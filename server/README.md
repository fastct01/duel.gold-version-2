# Duel.gold server

Backend for real **player-vs-player** skill games with **crypto wallets on a test network**.

- Sign in by signing a message with a wallet (no passwords, no gas).
- Every player gets their own **deposit address**. Send test ETH there; it is credited after N confirmations.
- Stake test ETH on a game, get matched with another **human** of similar rating, both play the **same seeded challenge**, the higher score wins the pot minus a 10% fee.
- Withdraw winnings **on-chain** to the wallet you signed in with.

> **Test networks only.** The server refuses to start on any chain id that is not a known testnet (Sepolia, Hoodi, Base/Arbitrum/OP Sepolia, Polygon Amoy, local Hardhat/Anvil). Keys are held by the server (custodial) with no HSM, no cold storage and no KYC. Do not point it at anything with real value.

Node 22.13+, no build step. State is one SQLite file (`node:sqlite`), one server process.

## Try it

```bash
cd server
npm install
npm run dev          # local chain + server + a local faucet → http://localhost:8787/play/
```

Open `/play/` in two browsers (or one normal and one private window), choose **Continue with a burner wallet** in each, press **Add 1 test ETH**, pick a game and a stake, and **Find opponent**. The page plays the real game packs from `../src/games`.

Other scripts: `npm run chain` starts just the local chain; `npm start` runs the server alone against `RPC_URL`.
Tests: `npm test` (104 tests, about 50 s, includes real Chromium and a real local chain).

### Against Sepolia (or another testnet)

```bash
export RPC_URL=https://…your Sepolia JSON-RPC…   CHAIN_ID=11155111   CONFIRMATIONS=6
export HD_MNEMONIC="twelve words …"              # see below
export ALLOWED_ORIGINS=https://your.site  PUBLIC_DOMAIN=your.site  ADMIN_TOKEN=$(openssl rand -hex 24)
NODE_ENV=production npm start
```

1. `HD_MNEMONIC` derives **all** keys (deposit addresses and the treasury). Generate one with `node -e "console.log(require('ethers').Wallet.createRandom().mnemonic.phrase)"` and keep it secret.
2. The startup log prints the **treasury address**. Send it test ETH from a faucet: it pays withdrawals and sweep gas. Watch `GET /v1/admin/solvency`.
3. Players send test ETH from any normal wallet (not a smart-contract wallet) to the deposit address shown in the wallet panel.

All settings are environment variables; see [`.env.example`](.env.example). Production mode refuses to start without `HD_MNEMONIC` and an explicit `ALLOWED_ORIGINS`.

> **Not verified against a live public testnet.** The development environment this was built in blocks public RPC endpoints, so everything was tested against a real local EVM node (Hardhat) over JSON-RPC, which exercises the same code paths. Before relying on it, run one deposit → match → withdrawal on Sepolia yourself.

## How it works

```
 browser / SDK ──HTTPS── REST  /v1/*  ─┐
       └────────WSS──── /v1/ws  ───────┤   Router · Gateway (rate limits, origin checks)
                                       ▼
   Auth ─ Users ─ Responsible play ─ MatchService (queue, matches, Elo) ─ Catalog (game packs)
                                       │
                                    Ledger  (double-entry, exact wei, SQLite)
                                       │
   WalletService ─ DepositWatcher · Sweeper · Withdrawals ── JSON-RPC ── EVM test network
```

| Area | File |
|---|---|
| Config, testnet allow-list | `src/config.js`, `src/wallet/chain.js` |
| Money: double-entry ledger | `src/ledger.js` |
| Wallet sign-in | `src/auth.js` |
| Deposits / sweeps / withdrawals | `src/wallet/*` |
| Matchmaking and matches | `src/matches/*` |
| Daily loss limit | `src/responsible.js` |
| REST / WebSocket | `src/http/*`, `src/ws/gateway.js` |
| Client SDK (Node and browser) | `client/duel-client.js` |
| Browser client | `public/` |

### Money

