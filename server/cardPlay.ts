import { kvGet, kvSet, tx, type DB } from './db';
import { commitmentFor, newSecret, rollFor } from './fair';
import { CardMover } from './cardMover';
import { Prizes, oddsOf, type PrizeRow, type ReleaseRow } from './prizes';
import type { Guard } from './guard';
import { newId, type PlayerRow } from './store';
import { BRAND } from '../shared/brand';
import { oddsForThrow } from '../shared/fair';
import { TIERS, type MyClaim, type Tier } from '../shared/prizes';
import { BALL_GRAVITY, CARD_HIT_RADIUS, INTERP_DELAY_MS, THROW_MAX_T, THROW_SPEED, WATER_Y, terrainHeight, type Vec3 } from '../shared/world';
import type { PublicCard, ServerMsg } from '../shared/protocol';

/** What CardPlay needs from the game server. */
export interface CardHost {
  readonly db: DB;
  readonly launched: boolean;
  broadcast(msg: ServerMsg): void;
  sendTo(playerId: string, msg: ServerMsg): void;
  systemChat(text: string): void;
  trainerPositions(): Vec3[];
  writeMemo(text: string): Promise<string>;
  log: { info(o: unknown, msg?: string): void; error(o: unknown, msg?: string): void };
}

/** A golden ball in flight, simulated on the server against the card's recorded path. */
interface Shot {
  player: PlayerRow;
  releaseId: string;
  o: Vec3;
  d: Vec3;
  at: number;
  t: number;
  logId: number;
}

const STEP = 1 / 60;

/** One real card at a time: scheduled releases, fleeing slab, server-side hit tests and rolls, claim codes. */
export class CardPlay {
  release: ReleaseRow | null = null;
  prize: PrizeRow | null = null;
  mover: CardMover | null = null;
  private shots: Shot[] = [];
  private releasing = false;
  private lastStep = Date.now();

  constructor(
    private host: CardHost,
    readonly prizes: Prizes,
    private guard: Guard,
  ) {
    // Resume a card that was loose when the server stopped (new position, same commitment).
    const open = host.db.prepare('SELECT * FROM releases WHERE ended_at IS NULL LIMIT 1').get() as unknown as ReleaseRow | undefined;
    if (open) {
      this.release = open;
      this.prize = prizes.byId(open.prize_id) ?? null;
      this.mover = this.newMover();
    }
  }

  private newMover(): CardMover {
    return new CardMover(() => this.prizes.settings().teleportMinutes * 60_000);
  }

  // ── Schedule ──────────────────────────────────────────────────────────

  private lastRelease(tier: Tier): number {
    return Number(kvGet(this.host.db, `last_release_${tier}`) ?? 0);
  }

  /** The earliest tier due for an automatic release that still has cards on the shelf. */
  nextRelease(): { at: number; tier: Tier } | null {
    const s = this.prizes.settings();
    let best: { at: number; tier: Tier } | null = null;
    for (const tier of TIERS) {
      const h = s.everyHours[tier];
      if (h === null || !this.prizes.availableCount(tier)) continue;
      const last = this.lastRelease(tier);
      // A tier that never released starts its clock at launch, so a fresh catalog doesn't dump everything at once.
      const from = last || Number(kvGet(this.host.db, 'launched_at') ?? Date.now());
      const at = from + h * 3_600_000;
      if (!best || at < best.at) best = { at, tier };
    }
    return best;
  }

  /** Called every few seconds: releases the due tier when the island has no card. */
  async checkSchedule(): Promise<void> {
    if (!this.host.launched || this.release || this.releasing) return;
    const next = this.nextRelease();
    if (!next || next.at > Date.now()) return;
    const pick = this.prizes.pickAvailable(next.tier);
    if (pick) await this.releasePrize(pick.id);
  }

