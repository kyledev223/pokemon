# Candy Cove ($COVE)

A shared, first-person 3D island that everyone plays in the browser. On-chain creator fees are claimed every minute
and **scatter golden balls** across the island. On a schedule set in the admin page, the server releases one **real
physical card from the operator's own collection** as a glowing slab that wanders, runs from players and teleports.
Golden balls are the only way to catch it, every hit is a provably fair roll, and the winner gets a one-time **claim
code** to DM for shipping. Separately, free unlimited **pink orbs** catch original critters for a 48-species dex
(30 Island + Ocean, Sky and Cave extensions). The first trainer to complete all of it wins a mystery Master card.

The game's creatures are all original. Real card names appear only in the prize catalog and on the roaming slab, as
factual descriptions of physical cards the operator owns.

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
- Admin: http://localhost:5173/admin.html (password = `ADMIN_PASSWORD` from `.env`, `dev-admin` by default)

### See the full loop locally in about a minute

1. Open the site, enter a name, then **Enter the lobby**. You get a waitlist spot and stand in the glass lobby. Click to throw pink orbs off the edge.
2. In the admin page click **🚀 Launch**. Everyone drops onto the island and early-bonus golden balls land in bags.
3. **Catalog** tab: upload photos for your cards, then **Release now** on one (for a quick test, raise that tier's odds in **Schedule & odds** first).
4. Walk over golden balls to pick them up, then right-click (or **F**) to throw them at the slab. It runs when you get within ~15m.
5. Win it: the "You won a real card!" modal shows your claim code. Paste it into the admin **Claims** tab, mark it verified, then shipped.
6. The secret is revealed on the catch. Go to **#verify** on the page and replay every roll in the browser.

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
  fair.ts          Per-tier odds schedule + roll definition
  prizes.ts        Prize tiers, default odds/schedule, seed catalog, claim-code format
  species.ts       48 original critters + arena stats
  protocol.ts      WebSocket message types
server/
  index.ts         Fastify + @fastify/websocket bootstrap, provider selection
  game.ts          Authoritative game loop: players, balls, critters, fee claims, events, chat
  cardPlay.ts      Real-card releases, server-side golden-ball flights, rolls, wins + claim codes
  cardMover.ts     Server-simulated card slab: wander, flee, teleport, position history
  prizes.ts        Prize catalog, photos, admin settings, claim codes (SQLite)
  guard.ts         Anti-abuse: throw log, hourly golden-ball caps, flags, bans
  fair.ts          Secret/commitment/HMAC rolls (node:crypto)
  store.ts         Players, waitlist, dex (SQLite)
  market.ts        Critter Market (swaps + token sales)
  arena.ts         Turn-based battles vs bot trainers (server-authoritative sessions)
  api.ts           REST API + admin endpoints
  chain/           ChainProvider interface, MockChain, SolanaChain
  cards/           CardProvider (vault auto-buy only), MockCards, HttpCards, placeholder prize art
src/               Frontend (Vite + TS + Three.js, plain CSS)
  main.ts          Wires landing page ↔ game ↔ panels
  game/            Renderer, island builder, critter meshes, card slab, input, net, audio
  panels.ts        Dex / Ranks / Arena / Market / waitlist / prize-won + My cards modals (+ panels-dex.css)
  chat.ts          Bottom-left chat log + input
  game/hand.ts     First-person glove holding the selected orb
  game/orbs.ts     Original pink puff orb + golden ball models, light beams
  game/minimap.ts  Circular north-up minimap
  verify.ts        In-browser provably-fair verifier
  admin.ts         Operator console: catalog, schedule & odds, claims, anti-abuse (admin.html + admin.css)
scripts/           Tests and dev tools
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `ADMIN_PASSWORD` | `dev-admin` | Admin page password (sent as `x-admin-token`; `ADMIN_TOKEN` still works). 10 wrong tries/min per IP. **Change in production.** |
| `IP_SALT` | `dev-salt` | Salt for hashing visitor IPs (waitlist de-dupe). Raw IPs are never stored. |
| `DB_PATH` | `./data/game.db` | SQLite file. Card photos go in a `photos/` folder next to it. Put both on a persistent volume. |
| `LAUNCH_AT` | – | ISO date for the "time until launch" countdown |
| `LAUNCHED` | `false` | Initial launch state; the admin toggle (stored in DB) wins afterwards |
| `FEE_CLAIM_INTERVAL_SEC` | `60` | How often creator fees are claimed (one golden drop per claim) |
| `VAULT_AUTO_BUY` | `false` | Off: real cards come only from the admin catalog and all fees become golden balls. On: `VAULT_SHARE` of fees fills a USDC vault that buys cards into the catalog as Tier B |
| `CARD_THRESHOLD_USD` | `10` | Vault size that triggers a card purchase (`VAULT_AUTO_BUY` only) |
| `VAULT_SHARE` | `0.5` | Share of each claim sent to the vault (`VAULT_AUTO_BUY` only) |
| `USD_PER_GOLDEN_BALL` | `0.25` | Fee value per golden ball |
| `MAX_BALLS_PER_DROP` | `40` | Cap per claim (also max 300 on the island) |
| `GOLD_PER_HOUR` | `20` | Default golden balls one trainer can pick up per rolling hour (a network gets 2×). Editable in admin |
| `CARD_TELEPORT_MINUTES` | `4` | Default time between card teleports (±25%). Editable in admin |
| `MAX_ACCOUNTS_PER_IP_DAY` | `5` | New browser accounts allowed per network per 24h |
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

**Prize catalog.** Each row is one physical card: name, set, grade, photo, tier (S/A/B) and status
(`available → in_play → won → shipped`). It's seeded on first boot with the 17 cards from the brief and edited in the
admin **Catalog** tab (photos are JPEG/PNG/WebP up to 6 MB, magic-byte checked). A won card never goes back on the shelf.
Cards that were never released can be deleted; released ones stay because their throw logs are public.

**Releases.** One card at a time. Each tier has an interval (defaults: Tier B every 24h, Tier A every 7 days, Tier S
manual only); when no card is out, the earliest due tier releases a random available card of that tier. Clocks start at
launch. The admin can also release a specific card, teleport it, or recall it (the release ends with no winner, its
secret is revealed, and the card returns to the shelf for a fresh release later). Everyone gets a banner:
"A real *card name* card is loose on the island!"

**The slab.** Simulated only on the server at 10 Hz: wanders at 2.4 m/s, runs at 7.2 m/s from anyone within 15m
(walkers can't keep up, runners can), and teleports every few minutes. Clients draw it 150ms in the past and interpolate.

**Catch odds (per tier, editable in admin).** Only golden balls count. Hit index `i` (hit #n has `i = n − 1`) wins with
`min(cap, start + step × i)`:

| Tier | Start | Step per miss | Cap | Mean hits |
| --- | --- | --- | --- | --- |
| S | 0.05% | +0.002 pts | 2% | ~258 |
| A | 0.1% | +0.003 pts | 3% | ~200 |
| B | 0.2% | +0.005 pts | 5% | ~144 |

Each release stores the odds it went out with, so changing settings never changes a card already on the island, and the
verifier always replays the right schedule.

**Provably fair.**
1. On release the server generates a 32-byte `secret`, publishes `sha256(secret)` (over the raw bytes, hex) and writes it in an on-chain memo.
2. Throw `i` wins if `HMAC-SHA256(key = secret bytes, msg = "cardId:i")`, read as a 256-bit integer and divided by 2²⁵⁶, is below that throw's odds.
3. When the release ends (caught or recalled) the secret is revealed. `#verify` lists every release with its odds and full throw log, recomputes the commitment and every roll with WebCrypto, and checks that the winner was the *first* winning roll (or, for a recall, that no roll won).

**Claiming.** The winning hit creates a one-time code like `CLAIM-7F3K-9QXA` (CSPRNG, no look-alike characters) tied to
the player, the card and the winning hit. Only the winner's socket and `/api/me` ever carry it; the public gallery shows
the card, winner, date and Won/Shipped but never the code. The winner's modal has **Copy code** and **Open X DM** (a
prefilled message to `BRAND.claimContactX`, a placeholder `@YOUR_TWITTER` in `shared/brand.ts` until you set it), and
**🎁 My cards** in the HUD shows it again later. In admin **Claims**, look up a code to see the card, winner (with any
flags), release, commitment, revealed secret, every rolled hit and the winner's raw throw log; **Mark verified** redeems
it (one time only, enforced in SQL), then **Mark shipped** records the tracking number.

**Server-authoritative.** The server owns golden ball inventory, pickups, the card's position, hits and rolls. Golden
balls are simulated on the server: each throw's ballistic path is stepped at 60 Hz against the card's recorded path
(lag-compensated by the same 150ms clients render with). Critter motion is deterministic from `(seed, spawn time, now)`
in `shared/world.ts`, so orb throws are re-simulated the same way. Positions are speed- and collision-checked. Throws are
rate-limited (4/s, golden balls 1 per 450ms), and a golden throw whose origin isn't where the server has you is refused
without spending the ball.

**Anti-abuse.** One account per browser token, a cap on new accounts per network per day, and at most 8 sockets per
network; opening the game in a second tab kicks the first. Golden-ball pickups are capped per trainer per rolling hour
(and 2× that per network), so extra tabs or accounts don't farm more. Every golden throw and every rejected throw is
written to `throw_log` with origin, direction, client time and result. Impossible movement, throw-rate, throw-origin and
pickup-distance violations raise flags for the admin **Anti-abuse** tab, which can ban an account (bans stop golden
pickups and throws).

**Waitlist.** One spot per browser token, and one per IP hash. Returning never moves you down. A second browser on the
same network shares the existing spot. The bonus is granted once, on first join after launch: #1–100 get 10, #101–500 get 6, #501–2000 get 4, everyone else 2.

**Critters.** 30 Island species (roam meadows), 6 Ocean (swim offshore, throw from the beach), 6 Sky (circle overhead,
land for about 7s every 40s), 6 Cave (inside the crystal mountain, NE). Each region has one legendary that only spawns
during 5-minute timed events (every 2–5h, or triggered from admin). Catch chance depends on rarity. The first catch of each
species is locked in your dex and can never be traded.

**Catching.** A pink orb that hits a critter pulls it in; the orb wobbles three times (2.6s) before the server
reveals the result, and the critter can't be targeted while it's inside. Catches of new species update your title
(Ocean/Sky/Cave Master, Dex Master for the 30-species island dex, Grand Master for everything), which shows above
your avatar and in chat. Island-dex finishers scroll in the HUD's "Dex masters" ticker.

**Arena.** Pick up to 3 of your critters for a turn-based battle against a bot trainer. Each species has HP/ATK/DEF/SPD,
a level (5 + 3 per extra copy, max 50) and 4 moves; the server resolves every turn. Wins give 3 arena points, losses 1.

**Chat.** Enter to type, Enter to send. Max 140 characters, 1 message per second (5 per 10s), control characters stripped.
The last 40 lines live in memory and are sent to new connections; big events (drops, cards, legendaries) post system lines.

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

### Cards: `server/cards/types.ts` (only with `VAULT_AUTO_BUY=true`)

Set `CARD_PROVIDER=http`, `CARD_API_URL`, `CARD_API_KEY`. `HttpCards` expects:

```
POST /quote     { maxUsd }               → { listingId, name, set, grade, priceUsd, valueUsd, image, payTo } | { listing: null }
POST /purchase  { listingId, paymentSig } → { mint }
```

Bought cards land in the catalog as Tier B (an `https://` listing image becomes the photo) and are claimed with a claim
code like every other card.

## Deploy

It's a single Node process with SQLite, so run **one instance** (the game state is in memory and on one DB file).

1. `npm ci && npm run build`
2. Set env vars (at least `ADMIN_PASSWORD`, `IP_SALT`, `DB_PATH` on a persistent disk, and the chain settings).
3. `npm start`. This serves the site, `/admin`, `/api/*` and `/ws` on `PORT`.
4. Put it behind HTTPS (required for the WebCrypto verifier and clipboard) with WebSocket upgrade enabled. For example, Caddy:
   ```
   play.example.com {
     reverse_proxy localhost:8787
   }
   ```
   `trustProxy` is on, so the IP hash uses `X-Forwarded-For` from your proxy. Make sure the proxy overwrites that header.
5. Any VM, Fly.io (1 machine + volume), Render (disk) or Railway (volume) works. Back up the SQLite file and the `photos/` folder.

**Scaling past one box:** move `server/db.ts` and `server/store.ts` to Postgres (queries are plain SQL), and move the in-memory
state in `Game` (balls, critter spawns, current card) to Redis with a single leader running the fee and event loops.

## Before going live

- Set `claimContactX` in `shared/brand.ts` to the X account winners should DM, and upload a photo for every card.
- Replace the placeholder critters (`src/game/critterMesh.ts` builds them from primitives) with your designs. `buildCritter()` can return a loaded GLTF instead.
- Change `ADMIN_TOKEN` and `IP_SALT`, set `TOKEN_MINT`, and fill in `BRAND.socials` / `BRAND.buyUrl`.
- Have counsel review prize mechanics for your jurisdictions. The footer disclaimer is a starting point, not legal advice.
