/* One game's own lobby page (#game/<id>): what the game is, every way to play it, the settings, and Create lobby.
   Opened from a card in the Game library (app.go("game", id) sets S.ui.gameId and S.pick.game). Styles: /play/gamelobby.css (.gl- prefix).
   The stake picker, terms line and Create button reuse the lobby page's helpers, so both pages behave the same.
   Everything shown is real: the game pack's text (or gamecopy.js), S.cfg, the player's own rating, and S.live. */
import { icon, avatar } from "../ui.js";
import { readFavs, catLabel, nbUnits, ratingFor, stakeChips, calcHTML, noticesHTML, openLobbyCard } from "./lobby.js";
import { copyFor } from "./gamecopy.js";
import { art, artBg } from "../gameart.js";

/* ------------------------------------------------------------------ small helpers */

/* online matches always play the full game: drop Duel Mix asides like "(Duel Mix: 6×6, 45 s)" or "(3 in Duel Mix)" */
const noMix = (s) => String(s || "").replace(/\s*\([^)]*\bmix\b[^)]*\)/gi, "").trim();
const mixOnly = (s) => /^\s*(?:in\s+)?(?:duel\s+)?mix\b/i.test(String(s || ""));
const cleanRules = (rules) => (Array.isArray(rules) ? rules : []).filter((r) => r && !mixOnly(r)).map(noMix).filter(Boolean);
const list = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string" && x.trim()) : []);

const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/* 1800000 → "30 minutes", 5400000 → "1 hour 30 minutes" */
function longTime(ms) {
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 60) return plural(s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, "minute");
  const hr = Math.floor(m / 60), r = m % 60;
  return plural(hr, "hour") + (r ? ` ${plural(r, "minute")}` : "");
}
/* 360 → "6 min", 95 → "1 min 35 s", 45 → "45 s" */
function shortTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/* the game's text: the written guide if there is one, otherwise the game pack's own blurb and rules */
function textFor(g) {
  const c = copyFor(g.id);
  const pack = window.DG && window.DG.getGame ? window.DG.getGame(g.id) : null;
  const rules = cleanRules((g.rules && g.rules.length) ? g.rules : pack && pack.rules);
  const blurb = g.blurb || (pack && pack.blurb) || "";
  const length = (c && c.length) || noMix(g.duration || (pack && pack.duration) || "");
  if (!c) return { tagline: blurb, overview: "", goal: "", scoring: [], controls: [], tips: [], rules, length };
  const t = {
    tagline: c.tagline || blurb, overview: c.overview || (c.tagline ? blurb : ""), goal: c.goal || "",
    scoring: list(c.scoring), controls: list(c.controls), tips: list(c.tips), length,
  };
  /* a guide without any of the detail sections still gets the pack's rules */
  t.rules = t.goal || t.scoring.length || t.controls.length || t.tips.length ? [] : rules;
  return t;
}

const isBanned = (S, h) => !!(S.me && S.me.queueBanUntil && Number(S.me.queueBanUntil) > h.now());

/* ------------------------------------------------------------------ pieces */

function liveHTML(ctx, g) {
  const { S } = ctx; const L = S.live;
  if (!L || typeof L !== "object") return "";
  const out = [];
  if (Number.isFinite(L.online)) out.push(`<span class="gl-livei"><span class="lb-pulse sm" aria-hidden="true"></span><b class="dg-mono">${L.online}</b> ${L.online === 1 ? "player" : "players"} online</span>`);
  return out.length ? `<p class="gl-live" aria-label="Live numbers">${out.join("")}</p>` : "";
}