Every amount is an integer number of **wei**, held as `BigInt` in memory and decimal `TEXT` in SQLite; JSON carries decimal strings. Nothing is ever a JS `Number`.

The ledger is double-entry: each transaction's entries sum to exactly zero, and only `external:chain` may go negative, so no player or escrow can be overdrawn. `GET /v1/admin/audit` re-derives every balance from the entries.

| Account | Meaning |
|---|---|
| `user:<id>` | spendable balance |
| `escrow:ticket:<id>` | stake held while queued |
| `escrow:match:<id>` | both stakes of a running match |
| `escrow:withdrawal:<id>` | funds on their way out |
| `house:fees` | collected fees |
| `external:chain` | minus net deposits |

**Payouts.** Win: `floor(pot × 90%)` to the winner, the remainder (fee) to the house. Draw or void: each stake back, no fee. Stake 0 is free play (rating only). Ratings are per game, Elo with K = 24, start 1200, same constants as the front-end.

### Deposits, sweeps, withdrawals

- **Deposits.** The watcher scans blocks that are already `CONFIRMATIONS` deep (so a reorg cannot un-credit anything) for top-level transfers to any known deposit address. The tx hash is an idempotency key and the scan cursor moves in the same DB transaction as the credit, so a crash can neither lose nor repeat a deposit. Transfers made *inside* a contract call (multisigs, smart wallets) are not seen.
- **Sweeps.** Confirmed deposits are moved to the treasury so it can pay withdrawals. The ledger is not involved; players were already credited.
- **Withdrawals** are a crash-safe state machine: `queued → signed → broadcast → confirmed | failed`. The raw signed transaction is stored **before** it is broadcast and re-sent byte-for-byte after a crash, so it cannot pay twice. A withdrawal is refunded only when the chain **proves** it can never mine (it reverted, or the treasury nonce moved past it while our hash is unknown to the node, for a safety window). A merely slow transaction is re-broadcast, never refunded. Payouts go only to the sign-in address; there is a per-request cap, a rolling 24-hour cap, and `Idempotency-Key` support.

### Matches (race games)

```
join queue ─▶ found ─▶ both press Ready ─▶ playing ─▶ settled
 stake held   stakes in   server draws the seed,    both scores → higher wins (equal = draw)
              match       sends it ONCE to the       one score by the deadline → that player wins
              escrow      Ready socket, start time   forfeit → the other player wins
                          a few seconds ahead        nothing submitted → void, refunds
```

- Pairing: same game and stake, rating within ±60 widening 15/second up to ±600. A private code (`code`) pairs two friends regardless of rating.
- No-show or decline: match voided, everyone refunded, the absent player gets a strike; 3 strikes = 5-minute queue ban.
- Settlement is one DB transaction guarded by a compare-and-set on the match state, so a submit, a forfeit and the deadline timer racing each other settle it exactly once.
- Restart recovery: queued tickets are refunded (open invite lobbies are restored, see above), unstarted matches voided, running matches keep their deadline.
- Only **race** games (14 of 22) are playable person-vs-person. The 8 **versus** games embed an AI opponent in the client; a human-vs-human version needs a server-side rules referee per game.

### How lobbies work (invite-only play)

Random matchmaking is **off by default** (`PUBLIC_QUEUE=1` turns it back on; without it `POST /v1/queue` and WS `queue.join` without a `code` fail with 403 `PUBLIC_QUEUE_DISABLED`). Players meet through invite lobbies:

1. The host calls `POST /v1/lobbies {game, stake}`. The server generates an 8-character code (alphabet without 0/O/1/I/L, from `crypto.randomInt`) and holds the host's stake exactly like a queue ticket, in `escrow:ticket:<id>`. All stake checks apply (balance, loss limit, queue ban). One open lobby per player; a hosting player cannot queue, host another, or join someone else's (409 `ALREADY_ACTIVE`).
2. The client shows `<origin>/play/?join=<CODE>`. Anyone may `GET /v1/lobbies/:code` (public, rate-limited per IP, host display name only, never an address or user id; the code is case-insensitive).
3. A friend calls `POST /v1/lobbies/:code/join`. The guest's stake is escrowed in their own ticket and the two tickets are paired immediately through the same path as the queue (stakes move to `escrow:match:<id>`; host is seat 0). Both players receive `match.found`; Ready, play and settlement are unchanged.
4. The host can `DELETE /v1/lobbies/:code` (stake refunded), or it expires after `LOBBY_TTL_MS` (default 30 minutes; stake refunded, `lobby.closed` sent).

