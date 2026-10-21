import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { CONFIG, explorerSuffix } from './config';
import { kvGet, type Row } from './db';
import { imageUrl, type CardRow, type Game } from './game';
import { Arena } from './arena';
import { HttpError, Market } from './market';
import { cleanName, hashIp, isToken, type PlayerRow } from './store';
import { slabSvg } from './cards/art';
import { BRAND } from '../shared/brand';
import { BASE_ODDS, ODDS_CAP, ODDS_STEP, expectedHits } from '../shared/fair';
import type { WonCard } from '../shared/protocol';
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

export function registerApi(app: FastifyInstance, game: Game): void {
  const { db, store } = game;
  const market = new Market(game);
  const arena = new Arena(game);
  const writeLimit = limiter(60);
  const EXPECTED_HITS = expectedHits();

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err instanceof HttpError ? err.status : (err.statusCode ?? 500);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: status >= 500 ? 'Something went wrong.' : err.message });
  });

  app.addHook('preHandler', async (req) => {
    if (req.method === 'POST' || req.method === 'DELETE') {
      if (!writeLimit(`${req.ip}`)) throw new HttpError(429, 'Slow down a little.');
    }
  });

  const playerFrom = (token: unknown): PlayerRow => {
    if (!isToken(token)) throw new HttpError(401, 'Missing session.');
    const p = store.playerByToken(token);
    if (!p) throw new HttpError(401, 'Join the game first.');
    return p;
  };

  // ── Public ────────────────────────────────────────────────────────────

  app.get('/api/status', async () => ({
    brand: BRAND,
    launched: game.launched,
    launchAt: CONFIG.launchAt || null,
    tokenMint: CONFIG.tokenMint || null,
    explorerSuffix,
    economy: game.economy(),
    card: game.card ? game.publicCard(game.card) : null,
    waitlistTotal: store.waitlistTotal(),
    odds: { base: BASE_ODDS, step: ODDS_STEP, cap: ODDS_CAP, expectedHits: EXPECTED_HITS },
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

  app.post('/api/wallet', async (req) => {
    const b = (req.body ?? {}) as Body;
    const p = playerFrom(b.token);
    const wallet = String(b.wallet ?? '').trim();
    if (!game.chain.isValidAddress(wallet)) throw new HttpError(400, "That doesn't look like a Solana wallet address.");
    await game.setWallet(p, wallet);
    return { ok: true, you: game.youInfo(store.playerById(p.id)!) };
  });

  app.get('/api/cards/won', async (): Promise<WonCard[]> => {
    const rows = db.prepare("SELECT * FROM cards WHERE status IN ('caught','claimed') ORDER BY caught_at DESC LIMIT 100").all() as unknown as CardRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      set: r.set_name,
      grade: r.grade,
      valueUsd: r.value_usd,
      image: imageUrl(r),
      winnerName: r.winner_name ?? '?',
      caughtAt: r.caught_at ?? 0,
      throws: r.throw_count,
      transferSig: r.transfer_sig,
      memoSig: r.memo_sig,
      purchaseSig: r.purchase_sig,
    }));
  });

  app.get('/api/cards/:id/image.svg', async (req, reply: FastifyReply) => {
    const row = db.prepare('SELECT * FROM cards WHERE id = ?').get((req.params as Body).id) as unknown as CardRow | undefined;
    if (!row) throw new HttpError(404, 'No such card.');
    reply.header('content-type', 'image/svg+xml').header('cache-control', 'public, max-age=86400');
    return slabSvg({ name: row.name, grade: row.grade, set: row.set_name, speciesId: row.species });
  });

  // Provably fair: every released card with its commitment; secret only after the catch.
  app.get('/api/fair', async () => {
    const rows = db
      .prepare("SELECT * FROM cards WHERE status IN ('in_play','caught','claimed') ORDER BY released_at DESC LIMIT 100")
      .all() as unknown as CardRow[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      commitment: r.commitment,
      memoSig: r.memo_sig,
      throws: r.throw_count,
      revealed: r.status !== 'in_play',
    }));
  });

  app.get('/api/fair/:id', async (req) => {
    const r = db.prepare('SELECT * FROM cards WHERE id = ?').get((req.params as Body).id) as unknown as CardRow | undefined;
    if (!r || r.status === 'queued') throw new HttpError(404, 'No such card.');
    const throws = db.prepare('SELECT idx, player_name, odds, won, created_at FROM throws WHERE card_id = ? ORDER BY idx').all(r.id) as Row[];
    return {
      id: r.id,
      name: r.name,
      status: r.status,
      commitment: r.commitment,
      memoSig: r.memo_sig,
      secret: r.status === 'in_play' ? null : r.secret,
      winnerName: r.winner_name,
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
      cards: top("SELECT winner_name AS name, COUNT(*) AS score FROM cards WHERE winner_id IS NOT NULL GROUP BY winner_id ORDER BY score DESC LIMIT 20"),
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

  app.post('/api/arena/duel', async (req) => {
    const b = (req.body ?? {}) as Body;
    return arena.duel(playerFrom(b.token), Array.isArray(b.critters) ? b.critters : []);
  });

  // ── Admin ─────────────────────────────────────────────────────────────

  const admin = async (req: FastifyRequest) => {
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const want = Buffer.from(CONFIG.adminToken);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new HttpError(401, 'Bad admin token.');
  };

  app.get('/api/admin/state', { preHandler: admin }, async () => ({
    economy: game.economy(),
    card: game.card ? { ...game.publicCard(game.card), secretHidden: true } : null,
    queued: db.prepare("SELECT id, name, grade, price_usd FROM cards WHERE status = 'queued' ORDER BY created_at").all(),
    balls: game.balls.size,
    critters: game.critters.size,
    event: game.event,
    waitlist: store.waitlistTotal(),
    players: (db.prepare('SELECT COUNT(*) AS n FROM players').get() as Row).n,
    claims: db.prepare('SELECT * FROM fee_claims ORDER BY id DESC LIMIT 20').all(),
    recentThrows: db.prepare('SELECT * FROM throws ORDER BY created_at DESC LIMIT 30').all(),
    pendingDeliveries: db.prepare("SELECT id, name, winner_name, winner_wallet FROM cards WHERE status = 'caught'").all(),
    masterWinner: JSON.parse(kvGet(db, 'master_winner') ?? 'null'),
    providers: { chain: game.chain.name, cards: game.cards.name },
  }));

  app.post('/api/admin/launch', { preHandler: admin }, async (req) => {
    game.setLaunched(!!(req.body as Body)?.launched);
    return { launched: game.launched };
  });

  app.post('/api/admin/claim', { preHandler: admin }, async () => {
    if (!game.launched) throw new HttpError(400, 'Launch first.');
    await game.runFeeClaim();
    return { ok: true, economy: game.economy() };
  });

  app.post('/api/admin/vault', { preHandler: admin }, async (req) => {
    const add = Number((req.body as Body)?.addUsd);
    if (!Number.isFinite(add)) throw new HttpError(400, 'addUsd must be a number.');
    game.setVault(game.vaultUsd + add);
    await game.maybeBuyCard();
    return { ok: true, economy: game.economy() };
  });

  app.post('/api/admin/balls', { preHandler: admin }, async (req) => {
    const n = Math.max(1, Math.min(100, Number((req.body as Body)?.n) || 10));
    return { spawned: game.spawnBalls(n) };
  });

  app.post('/api/admin/event', { preHandler: admin }, async (req) => {
    const region = (req.body as Body)?.region as Region | undefined;
    game.startEvent(region || undefined);
    return { event: game.event };
  });

  app.post('/api/admin/redeliver', { preHandler: admin }, async (req) => {
    await game.deliverCard(String((req.body as Body)?.cardId ?? ''));
    return { ok: true };
  });
}