  async releasePrize(prizeId: string): Promise<ReleaseRow> {
    if (this.release) throw new Error('A card is already on the island. Recall it first.');
    if (this.releasing) throw new Error('A release is already in progress.');
    const prize = this.prizes.byId(prizeId);
    if (!prize) throw new Error('No such card.');
    if (prize.status !== 'available') throw new Error('Only available cards can be released.');
    this.releasing = true;
    try {
      const id = newId('card');
      const secret = newSecret();
      const commitment = commitmentFor(secret);
      const odds = this.prizes.settings().odds[prize.tier];
      let memoSig = '';
      try {
        memoSig = await this.host.writeMemo(`${BRAND.name} card ${id} fair-roll commit sha256:${commitment}`);
      } catch (e) {
        this.host.log.error(e, 'memo write failed');
      }
      const now = Date.now();
      tx(this.host.db, () => {
        this.host.db
          .prepare(
            `INSERT INTO releases (id, prize_id, tier, secret, commitment, memo_sig, odds_base, odds_step, odds_cap, released_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(id, prize.id, prize.tier, secret, commitment, memoSig, odds.base, odds.step, odds.cap, now);
        this.host.db.prepare("UPDATE prizes SET status = 'in_play', released_at = ? WHERE id = ?").run(now, prize.id);
      });
      kvSet(this.host.db, `last_release_${prize.tier}`, now);
      this.release = this.prizes.release(id)!;
      this.prize = this.prizes.byId(prize.id)!;
      this.mover = this.newMover();
      this.shots = [];
      this.host.broadcast({ t: 'card', card: this.publicCard() });
      this.host.broadcast({ t: 'banner', text: `A real ${prize.name} card is loose on the island!` });
      this.host.systemChat(`🃏 A real ${prize.name} card (${prize.tier}) is loose! Commitment sha256 ${commitment.slice(0, 12)}…`);
      this.host.log.info({ prize: prize.name, tier: prize.tier, release: id }, 'card released');
      return this.release;
    } finally {
      this.releasing = false;
    }
  }

  /** Takes the card off the island without a winner. Its secret becomes public so every roll stays checkable. */
  recall(): void {
    const r = this.release;
    if (!r || !this.prize) throw new Error('No card on the island.');
    const now = Date.now();
    tx(this.host.db, () => {
      this.host.db.prepare("UPDATE releases SET ended_at = ?, end_reason = 'recalled' WHERE id = ?").run(now, r.id);
      this.host.db.prepare("UPDATE prizes SET status = 'available' WHERE id = ?").run(this.prize!.id);
    });
    this.host.systemChat(`The ${this.prize.name} card left the island. Its secret is now public on the Verify page.`);
    this.clear();
  }

  private clear(): void {
    this.release = null;
    this.prize = null;
    this.mover = null;
    this.shots = [];
    this.host.broadcast({ t: 'card', card: null });
  }

  publicCard(): PublicCard | null {
    const r = this.release;
    const p = this.prize;
    if (!r || !p) return null;
    const odds = oddsOf(r);
    return {
      id: r.id,
      prizeId: p.id,
      name: p.name,
      set: p.set_name,
      grade: p.grade,
      tier: p.tier,
      image: this.prizes.imageUrl(p),
      releasedAt: r.released_at,
      commitment: r.commitment,
      memoSig: r.memo_sig,
      odds,
      throws: r.throw_count,
      nextOdds: oddsForThrow(r.throw_count, odds),
    };
  }

  // ── Motion + golden balls ─────────────────────────────────────────────

  /** 10 Hz: move the slab, broadcast it, then advance golden balls in flight. */
  tick(now: number): void {
    const dt = Math.min(0.25, (now - this.lastStep) / 1000);
    this.lastStep = now;
    const m = this.mover;
    const r = this.release;
    if (!m || !r) return;
    const jumped = m.step(dt, now, this.host.trainerPositions());
    const p = m.latest();
    this.host.broadcast({ t: 'cardPos', id: r.id, at: now, x: p.x, y: p.y, z: p.z, fleeing: m.fleeing, jump: jumped });
    if (this.shots.length) this.stepShots(now);
  }

  /** Queues a golden ball that already passed validation and was paid for. */
  addShot(player: PlayerRow, o: Vec3, d: Vec3, at: number, logId: number): void {
    if (!this.release) {
      this.guard.setThrowResult(logId, 'miss:no-card');
      return;
    }
    this.shots.push({ player, releaseId: this.release.id, o, d, at, t: 0, logId });
  }

  private stepShots(now: number): void {
    const m = this.mover!;
    const r2 = CARD_HIT_RADIUS * CARD_HIT_RADIUS;
    this.shots = this.shots.filter((s) => {
      if (s.releaseId !== this.release?.id) {
        this.guard.setThrowResult(s.logId, 'miss:card-gone');
        return false;
      }
      const horizon = Math.min(THROW_MAX_T, (now - s.at) / 1000);
      for (; s.t <= horizon; s.t += STEP) {
        const t = s.t;
        const p = {
          x: s.o.x + s.d.x * THROW_SPEED * t,
          y: s.o.y + s.d.y * THROW_SPEED * t + 0.5 * BALL_GRAVITY * t * t,
          z: s.o.z + s.d.z * THROW_SPEED * t,
        };
        // Compare against where the thrower saw the card (clients draw it INTERP_DELAY_MS behind).
        const c = m.posAt(s.at + t * 1000 - INTERP_DELAY_MS);
        const dx = p.x - c.x;
        const dy = p.y - c.y;
        const dz = p.z - c.z;
        if (dx * dx + dy * dy + dz * dz <= r2) {
          this.guard.setThrowResult(s.logId, 'hit');
          this.resolveHit(s.player);
          return false;
        }
        if (p.y < Math.max(terrainHeight(p.x, p.z), WATER_Y - 3)) {
          this.guard.setThrowResult(s.logId, 'miss');
          return false;
        }
      }
      if (s.t > THROW_MAX_T) {
        this.guard.setThrowResult(s.logId, 'miss');
        return false;
      }
      return true;
    });
  }

  private resolveHit(player: PlayerRow): void {
    const r = this.release;
    if (!r) return;
    const index = r.throw_count;
    const odds = oddsForThrow(index, oddsOf(r));
    const won = rollFor(r.secret, r.id, index) < odds;
    const now = Date.now();
    tx(this.host.db, () => {
      this.host.db
        .prepare('INSERT INTO release_throws (release_id, idx, player_id, player_name, odds, won, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(r.id, index, player.id, player.name, odds, won ? 1 : 0, now);
      this.host.db.prepare('UPDATE releases SET throw_count = throw_count + 1 WHERE id = ?').run(r.id);
      this.host.db.prepare('UPDATE players SET gold_hits = gold_hits + 1 WHERE id = ?').run(player.id);
    });
    r.throw_count++;
    this.host.broadcast({ t: 'cardHit', cardId: r.id, index, odds, by: player.name, byId: player.id, won });
    if (won) this.win(player, index);
  }

  /** The winning hit: close the release, mint a one-time claim code, reveal the secret. */
  private win(player: PlayerRow, index: number): void {
    const r = this.release!;
    const prize = this.prize!;
    const code = this.prizes.newClaimCode();
    const now = Date.now();
    tx(this.host.db, () => {
      this.host.db
        .prepare("UPDATE releases SET ended_at = ?, end_reason = 'caught', winner_id = ?, winner_name = ? WHERE id = ?")
        .run(now, player.id, player.name, r.id);
      this.host.db
        .prepare(
          `UPDATE prizes SET status = 'won', winner_id = ?, winner_name = ?, release_id = ?, winning_idx = ?, claim_code = ?, won_at = ?
           WHERE id = ?`,
        )
        .run(player.id, player.name, r.id, index, code, now, prize.id);
    });
    this.host.log.info({ prize: prize.name, winner: player.name, release: r.id, hit: index + 1 }, 'card won');
    this.host.broadcast({ t: 'cardCaught', cardId: r.id, name: prize.name, by: player.name, byId: player.id, secret: r.secret });
    const claim: MyClaim = { code, prize: this.prizes.publicPrize(this.prizes.byId(prize.id)!), verified: false };
    this.host.sendTo(player.id, { t: 'prizeWon', claim });
    this.host.systemChat(`🎉 ${player.name} caught the real ${prize.name} card on hit #${index + 1}!`);
    this.clear();
  }
}
