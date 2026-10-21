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
  `);
  return db;
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
