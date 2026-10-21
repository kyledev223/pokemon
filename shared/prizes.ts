// Real-card prizes: physical cards from the operator's own collection. Card names here are
// factual descriptions of those items; the game world's creatures stay original.

export type Tier = 'S' | 'A' | 'B';
export const TIERS: Tier[] = ['S', 'A', 'B'];
export const TIER_LABEL: Record<Tier, string> = { S: 'Tier S', A: 'Tier A', B: 'Tier B' };

export type PrizeStatus = 'available' | 'in_play' | 'won' | 'shipped';

/** Per-hit catch odds for one tier: start at `base`, +`step` per miss, never above `cap`. */
export interface TierOdds {
  base: number;
  step: number;
  cap: number;
}

export interface Settings {
  odds: Record<Tier, TierOdds>;
  /** Hours between automatic releases per tier; null = only when the admin triggers it. */
  everyHours: Record<Tier, number | null>;
  /** Golden balls one trainer can pick up per rolling hour. */
  goldPerHour: number;
  /** A roaming card jumps to a new area about this often. */
  teleportMinutes: number;
}

export const DEFAULT_SETTINGS: Settings = {
  odds: {
    S: { base: 0.0005, step: 0.00002, cap: 0.02 },
    A: { base: 0.001, step: 0.00003, cap: 0.03 },
    B: { base: 0.002, step: 0.00005, cap: 0.05 },
  },
  everyHours: { S: null, A: 168, B: 24 },
  goldPerHour: 20,
  teleportMinutes: 4,
};

/** What the public (and the roaming slab) may know about a prize. Never includes the claim code. */
export interface PublicPrize {
  id: string;
  name: string;
  set: string;
  grade: string;
  tier: Tier;
  status: PrizeStatus;
  image: string;
  winnerName: string | null;
  wonAt: number | null;
  shippedAt: number | null;
  /** The winning release (its throw log is public on the Verify page). */
  releaseId: string | null;
}

/** A winner's own view of their claim (only ever sent to that player). */
export interface MyClaim {
  code: string;
  prize: PublicPrize;
  verified: boolean;
}

export const SEED_PRIZES: { name: string; tier: Tier }[] = [
  ...['Charizard', 'Mewtwo', 'Mew', 'Blastoise', 'Venusaur'].map((name) => ({ name, tier: 'S' as Tier })),
  ...['Pikachu', 'Snorlax', 'Charmeleon', 'Wartortle', 'Ivysaur', 'Butterfree'].map((name) => ({ name, tier: 'A' as Tier })),
  ...['Charmander', 'Squirtle', 'Bulbasaur', 'Jigglypuff', 'Caterpie', 'Metapod'].map((name) => ({ name, tier: 'B' as Tier })),
];

/** Claim codes look like CLAIM-7F3K-9QXA (no 0/O/1/I/L to avoid misreads). */
export const CLAIM_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CLAIM_RE = /^CLAIM-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;
