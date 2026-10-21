import type { WebSocket } from 'ws';
import { randomInt } from 'node:crypto';
import { CONFIG } from './config';
import { kvGet, kvSet, tx, type DB, type Row } from './db';
import { Store, cleanName, hashIp, isToken, newId, type PlayerRow } from './store';
import { commitmentFor, newSecret, rollFor } from './fair';
import type { ChainProvider } from './chain/types';
import type { CardProvider } from './cards/types';
import { BRAND } from '../shared/brand';
import { oddsForThrow } from '../shared/fair';
import { BASE_DEX_SIZE, CATCH_RATE, REGIONS, REGION_LABEL, SPAWN_WEIGHT, SPECIES, speciesById, type Region } from '../shared/species';
import {
  CARD_HIT_RADIUS,
  EYE_HEIGHT,
  LOBBY,
  PICKUP_RADIUS,
  RUN_SPEED,
  cardCenter,
  cardPose,
  critterCenter,
  critterHitRadius,
  critterPose,
  groundHeight,
  randomCavePoint,
  randomLandPoint,
  randomOceanPoint,
  resolveMove,
  terrainHeight,
  traceHit,
  type CritterKind,
  type Mode,
  type SpawnInfo,
  type Vec3,
} from '../shared/world';
import type { Ball, ChatLine, ClientMsg, Economy, EventInfo, PlayerPos, PublicCard, ServerMsg, YouInfo } from '../shared/protocol';

export interface CardRow {
  id: string;
  name: string;
  set_name: string;
  grade: string;
  value_usd: number;
  price_usd: number;
  image: string;
  mint: string | null;
  species: number;
  status: 'queued' | 'in_play' | 'caught' | 'claimed';
  purchase_sig: string | null;
  seed: number;
  released_at: number;
  secret: string;
  commitment: string;
  memo_sig: string;
  throw_count: number;
  winner_id: string | null;
  winner_name: string | null;
  winner_wallet: string | null;
  caught_at: number | null;
  transfer_sig: string | null;
  created_at: number;
}

interface Conn {
  ws: WebSocket;
  ip: string;
  player: PlayerRow | null;
  title: string | null;
  chatTimes: number[];
  pos: Vec3;
  ry: number;
  lastPosAt: number;
  mode: Mode;
  throwTimes: number[];
  lastGoldAt: number;
  strikes: number;
  msgWindowStart: number;
  msgCount: number;
}

interface Logger {
  info(o: unknown, msg?: string): void;
  warn(o: unknown, msg?: string): void;
  error(o: unknown, msg?: string): void;
}

const TARGET: Record<CritterKind, number> = { land: 34, ocean: 8, sky: 6, cave: 8 };
const REGION_KIND: Record<Region, CritterKind> = { base: 'land', ocean: 'ocean', sky: 'sky', cave: 'cave' };
const KIND_REGION: Record<CritterKind, Region> = { land: 'base', ocean: 'ocean', sky: 'sky', cave: 'cave' };
const EVENT_MS = 5 * 60_000;
const MAX_BALLS_ON_ISLAND = 300;
/** How long an orb wobbles on the ground before the catch resolves (3 wobbles client side). */
export const CATCH_WOBBLE_MS = 2_600;
const CHAT_HISTORY = 40;

export function imageUrl(row: { id: string; image: string }): string {
  return row.image.startsWith('mock:') ? `/api/cards/${row.id}/image.svg` : row.image;
}

export class Game {
  readonly conns = new Set<Conn>();
  readonly balls = new Map<string, Ball>();
  readonly critters = new Map<string, SpawnInfo>();
  card: CardRow | null;
  event: EventInfo | null = null;
  launched: boolean;
  vaultUsd: number;
  nextClaimAt = 0;
  private claiming = false;
  private buying = false;
  private releasing = false;
  private ballsDirty = false;
  /** Critters currently inside a wobbling orb; they can't be targeted again. */
  private catching = new Set<string>();
  private chat: ChatLine[] = [];
  private chatSeq = 0;
  private dexMasters: string[] = [];

  constructor(
    readonly db: DB,
    readonly store: Store,
    readonly chain: ChainProvider,
    readonly cards: CardProvider,
    private log: Logger,
  ) {
    this.launched = (kvGet(db, 'launched') ?? String(CONFIG.launchedDefault)) === 'true';
    this.vaultUsd = Number(kvGet(db, 'vault_usd') ?? 0);
    this.card = (db.prepare("SELECT * FROM cards WHERE status = 'in_play' LIMIT 1").get() as unknown as CardRow) ?? null;
    for (const b of JSON.parse(kvGet(db, 'balls') ?? '[]') as Ball[]) this.balls.set(b.id, b);
    this.refreshDexMasters();
  }