function hero(ctx, g, t) {
  const { S, h } = ctx; const { esc } = h;
  /* the game's illustration from the lobby cards: a big faded banner behind the title (decorative; nothing renders when a game has no art) */
  const A = art(g.id);
  const tagline = t.tagline || (A ? A.tagline : "");
  const fav = readFavs().includes(g.id), r = ratingFor(S, g.id);
  const games = r ? (r.wins || 0) + (r.losses || 0) + (r.draws || 0) : 0;
  const stat = (ico, k, v, sub = "") => `<div class="gl-stat"><span class="gl-stat-k">${icon(ico)}${k}</span><b class="gl-stat-v">${v}</b>${sub ? `<span class="gl-stat-s">${sub}</span>` : ""}</div>`;
  return `<section class="lb-card gl-hero${A ? " has-art" : ""}"${A ? ` style="--ga:${A.accent}"` : ""} aria-labelledby="glName">
    ${artBg(g.id, "gl-art")}
    <div class="gl-hero-top">
      <p class="lb-eyebrow gl-eyebrow">${esc(catLabel(g.category))}${t.length ? ` · ${esc(t.length)}` : ""}</p>
      <button type="button" class="lb-fav gl-fav" data-act="lb-fav" data-game="${esc(g.id)}" aria-pressed="${fav}" aria-label="${fav ? "Remove " : "Add "}${esc(g.name)} ${fav ? "from" : "to"} favourites">${icon("star")}</button>
    </div>
    <h2 class="lb-title gl-name" id="glName">${esc(g.name)}</h2>
    ${tagline ? `<p class="gl-tagline">${esc(nbUnits(tagline))}</p>` : ""}
    <div class="gl-stats">
      <div class="gl-stat gl-stat-m"><div class="lb-meters">${h.meter("Skill", g.skill, "skill")}${h.meter("Luck", g.luck, "luck")}</div></div>
      ${stat("trophy", "Your rating", r ? `<span class="dg-mono">${esc(r.rating)}</span>` : "Unrated", r && games ? esc(`${r.wins || 0}W ${r.losses || 0}L ${r.draws || 0}D`) : r ? "" : "Play a match to get one")}
      ${g.maxSeconds ? stat("clock", "Length", "Up to " + esc(shortTime(g.maxSeconds)), "Full game") : ""}
      ${g.scoreLabel ? stat("bolt", "Scored by", esc(catLabel(g.scoreLabel)), "Higher wins") : ""}
    </div>
    <div id="glLive">${liveHTML(ctx, g)}</div>
  </section>`;
}

function aboutCard(ctx, g, t) {
  const { esc } = ctx.h;
  const ul = (items) => `<ul class="gl-list">${items.map((x) => `<li>${esc(nbUnits(x))}</li>`).join("")}</ul>`;
  const block = (ico, title, items) => (items.length ? `<div class="gl-block"><h4 class="gl-h4">${icon(ico)}${title}</h4>${ul(items)}</div>` : "");
  const blocks = [block("trophy", "Scoring", t.scoring), block("games", "Controls", t.controls), block("star", "Tips", t.tips)].filter(Boolean);
  return `<section class="lb-card gl-about" aria-labelledby="glAbout">
    <header class="gl-sec-head"><p class="lb-eyebrow">How it plays</p><h3 class="gl-h3" id="glAbout">About the game</h3></header>
    ${t.overview ? `<p class="gl-overview">${esc(nbUnits(t.overview))}</p>` : ""}
    ${t.goal ? `<div class="gl-goal"><span class="gl-goal-ico">${icon("check")}</span><div><b>Goal</b><p>${esc(nbUnits(t.goal))}</p></div></div>` : ""}
    ${t.rules.length ? `<div class="gl-block"><h4 class="gl-h4">${icon("shield")}How to play</h4><ol class="gl-rules">${t.rules.map((x) => `<li>${esc(nbUnits(x))}</li>`).join("")}</ol></div>` : ""}
    ${blocks.length ? `<div class="gl-blocks n${blocks.length}">${blocks.join("")}</div>` : ""}
    ${!t.overview && !t.goal && !t.rules.length && !blocks.length ? `<p class="lb-empty sm">There is no written guide for this game yet. Practice against the bot to learn it.</p>` : ""}
    <p class="gl-fair">${icon("users")}<span>Both players get the exact same seeded challenge, so the better play wins.</span></p>
  </section>`;
}

