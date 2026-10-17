# PlayVault — PLATFORM spec (for the platform agent; read SPEC.md first)

You build everything that is not a game: the page template, the lobby, matchmaking, the match runner for every
format, results/payouts/ratings, tournaments, Duel Mix, Watch, social, profile, economy, responsible-play controls,
persistence. Games plug in through `window.DG.games` (see SPEC.md). You own `src/index.html` and any
`src/core/*` files you create **except** `sdk.js` and `base.css` (read-only; link base.css and extend with your own
`src/core/app.css`).

## Page template rules (the page ships as a claude.ai Artifact)
- `src/index.html` has NO `<!doctype>`, `<html>`, `<head>`, `<body>` tags. Start with `<title>PlayVault</title>`,
  then Google Fonts `<link>` (Big Shoulders Display 600/800/900, Barlow 400/500/600/700, JetBrains Mono 500/700),
  then `<link rel="stylesheet" href="core/base.css">`, your css links, markup, then scripts in this order:
  ```html
  <script src="https://cdnjs.cloudflare.com/ajax/libs/chess.js/0.10.3/chess.min.js"></script>
  <script src="core/sdk.js"></script>
  <script src="games/strategy.js"></script>
  <script src="games/brain.js"></script>
  <script src="games/reflex.js"></script>
  <script src="games/builder.js"></script>
  <script src="games/social.js"></script>
  <script src="core/app.js"></script>     <!-- your code; split into more core/*.js files if you like -->
  ```
  Exactly this tag shape (`<script src="..."></script>`, `<link rel="stylesheet" href="...">`) — `build.py` inlines them.
  Never write a literal `</script` inside JS (use `<\/script`).
- The host adds a skeleton with a light off-white body; set `html,body{background:var(--ink)}` (base.css does) and
  keep the host's `:root` top/bottom safe-area padding. Sticky header uses `top: env(safe-area-inset-top,0px)`; a fixed
  bottom nav adds `env(safe-area-inset-bottom,0px)` to its padding. Full-screen overlays: `position:fixed; inset:0` with
  their own safe-area padding.
- Sandbox: `alert/confirm/prompt` do nothing → build confirmations in the page. No `window.open`, no downloads, no
  print, no network except the chess.js CDN script and Google Fonts. Only `#token` hashes survive in the URL.
- `localStorage` can throw or be empty: wrap every access in try/catch; the app must work fully without it.
- Must work at 360 px width (no horizontal page scroll; 16 px side gutter) up to wide desktop. Visible focus states,
  `prefers-reduced-motion` respected, all controls have stable `id`s or labels.
- Game packs are optional at runtime: if a pack throws during registration or a game throws during play, the app
  must keep working (catch, show a clear message, refund the stake, log to console).

## Design direction
Continue the existing PlayVault identity: dark indigo "arena" ground, gold = you/money/primary action, coral red =
rival, blue = ally. Big Shoulders Display for display type (uppercase, tight), Barlow for body, JetBrains Mono for all
numbers. Deliberate, sporty, not a casino: no slot-machine glitter, no emoji as section markers. Cards only where
something is a separate object. Numbers use tabular figures. Plain, direct copy ("Find opponent", "Rematch · 250").

## Information architecture
Top bar (sticky): logo `DUEL.gold`, wallet pills **GOLD**, **DUEL POINTS**, **CASH** (€0.00, locked icon), overall
rating. A clear "Demo · no real money" tag. Primary nav (tabs on desktop, fixed bottom bar on phones):
**Home · Games · Watch · Tournaments · Social · Profile** (+ Settings reachable from Profile/top bar).

### Home
- **Duel now** panel (the hero): pick **Game** (Any game / Favorites / each category / Surprise me, plus a searchable
  specific-game select), **Format** (1v1, 2v2, FFA, Tournament, Duel Mix — disable combinations a game can't do and
  say why), **Stake** (Free, 50, 100, 250, 500, 1,000, Custom input 10…balance; disabled above balance or when
  staking is blocked by limits/cool-off/age), then the big **Find opponent** button. Show pot/fee math under it
  ("Pot 500 · winner receives 450 after the 10% fee").
