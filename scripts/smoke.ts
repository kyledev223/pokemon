// End-to-end smoke test: boots the real server on a temp DB with mocks, then drives it
// over HTTP + WebSocket like a browser would. Run: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import type { ServerMsg } from '../shared/protocol';
import { speciesById } from '../shared/species';
import { oddsForThrow } from '../shared/fair';
import { CLAIM_RE } from '../shared/prizes';
import { BALL_GRAVITY, EYE_HEIGHT, INTERP_DELAY_MS, THROW_SPEED, critterCenter, critterPose, resolveMove, terrainHeight, type SpawnInfo, type Vec3 } from '../shared/world';
import { rollsFor, sha256Hex } from '../src/verify';

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const ADMIN = 'smoke-admin';
const dir = mkdtempSync(join(tmpdir(), 'cove-smoke-'));
const dbPath = join(dir, 'game.db');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, ADMIN_TOKEN: ADMIN, LAUNCHED: 'true', FEE_CLAIM_INTERVAL_SEC: '3600', LOG_LEVEL: 'warn' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

async function http<T = any>(method: string, path: string, body?: unknown, admin = false): Promise<{ status: number; json: T }> {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(admin ? { 'x-admin-token': ADMIN } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as T };
}

class Client {
  ws: WebSocket;
  msgs: ServerMsg[] = [];
  pos: Vec3 = { x: 0, y: 0, z: 0 };
  critters = new Map<string, SpawnInfo>();
  card: any = null;
  /** Last two server card positions, for aiming at a moving (fleeing) slab. */
  cardPos: { at: number; x: number; y: number; z: number }[] = [];
  offset = 0;
  gold = 0;
  constructor(readonly token: string) {
    this.ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    this.ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()) as ServerMsg;
      this.msgs.push(m);
      if (m.t === 'init') {
        this.offset = m.now - Date.now();
        m.critters.forEach((c) => this.critters.set(c.id, c));
        this.card = m.card;
      }
      if (m.t === 'you') {
        this.pos = m.spawn;
        this.gold = m.you.gold;
      }
      if (m.t === 'bag') this.gold = m.gold;
      if (m.t === 'correct') this.pos = { x: m.x, y: m.y, z: m.z };
      if (m.t === 'critter+') m.spawns.forEach((c) => this.critters.set(c.id, c));
      if (m.t === 'critter-') this.critters.delete(m.id);
      if (m.t === 'card') this.card = m.card;
      if (m.t === 'cardPos') {
        this.cardPos.push(m);
        if (this.cardPos.length > 2 || m.jump) this.cardPos.splice(0, this.cardPos.length - 1);
      }
    });
  }
  now() {
    return Date.now() + this.offset;
  }
  open() {
    return new Promise<void>((r) => this.ws.once('open', () => r()));
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  /** Resolves with the first matching message at index >= `from` (defaults to the whole history). */
  async waitFor<K extends ServerMsg['t']>(t: K, pred: (m: Extract<ServerMsg, { t: K }>) => boolean = () => true, ms = 5000, from = 0) {
    const start = Date.now();
    let seen = from;
    while (Date.now() - start < ms) {
      for (; seen < this.msgs.length; seen++) {
        const m = this.msgs[seen];
        if (m.t === t && pred(m as Extract<ServerMsg, { t: K }>)) return m as Extract<ServerMsg, { t: K }>;
      }
      await sleep(20);
    }
    return null;
  }
  /** Walks at legal speed until within `within` units of the target (x,z) supplier. */
  async walkTo(target: () => { x: number; z: number }, within: number) {
    for (let i = 0; i < 600; i++) {
      const t = target();
      const dx = t.x - this.pos.x;
      const dz = t.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d <= within) return true;
      const step = Math.min(1.4, d - within + 0.1);
      const n = resolveMove(this.pos.x, this.pos.z, this.pos.x + (dx / d) * step, this.pos.z + (dz / d) * step, 'island');
      this.pos = { x: n.x, y: terrainHeight(n.x, n.z), z: n.z };
      this.send({ t: 'pos', ...this.pos, ry: 0 });
      await sleep(110);
    }
    return false;
  }
  /** Where the card will be drawn at server time `ms`, extrapolated from the last two samples. */
  cardAt(ms: number): Vec3 {
    const [a, b] = this.cardPos.length > 1 ? this.cardPos : [this.cardPos[0], this.cardPos[0]];
    const k = b.at === a.at ? 0 : (ms - INTERP_DELAY_MS - b.at) / (b.at - a.at);
    return { x: b.x + (b.x - a.x) * k, y: b.y + (b.y - a.y) * k, z: b.z + (b.z - a.z) * k };
  }
  /** Aims a ballistic throw at a moving target. */
  throwAt(kind: 'orb' | 'gold', targetAt: (ms: number) => Vec3) {
    const o = { x: this.pos.x, y: this.pos.y + EYE_HEIGHT - 0.15, z: this.pos.z };
    const at = this.now();
    let aim = targetAt(at);
    let t = 0;
    for (let k = 0; k < 4; k++) {
      t = Math.hypot(aim.x - o.x, aim.y - o.y, aim.z - o.z) / THROW_SPEED;
      aim = targetAt(at + t * 1000);
    }
    const dy = aim.y - o.y - 0.5 * BALL_GRAVITY * t * t;
    const d = { x: aim.x - o.x, y: dy, z: aim.z - o.z };
    const len = Math.hypot(d.x, d.y, d.z);
    this.send({ t: 'throw', kind, o, d: { x: d.x / len, y: d.y / len, z: d.z / len }, at });
  }
}

