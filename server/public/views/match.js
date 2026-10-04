/* Match flow: lobby (host waiting room / guest invite / guest waiting room) → found → play → result (+ orphan when the match runs in another tab).
   A lobby holds 2–10 players: the host plus guests. Everything that lists people (roster, ready states, live race, standings) is a list
   built from lobby.players / match.players, so it works for 2 players and for 10.
   All markup uses .mx-* classes styled in /play/match.css (gold-style design rules: serif display headlines, uppercase tracked labels,
   hairline rules, 2–4px corners, one solid-gold primary action per view). Views are pure; live()/playBar()/patchLobby() patch the DOM in place. */
import { icon, avatar, esc } from "../ui.js";

/* why a match ended, as a sentence. `ps` = playersOf(match); `shared` = more than one player holds first place. */
const REASONS = (m, ps = [], shared = false) => {
  const n = ps.length || 2, you = ps.find((p) => p.you) || m.you || {};
  return {
    scores: shared ? "The top score is shared, so the pot is split between the leaders." : m.result === "draw" && n > 2 ? "Everyone scored the same. Stakes are refunded." : "Highest score wins.",
    forfeit: you.forfeited ? "You forfeited." : n > 2 ? "Another player forfeited." : m.result === "win" ? "Your opponent forfeited." : "You forfeited.",
    timeout: n > 2 ? (you.score == null ? "You did not finish in time." : "Another player did not finish in time.") : m.result === "win" ? "Your opponent did not finish in time." : "You did not finish in time.",
    no_result: "Nobody submitted a result. Stakes are refunded.",
    no_show: "Someone did not press Ready. Stakes are refunded.",
    declined: "The match was declined. Stakes are refunded.",
    server_restart: "The server restarted. Stakes are refunded.",
  };
};

const NB = " "; // non-breaking space: keeps a number and its unit on one line
const nb = (s) => String(s).replace(/(\d) (?=[A-Za-zµ])/g, "$1" + NB);
const stakeText = (h, stake) => (String(stake) === "0" ? "Free play" : `${h.eth(stake)}${NB}${h.sym()}`);
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const plural = (n, a, b) => (n === 1 ? a : b);
/* 1 → "1st", 2 → "2nd", 11 → "11th" */
const ord = (n) => { const v = Number(n), t = v % 100; return v + (t >= 11 && t <= 13 ? "th" : ["th", "st", "nd", "rd"][v % 10] || "th"); };

/* ---------- people: the lobby roster and the match players ---------- */
const LOBBY_MAX = 10;
const maxOf = (l) => Number(l && l.maxPlayers) || LOBBY_MAX;
const minOf = (l) => Number(l && l.minPlayers) || 2;
/* [{ name, host, you?, avatar? }] — falls back to just the host for a server that does not send the roster */
export const lobbyPlayers = (l) => (l && Array.isArray(l.players) && l.players.length ? l.players : l && l.host ? [{ name: l.host.name, host: true, you: l.role === "host" }] : []);
export const countOf = (l) => lobbyPlayers(l).length || Number(l && l.playerCount) || 1;

/* The players of a match, by seat. Uses match.players; for a server that only sends you + opponent it builds the same two rows. */
export function playersOf(m, me) {
  if (!m) return [];
  if (Array.isArray(m.players) && m.players.length) return [...m.players].sort((a, b) => a.seat - b.seat);
  const y = m.you || {}, o = m.opponent || {};
  return [
    { seat: y.seat, name: (me && me.displayName) || "You", address: me && me.address, you: true, ready: !!y.ready, finished: !!y.submitted, forfeited: false, score: y.score, ratingBefore: y.ratingBefore, ratingAfter: y.ratingAfter, payout: y.payout, place: null },
    { seat: y.seat === 0 ? 1 : 0, name: o.name, address: o.address, you: false, ready: !!o.ready, finished: !!o.finished, forfeited: false, score: o.score, ratingBefore: o.ratingBefore, ratingAfter: o.ratingAfter, payout: null, place: null },
  ].sort((a, b) => a.seat - b.seat);
}
const isReady = (S, p) => (p.you ? !!S.youReady : !!(S.seats && S.seats[p.seat] ? S.seats[p.seat].ready : p.ready));

/* small outlined tags next to a name: HOST, YOU (the .lb-chip-s look from lobby.css) */
const chips = (p) => `${p.host ? '<span class="lb-chip-s">Host</span>' : ""}${p.you ? '<span class="lb-chip-s you">You</span>' : ""}`;
/* one row per lobby player: avatar, name in ivory, tags. Used by the host room, the guest room and the invite page. */
const rosterRows = (l) => lobbyPlayers(l).map((p) => `<li class="mx-pr${p.you ? " you" : ""}">${ava(p.avatar || p.name, 32, p.you ? "you" : "")}<span class="mx-pname">${esc(p.name)}</span><span class="mx-ptags">${chips(p)}</span></li>`).join("");
/* ten thin segments, one per seat: gold = taken (decorative, the count beside it carries the meaning) */
const seatPips = (n, max) => Array.from({ length: max }, (_, i) => `<i${i < n ? ' class="on"' : ""}></i>`).join("");
const startLabel = (n, min, busy) => (busy ? "Starting…" : n >= min ? `Start match · ${n} players` : "Start match");
const startHint = (n, min, max) => (n < min ? "Waiting for at least one more player" : n >= max ? "The lobby is full. Starting…" : `Press Start match when everyone is in. It also starts by itself at ${max} players.`);

/* a money figure: serif numerals + a small unit */
const amt = (h, wei) => `<span class="mx-amt">${h.esc(h.eth(wei))}</span><span class="mx-unit">${NB}${h.esc(h.sym())}</span>`;

/* thin-stroke icons local to this module (the shared set has no share glyph or left arrow) */
const glyph = (d) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const SHARE = glyph('<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 12v7h14v-7"/>');
const BACK = glyph('<path d="M19 12H5M11 6l-6 6 6 6"/>');

/* avatar in the role colour: gold = you, terracotta = your opponent (restyled in CSS from the shared pixel avatar) */
const ava = (seed, size, tone) => `<span class="mx-ava ${tone}">${avatar(seed, size)}</span>`;

/* rating-based estimate (Elo expected score), clamped so it never claims certainty */
function odds(you, opp) {
  const e = 1 / (1 + 10 ** ((Number(opp) - Number(you)) / 400));
  return Math.min(95, Math.max(5, Math.round(e * 100)));
}

