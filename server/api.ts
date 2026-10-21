import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, explorerSuffix } from './config';
import { kvGet, type Row } from './db';
import type { Game } from './game';
import { Arena } from './arena';
import { HttpError, Market } from './market';
import { AccountLimitError, cleanName, hashIp, isToken, type PlayerRow } from './store';
import { MAX_PHOTO_BYTES, PHOTO_TYPES, oddsOf, type PrizeRow, type ReleaseRow } from './prizes';
import { prizeSvg } from './cards/art';
import { BRAND } from '../shared/brand';
import { expectedHits } from '../shared/fair';
import { CLAIM_RE, TIERS } from '../shared/prizes';
import type { Region } from '../shared/species';

type Body = Record<string, any>;

/** Tiny fixed-window limiter per IP + bucket. */
function limiter(perMinute: number) {
  const hits = new Map<string, { n: number; at: number }>();
  return (key: string) => {
    const now = Date.now();
    const h = hits.get(key);
    if (!h || now - h.at > 60_000) {
      hits.set(key, { n: 1, at: now });
      return true;
    }
    return ++h.n <= perMinute;
  };
}

const PHOTO_MIME: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export function registerApi(app: FastifyInstance, game: Game): void {
  const { db, store, prizes, guard, cardPlay } = game;
  const market = new Market(game);
  const arena = new Arena(game);
  const writeLimit = limiter(60);
  const adminFailLimit = limiter(10);

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : err instanceof AccountLimitError ? 429 : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  // Card photos arrive as raw image bodies from the admin page.
  app.addContentTypeParser(Object.keys(PHOTO_TYPES), { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES + 1024 }, (_req, body, done) => done(null, body));

  app.addHook('preHandler', async (req) => {
    if (req.method !== 'GET' && !req.url.startsWith('/api/admin/')) {
      if (!writeLimit(`${req.ip}`)) throw new HttpError(429, 'Slow down a little.');
    }
  });

  const playerFrom = (token: unknown): PlayerRow => {
    if (!isToken(token)) throw new HttpError(401, 'Missing session.');
    const p = store.playerByToken(token);
    if (!p) throw new HttpError(401, 'Join the game first.');
    return p;
  };

  /** Turns validation errors from the prize store into 400s. */
  const attempt = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, (e as Error).message);
    }
  };

  const tierInfo = () => {
    const s = prizes.settings();
    return Object.fromEntries(
      TIERS.map((t) => [t, { odds: s.odds[t], expectedHits: expectedHits(s.odds[t]), everyHours: s.everyHours[t], available: prizes.availableCount(t) }]),
    );
  };

  // ── Public ────────────────────────────────────────────────────────────

  app.get('/api/status', async () => ({
    brand: BRAND,
    launched: game.launched,
    launchAt: CONFIG.launchAt || null,
    tokenMint: CONFIG.tokenMint || null,
    vaultWallet: CONFIG.vaultAutoBuy ? game.chain.vaultWallet : null,
    explorerSuffix,
    economy: game.economy(),
    card: cardPlay.publicCard(),
    waitlistTotal: store.waitlistTotal(),
    tiers: tierInfo(),
    masterWinner: JSON.parse(kvGet(db, 'master_winner') ?? 'null'),
    providers: { chain: game.chain.name, cards: game.cards.name },
  }));

  app.post('/api/waitlist', async (req) => {
    const b = (req.body ?? {}) as Body;
    if (!isToken(b.token)) throw new HttpError(400, 'Missing browser token.');
    const ipHash = hashIp(req.ip);
    const player = store.upsertPlayer(b.token, cleanName(b.name), ipHash);
    return store.joinWaitlist(player, ipHash);
  });

  app.get('/api/me', async (req) => {
    const p = playerFrom((req.query as Body).token);
    const position = store.waitlistSpot(p.id);
    return {
      you: game.youInfo(p),
      waitlist: position ? { position, total: store.waitlistTotal() } : null,
      collection: store.collection(p.id),
    };
  });

  /** The whole catalog as the public may see it: names, photos, status, winner. Never claim codes. */
  app.get('/api/prizes', async () => prizes.all().map((r) => prizes.publicPrize(r)));

  app.get('/api/prizes/:id/photo', async (req, reply: FastifyReply) => {
    const row = prizes.byId(String((req.params as Body).id));
    if (!row) throw new HttpError(404, 'No such card.');
    reply.header('x-content-type-options', 'nosniff');
    if (row.photo && !row.photo.includes('/')) {
      const ext = row.photo.split('.').pop()!;
      try {
        const data = readFileSync(join(prizes.photoDir, row.photo));
        return reply.header('content-type', PHOTO_MIME[ext] ?? 'application/octet-stream').header('cache-control', 'public, max-age=31536000, immutable').send(data);
      } catch {
        /* file missing on disk: fall back to the placeholder */
      }
    }
    reply.header('content-type', 'image/svg+xml').header('cache-control', 'public, max-age=300');
    return prizeSvg({ name: row.name, set: row.set_name, grade: row.grade, tier: row.tier });
  });

  // Provably fair: every release with its commitment; the secret only once the release has ended.
  const fairSummary = (r: ReleaseRow) => {
    const prize = prizes.byId(r.prize_id);
    return {
      id: r.id,
      name: prize?.name ?? '?',
      tier: r.tier,
      status: r.ended_at ? (r.end_reason ?? 'ended') : 'in_play',
      commitment: r.commitment,
      memoSig: r.memo_sig,
      throws: r.throw_count,
      revealed: !!r.ended_at,
      odds: oddsOf(r),
      releasedAt: r.released_at,
    };
  };

  app.get('/api/fair', async () => {
    const rows = db.prepare('SELECT * FROM releases ORDER BY released_at DESC LIMIT 200').all() as unknown as ReleaseRow[];
    return rows.map(fairSummary);
  });

  app.get('/api/fair/:id', async (req) => {
    const r = prizes.release(String((req.params as Body).id));
    if (!r) throw new HttpError(404, 'No such card release.');
    const throws = db.prepare('SELECT idx, player_name, odds, won, created_at FROM release_throws WHERE release_id = ? ORDER BY idx').all(r.id) as Row[];
    return {
      ...fairSummary(r),
      secret: r.ended_at ? r.secret : null,
      winnerName: r.winner_name,
      endedAt: r.ended_at,
      throws: throws.map((t) => ({ index: t.idx, player: t.player_name, odds: t.odds, won: !!t.won, at: t.created_at })),
    };
  });

  app.get('/api/ranks', async () => {
    const top = (sql: string) => db.prepare(sql).all() as Row[];
    return {
      dex: top(
        'SELECT p.name, COUNT(DISTINCT c.species) AS score FROM critters c JOIN players p ON p.id = c.owner_id GROUP BY c.owner_id ORDER BY score DESC, MIN(c.caught_at) LIMIT 20',
      ),
      hits: top('SELECT name, gold_hits AS score FROM players WHERE gold_hits > 0 ORDER BY gold_hits DESC LIMIT 20'),
      cards: top('SELECT winner_name AS name, COUNT(*) AS score FROM prizes WHERE winner_id IS NOT NULL GROUP BY winner_id ORDER BY score DESC LIMIT 20'),
      arena: top('SELECT name, arena_points AS score FROM players WHERE arena_points > 0 ORDER BY arena_points DESC LIMIT 20'),
    };
  });

  // ── Market + arena ────────────────────────────────────────────────────

  app.get('/api/market/offers', async () => market.list());

  app.post('/api/market/offers', async (req) => {
    const b = (req.body ?? {}) as Body;
    return market.create(playerFrom(b.token), b as never);
  });

  app.post('/api/market/offers/:id/accept', async (req) => {
    const b = (req.body ?? {}) as Body;
    await market.accept(playerFrom(b.token), Number((req.params as Body).id), b);
    return { ok: true };
  });

  app.post('/api/market/offers/:id/cancel', async (req) => {
    const b = (req.body ?? {}) as Body;
    market.cancel(playerFrom(b.token), Number((req.params as Body).id));
    return { ok: true };
  });

  app.post('/api/arena/start', async (req) => {
    const b = (req.body ?? {}) as Body;
    return arena.start(playerFrom(b.token), Array.isArray(b.critters) ? b.critters : []);
  });

  app.post('/api/arena/move', async (req) => {
    const b = (req.body ?? {}) as Body;
    return arena.move(playerFrom(b.token), b.battleId, b.move);
  });

  // ── Admin (password from ADMIN_PASSWORD, sent as x-admin-token) ──────

  const admin = async (req: FastifyRequest) => {
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const want = Buffer.from(CONFIG.adminToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      if (!adminFailLimit(req.ip)) throw new HttpError(429, 'Too many wrong passwords. Wait a minute.');
      throw new HttpError(401, 'Wrong admin password.');
    }
  };
  const A = { preHandler: admin };

  const playerName = (id: string | null) => (id ? ((db.prepare('SELECT name FROM players WHERE id = ?').get(id) as Row | undefined)?.name ?? '?') : null);

  app.get('/api/admin/state', A, async () => {
    const m = cardPlay.mover;
    return {
      economy: game.economy(),
      card: cardPlay.publicCard(),
      cardMotion: m ? { x: m.x, z: m.z, fleeing: m.fleeing, nextTeleportAt: m.nextTeleportAt } : null,
      nextRelease: cardPlay.nextRelease(),
      settings: prizes.settings(),
      tiers: tierInfo(),
      vaultAutoBuy: CONFIG.vaultAutoBuy,
      vaultUsd: game.vaultUsd,
      balls: game.balls.size,
      critters: game.critters.size,
      event: game.event,
      waitlist: store.waitlistTotal(),
      players: (db.prepare('SELECT COUNT(*) AS n FROM players').get() as Row).n,
      feeClaims: db.prepare('SELECT * FROM fee_claims ORDER BY id DESC LIMIT 20').all(),
      recentThrows: db
        .prepare(
          `SELECT t.id, t.created_at, t.kind, t.result, t.release_id, t.player_id, p.name AS player_name
           FROM throw_log t LEFT JOIN players p ON p.id = t.player_id ORDER BY t.id DESC LIMIT 40`,
        )
        .all(),
      flags: guard.flags(50),
      masterWinner: JSON.parse(kvGet(db, 'master_winner') ?? 'null'),
      providers: { chain: game.chain.name, cards: game.cards.name },
    };
  });

  // Catalog (admin view includes claim codes).
  app.get('/api/admin/prizes', A, async () =>
    prizes.all().map((r) => ({
      ...r,
      image: prizes.imageUrl(r),
      releases: ((db.prepare('SELECT COUNT(*) AS n FROM releases WHERE prize_id = ?').get(r.id) as Row).n as number) ?? 0,
    })),
  );

  app.post('/api/admin/prizes', A, async (req) => attempt(() => prizes.create((req.body ?? {}) as Body)));

  app.post('/api/admin/prizes/:id', A, async (req) => {
    const row = attempt(() => prizes.update(String((req.params as Body).id), (req.body ?? {}) as Body));
    if (cardPlay.prize?.id === row.id) {
      cardPlay.prize = row;
      game.broadcast({ t: 'card', card: cardPlay.publicCard() });
    }
    return row;
  });

  app.post('/api/admin/prizes/:id/delete', A, async (req) => {
    attempt(() => prizes.remove(String((req.params as Body).id)));
    return { ok: true };
  });

  app.put('/api/admin/prizes/:id/photo', A, async (req) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'Send the photo as image/jpeg, image/png or image/webp.');
    const row = attempt(() => prizes.savePhoto(String((req.params as Body).id), String(req.headers['content-type']).split(';')[0], body));
    if (cardPlay.prize?.id === row.id) {
      cardPlay.prize = row;
      game.broadcast({ t: 'card', card: cardPlay.publicCard() });
    }
    return { ...row, image: prizes.imageUrl(row) };
  });

  app.post('/api/admin/prizes/:id/release', A, async (req) => {
    if (!game.launched) throw new HttpError(400, 'Launch the island first.');
    try {
      const r = await cardPlay.releasePrize(String((req.params as Body).id));
      game.broadcastEconomy();
      return { releaseId: r.id };
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  });

  app.post('/api/admin/recall', A, async () => {
    attempt(() => cardPlay.recall());
    game.broadcastEconomy();
    return { ok: true };
  });

  app.post('/api/admin/teleport', A, async () => {
    if (!cardPlay.mover) throw new HttpError(400, 'No card on the island.');
    cardPlay.mover.teleport(Date.now());
    return { ok: true };
  });

  app.get('/api/admin/settings', A, async () => prizes.settings());

  app.post('/api/admin/settings', A, async (req) => {
    const s = attempt(() => prizes.saveSettings((req.body ?? {}) as Body));
    game.broadcastEconomy();
    return s;
  });

  // Claims: look up a code, verify it once, then mark it shipped.
  const prizeByCode = (raw: unknown): PrizeRow => {
    const code = String(raw ?? '').trim().toUpperCase();
    if (!CLAIM_RE.test(code)) throw new HttpError(400, 'Claim codes look like CLAIM-7F3K-9QXA.');
    const row = prizes.byCode(code);
    if (!row) throw new HttpError(404, 'No card was won with that code.');
    return row;
  };

  app.get('/api/admin/claims', A, async () =>
    (db.prepare("SELECT * FROM prizes WHERE claim_code IS NOT NULL ORDER BY won_at DESC").all() as unknown as PrizeRow[]).map((r) => ({
      code: r.claim_code,
      name: r.name,
      tier: r.tier,
      status: r.status,
      winnerName: r.winner_name,
      wonAt: r.won_at,
      verifiedAt: r.claim_verified_at,
      shippedAt: r.shipped_at,
      tracking: r.tracking,
    })),
  );

  app.get('/api/admin/claims/:code', A, async (req) => {
    const p = prizeByCode((req.params as Body).code);
    const r = p.release_id ? prizes.release(p.release_id) : undefined;
    const winner = p.winner_id ? store.playerById(p.winner_id) : undefined;
    return {
      code: p.claim_code,
      prize: { ...p, image: prizes.imageUrl(p) },
      redeemed: !!p.claim_verified_at,
      winner: winner
        ? {
            id: winner.id,
            name: winner.name,
            joinedAt: winner.created_at,
            banned: !!winner.banned,
            goldHits: winner.gold_hits,
            flags: guard.flags(500).filter((f) => f.player_id === winner.id),
          }
        : null,
      release: r ? { id: r.id, tier: r.tier, commitment: r.commitment, secret: r.secret, memoSig: r.memo_sig, odds: oddsOf(r), releasedAt: r.released_at, endedAt: r.ended_at } : null,
      winningThrow: p.winning_idx ?? null,
      wonAt: p.won_at,
      throws: r ? db.prepare('SELECT idx, player_id, player_name, odds, won, created_at FROM release_throws WHERE release_id = ? ORDER BY idx').all(r.id) : [],
      winnerThrowLog: r && winner
        ? db.prepare("SELECT id, kind, result, origin, dir, client_at, created_at FROM throw_log WHERE release_id = ? AND player_id = ? ORDER BY id").all(r.id, winner.id)
        : [],
    };
  });

  app.post('/api/admin/claims/:code/verify', A, async (req) => {
    const p = prizeByCode((req.params as Body).code);
    if (p.claim_verified_at) throw new HttpError(409, `Already redeemed on ${new Date(p.claim_verified_at).toISOString()}.`);
    if (p.status !== 'won') throw new HttpError(409, `This card is ${p.status}, not waiting for verification.`);
    // The WHERE clause makes redemption one-time even if two admins click at once.
    const r = db.prepare("UPDATE prizes SET claim_verified_at = ? WHERE id = ? AND claim_verified_at IS NULL AND status = 'won'").run(Date.now(), p.id);
    if (Number(r.changes) !== 1) throw new HttpError(409, 'Already redeemed.');
    game.refreshClaims(p.winner_id);
    return { ok: true };
  });

  app.post('/api/admin/claims/:code/ship', A, async (req) => {
    const p = prizeByCode((req.params as Body).code);
    const tracking = String((req.body as Body)?.tracking ?? '').trim().slice(0, 120);
    if (!tracking) throw new HttpError(400, 'Add a tracking number.');
    if (!p.claim_verified_at) throw new HttpError(409, 'Verify the claim before shipping.');
    if (p.status !== 'won') throw new HttpError(409, `This card is already ${p.status}.`);
    db.prepare("UPDATE prizes SET status = 'shipped', tracking = ?, shipped_at = ? WHERE id = ? AND status = 'won'").run(tracking, Date.now(), p.id);
    game.refreshClaims(p.winner_id);
    return { ok: true };
  });

  // Anti-abuse.
  app.get('/api/admin/flags', A, async () => guard.flags(200));

  app.post('/api/admin/players/:id/ban', A, async (req) => {
    const id = String((req.params as Body).id);
    if (!store.playerById(id)) throw new HttpError(404, 'No such player.');
    guard.setBanned(id, !!(req.body as Body)?.banned);
    return { ok: true, name: playerName(id) };
  });

  app.get('/api/admin/throws', A, async (req) => {
    const q = req.query as Body;
    const where: string[] = [];
    const args: string[] = [];
    if (q.player) {
      where.push('t.player_id = ?');
      args.push(String(q.player));
    }
    if (q.release) {
      where.push('t.release_id = ?');
      args.push(String(q.release));
    }
    return db
      .prepare(
        `SELECT t.*, p.name AS player_name FROM throw_log t LEFT JOIN players p ON p.id = t.player_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id DESC LIMIT 500`,
      )
      .all(...args);
  });

  // Island controls.
  app.post('/api/admin/launch', A, async (req) => {
    game.setLaunched(!!(req.body as Body)?.launched);
    return { launched: game.launched };
  });

  app.post('/api/admin/claim', A, async () => {
    if (!game.launched) throw new HttpError(400, 'Launch first.');
    await game.runFeeClaim();
    return { ok: true, economy: game.economy() };
  });

  app.post('/api/admin/vault', A, async (req) => {
    if (!CONFIG.vaultAutoBuy) throw new HttpError(400, 'The vault is off (VAULT_AUTO_BUY=false).');
    const add = Number((req.body as Body)?.addUsd);
    if (!Number.isFinite(add)) throw new HttpError(400, 'addUsd must be a number.');
    game.setVault(game.vaultUsd + add);
    await game.maybeBuyCard();
    return { ok: true, economy: game.economy() };
  });

  app.post('/api/admin/balls', A, async (req) => {
    const n = Math.max(1, Math.min(100, Number((req.body as Body)?.n) || 10));
    return { spawned: game.spawnBalls(n) };
  });

  app.post('/api/admin/event', A, async (req) => {
    const region = (req.body as Body)?.region as Region | undefined;
    game.startEvent(region || undefined);
    return { event: game.event };
  });
}
