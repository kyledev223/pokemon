import { randomInt } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CONFIG } from './config';
import { kvGet, kvSet, type DB, type Row } from './db';
import { newId } from './store';
import {
  CLAIM_ALPHABET,
  DEFAULT_SETTINGS,
  SEED_PRIZES,
  TIERS,
  type MyClaim,
  type PrizeStatus,
  type PublicPrize,
  type Settings,
  type Tier,
  type TierOdds,
} from '../shared/prizes';

export interface PrizeRow {
  id: string;
  name: string;
  set_name: string;
  grade: string;
  tier: Tier;
  photo: string | null;
  status: PrizeStatus;
  winner_id: string | null;
  winner_name: string | null;
  release_id: string | null;
  winning_idx: number | null;
  claim_code: string | null;
  claim_verified_at: number | null;
  tracking: string | null;
  created_at: number;
  released_at: number | null;
  won_at: number | null;
  shipped_at: number | null;
}

export interface ReleaseRow {
  id: string;
  prize_id: string;
  tier: Tier;
  secret: string;
  commitment: string;
  memo_sig: string;
  odds_base: number;
  odds_step: number;
  odds_cap: number;
  released_at: number;
  ended_at: number | null;
  end_reason: 'caught' | 'recalled' | null;
  throw_count: number;
  winner_id: string | null;
  winner_name: string | null;
}

export const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

export const oddsOf = (r: ReleaseRow): TierOdds => ({ base: r.odds_base, step: r.odds_step, cap: r.odds_cap });

/** Validates admin input for one tier's odds. Throws on nonsense values. */
function cleanOdds(o: Partial<TierOdds> | undefined, fallback: TierOdds): TierOdds {
  const base = Number(o?.base ?? fallback.base);
  const step = Number(o?.step ?? fallback.step);
  const cap = Number(o?.cap ?? fallback.cap);
  if (![base, step, cap].every(Number.isFinite) || base <= 0 || step < 0 || cap < base || cap > 1) {
    throw new Error('Odds need 0 < start ≤ cap ≤ 1 and a step ≥ 0.');
  }
  return { base, step, cap };
}

/** The operator's catalog of real cards, release settings and claim codes. */
export class Prizes {
  readonly photoDir: string;

  constructor(readonly db: DB) {
    this.photoDir = CONFIG.dbPath === ':memory:' ? resolve('data/photos') : join(dirname(resolve(CONFIG.dbPath)), 'photos');
    mkdirSync(this.photoDir, { recursive: true });
    this.seed();
  }

  /** First boot only: the cards listed in the brief, ready for photos and set/grade details. */
  private seed(): void {
    if (kvGet(this.db, 'prizes_seeded')) return;
    const now = Date.now();
    const insert = this.db.prepare('INSERT INTO prizes (id, name, tier, created_at) VALUES (?, ?, ?, ?)');
    SEED_PRIZES.forEach((p, i) => insert.run(newId('prize'), p.name, p.tier, now + i));
    kvSet(this.db, 'prizes_seeded', 1);
  }

  // ── Settings ──────────────────────────────────────────────────────────

  settings(): Settings {
    const saved = JSON.parse(kvGet(this.db, 'prize_settings') ?? 'null') as Partial<Settings> | null;
    const base: Settings = { ...DEFAULT_SETTINGS, goldPerHour: CONFIG.goldPerHour, teleportMinutes: CONFIG.cardTeleportMinutes };
    if (!saved) return base;
    return {
      odds: { ...base.odds, ...saved.odds },
      everyHours: { ...base.everyHours, ...saved.everyHours },
      goldPerHour: saved.goldPerHour ?? base.goldPerHour,
      teleportMinutes: saved.teleportMinutes ?? base.teleportMinutes,
    };
  }

