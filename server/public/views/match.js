/* Match flow: waiting room (host) / invite (guest) → found → play → result (+ orphan when the match runs in another tab).
   All markup uses .mx-* classes styled in /play/match.css. Views are pure; live()/mount()/playBar() patch the DOM in place. */
import { icon, avatar } from "../ui.js";

const REASONS = (m) => ({
  scores: "Highest score wins.",
  forfeit: m.result === "win" ? "Your opponent forfeited." : "You forfeited.",
  timeout: m.result === "win" ? "Your opponent did not finish in time." : "You did not finish in time.",
  no_result: "Nobody submitted a result. Stakes are refunded.",
  no_show: "Someone did not press Ready. Stakes are refunded.",
  declined: "The match was declined. Stakes are refunded.",
  server_restart: "The server restarted. Stakes are refunded.",
});

const stakeText = (h, stake) => (String(stake) === "0" ? "Free play" : `${h.eth(stake)} ${h.sym()}`);
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const plural = (n, a, b) => (n === 1 ? a : b);

/* rating-based estimate (Elo expected score), clamped so it never claims certainty */
function odds(you, opp) {
  const e = 1 / (1 + 10 ** ((Number(opp) - Number(you)) / 400));
  const p = Math.min(95, Math.max(5, Math.round(e * 100)));
  return p;
}

