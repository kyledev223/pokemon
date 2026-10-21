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
import { BALL_GRAVITY, EYE_HEIGHT, THROW_SPEED, cardCenter, cardPose, critterCenter, critterPose, resolveMove, terrainHeight, type SpawnInfo, type Vec3 } from '../shared/world';
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
  async waitFor<K extends ServerMsg['t']>(t: K, pred: (m: Extract<ServerMsg, { t: K }>) => boolean = () => true, ms = 5000) {
    const start = Date.now();
    let seen = 0;
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

  // Admin auth + vault → card purchase → release.
  assert.equal((await http('POST', '/api/admin/vault', { addUsd: 10 })).status, 401);
  const v = await http('POST', '/api/admin/vault', { addUsd: 10 }, true);
  assert.equal(v.status, 200);
  const st = await http('GET', '/api/status');
  assert.ok(st.json.card, 'a card should be in play after the vault hits $10');
  assert.match(st.json.card.commitment, /^[0-9a-f]{64}$/);
  assert.ok(!('secret' in st.json.card));
  ok(`vault $10 → bought + released "${st.json.card.name}" with commitment ${st.json.card.commitment.slice(0, 12)}…`);

  // Join over WebSocket; early bonus lands once.
  const a = new Client(tokA);
  await a.open();
  await a.waitFor('init');
  a.send({ t: 'hello', token: tokA, name: 'Alice' });
  const you = await a.waitFor('you');
  assert.ok(you);
  assert.equal(you!.you.gold, 10, 'position #1 should get 10 bonus balls');
  ok('launch bonus: 10 golden balls granted on first join');

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
    a.throwAt('orb', (ms) => critterCenter(critterPose(target, ms), size));
    catchMsg = await a.waitFor('catch', (m) => m.spawnId === target.id && m.ok, 900);
  }
  assert.ok(catchMsg, 'should catch a critter within 25 throws');
  ok(`pink orb caught ${speciesById(catchMsg!.species).name}; dex updated`);

  // Golden balls at the card until it's caught (test tops up the bag directly in the DB).
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE players SET gold = 600 WHERE name = ?').run('Alice');
  const card = a.card ?? st.json.card;
  let caught = null;
  let throws = 0;
  for (; throws < 600 && !caught; throws++) {
    await a.walkTo(() => cardPose(card.seed, card.releasedAt, a.now()), 7);
    a.throwAt('gold', (ms) => cardCenter(cardPose(card.seed, card.releasedAt, ms)));
    await sleep(480);
    caught = a.msgs.find((m) => m.t === 'cardCaught') as Extract<ServerMsg, { t: 'cardCaught' }> | undefined;
  }
  assert.ok(caught, 'card should be caught');
  const hits = a.msgs.filter((m) => m.t === 'cardHit').length;
  ok(`card caught after ${throws} golden throws (${hits} hits), secret revealed`);

  // Verify the full throw log the way the browser does.
  const fair = await http('GET', `/api/fair/${card.id}`);
  assert.equal(fair.json.secret, caught!.secret);
  assert.equal(await sha256Hex(fair.json.secret), fair.json.commitment);
  const rolls = await rollsFor(fair.json.secret, card.id, fair.json.throws.length);
  fair.json.throws.forEach((t: any, i: number) => {
    assert.equal(t.index, i);
    assert.equal(t.odds, oddsForThrow(i));
    assert.equal(t.won, rolls[i] < oddsForThrow(i));
  });
  assert.equal(fair.json.throws.findIndex((t: any) => t.won), fair.json.throws.length - 1);
  ok(`verifier: commitment + all ${rolls.length} rolls recomputed, winner is the first winning roll`);

  // Winner pastes a wallet → mock transfer.
  const wallet = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
  const ws = await http('POST', '/api/wallet', { token: tokA, wallet });
  assert.equal(ws.status, 200);
  const won = await http('GET', '/api/cards/won');
  assert.equal(won.json.length, 1);
  assert.ok(won.json[0].transferSig);
  assert.equal(won.json[0].winnerName, 'Alice');
  ok('wallet pasted → card delivered (mock transfer sig recorded)');

  // Market swap between Alice and Bob.
  const b = new Client(tokB);
  await b.open();
  b.send({ t: 'hello', token: tokB, name: 'Bob' });
  await b.waitFor('you');
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

  // Arena duel.
  const duel = await http('POST', '/api/arena/duel', { token: tokA, critters: [bDup] });
  assert.equal(duel.status, 200, JSON.stringify(duel.json));
  assert.ok(duel.json.log.length > 2);
  ok(`arena duel resolved (${duel.json.won ? 'won' : 'lost'}, ${duel.json.log.length} log lines)`);

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
