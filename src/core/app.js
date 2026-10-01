/* Duel.gold platform — boot: router, header/wallet, nav, reminders, tickers, test hooks (window.DGApp). */
(function () {
  "use strict";
  const DG = window.DG, P = window.DGP, M = P.match;
  const esc = P.esc, $ = P.$, $$ = P.$$, fmt = P.fmt;
  const TABS = [
    { id: "home", name: "Home", icon: "home" },
    { id: "games", name: "Games", icon: "games" },
    { id: "watch", name: "Watch", icon: "watch" },
    { id: "tournaments", name: "Tournaments", icon: "trophy" },
    { id: "social", name: "Social", icon: "social" },
    { id: "profile", name: "Profile", icon: "profile" },
  ];
  const VIEWS = TABS.map((t) => t.id).concat(["settings", "fair"]);
  P.sessionStart = Date.now();
  let view = "home";

  /* ---------------- nav ---------------- */
  function navHTML(kind) {
    return TABS.map((t) => '<button class="nav-b" id="' + kind + "-" + t.id + '" data-go="' + t.id + '"' + (kind === "tab" ? ' title="' + esc(t.name) + '"' : "") + ' aria-current="' + (view === t.id ? "page" : "false") + '">' +
      P.icon(t.icon) + "<span>" + esc(kind === "bn" && t.short ? t.short : t.name) + "</span></button>").join("");
  }
  function renderNav() {
    $("#tabs").innerHTML = navHTML("tab");
    $("#bottomNav").innerHTML = navHTML("bn");
    const sb = $("#settingsBtn");
    sb.innerHTML = P.icon("gear");
    sb.setAttribute("aria-current", view === "settings" ? "page" : "false");
  }
  function renderWallet() {
    const S = P.S;
    $("#wGold").textContent = fmt(S.gold);
    $("#wDp").textContent = fmt(S.dp);
    $("#wCash").textContent = "€0.00";
    $("#wRating").textContent = fmt(P.overall());
  }
  function renderView() {
    const el = $("#view-" + view);
    if (!el) return;
    try { P.views[view](el); }
    catch (e) {
      console.error("[Duel.gold] view error", e);
      el.innerHTML = '<div class="dg-box empty">Something went wrong showing this page. <button class="dg-btn" id="viewRetry">Try again</button></div>';
      const b = el.querySelector("#viewRetry"); if (b) b.onclick = () => renderView();
    }
  }
  P.go = function (v, anchor) {
    if (!VIEWS.includes(v)) v = "home";
    const changed = v !== view;
    view = v;
    $$(".view").forEach((s) => (s.hidden = s.dataset.view !== v));
    renderNav();
    renderView();
    const h = "#" + v;
    if (location.hash !== h) { try { history.replaceState(null, "", h); } catch (e) { try { location.hash = h; } catch (x) { /* ignore */ } } }
    if (anchor) { const a = document.getElementById(anchor); if (a) try { a.scrollIntoView({ block: "start" }); } catch (e) { /* ignore */ } }
    else if (changed) try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
  };
  P.view = () => view;
  document.addEventListener("click", (e) => {
    const b = e.target.closest && e.target.closest("[data-go]");
    if (!b) return;
    e.preventDefault();
    const m = P.topModal(); if (m && b.closest(".modal")) m.close();
    P.go(b.dataset.go, b.dataset.anchor);
  });
  /* desktop sidebar collapse; remembered per browser when storage works */
  const SB_KEY = "duelgold.sb";
  function setSidebar(collapsed) {
    document.documentElement.classList.toggle("sb-collapsed", collapsed);
    const t = $("#sbToggle");
    t.setAttribute("aria-expanded", String(!collapsed));
    t.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
  }
  try { setSidebar(window.localStorage.getItem(SB_KEY) === "1"); } catch (e) { setSidebar(false); }
  $("#sbToggle").addEventListener("click", () => {
    const collapsed = !document.documentElement.classList.contains("sb-collapsed");
    setSidebar(collapsed);
    try { window.localStorage.setItem(SB_KEY, collapsed ? "1" : "0"); } catch (e) { /* ignore */ }
  });
  /* top bar: search, filter, sign in / register */
  const topQ = $("#topQ");
  function searchGames(q) {
    P.views.setLibQuery(q);
    if (view === "games") renderView(); else P.go("games");
  }
  topQ.addEventListener("input", () => searchGames(topQ.value));
  $("#topSearch").addEventListener("submit", (e) => { e.preventDefault(); searchGames(topQ.value); });
  $("#topSearchBtn").addEventListener("click", () => {
    P.go("games");
    const s = $("#libSearch"); if (s) try { s.focus(); } catch (e) { /* ignore */ }
  });
  function accountNote() {
    P.modal({
      title: "Accounts are coming soon", testId: "account-note",
      body: '<p class="modal-text">Duel.gold is a demo, so there is nothing to sign in to yet. Your gold, ratings and progress are saved in this browser.</p>',
      actions: [{ label: "Got it", id: "accountOk", kind: "primary" }],
    });
  }
  $("#signInBtn").addEventListener("click", accountNote);
  $("#registerBtn").addEventListener("click", accountNote);
  window.addEventListener("hashchange", () => {
    const v = location.hash.slice(1);
    if (VIEWS.includes(v) && v !== view) P.go(v);
  });

  P.onChange(() => {
    renderWallet();
    if (!(view === "games" && document.activeElement && document.activeElement.id === "libSearch")) renderView();
  });


  /* ---------------- session reminder ---------------- */
  let remindTimer = null;
  P.fireReminder = function () {
    P.ensureToday();
    const min = Math.floor((Date.now() - P.sessionStart) / 60000);
    const t = P.S.today;
    const txt = "Reminder: you have played for " + min + " min. Today: " + t.played + " matches, net " + P.signed(t.net) + " gold.";
    const ov = $("#ov");
    if (ov && !ov.hidden) {
      /* inside a match: an inline banner at the top of the overlay instead of a toast over the game */
      const w = $("#ovWarn");
      w.innerHTML = '<span data-test="remind-inline">' + esc(txt) + '</span><button class="toast-x" id="ovWarnX" aria-label="Dismiss reminder">' + P.icon("close") + "</button>";
      w.hidden = false;
      $("#ovWarnX").onclick = () => { w.hidden = true; };
      return;
    }
    P.toast(txt, "remind", 9000);
  };
  P.scheduleReminder = function () {
    if (remindTimer) clearInterval(remindTimer);
    remindTimer = null;
    const m = P.S.limits.remind;
    if (m > 0) remindTimer = setInterval(P.fireReminder, m * 60000);
  };

  /* ---------------- tickers: countdowns + live counts ---------------- */
  const CD = { midnight: P.msToMidnight, week: P.msToWeekEnd, hour: P.msToHour, season: P.msToSeasonEnd };
  let lastLive = 0;
  setInterval(() => {
    $$("[data-cd]").forEach((n) => { const f = CD[n.dataset.cd]; if (f) n.textContent = P.countdown(f()); });
    const slot = Math.floor(P.clock.now() / 10000);
    if (slot !== lastLive) {
      lastLive = slot;
      $$("[data-live]").forEach((n) => { n.textContent = fmt(P.playing(n.dataset.live)); });
    }
    if (P.S.today.date && P.S.today.date !== P.dayKey() && !M.cur && view === "home") renderView(); // day rolled over
  }, 1000);

  /* ---------------- load problems ---------------- */
  P.reportLoad = reportLoad;
  function reportLoad() {
    const box = $("#loadErrors");
    const all = (DG.loadErrors || []).map((e) => {
      if (e == null) return "";
      if (typeof e === "string") return e;
      if (typeof e === "object") return [e.id, e.message || e.msg || e.error].filter((x) => x != null && x !== "").join(": ") || JSON.stringify(e);
      return String(e);
    }).filter(Boolean);
    if (!all.length) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = "<b>" + (all.length === 1 ? "One game could not load." : all.length + " games could not load.") + "</b> The rest of the arena works normally. " +
      '<span class="dg-note">' + all.slice(0, 4).map((x) => esc(String(x).slice(0, 160))).join(" · ") + (all.length > 4 ? " · …" : "") + "</span>";
  }

  /* ---------------- boot ---------------- */
  function boot() {
    P.ensureToday();
    renderWallet();
    const v = location.hash.slice(1);
    P.go(VIEWS.includes(v) ? v : "home");
    reportLoad();
    P.scheduleReminder();
    let rec = null;
    try { rec = M.recover(); } catch (e) { console.error("[Duel.gold] recovery error", e); }
    if (rec) {
      const txt = rec.kind === "refund"
        ? "Your duel was still matchmaking when the page closed. " + (rec.amount ? fmt(rec.amount) + " gold was refunded." : "Nothing was charged.")
        : "Your unfinished duel was counted as a forfeit" + (rec.stake ? " (stake " + fmt(rec.stake) + " gold lost)" : "") + ".";
      M.notice = txt;
      P.toast(txt, rec.kind === "refund" ? "" : "bad", 9000);
      const n = $("#recoverNote"); if (n) { n.textContent = txt; n.hidden = false; }
    }
    DG.__appReady = true;
  }

  /* ---------------- test hooks ---------------- */
  window.DGApp = {
    state: () => JSON.parse(JSON.stringify(P.S)),
    reset: () => { M.cur && M.close(); P.reset(); },
    setSpeed: (n) => { M.speed = Math.max(0.1, Number(n) || 1); return M.speed; },
    startMatch: (o) => M.start(Object.assign({ game: "any", format: "1v1", stake: 0 }, o || {})),
    notice: () => M.notice || null,
    forfeit: () => M.forfeit(false),
    current: () => { const c = M.cur; return c ? { phase: c.phase, format: c.format, stake: c.stake, escrow: c.escrow, games: c.games.map((g) => g.id), opps: c.opps || null, ally: c.ally || null, seed: c.seed, tour: c.T ? { round: c.T.round, alive: c.T.alive } : null, mix: c.mix ? JSON.parse(JSON.stringify(c.mix)) : null } : null; },
    ctx: () => (M.cur && M.cur.handle ? M.cur.handle.ctx : null),
    last: () => M.last,
    close: () => M.close(),
    go: (v) => P.go(v),
    refresh: () => P.commit(),
    set: (patch) => { Object.assign(P.S, patch); P.commit(); },
    advanceDays: (n) => { P.clock.offset += n * 86400000; P.commit(); },
    econ: P.econ,
    remindNow: () => P.fireReminder(),
    watch: (i) => { const w = P.liveMatches()[i || 0]; return w ? M.watch(w) : "none"; },
    watchGame: (id, players) => M.watch({ game: id, players: players || [{ name: "Mira", rating: 1500 }, { name: "Kofi", rating: 1450 }], pot: 0 }),
    storage: () => Object.assign({}, P.storage),
  };

  try { boot(); }
  catch (e) { console.error("[Duel.gold] boot error", e); }
})();
