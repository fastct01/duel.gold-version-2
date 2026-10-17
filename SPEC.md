# PlayVault — build spec (read fully before writing code)

PlayVault is a PvP skill-game arena: players pick a game, a format and a stake (demo **gold**), get matched
with an opponent of similar rating, play the same seeded challenge, and the winner takes the pot minus a 10% fee.
This build is a **front-end prototype**: opponents are bots, balances are demo gold, there is no server.
It will ship as ONE self-contained HTML page (a claude.ai Artifact) produced by `build.py`.

## Project layout and ownership

```
duel-gold/
  SPEC.md                  this file (read-only)
  build.py                 inlines src into dist/ (owned by lead)
  src/index.html           platform page template (PLATFORM agent)
  src/core/sdk.js          window.DG registry + match context (lead; read-only for everyone else)
  src/core/base.css        design tokens + dg-* classes (lead; read-only)
  src/core/*.js|*.css      platform code (PLATFORM agent)
  src/games/_samples.js    reference games (read-only, not shipped)
  src/games/strategy.js    Pack A
  src/games/brain.js       Pack B
  src/games/reflex.js      Pack C
  src/games/builder.js     Pack D
  src/games/social.js      Pack E
  test/harness.html        loads sdk + game files and runs one game (read-only)
  test/dglib.py            Playwright helpers (read-only)
  test/test_<name>.py      each agent's own tests
  vendor/chess.js          local copy of chess.js 0.10.3 used ONLY by tests (CDN is routed to it)
```

**Only edit files you own.** If you believe sdk.js/base.css/harness need a change, do not edit them — work around it
and describe the needed change in your final report.

Runtime environment of the shipped page: a sandboxed iframe. No network except the one CDN script below,
no `alert/confirm/prompt` (they silently fail), no downloads, no `window.open`, no service workers.
`localStorage` may throw — games must not use it at all (the platform owns persistence).
The ONLY external library available is chess.js **0.10.3** loaded by the page from
`https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js` as global `Chess` (0.10.x API:
`new Chess()`, `.moves({verbose:true})`, `.move({from,to,promotion})`, `.undo()`, `.in_checkmate()`,
`.in_draw()`, `.in_stalemate()`, `.in_threefold_repetition()`, `.insufficient_material()`, `.game_over()`,
`.turn()`, `.board()`, `.fen()`, `.get(square)`, `.in_check()`). Every other piece of code is written by us.

## The game contract

A pack file is an IIFE that calls `DG.registerGame(def)` once per game. `window.DG` already exists.

```js
DG.registerGame({
  id: 'sudoku',               // unique, lowercase, [a-z0-9-]
  name: 'Sudoku Sprint',      // display name (original names; no trademarks like "Connections", "Clash", "Monopoly")
  category: 'puzzle',         // one of DG.CATEGORIES ids: strategy puzzle reflex precision numbers builder battle cards dice knowledge word social
  kind: 'race' | 'versus',
  formats: [...],             // race: any of '1v1','2v2','ffa','tournament','mix'  | versus: only '1v1','tournament'
  skill: 0-10, luck: 0-10,    // honest rating of how much skill vs luck decides the winner (they need not sum to 10)
  cashEligible: true|false,   // true only for deterministic, skill-dominant games (luck <= 2). Dice/card games with hidden random deals: false
  duration: '90 s',           // human-readable typical length
  blurb: 'One sentence.',     // shown on the game card
  rules: ['Short rule 1', 'Short rule 2', ...],  // 3-6 bullet rules for the How-to-play panel
  scoreLabel: 'points',       // unit shown next to race scores
  formatScore: n => ...,      // optional; how to display a score (e.g. '2:31')
  pack: 'brain',              // your pack name
  play(ctx) { ... },          // REQUIRED — renders into ctx.root and eventually calls ctx.end(result) exactly once
  bot(seed, skill, rng, mode) { ... },   // REQUIRED for race games (see below)
  spectate(ctx) { ... },      // OPTIONAL — bot-vs-bot visual for the Watch tab (see below)
});
```

### kind: 'race'
Both sides face the **identical** challenge generated from `ctx.seed` (e.g. same sudoku, same board, same questions,
same zombie waves). The human plays via `play(ctx)` and ends with:
`ctx.end({ score: Number, detail: '<optional small HTML summary>' })`. **Higher score is always better.**
If the challenge is time-based (solve fastest), convert to points where faster = more (e.g. base + time bonus).

