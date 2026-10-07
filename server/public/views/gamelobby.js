/* One game's own page (#game/<id>): what the game is, how to play it against a bot or a friend, the settings, and Create lobby.
   Opened from a card in the Game library (app.go("game", id) sets S.ui.gameId and S.pick.game). Styles: /play/gamelobby.css (.gl- prefix).
   The stake picker, terms line and open-lobby banner reuse the lobby page's helpers, so both pages behave the same.
   Everything shown is real: the game pack's text (or gamecopy.js), S.cfg and the player's own rating. Nothing public: no online counts, no results of other players.
   Layout: an editorial page. A large hero plate (the game's art as a quiet picture), an About / Try out row under it, hairline-ruled sections with the heading in a
   narrow left column, and a rail on wide screens that holds the one primary action, Create lobby. */
import { icon } from "../ui.js";
import { readFavs, ratingFor, stakeChips, calcHTML, noticesHTML, openLobbyCard } from "./lobby.js";
import { copyFor, cleanRules, noMix, nbu, cap } from "./gamecopy.js";
import { art, artBg } from "../gameart.js";

/* ------------------------------------------------------------------ small helpers */

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
/* 360 → "6 min", 95 → "1 min 35 s", 45 → "45 s" (the space before the unit is non-breaking) */
function shortTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return nbu(`${s} s`);
  const m = Math.floor(s / 60), r = s % 60;
  return nbu(r ? `${m} min ${r} s` : `${m} min`);
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

/* "pts" is the pack's short form: show the word */
const scoreName = (s) => (/^pts?$/i.test(String(s).trim()) ? "Points" : cap(String(s)));

const isBanned = (S, h) => !!(S.me && S.me.queueBanUntil && Number(S.me.queueBanUntil) > h.now());

/* ------------------------------------------------------------------ pieces */

function hero(ctx, g, t) {
  const { S, h } = ctx; const { esc } = h;
  /* the game's illustration from the lobby cards: a big, quiet picture behind the title (decorative; nothing renders when a game has no art) */
  const A = art(g.id);
  const tagline = t.tagline || (A ? A.tagline : "");
  const fav = readFavs().includes(g.id), r = ratingFor(S, g.id);
  const games = r ? (r.wins || 0) + (r.losses || 0) + (r.draws || 0) : 0;
  /* the length is shown as a stat when the game has a time cap; otherwise it rides in the eyebrow */
  const eyebrow = [cap(g.category), !g.maxSeconds && t.length ? nbu(t.length) : ""].filter(Boolean).map(esc).join(" · ");
  const stat = (k, v, sub = "") => `<div class="gl-stat"><dt class="gl-label">${k}</dt><dd class="gl-stat-v">${v}</dd>${sub ? `<dd class="gl-stat-s">${sub}</dd>` : ""}</div>`;
  return `<section class="gl-hero${A ? " has-art" : ""}" aria-labelledby="glName">
    ${artBg(g.id, "gl-art")}
    <div class="gl-hero-top">
      <p class="gl-label gl-eyebrow">${eyebrow}</p>
      <button type="button" class="gl-fav" data-act="lb-fav" data-game="${esc(g.id)}" aria-pressed="${fav}" aria-label="${fav ? "Remove " : "Add "}${esc(g.name)} ${fav ? "from" : "to"} favourites">${icon("star")}</button>
    </div>
    <h1 class="gl-name" id="glName">${esc(g.name)}</h1>
    ${tagline ? `<p class="gl-tagline">${esc(nbu(tagline))}</p>` : ""}
    <div class="gl-spec">
      <div class="gl-meters">${h.meter("Skill", g.skill, "skill")}${h.meter("Luck", g.luck, "luck")}</div>
      <dl class="gl-stats">
        ${stat("Your rating", r ? `<span class="dg-mono">${esc(r.rating)}</span>` : "Unrated", r && games ? esc(`${r.wins || 0}W ${r.losses || 0}L ${r.draws || 0}D`) : r ? "" : "Play a match to get one")}
        ${g.maxSeconds ? stat("Longest match", esc(shortTime(g.maxSeconds)), "Full game") : ""}
        ${g.scoreLabel ? stat("Scored by", esc(scoreName(g.scoreLabel)), "Higher wins") : ""}
      </dl>
    </div>
  </section>`;
}

/* right under the hero: About opens the game's description in place, Try out starts a practice round against the bot (the level
   picked in Practice carries over). The panel's open state lives in S.ui.glAbout, so background re-renders keep it. */