function rulesSection(g, h, eyebrow, cls = "") {
  if (!g || !Array.isArray(g.rules) || !g.rules.length) return "";
  return `<section class="mx-rulesec ${cls}" aria-label="Rules">
    <div class="mx-rulehead"><p class="mx-eyebrow">${h.esc(eyebrow)}</p><h2 class="mx-h2">How ${h.esc(g.name)} works</h2></div>
    <ol class="mx-rules">${g.rules.map((r) => `<li>${h.esc(r)}</li>`).join("")}</ol>
  </section>`;
}

/* Honest context for the queue screen from GET /v1/lobby (S.live). Returns plain text, or "" when nothing real is known. */
function liveText(S) {
  const q = S.queue, L = S.live;
  if (!q) return "";
  if (q.code) return "Private match: only a player who enters your code can join.";
  if (!L || !Array.isArray(L.games)) return "";
  const g = L.games.find((x) => x.game === q.game);
  const others = Math.max(0, (g ? Number(g.waiting) || 0 : 0) - 1); // the count includes your own ticket
  const same = g && Array.isArray(g.stakes) ? g.stakes.find((s) => String(s.stake) === String(q.stake)) : null;
  const sameOthers = Math.max(0, (same ? Number(same.waiting) || 0 : 0) - 1);
  const parts = [];
  if (others > 0) parts.push(`${others} ${plural(others, "other", "others")} waiting for this game`);
  else parts.push("You are the only one waiting for this game right now");
  if (others > 0 && sameOthers > 0) parts.push(`${sameOthers} at your stake`);
  if (g && Number(g.playing) > 0) parts.push(`${g.playing} ${plural(Number(g.playing), "match", "matches")} in progress`);
  return parts.join(" · ");
}

export function live(app) {
  const el = document.getElementById("mxLive");
  if (!el || app.S.view !== "queue") return;
  const t = liveText(app.S);
  el.textContent = t;
  el.hidden = !t;
}

let clockNow = () => Date.now(); // swapped for the server-synced clock on first render
/* elapsed-time labels: [data-since="epochMs"] */
setInterval(() => {
  for (const el of document.querySelectorAll("[data-since]")) {
    const now = clockNow();
    el.textContent = clock(Math.max(0, Math.floor((now - Number(el.dataset.since)) / 1000)));
  }
}, 1000);

/* The terms as a ledger of hairline-separated rows. `l` = public lobby or match view (stake, pot, winnerPayout); g = game meta or undefined. */
function terms(h, l, g, { duration = true } = {}) {
  const { esc, eth, sym } = h;
  const rows = [];
  const n = Number(l.playerCount) || (Array.isArray(l.players) ? l.players.length : 0); // the pot is stake × players, so it grows as people join
  if (duration && g && g.duration) rows.push(`<div class="mx-row"><dt>Duration</dt><dd class="mx-plain">${esc(nb(g.duration))}</dd></div>`);
  if (String(l.stake) === "0") {
    rows.push(`<div class="mx-row"><dt>Stake</dt><dd class="mx-plain">Free play<small>Ratings still count.</small></dd></div>`);
  } else {
    const fee = BigInt(l.pot) - BigInt(l.winnerPayout);
    rows.push(`<div class="mx-row"><dt>Stake each</dt><dd>${amt(h, l.stake)}</dd></div>`);
    rows.push(`<div class="mx-row"><dt>Pot${n ? ` · ${n} ${plural(n, "player", "players")}` : ""}</dt><dd>${amt(h, l.pot)}</dd></div>`);
    rows.push(`<div class="mx-row win"><dt>Winner receives</dt><dd>${amt(h, l.winnerPayout)}<small>after the ${esc(eth(fee))}${NB}${esc(sym())} fee. Tied top scores split it.</small></dd></div>`);
  }
  return `<dl class="mx-ledger">${rows.join("")}</dl>`;
}

const spaced = (code) => String(code).replace(/(.{4})(?=.)/g, "$1 ");

/* ---------- the lobby screens: host room, guest room, invite page ---------- */

const potLine = (h, l) => (String(l.stake) === "0" ? "Free play. Ratings still count."
  : `Pot <b>${esc(h.eth(l.pot))}${NB}${esc(h.sym())}</b> · winner receives <b>${esc(h.eth(l.winnerPayout))}${NB}${esc(h.sym())}</b>`);
/* plain text (the caller escapes it, or sets textContent) */
const waitText = (l) => (l.role === "host"
  ? (countOf(l) < minOf(l) ? "Nobody has joined yet" : `${countOf(l)} players are in. Start when you are ready`)
  : "The match starts when the host presses Start");

/* the Players block: label + count, seat bar, the list, the pot line and, for the host, the Start button.
   The count, list, pot line and button are patched in place by patchLobby() when someone joins or leaves. */
function playersBlock(ctx, l) {
  const { S, h } = ctx;
  const host = l.role === "host";
  const n = countOf(l), max = maxOf(l), min = minOf(l);
  const start = host ? `<div class="mx-startbox">
        <button type="button" class="mx-btn primary lg" id="startLobby" data-act="start-lobby" aria-describedby="startHint" ${n >= min && !S.busy ? "" : "disabled"}><span>${esc(startLabel(n, min, S.busy))}</span></button>
        <p class="mx-fine" id="startHint" aria-live="polite">${esc(startHint(n, min, max))}</p>
      </div>` : "";
  return `<section class="mx-a-players mx-players" id="lobbyPlayers" data-role="${host ? "host" : "guest"}" aria-labelledby="plH">
      <h2 class="mx-k mx-plh" id="plH">Players <span class="mx-plc" id="plCount">${n} / ${max}</span></h2>
      <div class="mx-seats" id="plSeats" style="--cap:${max}" aria-hidden="true">${seatPips(n, max)}</div>
      <ol class="mx-pl" id="plList" aria-label="Players in this lobby">${rosterRows(l)}</ol>
      <p class="mx-fine mx-potline" id="plPot">${potLine(h, l)}</p>
      ${start}
    </section>`;
}