Opponents are simulated by `bot(seed, skill, rng, mode)` which must return
`{ score: Number, timeline: [[secondsElapsed, scoreSoFar], ...] }` — ascending time, last entry == score.
- `seed` is the same seed the human got; `skill` in [0.05, 0.98]; `rng` is a seeded RNG private to that bot;
  `mode` is 'full' or 'mix'. Must be deterministic for the same arguments and fast (< 50 ms, no DOM).
- **Calibrate**: skill 0.5 ≈ a decent casual human playing properly; skill 0.9 ≈ a very strong human; 0.1 ≈ a weak
  beginner. A human who plays well must be able to beat a 0.5 bot most of the time, and a 0.9 bot sometimes.
  Where feasible, derive the bot score from the actual seeded content (e.g. bot simulates solving the actual puzzle
  with skill-dependent speed/mistakes) rather than a pure random number.
- The platform uses the bot for 1v1 rivals, 2v2 teammates/rivals, FFA fields and tournament brackets.

Race games MUST support `mode === 'mix'`: a short variant (≤ 45 s) used in Duel Mix, same scoring spirit.
Call `ctx.progress(scoreSoFar)` whenever the human's running score changes (the platform shows a live race bar).

### kind: 'versus'
Turn-based or real-time head-to-head vs `ctx.opponents[0]` (`{name, rating, skill}`) which your own AI plays,
with strength scaled by `skill` (0.05 = weak beginner, 0.98 = strong). Must be beatable at 0.5 by a decent human.
End with `ctx.end({ outcome: 'win'|'loss'|'draw', myScore: Number, oppScore: Number, detail: '<optional HTML>' })`
(from the human's perspective; scores are whatever is natural: points, pieces, discs, 1/0).
The AI must never freeze the UI: keep each AI move under ~150 ms on a laptop (use iterative deepening with a time
budget, or chunk work with `ctx.timeout`). Add a short "thinking" delay (300–900 ms) so moves are visible.

### spectate(ctx) (optional, used by the Watch tab)
`ctx.players = [{name, rating, skill}, {name, rating, skill}]`. Render bot-vs-bot play visibly at watchable pace,
then `ctx.end({ winner: 0|1|-1, scores: [a, b] })` (-1 = draw). Required for Pack A games; optional elsewhere.

### The match context `ctx`
| member | meaning |
|---|---|
| `ctx.root` | empty `<div>` to render into (width 320–860 px) |
| `ctx.seed`, `ctx.rng()` | seed and a seeded RNG. **All randomness in content generation must come from `ctx.rng` / the seed** so both sides get identical content. |
| `ctx.mode` | `'full'` or `'mix'` |
| `ctx.format` | `'1v1'`,`'2v2'`,`'ffa'`,`'tournament'`,`'mix'` (informational) |
| `ctx.me` | `{name, rating}` |
| `ctx.opponents` | array of `{name, rating, skill}` (versus: exactly one) |
| `ctx.now()` | ms since the match started, **scaled by test speed**. Use this for ALL game time (clocks, reaction times, physics dt). Never use `Date.now()` / raw `performance.now()` for game logic. |
| `ctx.timeout(fn,ms)`, `ctx.interval(fn,ms)`, `ctx.raf(fn)`, `ctx.clearTimeout(id)`, `ctx.clearInterval(id)` | timers that are scaled by speed and auto-cancelled when the match ends/aborts. Use ONLY these. `raf` is one-shot: call it again each frame; its callback receives `ctx.now()`. |
| `ctx.onKey(fn)` | keydown listener auto-removed at the end |
| `ctx.onCleanup(fn)` | runs once when the match ends or is aborted (disconnect ResizeObservers etc.) |
| `ctx.cancelRaf(id)` | cancel a pending `ctx.raf` |
| `ctx.speed` | test time multiplier (1 in production) |
| `ctx.setStatus(text)` | short text in the top bar centre: clock, turn, round (update at least every second in timed games) |
| `ctx.progress(score)` | race only: running score |
| `ctx.end(result)` | finish (idempotent). After it (or after a forfeit) `ctx.signal.ended === true` — stop everything, ignore input |
| `ctx.signal.ended` | check it in async code/listeners |
| `ctx.reducedMotion` | true if the user prefers reduced motion — shorten/skip decorative animation |
| `ctx.test` | **you set this**: an object of test-only hooks (e.g. `{ solve(){…}, state(){…}, autoplay(){…} }`) that lets automated tests drive the game to an end quickly. Never reachable from the UI. |

Event listeners you add to elements inside `ctx.root` die with the DOM; listeners on `window`/`document` must be
removed when `ctx.signal.ended` (prefer `ctx.onKey`). The platform may abort a match at any time (forfeit) —
after that nothing may keep running (no orphan rAF/timers/sounds) and `ctx.end` must not be called.

## Look and feel
- Load nothing extra; fonts/tokens come from the page. Use tokens from `src/core/base.css`
  (`--ink --panel --panel-2 --panel-3 --line --fg --muted --gold --gold-deep --on-gold --rival --ally --good --warn --bad
  --f-display --f-body --f-mono --r-sm --r-md --r-lg`) and shared classes (`dg-btn`, `dg-btn primary`, `dg-chip`,
  `dg-box`, `dg-stat`, `dg-eyebrow`, `dg-h`, `dg-mono`, `dg-muted`, `dg-note`, `dg-row`, `dg-stack`, `dg-table`, `dg-good/bad/gold/rival/ally`).
- The human is always **gold**, opponents **rival** red, teammates **ally** blue.
- Inject your CSS once per game with `DG.css('<gameid>', cssText)` and namespace every class `.g-<gameid>-…`.
- It is a dark arena look. Canvas games: handle `devicePixelRatio`, size the canvas to the container width
  (max 860 px), keep aspect ratio, and redraw on container resize (ResizeObserver; disconnect on end).
- Must work at **360 px wide** (phone) and on desktop. No horizontal page scroll. Touch + mouse via Pointer Events
  (`touch-action: none` on drag/play surfaces), keyboard as a bonus. Tap targets ≥ 36 px.
- Put `data-test="…"` attributes on the key interactive elements to make tests robust.
- Keep each game's first screen self-explanatory: a one-line instruction and a clear start (or immediate start).
- No emoji as decoration. Card suits (♠♥♦♣) and dice pips are content, fine.

## Quality bar
- Correct rules, no dead ends, no way to get stuck (every state leads to `ctx.end`), timeouts always resolve.
- Deterministic content for a given seed; bots deterministic for (seed, skill, rng-seed, mode).
- No console errors. No memory leaks after end/abort.
- Plain, clear copy: short sentences, active voice, name buttons by what they do.

## Testing you must do (Playwright, Python, headless Chromium is installed)
Use `test/dglib.py` (`browser_page`, `open_harness`, `wait_result`, `errors`). Harness URL params: `files`, `game`,
`mode`, `format`, `seed`, `skill`, `speed` (speed scales ctx time: use 4–20 to finish timed games fast).
`page.evaluate("__run({game:'x', mode:'mix', seed:5, skill:0.3, speed:8})")` starts a match; `window.__result` is
set on end; `window.__handle.ctx.test` exposes your hooks; `window.__handle.abort()` simulates a forfeit;
`__spectate({game:'x', speed:6})` runs a spectate. Write `test/test_<yourpack>.py` that, for EVERY game:
1. plays to completion via real UI clicks/keys where practical (and via ctx.test hooks otherwise), in 'full' and
   (race) 'mix' mode, at 400 px and 1280 px width; asserts the result shape and that `errors(page)` is empty;
2. aborts a match mid-play and checks nothing keeps running (no further errors, no ctx.end call after abort);
3. race: checks bot determinism and prints bot score distributions for skills 0.1/0.5/0.9 over 20 seeds next to
   what an optimal/typical human gets, to prove calibration;
4. versus: plays several full AI-vs-random or AI-vs-AI games through `ctx.test` to prove the rules engine never
   hangs and always terminates;
5. checks `document.documentElement.scrollWidth <= window.innerWidth` at 360 px;
6. takes one screenshot per game at 400 px and 1280 px into `test/shots/<gameid>-{400,1280}.png` and LOOK at them
   (Read the PNG) to verify it renders sensibly.
Fix everything you find. Run your test file until it passes.

## Final report (your last message)
Return: games built (id, kind, formats, one-line mechanics), how each bot/AI works and its calibration numbers,
what you tested and the results, known limitations or bugs you could not fix, and any SDK change requests.
Keep it factual and concise (under ~600 words).