  saveSettings(input: Partial<Settings>): Settings {
    const cur = this.settings();
    const next: Settings = {
      odds: { S: cur.odds.S, A: cur.odds.A, B: cur.odds.B },
      everyHours: { ...cur.everyHours },
      goldPerHour: cur.goldPerHour,
      teleportMinutes: cur.teleportMinutes,
    };
    for (const t of TIERS) {
      if (input.odds?.[t]) next.odds[t] = cleanOdds(input.odds[t], cur.odds[t]);
      if (input.everyHours && t in input.everyHours) {
        const h = input.everyHours[t];
        if (h !== null && (!Number.isFinite(Number(h)) || Number(h) <= 0)) throw new Error('Release interval must be a positive number of hours, or manual.');
        next.everyHours[t] = h === null ? null : Number(h);
      }
    }
    if (input.goldPerHour !== undefined) {
      const n = Math.floor(Number(input.goldPerHour));
      if (!(n >= 1 && n <= 1000)) throw new Error('Golden balls per hour must be 1–1000.');
      next.goldPerHour = n;
    }
    if (input.teleportMinutes !== undefined) {
      const m = Number(input.teleportMinutes);
      if (!(m >= 0.5 && m <= 120)) throw new Error('Teleport interval must be 0.5–120 minutes.');
      next.teleportMinutes = m;
    }
    kvSet(this.db, 'prize_settings', JSON.stringify(next));
    return next;
  }

  // ── Catalog ───────────────────────────────────────────────────────────

  all(): PrizeRow[] {
    return this.db.prepare("SELECT * FROM prizes ORDER BY CASE tier WHEN 'S' THEN 0 WHEN 'A' THEN 1 ELSE 2 END, created_at").all() as unknown as PrizeRow[];
  }

  byId(id: string): PrizeRow | undefined {
    return this.db.prepare('SELECT * FROM prizes WHERE id = ?').get(id) as unknown as PrizeRow | undefined;
  }

  byCode(code: string): PrizeRow | undefined {
    return this.db.prepare('SELECT * FROM prizes WHERE claim_code = ?').get(code) as unknown as PrizeRow | undefined;
  }