function aboutBar(ctx, g, t) {
  const { S, h } = ctx; const { esc } = h;
  const open = !!S.ui.glAbout;
  const ul = (items) => `<ul class="gl-list">${items.map((x) => `<li>${esc(nbu(x))}</li>`).join("")}</ul>`;
  const block = (title, items) => (items.length ? `<div class="gl-block"><h3 class="gl-label">${title}</h3>${ul(items)}</div>` : "");
  const blocks = [block("Scoring", t.scoring), block("Controls", t.controls), block("Tips", t.tips)].filter(Boolean);
  return `<section class="gl-quick" aria-label="About ${esc(g.name)}">
    <div class="gl-quick-acts">
      <button type="button" class="gl-btn quiet gl-about-btn" data-act="gl-about" id="glAboutBtn" aria-expanded="${open}" aria-controls="glAboutPanel">About${icon("chevron")}</button>
      <button type="button" class="gl-btn" data-act="try-game" data-game="${esc(g.id)}" id="glTry">Try out${icon("arrow")}</button>
    </div>
    <div class="gl-about-panel" id="glAboutPanel" role="region" aria-labelledby="glAboutBtn"${open ? "" : " hidden"}>
      ${t.overview ? `<p class="gl-p">${esc(nbu(t.overview))}</p>` : ""}
      ${t.goal ? `<div class="gl-goal"><p class="gl-label gold">Goal</p><p class="gl-goal-t">${esc(nbu(t.goal))}</p></div>` : ""}
      ${t.rules.length ? `<div class="gl-block"><h3 class="gl-label">How to play</h3><ol class="gl-rules">${t.rules.map((x) => `<li>${esc(nbu(x))}</li>`).join("")}</ol></div>` : ""}
      ${blocks.join("")}
      ${!t.overview && !t.goal && !t.rules.length && !blocks.length ? `<p class="gl-p gl-quiet">There is no written guide for this game yet. Try it out against the bot to learn it.</p>` : ""}
      <p class="gl-fair">Everyone in the match gets the exact same seeded challenge, so the better play wins.</p>
    </div>
  </section>`;
}

/* the terms of every online match of this game */
function rulesCard(ctx, g) {
  const { S, h } = ctx; const { esc, eth } = h; const cfg = S.cfg;
  const fee = (cfg.feeBps || 0) / 100;
  const row = (k, v) => `<div class="gl-term"><dt class="gl-label">${k}</dt><dd>${v}</dd></div>`;
  return `<section class="gl-sec gl-terms" aria-labelledby="glTerms"><div class="gl-sec-in">
    <header class="gl-sec-head"><p class="gl-label">Settings for every match</p><h2 class="gl-h2" id="glTerms">Match rules</h2></header>
    <dl class="gl-termlist">
      ${row("Stake", `Free, or <b class="dg-mono">${eth(cfg.stake.min)}</b> to <b class="dg-mono">${eth(cfg.stake.max)}</b> ${esc(h.sym())} each`)}
      ${row("Winner", `Highest score takes the pot, minus a <b>${fee}%</b> fee on staked matches. Tied top scores split it`)}
      ${row("Rated", "Yes. Free and staked matches both change your rating")}
      ${row("Players", "2 to 10 in one private lobby. The host starts the match")}
      ${row("Challenge", "Same seeded challenge for every player")}
      ${g.maxSeconds ? row("Length", `Up to <b>${esc(shortTime(g.maxSeconds))}</b>, full version of the game`) : row("Version", "Full version of the game")}
      ${row("Network", h.real() ? `${esc(h.chainName())}. Real ${esc(h.sym())}: stakes are held in escrow until the match is decided` : `Test network. Test ${esc(h.sym())} only, no real money`)}
    </dl>
  </div></section>`;
}

/* ---- ways to play */