  start(): void {
    if (this.launched) this.nextClaimAt = Date.now() + 15_000;
    this.fillCritters();
    setInterval(() => this.tick(), 100);
    setInterval(() => this.fillCritters(), 5_000);
    setInterval(() => {
      if (this.launched && !this.claiming && this.nextClaimAt && Date.now() >= this.nextClaimAt) void this.runFeeClaim();
    }, 1_000);
    setInterval(() => this.persistBalls(), 2_000);
    if (this.launched) void this.maybeBuyCard();
  }

  // ── Connections ───────────────────────────────────────────────────────

  connect(ws: WebSocket, ip: string): void {
    const c: Conn = {
      ws,
      ip,
      player: null,
      title: null,
      chatTimes: [],
      pos: { x: 0, y: 0, z: 0 },
      ry: 0,
      lastPosAt: Date.now(),
      mode: 'lobby',
      throwTimes: [],
      lastGoldAt: 0,
      strikes: 0,
      msgWindowStart: Date.now(),
      msgCount: 0,
    };
    this.conns.add(c);
    ws.on('message', (raw) => this.onMessage(c, raw.toString()));
    ws.on('close', () => {
      this.conns.delete(c);
      if (c.player) {
        this.broadcast({ t: 'left', id: c.player.id });
        this.broadcastEconomy();
      }
    });
    this.send(c, {
      t: 'init',
      now: Date.now(),
      players: this.playerList(),
      balls: [...this.balls.values()],
      critters: [...this.critters.values()],
      card: this.card ? this.publicCard(this.card) : null,
      economy: this.economy(),
      event: this.event,
      chat: this.chat,
    });
  }

