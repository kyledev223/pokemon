// Catch odds + the provably-fair roll definition. Both the server (node:crypto) and the
// browser verifier (WebCrypto) implement HMAC-SHA256 and feed the hex digest in here.

export const BASE_ODDS = 0.004; // 0.4 %
export const ODDS_STEP = 0.00012; // +0.012 percentage points per miss
export const ODDS_CAP = 0.25; // 25 %

/** Odds for throw index i (throw #n has i = n - 1). Every logged golden-ball hit is one throw. */
export function oddsForThrow(i: number): number {
  return Math.min(ODDS_CAP, BASE_ODDS + ODDS_STEP * i);
}

/** HMAC message for throw i on a card. */
export function rollMessage(cardId: string, i: number): string {
  return `${cardId}:${i}`;
}

/** First 52 bits of the HMAC digest as a float in [0,1). Exact in IEEE-754 doubles. */
export function rollFromHex(hex: string): number {
  return parseInt(hex.slice(0, 13), 16) / 2 ** 52;
}

/** Mean number of hits until a catch, given the odds ramp above. */
export function expectedHits(): number {
  let survive = 1;
  let mean = 0;
  for (let i = 0; i < 5000 && survive > 1e-12; i++) {
    const p = oddsForThrow(i);
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
