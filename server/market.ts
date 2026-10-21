import { tx, type Row } from './db';
import type { Game } from './game';
import type { PlayerRow } from './store';
import { SPECIES, speciesById } from '../shared/species';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OfferView {
  id: number;
  sellerId: string;
  sellerName: string;
  species: number;
  kind: 'swap' | 'sale';
  wantSpecies: number | null;
  price: number | null;
  sellerWallet: string | null;
  createdAt: number;
}

/**
 * Critter Market. Swaps settle instantly server-side. Sales settle in the game token:
 * the buyer sends tokens to the seller's pasted wallet and submits the signature,
 * which the chain provider verifies before the critter changes hands.
 */
export class Market {
  constructor(private game: Game) {}

  private get db() {
    return this.game.db;
  }

  list(): OfferView[] {
    return (this.db.prepare("SELECT * FROM offers WHERE status = 'open' ORDER BY created_at DESC LIMIT 200").all() as Row[]).map((o) => ({
      id: o.id,
      sellerId: o.seller_id,
      sellerName: o.seller_name,
      species: o.species,
      kind: o.kind,
      wantSpecies: o.want_species,
      price: o.price,
      sellerWallet: o.seller_wallet,
      createdAt: o.created_at,
    }));
  }

  private tradableCritter(ownerId: string, critterId: number, species?: number): Row {
    const c = this.db.prepare('SELECT * FROM critters WHERE id = ? AND owner_id = ?').get(critterId, ownerId) as Row | undefined;
    if (!c) throw new HttpError(400, 'That critter is not in your bag.');
    if (c.locked) throw new HttpError(400, 'The first catch of each species stays locked in your dex.');
    if (species !== undefined && c.species !== species) throw new HttpError(400, 'Wrong species for this swap.');
    const listed = this.db.prepare("SELECT 1 FROM offers WHERE critter_id = ? AND status = 'open'").get(critterId);
    if (listed) throw new HttpError(400, 'That critter is already listed.');
    return c;
  }

  create(
    player: PlayerRow,
    body: { critterId: number; kind: 'swap' | 'sale'; wantSpecies?: number; price?: number; wallet?: string },
  ): OfferView {
    const open = (this.db.prepare("SELECT COUNT(*) AS n FROM offers WHERE seller_id = ? AND status = 'open'").get(player.id) as Row).n;
    if (open >= 10) throw new HttpError(400, 'You can have at most 10 open offers.');
    const c = this.tradableCritter(player.id, Number(body.critterId));
    let want: number | null = null;
    let price: number | null = null;
    let wallet: string | null = null;
    if (body.kind === 'swap') {
      want = Number(body.wantSpecies);
      if (!SPECIES.some((s) => s.id === want)) throw new HttpError(400, 'Pick a species you want in return.');
    } else if (body.kind === 'sale') {
      price = Number(body.price);
      if (!(price > 0 && price < 1e12)) throw new HttpError(400, 'Enter a price.');
      wallet = String(body.wallet ?? player.wallet ?? '').trim();
      if (!this.game.chain.isValidAddress(wallet)) throw new HttpError(400, 'Paste the Solana wallet that should receive the payment.');
    } else throw new HttpError(400, 'Unknown offer type.');

    const r = this.db
      .prepare(
        'INSERT INTO offers (seller_id, seller_name, critter_id, species, kind, want_species, price, seller_wallet, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(player.id, player.name, c.id, c.species, body.kind, want, price, wallet, Date.now());
    return this.list().find((o) => o.id === Number(r.lastInsertRowid))!;
  }

  cancel(player: PlayerRow, offerId: number): void {
    const r = this.db.prepare("UPDATE offers SET status = 'cancelled', closed_at = ? WHERE id = ? AND seller_id = ? AND status = 'open'").run(Date.now(), offerId, player.id);
    if (!Number(r.changes)) throw new HttpError(404, 'Offer not found.');
  }

  async accept(buyer: PlayerRow, offerId: number, body: { critterId?: number; txSig?: string }): Promise<void> {
    const offer = this.db.prepare("SELECT * FROM offers WHERE id = ? AND status = 'open'").get(offerId) as Row | undefined;
    if (!offer) throw new HttpError(404, 'This offer is gone.');
    if (offer.seller_id === buyer.id) throw new HttpError(400, "That's your own offer.");

    if (offer.kind === 'sale') {
      const sig = String(body.txSig ?? '').trim();
      if (!sig) throw new HttpError(400, 'Paste the transaction signature of your payment.');
      if (this.db.prepare('SELECT 1 FROM offers WHERE tx_sig = ?').get(sig)) throw new HttpError(400, 'That signature was already used.');
      const ok = await this.game.chain.verifyTokenPayment(sig, offer.seller_wallet, offer.price);
      if (!ok) throw new HttpError(400, 'Payment not found on-chain yet. Wait for confirmation and retry.');
      tx(this.db, () => {
        const still = this.db.prepare("UPDATE offers SET status = 'done', buyer_id = ?, tx_sig = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(buyer.id, sig, Date.now(), offerId);
        if (!Number(still.changes)) throw new HttpError(409, 'Someone else just bought it.');
        this.give(offer.critter_id, buyer.id);
      });
    } else {
      const mine = this.tradableCritter(buyer.id, Number(body.critterId), offer.want_species);
      tx(this.db, () => {
        const still = this.db.prepare("UPDATE offers SET status = 'done', buyer_id = ?, closed_at = ? WHERE id = ? AND status = 'open'").run(buyer.id, Date.now(), offerId);
        if (!Number(still.changes)) throw new HttpError(409, 'Someone else just took it.');
        this.give(offer.critter_id, buyer.id);
        this.give(mine.id, offer.seller_id);
      });
    }
    this.game.refreshPlayer(buyer.id);
    this.game.refreshPlayer(offer.seller_id);
    const sp = speciesById(offer.species);
    const seller = this.game.connFor(offer.seller_id);
    if (seller) this.game.toast(seller, `🏪 ${buyer.name} took your ${sp.name} offer.`, 'pink');
  }

  /** Moves a critter to a new owner. If it's their first of that species it becomes their locked dex entry. */
  private give(critterId: number, to: string): void {
    const c = this.db.prepare('SELECT species FROM critters WHERE id = ?').get(critterId) as Row;
    const has = this.db.prepare('SELECT 1 FROM critters WHERE owner_id = ? AND species = ? LIMIT 1').get(to, c.species);
    this.db.prepare('UPDATE critters SET owner_id = ?, locked = ? WHERE id = ?').run(to, has ? 0 : 1, critterId);
  }
}
