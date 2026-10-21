import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG } from './config';
import { openDb } from './db';
import { Store } from './store';
import { Game } from './game';
import { registerApi } from './api';
import { MockChain } from './chain/mock';
import { SolanaChain } from './chain/solana';
import { MockCards } from './cards/mock';
import { HttpCards } from './cards/http';
import type { ChainProvider } from './chain/types';
import type { CardProvider } from './cards/types';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });
await app.register(websocket, { options: { maxPayload: 16 * 1024 } });

const db = openDb(CONFIG.dbPath);
const chain: ChainProvider = CONFIG.chainProvider === 'solana' ? new SolanaChain() : new MockChain();
const cards: CardProvider = CONFIG.cardProvider === 'http' ? new HttpCards() : new MockCards();
const game = new Game(db, new Store(db), chain, cards, app.log);

// Routes log at warn so per-request lines don't drown out game events.
await app.register(
  async (scope) => {
    scope.get('/ws', { websocket: true }, (socket, req) => game.connect(socket, req.ip));
    registerApi(scope, game);
  },
  { logLevel: 'warn' },
);

// In production the built frontend is served from the same origin.
const dist = resolve(import.meta.dirname, '../dist');
if (existsSync(dist)) {
  await app.register(
    async (scope) => {
      await scope.register(fastifyStatic, { root: dist });
      scope.get('/admin', (_req, reply) => reply.sendFile('admin.html'));
    },
    { logLevel: 'warn' },
  );
}

await app.listen({ port: CONFIG.port, host: '0.0.0.0' });
app.log.info(`chain=${chain.name} cards=${cards.name} launched=${game.launched}`);
game.start();
