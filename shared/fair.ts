// Catch odds + the provably-fair roll definition. Both the server (node:crypto) and the
// browser verifier (WebCrypto) implement HMAC-SHA256 and feed the hex digest in here.

import type { TierOdds } from './prizes';

/** Odds for throw index i (throw #n has i = n - 1). Every logged golden-ball hit is one throw. */
export function oddsForThrow(i: number, o: TierOdds): number {
  return Math.min(o.cap, o.base + o.step * i);
}

/** HMAC message for throw i on a card release. */
export function rollMessage(cardId: string, i: number): string {
  return `${cardId}:${i}`;
}

/** The whole 256-bit HMAC digest read as an integer, divided by 2^256 → float in [0,1). */
export function rollFromHex(hex: string): number {
  return Number(BigInt(`0x${hex}`)) / 2 ** 256;
}

/** Mean number of hits until a catch, given an odds ramp. */
export function expectedHits(o: TierOdds): number {
  let survive = 1;
  let mean = 0;
  for (let i = 0; i < 100_000 && survive > 1e-12; i++) {
    const p = oddsForThrow(i, o);
    mean += (i + 1) * survive * p;
    survive *= 1 - p;
  }
  return mean;
}

export function bonusForPosition(position: number): number {
  if (position <= 100) return 10;
  if (position <= 500) return 6;
  if (position <= 2000) return 4;
  return 2;
}
