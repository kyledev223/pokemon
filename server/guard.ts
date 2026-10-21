import type { DB, Row } from './db';
import type { Vec3 } from '../shared/world';

// Anti-abuse bookkeeping: throw log, hourly golden-ball caps and automatic flags for
// impossible movement or throw rates. Flags never block on their own; the admin reviews
// them and can ban, which stops golden-ball pickups and throws.

const FLAG_WINDOW_MS = 60_000;
const FLAG_COOLDOWN_MS = 10 * 60_000;
/** Strikes inside one minute before an account is flagged, per reason. */
const FLAG_AT: Record<string, number> = { movement: 8, 'throw-rate': 10, 'throw-origin': 5, 'pickup-distance': 6 };
/** A network (IP hash) may pick up this many times the per-trainer hourly cap. */
const IP_CAP_FACTOR = 2;

export type FlagReason = keyof typeof FLAG_AT;

export class Guard {
  private strikes = new Map<string, number[]>();
  private lastFlag = new Map<string, number>();

  constructor(private db: DB) {}

  // ── Throw log ─────────────────────────────────────────────────────────

  logThrow(t: { playerId: string; ipHash: string | null; kind: string; releaseId: string | null; o: Vec3; d: Vec3; clientAt: number; result: string }): number {
    const r = this.db
      .prepare('INSERT INTO throw_log (player_id, ip_hash, kind, release_id, origin, dir, client_at, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(t.playerId, t.ipHash, t.kind, t.releaseId, vec(t.o), vec(t.d), Math.round(t.clientAt) || null, t.result, Date.now());
    return Number(r.lastInsertRowid);
  }

  setThrowResult(id: number, result: string): void {
    this.db.prepare('UPDATE throw_log SET result = ? WHERE id = ?').run(result, id);
  }

  // ── Golden ball caps ──────────────────────────────────────────────────

  pickupsThisHour(playerId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM pickups WHERE player_id = ? AND created_at > ?').get(playerId, Date.now() - 3_600_000) as Row).n as number;
  }

  /** Null when allowed, otherwise the reason and when the oldest pickup ages out. */
  pickupBlocked(playerId: string, ipHash: string, cap: number): { reason: string; retryAt: number } | null {
    const since = Date.now() - 3_600_000;
    const mine = this.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM pickups WHERE player_id = ? AND created_at > ?').get(playerId, since) as Row;
    if ((mine.n as number) >= cap) return { reason: `Hourly limit reached (${cap}/${cap}).`, retryAt: (mine.first as number) + 3_600_000 };
    const net = this.db.prepare('SELECT COUNT(*) AS n, MIN(created_at) AS first FROM pickups WHERE ip_hash = ? AND created_at > ?').get(ipHash, since) as Row;
    if ((net.n as number) >= cap * IP_CAP_FACTOR) return { reason: 'This network hit its hourly limit.', retryAt: (net.first as number) + 3_600_000 };
    return null;
  }

  recordPickup(playerId: string, ipHash: string): void {
    this.db.prepare('INSERT INTO pickups (player_id, ip_hash, created_at) VALUES (?, ?, ?)').run(playerId, ipHash, Date.now());
  }

  /** Drop pickup rows older than a day so the table stays small. */
  prune(): void {
    this.db.prepare('DELETE FROM pickups WHERE created_at < ?').run(Date.now() - 86_400_000);
  }

  // ── Flags + bans ──────────────────────────────────────────────────────

  /** Counts a strike; flags the player once the per-reason threshold is crossed. Returns true when a flag was raised. */
  strike(playerId: string, reason: FlagReason, detail: string): boolean {
    const now = Date.now();
    const key = `${playerId}:${reason}`;
    const list = (this.strikes.get(key) ?? []).filter((t) => now - t < FLAG_WINDOW_MS);
    list.push(now);
    this.strikes.set(key, list);
    if (list.length < FLAG_AT[reason] || now - (this.lastFlag.get(key) ?? 0) < FLAG_COOLDOWN_MS) return false;
    this.lastFlag.set(key, now);
    this.db.prepare('INSERT INTO flags (player_id, reason, detail, created_at) VALUES (?, ?, ?, ?)').run(playerId, reason, `${list.length} in 60s · ${detail}`.slice(0, 300), now);
    return true;
  }

  isBanned(playerId: string): boolean {
    const row = this.db.prepare('SELECT banned FROM players WHERE id = ?').get(playerId) as Row | undefined;
    return !!row?.banned;
  }

  setBanned(playerId: string, banned: boolean): void {
    this.db.prepare('UPDATE players SET banned = ? WHERE id = ?').run(banned ? 1 : 0, playerId);
  }

  flags(limit = 100): Row[] {
    return this.db
      .prepare(
        `SELECT f.id, f.player_id, p.name AS player_name, p.banned, f.reason, f.detail, f.created_at
         FROM flags f LEFT JOIN players p ON p.id = f.player_id ORDER BY f.id DESC LIMIT ?`,
      )
      .all(limit) as Row[];
  }
}

const vec = (v: Vec3) => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