- **Live now**: game list with fluctuating "playing" counts; click → preselect that game.
- **Duel Mix** feature card (3 random challenges, one opponent).
- Featured tournament card with countdown and Join.
- Recent results feed (simulated, labelled as such).
- Daily bonus claim (+500 gold once per calendar day) and "Top up demo gold" when gold < 100.

### Games (library)
Search box, category filter chips, Favorites filter, sort (popular / skill-heavy / A–Z). Card per game per the concept:
category · formats · duration, name, blurb, **Skill** and **Luck** 10-segment meters, "Cash-eligible" or "Gold only"
badge, playing count, your rating in that game, star (favorite) toggle, **Duel** button and **How to play** (rules
panel). Clicking Duel opens the Duel-now setup with that game preselected (as a sheet/modal).

### Match flow (overlay, full screen)
1. **Matchmaking**: radar animation, "Finding opponent · <game> · <stake> · rating ± 60" (1–2 s). Deduct stakes into
   escrow at this point.
2. **Versus card**: participants with ratings (1v1: you vs rival; 2v2: you + ally vs two rivals; FFA: 4 players),
   seed shown ("Seed #481023 · identical for every player"), stake/pot, then a **Rules + Start** card (the game's
   rules bullets) so the human is ready before a timed game starts. Auto-start after 10 s if untouched is fine.
3. **Playing**: header bar with participants, `ctx.setStatus` text in the centre, a **live race panel** for race
   games (your running score from `ctx.progress` vs each bot's timeline evaluated at `ctx.now()/1000`), and a
   **Forfeit** button with an in-page confirm. Forfeit = loss (stake lost), abort the ctx.
4. **Result**: Victory/Defeat/Draw (or placement for FFA), scoreline, payout, rating change (Elo, K=24; 2v2 uses team
   average; FFA pairwise), duel points earned, the game's `detail` HTML, **Rematch** (same game/format/stake, new seed,
   same opponent) and **Back**. Race games show the bot score(s); versus games use the game's scores.
Opponent generation: names from a list of ~40 international first names, rating = your game rating ± 60,
`skill = DG.util.skillFromRating(rating)`. Bots for race opponents: `game.bot(seed, skill, DG.util.rng(seed + ':' + name), mode)`.

### Formats (the runner)
- **1v1**: race → compare your score with the bot's; versus → the game decides. Win pays `2 × stake × 0.9`, draw refunds.
- **2v2** (race games only): you + ally bot vs two rival bots; team score = sum. Each player staked; winning team
  members each receive `2 × stake × 0.9`.
- **FFA** (race only): 4 players each staking; net pot = `4 × stake × 0.9`; 1st 70%, 2nd 30%; ties split.
- **Tournament**: 8-player single-elimination bracket (Quarter → Semi → Final). You play each of your rounds (race or
  versus); other bracket matches are simulated (race: bot vs bot scores; versus: Elo win probability). Entry fee =
  stake (or free); prize pool = entries × fee × 0.9 (+ house-added prize for featured tournaments); champion 60%,
  runner-up 25%, semi-finalists 7.5% each. Show the bracket updating between rounds; losing ends your run with your
  prize. Tournament points added to profile.
- **Duel Mix**: 3 rounds vs the same opponent, each a different race game that supports 'mix' (prefer different
  categories), run with `mode:'mix'`. Round win = 3 pts, draw = 1. Show the running table like
  `ROUND · YOU · RIVAL` and a final total. Stake paid once; win pays 1.8×.
- Game-format compatibility comes from each game's `formats`. "Any game"/"Surprise me" choose randomly among games
  compatible with the chosen format and category.

### Watch
List of live featured matches (bot vs bot) across games with players, ratings and pot. Opening one: if the game has
`spectate`, run it in a spectator overlay (`ctx.players` set, no input expected, `ctx.opponents` = [players[1]], and
`ctx.me` = players[0]); otherwise show a live race using both bots' timelines and reveal the winner. Also a
"Leaderboard" of top players (simulated) per game.