/* the same block for someone who has not joined yet (public view: names and the HOST tag only) */
function publicPlayers(l) {
  const n = countOf(l), max = maxOf(l);
  return `<section class="mx-a-players mx-players" id="lobbyPlayers" data-role="public" aria-labelledby="plH">
      <h2 class="mx-k mx-plh" id="plH">Players <span class="mx-plc" id="plCount">${n} / ${max}</span></h2>
      <div class="mx-seats" id="plSeats" style="--cap:${max}" aria-hidden="true">${seatPips(n, max)}</div>
      <ol class="mx-pl" id="plList" aria-label="Players in this lobby">${rosterRows(l)}</ol>
    </section>`;
}

function hostRoom(ctx, l) {
  const { S, h } = ctx; const { left, game } = h;
  const g = game(l.game.id);
  const url = ctx.inviteUrl(l.code);
  const copied = Date.now() < (S.ui.copiedUntil || 0);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  const free = String(l.stake) === "0";
  const n = countOf(l), min = minOf(l), max = maxOf(l);
  return `<section class="mx mx-waiting" aria-labelledby="hw">
      <div class="mx-split">
        <header class="mx-a-head">
          <p class="mx-eyebrow">Your lobby is open</p>
          <h1 class="mx-title" id="hw">Waiting for <em>players</em></h1>
          <p class="mx-lede">Send this link or code to your friends. Everyone who opens it and presses Join takes a seat, up to ${max} players. Press Start match when you are ready.</p>
        </header>
        <div class="mx-a-main mx-panel mx-invite">
          <label class="mx-k" for="inviteLink">Invite link</label>
          <input class="mx-link" id="inviteLink" type="text" readonly value="${esc(url)}" spellcheck="false" autocomplete="off">
          <div class="mx-actions">
            <button class="mx-btn${n < min ? " primary" : ""}" id="copyInvite" data-act="copy-invite" ${copied ? 'data-copied="1"' : ""}>${icon("copy")}<span>${copied ? "Copied" : "Copy link"}</span></button>
            ${canShare ? `<button class="mx-btn" id="shareInvite" data-act="share-invite">${SHARE}<span>Share</span></button>` : ""}
          </div>
          <div class="mx-codebox"><span class="mx-k">Or tell them the code</span><b class="mx-code" aria-label="Invite code ${esc(String(l.code).split("").join(" "))}">${esc(spaced(l.code))}</b></div>
        </div>
        ${playersBlock(ctx, l)}
        <div class="mx-a-act">
          <div class="mx-wait" role="status">
            <span class="mx-scan" aria-hidden="true"></span>
            <p class="mx-waitrow"><span id="waitText">${esc(waitText(l))}</span><span><span class="mx-k">Link expires in</span> <b class="mx-time" data-until="${l.expiresAt}">${left(l.expiresAt)}</b></span></p>
          </div>
          <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
          <div class="mx-foot">
            <button type="button" class="mx-btn quiet" data-go="lobby" id="backToLobby">${BACK}<span>Back to lobby</span></button>
            <button type="button" class="mx-btn danger sm" data-act="close-lobby" id="closeLobby">${free ? "Cancel lobby" : "Cancel lobby and refund my stake"}</button>
          </div>
        </div>
        <aside class="mx-a-terms mx-terms" aria-label="The terms">
          <p class="mx-eyebrow">The terms</p>
          <h2 class="mx-h2">${esc(l.game.name)}</h2>
          <div id="lobbyTerms">${terms(h, l, g)}</div>
          ${g && g.blurb ? `<p class="mx-lede">${esc(g.blurb)}</p>` : ""}
          <p class="mx-fine">${free ? "Free play. Ratings still count. Cancelling closes the lobby for everyone." : "Every player stakes the same amount, held until the match is decided. Cancelling the lobby returns every stake. Test ETH only, no real money."}</p>
        </aside>
      </div>
      ${rulesSection(g, h, "While you wait")}
    </section>`;
}

/* a guest who joined: the same roster, no Start button, a way out */
function guestRoom(ctx, l) {
  const { S, h } = ctx; const { left, game } = h;
  const g = game(l.game.id);
  const free = String(l.stake) === "0";
  return `<section class="mx mx-waiting mx-guest" aria-labelledby="hw">
      <div class="mx-split">
        <header class="mx-a-head">
          <p class="mx-eyebrow">${esc(l.game.name)} · private lobby</p>
          <h1 class="mx-title" id="hw">You’re <em>in</em></h1>
          <p class="mx-lede">Waiting for <b class="mx-who">${esc(l.host.name)}</b> to start. ${free ? "You can leave any time before it starts." : "You can leave any time before it starts and get your stake back."}</p>
        </header>
        ${playersBlock(ctx, l)}
        <div class="mx-a-act">
          <div class="mx-wait" role="status">
            <span class="mx-scan" aria-hidden="true"></span>
            <p class="mx-waitrow"><span id="waitText">${esc(waitText(l))}</span><span><span class="mx-k">Lobby expires in</span> <b class="mx-time" data-until="${l.expiresAt}">${left(l.expiresAt)}</b></span></p>
          </div>
          <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
          <div class="mx-foot">
            <button type="button" class="mx-btn quiet" data-go="lobby" id="backToLobby">${BACK}<span>Back to lobby</span></button>
            <button type="button" class="mx-btn danger sm" data-act="leave-lobby" id="leaveLobby">${free ? "Leave lobby" : "Leave lobby and refund my stake"}</button>
          </div>
        </div>
        <aside class="mx-a-terms mx-terms" aria-label="The terms">
          <p class="mx-eyebrow">The terms</p>
          <h2 class="mx-h2">${esc(l.game.name)}</h2>
          <div id="lobbyTerms">${terms(h, l, g)}</div>
          ${g && g.blurb ? `<p class="mx-lede">${esc(g.blurb)}</p>` : ""}
          <p class="mx-fine">${free ? "Free play. Ratings still count." : "Your stake is held until the match is decided. Leaving before it starts returns it in full. Test ETH only, no real money."}</p>
        </aside>
      </div>
      ${rulesSection(g, h, "While you wait")}
    </section>`;
}

/* The roster, the Start button, the pot and the terms change whenever someone joins or leaves. Patching those nodes (instead of
   re-rendering the page) keeps keyboard focus, the selected invite link and the expiry timer exactly where they are.
   Returns false when the screen is not the one the lobby calls for: the caller then renders it from scratch. */