/* the one primary action of the page */
function inviteCard(ctx, g) {
  const { S, h } = ctx; const { esc } = h; const cfg = S.cfg;
  const banned = isBanned(S, h), hasOpen = !!S.lobby;
  return `<section class="gl-invite" id="glInvite" aria-labelledby="glInviteH">
    <header class="gl-inv-head">
      <p class="gl-label gold">Private lobby · Main mode</p>
      <h2 class="gl-h2" id="glInviteH">Invite friends</h2>
    </header>
    <ol class="gl-steps">
      <li>Create a lobby for ${esc(g.name)}</li>
      <li>Send the invite link or 8-character code</li>
      <li>Friends check the terms and join, up to 10 players</li>
      <li>You start the match when everyone is in</li>
    </ol>
    <div class="gl-inv-set">
      <div class="gl-stake">
        <span class="gl-label" id="glStakeL">Stake <small>${esc(h.sym())} · ${h.real() ? esc(h.chainName()) : "test network"}</small></span>
        <div class="gl-chips" role="group" aria-labelledby="glStakeL">${stakeChips(ctx)}</div>
      </div>
      ${S.pick.stake === "custom" ? `<div class="gl-custom"><label for="customStake">Custom stake in ${esc(h.sym())} (${h.eth(cfg.stake.min)} to ${h.eth(cfg.stake.max)})</label><input id="customStake" type="text" inputmode="decimal" value="${esc(S.pick.custom)}" placeholder="0.002" autocomplete="off"></div>` : ""}
      <div id="lbCalc" class="gl-calc" aria-live="polite">${calcHTML(ctx)}</div>
      ${noticesHTML(ctx)}
      <div class="gl-err" id="err" role="alert">${esc(S.error)}</div>
      <button type="button" class="gl-btn primary block gl-create" data-act="create-lobby" id="createBtn" ${S.busy || banned || hasOpen ? "disabled" : ""}>Create lobby${icon("arrow")}</button>
      ${hasOpen ? `<p class="gl-note" role="status">You are already in a lobby. Cancel or leave it from its waiting room before you create another.</p>` : ""}
    </div>
    <ul class="gl-facts">
      <li>The lobby stays open for ${esc(longTime(cfg.match.lobbyTtlMs))}.</li>
      <li>Your stake is held until the match is decided, or until you cancel.</li>
      <li>Each friend sees the game and stake before paying.</li>
    </ul>
  </section>`;
}

/* practice against a bot: sits right under the hero. The level chosen here carries over to the practice screen.
   A secondary action (gold outline): the page's solid gold button is Create lobby. */
function practiceCard(ctx, g) {
  const { S, h } = ctx; const { esc } = h;
  const lvl = S.ui.prLevel || "normal";
  const chip = (id, name) => `<button type="button" class="gl-chip" data-act="pr-level" data-level="${id}" aria-pressed="${lvl === id}">${name}</button>`;
  return `<section class="gl-sec gl-prac" aria-labelledby="glPracH"><div class="gl-sec-in">
    <header class="gl-sec-head"><p class="gl-label">Free · no stake · no rating</p><h2 class="gl-h2" id="glPracH">Practice against a bot</h2></header>
    <div class="gl-sec-body">
      <p class="gl-p">Learn ${esc(g.name)} before you play a friend. The bot plays the exact same challenge as you, so beat its score to win.</p>
      <div class="gl-prac-ctl">
        <div class="gl-lvl"><span class="gl-label" id="glPracLv">Bot level</span><div class="gl-seg" role="group" aria-labelledby="glPracLv">${chip("easy", "Easy")}${chip("normal", "Normal")}${chip("hard", "Hard")}</div></div>
        <button type="button" class="gl-btn line" data-act="try-game" data-game="${esc(g.id)}" id="glPractice">Start practice${icon("arrow")}</button>
      </div>
    </div>
  </div></section>`;
}

function notFound(ctx) {
  const { S, h } = ctx;
  const id = S.ui.gameId || "";
  return `<div class="gl-page gl-none">
    <a class="gl-back" href="#games" data-go="games">${icon("arrow")}<span>Game library</span></a>
    <section class="gl-nf" aria-labelledby="glNf">
      <h1 class="gl-name" id="glNf">Game not found</h1>
      <p class="gl-p gl-quiet">${id ? `There is no game called “${h.esc(id)}” here.` : "That game does not exist."} It may have been renamed or removed.</p>
      <a class="gl-btn primary" href="#games" data-go="games">Browse the game library${icon("arrow")}</a>
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
    const host = S.lobby ? `<div class="gl-host">${openLobbyCard(ctx)}</div>` : "";
    return `<div class="gl-page">
      <a class="gl-back" href="#games" data-go="games">${icon("arrow")}<span>Game library</span></a>
      ${host}
      <div class="gl-grid">
        ${hero(ctx, g, t)}
        ${aboutBar(ctx, g, t)}
        ${practiceCard(ctx, g)}
        <aside class="gl-rail" aria-label="Play with friends">
          ${inviteCard(ctx, g)}
        </aside>
        <div class="gl-main">
          ${rulesCard(ctx, g)}
        </div>
      </div>
    </div>`;
  },
};

export const actions = {
  /* toggled in place, so focus stays on the button */
  "gl-about"(el, app) {
    const open = (app.S.ui.glAbout = !app.S.ui.glAbout);
    const panel = document.getElementById("glAboutPanel");
    if (!panel) return app.render(true);
    panel.hidden = !open;
    el.setAttribute("aria-expanded", String(open));
  },
};

export function mount(name, app) {}
