import type { Economy, PublicCard, WonCard, YouInfo } from '../shared/protocol';

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
  explorerSuffix: string;
  economy: Economy;
  card: PublicCard | null;
  waitlistTotal: number;
  odds: { base: number; step: number; cap: number; expectedHits: number };
  masterWinner: { name: string } | null;
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

export interface FairCard {
  id: string;
  name: string;
  status: string;
  commitment: string;
  memoSig: string;
  throws: number;
  revealed: boolean;
}

export interface FairDetail {
  id: string;
  name: string;
  status: string;
  commitment: string;
  memoSig: string;
  secret: string | null;
  winnerName: string | null;
  throws: { index: number; player: string; odds: number; won: boolean; at: number }[];
}

type Ranked = { name: string; score: number }[];

export const api = {
  status: () => req<Status>('GET', '/api/status'),
  waitlist: (name: string) =>
    req<{ position: number; total: number; bonus: number; sameNetwork: boolean }>('POST', '/api/waitlist', { token: token(), name }),
  me: () => req<Me>('GET', `/api/me?token=${token()}`),
  setWallet: (wallet: string) => req<{ you: YouInfo }>('POST', '/api/wallet', { token: token(), wallet }),
  wonCards: () => req<WonCard[]>('GET', '/api/cards/won'),
  fairList: () => req<FairCard[]>('GET', '/api/fair'),
  fair: (id: string) => req<FairDetail>('GET', `/api/fair/${encodeURIComponent(id)}`),
  ranks: () => req<{ dex: Ranked; hits: Ranked; cards: Ranked; arena: Ranked }>('GET', '/api/ranks'),
  offers: () => req<Offer[]>('GET', '/api/market/offers'),
  postOffer: (o: { critterId: number; kind: 'swap' | 'sale'; wantSpecies?: number; price?: number; wallet?: string }) =>
    req<Offer>('POST', '/api/market/offers', { token: token(), ...o }),
  acceptOffer: (id: number, b: { critterId?: number; txSig?: string }) => req('POST', `/api/market/offers/${id}/accept`, { token: token(), ...b }),
  cancelOffer: (id: number) => req('POST', `/api/market/offers/${id}/cancel`, { token: token() }),
  duel: (critters: number[]) =>
    req<{ foeName: string; you: number[]; foe: number[]; log: string[]; won: boolean; points: number }>('POST', '/api/arena/duel', {
      token: token(),
      critters,
    }),
};
