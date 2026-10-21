# Candy Cove ($COVE)

A shared, first-person 3D island that everyone plays in the browser. On-chain creator fees are claimed every few
minutes and do two things: they **scatter golden balls** across the island, and they **fill a USDC vault**. Each time
the vault reaches $10, the server buys a real graded card and releases it as a roaming creature. Players hit it with
golden balls. Every hit is a provably fair roll, and the winning throw gets the card, sent to any Solana wallet they
paste. Separately, free unlimited **pink orbs** catch original critters for a 48-species dex (30 Island + Ocean, Sky and
Cave extensions). The first trainer to complete all of it wins a mystery Master card.

> The name and ticker are placeholders. Change them in [`shared/brand.ts`](shared/brand.ts) and the whole site
> follows. Critter species live in [`shared/species.ts`](shared/species.ts).

---

## Quick start

Requires **Node 22.13+** (uses the built-in `node:sqlite`, so there are no native builds).

```bash
npm install
cp .env.example .env      # defaults run everything with mocks
npm run dev               # API + WebSocket on :8787, site on :5173
```

- Site: http://localhost:5173
- Admin: http://localhost:5173/admin.html (token = `ADMIN_TOKEN` from `.env`, `dev-admin` by default)

### See the full loop locally in about a minute

1. Open the site, enter a name, then **Enter the lobby**. You get a waitlist spot and stand in the glass lobby. Click to throw pink orbs off the edge.
2. In the admin page click **🚀 Launch**. Everyone drops onto the island and early-bonus golden balls land in bags.
3. Click **💰 Add $10 to vault**. The mock card shop "buys" a card and it starts roaming (follow the golden beam).
4. Walk over golden balls to pick them up, then right-click (or **F**) to throw them at the card.
5. Use **⚡ Claim fees now** to force a fee drop, or **🌟 Legendary event** to spawn a legendary.
6. After a catch, the secret is revealed. Go to **#verify** on the page and replay every roll in the browser.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server + `tsx watch` backend (mock chain/cards by default) |
| `npm run build` | Typecheck + production build into `dist/` |
| `npm start` | Production server: API, WebSocket and `dist/` from one port |
| `npm test` | Fair-roll cross-check (node:crypto vs WebCrypto) + end-to-end smoke test over HTTP/WS |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run world:map` | ASCII map of the procedural island + spawn sanity checks |

## Project layout

```
shared/            Code used by BOTH browser and server (must stay deterministic)
  brand.ts         Name, ticker, links
  world.ts         Terrain heightfield, paths, cave/bazaar/lobby, collision, throw physics, creature motion
  fair.ts          Odds schedule + roll definition
  species.ts       48 original critters + arena stats
  protocol.ts      WebSocket message types
server/
  index.ts         Fastify + @fastify/websocket bootstrap, provider selection
  game.ts          Authoritative game loop: players, balls, critters, card, fee claims, events
  fair.ts          Secret/commitment/HMAC rolls (node:crypto)
  store.ts         Players, waitlist, dex (SQLite)
  market.ts        Critter Market (swaps + token sales)
  arena.ts         Bot duels for the Ranks board
  api.ts           REST API + admin endpoints
  chain/           ChainProvider interface, MockChain, SolanaChain
  cards/           CardProvider interface, MockCards, HttpCards, placeholder slab art
src/               Frontend (Vite + TS + Three.js, plain CSS)
  main.ts          Wires landing page ↔ game ↔ panels
  game/            Renderer, island builder, critter meshes, input, net, audio
  panels.ts        Dex / Ranks / Arena / Market / waitlist / claim modals
  verify.ts        In-browser provably-fair verifier
  admin.ts         Operator console (admin.html)
scripts/           Tests and dev tools
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `ADMIN_TOKEN` | `dev-admin` | Required header `x-admin-token` for `/api/admin/*`. **Change in production.** |
| `IP_SALT` | `dev-salt` | Salt for hashing visitor IPs (waitlist de-dupe). Raw IPs are never stored. |
| `DB_PATH` | `./data/game.db` | SQLite file. Put it on a persistent volume. |
| `LAUNCH_AT` | – | ISO date for the "time until launch" countdown |
| `LAUNCHED` | `false` | Initial launch state; the admin toggle (stored in DB) wins afterwards |
| `FEE_CLAIM_INTERVAL_SEC` | `180` | How often creator fees are claimed |
| `CARD_THRESHOLD_USD` | `10` | Vault size that triggers a card purchase |
| `VAULT_SHARE` | `0.5` | Share of each claim sent to the USDC vault; the rest becomes golden balls |
| `USD_PER_GOLDEN_BALL` | `0.25` | Fee value per golden ball |
| `MAX_BALLS_PER_DROP` | `40` | Cap per claim (also max 300 on the island) |
| `CHAIN_PROVIDER` | `mock` | `mock` or `solana` |
| `SOLANA_CLUSTER` | `mainnet-beta` | Used for Solscan links |
| `RPC_URL` | public mainnet | Use a dedicated RPC (Helius, Triton, …) in production |
| `TOKEN_MINT` | – | The CA. Empty shows "CA soon"; set it to enable Copy/Solscan/Buy and market sales |
| `USDC_MINT` | mainnet USDC | |
| `FEE_WALLET_SECRET_KEY` | – | JSON byte array. Receives creator fees, signs claims, memos and swaps. |
| `VAULT_WALLET_SECRET_KEY` | – | JSON byte array. Holds vault USDC, pays card sellers. |
| `FEE_WALLET_RESERVE_SOL` | `0.05` | SOL kept back for rent and fees |
| `CARD_PROVIDER` | `mock` | `mock` or `http` |
| `CARD_API_URL` | – | Card marketplace base URL (for `http`) |
| `CARD_API_KEY` | – | Bearer token for the card marketplace |
| `LOG_LEVEL` | `info` | Pino log level |

