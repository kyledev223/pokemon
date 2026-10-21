import { createHash, randomBytes } from 'node:crypto';
import { CONFIG } from './config';
import type { DB, Row } from './db';
import { bonusForPosition } from '../shared/fair';
import { SPECIES } from '../shared/species';

export interface PlayerRow {
  id: string;
  token_hash: string;
  name: string;
  ip_hash: string | null;
  gold: number;
  wallet: string | null;
  bonus_granted: number;
  arena_points: number;
  gold_hits: number;
  created_at: number;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const hashIp = (ip: string) => sha256(`${CONFIG.ipSalt}:${ip}`);
export const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

export function cleanName(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 16);
  return s.length >= 2 ? s : `Trainer${Math.floor(1000 + Math.random() * 9000)}`;
}

export function isToken(t: unknown): t is string {
  return typeof t === 'string' && /^[a-f0-9]{32,64}$/.test(t);
}

export class Store {
  constructor(readonly db: DB) {}

  playerByToken(token: string): PlayerRow | undefined {
    return this.db.prepare('SELECT * FROM players WHERE token_hash = ?').get(sha256(token)) as PlayerRow | undefined;
  }

  playerById(id: string): PlayerRow | undefined {
    return this.db.prepare('SELECT * FROM players WHERE id = ?').get(id) as PlayerRow | undefined;
  }

  upsertPlayer(token: string, name: string | null, ipHash: string): PlayerRow {
    const existing = this.playerByToken(token);
    if (existing) {
      if (name && name !== existing.name) this.db.prepare('UPDATE players SET name = ? WHERE id = ?').run(name, existing.id);
      return this.playerById(existing.id)!;
    }
    const id = sha256(`player:${token}`).slice(0, 16);
    this.db
      .prepare('INSERT INTO players (id, token_hash, name, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, sha256(token), name ?? cleanName(''), ipHash, Date.now());
    return this.playerById(id)!;
  }

  addGold(playerId: string, delta: number): number {
    this.db.prepare('UPDATE players SET gold = MAX(0, gold + ?) WHERE id = ?').run(delta, playerId);
    return (this.db.prepare('SELECT gold FROM players WHERE id = ?').get(playerId) as Row).gold as number;
  }

  /** Atomically spends one golden ball. Returns false when the bag is empty. */
  spendGold(playerId: string): boolean {
    const r = this.db.prepare('UPDATE players SET gold = gold - 1 WHERE id = ? AND gold > 0').run(playerId);
    return Number(r.changes) === 1;
  }

  // ── Waitlist ──────────────────────────────────────────────────────────

  waitlistTotal(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM waitlist').get() as Row).n as number;
  }

  /** One spot per token and one per IP hash. Returning never moves you down. */
  joinWaitlist(player: PlayerRow, ipHash: string): { position: number; total: number; bonus: number; sameNetwork: boolean } {
    const mine = this.db.prepare('SELECT position FROM waitlist WHERE player_id = ?').get(player.id) as Row | undefined;
    let position: number;
    let sameNetwork = false;
    if (mine) position = mine.position as number;
    else {
      const byIp = this.db.prepare('SELECT position FROM waitlist WHERE ip_hash = ? ORDER BY position LIMIT 1').get(ipHash) as Row | undefined;
      if (byIp) {
        position = byIp.position as number;
        sameNetwork = true;
      } else {
        const r = this.db.prepare('INSERT INTO waitlist (player_id, ip_hash, created_at) VALUES (?, ?, ?)').run(player.id, ipHash, Date.now());
        position = Number(r.lastInsertRowid);
      }
    }
    return { position, total: this.waitlistTotal(), bonus: bonusForPosition(position), sameNetwork };
  }

  waitlistSpot(playerId: string): number | null {
    const row = this.db.prepare('SELECT position FROM waitlist WHERE player_id = ?').get(playerId) as Row | undefined;
    return row ? (row.position as number) : null;
  }

  /** Grants the early bonus exactly once (after launch). Returns how many balls were added. */
  grantLaunchBonus(playerId: string): number {
    const pos = this.waitlistSpot(playerId);
    if (pos === null) return 0;
    const bonus = bonusForPosition(pos);
    const r = this.db.prepare('UPDATE players SET bonus_granted = 1, gold = gold + ? WHERE id = ? AND bonus_granted = 0').run(bonus, playerId);
    return Number(r.changes) === 1 ? bonus : 0;
  }

  // ── Dex ───────────────────────────────────────────────────────────────

  dex(playerId: string): number[] {
    return (this.db.prepare('SELECT DISTINCT species FROM critters WHERE owner_id = ? ORDER BY species').all(playerId) as Row[]).map(
      (r) => r.species as number,
    );
  }

  /** Adds a caught critter. The first catch of each species is locked (can never be traded). */
  addCritter(playerId: string, species: number): { id: number; isNew: boolean } {
    const has = this.db.prepare('SELECT 1 FROM critters WHERE owner_id = ? AND species = ? LIMIT 1').get(playerId, species);
    const r = this.db
      .prepare('INSERT INTO critters (owner_id, species, locked, caught_at) VALUES (?, ?, ?, ?)')
      .run(playerId, species, has ? 0 : 1, Date.now());
    return { id: Number(r.lastInsertRowid), isNew: !has };
  }

  collection(playerId: string) {
    return this.db
      .prepare(
        `SELECT c.id, c.species, c.locked, c.caught_at,
                EXISTS(SELECT 1 FROM offers o WHERE o.critter_id = c.id AND o.status = 'open') AS listed
         FROM critters c WHERE c.owner_id = ? ORDER BY c.species, c.id`,
      )
      .all(playerId) as { id: number; species: number; locked: number; caught_at: number; listed: number }[];
  }

  hasCompletedDex(playerId: string): boolean {
    return this.dex(playerId).length === SPECIES.length;
  }
}
