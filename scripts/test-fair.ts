// Cross-checks the server's node:crypto rolls against the browser verifier's WebCrypto rolls,
// and the odds schedule against a Monte Carlo run.
import assert from 'node:assert/strict';
import { commitmentFor, newSecret, rollFor } from '../server/fair';
import { rollsFor, sha256Hex } from '../src/verify';
import { expectedHits, oddsForThrow } from '../shared/fair';
import { DEFAULT_SETTINGS, TIERS } from '../shared/prizes';

const secret = newSecret();
const cardId = 'card_test123';

assert.equal(await sha256Hex(secret), commitmentFor(secret), 'commitment differs between server and browser');

const browser = await rollsFor(secret, cardId, 500);
for (let i = 0; i < 500; i++) {
  const r = rollFor(secret, cardId, i);
  assert.ok(r >= 0 && r < 1);
  assert.equal(browser[i], r, `roll ${i} differs`);
}

// Tier B per spec: 0.2% start, +0.005 pts per miss, cap 5%.
const B = DEFAULT_SETTINGS.odds.B;
assert.equal(oddsForThrow(0, B), 0.002);
assert.ok(Math.abs(oddsForThrow(1, B) - 0.00205) < 1e-15);
assert.equal(oddsForThrow(100_000, B), 0.05);

const report: string[] = [];
for (const tier of TIERS) {
  const o = DEFAULT_SETTINGS.odds[tier];
  let total = 0;
  const N = 6_000;
  for (let k = 0; k < N; k++) {
    let i = 0;
    while (Math.random() >= oddsForThrow(i, o)) i++;
    total += i + 1;
  }
  const mc = total / N;
  const exact = expectedHits(o);
  assert.ok(Math.abs(mc - exact) / exact < 0.05, `tier ${tier}: Monte Carlo ${mc} vs exact ${exact}`);
  report.push(`${tier} ~${exact.toFixed(0)} hits (MC ${mc.toFixed(0)})`);
}

console.log(`✓ fair rolls match (500), tier odds ok: ${report.join(', ')}`);