function rulesList(g, h) {
  if (!g || !Array.isArray(g.rules) || !g.rules.length) return "";
  return `<ol class="mx-rules">${g.rules.map((r) => `<li>${h.esc(r)}</li>`).join("")}</ol>`;
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

/* money tiles shared by the waiting room and the invite screen; l = public lobby object */
function terms(h, l) {
  const { esc, eth, sym } = h;
  if (String(l.stake) === "0") return `<div class="mx-money"><div class="mx-tile"><span class="mx-k">Stake</span><b>Free play</b><small>Ratings still count.</small></div></div>`;
  const fee = BigInt(l.pot) - BigInt(l.winnerPayout);
  return `<div class="mx-money">
    <div class="mx-tile"><span class="mx-k">Stake each</span><b class="dg-mono">${eth(l.stake)} <small>${esc(sym())}</small></b></div>
    <div class="mx-tile"><span class="mx-k">Pot</span><b class="dg-mono">${eth(l.pot)} <small>${esc(sym())}</small></b></div>
    <div class="mx-tile win"><span class="mx-k">Winner receives</span><b class="dg-mono">${eth(l.winnerPayout)} <small>${esc(sym())}</small></b><small>after the ${eth(fee)} ${esc(sym())} fee</small></div>
  </div>`;
}

const spaced = (code) => String(code).replace(/(.{4})(?=.)/g, "$1 ");

export const views = {
  waiting(ctx) {
    const { S, h } = ctx; const { esc, left, game, icon: ico } = h;
    const l = S.host;
    if (!l) return `<section class="mx"><div class="mx-card mx-hero"><h2 class="mx-title" id="hw">No open lobby</h2><button class="dg-btn primary mx-btn" data-go="lobby">Back to lobby</button></div></section>`;
    const g = game(l.game.id);
    const url = ctx.inviteUrl(l.code);
    const copied = Date.now() < (S.ui.copiedUntil || 0);
    const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
    const free = String(l.stake) === "0";
    return `<section class="mx mx-waiting" aria-labelledby="hw">
      <div class="mx-card mx-hero">
        <div class="mx-radar sm" aria-hidden="true"><i class="mx-pulse p1"></i><i class="mx-pulse p2"></i><i class="mx-pulse p3"></i><i class="mx-sweep"></i><span class="mx-me">${avatar(S.me.address, 40)}</span></div>
        <p class="mx-eyebrow">Your lobby is open</p>
        <h2 class="mx-title" id="hw">Waiting for your opponent</h2>
        <p class="mx-sub">Send this link to a friend. When they open it and press Join, the duel starts.</p>
        <div class="mx-invite">
          <label class="mx-k" for="inviteLink">Invite link</label>
          <div class="mx-linkrow">
            <input class="mx-link dg-mono" id="inviteLink" type="text" readonly value="${esc(url)}" spellcheck="false" autocomplete="off">
            <button class="dg-btn primary mx-btn" id="copyInvite" data-act="copy-invite" ${copied ? 'data-copied="1"' : ""}>${ico("copy")}<span>${copied ? "Copied" : "Copy link"}</span></button>
            ${canShare ? `<button class="dg-btn mx-btn" id="shareInvite" data-act="share-invite">${ico("arrow")}<span>Share</span></button>` : ""}
          </div>
          <div class="mx-codebox"><span class="mx-k">Or tell them the code</span><b class="mx-code dg-mono" aria-label="Invite code ${esc(String(l.code).split("").join(" "))}">${esc(spaced(l.code))}</b></div>
          <div class="mx-invite-actions">
            <button type="button" class="mx-back" data-go="lobby" id="backToLobby">${ico("arrow")}<span>Back to lobby</span></button>
            <button type="button" class="lb-cancel mx-cancel" data-act="close-lobby" id="closeLobby">${free ? "Cancel lobby" : "Cancel lobby and refund my stake"}</button>
          </div>
        </div>
        <div class="mx-waitrow" role="status"><span class="mx-wa"><span class="mx-dot" aria-hidden="true"></span><span>Nobody has joined yet</span></span><span class="mx-sep" aria-hidden="true">·</span><span class="mx-wa"><span class="mx-k">link expires in</span><b class="dg-mono" data-until="${l.expiresAt}">${left(l.expiresAt)}</b></span></div>
      </div>
      <div class="mx-card mx-accept">
        <div class="mx-rh"><div><p class="mx-eyebrow">The terms</p><h3 class="mx-h3">${esc(l.game.name)}</h3></div>
          <div class="mx-chips">${g && g.duration ? `<span class="mx-chip">${ico("clock")}${esc(g.duration)}</span>` : ""}<span class="mx-chip ${free ? "" : "gold"}">${ico("bolt")}${free ? "Free play" : esc(h.eth(l.stake) + " " + h.sym() + " each")}</span></div></div>
        ${terms(h, l)}
        ${g && g.blurb ? `<p class="mx-sub">${esc(g.blurb)}</p>` : ""}
        <p class="mx-fine">${free ? "Free play. Ratings still count." : "Your stake is held until someone joins or you cancel. Test ETH only, no real money."}</p>
        <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
      </div>
      ${g ? `<div class="mx-card mx-rulescard">
        <div class="mx-rh"><div><p class="mx-eyebrow">While you wait</p><h3 class="mx-h3">How ${esc(g.name)} works</h3></div></div>
        ${rulesList(g, h)}
      </div>` : ""}
    </section>`;
  },

  invite(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, game, icon: ico } = h;
    const inv = S.invite || {}, l = inv.lobby;
    const back = `<div class="mx-actions"><button class="dg-btn primary mx-btn" id="inviteBack" data-act="dismiss-invite">Back to lobby</button></div>`;
    const stop = (title, text) => `<section class="mx mx-invite-s" aria-labelledby="hi"><div class="mx-card mx-hero" id="inviteCard">
        <div class="mx-orb" aria-hidden="true">${ico("link")}</div>
        <h2 class="mx-title" id="hi">${esc(title)}</h2>
        <p class="mx-sub mx-wide">${esc(text)}</p>
        ${back}
      </div></section>`;
    if (inv.loading && !l) return stop("Opening invite…", "Checking the invite link.");
    if (!l) return inv.error === "LOBBY_NOT_FOUND" || !inv.error
      ? stop("This invite link is not valid", "Check that you copied the whole link, or ask your friend for a new one.")
      : stop("Could not open this invite", inv.error);
    if (S.host && S.host.code === l.code) return stop("This is your own lobby", "Send the link to a friend. You cannot join your own lobby.");
    if (l.state !== "open") {
      const why = l.closedReason === "expired" ? "This invite has expired." : l.closedReason === "cancelled" ? "The host closed this lobby." : "Someone else already joined this lobby.";
      return stop("This lobby is closed", why + " Ask for a new link, or create a lobby of your own.");
    }
    const g = game(l.game.id), free = String(l.stake) === "0";
    const stake = BigInt(l.stake || 0), avail = BigInt((S.me && S.me.balances && S.me.balances.available) || 0);
    const short = !free && avail < stake ? stake - avail : 0n;
    return `<section class="mx mx-invite-s" aria-labelledby="hi">
      <div class="mx-card mx-versus" id="inviteCard">
        <p class="mx-eyebrow">${esc(l.game.name)} · private invite</p>
        <h2 class="mx-title" id="hi">${esc(l.host.name)} invited you</h2>
        <div class="mx-vs">
          <div class="mx-side you"><span class="mx-ava">${avatar(S.me.address, 88)}</span><b class="mx-name">${esc(S.me.displayName)}</b><span class="mx-k">You</span></div>
          <div class="mx-x" aria-hidden="true">VS</div>
          <div class="mx-side rival"><span class="mx-ava">${avatar(l.host.name, 88)}</span><b class="mx-name">${esc(l.host.name)}</b><span class="mx-k">Host</span></div>
        </div>
      </div>
      <div class="mx-card mx-accept">
        <div class="mx-rh"><div><p class="mx-eyebrow">The terms</p><h3 class="mx-h3">${esc(l.game.name)}</h3></div>
          <div class="mx-chips">${g && g.duration ? `<span class="mx-chip">${ico("clock")}${esc(g.duration)}</span>` : ""}<span class="mx-chip ${free ? "" : "gold"}">${ico("bolt")}${free ? "Free play" : esc(eth(l.stake) + " " + sym() + " each")}</span></div></div>
        ${g && g.blurb ? `<p class="mx-sub">${esc(g.blurb)}</p>` : ""}
        ${terms(h, l)}
        ${free ? "" : `<p class="mx-fine">Test ETH only, no real money. A draw refunds both stakes. Your stake is taken when you press Join.</p>`}
        ${short > 0n ? `<div class="mx-short" role="status"><div><b>You need ${eth(short)} ${esc(sym())} more</b><span class="mx-k">Your available balance is ${eth(avail)} ${esc(sym())}.</span></div>
          <div class="mx-actions">${S.cfg && S.cfg.devFaucet && S.wallet ? `<button class="dg-btn mx-btn" data-act="faucet" data-eth="1" id="inviteFaucet"${S.depositing ? " disabled" : ""}>${S.depositing ? "Depositing…" : `Deposit 1 test ${esc(sym())}`}</button>` : ""}<button class="dg-btn mx-btn" data-go="wallet">Open wallet</button></div></div>` : ""}
        <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
        <div class="mx-go">
          <div class="mx-gocopy"><div class="mx-actions">
            <button class="dg-btn primary mx-btn big" data-act="join-lobby" id="joinBtn" ${S.busy || short > 0n ? "disabled" : ""}>${S.busy ? "Joining…" : "Join and play"}</button>
            <button class="dg-btn mx-btn" data-act="dismiss-invite" id="inviteBack">Not now</button>
          </div></div>
        </div>
        ${g ? `<div class="mx-rulesbox"><p class="mx-k">Rules</p>${rulesList(g, h)}</div>` : ""}
      </div>
    </section>`;
  },

  queue(ctx) {
    const { S, h } = ctx; const { esc, left, game, icon: ico } = h;
    clockNow = h.now;
    const q = S.queue, g = game(q.game);
    const total = (S.cfg && S.cfg.match && S.cfg.match.queueTimeoutMs) || 120000;
    const since = Number(q.expiresAt) - total;
    const lt = liveText(S);
    return `<section class="mx mx-queue" aria-labelledby="hq">
      <div class="mx-card mx-hero">
        <div class="mx-radar" aria-hidden="true"><i class="mx-pulse p1"></i><i class="mx-pulse p2"></i><i class="mx-pulse p3"></i><i class="mx-sweep"></i><span class="mx-me">${avatar(S.me.address, 44)}</span></div>
        <p class="mx-eyebrow">Matchmaking</p>
        <h2 class="mx-title" id="hq">Finding an opponent</h2>
        <div class="mx-chips">
          <span class="mx-chip">${ico("games")}${esc(g ? g.name : q.game)}</span>
          <span class="mx-chip ${String(q.stake) === "0" ? "" : "gold"}">${ico("bolt")}${esc(stakeText(h, q.stake))}</span>
          ${q.code ? `<span class="mx-chip">${ico("link")}code <b class="dg-mono">${esc(q.code)}</b></span>` : ""}
        </div>
        <p class="mx-sub">Searching within ±60 rating, widening as you wait.</p>
        <div class="mx-times">
          <div><span class="mx-k">Elapsed</span><b class="dg-mono" data-since="${since}">${clock(Math.max(0, Math.floor((h.now() - since) / 1000)))}</b></div>
          <div><span class="mx-k">Timeout in</span><b class="dg-mono" data-until="${q.expiresAt}">${left(q.expiresAt)}</b></div>
        </div>
        <p class="mx-live" id="mxLive" ${lt ? "" : "hidden"}>${esc(lt)}</p>
        <button class="dg-btn mx-btn" data-act="cancel-queue" id="cancelQueue">Cancel and get my stake back</button>
        <p class="mx-fine">${String(q.stake) === "0" ? "Free play. Ratings still count." : "Your stake is held until the result. Test ETH only, no real money."}</p>
      </div>
      ${g ? `<div class="mx-card mx-rulescard">
        <div class="mx-rh"><div><p class="mx-eyebrow">While you wait</p><h3 class="mx-h3">How ${esc(g.name)} works</h3></div>${g.duration ? `<span class="mx-chip">${ico("clock")}${esc(g.duration)}</span>` : ""}</div>
        ${g.blurb ? `<p class="mx-sub">${esc(g.blurb)}</p>` : ""}
        ${rulesList(g, h)}
      </div>` : ""}
    </section>`;
  },

  found(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, left, game, icon: ico } = h;
    const m = S.match, g = game(m.game.id);
    const you = Number(m.you.ratingBefore), opp = Number(m.opponent.ratingBefore);
    const p = odds(you, opp), diff = you - opp;
    const free = String(m.stake) === "0";
    const acceptMs = (S.cfg && S.cfg.match && S.cfg.match.acceptMs) || 30000;
    const remain = Math.max(0, Number(m.readyDeadline) - h.now());
    const frac = Math.min(100, Math.max(0, (remain / acceptMs) * 100));
    const fee = free ? 0n : BigInt(m.pot) - BigInt(m.winnerPayout);
    const rdy = (on, name) => `<span class="mx-ready ${on ? "on" : ""}">${on ? ico("check") + "Ready" : "Not ready yet"}<span class="sr-only"> ${esc(name)}</span></span>`;
    const status = S.youReady
      ? (S.oppReady ? "Both ready. Starting…" : `Waiting for ${esc(m.opponent.name)} to press Ready…`)
      : "Press Ready before the timer runs out. The game starts a few seconds after both of you are ready.";
    return `<section class="mx mx-found" aria-labelledby="hf">
      <div class="mx-card mx-versus">
        <p class="mx-eyebrow">${esc(m.game.name)}</p>
        <h2 class="mx-title" id="hf">Opponent found</h2>
        <div class="mx-vs">
          <div class="mx-side you">
            <span class="mx-ava">${avatar(S.me.address, 88)}</span>
            <b class="mx-name">${esc(S.me.displayName)}</b>
            <span class="mx-rating dg-mono">${esc(you)}</span>
            ${rdy(S.youReady, "you")}
          </div>
          <div class="mx-x" aria-hidden="true">VS</div>
          <div class="mx-side rival">
            <span class="mx-ava">${avatar(m.opponent.name, 88)}</span>
            <b class="mx-name">${esc(m.opponent.name)}</b>
            <span class="mx-rating dg-mono">${esc(opp)}</span>
            ${rdy(S.oppReady, m.opponent.name)}
          </div>
        </div>
        <div class="mx-odds" role="img" aria-label="Rough odds from ratings: you ${p} percent, ${esc(m.opponent.name)} ${100 - p} percent">
          <div class="mx-oddsbar"><i style="width:${p}%"></i></div>
          <div class="mx-oddsrow"><span class="dg-gold">You ${p}%</span><span class="mx-k">${diff === 0 ? "Evenly rated" : diff > 0 ? `You are rated ${diff} higher` : `${-diff} higher rated than you`} · rough odds from ratings${g && Number(g.luck) >= 6 ? ", luck matters a lot here" : ""}</span><span class="dg-rival">${100 - p}%</span></div>
        </div>
      </div>
      <div class="mx-card mx-accept">
        <div class="mx-money">
          ${free
            ? `<div class="mx-tile"><span class="mx-k">Stake</span><b>Free play</b><small>Ratings still count.</small></div>`
            : `<div class="mx-tile"><span class="mx-k">Stake each</span><b class="dg-mono">${eth(m.stake)} <small>${esc(sym())}</small></b></div>
               <div class="mx-tile"><span class="mx-k">Pot</span><b class="dg-mono">${eth(m.pot)} <small>${esc(sym())}</small></b></div>
               <div class="mx-tile win"><span class="mx-k">Winner receives</span><b class="dg-mono">${eth(m.winnerPayout)} <small>${esc(sym())}</small></b><small>after the ${eth(fee)} ${esc(sym())} fee</small></div>`}
        </div>
        ${free ? "" : `<p class="mx-fine">Test ETH only, no real money. A draw refunds both stakes.</p>`}
        ${g ? `<div class="mx-rulesbox"><p class="mx-k">Rules</p>${rulesList(g, h)}</div>` : ""}
        <div class="mx-go">
          <div class="mx-timer" style="--from:${(100 - frac).toFixed(2)};--dur:${Math.round(remain)}ms" role="timer" aria-label="Time left to accept">
            <svg viewBox="0 0 44 44" aria-hidden="true"><circle class="t" cx="22" cy="22" r="19" pathLength="100"/><circle class="f" cx="22" cy="22" r="19" pathLength="100"/></svg>
            <span class="dg-mono" data-until="${m.readyDeadline}">${left(m.readyDeadline)}</span>
          </div>
          <div class="mx-gocopy"><p class="mx-status" aria-live="polite">${status}</p>
            <div class="mx-err" id="err" role="alert">${esc(S.error)}</div>
            <div class="mx-actions">
              <button class="dg-btn primary mx-btn big" data-act="ready" id="readyBtn" ${S.youReady ? "disabled" : ""}>${S.youReady ? "Waiting…" : "Ready"}</button>
              <button class="dg-btn mx-btn" data-act="decline" id="declineBtn">Decline</button>
            </div>
          </div>
        </div>
      </div>
    </section>`;
  },

  orphan(ctx) {
    const { S, h } = ctx; const { esc, left } = h;
    const m = S.match;
    return `<section class="mx mx-orphan" aria-labelledby="ho">
      <div class="mx-card mx-hero">
        <div class="mx-orb" aria-hidden="true">${icon("bolt")}</div>
        <p class="mx-eyebrow">${esc(m.game.name)}</p>
        <h2 class="mx-title" id="ho">Match in progress</h2>
        <p class="mx-sub mx-wide">Your match against <b>${esc(m.opponent.name)}</b> is running, but the challenge is only delivered once, to the page that pressed Ready, so it cannot be resumed here. If you play it in another tab you can ignore this. Otherwise forfeit, or the match ends by itself at the deadline.</p>
        <div class="mx-times"><div><span class="mx-k">Deadline in</span><b class="dg-mono" data-until="${m.submitDeadline}">${left(m.submitDeadline)}</b></div></div>
        <button class="dg-btn danger mx-btn" data-act="forfeit-now" id="forfeitNow">Forfeit this match</button>
      </div>
    </section>`;
  },

  result(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, game, icon: ico } = h;
    const m = S.result;
    const you = m.you, opp = m.opponent;
    const label = { win: "Victory", loss: "Defeat", draw: "Draw", void: "Match cancelled" }[m.result] || m.result;
    const why = REASONS(m)[m.reason] || "";
    const lab = m.game.scoreLabel;
    const hasRating = you.ratingAfter != null && m.result !== "void";
    const delta = hasRating ? Number(you.ratingAfter) - Number(you.ratingBefore) : 0;
    const stake = BigInt(m.stake || 0), got = BigInt(you.payout || 0);
    const net = m.result === "void" || m.result === "draw" ? 0n : got - stake;
    const abs = net < 0n ? -net : net;
    const showScores = m.result !== "void" && (you.score != null || opp.score != null);
    const yn = Number(you.score), on = Number(opp.score);
    const burst = m.result === "win" ? `<div class="mx-burst" aria-hidden="true">${Array.from({ length: 28 }, (_, i) => `<i style="--a:${(i * 360 / 28 + (i % 3) * 7).toFixed(1)}deg;--d:${120 + ((i * 53) % 150)}px;--t:${(i % 7) * 40}ms;--c:${["#F5C94A", "#FFE27A", "#F4F4F5", "#D9A52E", "#5AD690"][i % 5]};--w:${5 + (i % 3) * 2}px"></i>`).join("")}</div>` : "";
    const g = game(m.game.id);
    let money = "";
    if (stake > 0n) {
      if (net > 0n) money = `<div class="mx-tile good"><span class="mx-k">You won</span><b class="dg-mono">+<span data-count="${abs}">${eth(abs)}</span> <small>${esc(sym())}</small></b></div>`;
      else if (net < 0n) money = `<div class="mx-tile"><span class="mx-k">Stake lost</span><b class="dg-mono">−<span data-count="${abs}">${eth(abs)}</span> <small>${esc(sym())}</small></b></div>`;
      else money = `<div class="mx-tile"><span class="mx-k">Money</span><b class="dg-mono">±0 <small>${esc(sym())}</small></b><small>Your ${eth(stake)} ${esc(sym())} stake was returned.</small></div>`;
    } else money = `<div class="mx-tile"><span class="mx-k">Stake</span><b>Free play</b></div>`;
    return `<section class="mx mx-result ${esc(m.result)}" aria-labelledby="hr">
      <div class="mx-card mx-hero">
        ${burst}
        <p class="mx-eyebrow">${esc(m.game.name)} · vs ${esc(opp.name)}</p>
        <h2 class="mx-verdict" id="hr" data-test="result">${esc(label)}</h2>
        <p class="mx-sub mx-reason">${esc(why)}</p>
        ${showScores ? `<div class="mx-score" aria-label="Final score">
          <div class="mx-sl you ${yn > on ? "lead" : ""}"><span class="mx-ava">${avatar(S.me.address, 40)}</span><span class="mx-k">You</span><b class="dg-mono">${you.score == null ? "–" : esc(you.score)}</b><span class="mx-k">${esc(lab)}</span></div>
          <div class="mx-dash" aria-hidden="true">vs</div>
          <div class="mx-sl rival ${on > yn ? "lead" : ""}"><span class="mx-ava">${avatar(opp.name, 40)}</span><span class="mx-k" title="${esc(opp.name)}">${esc(opp.name)}</span><b class="dg-mono">${opp.score == null ? "–" : esc(opp.score)}</b><span class="mx-k">${esc(lab)}</span></div>
        </div>` : ""}
        <div class="mx-tiles">
          ${money}
          ${hasRating ? `<div class="mx-tile"><span class="mx-k">Rating</span><b class="dg-mono">${esc(you.ratingBefore)} <span class="mx-arrow">→</span> ${esc(you.ratingAfter)}${delta ? ` <span class="${delta > 0 ? "dg-good" : "mx-muted"} mx-delta">${delta > 0 ? "+" : "−"}${Math.abs(delta)}</span>` : ""}</b></div>` : ""}
        </div>
        <div class="mx-actions">
          <button class="dg-btn primary mx-btn big" data-act="rematch" id="rematchBtn">Create a new lobby</button>
          <button class="dg-btn mx-btn big" data-act="back" id="backBtn">Back to lobby</button>
        </div>
        ${m.seed != null ? `<p class="mx-fine dg-mono">Seed #${esc(m.seed)}: the same challenge both players got. Match #${esc(m.id)}.${g ? "" : ""}</p>` : ""}
        ${stake > 0n ? `<p class="mx-fine">Test ETH only, no real money.</p>` : ""}
      </div>
    </section>`;
  },
};

export const actions = {};

/* count the money tile up from zero once per finished match; the markup already holds the correct final text */
export function mount(name, app) {
  if (name !== "result" || !app.S.result) return;
  const id = app.S.result.id;
  if (app.S.ui.mxCounted === id) return;
  app.S.ui.mxCounted = id;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  for (const el of document.querySelectorAll("[data-count]")) {
    let to;
    try { to = BigInt(el.dataset.count); } catch { continue; }
    const final = el.textContent, t0 = performance.now(), dur = 1100;
    const step = (t) => {
      if (!el.isConnected) return;
      const k = Math.min(1, (t - t0) / dur), e = 1 - (1 - k) ** 3;
      if (k >= 1) { el.textContent = final; return; }
      el.textContent = app.h.eth((to * BigInt(Math.round(e * 1000))) / 1000n);
      requestAnimationFrame(step);
    };
    el.textContent = app.h.eth(0n);
    requestAnimationFrame(step);
  }
}

/* The play screen is built once per match (playFrame) and then only patched (playBar) so the running game's DOM inside
   #stage is never rebuilt. Required ids: #stage (game mounts here), #countdown, #status, #forfeitArea, #playNote. */
export function playFrame(ctx) {
  const { S, h } = ctx; const { esc } = h;
  const m = S.match;
  return `<section class="mx mx-play" aria-label="Match: ${esc(m.game.name)}">
      <div class="mx-hud">
        <div class="mx-hudtop">
          <div class="mx-hudwho"><span class="mx-ava">${avatar(m.opponent.name, 28)}</span><div><b title="${esc(m.game.name)}">${esc(m.game.name)}</b><span class="mx-k">vs ${esc(m.opponent.name)}${String(m.stake) === "0" ? " · free play" : ` · pot ${esc(h.eth(m.pot))} ${esc(h.sym())}`}</span></div></div>
          <div class="mx-status dg-mono" id="status" aria-live="off"></div>
          <div class="mx-forfeit" id="forfeitArea"></div>
        </div>
        <div class="mx-race" id="race" role="group" aria-label="Live scores">
          <div class="mx-lane you"><span class="mx-ln">You</span><div class="mx-track"><div class="mx-fill" id="fillYou"></div></div><b class="dg-mono" id="numYou">0</b></div>
          <div class="mx-lane rival"><span class="mx-ln" title="${esc(m.opponent.name)}">${esc(m.opponent.name)}</span><div class="mx-track"><div class="mx-fill" id="fillOpp"></div></div><b class="dg-mono" id="numOpp">0</b></div>
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
  const mode = S.confirmForfeit ? "confirm" : "idle";
  if (fa && fa.dataset.mode !== mode) { // only touch the buttons when the mode changes, so a click is never lost to a re-render
    fa.dataset.mode = mode;
    const staked = S.match && String(S.match.stake) !== "0";
    fa.innerHTML = S.confirmForfeit
      ? `<span class="mx-confirm" role="alertdialog" aria-label="Confirm forfeit"><span class="mx-confirm-t">${staked ? "Forfeit and lose your stake?" : "Forfeit this match?"}</span><button class="dg-btn danger mx-sm" data-act="forfeit-yes" id="forfeitYes">Yes, forfeit</button><button class="dg-btn mx-sm" data-act="forfeit-no">Keep playing</button></span>`
      : `<button class="dg-btn danger mx-sm" data-act="forfeit" id="forfeitBtn">Forfeit</button>`;
    if (mode === "confirm") { const y = $("#forfeitYes"); if (y) y.focus({ preventScroll: true }); }
  }
  const top = Math.max(1, S.myScore, S.oppScore);
  const set = (id, v) => { const el = $(id); if (el) el.style.width = Math.min(100, (v / top) * 100) + "%"; };
  set("#fillYou", S.myScore); set("#fillOpp", S.oppScore);
  const ny = $("#numYou"), no = $("#numOpp");
  if (ny) ny.textContent = S.myScore;
  if (no) no.textContent = S.oppScore;
  const race = $("#race");
  if (race) race.dataset.lead = S.myScore === S.oppScore ? "" : S.myScore > S.oppScore ? "you" : "rival";
  const note = $("#playNote");
  if (note) note.textContent = S.submitted ? `Result sent. Waiting for ${S.match.opponent.name} to finish…` : S.oppFinished ? `${S.match.opponent.name} has finished.` : "";
}

/* big 3-2-1 before the game starts; `ms` = time left. Re-rendered every ~100 ms, so the animation is phased from the real clock. */
export function countdown(ctx, ms) {
  if (!(ms > 0)) return "";
  const n = Math.ceil(ms / 1000);
  const elapsed = Math.round(n * 1000 - ms);
  return `<div class="mx-cdn" style="--ph:-${elapsed}ms"><span class="mx-num" key="${n}">${n}</span></div><p class="mx-cdt">Get ready. Both players get the same challenge.</p>`;
}
