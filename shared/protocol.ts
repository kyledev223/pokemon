import type { Region } from './species';
import type { SpawnInfo, Vec3 } from './world';

export interface PublicCard {
  id: string;
  name: string;
  set: string;
  grade: string;
  valueUsd: number;
  image: string;
  species: number;
  seed: number;
  releasedAt: number;
  commitment: string;
  memoSig: string;
  throws: number;
  nextOdds: number;
}

export interface WonCard {
  id: string;
  name: string;
  set: string;
  grade: string;
  valueUsd: number;
  image: string;
  winnerName: string;
  caughtAt: number;
  throws: number;
  transferSig: string | null;
  memoSig: string;
  purchaseSig: string | null;
}

export interface PlayerPos {
  id: string;
  name: string;
  title: string | null;
  x: number;
  y: number;
  z: number;
  ry: number;
}

export interface Ball {
  id: string;
  x: number;
  y: number;
  z: number;
}

export interface Economy {
  launched: boolean;
  vaultUsd: number;
  threshold: number;
  nextClaimAt: number;
  online: number;
  cardsCaught: number;
  /** Golden balls currently lying on the island. */
  balls: number;
  /** Trainers who completed the 30-species island dex, earliest first. */
  dexMasters: string[];
}

export interface ChatLine {
  id: number;
  name: string;
  title: string | null;
  text: string;
  at: number;
  /** System lines (catches, drops) have no author. */
  system?: boolean;
}

export interface EventInfo {
  region: Region;
  species: number;
  endsAt: number;
}

export interface YouInfo {
  id: string;
  name: string;
  gold: number;
  dex: number[];
  wallet: string | null;
  pendingCards: { id: string; name: string }[];
}

export type ThrowKind = 'orb' | 'gold';

export type ClientMsg =
  | { t: 'watch' }
  | { t: 'hello'; token: string; name: string }
  | { t: 'pos'; x: number; y: number; z: number; ry: number }
  | { t: 'throw'; kind: ThrowKind; o: Vec3; d: Vec3; at: number }
  | { t: 'pickup'; id: string }
  | { t: 'chat'; text: string }
  | { t: 'ping'; c: number };

export type ServerMsg =
  | {
      t: 'init';
      now: number;
      players: PlayerPos[];
      balls: Ball[];
      critters: SpawnInfo[];
      card: PublicCard | null;
      economy: Economy;
      event: EventInfo | null;
      chat: ChatLine[];
    }
  | { t: 'you'; you: YouInfo; spawn: Vec3; mode: 'lobby' | 'island' }
  | { t: 'players'; list: PlayerPos[] }
  | { t: 'left'; id: string }
  | { t: 'balls+'; balls: Ball[] }
  | { t: 'ball-'; id: string }
  | { t: 'critter+'; spawns: SpawnInfo[] }
  | { t: 'critter-'; id: string }
  /** A pink orb hit a critter; the orb wobbles until the matching 'catch' arrives. */
  | { t: 'catchStart'; spawnId: string; byId: string; at: Vec3 }
  | { t: 'catch'; ok: boolean; spawnId: string; species: number; by: string; byId: string; isNew: boolean }
  | { t: 'card'; card: PublicCard | null }
  | { t: 'cardHit'; cardId: string; index: number; odds: number; by: string; byId: string; won: boolean }
  | { t: 'cardCaught'; cardId: string; name: string; by: string; byId: string; secret: string }
  | { t: 'economy'; e: Economy }
  | { t: 'bag'; gold: number }
  | { t: 'dex'; dex: number[] }
  | { t: 'fx'; kind: ThrowKind; o: Vec3; d: Vec3; by: string }
  | { t: 'toast'; text: string; tone: 'info' | 'gold' | 'pink' | 'warn' }
  | { t: 'correct'; x: number; y: number; z: number }
  | { t: 'event'; event: EventInfo | null }
  | { t: 'chat'; line: ChatLine }
  | { t: 'pong'; c: number; now: number };