/* the terms of every online match of this game */
function rulesCard(ctx, g) {
  const { S, h } = ctx; const { esc, eth } = h; const cfg = S.cfg;
  const fee = (cfg.feeBps || 0) / 100;
  const row = (ico, k, v) => `<div class="gl-term"><dt>${icon(ico)}${k}</dt><dd>${v}</dd></div>`;
  return `<section class="lb-card gl-terms" aria-labelledby="glTerms">
    <header class="gl-sec-head"><p class="lb-eyebrow">Settings for every match</p><h3 class="gl-h3" id="glTerms">Match rules</h3></header>
    <dl class="gl-termlist">
      ${row("wallet", "Stake", `Free, or <b class="dg-mono">${eth(cfg.stake.min)}</b> to <b class="dg-mono">${eth(cfg.stake.max)}</b> ${esc(h.sym())} each`)}
      ${row("trophy", "Winner", `Higher score takes the pot, minus a <b>${fee}%</b> fee on staked matches`)}
      ${row("check", "Rated", "Yes. Free and staked matches both change your rating")}
      ${row("dice", "Challenge", "Same seeded challenge for both players")}
      ${g.maxSeconds ? row("clock", "Length", `Up to <b>${esc(shortTime(g.maxSeconds))}</b>, full version of the game`) : row("clock", "Version", "Full version of the game")}
      ${row("shield", "Network", `Test network. Test ${esc(h.sym())} only, no real money`)}
    </dl>
  </section>`;
}

function recentHTML(ctx, g) {
  const { S, h } = ctx; const { esc } = h;
  const rows = S.live && Array.isArray(S.live.recent) ? S.live.recent.filter((r) => r.game === g.id).slice(0, 4) : [];
  if (!rows.length) return "";
  return `<section class="lb-card gl-recent" aria-labelledby="glRecentH">
    <header class="gl-sec-head"><p class="lb-eyebrow">Public matches</p><h3 class="gl-h3" id="glRecentH">Recent results</h3></header>
    <ul class="gl-rlist">${rows.map((r) => {
      const who = r.winner && r.winner.name ? r.winner.name : "";
      const what = r.result === "draw" ? "Draw" : who ? `${esc(who)} won` : "Won";
      const pot = r.stake === "0" ? "Free" : `Pot <b class="dg-mono">${h.eth(r.pot)}</b> ${esc(h.sym())}`;
      return `<li>${avatar(who || "draw", 26)}<span class="gl-rwho">${what}</span><span class="gl-rpot">${pot}</span><span class="gl-rago">${esc(h.ago(r.endedAt))}</span></li>`;
    }).join("")}</ul>
  </section>`;
}

/* ---- ways to play */

function inviteCard(ctx, g) {
  const { S, h } = ctx; const { esc } = h; const cfg = S.cfg;
  const banned = isBanned(S, h), hasOpen = !!S.host;
  return `<section class="lb-card gl-mode gl-invite" id="glInvite" aria-labelledby="glInviteH">
    <header class="gl-mode-head">
      <span class="gl-mode-ico">${icon("link")}</span>
      <div class="gl-mode-t"><h4 id="glInviteH">Invite a friend</h4><p>Private lobby</p></div>
      <span class="gl-tag gold">Main mode</span>
    </header>
    <ol class="gl-steps">
      <li><b>1</b><span>Create a lobby for ${esc(g.name)}</span></li>
      <li><b>2</b><span>Send the invite link or 8-character code</span></li>
      <li><b>3</b><span>Your friend checks the terms and joins</span></li>
    </ol>
    <div class="gl-set">
      <span class="gl-set-l" id="glStakeL">Stake <small>${esc(h.sym())} · test network</small></span>
      <div class="lb-chips gl-chips" role="group" aria-labelledby="glStakeL">${stakeChips(ctx)}</div>
      ${S.pick.stake === "custom" ? `<div class="lb-custom"><label for="customStake">Custom stake in ${esc(h.sym())} (${h.eth(cfg.stake.min)} to ${h.eth(cfg.stake.max)})</label><input id="customStake" type="text" inputmode="decimal" value="${esc(S.pick.custom)}" placeholder="0.002" autocomplete="off"></div>` : ""}
      <div id="lbCalc" aria-live="polite">${calcHTML(ctx)}</div>
    </div>
    ${noticesHTML(ctx)}
    <div class="lb-err err" id="err" role="alert">${esc(S.error)}</div>
    <button class="lb-find gl-create" data-act="create-lobby" id="createBtn" ${S.busy || banned || hasOpen ? "disabled" : ""}>
      <span class="lb-find-t"><b>Create lobby</b></span>${icon("arrow")}</button>
    ${hasOpen ? `<p class="lb-go-note" role="status">You already have an open lobby. Cancel it from its waiting room before you create another.</p>` : ""}
    <ul class="gl-facts">
      <li>${icon("clock")}<span>The lobby stays open for ${esc(longTime(cfg.match.lobbyTtlMs))}.</span></li>
      <li>${icon("wallet")}<span>Your stake is held until someone joins or you cancel.</span></li>
      <li>${icon("shield")}<span>Your friend sees the game and stake before paying.</span></li>
    </ul>
  </section>`;
}

