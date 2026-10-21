import type { Economy, PublicCard, YouInfo } from '../shared/protocol';
import type { PublicPrize, Tier, TierOdds } from '../shared/prizes';
import type { Move } from '../shared/species';

const TOKEN_KEY = 'cove.token';
const NAME_KEY = 'cove.name';

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode: session-only token */
  }
}

let memToken: string | null = null;

/** Random browser token: the only "account" a player has. */
export function token(): string {
  const existing = safeGet(TOKEN_KEY) ?? memToken;
  if (existing && /^[a-f0-9]{32,64}$/.test(existing)) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const t = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  memToken = t;
  safeSet(TOKEN_KEY, t);
  return t;
}

export const savedName = () => safeGet(NAME_KEY) ?? '';
export const saveName = (n: string) => safeSet(NAME_KEY, n);
export const prefGet = safeGet;
export const prefSet = safeSet;

export class ApiError extends Error {}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json as T;
}

export interface Status {
  brand: { name: string; ticker: string; buyUrl: string; socials: { x: string; telegram: string } };
  launched: boolean;
  launchAt: string | null;
  tokenMint: string | null;
  vaultWallet: string | null;
  explorerSuffix: string;
  economy: Economy;
  card: PublicCard | null;
  waitlistTotal: number;
  tiers: Record<Tier, TierInfo>;
  masterWinner: { name: string } | null;
}

export interface TierInfo {
  odds: TierOdds;
  expectedHits: number;
  /** Hours between automatic releases; null = manual drops only. */
  everyHours: number | null;
  available: number;
}

export interface CollectionItem {
  id: number;
  species: number;
  locked: number;
  caught_at: number;
  listed: number;
}

export interface Me {
  you: YouInfo;
  waitlist: { position: number; total: number } | null;
  collection: CollectionItem[];
}

export interface Offer {
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

/** One card release on the Verify page (`id` is the cardId in the HMAC message). */
export interface FairCard {
  id: string;
  name: string;
  tier: Tier;
  /** in_play | caught | recalled */
  status: string;
  commitment: string;
  memoSig: string;
  throws: number;
  revealed: boolean;
  odds: TierOdds;
  releasedAt: number;
}

export interface FairDetail extends Omit<FairCard, 'throws'> {
  secret: string | null;
  winnerName: string | null;
  endedAt: number | null;
  throws: { index: number; player: string; odds: number; won: boolean; at: number }[];
}

type Ranked = { name: string; score: number }[];

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  waitlist: (name: string) =>
    req<{ position: number; total: number; bonus: number; sameNetwork: boolean }>('POST', '/api/waitlist', { token: token(), name }),
  me: () => req<Me>('GET', `/api/me?token=${token()}`),
  prizes: () => req<PublicPrize[]>('GET', '/api/prizes'),
  fairList: () => req<FairCard[]>('GET', '/api/fair'),
  fair: (id: string) => req<FairDetail>('GET', `/api/fair/${encodeURIComponent(id)}`),
  ranks: () => req<{ dex: Ranked; hits: Ranked; cards: Ranked; arena: Ranked }>('GET', '/api/ranks'),
  offers: () => req<Offer[]>('GET', '/api/market/offers'),
  postOffer: (o: { critterId: number; kind: 'swap' | 'sale'; wantSpecies?: number; price?: number; wallet?: string }) =>
    req<Offer>('POST', '/api/market/offers', { token: token(), ...o }),
  acceptOffer: (id: number, b: { critterId?: number; txSig?: string }) => req('POST', `/api/market/offers/${id}/accept`, { token: token(), ...b }),
  cancelOffer: (id: number) => req('POST', `/api/market/offers/${id}/cancel`, { token: token() }),
  arenaStart: (critters: number[]) => req<{ battleId: string; foeName: string; state: BattleState }>('POST', '/api/arena/start', { token: token(), critters }),
  arenaMove: (battleId: string, move: number) =>
    req<{ log: string[]; state: BattleState; done: boolean; won?: boolean; points?: number }>('POST', '/api/arena/move', { token: token(), battleId, move }),
};

export interface FighterView {
  species: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  moves: Move[];
}

export interface BattleState {
  you: FighterView | null;
  foe: FighterView | null;
  yourTeam: { species: number; hp: number; maxHp: number }[];
  foeTeam: { species: number; hp: number; maxHp: number }[];
  turn: number;
}