### Tournaments
Daily Championship (free entry, 5,000 gold house prize, resets at local midnight — countdown), Weekend Championship
(entry 250, +20,000 added), High Stakes (entry 1,000), World Championship (seasonal, needs Gold division; locked
state explained), per-game quick 8-player tournaments. Each shows game, entry, prize pool, entrants, countdown, your
best result. Plus a season leaderboard (tournament points).

### Social
Friends (8 seeded bot friends: name, rating, status Online / In a duel / Offline, favourite game) — **Challenge**
opens duel setup against that friend (their name/rating as the opponent). Add a friend by name (in-page form).
Clubs: join one of 4 clubs; weekly club leaderboard using duel points (yours counts). Activity feed of friends
(simulated).

### Profile
Tiles per the concept: Player rating, Win rate, Gold, Tournament points, Rank (#, computed against a simulated
population of ~5,000 players from rating), Games mastered (N / total, mastered = rating ≥ 1400 or ≥ 5 wins in that
game), Current streak (and best). Per-game table (rating, division Bronze<1250≤Silver<1400≤Gold<1550≤Diamond<1700≤
Master, W-L-D, best score). Match history (last 50, filterable by game). Achievements (8–12, e.g. First win,
Hat-trick streak, Mix master, Tournament champion, Polymath = 10 different games, High roller = win a 1,000 duel,
Comeback, Beat a 1600+ player). Duel-points **shop**: cosmetic profile frames/titles/name colours bought with DP.

### Settings & responsible play
- Age gate on first visit (in-page modal): "PlayVault is for players aged 18+ … demo gold has no cash value" →
  "I am 18 or older" / "I am under 18" (under 18 → free play only; stakes disabled, explained).
- Daily loss limit (gold; off/1,000/2,500/5,000 or custom), session reminder every 15/30/60 min (in-page toast with
  time played and net result today), cool-off (24 h / 7 days: staked play blocked, free play allowed), today's stats.
- Cash wallet panel: explains cash play is not available — it requires age and identity verification (KYC), UK-only
  location checks, a licensed payment provider and legal review; only cash-eligible (skill-dominant) games would
  qualify. No fake deposit flow.
- Reset demo data (in-page confirm). Fairness page ("How PlayVault works": identical seeds, skill/luck meters,
  rating-based matchmaking, 10% fee, server verification would be required in production).

### State & persistence
One state object, versioned (`duelgold.v2`), saved after every change (try/catch). Includes gold, dp, cashLocked,
tournament points, per-game rating + W/L/D + best, history, favourites, friends, club, achievements, cosmetics,
limits/cool-off/age, daily-bonus date, today's stats (date-keyed). Corrupt/missing → defaults.

## Testing (required)
Write `test/test_platform.py` using `test/dglib.py`. Build a test page with the sample games:
`python3 build.py --test-games _samples.js` → `dist/test.html` (samples = race "sample-tap", versus "sample-nim").
Your code must work with ANY set of registered games (the real packs arrive later). Test, at 1280 px and 360 px:
age gate; each tab renders; no horizontal scroll at 360 px; Duel now with every format (1v1 race, 1v1 versus,
2v2, FFA, tournament to the end — win and lose paths, Duel Mix with 3 rounds) using the samples (click the tap
button / take stones via UI); stake escrow, payouts and rating changes are arithmetically correct (assert numbers);
forfeit path; rematch; custom stake validation; daily bonus once per day; loss limit and cool-off block staked play;
under-18 path; favourites; friend challenge; club join; shop purchase; Watch race + (if any game had spectate) spectate;
localStorage disabled (simulate by `page.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})")`)
still works; a game that throws in `play` is handled with refund (register a throwing test game via
`page.evaluate` after load, or `add_init_script`); zero console errors. Screenshot every tab at 360 and 1280 into
`test/shots/platform-*.png` and look at them. Fix what you find.

Also expose `window.DGApp` with a few test hooks (e.g. `DGApp.state()`, `DGApp.reset()`, `DGApp.setSpeed(n)` that sets
the ctx speed for subsequent matches so tests of timed games run fast, `DGApp.startMatch({game, format, stake})`).

## Final report
What you built (screens, runner semantics, economy rules), how you tested it and results, known limitations, and
anything the game packs must do/avoid for smooth integration. Under ~700 words.