  create(input: { name?: unknown; set?: unknown; grade?: unknown; tier?: unknown }): PrizeRow {
    const id = newId('prize');
    const { name, set, grade, tier } = this.cleanFields(input, true);
    this.db.prepare('INSERT INTO prizes (id, name, set_name, grade, tier, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name!, set ?? '', grade ?? '', tier!, Date.now());
    return this.byId(id)!;
  }

  update(id: string, input: { name?: unknown; set?: unknown; grade?: unknown; tier?: unknown }): PrizeRow {
    const row = this.byId(id);
    if (!row) throw new Error('No such card.');
    const f = this.cleanFields(input, false);
    if (f.tier && f.tier !== row.tier && row.status === 'in_play') throw new Error('Recall the card before changing its tier.');
    this.db
      .prepare('UPDATE prizes SET name = ?, set_name = ?, grade = ?, tier = ? WHERE id = ?')
      .run(f.name ?? row.name, f.set ?? row.set_name, f.grade ?? row.grade, f.tier ?? row.tier, id);
    return this.byId(id)!;
  }

  /** Only cards that never went onto the island can be deleted (released ones are part of the fair log). */
  remove(id: string): void {
    const row = this.byId(id);
    if (!row) throw new Error('No such card.');
    const released = this.db.prepare('SELECT 1 FROM releases WHERE prize_id = ? LIMIT 1').get(id);
    if (row.status !== 'available' || released) throw new Error('Only never-released cards can be deleted.');
    this.removePhotoFile(row);
    this.db.prepare('DELETE FROM prizes WHERE id = ?').run(id);
  }

  private cleanFields(input: { name?: unknown; set?: unknown; grade?: unknown; tier?: unknown }, requireAll: boolean) {
    const str = (v: unknown, max: number) => (v === undefined ? undefined : String(v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, max));
    const name = str(input.name, 60);
    const set = str(input.set, 60);
    const grade = str(input.grade, 40);
    const tier = input.tier === undefined ? undefined : (String(input.tier).toUpperCase() as Tier);
    if ((requireAll || name !== undefined) && !name) throw new Error('Card name is required.');
    if ((requireAll || tier !== undefined) && !TIERS.includes(tier!)) throw new Error('Tier must be S, A or B.');
    return { name, set, grade, tier };
  }

  savePhoto(id: string, mime: string, data: Buffer): PrizeRow {
    const row = this.byId(id);
    if (!row) throw new Error('No such card.');
    const ext = PHOTO_TYPES[mime];
    if (!ext) throw new Error('Upload a JPEG, PNG or WebP photo.');
    if (!data.length || data.length > MAX_PHOTO_BYTES) throw new Error('Photo must be under 6 MB.');
    if (!looksLike(ext, data)) throw new Error("That file doesn't look like a real image.");
    this.removePhotoFile(row);
    const file = `${id}-${Date.now().toString(36)}.${ext}`;
    writeFileSync(join(this.photoDir, file), data);
    this.db.prepare('UPDATE prizes SET photo = ? WHERE id = ?').run(file, id);
    return this.byId(id)!;
  }

  private removePhotoFile(row: PrizeRow): void {
    if (!row.photo || row.photo.includes('/')) return;
    try {
      unlinkSync(join(this.photoDir, row.photo));
    } catch {
      /* already gone */
    }
  }

  /** URL the browser loads the card photo from (placeholder art until a photo is uploaded). */
  imageUrl(row: PrizeRow): string {
    if (row.photo?.startsWith('https://')) return row.photo;
    return `/api/prizes/${row.id}/photo${row.photo ? `?v=${encodeURIComponent(row.photo)}` : ''}`;
  }

  publicPrize(row: PrizeRow): PublicPrize {
    return {
      id: row.id,
      name: row.name,
      set: row.set_name,
      grade: row.grade,
      tier: row.tier,
      status: row.status,
      image: this.imageUrl(row),
      winnerName: row.winner_name,
      wonAt: row.won_at,
      shippedAt: row.shipped_at,
      releaseId: row.release_id,
    };
  }

  claimsFor(playerId: string): MyClaim[] {
    const rows = this.db.prepare('SELECT * FROM prizes WHERE winner_id = ? ORDER BY won_at DESC').all(playerId) as unknown as PrizeRow[];
    return rows.map((r) => ({ code: r.claim_code!, prize: this.publicPrize(r), verified: !!r.claim_verified_at }));
  }

  /** CLAIM-XXXX-XXXX from a CSPRNG, retried on the (astronomically unlikely) collision. */
  newClaimCode(): string {
    for (;;) {
      const part = () => Array.from({ length: 4 }, () => CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)]).join('');
      const code = `CLAIM-${part()}-${part()}`;
      if (!this.byCode(code)) return code;
    }
  }

  // ── Releases ──────────────────────────────────────────────────────────

  release(id: string): ReleaseRow | undefined {
    return this.db.prepare('SELECT * FROM releases WHERE id = ?').get(id) as unknown as ReleaseRow | undefined;
  }

  /** A random available card of the tier, or null when that shelf is empty. */
  pickAvailable(tier: Tier): PrizeRow | null {
    const rows = this.db.prepare("SELECT * FROM prizes WHERE status = 'available' AND tier = ?").all(tier) as unknown as PrizeRow[];
    return rows.length ? rows[randomInt(rows.length)] : null;
  }

  availableCount(tier?: Tier): number {
    const row = tier
      ? this.db.prepare("SELECT COUNT(*) AS n FROM prizes WHERE status = 'available' AND tier = ?").get(tier)
      : this.db.prepare("SELECT COUNT(*) AS n FROM prizes WHERE status = 'available'").get();
    return (row as Row).n as number;
  }
}

/** Magic-byte check so a renamed file can't masquerade as a photo. */
function looksLike(ext: string, b: Buffer): boolean {
  if (ext === 'jpg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (ext === 'png') return b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
}