/* practice against a bot: sits right under the hero. The level chosen here carries over to the practice screen. */
function practiceCard(ctx, g) {
  const { S, h } = ctx; const { esc } = h;
  const lvl = S.ui.prLevel || "normal";
  const chip = (id, name) => `<button type="button" class="lb-chip" data-act="pr-level" data-level="${id}" aria-pressed="${lvl === id}">${name}</button>`;
  return `<section class="lb-card gl-mode gl-prac" aria-labelledby="glPracH">
    ${artBg(g.id, "gl-pracart")}
    <div class="gl-prac-l">
      <header class="gl-mode-head">
        <span class="gl-mode-ico">${icon("bolt")}</span>
        <div class="gl-mode-t"><h4 id="glPracH">Practice against a bot</h4><p>Free · no stake · no rating</p></div>
      </header>
      <p class="gl-mode-p">Learn ${esc(g.name)} before you play a friend. The bot plays the exact same challenge as you, so beat its score to win.</p>
    </div>
    <div class="gl-prac-r">
      <div class="gl-prac-lv"><span class="gl-prac-lvl" id="glPracLv">Bot level</span><div class="gl-prac-chips" role="group" aria-labelledby="glPracLv">${chip("easy", "Easy")}${chip("normal", "Normal")}${chip("hard", "Hard")}</div></div>
      <button type="button" class="lb-find gl-prac-go" data-act="try-game" data-game="${esc(g.id)}" id="glPractice"><span class="lb-find-t"><b>Start practice</b></span>${icon("arrow")}</button>
    </div>
  </section>`;
}

function notFound(ctx) {
  const { S, h } = ctx;
  const id = S.ui.gameId || "";
  return `<div class="gl-page gl-none">
    <a class="gl-back" href="#games" data-go="games">${icon("arrow")}Game library</a>
    <section class="lb-card gl-nf" aria-labelledby="glNf">
      <span class="gl-mode-ico">${icon("search")}</span>
      <h2 class="lb-title" id="glNf">Game not found</h2>
      <p class="lb-muted">${id ? `There is no game called “${h.esc(id)}” here.` : "That game does not exist."} It may have been renamed or removed.</p>
      <a class="lb-btn gold" href="#games" data-go="games">Browse the game library${icon("arrow")}</a>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ view */

export const views = {
  game(ctx) {
    const { S, h } = ctx;
    const g = h.game(S.ui.gameId);
    if (!g) return notFound(ctx);
    const t = textFor(g);
    const host = S.host ? `<div class="gl-host">${openLobbyCard(ctx)}</div>` : "";
    return `<div class="gl-page">
      <a class="gl-back" href="#games" data-go="games">${icon("arrow")}Game library</a>
      ${host}
      <div class="gl-grid">
        ${hero(ctx, g, t)}
        ${practiceCard(ctx, g)}
        <aside class="gl-rail" aria-label="Play a friend">
          ${inviteCard(ctx, g)}
        </aside>
        <div class="gl-main">
          ${aboutCard(ctx, g, t)}
          ${rulesCard(ctx, g)}
          <div id="glRecent">${recentHTML(ctx, g)}</div>
        </div>
      </div>
    </div>`;
  },
};

export const actions = {};

export function mount(name, app) {}

/* S.live refreshed: patch the numbers in place so a poll never re-renders the page under the player */
export function live(app) {
  const { S, ctx, h } = app;
  if (S.view !== "lobby" || S.tab !== "game") return;
  const g = h.game(S.ui.gameId);
  if (!g) return;
  const a = document.querySelector("#glLive"), b = document.querySelector("#glRecent");
  patch(a, liveHTML(ctx, g));
  patch(b, recentHTML(ctx, g));
}
/* only touch the DOM when the numbers changed: rewriting it every poll restarts the pulse dot and drops text selection */
function patch(el, html) {
  if (!el || el._html === html) return;
  el._html = html; el.innerHTML = html;
}