export function patchLobby(ctx) {
  const { S, h } = ctx; const l = S.lobby;
  const root = document.getElementById("lobbyPlayers");
  if (!l || !root || root.dataset.role !== (l.role === "host" ? "host" : "guest")) return false;
  const n = countOf(l), max = maxOf(l), min = minOf(l), $ = (id) => document.getElementById(id);
  const html = (id, v) => { const el = $(id); if (el && el._html !== v) { el._html = v; el.innerHTML = v; } };
  const text = (id, v) => { const el = $(id); if (el && el.textContent !== v) el.textContent = v; };
  text("plCount", `${n} / ${max}`);
  html("plSeats", seatPips(n, max));
  html("plList", rosterRows(l));
  html("plPot", potLine(h, l));
  html("lobbyTerms", terms(h, l, h.game(l.game.id)));
  text("waitText", waitText(l));
  const btn = $("startLobby");
  if (btn) {
    btn.disabled = !(n >= min && !S.busy);
    const t = btn.querySelector("span"); if (t) t.textContent = startLabel(n, min, S.busy);
    text("startHint", startHint(n, min, max));
  }
  const copy = $("copyInvite"); if (copy) copy.classList.toggle("primary", n < min); // Copy is the main action until there is someone to start with
  return true;
}

/* the invite page: the roster refreshes by itself every few seconds (loadInvite) */
export function patchInvite(ctx) {
  const { S } = ctx; const l = S.invite && S.invite.lobby;
  const root = document.getElementById("lobbyPlayers"), card = document.getElementById("inviteCard");
  if (!l || !root || !card || root.dataset.role !== "public") return false;
  const n = countOf(l), max = maxOf(l);
  if (card.dataset.full !== (n >= max ? "1" : "0")) return false; // the "full" notice appears or goes: build the page again
  const html = (id, v) => { const el = document.getElementById(id); if (el && el._html !== v) { el._html = v; el.innerHTML = v; } };
  const pc = document.getElementById("plCount"); if (pc) pc.textContent = `${n} / ${max}`;
  html("plSeats", seatPips(n, max));
  html("plList", rosterRows(l));
  html("lobbyTerms", terms(ctx.h, l, ctx.h.game(l.game.id)));
  return true;
}

