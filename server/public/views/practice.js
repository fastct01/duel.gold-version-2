/* Practice: play any game against a local bot inside the Games tab. Runs entirely in the browser: no server, no stake,
   no rating. The bot plays the same seeded challenge (the game pack's bot()), and you race its score live.
   State: S.practice = { game, level, phase: "ready" | "play" | "done", seed, bot, my, result, error } | null.
   app.js keeps the page from re-rendering while a practice game runs (see render) and calls stop() when you leave. */
import { icon } from "../ui.js";
import { cleanRules, nbu } from "./gamecopy.js";

const LEVELS = [
  ["easy", "Easy", 0.35],
  ["normal", "Normal", 0.6],
  ["hard", "Hard", 0.85],
];
const skillOf = (level) => (LEVELS.find((l) => l[0] === level) || LEVELS[1])[2];
const levelName = (level) => (LEVELS.find((l) => l[0] === level) || LEVELS[1])[1];
const BOT = "Practice bot";

/* the running game lives outside S so a render can never serialise or copy it */
let handle = null, ticker = null;
if (new URLSearchParams(location.search).has("test")) window.__practice = { get ctx() { return handle && handle.ctx; } };

/* stop a running practice game (left the page, a match arrived, quit) */
export function stop(S) {
  if (ticker) { clearInterval(ticker); ticker = null; }
  if (handle) { try { handle.abort(); } catch { /* already over */ } handle = null; }
  if (S && S.practice && S.practice.phase === "play") S.practice = null;
}
export const running = () => !!handle;

/* bot score at time t (s) from its [t, score] timeline */
function atTime(tl, t) {
  let pt = 0, ps = 0;
  for (const [tt, s] of tl) {
    if (tt <= t) { pt = tt; ps = s; continue; }
    const f = tt === pt ? 1 : (t - pt) / (tt - pt);
    return ps + (s - ps) * Math.max(0, Math.min(1, f));
  }
  return ps;
}

function runBot(g, seed, skill) {
  const { DG } = window;
  const r = g.bot(seed, skill, DG.util.rng(seed + ":practice-bot"), "full");
  const score = Number(r && r.score);
  if (!Number.isFinite(score)) throw new Error("The practice bot could not play this game.");
  let tl = Array.isArray(r.timeline) ? r.timeline.filter((e) => Array.isArray(e) && Number.isFinite(+e[0]) && Number.isFinite(+e[1])).map((e) => [+e[0], +e[1]]) : [];
  tl.sort((a, b) => a[0] - b[0]);
  if (!tl.length) tl = [[0, 0], [60, score]];
  if (tl[tl.length - 1][1] !== score) tl.push([tl[tl.length - 1][0], score]);
  return { score, timeline: tl };
}

/* ------------------------------------------------------------------ view */
/* Three screens, one primary action each (solid gold): ready → Start practice, playing → none (Quit is quiet), result → Play again.
   Styles: /play/practice.css (.pr-); buttons, chips, labels and the back link come from the kit at the top of /play/gamelobby.css (.gl-). */