const results: string[] = [];
const ok = (msg: string) => {
  results.push(msg);
  console.log(`✓ ${msg}`);
};

try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/api/status`)).ok) break;
    } catch {
      /* booting */
    }
    await sleep(200);
  }

  // Waitlist: one spot per token, one per network.
  const tokA = randomBytes(24).toString('hex');
  const tokB = randomBytes(24).toString('hex');
  const w1 = await http('POST', '/api/waitlist', { token: tokA, name: 'Alice' });
  const w1b = await http('POST', '/api/waitlist', { token: tokA, name: 'Alice' });
  const w2 = await http('POST', '/api/waitlist', { token: tokB, name: 'Bob' });
  assert.equal(w1.json.position, 1);
  assert.equal(w1b.json.position, 1);
  assert.equal(w2.json.position, 1);
  assert.equal(w2.json.sameNetwork, true);
  assert.equal(w1.json.total, 1);
  ok('waitlist: returning keeps spot, same network shares one spot');

  // Catalog: seeded from the brief, public view never carries claim codes.
  assert.equal((await http('GET', '/api/admin/prizes')).status, 401);
  const catalog = await http('GET', '/api/prizes');
  assert.equal(catalog.json.length, 17);
  assert.deepEqual(
    ['S', 'A', 'B'].map((t) => catalog.json.filter((p: any) => p.tier === t).length),
    [5, 6, 6],
  );
  assert.ok(catalog.json.every((p: any) => !('claimCode' in p) && !('claim_code' in p) && p.status === 'available'));
  ok('prize catalog seeded: 5 Tier S, 6 Tier A, 6 Tier B, no claim codes in public view');

  // Admin settings: fast odds for the test, no teleports, then release a Tier B card.
  const bad = await http('POST', '/api/admin/settings', { odds: { B: { base: 0.5, step: 0, cap: 0.2 } } }, true);
  assert.equal(bad.status, 400, 'cap below start must be rejected');
  const set = await http('POST', '/api/admin/settings', { odds: { B: { base: 0.15, step: 0.05, cap: 0.9 } }, teleportMinutes: 60, everyHours: { B: null } }, true);
  assert.equal(set.status, 200, JSON.stringify(set.json));
  const tierB = catalog.json.find((p: any) => p.tier === 'B');
  const rel = await http('POST', `/api/admin/prizes/${tierB.id}/release`, {}, true);
  assert.equal(rel.status, 200, JSON.stringify(rel.json));
  assert.equal((await http('POST', `/api/admin/prizes/${tierB.id}/release`, {}, true)).status, 400, 'one card at a time');
  const st = await http('GET', '/api/status');
  assert.equal(st.json.card.name, tierB.name);
  assert.match(st.json.card.commitment, /^[0-9a-f]{64}$/);
  assert.ok(!('secret' in st.json.card));
  assert.equal(st.json.card.odds.base, 0.15);
  ok(`admin released "${st.json.card.name}" (Tier B) with commitment ${st.json.card.commitment.slice(0, 12)}…`);

  // Join over WebSocket; early bonus lands once.
  const a = new Client(tokA);
  await a.open();
  await a.waitFor('init');
  a.send({ t: 'hello', token: tokA, name: 'Alice' });
  const you = await a.waitFor('you');
  assert.ok(you);
  assert.equal(you!.you.gold, 10, 'position #1 should get 10 bonus balls');
  ok('launch bonus: 10 golden balls granted on first join');

  // Bob watches from the same island (he must never see Alice's claim code).
  const b = new Client(tokB);
  await b.open();
  b.send({ t: 'hello', token: tokB, name: 'Bob' });
  await b.waitFor('you');

  // Anti-cheat: teleport is rejected.
  const before = { ...a.pos };
  a.send({ t: 'pos', x: before.x + 60, y: before.y, z: before.z, ry: 0 });
  const corr = await a.waitFor('correct');
  assert.ok(corr && Math.abs(corr.x - before.x) < 0.01);
  ok('server rejects teleporting');

  // Golden ball pickup: far pickups are ignored, close ones count.
  await http('POST', '/api/admin/balls', { n: 30 }, true);
  const ballsMsg = await a.waitFor('balls+');
  assert.ok(ballsMsg);
  const balls = ballsMsg!.balls.sort((p, q) => Math.hypot(p.x - a.pos.x, p.z - a.pos.z) - Math.hypot(q.x - a.pos.x, q.z - a.pos.z));
  const far = balls[balls.length - 1];
  a.send({ t: 'pickup', id: far.id });
  assert.equal(await a.waitFor('ball-', (m) => m.id === far.id, 800), null);
  const near = balls[0];
  assert.ok(await a.walkTo(() => near, 1));
  a.send({ t: 'pickup', id: near.id });
  assert.ok(await a.waitFor('ball-', (m) => m.id === near.id));
  assert.equal((await a.waitFor('bag', (m) => m.gold === 11))?.gold, 11);
  ok('golden ball pickups are distance-checked server-side');

  // Pink orb at a nearby land critter.
  const land = [...a.critters.values()].filter((c) => c.kind === 'land').sort((p, q) => Math.hypot(p.hx - a.pos.x, p.hz - a.pos.z) - Math.hypot(q.hx - a.pos.x, q.hz - a.pos.z));
  const target = land[0];
  const size = speciesById(target.species).size;
  let catchMsg = null;
  for (let i = 0; i < 25 && !catchMsg; i++) {
    if (!a.critters.has(target.id)) break;
    await a.walkTo(() => critterPose(target, a.now()), 5);
    const mark = a.msgs.length;
    a.throwAt('orb', (ms) => critterCenter(critterPose(target, ms), size));
    // A hit starts the wobble; the result arrives once it's over.
    if (!(await a.waitFor('catchStart', (m) => m.spawnId === target.id, 900, mark))) continue;
    const result = await a.waitFor('catch', (m) => m.spawnId === target.id, 4000, mark);
    if (result?.ok) catchMsg = result;
  }
  assert.ok(catchMsg, 'should catch a critter within 25 throws');
  ok(`pink orb caught ${speciesById(catchMsg!.species).name}; dex updated`);

  // Golden balls at the fleeing card until it's caught (test tops up the bag directly in the DB).
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE players SET gold = 300 WHERE name = ?').run('Alice');
  const card = a.card ?? st.json.card;
  assert.ok(await a.waitFor('cardPos', () => true, 2000), 'server streams card positions');
  let caught = null;
  let throws = 0;
  for (; throws < 300 && !caught; throws++) {
    await a.walkTo(() => a.cardAt(a.now()), 17);
    a.throwAt('gold', (ms) => a.cardAt(ms));
    await sleep(480);
    caught = a.msgs.find((m) => m.t === 'cardCaught') as Extract<ServerMsg, { t: 'cardCaught' }> | undefined;
  }
  assert.ok(caught, 'card should be caught');
  const hits = a.msgs.filter((m) => m.t === 'cardHit').length;
  ok(`fleeing card caught after ${throws} golden throws (${hits} hits, server-simulated), secret revealed`);

  const prizeWon = (await a.waitFor('prizeWon')) as Extract<ServerMsg, { t: 'prizeWon' }> | null;
  assert.ok(prizeWon, 'winner gets a private prizeWon message');
  const code = prizeWon!.claim.code;
  assert.match(code, CLAIM_RE);
  assert.ok(!(await b.waitFor('prizeWon', () => true, 300)), 'other players never see the code');
  assert.ok(!JSON.stringify(b.msgs).includes(code));
  ok(`winner got one-time claim code ${code.slice(0, 6)}…; nobody else saw it`);

  // Verify the full throw log the way the browser does, with this release's odds.
  const fair = await http('GET', `/api/fair/${card.id}`);
  assert.equal(fair.json.secret, caught!.secret);
  assert.equal(await sha256Hex(fair.json.secret), fair.json.commitment);
  const rolls = await rollsFor(fair.json.secret, card.id, fair.json.throws.length);
  fair.json.throws.forEach((t: any, i: number) => {
    assert.equal(t.index, i);
    assert.equal(t.odds, oddsForThrow(i, fair.json.odds));
    assert.equal(t.won, rolls[i] < oddsForThrow(i, fair.json.odds));
  });
  assert.equal(fair.json.throws.findIndex((t: any) => t.won), fair.json.throws.length - 1);
  ok(`verifier: commitment + all ${rolls.length} rolls recomputed, winner is the first winning roll`);

  // Claim: public gallery shows Won without the code; admin looks it up, redeems once, ships.
  const pub = await http('GET', '/api/prizes');
  const wonPub = pub.json.find((p: any) => p.id === tierB.id);
  assert.equal(wonPub.status, 'won');
  assert.equal(wonPub.winnerName, 'Alice');
  assert.ok(!JSON.stringify(pub.json).includes(code));
  const look = await http('GET', `/api/admin/claims/${code}`, undefined, true);
  assert.equal(look.status, 200);
  assert.equal(look.json.winner.name, 'Alice');
  assert.equal(look.json.throws.length, fair.json.throws.length);
  assert.equal(look.json.winningThrow, fair.json.throws.length - 1);
  assert.equal((await http('POST', `/api/admin/claims/${code}/ship`, { tracking: 'X1' }, true)).status, 409, 'ship needs verify first');
  assert.equal((await http('POST', `/api/admin/claims/${code}/verify`, {}, true)).status, 200);
  assert.equal((await http('POST', `/api/admin/claims/${code}/verify`, {}, true)).status, 409, 'a code redeems once');
  assert.equal((await http('POST', `/api/admin/claims/${code}/ship`, {}, true)).status, 400, 'tracking required');
  assert.equal((await http('POST', `/api/admin/claims/${code}/ship`, { tracking: 'TRACK123' }, true)).status, 200);
  assert.equal((await http('GET', '/api/prizes')).json.find((p: any) => p.id === tierB.id).status, 'shipped');
  assert.equal((await http('GET', '/api/admin/claims/CLAIM-2222-2222', undefined, true)).status, 404);
  const me = await http('GET', `/api/me?token=${tokA}`);
  assert.equal(me.json.you.claims[0].code, code);
  ok('claim: admin lookup → verify once (second is 409) → shipped with tracking; winner still sees their code');

  // Anti-abuse: a golden throw from somewhere you aren't is refused and costs nothing.
  const goldBefore = (db.prepare('SELECT gold FROM players WHERE name = ?').get('Alice') as any).gold as number;
  a.send({ t: 'throw', kind: 'gold', o: { x: a.pos.x + 12, y: a.pos.y + 1.5, z: a.pos.z }, d: { x: 1, y: 0, z: 0 }, at: a.now() });
  await sleep(300);
  assert.equal((db.prepare('SELECT gold FROM players WHERE name = ?').get('Alice') as any).gold, goldBefore);
  const logged = db.prepare("SELECT result, COUNT(*) AS n FROM throw_log WHERE kind = 'gold' GROUP BY result").all() as any[];
  assert.ok(logged.some((r) => r.result === 'rejected:origin'));
  assert.ok(logged.some((r) => r.result === 'hit'));
  ok(`throw log: ${logged.map((r) => `${r.n} ${r.result}`).join(', ')}`);

  // Hourly golden-ball cap.
  await http('POST', '/api/admin/settings', { goldPerHour: 1 }, true);
  await http('POST', '/api/admin/balls', { n: 30 }, true);
  const more = (await a.waitFor('balls+', () => true, 2000, a.msgs.length - 5))!;
  const next = more.balls.sort((p, q) => Math.hypot(p.x - a.pos.x, p.z - a.pos.z) - Math.hypot(q.x - a.pos.x, q.z - a.pos.z))[0];
  assert.ok(await a.walkTo(() => next, 1));
  const capMark = a.msgs.length;
  a.send({ t: 'pickup', id: next.id });
  assert.ok(await a.waitFor('toast', (m) => m.text.includes('Hourly limit'), 1500, capMark));
  assert.equal(await a.waitFor('ball-', (m) => m.id === next.id, 500, capMark), null);
  await http('POST', '/api/admin/settings', { goldPerHour: 20 }, true);
  ok('hourly golden-ball cap blocks pickups past the limit');

  // Market swap between Alice and Bob.
  const alice = db.prepare('SELECT id FROM players WHERE name = ?').get('Alice') as { id: string };
  const bob = db.prepare('SELECT id FROM players WHERE name = ?').get('Bob') as { id: string };
  const ins = db.prepare('INSERT INTO critters (owner_id, species, locked, caught_at) VALUES (?, ?, ?, ?)');
  ins.run(alice.id, 5, 1, Date.now());
  const aDup = Number(ins.run(alice.id, 5, 0, Date.now()).lastInsertRowid);
  ins.run(bob.id, 9, 1, Date.now());
  const bDup = Number(ins.run(bob.id, 9, 0, Date.now()).lastInsertRowid);
  const lockedId = (db.prepare('SELECT id FROM critters WHERE owner_id = ? AND species = 5 AND locked = 1').get(alice.id) as { id: number }).id;
  assert.equal((await http('POST', '/api/market/offers', { token: tokA, critterId: lockedId, kind: 'swap', wantSpecies: 9 })).status, 400);
  const offer = await http('POST', '/api/market/offers', { token: tokA, critterId: aDup, kind: 'swap', wantSpecies: 9 });
  assert.equal(offer.status, 200);
  const acc = await http('POST', `/api/market/offers/${offer.json.id}/accept`, { token: tokB, critterId: bDup });
  assert.equal(acc.status, 200);
  assert.equal((db.prepare('SELECT owner_id FROM critters WHERE id = ?').get(aDup) as { owner_id: string }).owner_id, bob.id);
  assert.equal((db.prepare('SELECT owner_id FROM critters WHERE id = ?').get(bDup) as { owner_id: string }).owner_id, alice.id);
  ok('market: locked first catch cannot be listed, swap settles instantly');

  // Arena: turn-based battle, server-authoritative.
  assert.equal((await http('POST', '/api/arena/start', { token: tokA, critters: [aDup] })).status, 400); // no longer Alice's
  const start = await http('POST', '/api/arena/start', { token: tokA, critters: [bDup] });
  assert.equal(start.status, 200, JSON.stringify(start.json));
  assert.equal(start.json.state.you.moves.length, 4);
  assert.equal((await http('POST', '/api/arena/move', { token: tokA, battleId: start.json.battleId, move: 7 })).status, 400);
  let turn: any = null;
  let lines = 0;
  for (let i = 0; i < 70; i++) {
    turn = await http('POST', '/api/arena/move', { token: tokA, battleId: start.json.battleId, move: 0 });
    assert.equal(turn.status, 200, JSON.stringify(turn.json));
    lines += turn.json.log.length;
    if (turn.json.done) break;
  }
  assert.ok(turn.json.done, 'battle should finish');
  assert.equal((await http('POST', '/api/arena/move', { token: tokA, battleId: start.json.battleId, move: 0 })).status, 404);
  ok(`arena battle resolved (${turn.json.won ? 'won' : 'lost'} after ${turn.json.state.turn} turns, ${lines} log lines)`);

  // Chat: broadcast to everyone, control characters stripped, flood-limited.
  const chatMark = b.msgs.length;
  a.send({ t: 'chat', text: '  hello\u0007   island  ' });
  const line = await b.waitFor('chat', (m) => !m.line.system && m.line.name === 'Alice', 2000, chatMark);
  assert.equal(line?.line.text, 'hello island');
  a.send({ t: 'chat', text: 'spam' });
  assert.equal(await b.waitFor('chat', (m) => m.line.text === 'spam', 600, chatMark), null);
  ok('chat: broadcast, sanitised and rate-limited');

  // Impossible movement gets the account flagged for the admin.
  for (let i = 0; i < 9; i++) {
    a.send({ t: 'pos', x: a.pos.x + 80, y: a.pos.y, z: a.pos.z, ry: 0 });
    await sleep(30);
  }
  await sleep(200);
  const flags = await http('GET', '/api/admin/flags', undefined, true);
  assert.ok(flags.json.some((f: any) => f.player_name === 'Alice' && f.reason === 'movement'));
  ok('impossible movement flags the account for review');

  // One account per browser, and a cap on fresh accounts per network.
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await http('POST', '/api/waitlist', { token: randomBytes(24).toString('hex'), name: `Alt${i}` })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429]);
  ok('new-account limit per network (5/day): the 6th fresh browser token is refused');

  db.close();
  a.ws.close();
  b.ws.close();
  console.log(`\nAll ${results.length} smoke checks passed.`);
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  server.kill();
  await sleep(300);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* windows file locks */
  }
}