export const views = {
  waiting(ctx) {
    const l = ctx.S.lobby || ctx.S.host;
    if (!l) return `<section class="mx mx-stop" aria-labelledby="hw"><div class="mx-stopbox"><p class="mx-eyebrow">Lobby</p><h1 class="mx-title" id="hw">No open lobby</h1><div class="mx-actions"><button class="mx-btn primary" data-go="lobby">Back to lobby</button></div></div></section>`;
    return l.role === "guest" ? guestRoom(ctx, l) : hostRoom(ctx, l);
  },

  invite(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, game } = h;
    const inv = S.invite || {}, l = inv.lobby;
    const stop = (eyebrow, title, text) => `<section class="mx mx-stop mx-invite-s" aria-labelledby="hi"><div class="mx-stopbox" id="inviteCard">
        <p class="mx-eyebrow">${esc(eyebrow)}</p>
        <h1 class="mx-title" id="hi">${esc(title)}</h1>
        <p class="mx-lede">${esc(text)}</p>
        <div class="mx-actions"><button class="mx-btn primary" id="inviteBack" data-act="dismiss-invite">Back to lobby</button></div>
      </div></section>`;
    if (inv.loading && !l) return stop("Private invite", "Opening invite…", "Checking the invite link.");
    if (!l) return inv.error === "LOBBY_NOT_FOUND" || !inv.error
      ? stop("Private invite", "This invite link is not valid", "Check that you copied the whole link, or ask your friend for a new one.")
      : stop("Private invite", "Could not open this invite", inv.error);
    if (S.lobby && S.lobby.code === l.code) return S.lobby.role === "host"
      ? stop("Private invite", "This is your own lobby", "Send the link to a friend. You cannot join your own lobby.")
      : stop("Private invite", "You are already in this lobby", "Use Open lobby at the top of the page to go back to your waiting room.");
    if (l.state !== "open") {
      const why = l.closedReason === "expired" ? "This invite has expired." : l.closedReason === "cancelled" ? "The host closed this lobby." : l.state === "matched" || l.closedReason === "matched" ? "The match has already started." : "This lobby is no longer open.";
      return stop("Private invite", "This lobby is closed", why + " Ask for a new link, or create a lobby of your own.");
    }
    const g = game(l.game.id), free = String(l.stake) === "0";
    const n = countOf(l), max = maxOf(l), full = n >= max;
    const stake = BigInt(l.stake || 0), avail = BigInt((S.me && S.me.balances && S.me.balances.available) || 0);
    const short = !free && avail < stake ? stake - avail : 0n;
    return `<section class="mx mx-invite-s" aria-labelledby="hi">
      <div class="mx-split" id="inviteCard" data-full="${full ? 1 : 0}">
        <header class="mx-a-head">
          <p class="mx-eyebrow">${esc(l.game.name)} · private invite</p>
          <h1 class="mx-title" id="hi"><span class="mx-who">${esc(l.host.name)}</span> <em>invited</em> you</h1>
          ${g && g.blurb ? `<p class="mx-lede">${esc(g.blurb)}</p>` : ""}
          <p class="mx-lede">Pressing Join puts you in the lobby. ${esc(l.host.name)} starts the match once enough players are in.</p>
        </header>
        ${publicPlayers(l)}
        <aside class="mx-a-terms mx-terms" aria-label="The terms">
          <p class="mx-eyebrow">The terms</p>
          <h2 class="mx-h2">${esc(l.game.name)}</h2>
          <div id="lobbyTerms">${terms(h, l, g)}</div>
          ${free ? "" : `<p class="mx-fine">Test ETH only, no real money. Your stake is taken when you press Join, and you can leave before the match starts for a full refund. If everyone ties, all stakes are returned.</p>`}
        </aside>
        <div class="mx-a-act">
          ${full ? `<div class="mx-short" role="status" id="fullNote"><p><b>This lobby is full</b><span class="mx-k">All ${max} seats are taken. Ask ${esc(l.host.name)} for a new link.</span></p></div>` : ""}
          ${short > 0n && !full ? `<div class="mx-short" role="status"><p><b>You need ${esc(eth(short))}${NB}${esc(sym())} more</b><span class="mx-k">Your available balance is ${esc(eth(avail))}${NB}${esc(sym())}.</span></p>
            <div class="mx-actions">${S.cfg && S.cfg.devFaucet && S.wallet ? `<button class="mx-btn" data-act="faucet" data-eth="1" id="inviteFaucet"${S.depositing ? " disabled" : ""}>${S.depositing ? "Depositing…" : `Deposit 1 test ${esc(sym())}`}</button>` : ""}<button class="mx-btn" data-go="wallet">Open wallet</button></div></div>` : ""}
          <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
          <div class="mx-actions">
            <button class="mx-btn primary lg" data-act="join-lobby" id="joinBtn" ${S.busy || full || short > 0n ? "disabled" : ""}>${S.busy ? "Joining…" : full ? "Lobby full" : "Join lobby"}</button>
            <button class="mx-btn quiet" data-act="dismiss-invite" id="inviteBack">Not now</button>
          </div>
        </div>
      </div>
      ${rulesSection(g, h, "Rules")}
    </section>`;
  },

  queue(ctx) {
    const { S, h } = ctx; const { esc, left, game } = h;
    clockNow = h.now;
    const q = S.queue, g = game(q.game);
    const total = (S.cfg && S.cfg.match && S.cfg.match.queueTimeoutMs) || 120000;
    const since = Number(q.expiresAt) - total;
    const lt = liveText(S);
    const free = String(q.stake) === "0";
    return `<section class="mx mx-queue" aria-labelledby="hq">
      <div class="mx-split">
        <header class="mx-a-head">
          <p class="mx-eyebrow">Matchmaking</p>
          <h1 class="mx-title" id="hq">Finding an <em>opponent</em></h1>
          <p class="mx-lede">Searching within ±60 rating, widening as you wait.</p>
          <div class="mx-wait" role="status"><span class="mx-scan" aria-hidden="true"></span></div>
        </header>
        <div class="mx-a-main">
          <dl class="mx-ledger">
            <div class="mx-row"><dt>Game</dt><dd class="mx-plain">${esc(g ? g.name : q.game)}</dd></div>
            <div class="mx-row"><dt>Stake</dt><dd class="mx-plain">${esc(stakeText(h, q.stake))}</dd></div>
            ${q.code ? `<div class="mx-row"><dt>Private code</dt><dd class="mx-plain">${esc(q.code)}</dd></div>` : ""}
            <div class="mx-row"><dt>Elapsed</dt><dd><b class="mx-time" data-since="${since}">${clock(Math.max(0, Math.floor((h.now() - since) / 1000)))}</b></dd></div>
            <div class="mx-row"><dt>Timeout in</dt><dd><b class="mx-time" data-until="${q.expiresAt}">${left(q.expiresAt)}</b></dd></div>
          </dl>
          <p class="mx-lede" id="mxLive" ${lt ? "" : "hidden"}>${esc(lt)}</p>
          <div class="mx-actions"><button class="mx-btn" data-act="cancel-queue" id="cancelQueue">Cancel and get my stake back</button></div>
          <p class="mx-fine">${free ? "Free play. Ratings still count." : "Your stake is held until the result. Test ETH only, no real money."}</p>
        </div>
      </div>
      ${rulesSection(g, h, "While you wait")}
    </section>`;
  },

  found(ctx) {
    const { S, h } = ctx; const { esc, left, game } = h;
    const m = S.match, g = game(m.game.id);
    const ps = playersOf(m, S.me), n = ps.length;
    const me = ps.find((p) => p.you) || {}, others = ps.filter((p) => !p.you);
    const free = String(m.stake) === "0";
    const acceptMs = (S.cfg && S.cfg.match && S.cfg.match.acceptMs) || 30000;
    const remain = Math.max(0, Number(m.readyDeadline) - h.now());
    const frac = Math.min(1, Math.max(0, remain / acceptMs));
    const rdy = (on, name) => `<span class="mx-ready ${on ? "on" : ""}"><i class="mx-dot" aria-hidden="true"></i>${on ? "Ready" : "Not ready yet"}<span class="sr-only"> ${esc(name)}</span></span>`;
    let title, main;
    if (n === 2) {
      /* two players: the face-to-face layout with rough odds */
      const opp = others[0] || {};
      const you = Number(me.ratingBefore), or = Number(opp.ratingBefore);
      const p = odds(you, or), diff = you - or;
      title = `Opponent <em>found</em>`;
      main = `<div class="mx-vs">
            <div class="mx-side you">
              ${ava(S.me.address, 56, "you")}
              <span class="mx-k mx-tag">You</span>
              <b class="mx-name">${esc(S.me.displayName)}</b>
              <span class="mx-rating"><span class="mx-k">Rating</span> <b class="mx-fig">${esc(you)}</b></span>
              ${rdy(S.youReady, "you")}
            </div>
            <div class="mx-x" aria-hidden="true">vs</div>
            <div class="mx-side opp">
              ${ava(opp.address || opp.name, 56, "opp")}
              <span class="mx-k mx-tag">Opponent</span>
              <b class="mx-name">${esc(opp.name)}</b>
              <span class="mx-rating"><span class="mx-k">Rating</span> <b class="mx-fig">${esc(or)}</b></span>
              ${rdy(isReady(S, opp), opp.name)}
            </div>
          </div>
          <div class="mx-odds" role="img" aria-label="Rough odds from ratings: you ${p} percent, ${esc(opp.name)} ${100 - p} percent">
            <div class="mx-oddsbar"><i style="width:${p}%"></i></div>
            <div class="mx-oddsrow"><span class="mx-you">You ${p}%</span><span class="mx-oddsnote">${diff === 0 ? "Evenly rated" : diff > 0 ? `You are rated ${diff} higher` : `${-diff} higher rated than you`} · rough odds from ratings${g && Number(g.luck) >= 6 ? ", luck matters a lot here" : ""}</span><span class="mx-opp">${100 - p}%</span></div>
          </div>`;
    } else {
      /* three or more: one row per player with their ready state */
      title = `Match <em>found</em>`;
      main = `<section class="mx-players" aria-labelledby="fdH">
            <h2 class="mx-k mx-plh" id="fdH">Players <span class="mx-plc" id="fdCount">${foundCount(S, ps)}</span></h2>
            <ol class="mx-pl" id="fdList" aria-label="Players and their ready state">${foundRows(S, ps)}</ol>
          </section>`;
    }
    return `<section class="mx mx-found" aria-labelledby="hf">
      <div class="mx-split">
        <div class="mx-a-main">
          <header class="mx-a-head">
            <p class="mx-eyebrow">${esc(m.game.name)}${n > 2 ? ` · ${n} players` : ""}</p>
            <h1 class="mx-title" id="hf">${title}</h1>
          </header>
          ${main}
        </div>
        <div class="mx-a-act mx-readyblock">
          <div class="mx-timer" style="--left:${frac.toFixed(3)};--dur:${Math.round(remain)}ms" role="timer" aria-label="Time left to accept">
            <span class="mx-k">Time to accept</span>
            <b class="mx-clock" data-until="${m.readyDeadline}">${left(m.readyDeadline)}</b>
            <i class="mx-drain" aria-hidden="true"></i>
          </div>
          <p class="mx-status" id="foundStatus" aria-live="polite">${esc(foundStatus(S, ps))}</p>
          <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
          <div class="mx-actions">
            <button class="mx-btn primary lg" data-act="ready" id="readyBtn" ${S.youReady ? "disabled" : ""}>${S.youReady ? "Waiting…" : "Ready"}</button>
            <button class="mx-btn quiet" data-act="decline" id="declineBtn">Decline</button>
          </div>
        </div>
        <aside class="mx-a-terms mx-terms" aria-label="The terms">
          <p class="mx-eyebrow">The terms</p>
          ${terms(h, m, g, { duration: false })}
          ${free ? "" : `<p class="mx-fine">Test ETH only, no real money. If everyone ties, all stakes are returned.</p>`}
        </aside>
        ${rulesSection(g, h, "Rules", "mx-a-rules stack")}
      </div>
    </section>`;
  },

  orphan(ctx) {
    const { S, h } = ctx; const { esc, left } = h;
    const m = S.match, n = playersOf(m, S.me).length;
    const who = n > 2 ? `with <b>${n} players</b>` : `against <b>${esc(m.opponent.name)}</b>`;
    return `<section class="mx mx-stop mx-orphan" aria-labelledby="ho">
      <div class="mx-stopbox">
        <p class="mx-eyebrow">${esc(m.game.name)}</p>
        <h1 class="mx-title" id="ho">Match in <em>progress</em></h1>
        <p class="mx-lede">Your match ${who} is running, but the challenge is only delivered once, to the page that pressed Ready, so it cannot be resumed here. If you play it in another tab you can ignore this. Otherwise forfeit, or the match ends by itself at the deadline.</p>
        <dl class="mx-ledger"><div class="mx-row"><dt>Deadline in</dt><dd><b class="mx-time" data-until="${m.submitDeadline}">${left(m.submitDeadline)}</b></dd></div></dl>
        ${S.forfeited
          ? `<p class="mx-status" id="forfeitedNote" role="status">You forfeited. The match goes on for the others, and you will see the result when it ends.</p>`
          : `<div class="mx-actions"><button class="mx-btn danger" data-act="forfeit-now" id="forfeitNow">Forfeit this match</button></div>`}
      </div>
    </section>`;
  },

  result(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, game } = h;
    const m = S.result;
    const ps = playersOf(m, S.me), n = ps.length;
    const you = ps.find((p) => p.you) || m.you || {};
    const opp = n === 2 ? ps.find((p) => !p.you) || m.opponent || {} : null;
    const leaders = ps.filter((p) => Number(p.place) === 1).length; // players sharing first place
    const shared = m.result === "win" && leaders > 1;
    const label = shared ? "Shared win" : { win: "Victory", loss: "Defeat", draw: "Draw", void: "Match cancelled" }[m.result] || m.result;
    const why = REASONS(m, ps, shared)[m.reason] || "";
    const lab = m.game.scoreLabel;
    const hasRating = you.ratingAfter != null && m.result !== "void";
    const delta = hasRating ? Number(you.ratingAfter) - Number(you.ratingBefore) : 0;
    const stake = BigInt(m.stake || 0), got = BigInt(you.payout || 0);
    const net = m.result === "void" || m.result === "draw" ? 0n : got - stake;
    const abs = net < 0n ? -net : net;
    const showScores = m.result !== "void" && ps.some((p) => p.score != null);
    const yn = Number(you.score), on = opp ? Number(opp.score) : 0;
    const g = game(m.game.id);
    const rows = [];
    if (stake > 0n) {
      if (net > 0n) rows.push(`<div class="mx-row good"><dt>${shared ? "You won (shared)" : "You won"}</dt><dd><span class="mx-amt">+${esc(eth(abs))}</span><span class="mx-unit">${NB}${esc(sym())}</span></dd></div>`);
      else if (net < 0n) rows.push(`<div class="mx-row bad"><dt>${m.result === "win" ? "Net after the split" : "Stake lost"}</dt><dd><span class="mx-amt">−${esc(eth(abs))}</span><span class="mx-unit">${NB}${esc(sym())}</span></dd></div>`);
      else rows.push(`<div class="mx-row"><dt>Money</dt><dd><span class="mx-amt">±0</span><span class="mx-unit">${NB}${esc(sym())}</span><small>Your ${esc(eth(stake))}${NB}${esc(sym())} stake was returned.</small></dd></div>`);
    } else rows.push(`<div class="mx-row"><dt>Stake</dt><dd class="mx-plain">Free play</dd></div>`);
    if (hasRating) rows.push(`<div class="mx-row"><dt>Rating</dt><dd><span class="mx-amt">${esc(you.ratingBefore)}</span><i class="mx-arrow" aria-hidden="true"></i><span class="sr-only"> to </span><span class="mx-amt">${esc(you.ratingAfter)}</span>${delta ? ` <small class="mx-delta ${delta > 0 ? "up" : "down"}">${delta > 0 ? "+" : "−"}${Math.abs(delta)}</small>` : ""}</dd></div>`);
    /* the scoreboard: two big scores for a duel, a ranked list for a bigger lobby */
    let board = "";
    if (showScores && n === 2) board = `<div class="mx-a-main mx-score" role="group" aria-label="Final score">
          <div class="mx-sl you ${yn > on ? "lead" : ""}">${ava(S.me.address, 36, "you")}<span class="mx-k">You</span><b class="mx-big">${you.score == null ? "–" : esc(you.score)}</b><span class="mx-k">${esc(lab)}</span></div>
          <div class="mx-sl opp ${on > yn ? "lead" : ""}">${ava(opp.address || opp.name, 36, "opp")}<span class="mx-k mx-oname" title="${esc(opp.name)}">${esc(opp.name)}</span><b class="mx-big">${opp.score == null ? "–" : esc(opp.score)}</b><span class="mx-k">${esc(lab)}</span></div>
        </div>`;
    else if (showScores) board = `<section class="mx-a-main mx-players" aria-labelledby="stH">
          <h2 class="mx-k mx-plh" id="stH">Final standings <span class="mx-plc">${n} players</span></h2>
          <ol class="mx-pl mx-board" data-test="placements" aria-label="Final standings">${standingRows(h, m, ps, lab)}</ol>
        </section>`;
    return `<section class="mx mx-result ${esc(m.result)}" aria-labelledby="hr">
      <header class="mx-a-head">
        <p class="mx-eyebrow">${esc(m.game.name)} · ${n === 2 ? `vs ${esc(opp.name)}` : `${n} players`}</p>
        <h1 class="mx-verdict" id="hr" data-test="result">${esc(label)}</h1>
        <i class="mx-rule" aria-hidden="true"></i>
        <p class="mx-lede mx-reason">${esc(why)}</p>
      </header>
      <div class="mx-split mx-resultbody">
        ${board}
        <dl class="mx-a-terms mx-ledger" aria-label="Outcome">${rows.join("")}</dl>
      </div>
      <div class="mx-actions mx-resultactions">
        <button class="mx-btn primary lg" data-act="rematch" id="rematchBtn">Create a new lobby</button>
        <button class="mx-btn" data-act="back" id="backBtn">Back to lobby</button>
      </div>
      <div class="mx-finebox">
        ${m.seed != null ? `<p class="mx-fine">Seed #${esc(m.seed)}: the same challenge ${n === 2 ? "both players" : "every player"} got. Match #${esc(m.id)}.</p>` : ""}
        ${stake > 0n ? `<p class="mx-fine">Test ETH only, no real money.</p>` : ""}
      </div>
    </section>`;
  },
};

/* ---------- found screen (3+ players): the ready list ---------- */
const foundCount = (S, ps) => `${ps.filter((p) => isReady(S, p)).length} / ${ps.length} ready`;
const foundRows = (S, ps) => ps.map((p) => {
  const on = isReady(S, p), rating = p.ratingBefore != null ? `<span class="mx-prate"><span class="sr-only">Rating </span>${esc(p.ratingBefore)}</span>` : "";
  return `<li class="mx-pr${p.you ? " you" : ""}">${ava(p.address || p.name, 32, p.you ? "you" : "")}<span class="mx-pname">${esc(p.name)}${rating}</span><span class="mx-ptags">${chips(p)}<span class="mx-ready ${on ? "on" : ""}"><i class="mx-dot" aria-hidden="true"></i>${on ? "Ready" : "Waiting"}</span></span></li>`;
}).join("");
function foundStatus(S, ps) {
  const waiting = ps.filter((p) => !p.you && !isReady(S, p));
  if (!S.youReady) return `Press Ready before the timer runs out. The game starts a few seconds after ${ps.length === 2 ? "both of you are" : "everyone is"} ready.`;
  if (!waiting.length) return ps.length === 2 ? "Both ready. Starting…" : "Everyone is ready. Starting…";
  return waiting.length === 1 ? `Waiting for ${waiting[0].name} to press Ready…` : `Waiting for ${waiting.length} players to press Ready…`;
}
/* a player pressed Ready: update the list, the count and the status line in place (keeps focus on the Ready button).
   Returns false when this is the 2-player layout, which is simply rendered again. */
export function patchFound(ctx) {
  const { S } = ctx;
  const list = document.getElementById("fdList");
  if (!list || !S.match) return false;
  const ps = playersOf(S.match, S.me);
  const rows = foundRows(S, ps);
  if (list._html !== rows) { list._html = rows; list.innerHTML = rows; }
  const c = document.getElementById("fdCount"); if (c) c.textContent = foundCount(S, ps);
  const st = document.getElementById("foundStatus"); if (st) st.textContent = foundStatus(S, ps);
  return true;
}

/* ---------- result screen (3+ players): the placement list ---------- */
function standingRows(h, m, ps, lab) {
  const refund = m.result === "draw" || m.result === "void";
  const ranked = [...ps].sort((a, b) => (Number(a.place) || 99) - (Number(b.place) || 99) || a.seat - b.seat);
  return ranked.map((p) => {
    const paid = BigInt(p.payout || 0), staked = String(m.stake) !== "0";
    const money = !staked ? "" : refund ? "Stake returned" : paid > 0n ? `+${esc(h.eth(paid))}${NB}${esc(h.sym())}` : "";
    const note = p.forfeited ? "Forfeited" : p.score == null ? "Did not finish" : esc(lab);
    return `<li class="mx-pr mx-res${p.you ? " you" : ""}${Number(p.place) === 1 ? " first" : ""}"><span class="mx-place">${p.place ? ord(p.place) : "–"}</span>${ava(p.address || p.name, 32, p.you ? "you" : "")}<span class="mx-pname">${esc(p.name)}${p.you ? '<span class="mx-ptags"><span class="lb-chip-s you">You</span></span>' : ""}</span><span class="mx-pscore"><b class="mx-pn">${p.score == null ? "–" : esc(p.score)}</b><small>${note}</small>${money ? `<small class="mx-pay">${money}</small>` : ""}</span></li>`;
  }).join("");
}

export const actions = {};

/* The play screen is built once per match (playFrame) and then only patched (playBar) so the running game's DOM inside
   #stage is never rebuilt. Required ids: #stage (game mounts here), #countdown, #status, #forfeitArea, #playNote.
   The race shows a lane for you and one for every other player, by seat (S.seats[seat] = { score, finished, forfeited }). */
export function playFrame(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const m = S.match, ps = playersOf(m, S.me), n = ps.length;
  const others = ps.filter((p) => !p.you);
  const first = others[0] || {};
  const lane = (p) => `<div class="mx-lane ${p.you ? "you" : "opp"}"${p.you ? ' id="laneYou"' : ` data-seat="${esc(p.seat)}"`}><span class="mx-ln" title="${esc(p.you ? "You" : p.name)}">${p.you ? "You" : esc(p.name)}</span><div class="mx-track"><div class="mx-fill"${p.you ? ' id="fillYou"' : ""}></div></div><b class="mx-num"${p.you ? ' id="numYou"' : ""}><span class="mx-done" hidden>${icon("check")}<span class="sr-only">finished</span></span><span class="mx-n">0</span></b></div>`;
  return `<section class="mx mx-play" aria-label="Match: ${esc(m.game.name)}">
      <div class="mx-hud">
        <div class="mx-hudtop">
          <div class="mx-hudwho">${n === 2 ? ava(first.address || first.name, 32, "opp") : `<span class="mx-hudgroup" aria-hidden="true">${icon("users")}</span>`}<div><h1 class="mx-hudname" title="${esc(m.game.name)}">${esc(m.game.name)}</h1><span class="mx-k">${n === 2 ? `vs ${esc(first.name)}` : `${n} players`}${String(m.stake) === "0" ? " · free play" : ` · pot ${esc(h.eth(m.pot))}${NB}${esc(h.sym())}`}</span></div></div>
          <div class="mx-status" id="status" aria-live="off"></div>
          <div class="mx-forfeit" id="forfeitArea"></div>
        </div>
        <div class="mx-race${others.length > 3 ? " many" : ""}" id="race" role="group" aria-label="Live scores">
          ${lane(ps.find((p) => p.you) || { you: true })}${others.map(lane).join("")}
        </div>
      </div>
      <div class="mx-cd" id="countdown" role="timer"></div>
      <div id="stage"></div>
      <p class="mx-note" id="playNote" aria-live="polite"></p>
    </section>`;
}

export function playBar(ctx) {
  const { S } = ctx;
  const $ = (s) => document.querySelector(s);
  const fa = $("#forfeitArea");
  const mode = S.forfeited ? "out" : S.confirmForfeit ? "confirm" : "idle";
  if (fa && fa.dataset.mode !== mode) { // only touch the buttons when the mode changes, so a click is never lost to a re-render
    fa.dataset.mode = mode;
    const staked = S.match && String(S.match.stake) !== "0";
    fa.innerHTML = S.forfeited
      ? `<span class="mx-k" role="status">You forfeited</span>`
      : S.confirmForfeit
      ? `<span class="mx-confirm" role="alertdialog" aria-label="Confirm forfeit"><span class="mx-confirm-t">${staked ? "Forfeit and lose your stake?" : "Forfeit this match?"}</span><span class="mx-confirm-b"><button class="mx-btn danger sm" data-act="forfeit-yes" id="forfeitYes">Yes, forfeit</button><button class="mx-btn quiet sm" data-act="forfeit-no">Keep playing</button></span></span>`
      : `<button class="mx-btn danger sm" data-act="forfeit" id="forfeitBtn">Forfeit</button>`;
    if (mode === "confirm") { const y = $("#forfeitYes"); if (y) y.focus({ preventScroll: true }); }
  }
  const seats = S.seats || {};
  const lanes = [...document.querySelectorAll("#race .mx-lane[data-seat]")];
  const scoreOf = (l) => { const st = seats[l.dataset.seat] || {}; return st.forfeited ? 0 : Number(st.score) || 0; };
  const best = Math.max(S.myScore, ...lanes.map(scoreOf));
  const top = Math.max(1, best);
  /* one lane: bar, number (or "Out" for a forfeit), a tick once the player has submitted */
  const paint = (lane, score, { finished, forfeited }) => {
    const fill = lane.querySelector(".mx-fill"), num = lane.querySelector(".mx-n"), done = lane.querySelector(".mx-done");
    if (fill) fill.style.width = Math.min(100, (score / top) * 100) + "%";
    const t = forfeited ? "Out" : String(score);
    if (num && num.textContent !== t) num.textContent = t;
    if (done) done.hidden = !finished || forfeited;
    lane.dataset.state = forfeited ? "out" : finished ? "done" : "";
    lane.classList.toggle("lead", !forfeited && best > 0 && score === best);
  };
  const you = $("#laneYou");
  if (you) paint(you, S.myScore, { finished: S.submitted, forfeited: S.forfeited });
  const stage = $("#stage"); if (stage && stage.hidden !== !!S.forfeited) stage.hidden = !!S.forfeited; // my game stopped: no frozen board left on screen
  for (const l of lanes) paint(l, Number((seats[l.dataset.seat] || {}).score) || 0, seats[l.dataset.seat] || {});
  const note = $("#playNote");
  if (note && S.match) {
    const ps = playersOf(S.match, S.me).filter((p) => !p.you), many = ps.length > 1;
    const live = ps.filter((p) => !(seats[p.seat] || {}).finished && !(seats[p.seat] || {}).forfeited);
    const done = ps.filter((p) => (seats[p.seat] || {}).finished), out = ps.filter((p) => (seats[p.seat] || {}).forfeited);
    const parts = [];
    if (S.forfeited) parts.push(!live.length ? "You forfeited. Waiting for the final result…" : many ? `You forfeited. Waiting for the other ${live.length} ${plural(live.length, "player", "players")} to finish…` : `You forfeited. Waiting for ${live[0].name} to finish…`);
    else if (S.submitted) parts.push(!live.length ? "Result sent. Waiting for the final result…" : many ? `Result sent. Waiting for ${live.length} ${plural(live.length, "player", "players")} to finish…` : `Result sent. Waiting for ${live[0].name} to finish…`);
    else if (done.length) parts.push(many ? `${done.length} of ${ps.length} players finished.` : `${done[0].name} has finished.`);
    if (out.length) parts.push(many ? `${out.length} ${plural(out.length, "player", "players")} forfeited.` : `${out[0].name} forfeited.`);
    const t = parts.join(" ");
    if (note.textContent !== t) note.textContent = t;
  }
}

/* big 3-2-1 before the game starts; `ms` = time left. Re-rendered every ~100 ms, so the animation is phased from the real clock. */
export function countdown(ctx, ms) {
  if (!(ms > 0)) return "";
  const n = Math.ceil(ms / 1000);
  const elapsed = Math.round(n * 1000 - ms);
  return `<div class="mx-cdn" style="--ph:-${elapsed}ms"><span class="mx-cdnum" key="${n}">${n}</span><i class="mx-cdrule" aria-hidden="true"></i></div><p class="mx-cdt">Get ready. Everyone gets the same challenge.</p>`;
}