Races: node:sqlite is synchronous, so a join runs start to finish without interleaving. The first joiner flips the host ticket to `matched` (compare-and-set inside the match transaction); a second joiner sees the lobby closed before any of their money moves and gets 409 `LOBBY_CLOSED`. Cancel vs. join resolves the same way: one of them wins, the other gets `LOBBY_CLOSED`, nobody is charged twice. Restarts: open lobbies are restored from the `tickets` table (same escrow, expiry timer re-armed for the time left), and lobbies already past their expiry are refunded once on boot.

### Responsible play (enforced server-side)

Daily loss limit: lowering it applies at once, raising or removing it takes 24 h, and stakes in escrow count as at risk. Withdrawals are never blocked by it.

## API

Amounts are decimal wei strings, times are epoch milliseconds, errors are `{ "error": { "code", "message", … } }`. Send `Authorization: Bearer <token>`.

| | |
|---|---|
| `POST /v1/auth/nonce` `{address}` | get a message to sign |
| `POST /v1/auth/login` `{address, nonce, signature}` | → `{token, me}` |
| `POST /v1/auth/logout` | |
| `GET /v1/config` · `/v1/games` · `/v1/health` · `/v1/leaderboard?game=` | public |
| `GET /v1/lobby` | public live activity: `{at, online, playing, games[{game, waiting, playing, stakes[]}], recent[]}`; aggregates only, private-code play excluded, cached ~1.5 s (`LOBBY_CACHE_MS`) |
| `GET/PATCH /v1/me` | profile, balances, limits, active queue/lobby/match (`active.kind` = `queue` / `lobby` / `match`), ratings |
| `PUT /v1/me/loss-limit` `{amount\|null}` | set, lower or (after 24 h) raise or remove the daily loss limit |
| `GET /v1/wallet` | deposit address, chain, balances, limits |
| `GET /v1/wallet/history` · `/deposits` · `/withdrawals` | |
| `POST /v1/wallet/withdraw` `{amount}` + `Idempotency-Key` | to your sign-in address only |
| `POST /v1/lobbies` `{game, stake}` | host an invite lobby, `201 {lobby}` |
| `GET /v1/lobbies/:code` | public, `{lobby}`; unknown code 404 `LOBBY_NOT_FOUND` |
| `POST /v1/lobbies/:code/join` | `{match}`; errors `LOBBY_NOT_FOUND` 404, `LOBBY_CLOSED` 409, `LOBBY_OWN` 409 + stake/limit errors |
| `DELETE /v1/lobbies/:code` | host only, `{lobby}` closed and refunded (`LOBBY_NOT_HOST` 403, `LOBBY_CLOSED` 409 if already matched) |
| `POST /v1/queue` `{game, stake, code?}` · `DELETE /v1/queue` | public queue needs `PUBLIC_QUEUE=1`; with a private `code` it always works |
| `POST /v1/matches/:id/ready` · `/submit` `{score}` · `/forfeit` · `GET /v1/matches[/:id]` | |
| `GET /v1/admin/audit` · `/solvency` · `/flags` | `Authorization: Bearer $ADMIN_TOKEN` |

### WebSocket `/v1/ws`

First message within 5 s: `{"type":"auth","token":"…"}`. Requests may carry an `id` and are answered with `{"type":"ack","id","ok",…}`.

Requests: `queue.join` `{game, stake, code?}` · `queue.leave` · `lobby.create` `{game, stake}` → `{lobby}` · `lobby.close` `{code?}` → `{lobby}` · `match.ready` `{matchId}` · `match.progress` `{matchId, score}` · `match.submit` `{matchId, score}` · `match.forfeit` `{matchId}` · `sync` · `ping`.

