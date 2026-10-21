import type { WebSocket } from 'ws';
import { randomInt } from 'node:crypto';
import { CONFIG } from './config';
import { kvGet, kvSet, type DB, type Row } from './db';
import { AccountLimitError, Store, cleanName, hashIp, isToken, newId, type PlayerRow } from './store';
import { CardPlay } from './cardPlay';
import { Guard } from './guard';
import { Prizes } from './prizes';
import type { ChainProvider } from './chain/types';
import type { CardProvider } from './cards/types';
import { BRAND } from '../shared/brand';
import { BASE_DEX_SIZE, CATCH_RATE, REGIONS, REGION_LABEL, SPAWN_WEIGHT, SPECIES, speciesById, type Region } from '../shared/species';
import {
  EYE_HEIGHT,
  LOBBY,
  PICKUP_RADIUS,
  RUN_SPEED,
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
import type { Ball, ChatLine, ClientMsg, Economy, EventInfo, PlayerPos, ServerMsg, YouInfo } from '../shared/protocol';

interface Conn {
  ws: WebSocket;
  ip: string;
  ipHash: string;
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
/** Sockets allowed per network (IP hash); more tabs than this are refused. */
const MAX_SOCKETS_PER_IP = 8;
/** Golden throws must start within this distance of the server's idea of the player. */
const MAX_THROW_OFFSET = 2.5;

export class Game {
  readonly conns = new Set<Conn>();
  readonly balls = new Map<string, Ball>();
  readonly critters = new Map<string, SpawnInfo>();
  readonly prizes: Prizes;
  readonly guard: Guard;
  readonly cardPlay: CardPlay;
  event: EventInfo | null = null;
  launched: boolean;
  vaultUsd: number;
  nextClaimAt = 0;
  private claiming = false;
  private buying = false;
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
    readonly log: Logger,
  ) {
    this.launched = (kvGet(db, 'launched') ?? String(CONFIG.launchedDefault)) === 'true';
    this.vaultUsd = Number(kvGet(db, 'vault_usd') ?? 0);
    this.prizes = new Prizes(db);
    this.guard = new Guard(db);
    const game = this;
    this.cardPlay = new CardPlay(
      {
        db,
        get launched() {
          return game.launched;
        },
        broadcast: (m) => this.broadcast(m),
        sendTo: (id, m) => {
          const c = this.connFor(id);
          if (c) this.send(c, m);
        },
        systemChat: (text) => this.systemChat(text),
        trainerPositions: () => [...this.conns].filter((c) => c.player && c.mode === 'island').map((c) => c.pos),
        writeMemo: (text) => this.chain.writeMemo(text),
        log,
      },
      this.prizes,
      this.guard,
    );
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
    setInterval(() => void this.cardPlay.checkSchedule().catch((e) => this.log.error(e, 'scheduled release failed')), 5_000);
    setInterval(() => this.guard.prune(), 3_600_000);
    if (this.launched) void this.maybeBuyCard();
  }

  // ── Connections ───────────────────────────────────────────────────────

  connect(ws: WebSocket, ip: string): void {
    const ipHash = hashIp(ip);
    if ([...this.conns].filter((o) => o.ipHash === ipHash).length >= MAX_SOCKETS_PER_IP) {
      ws.close(1008, 'too many connections from this network');
      return;
    }
    const c: Conn = {
      ws,
      ip,
      ipHash,
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
      card: this.cardPlay.publicCard(),
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
    let player: PlayerRow;
    try {
      player = this.store.upsertPlayer(token, cleanName(name), c.ipHash);
    } catch (e) {
      if (!(e instanceof AccountLimitError)) throw e;
      this.toast(c, e.message, 'warn');
      c.ws.close(4001, 'account limit');
      return;
    }
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
    return {
      id: p.id,
      name: p.name,
      gold: p.gold,
      dex: this.store.dex(p.id),
      goldThisHour: this.guard.pickupsThisHour(p.id),
      claims: this.prizes.claimsFor(p.id),
    };
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
      this.guard.strike(c.player.id, 'movement', `jump ${horiz.toFixed(1)}m in ${dt.toFixed(2)}s at ${m.x.toFixed(0)},${m.z.toFixed(0)}`);
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
    const okVec = (v: Vec3) => v && [v.x, v.y, v.z].every(Number.isFinite);
    if ((m.kind !== 'orb' && m.kind !== 'gold') || !okVec(m.o) || !okVec(m.d)) return;
    const now = Date.now();
    const reject = (reason: string) => {
      this.guard.logThrow({ playerId: c.player!.id, ipHash: c.ipHash, kind: m.kind, releaseId: this.cardPlay.release?.id ?? null, o: m.o, d: m.d, clientAt: m.at, result: `rejected:${reason}` });
    };

    c.throwTimes = c.throwTimes.filter((t) => now - t < 1000);
    if (c.throwTimes.length >= 4 || (m.kind === 'gold' && now - c.lastGoldAt < 450)) {
      reject('rate');
      this.guard.strike(c.player.id, 'throw-rate', `${c.throwTimes.length} throws in 1s`);
      return;
    }
    c.throwTimes.push(now);

    const len = Math.hypot(m.d.x, m.d.y, m.d.z);
    if (len < 0.5 || len > 1.5) return reject('direction');
    const d = { x: m.d.x / len, y: m.d.y / len, z: m.d.z / len };
    let o = m.o;
    const offset = Math.hypot(o.x - c.pos.x, o.z - c.pos.z);
    const tooFar = offset > MAX_THROW_OFFSET || o.y < c.pos.y - 0.5 || o.y > c.pos.y + EYE_HEIGHT + 1.5;
    if (tooFar) {
      this.guard.strike(c.player.id, 'throw-origin', `${m.kind} ${offset.toFixed(1)}m from position`);
      // Golden balls are rolls for real prizes: a throw from somewhere you aren't is refused outright.
      if (m.kind === 'gold') return reject('origin');
      o = { x: c.pos.x, y: c.pos.y + EYE_HEIGHT - 0.15, z: c.pos.z };
    }
    const at = Number.isFinite(m.at) ? Math.min(now + 150, Math.max(now - 700, m.at)) : now;

    if (m.kind === 'orb') {
      this.broadcast({ t: 'fx', kind: m.kind, o, d, by: c.player.id }, c);
      this.orbThrow(c.player, o, d, at);
    } else {
      c.lastGoldAt = now;
      this.goldThrow(c, o, d, at, m.at);
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
    const cards = (this.db.prepare('SELECT COUNT(*) AS n FROM prizes WHERE winner_id = ?').get(playerId) as Row).n as number;
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

  /** Spends a golden ball, logs the throw and hands it to the server-side flight simulation. */
  private goldThrow(c: Conn, o: Vec3, d: Vec3, at: number, clientAt: number): void {
    const player = c.player!;
    const log = (result: string) =>
      this.guard.logThrow({ playerId: player.id, ipHash: c.ipHash, kind: 'gold', releaseId: this.cardPlay.release?.id ?? null, o, d, clientAt, result });
    if (!this.launched) return void log('rejected:prelaunch');
    if (this.guard.isBanned(player.id)) {
      log('rejected:banned');
      return this.toast(c, 'Golden balls are disabled for this account. Contact the team.', 'warn');
    }
    if (!this.store.spendGold(player.id)) {
      log('rejected:empty');
      this.sendBag(c);
      return this.toast(c, 'No golden balls left. Find more on the island!', 'warn');
    }
    this.sendBag(c);
    this.broadcast({ t: 'fx', kind: 'gold', o, d, by: player.id }, c);
    this.cardPlay.addShot(player, o, d, at, log('pending'));
  }

  // ── Golden balls ──────────────────────────────────────────────────────

  private onPickup(c: Conn, id: string): void {
    if (!c.player || !this.launched) return;
    const b = this.balls.get(id);
    if (!b) return;
    if (Math.hypot(b.x - c.pos.x, b.z - c.pos.z) > PICKUP_RADIUS + 1.5 || Math.abs(b.y - c.pos.y) > 3.5) {
      this.guard.strike(c.player.id, 'pickup-distance', `ball ${Math.hypot(b.x - c.pos.x, b.z - c.pos.z).toFixed(1)}m away`);
      return;
    }
    if (this.guard.isBanned(c.player.id)) return;
    const blocked = this.guard.pickupBlocked(c.player.id, c.ipHash, this.prizes.settings().goldPerHour);
    if (blocked) {
      const mins = Math.max(1, Math.ceil((blocked.retryAt - Date.now()) / 60_000));
      return this.toast(c, `🟡 ${blocked.reason} Next golden ball in ~${mins} min.`, 'warn');
    }
    this.balls.delete(id);
    this.ballsDirty = true;
    this.guard.recordPickup(c.player.id, c.ipHash);
    this.store.addGold(c.player.id, 1);
    this.sendBag(c);
    this.broadcast({ t: 'ball-', id });
    this.broadcastEconomy();
  }

  private sendBag(c: Conn): void {
    if (!c.player) return;
    const gold = this.store.playerById(c.player.id)?.gold ?? 0;
    this.send(c, { t: 'bag', gold, goldThisHour: this.guard.pickupsThisHour(c.player.id) });
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
        const vaultPart = CONFIG.vaultAutoBuy ? claim.usd * CONFIG.vaultShare : 0;
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

  /** VAULT_AUTO_BUY only: spend the vault on cards and shelve them in the catalog as Tier B prizes. */
  async maybeBuyCard(): Promise<void> {
    if (!CONFIG.vaultAutoBuy || this.buying) return;
    this.buying = true;
    try {
      while (this.vaultUsd >= CONFIG.cardThresholdUsd) {
        const listing = await this.cards.findCard(this.vaultUsd);
        if (!listing) break;
        const paySig = await this.chain.payUsdc(listing.payTo, listing.priceUsd);
        await this.cards.confirmPurchase(listing, paySig);
        this.setVault(this.vaultUsd - listing.priceUsd);
        const prize = this.prizes.create({ name: listing.name, set: listing.set, grade: listing.grade, tier: 'B' });
        if (listing.image.startsWith('https://')) this.db.prepare('UPDATE prizes SET photo = ? WHERE id = ?').run(listing.image, prize.id);
        this.log.info({ name: listing.name, price: listing.priceUsd, paySig }, 'card purchased into the catalog');
      }
    } catch (e) {
      this.log.error(e, 'card purchase failed');
    } finally {
      this.buying = false;
    }
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
    this.cardPlay.tick(now);
  }

  // ── Launch ────────────────────────────────────────────────────────────

  setLaunched(v: boolean): void {
    if (this.launched === v) return;
    this.launched = v;
    kvSet(this.db, 'launched', v);
    if (v && !kvGet(this.db, 'launched_at')) kvSet(this.db, 'launched_at', Date.now());
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
      nextClaimAt: this.nextClaimAt,
      online: this.onlineCount(),
      cardsCaught: (this.db.prepare("SELECT COUNT(*) AS n FROM prizes WHERE status IN ('won','shipped')").get() as Row).n as number,
      nextRelease: this.launched ? this.cardPlay.nextRelease() : null,
      prizesLeft: this.prizes.availableCount(),
      goldPerHour: this.prizes.settings().goldPerHour,
      vault: CONFIG.vaultAutoBuy ? { usd: this.vaultUsd, threshold: CONFIG.cardThresholdUsd } : null,
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
    this.sendBag(c);
  }

  /** Push a winner's updated claim list (after verify/ship) if they're online. */
  refreshClaims(playerId: string | null): void {
    const c = playerId ? this.connFor(playerId) : null;
    if (!c?.player) return;
    this.send(c, { t: 'you', you: this.youInfo(c.player), spawn: c.pos, mode: c.mode });
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
