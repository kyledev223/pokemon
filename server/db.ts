import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;
// node:sqlite rows come back as loosely typed records; callers cast to their row shape.
export type Row = Record<string, any>;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS players (
      id TEXT PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      ip_hash TEXT,
      gold INTEGER NOT NULL DEFAULT 0,
      wallet TEXT,
      bonus_granted INTEGER NOT NULL DEFAULT 0,
      arena_points INTEGER NOT NULL DEFAULT 0,
      gold_hits INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS waitlist (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT UNIQUE NOT NULL REFERENCES players(id),
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS waitlist_ip ON waitlist(ip_hash);

    CREATE TABLE IF NOT EXISTS critters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL REFERENCES players(id),
      species INTEGER NOT NULL,
      locked INTEGER NOT NULL DEFAULT 0,
      caught_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS critters_owner ON critters(owner_id);

    CREATE TABLE IF NOT EXISTS cards (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      set_name TEXT NOT NULL,
      grade TEXT NOT NULL,
      value_usd REAL NOT NULL,
      price_usd REAL NOT NULL,
      image TEXT NOT NULL,
      mint TEXT,
      species INTEGER NOT NULL,
      status TEXT NOT NULL,            -- queued | in_play | caught | claimed
      purchase_sig TEXT,
      seed INTEGER,
      released_at INTEGER,
      secret TEXT,
      commitment TEXT,
      memo_sig TEXT,
      throw_count INTEGER NOT NULL DEFAULT 0,
      winner_id TEXT,
      winner_name TEXT,
      winner_wallet TEXT,
      caught_at INTEGER,
      transfer_sig TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS throws (
      card_id TEXT NOT NULL REFERENCES cards(id),
      idx INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      odds REAL NOT NULL,
      won INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (card_id, idx)
    );

    CREATE TABLE IF NOT EXISTS offers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seller_id TEXT NOT NULL,
      seller_name TEXT NOT NULL,
      critter_id INTEGER NOT NULL,
      species INTEGER NOT NULL,
      kind TEXT NOT NULL,              -- swap | sale
      want_species INTEGER,
      price REAL,
      seller_wallet TEXT,
      status TEXT NOT NULL DEFAULT 'open', -- open | done | cancelled
      buyer_id TEXT,
      tx_sig TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      closed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS fee_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usd REAL NOT NULL,
      sol REAL NOT NULL,
      signature TEXT NOT NULL,
      balls INTEGER NOT NULL,
      vault_usd REAL NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

    -- Real-card prize catalog: one row per physical card the operator owns.
    CREATE TABLE IF NOT EXISTS prizes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      set_name TEXT NOT NULL DEFAULT '',
      grade TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL,              -- S | A | B
      photo TEXT,                      -- file name in the photos dir, or an https URL
      status TEXT NOT NULL DEFAULT 'available', -- available | in_play | won | shipped
      winner_id TEXT,
      winner_name TEXT,
      release_id TEXT,
      winning_idx INTEGER,
      claim_code TEXT UNIQUE,
      claim_verified_at INTEGER,
      tracking TEXT,
      created_at INTEGER NOT NULL,
      released_at INTEGER,
      won_at INTEGER,
      shipped_at INTEGER
    );

    -- Every time a prize goes onto the island. The release id is the cardId in the HMAC message.
    CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY,
      prize_id TEXT NOT NULL REFERENCES prizes(id),
      tier TEXT NOT NULL,
      secret TEXT NOT NULL,
      commitment TEXT NOT NULL,
      memo_sig TEXT NOT NULL DEFAULT '',
      odds_base REAL NOT NULL,
      odds_step REAL NOT NULL,
      odds_cap REAL NOT NULL,
      released_at INTEGER NOT NULL,
      ended_at INTEGER,
      end_reason TEXT,                 -- caught | recalled
      throw_count INTEGER NOT NULL DEFAULT 0,
      winner_id TEXT,
      winner_name TEXT
    );

    -- Rolled hits per release (what the verifier replays).
    CREATE TABLE IF NOT EXISTS release_throws (
      release_id TEXT NOT NULL REFERENCES releases(id),
      idx INTEGER NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      odds REAL NOT NULL,
      won INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (release_id, idx)
    );

    -- Server log of every golden throw and every rejected throw.
    CREATE TABLE IF NOT EXISTS throw_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      ip_hash TEXT,
      kind TEXT NOT NULL,
      release_id TEXT,
      origin TEXT NOT NULL,
      dir TEXT NOT NULL,
      client_at INTEGER,
      result TEXT NOT NULL,            -- pending | hit | miss | rejected:<reason>
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS throw_log_player ON throw_log(player_id, created_at);
    CREATE INDEX IF NOT EXISTS throw_log_release ON throw_log(release_id);

    CREATE TABLE IF NOT EXISTS pickups (
      player_id TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS pickups_player ON pickups(player_id, created_at);
    CREATE INDEX IF NOT EXISTS pickups_ip ON pickups(ip_hash, created_at);

    CREATE TABLE IF NOT EXISTS flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS flags_player ON flags(player_id);
  `);
  addColumn(db, 'players', 'banned', 'INTEGER NOT NULL DEFAULT 0');
  return db;
}

/** Tiny forward-only migration for columns added after a DB was created. */
function addColumn(db: DB, table: string, column: string, def: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Row[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
}

export function kvGet(db: DB, k: string): string | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(k) as Row | undefined;
  return row ? (row.v as string) : null;
}

export function kvSet(db: DB, k: string, v: string | number | boolean): void {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
