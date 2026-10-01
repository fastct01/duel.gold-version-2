/* Account pages: wallet, history, leaderboard, responsible play. Styles live in account.css. */
import { icon, avatar } from "../ui.js";

const RESULT_LABEL = { win: "Win", loss: "Loss", draw: "Draw", void: "Cancelled" };

const sign = (wei, eth) => (wei > 0n ? `+${eth(wei)}` : wei < 0n ? `−${eth(-wei)}` : "±0");
const cls = (wei) => (wei > 0n ? "dg-good" : wei < 0n ? "dg-bad" : "dg-muted");
const when = (t) => (t ? new Date(Number(t)).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "");

/* net change of one finished match for the viewer, in wei (BigInt) */
function netOf(m) {
  const stake = BigInt(m.stake || 0);
  if (m.result === "win") return BigInt(m.you.payout != null ? m.you.payout : m.winnerPayout || 0) - stake;
  if (m.result === "loss") return -stake;
  return 0n;
}

function header(title, text) {
  return `<header class="page-h"><h1>${title}</h1><p>${text}</p></header>`;
}

export const views = {
  /* ------------------------------------------------------------------ wallet */
  wallet(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, short, ago } = h;
    const me = S.me, w = S.wallet, cfg = S.cfg;
    const wd = w && w.withdrawals ? w.withdrawals : [];
    const deps = w && w.deposits ? w.deposits : [];
    const depAmt = S.ui.depAmt || "1";
    const amtChip = (v) => `<button type="button" class="dg-chip dg-mono" data-act="dep-amt" data-v="${v}" aria-pressed="${depAmt === v}">${v}</button>`;
    const lim = (w && w.limits) || (cfg && cfg.withdrawal) || null;
    const conf = w ? w.chain.confirmations : 1;
    return `${header("Wallet", `Your play balance on ${esc(w ? w.chain.name : "the test network")}. Test ${esc(sym())} only, with no real-world value.`)}
    <section class="dg-box dg-stack" aria-labelledby="hBal">
      <h2 class="dg-h sr-only" id="hBal">Balances</h2>
      <div class="bal">
        <div class="dg-stat">Available<b class="dg-mono" id="balAvail" aria-live="polite">${eth(me.balances.available)}</b><span class="unit">${esc(sym())}</span></div>
        <div class="dg-stat">In play<b class="dg-mono">${eth(me.balances.inPlay)}</b><span class="unit">staked in matches</span></div>
        <div class="dg-stat">Withdrawing<b class="dg-mono">${eth(me.balances.pendingWithdrawal)}</b><span class="unit">on its way out</span></div>
      </div>
    </section>
    ${w ? `<div class="grid2">
      <section class="dg-box dg-stack" aria-labelledby="hDep">
        <h2 class="dg-h" id="hDep">${icon("plus")}<span>Deposit</span></h2>
        ${cfg.devFaucet ? `<div class="field"><span class="label" id="depAmtL">Amount (test ${esc(sym())})</span>
          <div class="chips dep-amts" role="group" aria-labelledby="depAmtL">${amtChip("0.1")}${amtChip("0.5")}${amtChip("1")}</div></div>` : ""}
        <div class="field"><span class="label">Your deposit address on ${esc(w.chain.name)}</span>
          <div class="mono-box" id="depositAddr" data-test="deposit-address">${esc(w.depositAddress)}</div></div>
        <div class="dg-row dep-acts"><button class="dg-btn" data-act="copy">${icon("copy")}<span>Copy address</span></button>
          ${cfg.devFaucet ? `<button class="dg-btn primary" data-act="faucet" data-eth="${esc(depAmt)}" id="faucetBtn"${S.depositing ? " disabled" : ""}>${icon("plus")}<span>${S.depositing ? `Depositing ${esc(S.depositing)} test ${esc(sym())}…` : `Deposit ${esc(depAmt)} ${esc(sym())}`}</span></button>` : ""}</div>
        <ul class="notes">
          <li>Send test ${esc(sym())} from a normal wallet, not a smart-contract wallet.</li>
          <li>Deposits are credited after ${conf} confirmation${conf > 1 ? "s" : ""}, so they can take a moment to show up.</li>
          ${cfg.devFaucet ? `<li>Deposit sends free test ${esc(sym())} from the test faucet to this address. It counts once it is confirmed, like any deposit.</li>` : ""}
        </ul>
      </section>

      <section class="dg-box dg-stack" aria-labelledby="hWd">
        <h2 class="dg-h" id="hWd">${icon("out")}<span>Withdraw</span></h2>
        <form data-form="withdraw" class="dg-stack" autocomplete="off">
          <div class="field"><label for="wdAmt">Amount (${esc(sym())})</label>
            <div class="inline-form"><input id="wdAmt" type="text" inputmode="decimal" placeholder="${lim ? esc(eth(lim.min)) : "0.01"}" aria-describedby="wdHint wdErr"><button class="dg-btn" type="button" data-act="wd-max">Max</button><button class="dg-btn primary" type="submit" id="wdBtn">Withdraw</button></div></div>
          <div class="err" id="wdErr" role="alert"></div>
          <p class="dg-note" id="wdHint">${lim ? `Minimum ${eth(lim.min)} ${esc(sym())}, up to ${eth(lim.max)} per withdrawal and ${eth(lim.dailyCap)} per day. ` : ""}Payouts go only to the wallet you signed in with: <span class="dg-mono" title="${esc(w.withdrawTo)}">${esc(short(w.withdrawTo))}</span>.</p>
        </form>
      </section>
    </div>

    <section class="dg-box dg-stack" aria-labelledby="hDepl">
      <h2 class="dg-h" id="hDepl">Recent deposits</h2>
      ${deps.length ? `<div class="list" aria-label="Recent deposits">${deps.slice(0, 10).map((d) => `<div class="row wd-row">
        <div class="wd-main"><b class="dg-mono">+${eth(d.amount)} ${esc(sym())}</b><span class="sub">${esc(ago(d.creditedAt))}${d.blockNumber != null ? ` · block ${esc(d.blockNumber)}` : ""}</span></div>
        <div class="wd-side"><span class="rpill win">credited</span>${d.explorerUrl ? `<a class="sub" href="${esc(d.explorerUrl)}" target="_blank" rel="noopener">View transaction</a>` : ""}</div>
      </div>`).join("")}</div>` : `<p class="dg-note">No deposits yet. Each deposit shows up here once it is confirmed and credited to your balance.</p>`}
    </section>

    <section class="dg-box dg-stack" aria-labelledby="hWdl">
      <h2 class="dg-h" id="hWdl">Recent withdrawals</h2>
      ${wd.length ? `<div class="list" aria-label="Recent withdrawals">${wd.slice(0, 10).map((x) => `<div class="row wd-row">
        <div class="wd-main"><b class="dg-mono">${eth(x.amount)} ${esc(sym())}</b><span class="sub">${esc(ago(x.createdAt))} · to <span title="${esc(x.to)}">${esc(short(x.to))}</span></span>${x.status === "failed" && x.error ? `<span class="sub dg-bad">${esc(x.error)}</span>` : ""}</div>
        <div class="wd-side"><span class="rpill ${x.status === "confirmed" ? "win" : x.status === "failed" ? "loss" : "draw"}">${esc(x.status)}</span>${x.explorerUrl ? `<a class="sub" href="${esc(x.explorerUrl)}" target="_blank" rel="noopener">View tx ${icon("link")}</a>` : ""}</div>
      </div>`).join("")}</div>` : `<p class="dg-note">No withdrawals yet. When you withdraw, each one shows up here with its status and a link to the transaction.</p>`}
    </section>` : `<section class="dg-box"><p class="dg-note">The wallet is not enabled on this server.</p></section>`}`;
  },

  /* ------------------------------------------------------------------ history */
  history(ctx) {
    const { S, h } = ctx; const { esc, eth, sym, ago } = h;
    const head = header("History", `Your last 30 matches. Every finished match reveals its seed so you can replay and check it.`);
    if (S.history == null) {
      return `${head}<div class="hist-sum" aria-hidden="true">${Array.from({ length: 4 }, () => `<span class="skel hs-skel"></span>`).join("")}</div>
        <section class="dg-box dg-stack hist-card" aria-busy="true"><span class="sr-only">Loading history</span><ul class="hist" aria-hidden="true">${Array.from({ length: 4 }, () => `<li class="hrow-skel"><span class="skel"></span></li>`).join("")}</ul></section>`;
    }
    const done = S.history.filter((m) => m.result);
    let w = 0, l = 0, d = 0, v = 0, net = 0n, best = 0, run = 0;
    for (const m of done) { if (m.result === "win") w++; else if (m.result === "loss") l++; else if (m.result === "draw") d++; else v++; net += netOf(m); }
    for (const m of [...done].reverse()) { if (m.result === "win") { run++; best = Math.max(best, run); } else if (m.result !== "void") run = 0; }
    const strip = `<div class="hist-sum">
      <div class="dg-stat">Played<b class="dg-mono">${w + l + d}</b><span class="unit">${v ? `${v} cancelled` : "finished matches"}</span></div>
      <div class="dg-stat">Record<b class="dg-mono"><span class="dg-good">${w}</span><i>-</i><span class="dg-bad">${l}</span><i>-</i><span class="dg-gold">${d}</span></b><span class="unit">wins, losses, draws</span></div>
      <div class="dg-stat">Net<b class="dg-mono ${cls(net)}">${sign(net, eth)}</b><span class="unit">${esc(sym())} in this list</span></div>
      <div class="dg-stat">Best streak<b class="dg-mono">${best}</b><span class="unit">wins in a row</span></div>
    </div>`;
    if (!done.length) {
      return `${head}${strip}<section class="dg-box dg-stack dg-center"><h2 class="dg-h">No matches yet</h2><p class="dg-note">Your finished matches will be listed here with scores, rating changes and the seed for each one.</p><div><button class="dg-btn primary" data-go="lobby">Find an opponent</button></div></section>`;
    }
    const rows = done.map((m) => {
      const you = m.you || {}, opp = m.opponent || {};
      const net = netOf(m), staked = BigInt(m.stake || 0) > 0n;
      const dr = you.ratingAfter != null && you.ratingBefore != null ? you.ratingAfter - you.ratingBefore : null;
      const label = (m.game && m.game.scoreLabel) || "score";
      return `<li class="hrow ${esc(m.result)}">
        <div class="h-who"><span class="h-ava">${avatar(opp.address || opp.name, 40)}</span><div><b title="${esc(m.game ? m.game.name : "Game")}">${esc(m.game ? m.game.name : "Game")}</b><span class="sub">vs <span class="h-opp" title="${esc(opp.name || "Opponent")}">${esc(opp.name || "Opponent")}</span>${m.private ? ` <span class="h-tag">private</span>` : ""}</span></div></div>
        <div class="h-res"><span class="rpill ${esc(m.result)}">${esc(RESULT_LABEL[m.result] || m.result)}</span></div>
        <div class="h-score dg-mono" title="Your ${esc(label)} against theirs"><b>${you.score != null ? esc(you.score) : "–"}</b><i>vs</i><span>${opp.score != null ? esc(opp.score) : "–"}</span></div>
        <div class="h-net"><b class="dg-mono ${staked ? cls(net) : "dg-muted"}">${staked ? sign(net, eth) + " " + esc(sym()) : "Free play"}</b>${dr != null && dr !== 0 ? `<span class="sub dg-mono ${dr > 0 ? "dg-good" : "dg-bad"}">${dr > 0 ? "+" : "−"}${Math.abs(dr)} rating</span>` : `<span class="sub">${dr === 0 ? "rating unchanged" : ""}</span>`}</div>
        <div class="h-when sub" title="${esc(when(m.settledAt))}">${m.settledAt ? esc(ago(m.settledAt)) : ""}</div>
        <div class="h-proof sub dg-mono">Match #${esc(m.id)}${m.seed != null ? ` · seed ${esc(m.seed)}` : ""}${m.result === "void" && m.reason ? ` · ${esc(m.reason)}` : ""}</div>
      </li>`;
    }).join("");
    return `${head}${strip}<section class="dg-box dg-stack hist-card" aria-labelledby="hHl"><h2 class="dg-h sr-only" id="hHl">Finished matches</h2><ul class="hist" aria-label="Match history">${rows}</ul></section>`;
  },

  /* ------------------------------------------------------------------ leaderboard */
  leaderboard(ctx) {
    const { S, h } = ctx; const { esc } = h;
    const gid = S.pick.game, g = h.game(gid);
    const head = header("Leaderboard", "Rankings come from rated matches against real players. Everyone starts from the same rating.");
    if (!S.games.length) return `${head}<section class="dg-box"><p class="dg-note">No games are available yet.</p></section>`;
    const cats = {};
    for (const x of S.games) (cats[x.category] = cats[x.category] || []).push(x);
    const opts = Object.keys(cats).sort().map((c) => `<optgroup label="${esc(h.cap(c))}">${cats[c].map((x) => `<option value="${esc(x.id)}" ${x.id === gid ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</optgroup>`).join("");
    const picker = `<div class="field board-pick"><label for="boardSel">Game</label><select id="boardSel">${opts}</select></div>`;
    const rows = S.boards[gid];
    const mine = (S.me && S.me.ratings || []).find((r) => r.game === gid);
    const you = mine && (mine.wins + mine.losses + mine.draws) > 0
      ? `<div class="you-strip tile"><span>Your rating${g ? ` in ${esc(g.name)}` : ""}</span><b class="dg-mono">${mine.rating}</b><span class="sub dg-mono">${mine.wins}-${mine.losses}-${mine.draws}${mine.best ? ` · best ${mine.best}` : ""}</span></div>` : "";
    let body;
    if (rows == null) body = `<div class="dg-stack" aria-busy="true"><span class="sr-only">Loading leaderboard</span><div class="podium">${[0, 1, 2].map(() => `<span class="skel" style="height:150px"></span>`).join("")}</div>${[0, 1, 2, 3].map(() => `<span class="skel" style="height:56px"></span>`).join("")}</div>`;
    else if (!rows.length) body = `<div class="dg-center dg-stack"><h2 class="dg-h">Nobody is ranked yet</h2><p class="dg-note">Play a match in ${g ? esc(g.name) : "this game"} to claim the first spot.</p><div><button class="dg-btn primary" data-go="lobby">Find an opponent</button></div></div>`;
    else {
      const isMe = (p) => S.me && p.player && p.player.id === S.me.id;
      const ava = (p, n) => avatar(isMe(p) ? S.me.address : p.player.address || p.player.name, n);
      const top = rows.slice(0, 3);
      const pod = top.map((p) => `<article class="pod p${p.rank} ${isMe(p) ? "me" : ""}" ${isMe(p) ? 'aria-current="true"' : ""}>
          <span class="pod-rank" aria-label="Rank ${p.rank}">${p.rank}</span>
          <span class="pod-ava">${ava(p, 56)}</span>
          <b class="pod-name">${esc(p.player.name)}${isMe(p) ? ` <i class="you-tag">you</i>` : ""}</b>
          <span class="pod-rating dg-mono">${p.rating}</span>
          <span class="sub dg-mono">${p.wins}-${p.losses}-${p.draws}</span>
        </article>`).join("");
      const rest = rows.slice(3).map((p) => `<li class="lrow ${isMe(p) ? "me" : ""}" ${isMe(p) ? 'aria-current="true"' : ""}>
          <span class="l-rank dg-mono">${p.rank}</span>
          <span class="l-ava">${ava(p, 36)}</span>
          <span class="l-name"><b>${esc(p.player.name)}${isMe(p) ? ` <i class="you-tag">you</i>` : ""}</b><span class="sub dg-mono">${esc(p.player.address || "")}</span></span>
          <span class="l-rec sub dg-mono" title="Wins, losses, draws">${p.wins}-${p.losses}-${p.draws}</span>
          <span class="l-rating dg-mono">${p.rating}</span>
        </li>`).join("");
      body = `<div class="podium n${top.length}">${pod}</div>${rest ? `<ol class="lboard" start="4" aria-label="Ranks 4 and below">${rest}</ol>` : ""}`;
    }
    return `${head}<section class="dg-box dg-stack" aria-labelledby="hBoard">
      <div class="board-top"><h2 class="dg-h" id="hBoard">${g ? esc(g.name) : "Rankings"}</h2>${picker}</div>
      ${you}${body}
    </section>`;
  },

  /* ------------------------------------------------------------------ responsible play */
  settings(ctx) {
    const { S, h } = ctx; const { esc, eth, sym } = h;
    const me = S.me, r = me.responsible;
    const limit = r.lossLimit ? BigInt(r.lossLimit) : null;
    const lost = BigInt(r.lossToday || 0);
    const pct = limit && limit > 0n ? Math.min(100, Number((lost * 100n) / limit)) : 0;
    return `${header("Account", `Tools to keep play fun and in check. They are real controls, and they work the same way when you play for stakes. Everything here is test ${esc(sym())}, with no real money.`)}
    <div class="grid2">
      <section class="dg-box dg-stack" aria-labelledby="hLim">
        <h2 class="dg-h" id="hLim">Daily loss limit</h2>
        <p class="dg-note">The most you can lose in a day. Once you reach it, staked play pauses until the day resets. Lowering it applies straight away. Raising or removing it takes 24 hours, so a bad moment cannot undo it.</p>
        <div class="limit-now tile">
          <div><span class="sub">Current limit</span><b class="dg-mono">${limit ? `${eth(limit)} ${esc(sym())}` : "Off"}</b></div>
          <div><span class="sub">Lost today</span><b class="dg-mono ${lost > 0n ? "dg-bad" : ""}">${eth(lost)} ${esc(sym())}</b></div>
        </div>
        ${limit ? `<div class="meter-bar" role="img" aria-label="${pct}% of the daily limit used"><i style="width:${pct}%" class="${pct >= 100 ? "full" : pct >= 75 ? "high" : ""}"></i></div>` : ""}
        ${r.pending ? `<div class="notice" role="status">${icon("clock")}<span>Change pending: ${r.pending.lossLimit ? `limit becomes ${eth(r.pending.lossLimit)} ${esc(sym())}` : "limit turns off"} on ${esc(when(r.pending.effectiveAt))}.</span></div>` : ""}
        <form data-form="limit" class="dg-stack" autocomplete="off">
          <div class="field"><label for="limitAmt">${limit ? "Change limit" : "Set a limit"} (${esc(sym())} per day)</label>
            <div class="inline-form"><input id="limitAmt" type="text" inputmode="decimal" placeholder="0.02" aria-describedby="limErr"><button class="dg-btn primary" type="submit" id="limBtn">${limit ? "Update limit" : "Set limit"}</button></div></div>
          <div class="err" id="limErr" role="alert"></div>
        </form>
        ${limit || r.pending ? `<div><button class="dg-btn" type="button" data-act="limit-off">Turn off the limit</button></div>` : ""}
      </section>

      <section class="dg-box dg-stack" aria-labelledby="hAcct">
        <h2 class="dg-h" id="hAcct">Your account</h2>
        <div class="acct-card tile"><span class="acct-ava">${avatar(me.address, 52)}</span><div><b>${esc(me.displayName)}</b><span class="dg-mono sub" title="${esc(me.address)}">${esc(h.short(me.address))}</span></div></div>
        <form class="dg-stack" data-name-form autocomplete="off">
          <div class="field"><label for="nameIn">Display name</label>
            <div class="inline-form"><input id="nameIn" type="text" maxlength="20" value="${esc(me.displayName)}" aria-describedby="nameHint nameErr"><button class="dg-btn" type="submit" id="nameBtn">Save</button></div></div>
          <div class="err" id="nameErr" role="alert"></div>
          <p class="dg-note" id="nameHint">3 to 20 characters: letters, numbers, spaces, dot, dash or underscore. Other players see this name.</p>
        </form>
        <div><button class="dg-btn danger" data-act="logout">${icon("out")}<span>Sign out</span></button></div>
      </section>
    </div>`;
  },
};

/* ---------------------------------------------------------------------- hooks */

let appRef = null;
export function mount(view, app) {
  appRef = app;
  const { S } = app;
  if (view === "leaderboard" && S.pick.game && S.boards[S.pick.game] == null && S.ui.boardLoading !== S.pick.game) {
    S.ui.boardLoading = S.pick.game;
    Promise.resolve(app.loadBoard(S.pick.game)).finally(() => { if (S.ui.boardLoading === S.pick.game) S.ui.boardLoading = null; });
  }
}

export function onChange(e, app) {
  if (e.target.id !== "boardSel") return false;
  app.S.pick.game = e.target.value;
  app.render(true);
  app.loadBoard(e.target.value);
  return true;
}

export const actions = {
  /* deposit amount on the wallet page (the faucet sends at most 1 test ETH per deposit) */
  "dep-amt": async (el, app) => { app.S.ui.depAmt = el.dataset.v; app.render(true); },
  /* fill the withdraw box with the most the player can take out in one go (their balance, capped by the per-withdrawal maximum) */
  "wd-max": async (el, app) => {
    const { S, h } = app;
    let amt = BigInt(S.me.balances.available || 0);
    const cap = S.cfg && S.cfg.withdrawal && S.cfg.withdrawal.max ? BigInt(S.cfg.withdrawal.max) : null;
    if (cap != null && amt > cap) amt = cap;
    const inp = document.getElementById("wdAmt");
    if (inp) { inp.value = amt > 0n ? window.ethers.formatEther(amt) : ""; inp.focus(); }
  },
};

/* display-name form: the core owns [data-form], so this one uses its own marker and handler */
document.addEventListener("submit", async (e) => {
  const form = e.target.closest("[data-name-form]");
  if (!form) return;
  e.preventDefault();
  const app = appRef;
  if (!app) return;
  const err = document.getElementById("nameErr"), btn = document.getElementById("nameBtn");
  err.textContent = "";
  btn.disabled = true;
  try {
    const r = await app.api("PATCH", "/v1/me", { displayName: document.getElementById("nameIn").value });
    app.toast(`Display name saved: ${r.displayName}`, "good");
    await app.refreshMe();
    app.render(true);
  } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
});

/* amount check for the core's withdraw and loss-limit forms, before app.js submits them: ethers' parse errors are not for people */
document.addEventListener("submit", (e) => {
  const form = e.target.closest('[data-form="withdraw"],[data-form="limit"]');
  if (!form) return;
  const inp = form.querySelector("input"), err = form.querySelector(".err");
  if (!inp || !err) return;
  const v = inp.value.trim();
  const msg = !v ? "Enter an amount." : !/^(\d+\.?\d*|\.\d+)$/.test(v) ? "Enter a number, like 0.05." : /^[0.]+$/.test(v) ? "Enter an amount above 0."
    : (v.split(".")[1] || "").length > 18 ? "Use at most 18 decimal places." : "";
  inp.setAttribute("aria-invalid", msg ? "true" : "false");
  if (!msg) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  err.textContent = msg;
  inp.focus();
}, true);