  private onMessage(c: Conn, raw: string): void {
    const now = Date.now();
    if (now - c.msgWindowStart > 1000) {
      c.msgWindowStart = now;
      c.msgCount = 0;
    }
    if (++c.msgCount > 60) {
      if (c.msgCount > 200) c.ws.close(1008, 'rate limit');
      return;
    }
    let m: ClientMsg;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.t) {
      case 'hello':
        return this.onHello(c, m.token, m.name);
      case 'pos':
        return this.onPos(c, m);
      case 'throw':
        return this.onThrow(c, m);
      case 'pickup':
        return this.onPickup(c, m.id);
      case 'chat':
        return this.onChat(c, m.text);
      case 'ping':
        return this.send(c, { t: 'pong', c: m.c, now });
    }
  }

  private onHello(c: Conn, token: string, name: string): void {
    if (!isToken(token)) return this.toast(c, 'Invalid session, refresh the page.', 'warn');
    const player = this.store.upsertPlayer(token, cleanName(name), hashIp(c.ip));
    for (const other of this.conns) {
      if (other !== c && other.player?.id === player.id) {
        this.toast(other, 'You opened the game in another tab.', 'warn');
        other.player = null;
        other.ws.close(4000, 'replaced');
      }
    }
    c.player = player;
    c.title = this.titleFor(player.id);
    if (this.launched) {
      const bonus = this.store.grantLaunchBonus(player.id);
      if (bonus) this.toast(c, `🎁 Early-trainer bonus: ${bonus} golden balls landed in your bag!`, 'gold');
    }
    this.placeAtSpawn(c);
    this.broadcastEconomy();
  }

  private placeAtSpawn(c: Conn): void {
    if (!c.player) return;
    c.mode = this.launched ? 'island' : 'lobby';
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * 4;
    if (c.mode === 'lobby') c.pos = { x: LOBBY.x + Math.cos(a) * r, y: LOBBY.y, z: LOBBY.z + Math.sin(a) * r };
    else {
      const x = Math.cos(a) * (3 + r);
      const z = Math.sin(a) * (3 + r);
      c.pos = { x, y: terrainHeight(x, z), z };
    }
    c.lastPosAt = Date.now();
    c.player = this.store.playerById(c.player.id)!;
    this.send(c, { t: 'you', you: this.youInfo(c.player), spawn: c.pos, mode: c.mode });
  }

  youInfo(p: PlayerRow): YouInfo {
    const pending = this.db
      .prepare("SELECT id, name FROM cards WHERE winner_id = ? AND status = 'caught'")
      .all(p.id) as { id: string; name: string }[];
    return { id: p.id, name: p.name, gold: p.gold, dex: this.store.dex(p.id), wallet: p.wallet, pendingCards: pending };
  }

  private onPos(c: Conn, m: { x: number; y: number; z: number; ry: number }): void {
    if (!c.player || ![m.x, m.y, m.z, m.ry].every(Number.isFinite)) return;
    const now = Date.now();
    const dt = Math.min(1.5, (now - c.lastPosAt) / 1000);
    const horiz = Math.hypot(m.x - c.pos.x, m.z - c.pos.z);
    const fixed = resolveMove(c.pos.x, c.pos.z, m.x, m.z, c.mode);
    const ground = groundHeight(m.x, m.z, c.mode);
    const bad =
      horiz > RUN_SPEED * dt * 1.5 + 1.5 ||
      Math.hypot(fixed.x - m.x, fixed.z - m.z) > 0.75 ||
      m.y < ground - 1.5 ||
      m.y > ground + 9;
    if (bad) {
      c.strikes++;
      this.send(c, { t: 'correct', ...c.pos });
      return;
    }
    c.pos = { x: m.x, y: m.y, z: m.z };
    c.ry = m.ry;
    c.lastPosAt = now;
  }

  // ── Throws ────────────────────────────────────────────────────────────

  private onThrow(c: Conn, m: Extract<ClientMsg, { t: 'throw' }>): void {
    if (!c.player) return;
    const now = Date.now();
    c.throwTimes = c.throwTimes.filter((t) => now - t < 1000);
    if (c.throwTimes.length >= 4) return;
    if (m.kind === 'gold' && now - c.lastGoldAt < 450) return;
    c.throwTimes.push(now);

    const okVec = (v: Vec3) => v && [v.x, v.y, v.z].every(Number.isFinite);
    if (!okVec(m.o) || !okVec(m.d)) return;
    const len = Math.hypot(m.d.x, m.d.y, m.d.z);
    if (len < 0.5 || len > 1.5) return;
    const d = { x: m.d.x / len, y: m.d.y / len, z: m.d.z / len };
    let o = m.o;
    const tooFar = Math.hypot(o.x - c.pos.x, o.z - c.pos.z) > 2.5 || o.y < c.pos.y - 0.5 || o.y > c.pos.y + EYE_HEIGHT + 1.5;
    if (tooFar) o = { x: c.pos.x, y: c.pos.y + EYE_HEIGHT - 0.15, z: c.pos.z };
    const at = Number.isFinite(m.at) ? Math.min(now + 150, Math.max(now - 700, m.at)) : now;

    this.broadcast({ t: 'fx', kind: m.kind, o, d, by: c.player.id }, c);
    if (m.kind === 'orb') this.orbThrow(c.player, o, d, at);
    else {
      c.lastGoldAt = now;
      this.goldThrow(c, o, d, at);
    }
  }

  private orbThrow(player: PlayerRow, o: Vec3, d: Vec3, at: number): void {
    if (!this.launched) return;
    let best: { s: SpawnInfo; t: number } | null = null;
    for (const s of this.critters.values()) {
      if (this.catching.has(s.id)) continue;
      const size = speciesById(s.species).size;
      const p0 = critterPose(s, at);
      if (Math.hypot(p0.x - o.x, p0.z - o.z) > 90) continue;
      const t = traceHit(o, d, (dt) => critterCenter(critterPose(s, at + dt * 1000), size), critterHitRadius(size));
      if (t !== null && (!best || t < best.t)) best = { s, t };
    }
    if (!best) return;
    const { s, t } = best;
    setTimeout(() => this.startCatch(player, s.id, at + t * 1000), Math.max(0, at + t * 1000 - Date.now()));
  }

  /** The orb landed on the critter: it gets pulled in and the orb wobbles before the result. */
  private startCatch(player: PlayerRow, spawnId: string, hitAt: number): void {
    const s = this.critters.get(spawnId);
    if (!s || this.catching.has(spawnId)) return;
    this.catching.add(spawnId);
    const p = critterPose(s, hitAt);
    this.broadcast({ t: 'catchStart', spawnId, byId: player.id, at: { x: p.x, y: p.y, z: p.z } });
    setTimeout(() => this.resolveCatch(player, spawnId), CATCH_WOBBLE_MS);
  }

  private resolveCatch(player: PlayerRow, spawnId: string): void {
    this.catching.delete(spawnId);
    const s = this.critters.get(spawnId);
    if (!s) return;
    const sp = speciesById(s.species);
    if (Math.random() >= CATCH_RATE[sp.rarity]) {
      this.broadcast({ t: 'catch', ok: false, spawnId, species: s.species, by: player.name, byId: player.id, isNew: false });
      return;
    }
    this.critters.delete(spawnId);
    const { isNew } = this.store.addCritter(player.id, s.species);
    this.broadcast({ t: 'critter-', id: spawnId });
    this.broadcast({ t: 'catch', ok: true, spawnId, species: s.species, by: player.name, byId: player.id, isNew });
    const conn = this.connFor(player.id);
    if (conn) this.send(conn, { t: 'dex', dex: this.store.dex(player.id) });
    if (sp.rarity === 'legendary') {
      this.broadcastToast(`🌟 ${player.name} caught the legendary ${sp.name}!`, 'gold');
      this.systemChat(`🌟 ${player.name} caught the legendary ${sp.name}!`);
    }
    if (isNew) {
      this.checkMaster(player);
      this.onDexGrew(player.id, sp.region);
    }
  }

  /** Titles and the dex-master ticker only change when someone catches a new species. */
  private onDexGrew(playerId: string, region: Region): void {
    const c = this.connFor(playerId);
    if (c) c.title = this.titleFor(playerId);
    if (region === 'base' && this.refreshDexMasters()) this.broadcastEconomy();
  }

  /** Highest title a trainer has earned, shown above their avatar and in chat. */
  titleFor(playerId: string): string | null {
    const dex = new Set(this.store.dex(playerId));
    const done = (r: Region) => SPECIES.filter((s) => s.region === r).every((s) => dex.has(s.id));
    if (dex.size === SPECIES.length) return 'Grand Master';
    if (done('base')) return 'Dex Master';
    const region = REGIONS.find((r) => r !== 'base' && done(r));
    if (region) return `${REGION_LABEL[region]} Master`;
    const cards = (this.db.prepare('SELECT COUNT(*) AS n FROM cards WHERE winner_id = ?').get(playerId) as Row).n as number;
    return cards > 0 ? 'Card Catcher' : null;
  }

  /** Trainers with the full island dex, ordered by when they finished. Returns true when the list changed. */
  private refreshDexMasters(): boolean {
    const rows = this.db
      .prepare(
        `SELECT p.name AS name, MAX(f.first) AS done FROM (
           SELECT owner_id, species, MIN(caught_at) AS first FROM critters WHERE species <= ? GROUP BY owner_id, species
         ) f JOIN players p ON p.id = f.owner_id
         GROUP BY f.owner_id HAVING COUNT(*) = ? ORDER BY done LIMIT 12`,
      )
      .all(BASE_DEX_SIZE, BASE_DEX_SIZE) as Row[];
    const next = rows.map((r) => r.name as string);
    const changed = next.join('\n') !== this.dexMasters.join('\n');
    this.dexMasters = next;
    return changed;
  }

  // ── Chat ──────────────────────────────────────────────────────────────

  private onChat(c: Conn, raw: unknown): void {
    if (!c.player || typeof raw !== 'string') return;
    const text = raw
      .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140);
    if (!text) return;
    const now = Date.now();
    c.chatTimes = c.chatTimes.filter((t) => now - t < 10_000);
    if (c.chatTimes.length >= 5 || now - (c.chatTimes.at(-1) ?? 0) < 1_000) return this.toast(c, 'Easy there, one message per second.', 'warn');
    c.chatTimes.push(now);
    this.pushChat({ id: ++this.chatSeq, name: c.player.name, title: c.title, text, at: now });
  }

  systemChat(text: string): void {
    this.pushChat({ id: ++this.chatSeq, name: BRAND.name, title: null, text, at: Date.now(), system: true });
  }

  private pushChat(line: ChatLine): void {
    this.chat.push(line);
    if (this.chat.length > CHAT_HISTORY) this.chat.shift();
    this.broadcast({ t: 'chat', line });
  }

  private checkMaster(player: PlayerRow): void {
    if (kvGet(this.db, 'master_winner') || !this.store.hasCompletedDex(player.id)) return;
    kvSet(this.db, 'master_winner', JSON.stringify({ id: player.id, name: player.name, at: Date.now() }));
    this.broadcastToast(`🏆 ${player.name} completed every dex and wins the mystery Master card!`, 'gold');
  }

  private goldThrow(c: Conn, o: Vec3, d: Vec3, at: number): void {
    const player = c.player!;
    if (!this.launched) return;
    if (!this.store.spendGold(player.id)) {
      this.send(c, { t: 'bag', gold: 0 });
      return this.toast(c, 'No golden balls left. Find more on the island!', 'warn');
    }
    this.send(c, { t: 'bag', gold: this.store.playerById(player.id)!.gold });
    const card = this.card;
    if (!card) return;
    const t = traceHit(o, d, (dt) => cardCenter(cardPose(card.seed, card.released_at, at + dt * 1000)), CARD_HIT_RADIUS);
    if (t === null) return;
    setTimeout(() => this.resolveCardHit(player, card.id), Math.max(0, at + t * 1000 - Date.now()));
  }

  private resolveCardHit(player: PlayerRow, cardId: string): void {
    const card = this.card;
    if (!card || card.id !== cardId) return;
    const index = card.throw_count;
    const odds = oddsForThrow(index);
    const won = rollFor(card.secret, card.id, index) < odds;
    const now = Date.now();
    tx(this.db, () => {
      this.db
        .prepare('INSERT INTO throws (card_id, idx, player_id, player_name, odds, won, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(card.id, index, player.id, player.name, odds, won ? 1 : 0, now);
      this.db.prepare('UPDATE cards SET throw_count = throw_count + 1 WHERE id = ?').run(card.id);
      this.db.prepare('UPDATE players SET gold_hits = gold_hits + 1 WHERE id = ?').run(player.id);
    });
    card.throw_count++;
    this.broadcast({ t: 'cardHit', cardId: card.id, index, odds, by: player.name, byId: player.id, won });
    if (won) this.cardCaught(card, player);
  }

  private cardCaught(card: CardRow, player: PlayerRow): void {
    const fresh = this.store.playerById(player.id)!;
    this.db
      .prepare("UPDATE cards SET status = 'caught', winner_id = ?, winner_name = ?, winner_wallet = ?, caught_at = ? WHERE id = ?")
      .run(fresh.id, fresh.name, fresh.wallet, Date.now(), card.id);
    this.card = null;
    this.broadcast({ t: 'cardCaught', cardId: card.id, name: card.name, by: fresh.name, byId: fresh.id, secret: card.secret });
    this.systemChat(`🎉 ${fresh.name} caught the real ${card.name} on hit #${card.throw_count}!`);
    this.broadcast({ t: 'card', card: null });
    this.broadcastEconomy();
    const conn = this.connFor(fresh.id);
    if (conn) {
      conn.title = this.titleFor(fresh.id);
      this.send(conn, { t: 'you', you: this.youInfo(fresh), spawn: conn.pos, mode: conn.mode });
    }
    if (fresh.wallet) void this.deliverCard(card.id);
    setTimeout(() => void this.releaseNext(), 8_000);
  }

  async deliverCard(cardId: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as unknown as CardRow | undefined;
    if (!row || row.status !== 'caught' || !row.winner_wallet || !row.mint) return;
    try {
      const sig = await this.cards.transferToWinner(row.mint, row.winner_wallet);
      this.db.prepare("UPDATE cards SET status = 'claimed', transfer_sig = ? WHERE id = ?").run(sig, row.id);
      const conn = row.winner_id ? this.connFor(row.winner_id) : null;
      if (conn) this.toast(conn, `🃏 ${row.name} was sent to your wallet!`, 'gold');
    } catch (e) {
      this.log.error(e, 'card transfer failed');
    }
  }

  /** Winner pastes a wallet (read-only, no signature). Pending cards are delivered to it. */
  async setWallet(player: PlayerRow, wallet: string): Promise<void> {
    this.db.prepare('UPDATE players SET wallet = ? WHERE id = ?').run(wallet, player.id);
    const pending = this.db.prepare("SELECT id FROM cards WHERE winner_id = ? AND status = 'caught'").all(player.id) as Row[];
    for (const p of pending) {
      this.db.prepare('UPDATE cards SET winner_wallet = ? WHERE id = ?').run(wallet, p.id);
      await this.deliverCard(p.id as string);
    }
  }

  // ── Golden balls ──────────────────────────────────────────────────────

  private onPickup(c: Conn, id: string): void {
    if (!c.player || !this.launched) return;
    const b = this.balls.get(id);
    if (!b) return;
    if (Math.hypot(b.x - c.pos.x, b.z - c.pos.z) > PICKUP_RADIUS + 1.5 || Math.abs(b.y - c.pos.y) > 3.5) return;
    this.balls.delete(id);
    this.ballsDirty = true;
    this.send(c, { t: 'bag', gold: this.store.addGold(c.player.id, 1) });
    this.broadcast({ t: 'ball-', id });
    this.broadcastEconomy();
  }

  spawnBalls(n: number): number {
    const room = Math.max(0, MAX_BALLS_ON_ISLAND - this.balls.size);
    const added: Ball[] = [];
    for (let i = 0; i < Math.min(n, room); i++) {
      const p = randomLandPoint(Math.random, 1);
      const b = { id: newId('b'), x: p.x, y: terrainHeight(p.x, p.z) + 0.5, z: p.z };
      this.balls.set(b.id, b);
      added.push(b);
    }
    if (added.length) {
      this.ballsDirty = true;
      this.broadcast({ t: 'balls+', balls: added });
      this.broadcastEconomy();
    }
    return added.length;
  }

  private persistBalls(): void {
    if (!this.ballsDirty) return;
    this.ballsDirty = false;
    kvSet(this.db, 'balls', JSON.stringify([...this.balls.values()]));
  }

  // ── Fees → balls + vault → cards ──────────────────────────────────────

  async runFeeClaim(): Promise<void> {
    if (this.claiming) return;
    this.claiming = true;
    try {
      const claim = await this.chain.claimCreatorFees();
      if (claim && claim.usd > 0) {
        const vaultPart = claim.usd * CONFIG.vaultShare;
        const ballPart = claim.usd - vaultPart;
        const n = Math.max(1, Math.min(CONFIG.maxBallsPerDrop, Math.floor(ballPart / CONFIG.usdPerGoldenBall)));
        const spawned = this.spawnBalls(n);
        if (vaultPart > 0) {
          await this.chain.depositToVault(vaultPart);
          this.setVault(this.vaultUsd + vaultPart);
        }
        this.db
          .prepare('INSERT INTO fee_claims (usd, sol, signature, balls, vault_usd, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(claim.usd, claim.sol, claim.signature, spawned, this.vaultUsd, Date.now());
        this.broadcastToast(`⚡ Creator fees claimed: ${spawned} golden balls just dropped on the island!`, 'gold');
        this.systemChat(`⚡ Golden drop: ${spawned} golden balls landed on the island.`);
        this.log.info({ usd: claim.usd, balls: spawned, vault: this.vaultUsd }, 'fee claim');
      }
    } catch (e) {
      this.log.error(e, 'fee claim failed');
    } finally {
      this.claiming = false;
      this.nextClaimAt = Date.now() + CONFIG.feeClaimIntervalSec * 1000;
      this.broadcastEconomy();
    }
    await this.maybeBuyCard();
  }

  setVault(usd: number): void {
    this.vaultUsd = Math.max(0, Math.round(usd * 100) / 100);
    kvSet(this.db, 'vault_usd', this.vaultUsd);
    this.broadcastEconomy();
  }

  async maybeBuyCard(): Promise<void> {
    if (this.buying) return;
    this.buying = true;
    try {
      while (this.vaultUsd >= CONFIG.cardThresholdUsd) {
        const queued = (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE status = 'queued'").get() as Row).n as number;
        if (queued >= 3) break;
        const listing = await this.cards.findCard(this.vaultUsd);
        if (!listing) break;
        const paySig = await this.chain.payUsdc(listing.payTo, listing.priceUsd);
        const { mint } = await this.cards.confirmPurchase(listing, paySig);
        this.setVault(this.vaultUsd - listing.priceUsd);
        const mockSpecies = listing.image.startsWith('mock:') ? Number(listing.image.slice(5)) : 0;
        const pool = SPECIES.filter((s) => s.rarity !== 'legendary');
        const species = mockSpecies || pool[randomInt(pool.length)].id;
        this.db
          .prepare(
            `INSERT INTO cards (id, name, set_name, grade, value_usd, price_usd, image, mint, species, status, purchase_sig, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
          )
          .run(newId('card'), listing.name, listing.set, listing.grade, listing.valueUsd, listing.priceUsd, listing.image, mint, species, paySig, Date.now());
        this.log.info({ name: listing.name, price: listing.priceUsd }, 'card purchased');
      }
    } catch (e) {
      this.log.error(e, 'card purchase failed');
    } finally {
      this.buying = false;
    }
    if (!this.card) await this.releaseNext();
  }

  async releaseNext(): Promise<void> {
    if (this.card || this.releasing || !this.launched) return;
    const next = this.db.prepare("SELECT * FROM cards WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as unknown as CardRow | undefined;
    if (!next) return;
    this.releasing = true;
    try {
      const secret = newSecret();
      const commitment = commitmentFor(secret);
      let memoSig = '';
      try {
        memoSig = await this.chain.writeMemo(`${BRAND.name} card ${next.id} fair-roll commit sha256:${commitment}`);
      } catch (e) {
        this.log.error(e, 'memo write failed');
      }
      const seed = randomInt(1, 2 ** 31 - 1);
      const releasedAt = Date.now();
      this.db
        .prepare("UPDATE cards SET status = 'in_play', secret = ?, commitment = ?, memo_sig = ?, seed = ?, released_at = ? WHERE id = ?")
        .run(secret, commitment, memoSig, seed, releasedAt, next.id);
      this.card = { ...next, status: 'in_play', secret, commitment, memo_sig: memoSig, seed, released_at: releasedAt };
      this.broadcast({ t: 'card', card: this.publicCard(this.card) });
      this.broadcastToast(`🃏 A real ${next.name} (${next.grade}) is roaming the island!`, 'gold');
      this.systemChat(`🃏 A real ${next.name} (${next.grade}) is roaming. Commitment sha256 ${commitment.slice(0, 12)}…`);
    } finally {
      this.releasing = false;
    }
  }

  publicCard(row: CardRow): PublicCard {
    return {
      id: row.id,
      name: row.name,
      set: row.set_name,
      grade: row.grade,
      valueUsd: row.value_usd,
      image: imageUrl(row),
      species: row.species,
      seed: row.seed,
      releasedAt: row.released_at,
      commitment: row.commitment,
      memoSig: row.memo_sig,
      throws: row.throw_count,
      nextOdds: oddsForThrow(row.throw_count),
    };
  }

  // ── Critters + events ─────────────────────────────────────────────────

  private fillCritters(): void {
    const now = Date.now();
    const counts: Record<CritterKind, number> = { land: 0, ocean: 0, sky: 0, cave: 0 };
    const gone: string[] = [];
    for (const s of this.critters.values()) {
      if (speciesById(s.species).rarity === 'legendary') continue;
      if (now - s.born > 15 * 60_000 && Math.random() < 0.08) gone.push(s.id);
      else counts[s.kind]++;
    }
    for (const id of gone) {
      this.critters.delete(id);
      this.broadcast({ t: 'critter-', id });
    }
    const added: SpawnInfo[] = [];
    for (const kind of Object.keys(TARGET) as CritterKind[]) {
      for (let i = counts[kind]; i < TARGET[kind]; i++) added.push(this.spawnCritter(kind));
    }
    if (added.length) this.broadcast({ t: 'critter+', spawns: added });
  }

  private spawnCritter(kind: CritterKind, speciesId?: number): SpawnInfo {
    let species = speciesId;
    if (!species) {
      const pool = SPECIES.filter((s) => s.region === KIND_REGION[kind] && SPAWN_WEIGHT[s.rarity] > 0);
      const total = pool.reduce((a, s) => a + SPAWN_WEIGHT[s.rarity], 0);
      let r = Math.random() * total;
      species = pool.find((s) => (r -= SPAWN_WEIGHT[s.rarity]) < 0)?.id ?? pool[0].id;
    }
    const p =
      kind === 'ocean' ? randomOceanPoint(Math.random) : kind === 'cave' ? randomCavePoint(Math.random) : randomLandPoint(Math.random, kind === 'sky' ? 3 : 7);
    const s: SpawnInfo = { id: newId('c'), species, kind, hx: p.x, hz: p.z, seed: randomInt(1, 2 ** 31 - 1), born: Date.now() };
    this.critters.set(s.id, s);
    return s;
  }

  startEvent(region?: Region): void {
    if (this.event) return;
    const regions: Region[] = ['base', 'ocean', 'sky', 'cave'];
    const r = region ?? regions[randomInt(regions.length)];
    const legend = SPECIES.find((s) => s.region === r && s.rarity === 'legendary')!;
    const s = this.spawnCritter(REGION_KIND[r], legend.id);
    this.broadcast({ t: 'critter+', spawns: [s] });
    this.event = { region: r, species: legend.id, endsAt: Date.now() + EVENT_MS };
    this.broadcast({ t: 'event', event: this.event });
    this.broadcastToast(`🌟 Legendary event! ${legend.name} appeared for 5 minutes.`, 'pink');
    this.systemChat(`🌟 Legendary event: ${legend.name} appeared (${REGION_LABEL[r]}) for 5 minutes.`);
  }

  private endEvent(): void {
    for (const s of [...this.critters.values()]) {
      if (speciesById(s.species).rarity === 'legendary') {
        this.critters.delete(s.id);
        this.broadcast({ t: 'critter-', id: s.id });
      }
    }
    this.event = null;
    this.broadcast({ t: 'event', event: null });
    kvSet(this.db, 'next_event_at', Date.now() + (2 + Math.random() * 3) * 3_600_000);
  }

  private tick(): void {
    const now = Date.now();
    if (this.event && now >= this.event.endsAt) this.endEvent();
    if (this.launched && !this.event) {
      const next = Number(kvGet(this.db, 'next_event_at') ?? 0);
      if (!next) kvSet(this.db, 'next_event_at', now + (1 + Math.random() * 3) * 3_600_000);
      else if (now >= next) this.startEvent();
    }
    const list = this.playerList();
    if (list.length) this.broadcast({ t: 'players', list });
  }

  // ── Launch ────────────────────────────────────────────────────────────

  setLaunched(v: boolean): void {
    if (this.launched === v) return;
    this.launched = v;
    kvSet(this.db, 'launched', v);
    this.nextClaimAt = v ? Date.now() + 15_000 : 0;
    for (const c of this.conns) {
      if (!c.player) continue;
      if (v) {
        const bonus = this.store.grantLaunchBonus(c.player.id);
        if (bonus) this.toast(c, `🎁 We're live! ${bonus} early-trainer golden balls landed in your bag.`, 'gold');
      }
      this.placeAtSpawn(c);
    }
    this.broadcastEconomy();
    if (v) void this.maybeBuyCard();
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  economy(): Economy {
    return {
      launched: this.launched,
      vaultUsd: this.vaultUsd,
      threshold: CONFIG.cardThresholdUsd,
      nextClaimAt: this.nextClaimAt,
      online: this.onlineCount(),
      cardsCaught: (this.db.prepare("SELECT COUNT(*) AS n FROM cards WHERE status IN ('caught','claimed')").get() as Row).n as number,
      balls: this.balls.size,
      dexMasters: this.dexMasters,
    };
  }

  onlineCount(): number {
    return new Set([...this.conns].filter((c) => c.player).map((c) => c.player!.id)).size;
  }

  private playerList(): PlayerPos[] {
    const out: PlayerPos[] = [];
    for (const c of this.conns) {
      if (c.player) out.push({ id: c.player.id, name: c.player.name, title: c.title, x: c.pos.x, y: c.pos.y, z: c.pos.z, ry: c.ry });
    }
    return out;
  }

  connFor(playerId: string): Conn | null {
    for (const c of this.conns) if (c.player?.id === playerId) return c;
    return null;
  }

  /** Re-read a player from the DB and push fresh state to their socket (after market/arena changes). */
  refreshPlayer(playerId: string): void {
    const c = this.connFor(playerId);
    const p = this.store.playerById(playerId);
    if (!c || !p) return;
    c.player = p;
    c.title = this.titleFor(playerId);
    this.send(c, { t: 'dex', dex: this.store.dex(playerId) });
    this.send(c, { t: 'bag', gold: p.gold });
  }

  broadcastEconomy(): void {
    this.broadcast({ t: 'economy', e: this.economy() });
  }

  send(c: Conn, msg: ServerMsg): void {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg, except?: Conn): void {
    const data = JSON.stringify(msg);
    for (const c of this.conns) if (c !== except && c.ws.readyState === 1) c.ws.send(data);
  }

  toast(c: Conn, text: string, tone: 'info' | 'gold' | 'pink' | 'warn' = 'info'): void {
    this.send(c, { t: 'toast', text, tone });
  }

  broadcastToast(text: string, tone: 'info' | 'gold' | 'pink' | 'warn' = 'info'): void {
    this.broadcast({ t: 'toast', text, tone });
  }
}