Events: `hello`, `sync`, `queue.joined|left|expired`, `lobby.created` `{lobby}`, `lobby.closed` `{lobby}` (cancelled/expired), `match.found`, `match.opponent_ready`, **`match.start` `{seed, startAt, submitDeadline}`**, `match.opponent_progress`, `match.opponent_finished`, `match.result`, `match.void`, `wallet.updated`.

```js
import { DuelClient } from "./client/duel-client.js";
const c = new DuelClient({ baseUrl, address, sign: (m) => wallet.signMessage(m) });
await c.login(); await c.connect();
await c.joinQueue({ game: "reaction", stake: "1000000000000000" });
const { match } = await c.waitFor("match.found");
await c.ready(match.id);
const { seed, startAt } = await c.waitFor("match.start");   // play the game with `seed`, then:
await c.submit(match.id, score);
const { match: result } = await c.waitFor("match.result");
```

## Security and trust model

What is enforced: signature-verified login with single-use expiring nonces and hashed session tokens · sessions re-checked on every WebSocket message (logout, expiry and bans end live sockets) · RPC error text is never exposed or logged raw (providers put API keys in URLs) · BigInt-only money with a double-entry ledger and idempotency keys · testnet-only chain guard · state compare-and-set on every match transition · payouts only to the sign-in address · input validation everywhere (no string-built SQL) · body, frame and rate limits · origin checks on WebSocket · constant-time admin token check · path-safe static serving with a CSP.

What is **not** solved, by design of this prototype:

1. **Scores are reported by the player's own client.** The server picks the seed and the clock, delivers the seed once to a single socket, enforces deadlines and flags scores over 3× the strongest bot on that seed (`/v1/admin/flags`; advisory, it never changes a result). A modified client can still lie or run a solver. Real-money play needs server-side replay/verification of each game.
2. **Custodial keys in one process** protected only by the mnemonic. Production would use a KMS/HSM, cold storage, hot-wallet limits and dual control.
3. **Sybil/collusion.** Anyone can create wallets; two accounts can throw matches to each other (the 10% fee makes it costly, not impossible). No KYC or geo verification.
4. **Single instance.** SQLite and in-memory queues; no horizontal scaling. Rate limits are per process.
5. Login supports normal (EOA) wallets only, not EIP-1271 smart-contract wallets. Player display names are user-supplied text; clients must escape them.

## Testing

`npm test` runs `node:test` suites, no mocks for money or the chain:

| Suite | Covers |
|---|---|
| `ledger`, `rules` | balance exactness beyond 2^53, atomicity, overdraft, idempotency, audit tamper detection, pairing, Elo, catalog |
| `auth`, `responsible` | signatures, replay, expiry, bans, loss-limit delays |
| `wallet.chain` | **real local EVM node:** confirmations, restart safety, sweeps, withdrawals, crash and failure paths, refunds, testnet guard |
| `matches`, `matchmaking` | every outcome and its exact arithmetic, escrow, no-shows, seed delivery, races, restart recovery |
| `api` | error shapes, admin, CORS/origin, limits, static-file safety, socket abuse |
| `e2e` | wallet → on-chain deposit → match → on-chain withdrawal → solvency |
| `browser` | **real Chromium, two players**, funded and withdrawn on-chain; screenshots in `test/shots/` |

The suite itself was checked by mutation: 16 deliberate bugs in money and fairness logic (no fee, inverted winner, no refund, overdraft allowed, seed re-sent, self-matching, ignored loss limit…) were injected; 15 fail the suite and the survivor is an equivalent mutant (a second, redundant guard). That exercise exposed four weak spots in the tests themselves (expected amounts computed by the code under test, no direct test of self-pairing, no test of late submissions, and no check that ratings apply exactly once), all fixed.

## Roadmap

Versus-game referees (chess etc.) · 2v2, FFA, tournaments and Duel Mix over the wire · server-side score verification · spectating · KYC and a licensed payment path before any real money.
