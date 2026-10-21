// Cross-checks the server's node:crypto rolls against the browser verifier's WebCrypto rolls,
// and the odds schedule against a Monte Carlo run.
import assert from 'node:assert/strict';
import { commitmentFor, newSecret, rollFor } from '../server/fair';
import { rollsFor, sha256Hex } from '../src/verify';
import { BASE_ODDS, ODDS_CAP, expectedHits, oddsForThrow } from '../shared/fair';

const secret = newSecret();
const cardId = 'card_test123';

assert.equal(await sha256Hex(secret), commitmentFor(secret), 'commitment differs between server and browser');

const browser = await rollsFor(secret, cardId, 500);
for (let i = 0; i < 500; i++) {
  const r = rollFor(secret, cardId, i);
  assert.ok(r >= 0 && r < 1);
  assert.equal(browser[i], r, `roll ${i} differs`);
}

assert.equal(oddsForThrow(0), BASE_ODDS);
assert.ok(Math.abs(oddsForThrow(1) - 0.00412) < 1e-15);
assert.equal(oddsForThrow(10_000), ODDS_CAP);

let total = 0;
const N = 20_000;
for (let k = 0; k < N; k++) {
  let i = 0;
  while (Math.random() >= oddsForThrow(i)) i++;
  total += i + 1;
}
const mc = total / N;
const exact = expectedHits();
assert.ok(Math.abs(mc - exact) < 2, `Monte Carlo ${mc} vs exact ${exact}`);

console.log(`✓ fair rolls match (500), odds schedule ok, expected hits ${exact.toFixed(1)} (MC ${mc.toFixed(1)})`);