export function practiceHTML(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const P = S.practice, g = h.game(P.game);
  const back = `<button type="button" class="gl-back" data-act="pr-back" id="prBack">${icon("arrow")}<span>Game library</span></button>`;
  if (!g) return `<div class="pr-page">${back}<section class="pr-gone"><p class="pr-blurb">This game is not available.</p></section></div>`;

  if (P.phase === "play") {
    return `<div class="pr-page pr-playing"><section class="pr-run" aria-labelledby="prTitle">
      <div class="pr-hud">
        <div class="pr-hud-l"><h1 class="pr-hud-t" id="prTitle">${esc(g.name)}</h1><span class="pr-hud-s">vs ${BOT} · ${levelName(P.level)} · free practice</span></div>
        <span class="pr-status dg-mono" id="prStatus" aria-live="off"></span>
        <button type="button" class="gl-btn quiet pr-quit" data-act="pr-quit" id="prQuit">Quit</button>
      </div>
      <div class="pr-race" aria-label="Live scores">
        <div class="pr-lane you"><span>You</span><div class="pr-track"><i id="prFillYou"></i></div><b class="dg-mono" id="prYou">0</b></div>
        <div class="pr-lane bot"><span>Bot</span><div class="pr-track"><i id="prFillBot"></i></div><b class="dg-mono" id="prBot">0</b></div>
      </div>
      <div id="prStage" class="pr-stage"></div>
    </section></div>`;
  }

  if (P.phase === "done") {
    const r = P.result || {};
    const outcome = r.error ? "stopped" : r.outcome || "draw";
    const label = r.error ? "Practice stopped" : r.outcome === "win" ? "You beat the bot" : r.outcome === "loss" ? "The bot won" : "Draw";
    const fmt = (n) => (n == null ? "–" : esc(g.formatScore ? g.formatScore(n) : n));
    const unit = !g.scoreLabel || /^pts?$/i.test(String(g.scoreLabel).trim()) ? "points" : g.scoreLabel;
    return `<div class="pr-page pr-done"><section class="pr-result ${esc(outcome)}" aria-labelledby="prRes">
      ${back}
      <p class="gl-label pr-kicker">Practice result · ${esc(g.name)}</p>
      <h1 class="pr-outcome" id="prRes" data-test="practice-result">${label}</h1>
      ${r.error ? `<p class="pr-blurb">${esc(r.error)}</p>` : `<div class="pr-score">
        <div class="pr-you"><span class="gl-label">You</span><b class="dg-mono">${fmt(r.my)}</b></div>
        <div class="pr-bot"><span class="gl-label">Bot · ${levelName(P.level)}</span><b class="dg-mono">${fmt(r.bot)}</b></div>
      </div>
      <p class="pr-hint">Free practice: no stake, no rating. Same challenge for both of you (seed #${esc(P.seed)}). Scores in ${esc(unit)}.</p>`}
      ${levelChips(P.level)}
      <div class="pr-actions">
        <button type="button" class="gl-btn primary" data-act="pr-start" id="prAgain">Play again${icon("arrow")}</button>
        <button type="button" class="gl-btn line" data-act="pr-lobby">Create a lobby with ${esc(g.name)}${icon("arrow")}</button>
      </div>
    </section></div>`;
  }

  /* ready */
  const rules = cleanRules(g.rules);
  return `<div class="pr-page pr-ready">
    ${back}
    <div class="pr-grid">
      <header class="pr-intro">
        <p class="gl-label gl-eyebrow">Practice · free, no stake, no rating</p>
        <h1 class="pr-title" id="prTitle">${esc(g.name)}</h1>
        <p class="pr-blurb">${esc(nbu(g.blurb))}</p>
      </header>
      <aside class="pr-side" aria-label="Start practice">
        ${levelChips(P.level)}
        <p class="pr-hint">The bot plays the exact same challenge as you. Beat its score to win. Nothing is saved and no money moves.</p>
        ${P.error ? `<p class="gl-err" role="alert">${esc(P.error)}</p>` : ""}
        <button type="button" class="gl-btn primary block pr-start" data-act="pr-start" id="prStart">Start practice${icon("arrow")}</button>
      </aside>
      ${rules.length ? `<section class="pr-rules" aria-labelledby="prRulesH"><h2 class="gl-label" id="prRulesH">How to play</h2><ol class="gl-rules">${rules.map((x) => `<li>${esc(nbu(x))}</li>`).join("")}</ol></section>` : ""}
    </div>
  </div>`;
}

function levelChips(level) {
  return `<div class="pr-levels"><span class="gl-label" id="prLevelL">Bot level</span><div class="gl-seg" role="group" aria-labelledby="prLevelL">${LEVELS.map(([id, name]) =>
    `<button type="button" class="gl-chip" data-act="pr-level" data-level="${id}" aria-pressed="${level === id}">${name}</button>`).join("")}</div></div>`;
}

/* ------------------------------------------------------------------ play */

function start(app) {
  const { S, h } = app;
  const { DG } = window;
  const P = S.practice;
  const g = DG.getGame(P.game);
  stop(null);
  if (!g || typeof g.bot !== "function") { P.phase = "ready"; P.error = "This game cannot be practised yet."; return app.render(true); }
  const seed = Math.floor(Math.random() * 2 ** 31);
  let bot;
  try { bot = runBot(g, seed, skillOf(P.level)); }
  catch (e) { P.phase = "ready"; P.error = e.message; return app.render(true); }
  Object.assign(P, { phase: "play", seed, bot, my: 0, result: null, error: "" });
  app.render(true);
  window.scrollTo(0, 0);

  const $ = (s) => document.querySelector(s);
  const fmt = (n) => (g.formatScore ? g.formatScore(Math.round(n * 100) / 100) : String(Math.round(n)));
  /* the bot's clock starts with your first tap or key press, so a "tap to start" screen doesn't hand it a head start */
  let botFrom = null;
  const go = () => { if (botFrom == null && handle && handle.ctx) botFrom = handle.ctx.now(); };
  const bar = () => {
    if (botFrom == null && P.my > 0) go();
    const t = botFrom == null || !handle || !handle.ctx ? 0 : (handle.ctx.now() - botFrom) / 1000;
    const b = atTime(bot.timeline, t), top = Math.max(1, P.my, b) * 1.1;
    const set = (id, v) => { const el = $(id); if (el) el.style.width = Math.max(0, Math.min(100, (v / top) * 100)) + "%"; };
    set("#prFillYou", P.my); set("#prFillBot", b);
    const y = $("#prYou"), o = $("#prBot");
    if (y) y.textContent = fmt(P.my); if (o) o.textContent = fmt(b);
  };
  const finish = (res, error) => {
    if (S.practice !== P) return;
    if (ticker) { clearInterval(ticker); ticker = null; }
    handle = null;
    const my = Number(res && res.score);
    P.phase = "done";
    P.result = error ? { error } : !Number.isFinite(my) ? { error: "The game did not report a score." }
      : { my, bot: bot.score, outcome: my > bot.score ? "win" : my < bot.score ? "loss" : "draw" };
    app.render(true);
    window.scrollTo(0, 0);
  };
  handle = DG.start(g, {
    root: $("#prStage"), seed, mode: "full", format: "1v1", speed: 1,
    me: { name: S.me ? S.me.displayName : "You", rating: 1200 },
    opponents: [{ name: BOT, rating: Math.round(800 + skillOf(P.level) * 1400), skill: skillOf(P.level) }],
    onStatus: (t) => { const el = $("#prStatus"); if (el) el.textContent = t; },
    onProgress: (s) => { const n = Number(s); if (Number.isFinite(n)) { P.my = n; bar(); } },
    onEnd: (r) => finish(r),
    onError: (e) => { console.error("[practice]", e); if (handle) { try { handle.abort(); } catch { /* over */ } } finish(null, "The game hit a problem, so practice stopped."); },
  });
  const stageEl = $("#prStage");
  stageEl.addEventListener("pointerdown", go);
  handle.ctx.onKey(go);
  ticker = setInterval(bar, 200);
  bar();
}

/* ------------------------------------------------------------------ actions */

export const actions = {
  /* "Try out" from a game's description: open the practice screen in the Games tab */
  "try-game"(el, app) {
    const { S } = app;
    stop(S);
    S.practice = { game: el.dataset.game || S.pick.game, level: S.ui.prLevel || "normal", phase: "ready", error: "" };
    app.go("games");
  },
  "pr-level"(el, app) {
    const { S } = app;
    S.ui.prLevel = el.dataset.level;
    if (S.practice) S.practice.level = el.dataset.level;
    app.render(true);
  },
  "pr-start"(el, app) { if (app.S.practice) start(app); },
  "pr-quit"(el, app) {
    const { S } = app;
    const game = S.practice && S.practice.game;
    stop(S);
    S.practice = game ? { game, level: S.ui.prLevel || "normal", phase: "ready", error: "" } : null;
    app.render(true);
  },
  "pr-back"(el, app) { stop(app.S); app.S.practice = null; app.render(true); window.scrollTo(0, 0); },
  "pr-lobby"(el, app) {
    const { S } = app;
    if (S.practice) S.pick.game = S.practice.game;
    stop(S); S.practice = null; S.ui.lbFocus = true; S.ui.lbScroll = undefined; // re-centre the picker on this game
    app.go("lobby");
  },
};