## Game rules (as implemented)

**Catch odds.** Every golden ball that physically hits the card is one logged throw. Throw index `i` (throw #n has
`i = n − 1`) wins with probability `min(25%, 0.4% + 0.012 pts × i)`. The mean is about **88 hits per catch**. This is computed
from the schedule and shown on the page; it is not hard-coded.

**Provably fair.**
1. On release the server generates a 32-byte `secret`, publishes `sha256(secret)` (over the raw bytes, hex) and writes it in an on-chain memo.
2. Throw `i` wins if `HMAC-SHA256(key = secret bytes, msg = "cardId:i")` → first 13 hex chars (52 bits) ÷ 2⁵² is below that throw's odds.
3. After the catch the secret is revealed. `#verify` recomputes the commitment and every roll with WebCrypto and checks that the winner was the *first* winning roll.

**Server-authoritative.** The server owns golden ball inventory, pickups, card position, hits and rolls. Creature
motion is a deterministic function of `(seed, spawn time, now)` in `shared/world.ts`, so the server re-simulates
every throw's ballistic path against the target at the claimed throw time (clamped to −700ms/+150ms). Positions are
speed- and collision-checked (no teleports, no walking through the mountain or into deep water). Throws are
rate-limited (4/s, golden balls 1 per 450ms). Messages are rate-limited per socket, and POSTs per IP.

**Waitlist.** One spot per browser token, and one per IP hash. Returning never moves you down. A second browser on the
same network shares the existing spot. The bonus is granted once, on first join after launch: #1–100 get 10, #101–500 get 6, #501–2000 get 4, everyone else 2.

**Critters.** 30 Island species (roam meadows), 6 Ocean (swim offshore, throw from the beach), 6 Sky (circle overhead,
land for about 7s every 40s), 6 Cave (inside the crystal mountain, NE). Each region has one legendary that only spawns
during 5-minute timed events (every 2–5h, or triggered from admin). Catch chance depends on rarity. The first catch of each
species is locked in your dex and can never be traded.

**Market.** Swaps settle instantly. Sales: the seller pastes a payout wallet, the buyer sends `TOKEN_MINT` tokens to it and
submits the signature, and the server verifies the token balance change on-chain before handing over the critter.
Each signature can only be used once.

## Swapping mocks for real integrations

Both integrations are behind interfaces, and `server/index.ts` picks the implementation from env.

### Chain: `server/chain/types.ts` → `SolanaChain`

Set `CHAIN_PROVIDER=solana`, `RPC_URL`, `TOKEN_MINT`, `FEE_WALLET_SECRET_KEY`, `VAULT_WALLET_SECRET_KEY`.

- **Claiming fees** is launchpad specific. Add the launchpad's collect-creator-fee instruction(s) in
  `SolanaChain.claimInstructions()`. Any new SOL in the fee wallet beyond what was already accounted for counts as the claim. If your
  launchpad pushes fees automatically, leave it returning `[]`.
- **Vault deposit** swaps the vault share of SOL to USDC through Jupiter (`lite-api.jup.ag/swap/v1`) straight into the vault wallet's USDC account.
- **Memos** use the SPL Memo program from the fee wallet.
- **Card payments** are `transferChecked` USDC from the vault wallet.
- **Market sales** are verified by parsing the transaction's pre/post token balances.

Test on devnet first: `SOLANA_CLUSTER=devnet`, a devnet RPC, and devnet USDC/token mints.

### Cards: `server/cards/types.ts`

Set `CARD_PROVIDER=http`, `CARD_API_URL`, `CARD_API_KEY`. `HttpCards` expects:

```
POST /quote     { maxUsd }               → { listingId, name, set, grade, priceUsd, valueUsd, image, payTo } | { listing: null }
POST /purchase  { listingId, paymentSig } → { mint }
POST /transfer  { mint, wallet }          → { signature }
```

If your vendor's API looks different, implement `CardProvider` directly (three methods). Real card images should be
URLs you're licensed to display. The mock provider draws original placeholder slabs.

## Deploy

It's a single Node process with SQLite, so run **one instance** (the game state is in memory and on one DB file).

1. `npm ci && npm run build`
2. Set env vars (at least `ADMIN_TOKEN`, `IP_SALT`, `DB_PATH` on a persistent disk, and the chain/card settings).
3. `npm start`. This serves the site, `/admin`, `/api/*` and `/ws` on `PORT`.
4. Put it behind HTTPS (required for the WebCrypto verifier and clipboard) with WebSocket upgrade enabled. For example, Caddy:
   ```
   play.example.com {
     reverse_proxy localhost:8787
   }
   ```
   `trustProxy` is on, so the IP hash uses `X-Forwarded-For` from your proxy. Make sure the proxy overwrites that header.
5. Any VM, Fly.io (1 machine + volume), Render (disk) or Railway (volume) works. Back up the SQLite file.

**Scaling past one box:** move `server/db.ts` and `server/store.ts` to Postgres (queries are plain SQL), and move the in-memory
state in `Game` (balls, critter spawns, current card) to Redis with a single leader running the fee and event loops.

## Before going live

- Replace the placeholder critters (`src/game/critterMesh.ts` builds them from primitives) with your designs. `buildCritter()` can return a loaded GLTF instead.
- Change `ADMIN_TOKEN` and `IP_SALT`, set `TOKEN_MINT`, and fill in `BRAND.socials` / `BRAND.buyUrl`.
- Have counsel review prize mechanics for your jurisdictions. The footer disclaimer is a starting point, not legal advice.
