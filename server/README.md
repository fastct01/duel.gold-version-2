# Duel.gold server

Backend for real **player-vs-player** skill games with **crypto wallets on a test network**.

- Sign in by signing a message with a wallet (no passwords, no gas).
- Every player gets their own **deposit address**. Send test ETH there; it is credited after N confirmations.
- Stake test ETH on a game and play other **humans** at the **same seeded challenge**: head to head, or in an invite lobby of up to 10 players. The highest score wins the pot minus a 10% fee (tied winners split it).
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
Tests: `npm test` (171 tests, about 60 s, includes real Chromium and a real local chain).

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
| `escrow:ticket:<id>` | stake held while queued, or while waiting in an invite lobby (host and every guest each hold one) |
| `escrow:match:<id>` | every player's stake of a running match |
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
join queue / lobby ─▶ found ─▶ everyone presses Ready ─▶ playing ─▶ settled
 stake held             stakes in   server draws the seed,     see "Settlement" below
                        match       sends it ONCE to the Ready
                        escrow      socket, start time a few seconds ahead
```

- Pairing (public queue, 2 players): same game and stake, rating within ±60 widening 15/second up to ±600. A private code (`code`) pairs two friends regardless of rating.
- Invite lobbies hold 2 to `LOBBY_MAX_PLAYERS` (default 10) players: see below. A match has one seat per player (0..N-1, the host is seat 0, guests follow in join order).
- No-show or decline: the whole match is voided, everyone refunded, the players who did not press Ready (or who declined) get a strike; 3 strikes = 5-minute queue ban.
- Settlement is one DB transaction guarded by a compare-and-set on the match state, so a submit, a forfeit and the deadline timer racing each other settle it exactly once.
- Restart recovery: queued tickets are refunded, **open invite lobbies are restored with everyone waiting in them** (see below), unstarted matches voided, running matches keep their deadline.

**Settlement (N players)** is decided by `src/matches/standings.js` from the stored scores and forfeit flags, in one transaction with the money and the ratings:

| Situation | Result |
|---|---|
| Forfeited players, and players who never submitted by the deadline | lose |
| Highest score among the players who did not forfeit | **win**; several tied at the top **split** the payout |
| Forfeits leave exactly one player standing | that player wins at once, no score needed (reason `forfeit`) |
| Everyone submitted the same score and nobody forfeited | **draw**: every stake refunded, no fee |
| Nobody still in the match submitted a score | **void**: every stake refunded, nobody rated |

A forfeit in a match of 3+ players does **not** end it unless it leaves at most one player standing: the others are sent `match.opponent_forfeited` and the match settles when every player still in has submitted, or at the deadline. The forfeiter stays "in the match" (cannot queue or join elsewhere) until it ends. A forfeit in a 1v1 settles immediately, as always.

Money: `splitPot(pot)` gives the payout and the fee; each of the *k* winners gets `floor(payout / k)`, and the fee **plus the wei that did not divide** go to `house:fees` (`matches.fee` stores that total). Ledger entries always sum to zero. Draws and voids refund each stake exactly.

Ratings are **pairwise Elo**: every pair is rated with `delta()` (K = 24) from their relative finish (higher score beats lower, equal = 0.5, a forfeited or score-less player loses to anyone with a score, two of those draw), and a player's change is the sum over opponents divided by `N - 1`, rounded half away from zero. For N = 2 this is exactly the 1v1 formula (±12 at equal ratings). For N > 2 the rounding can leave the total of rating changes a point or two off zero. Per-player `payout`, `rating_after`, wins/losses/draws (winners and co-winners a win, everyone else a loss, an all-tie a draw) and the daily net used by the loss limit are recorded for every seat.
- Only **race** games (14 of 22) are playable person-vs-person. The 8 **versus** games embed an AI opponent in the client; a human-vs-human version needs a server-side rules referee per game.

### How lobbies work (invite-only play)

Random matchmaking is **off by default** (`PUBLIC_QUEUE=1` turns it back on; without it `POST /v1/queue` and WS `queue.join` without a `code` fail with 403 `PUBLIC_QUEUE_DISABLED`). Players meet through invite lobbies of **2 to 10 players** (`LOBBY_MAX_PLAYERS`, default 10, allowed 2-10):

1. The host calls `POST /v1/lobbies {game, stake}`. The server generates an 8-character code (alphabet without 0/O/1/I/L, from `crypto.randomInt`) and holds the host's stake exactly like a queue ticket, in `escrow:ticket:<id>`. All stake checks apply (balance, loss limit, queue ban). One open lobby per player; a hosting or waiting player cannot queue, host another, or join someone else's (409 `ALREADY_ACTIVE`).
2. The client shows `<origin>/play/?join=<CODE>`. Anyone may `GET /v1/lobbies/:code` (public, rate-limited per IP, display names only, never an address or user id; the code is case-insensitive).
3. A guest calls `POST /v1/lobbies/:code/join`: same checks (balance, loss limit, queue ban, not already busy), their stake is escrowed in their own ticket (`tickets.lobby_ticket_id` points at the host's ticket) and they are added to the roster. **Joining does not start a match.** Everyone in the lobby receives `lobby.updated` with the new roster. Full lobby: 409 `LOBBY_FULL`; already inside: 409 `LOBBY_ALREADY_IN`; own lobby: `LOBBY_OWN`; closed or already started: `LOBBY_CLOSED`.
4. A guest may `POST /v1/lobbies/:code/leave` before the start (stake refunded; the host gets 409 `LOBBY_HOST_LEAVE` instead and must cancel). The others receive `lobby.updated`.
5. The host starts with `POST /v1/lobbies/:code/start` (host only, 403 `LOBBY_NOT_HOST`; at least 2 players, else 409 `LOBBY_NOT_ENOUGH_PLAYERS`). The lobby also **starts by itself the moment it reaches `LOBBY_MAX_PLAYERS`**; that last join answers `{lobby, match}`. On start every member's ticket moves into one N-seat match (same path as the queue), everyone gets `match.found`, and the lobby ends in state `matched` with `matchId`. Ready, countdown, play and settlement follow the normal rules above.
6. The host can `DELETE /v1/lobbies/:code`; the lobby then closes and **every member is refunded**. It expires the same way after `LOBBY_TTL_MS` (default 30 minutes; joining does not extend it). Everyone gets `lobby.closed` followed by `wallet.updated`.

Races: node:sqlite is synchronous and a join runs start to finish without an `await`, so two joins can never interleave: the capacity check and the roster insert happen together, a lobby cannot be overfilled, and a join that loses a race to a start, a cancel or the last free seat sees `LOBBY_CLOSED` / `LOBBY_FULL` before any of its money moves. Closing, expiry and starting are compare-and-set on the host ticket's state inside one transaction with all the stake movements, so nobody is refunded or charged twice. Restarts: **open lobbies are restored with their guests** from the `tickets` table (same escrow, same roster and order, busy flags and expiry timer re-armed for the time left); a lobby already past its expiry is closed on boot and its host and every guest refunded once. A match that was found but not started when the server went down is voided and refunded, as for any match.

### Responsible play (enforced server-side)

Daily loss limit: lowering it applies at once, raising or removing it takes 24 h, and stakes in escrow count as at risk. Withdrawals are never blocked by it.

## API

Amounts are decimal wei strings, times are epoch milliseconds, errors are `{ "error": { "code", "message", … } }`. Send `Authorization: Bearer <token>`.

| | |
|---|---|
| `POST /v1/auth/nonce` `{address}` | get a message to sign |
| `POST /v1/auth/login` `{address, nonce, signature}` | → `{token, me}` |
| `POST /v1/auth/logout` | |
| `GET /v1/config` · `/v1/games` · `/v1/health` · `/v1/leaderboard?game=` | public; `config.match` has `lobbyMaxPlayers`, `lobbyTtlMs`, `acceptMs`, … |
| `GET /v1/lobby` | public live activity: `{at, online, playing, games[{game, waiting, playing, stakes[]}], recent[]}`; aggregates only, private-code play excluded, cached ~1.5 s (`LOBBY_CACHE_MS`) |
| `GET/PATCH /v1/me` | profile, balances, limits, active queue/lobby/match (`active.kind` = `queue` / `lobby` / `match`), ratings |
| `PUT /v1/me/loss-limit` `{amount\|null}` | set, lower or (after 24 h) raise or remove the daily loss limit |
| `GET /v1/wallet` | deposit address, chain, balances, limits |
| `GET /v1/wallet/history` · `/deposits` · `/withdrawals` | |
| `POST /v1/wallet/withdraw` `{amount}` + `Idempotency-Key` | to your sign-in address only |
| `POST /v1/lobbies` `{game, stake}` | host an invite lobby, `201 {lobby}` (member view, `role: "host"`) |
| `GET /v1/lobbies/:code` | public, `{lobby}` (names only); unknown code 404 `LOBBY_NOT_FOUND` |
| `POST /v1/lobbies/:code/join` | `{lobby}` (member view, `role: "guest"`), or `{lobby, match}` when this join filled the lobby and it started; errors `LOBBY_NOT_FOUND` 404, `LOBBY_CLOSED` / `LOBBY_FULL` / `LOBBY_ALREADY_IN` / `LOBBY_OWN` 409 + stake/limit/`ALREADY_ACTIVE` errors |
| `POST /v1/lobbies/:code/leave` | guests only, `{lobby}`; `LOBBY_HOST_LEAVE` 409 for the host, `LOBBY_NOT_IN` 409, `LOBBY_CLOSED` 409 |
| `POST /v1/lobbies/:code/start` | host only, `{match}`; `LOBBY_NOT_HOST` 403, `LOBBY_NOT_ENOUGH_PLAYERS` 409, `LOBBY_CLOSED` 409 |
| `DELETE /v1/lobbies/:code` | host only, `{lobby}` closed and everyone refunded (`LOBBY_NOT_HOST` 403, `LOBBY_CLOSED` 409 if already started) |
| `POST /v1/queue` `{game, stake, code?}` · `DELETE /v1/queue` | public queue needs `PUBLIC_QUEUE=1`; with a private `code` it always works |
| `POST /v1/matches/:id/ready` · `/submit` `{score}` · `/forfeit` · `GET /v1/matches[/:id]` | |
| `GET /v1/admin/audit` · `/solvency` · `/flags` | `Authorization: Bearer $ADMIN_TOKEN` |

### WebSocket `/v1/ws`

First message within 5 s: `{"type":"auth","token":"…"}`. Requests may carry an `id` and are answered with `{"type":"ack","id","ok",…}`.

Requests: `queue.join` `{game, stake, code?}` · `queue.leave` · `lobby.create` `{game, stake}` → `{lobby}` · `lobby.join` `{code}` → `{lobby}` or `{lobby, match}` · `lobby.leave` `{code}` → `{lobby}` · `lobby.start` `{code}` → `{match}` · `lobby.close` `{code?}` → `{lobby}` · `match.ready` `{matchId}` · `match.progress` `{matchId, score}` · `match.submit` `{matchId, score}` · `match.forfeit` `{matchId}` · `sync` · `ping`.

Events: `hello`, `sync`, `queue.joined|left|expired`, `lobby.created` `{lobby}`, **`lobby.updated` `{lobby}`** (the roster changed: someone joined or left; sent to every member, each with their own view), `lobby.closed` `{lobby}` (sent to every member when the host cancels or it expires, `closedReason` `cancelled` / `expired`; and to a guest who left, with `closedReason: "left"`; always followed by `wallet.updated`), `match.found` (every player), `match.opponent_ready` `{matchId, seat}`, **`match.start` `{seed, startAt, submitDeadline}`**, `match.opponent_progress` `{matchId, seat, score}`, `match.opponent_finished` `{matchId, seat}`, `match.opponent_forfeited` `{matchId, seat}` (a forfeit that did not end the match), `match.result`, `match.void`, `wallet.updated`. The `match.opponent_*` events go to **all other** players of the match.

**Lobby object** (`lobby`): `{code, game:{id,name}, stake, pot, winnerPayout, feeBps, host:{name}, state: "open"|"matched"|"closed", closedReason?, createdAt, expiresAt, matchId?, minPlayers: 2, maxPlayers, playerCount, players}`, with `pot = stake x playerCount` and `winnerPayout = splitPot(pot).payout`. Public view (`GET /v1/lobbies/:code`): `players: [{name, host}]`, host first, then join order. Member view (every response and event sent to someone inside): adds `role: "host"|"guest"` and `players: [{name, host, you, avatar}]` where `avatar` is the short address. A guest who left is told `state: "closed", closedReason: "left"` in the public shape (for them it is over; the lobby stays open for the others). `sync` / `GET /v1/me` return `active: {kind: "lobby", lobby}` (member view) to the host and to waiting guests.

**Match object** (`match`, via `match.found`, `match.result`, `GET /v1/matches[/:id]`): the 1v1 fields are unchanged (`opponent` is the first other player by seat) and it adds `playerCount` and `players: [{seat, name, address, you, ready, finished, forfeited, score, ratingBefore, ratingAfter, payout, place}]` ordered by seat. `score` of the others, `ratingAfter`, `payout` and `place` (1 = top, ties share a place) appear once the match is over; your own score is always visible. `you.place` is added after the match. `result` is `win` for every winner (including split winners), `loss`, `draw` or `void`; `winnerPayout` is the whole winners' share, `fee` what the house kept.

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
| `ledger`, `rules` | balance exactness beyond 2^53, atomicity, overdraft, idempotency, audit tamper detection, pairing, Elo (1v1 and pairwise), N-player result rules, catalog |
| `auth`, `responsible` | signatures, replay, expiry, bans, loss-limit delays |
| `wallet.chain` | **real local EVM node:** confirmations, restart safety, sweeps, withdrawals, crash and failure paths, refunds, testnet guard |
| `matches`, `matchmaking` | every outcome and its exact arithmetic, escrow, no-shows, seed delivery, races, restart recovery |
| `lobbies` | invite lobbies of 2-10: capacity and races, join/leave/start/close/expiry refunds, roster events, restart recovery, old-database upgrade |
| `multiplayer` | 3-10 player matches: single winner, split with remainder, draw, forfeit, deadline, void, pairwise Elo, ledger audit after each |
| `api` | error shapes, admin, CORS/origin, limits, static-file safety, socket abuse |
| `e2e` | wallet → on-chain deposit → match → on-chain withdrawal → solvency |
| `browser` | **real Chromium, two players**, funded and withdrawn on-chain; screenshots in `test/shots/` |

The suite itself was checked by mutation: 16 deliberate bugs in money and fairness logic (no fee, inverted winner, no refund, overdraft allowed, seed re-sent, self-matching, ignored loss limit…) were injected; 15 fail the suite and the survivor is an equivalent mutant (a second, redundant guard). That exercise exposed four weak spots in the tests themselves (expected amounts computed by the code under test, no direct test of self-pairing, no test of late submissions, and no check that ratings apply exactly once), all fixed.

## Roadmap

Versus-game referees (chess etc.) · 2v2, FFA, tournaments and Duel Mix over the wire · server-side score verification · spectating · KYC and a licensed payment path before any real money.
