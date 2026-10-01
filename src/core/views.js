/* Duel.gold platform — views: Duel-now panel, Home, Games, Watch, Tournaments, Social, Profile, Settings, Fairness. */
(function () {
  "use strict";
  const DG = window.DG, U = DG.util, P = window.DGP, E = P.econ, M = P.match;
  const esc = P.esc, $ = P.$, $$ = P.$$, fmt = P.fmt;
  const V = (P.views = {});
  const STAKES = [0, 50, 100, 250, 500, 1000];

  /* ================= Duel-now panel (Home hero + sheet) ================= */
  P.dn = { pick: "any", format: "1v1", stake: 0, custom: "", customOn: false, search: "", opponent: null };
  function dnStake(st) {
    if (!st.customOn) return st.stake;
    const t = String(st.custom).trim();
    if (!/^\d+$/.test(t)) return NaN;
    return parseInt(t, 10);
  }
  function pickLabel(pick) {
    if (pick === "any") return "Any game";
    if (pick === "favs") return "Favourites";
    if (pick === "surprise") return "Surprise me";
    if (pick.startsWith("cat:")) return P.catName(pick.slice(4));
    const g = P.game(pick); return g ? g.name : pick;
  }
  function formatReason(st, f) {
    if (P.poolFor(st.pick, f).length) return "";
    const g = P.game(st.pick);
    if (g) return g.kind === "versus" ? g.name + " is head-to-head: 1v1 and Tournament only." : g.name + " does not offer " + P.fmtName(f) + ".";
    if (st.pick === "favs" && !P.S.favs.length) return "Star games in the library to use Favourites.";
    return "No " + (st.pick.startsWith("cat:") ? P.catName(st.pick.slice(4)) + " " : "") + (st.pick === "favs" ? "favourite " : "") + "game supports " + P.fmtName(f) + ".";
  }
  function fixFormat(st) {
    const allowed = st.opponent ? ["1v1", "mix"] : P.FORMATS.map((f) => f.id);
    if (!allowed.includes(st.format) || formatReason(st, st.format)) {
      const ok = allowed.find((f) => !formatReason(st, f));
      if (ok) st.format = ok;
    }
  }
  /* A game can add its own setup section (def.setup: time control, colour, …). Values are kept per game in st.gopts
     and seeded from the game's saved preferences. Returns null for games without one. */
  function gameSetup(st) {
    const g = P.game(st.pick), def = g && g.raw && g.raw.setup;
    if (!def) return null;
    st.gopts = st.gopts || {};
    if (!st.gopts[g.id]) { let v = null; try { v = def.load(); } catch (e) { v = null; } st.gopts[g.id] = v || def.defaults(); }
    return { g, def, values: st.gopts[g.id] };
  }
  const setupCall = (fn, d) => { try { return fn(); } catch (e) { console.error("[Duel.gold] game setup error", e); return d; } };
  const setupSummary = (gs) => (gs ? setupCall(() => String(gs.def.summary(gs.values) || ""), "") : "");
  const findSmall = (st, gs, stake) => pickLabel(st.pick) + (setupSummary(gs) ? " · " + setupSummary(gs) : "") + " · " + P.fmtName(st.format) + " · " + (stake > 0 ? fmt(stake) : "Free");
  P.duelPanelHTML = function (px, st) {
    const games = P.games();
    if (!games.length) {
      return '<div class="dn-empty" data-test="no-games"><p class="dg-h dn-empty-h">No games installed</p><p class="dg-muted">The arena is ready but no game pack loaded. Games appear here as soon as a pack registers them.</p></div>';
    }
    fixFormat(st);
    const block = P.stakeBlock();
    if (block && (st.customOn || st.stake > 0)) { st.customOn = false; st.stake = 0; } // staking blocked: fall back to Free
    const cats = (DG.CATEGORIES || []).filter((c) => games.some((g) => g.category === c.id));
    const chip = (val, label, extra) => '<button class="dg-chip" data-pick="' + esc(val) + '" aria-pressed="' + (st.pick === val) + '"' + (extra || "") + ">" + esc(label) + "</button>";
    const q = st.search.trim().toLowerCase();
    const list = games.filter((g) => !q || g.name.toLowerCase().includes(q) || g.category.includes(q)).sort((a, b) => a.name.localeCompare(b.name));
    const specific = P.game(st.pick);
    let opts = '<option value="">' + (list.length ? (q ? list.length + " match" + (list.length === 1 ? "" : "es") + "…" : "Specific game…") : "No match") + "</option>" + list.map((g) => '<option value="' + esc(g.id) + '"' + (specific && specific.id === g.id ? " selected" : "") + ">" + esc(g.name) + " · " + esc(P.catName(g.category)) + "</option>").join("");
    if (specific && !list.includes(specific)) opts += '<option value="' + esc(specific.id) + '" selected>' + esc(specific.name) + "</option>";
    const allowed = st.opponent ? ["1v1", "mix"] : null;
    const fchips = P.FORMATS.map((f) => {
      const why = allowed && !allowed.includes(f.id) ? "Friend challenges are 1v1 or Duel Mix." : formatReason(st, f.id);
      return '<button class="dg-chip" id="' + px + "F-" + f.id + '" data-fmt="' + f.id + '" aria-pressed="' + (st.format === f.id) + '"' + (why ? ' disabled title="' + esc(why) + '"' : "") + ">" + esc(f.name) + "</button>";
    }).join("");
    const fwhy = P.FORMATS.map((f) => (allowed && !allowed.includes(f.id) ? "" : formatReason(st, f.id)) ? P.fmtName(f.id) + ": " + formatReason(st, f.id) : "").filter(Boolean);
    const fwhyTxt = fwhy.length > 1 && P.game(st.pick) && P.game(st.pick).kind === "versus" ? [formatReason(st, "2v2")] : fwhy;
    const schips = STAKES.map((s) => {
      const dis = s > 0 && (block || s > P.S.gold || s > P.lossRoom());
      return '<button class="dg-chip dg-mono" id="' + px + "S-" + s + '" data-stake="' + s + '" aria-pressed="' + (!st.customOn && st.stake === s) + '"' + (dis ? " disabled" : "") + ">" + (s ? fmt(s) : "Free") + "</button>";
    }).join("") + '<button class="dg-chip" id="' + px + 'S-custom" data-stake="custom" aria-pressed="' + st.customOn + '"' + (block ? " disabled" : "") + ">Custom</button>";
    const stake = dnStake(st);
    let err = st.customOn ? (Number.isFinite(stake) ? P.stakeError(stake) : "Enter a whole number of gold.") : P.stakeError(stake);
    if (err && err === block) err = ""; // already shown under the stake chips
    if (!err && formatReason(st, st.format)) err = formatReason(st, st.format);
    const gs = gameSetup(st);
    const gsHTML = gs ? '<div class="dn-field dn-gset" data-test="game-setup">' + setupCall(() => gs.def.html(gs.values, { px, rating: P.rating(gs.g.id), esc }), "") + "</div>" : "";
    if (!err && gs) err = setupCall(() => gs.def.validate(gs.values), "") || "";
    const tourNote = st.format === "tournament" ? " Entry fee = stake." : "";
    const note = err ? "" : P.potNote(st.format, stake || 0) + tourNote;
    const opp = st.opponent ? '<div class="dn-opp" data-test="dn-opponent"><span class="dg-eyebrow">Challenge</span><b class="dg-rival">' + esc(st.opponent.name) + '</b><span class="dg-mono dg-muted">' + fmt(st.opponent.rating) + '</span><button class="dg-btn slim" id="' + px + 'OppX">Remove</button></div>' : "";
    return opp +
      '<div class="dn-field"><span class="dg-eyebrow" id="' + px + 'GameL">Game <b class="dn-pick">' + esc(pickLabel(st.pick)) + "</b></span>" +
      '<div class="chips scroller" role="group" aria-labelledby="' + px + 'GameL">' +
      chip("any", "Any game") + chip("favs", "Favourites", P.S.favs.length ? "" : ' title="Star games in the library first"') + chip("surprise", "Surprise me") +
      cats.map((c) => chip("cat:" + c.id, c.name)).join("") + "</div>" +
      '<div class="dn-search"><label class="sr" for="' + px + 'Search">Search games</label><input class="inp" type="search" id="' + px + 'Search" placeholder="Search games" value="' + esc(st.search) + '" autocomplete="off">' +
      '<label class="sr" for="' + px + 'Game">Specific game</label><select class="inp" id="' + px + 'Game">' + opts + "</select></div></div>" +
      '<div class="dn-field"><span class="dg-eyebrow" id="' + px + 'FmtL">Format</span><div class="chips scroller" role="group" aria-labelledby="' + px + 'FmtL">' + fchips + "</div>" +
      (fwhyTxt.length ? '<p class="dn-why">' + fwhyTxt.map(esc).join(" ") + "</p>" : "") + "</div>" + gsHTML +
      '<div class="dn-field"><span class="dg-eyebrow" id="' + px + 'StakeL">Stake · gold</span><div class="chips scroller" role="group" aria-labelledby="' + px + 'StakeL">' + schips + "</div>" +
      (st.customOn ? '<div class="dn-custom"><label for="' + px + 'Custom">Custom stake (10 to ' + fmt(P.S.gold) + ')</label><input class="inp dg-mono" id="' + px + 'Custom" inputmode="numeric" value="' + esc(st.custom) + '" placeholder="e.g. 300"></div>' : "") +
      (block ? '<p class="dn-why warn" id="' + px + 'Block">' + esc(block) + "</p>" : "") + "</div>" +
      '<button class="cta" id="' + px + 'Find" data-test="find"' + (err ? " disabled" : "") + '><span>Find opponent</span><small>' + esc(findSmall(st, gs, stake)) + "</small></button>" +
      '<p class="dn-note' + (err ? " err" : "") + '" id="' + px + 'Note" aria-live="polite">' + esc(err || note) + "</p>";
  };
  P.bindDuel = function (root, px, st, rerender, onStarted) {
    root.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = () => { st.pick = b.dataset.pick; rerender(); }));
    const sel = root.querySelector("#" + px + "Game");
    if (sel) sel.onchange = () => { st.pick = sel.value || "any"; rerender(); };
    const se = root.querySelector("#" + px + "Search");
    if (se) se.oninput = () => {
      st.search = se.value; const pos = se.selectionStart;
      rerender();
      const n = root.querySelector("#" + px + "Search"); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } }
    };
    root.querySelectorAll("[data-fmt]").forEach((b) => (b.onclick = () => { st.format = b.dataset.fmt; rerender(); }));
    root.querySelectorAll("[data-stake]").forEach((b) => (b.onclick = () => {
      if (b.dataset.stake === "custom") { st.customOn = true; rerender(); const c = root.querySelector("#" + px + "Custom"); if (c) c.focus(); return; }
      st.customOn = false; st.stake = +b.dataset.stake; rerender();
    }));
    const cu = root.querySelector("#" + px + "Custom");
    if (cu) cu.oninput = () => {
      st.custom = cu.value;
      const v = dnStake(st);
      const gs = gameSetup(st);
      const err = Number.isFinite(v) ? P.stakeError(v) || formatReason(st, st.format) || (gs ? setupCall(() => gs.def.validate(gs.values), "") : "") : "Enter a whole number of gold.";
      const note = root.querySelector("#" + px + "Note"), find = root.querySelector("#" + px + "Find");
      note.textContent = err || P.potNote(st.format, v); note.classList.toggle("err", !!err);
      find.disabled = !!err;
      find.querySelector("small").textContent = findSmall(st, gs, v);
    };
    const gs = gameSetup(st);
    if (gs) setupCall(() => gs.def.bind(root, gs.values, { px, change: () => { setupCall(() => gs.def.save(gs.values)); rerender(); } }));
    const ox = root.querySelector("#" + px + "OppX");
    if (ox) ox.onclick = () => { st.opponent = null; rerender(); };
    const find = root.querySelector("#" + px + "Find");
    if (find) find.onclick = () => {
      const stake = dnStake(st);
      const gs2 = gameSetup(st);
      const options = gs2 ? { game: gs2.g.id, values: JSON.parse(JSON.stringify(gs2.values)) } : undefined;
      const err = M.start({ game: st.pick, format: st.format, stake: Number.isFinite(stake) ? stake : -1, opponent: st.opponent || undefined, options });
      if (err) { const n = root.querySelector("#" + px + "Note"); n.textContent = err; n.classList.add("err"); return; }
      if (onStarted) onStarted();
    };
  };
  /* sheet version (from Games / Social / Watch) */
  P.openDuelSheet = function (preset) {
    const st = Object.assign({}, P.dn, { search: "", opponent: null }, preset || {});
    const box = document.createElement("div");
    box.className = "dn sheet";
    const m = P.modal({ title: st.opponent ? "Challenge " + st.opponent.name : "Duel setup", body: box, testId: "duel-sheet", wide: true });
    const re = () => { box.innerHTML = P.duelPanelHTML("sh", st); P.bindDuel(box, "sh", st, re, () => m.close()); };
    re();
    return m;
  };

  /* ================= shared bits ================= */
  const sectionHead = (title, right) => '<div class="sec-head"><h2 class="dg-h">' + title + "</h2>" + (right || "") + "</div>";
  /* "1v1 · 2v2 · FFA +2" — full list goes in the title attribute and the rules panel */
  function shortFormats(fs) {
    const names = fs.map(P.fmtName);
    return names.length <= 3 ? names.join(" · ") : names.slice(0, 3).join(" · ") + " +" + (names.length - 3);
  }
  const shortDur = (d) => String(d).replace(/\s*\(.*\)\s*$/, "").replace(/^up to /i, "≤ ");
  function gameCard(g) {
    const fav = P.S.favs.includes(g.id);
    const gs = P.S.games[g.id];
    return '<article class="gcard" data-game="' + esc(g.id) + '">' +
      '<div class="gcard-top"><span class="dg-eyebrow" title="' + esc(g.formats.map(P.fmtName).join(", ")) + '">' + esc(P.catName(g.category)) + " · " + esc(shortFormats(g.formats)) + (g.duration ? " · " + esc(shortDur(g.duration)) : "") + "</span>" +
      '<button class="star" data-fav="' + esc(g.id) + '" aria-pressed="' + fav + '" aria-label="' + (fav ? "Remove " : "Add ") + esc(g.name) + (fav ? " from" : " to") + ' favourites">' + P.icon("star") + "</button></div>" +
      '<h3 class="dg-h gcard-name">' + esc(g.name) + "</h3>" +
      '<p class="gcard-blurb">' + esc(g.blurb) + "</p>" +
      '<div class="meters">' + P.meter("Skill", g.skill, "skill") + P.meter("Luck", g.luck, "luck") + "</div>" +
      '<div class="gcard-meta"><span class="badge ' + (g.cashEligible ? "cash" : "") + '">' + (g.cashEligible ? "Cash-eligible" : "Gold only") + '</span><span class="dg-note"><span class="live-dot"></span><span class="dg-mono" data-live="' + esc(g.id) + '">' + fmt(P.playing(g.id)) + "</span> playing</span></div>" +
      '<div class="gcard-meta"><span class="dg-note">Your rating <b class="dg-mono dg-gold">' + fmt(P.rating(g.id)) + "</b>" + (gs ? " · " + gs.w + "–" + gs.l + "–" + gs.d : "") + "</span></div>" +
      '<div class="gcard-foot"><button class="dg-btn" data-rules="' + esc(g.id) + '">How to play</button><button class="dg-btn primary" data-duel="' + esc(g.id) + '">Duel</button></div></article>';
  }
  P.showRules = function (id) {
    const g = P.game(id); if (!g) return;
    P.modal({
      title: g.name, testId: "rules-panel",
      body: '<p class="dg-muted">' + esc(g.blurb) + '</p><ul class="rules-list">' + g.rules.map((r) => "<li>" + esc(r) + "</li>").join("") + "</ul>" +
        '<div class="meters">' + P.meter("Skill", g.skill, "skill") + P.meter("Luck", g.luck, "luck") + "</div>" +
        '<p class="dg-note">' + esc(g.kind === "race" ? "Race: every player gets the identical seeded challenge; the higher " + g.scoreLabel + " wins." : "Head-to-head: you play directly against your opponent.") +
        " Formats: " + esc(g.formats.map(P.fmtName).join(", ")) + ". " + (g.cashEligible ? "Skill-dominant: would qualify for cash play if it ever launched." : "Gold only: luck plays too large a part for cash play.") + "</p>",
      actions: [{ label: "Close" }, { label: "Duel", kind: "primary", onClick: () => { setTimeout(() => P.openDuelSheet({ pick: g.id, format: g.formats.includes(P.dn.format) ? P.dn.format : g.formats[0] }), 0); } }],
    });
  };
  function bindCards(root) {
    root.querySelectorAll("[data-fav]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.fav, i = P.S.favs.indexOf(id);
      if (i >= 0) P.S.favs.splice(i, 1); else P.S.favs.push(id);
      P.commit();
    }));
    root.querySelectorAll("[data-rules]").forEach((b) => (b.onclick = () => P.showRules(b.dataset.rules)));
    root.querySelectorAll("[data-duel]").forEach((b) => (b.onclick = () => {
      const g = P.game(b.dataset.duel); if (!g) return;
      P.openDuelSheet({ pick: g.id, format: g.formats.includes(P.dn.format) ? P.dn.format : g.formats[0] || "1v1" });
    }));
  }
  /* simulated people helpers */
  const nameAt = (rng) => U.pick(rng, P.NAMES);
  function slotRng(tag, ms) { return U.rng(tag + ":" + Math.floor(P.clock.now() / ms)); }

  /* ================= Home ================= */
  V.home = function (el) {
    const S = P.S, games = P.games();
    P.ensureToday();
    const bonusReady = S.bonusDate !== P.dayKey();
    const live = games.slice().sort((a, b) => P.playing(b.id) - P.playing(a.id)).slice(0, 8);
    const mixOK = games.some((g) => P.supports(g, "mix"));
    const feat = P.tours().find((t) => t.id === "daily");
    const rng = slotRng("feed", 20000);
    const feed = [];
    if (games.length) for (let i = 0; i < 6; i++) {
      const g = U.pick(rng, games), a = nameAt(rng); let b = nameAt(rng); if (b === a) b = "Luca";
      const st = U.pick(rng, [0, 50, 100, 250, 500, 1000]);
      feed.push('<li><b class="dg-gold">' + esc(a) + "</b> beat " + esc(b) + ' <span class="dg-muted">· ' + esc(g.name) + (st ? " · won " + fmt(E.winPay(st)) : " · free") + '</span><span class="dg-mono dg-muted feed-t">' + (1 + Math.floor(rng() * 9)) + "m</span></li>");
    }
    el.innerHTML =
      '<div class="home-grid">' +
      '<section class="dn hero" id="duelNow" aria-labelledby="dnTitle"><div class="hero-head"><p class="dg-eyebrow">Every game · one opponent · one winner</p><h1 class="dg-h hero-h" id="dnTitle">Duel <em>now</em></h1>' +
      '<p class="dg-muted hero-sub">Same seed for every player. Matched by rating. The better player takes the pot.</p></div><div id="dnBody"></div></section>' +
      '<div class="side">' +
      '<section class="dg-box bonus" data-test="bonus"><div class="box-h"><h3 class="dg-h">Daily bonus</h3><span class="dg-eyebrow">Demo gold</span></div>' +
      (bonusReady ? '<p class="dg-note">Claim 500 demo gold once per day.</p><button class="dg-btn primary" id="claimBonus">Claim +500 gold</button>' : '<p class="dg-note">Claimed today. Next bonus in <span class="dg-mono" data-cd="midnight">' + P.countdown(P.msToMidnight()) + "</span>.</p>") +
      (S.gold < 100 ? '<div class="topup"><p class="dg-note">Running low on demo gold.</p><button class="dg-btn" id="topUp">Top up demo gold · +1,000</button></div>' : "") + "</section>" +
      '<section class="dg-box" aria-labelledby="liveH"><div class="box-h"><h3 class="dg-h" id="liveH"><span class="live-dot"></span>Live now</h3><span class="dg-eyebrow">Playing</span></div>' +
      (live.length ? '<ul class="rowlist" id="liveList">' + live.map((g) => '<li><button class="link" data-live-pick="' + esc(g.id) + '">' + esc(g.name) + '</button><span class="dg-mono dg-muted" data-live="' + esc(g.id) + '">' + fmt(P.playing(g.id)) + "</span></li>").join("") + "</ul>" : '<p class="dg-note">No games installed.</p>') + "</section>" +
      "</div></div>" +
      '<div class="home-cards">' +
      '<section class="feature mix-card" data-test="mix-card"><p class="dg-eyebrow">Duel Mix</p><h3 class="dg-h">Three challenges. One opponent.</h3><p class="dg-muted">Three short games from different categories against the same rival. Win a round for 3 points, draw for 1. One stake, winner takes 1.8×.</p>' +
      '<button class="dg-btn primary" id="mixGo"' + (mixOK ? "" : " disabled") + ">Set up Duel Mix</button>" + (mixOK ? "" : '<p class="dg-note">No installed game has a Duel Mix version.</p>') + "</section>" +
      (feat ? '<section class="feature tour-card" data-test="featured-tour"><p class="dg-eyebrow">Featured tournament</p><h3 class="dg-h">' + esc(feat.name) + '</h3><p class="dg-muted">' + esc(feat.gameName || "No game available") + " · " + (feat.entry ? fmt(feat.entry) + " entry" : "Free entry") + ' · prize pool <b class="dg-gold dg-mono">' + fmt(E.tourPool(feat.entry, feat.added)) + '</b></p><p class="dg-note">Ends in <span class="dg-mono" data-cd="' + feat.cd + '">' + P.countdown(feat.ms()) + "</span></p>" +
        '<button class="dg-btn primary" data-join="' + feat.id + '"' + (feat.block() ? " disabled" : "") + ">Join</button>" + (feat.block() ? '<p class="dg-note">' + esc(feat.block()) + "</p>" : "") + "</section>" : "") +
      '<section class="dg-box feed"><div class="box-h"><h3 class="dg-h">Recent results</h3><span class="dg-eyebrow">Simulated</span></div><ul class="feedlist">' + (feed.join("") || '<li class="dg-note">Nothing yet.</li>') + "</ul></section>" +
      "</div>";
    const body = el.querySelector("#dnBody");
    const re = () => { body.innerHTML = P.duelPanelHTML("dn", P.dn); P.bindDuel(body, "dn", P.dn, re); };
    re();
    const cb = el.querySelector("#claimBonus");
    if (cb) cb.onclick = () => V.claimBonus();
    const tu = el.querySelector("#topUp");
    if (tu) tu.onclick = () => { if (P.S.gold < 100) { P.S.gold += 1000; P.commit(); P.toast("+1,000 demo gold added.", "gold"); } };
    el.querySelectorAll("[data-live-pick]").forEach((b) => (b.onclick = () => {
      const g = P.game(b.dataset.livePick); if (!g) return;
      P.dn.pick = g.id; P.dn.opponent = null; re();
      try { $("#duelNow").scrollIntoView({ block: "start", behavior: "smooth" }); } catch (e) { /* ignore */ }
    }));
    const mg = el.querySelector("#mixGo");
    if (mg) mg.onclick = () => { P.dn.format = "mix"; if (P.game(P.dn.pick)) P.dn.pick = "any"; re(); try { $("#duelNow").scrollIntoView({ block: "start" }); } catch (e) { /* ignore */ } };
    bindJoin(el);
  };
  V.claimBonus = function () {
    if (P.S.bonusDate === P.dayKey()) return false;
    P.S.bonusDate = P.dayKey(); P.S.gold += 500; P.commit();
    P.toast("+500 demo gold. Come back tomorrow for more.", "gold");
    return true;
  };

  /* ================= Games library ================= */
  const lib = { q: "", cat: "all", favs: false, sort: "popular" };
  V.setLibQuery = (q) => { lib.q = String(q || ""); };
  V.games = function (el) {
    const games = P.games();
    const cats = (DG.CATEGORIES || []).filter((c) => games.some((g) => g.category === c.id));
    let list = games.filter((g) => (lib.cat === "all" || g.category === lib.cat) && (!lib.favs || P.S.favs.includes(g.id)) &&
      (!lib.q || (g.name + " " + g.blurb + " " + g.category).toLowerCase().includes(lib.q.toLowerCase())));
    if (lib.sort === "popular") list.sort((a, b) => P.playing(b.id) - P.playing(a.id));
    else if (lib.sort === "skill") list.sort((a, b) => b.skill - b.luck - (a.skill - a.luck) || a.name.localeCompare(b.name));
    else list.sort((a, b) => a.name.localeCompare(b.name));
    el.innerHTML = sectionHead("Game library", '<span class="dg-muted">' + games.length + " game" + (games.length === 1 ? "" : "s") + "</span>") +
      '<div class="lib-tools"><div class="lib-search">' + P.icon("search") + '<label class="sr" for="libSearch">Search games</label><input class="inp" type="search" id="libSearch" placeholder="Search games" value="' + esc(lib.q) + '"></div>' +
      '<label class="sr" for="libSort">Sort</label><select class="inp" id="libSort"><option value="popular"' + (lib.sort === "popular" ? " selected" : "") + '>Most popular</option><option value="skill"' + (lib.sort === "skill" ? " selected" : "") + '>Most skill-heavy</option><option value="az"' + (lib.sort === "az" ? " selected" : "") + ">A–Z</option></select></div>" +
      '<div class="chips lib-cats" role="group" aria-label="Filter"><button class="dg-chip" data-cat="all" aria-pressed="' + (lib.cat === "all") + '">All</button>' +
      '<button class="dg-chip" id="libFavs" aria-pressed="' + lib.favs + '">' + P.icon("star", "sm") + " Favourites</button>" +
      cats.map((c) => '<button class="dg-chip" data-cat="' + esc(c.id) + '" aria-pressed="' + (lib.cat === c.id) + '">' + esc(c.name) + "</button>").join("") + "</div>" +
      (list.length ? '<div class="ggrid" id="gameGrid">' + list.map(gameCard).join("") + "</div>"
        : '<div class="empty dg-box" data-test="lib-empty">' + (games.length ? (lib.favs && !P.S.favs.length ? "No favourites yet. Tap the star on a game to add it." : "No games match this filter.") : "No games are installed yet.") + "</div>");
    const s = el.querySelector("#libSearch");
    s.oninput = () => { lib.q = s.value; const pos = s.selectionStart; V.games(el); const n = el.querySelector("#libSearch"); n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } };
    el.querySelector("#libSort").onchange = (e) => { lib.sort = e.target.value; V.games(el); };
    el.querySelector("#libFavs").onclick = () => { lib.favs = !lib.favs; V.games(el); };
    el.querySelectorAll("[data-cat]").forEach((b) => (b.onclick = () => { lib.cat = b.dataset.cat; V.games(el); }));
    bindCards(el);
  };

  /* ================= Watch ================= */
  const watchState = { lb: "" };
  P.liveMatches = function () {
    const games = P.games();
    if (!games.length) return [];
    const rng = slotRng("watch", 60000);
    const pickFrom = U.shuffle(rng, games).slice(0, Math.min(8, Math.max(4, games.length)));
    const out = [];
    for (let i = 0; i < Math.min(8, Math.max(4, games.length)); i++) {
      const g = pickFrom[i % pickFrom.length];
      const a = nameAt(rng); let b = nameAt(rng); if (b === a) b = "Luca";
      const ra = 1300 + Math.floor(rng() * 600), rb = Math.max(1200, ra + Math.floor(rng() * 160 - 80));
      out.push({ id: "w" + i, game: g.id, gameName: g.name, spect: g.hasSpectate, kind: g.kind, players: [{ name: a, rating: ra }, { name: b, rating: rb }], pot: U.pick(rng, [0, 500, 1000, 2000, 5000]), seed: 100000 + Math.floor(rng() * 900000) });
    }
    return out;
  };
  V.watch = function (el) {
    const games = P.games();
    const list = P.liveMatches();
    if (!watchState.lb || !P.game(watchState.lb)) watchState.lb = games[0] ? games[0].id : "";
    const lbg = P.game(watchState.lb);
    let lb = "";
    if (lbg) {
      const rng = U.rng("lb:" + lbg.id + ":" + P.weekKey());
      const rows = []; let r = 2050 + Math.floor(rng() * 150);
      const used = new Set();
      for (let i = 0; i < 10; i++) { let n = nameAt(rng); while (used.has(n)) n = nameAt(rng); used.add(n); rows.push({ n, r, w: 40 + Math.floor(rng() * 300) }); r -= 8 + Math.floor(rng() * 40); }
      const my = P.rating(lbg.id);
      lb = '<div class="dg-scroll-x"><table class="dg-table" id="lbTable"><thead><tr><th>#</th><th>Player</th><th class="num">Rating</th><th class="num">Wins</th></tr></thead><tbody>' +
        rows.map((x, i) => "<tr><td class=\"dg-mono\">" + (i + 1) + "</td><td>" + esc(x.n) + '</td><td class="num">' + fmt(x.r) + '</td><td class="num">' + fmt(x.w) + "</td></tr>").join("") +
        '<tr class="me"><td class="dg-mono">' + fmt(P.rank(my)) + "</td><td>" + esc(P.S.name) + '</td><td class="num">' + fmt(my) + '</td><td class="num">' + fmt(P.S.games[lbg.id] ? P.S.games[lbg.id].w : 0) + "</td></tr></tbody></table></div>";
    }
    el.innerHTML = sectionHead("Watch", '<span class="dg-muted">Featured live matches · simulated</span>') +
      (list.length ? '<div class="wgrid" id="watchList">' + list.map((w) =>
        '<article class="wcard" data-watch="' + w.id + '"><div class="wcard-top"><span class="live-tag"><span class="live-dot"></span>Live</span><span class="dg-eyebrow">' + esc(w.gameName) + "</span></div>" +
        '<div class="wcard-vs"><div><b>' + esc(w.players[0].name) + '</b><span class="dg-mono">' + fmt(w.players[0].rating) + '</span></div><span class="vs-mini">vs</span><div class="r"><b>' + esc(w.players[1].name) + '</b><span class="dg-mono">' + fmt(w.players[1].rating) + "</span></div></div>" +
        '<div class="wcard-foot"><span class="dg-note">' + (w.pot ? "Pot <b class=\"dg-mono dg-gold\">" + fmt(w.pot) + "</b>" : "Free match") + " · " + (w.spect ? "Live board" : w.kind === "race" ? "Live race" : "Result only") + '</span><button class="dg-btn primary" data-watch-go="' + w.id + '"' + (!w.spect && w.kind !== "race" ? " disabled" : "") + ">Watch</button></div></article>").join("") + "</div>"
        : '<div class="empty dg-box">No live matches. Install a game pack to see featured matches.</div>') +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Leaderboard</h3><span class="dg-eyebrow">Simulated · this week</span></div>' +
      (lbg ? '<label class="sr" for="lbGame">Leaderboard game</label><select class="inp lb-sel" id="lbGame">' + games.map((g) => '<option value="' + esc(g.id) + '"' + (g.id === lbg.id ? " selected" : "") + ">" + esc(g.name) + "</option>").join("") + "</select>" + lb : '<p class="dg-note">No games installed.</p>') + "</section>";
    el.querySelectorAll("[data-watch-go]").forEach((b) => (b.onclick = () => {
      const w = P.liveMatches().find((x) => x.id === b.dataset.watchGo) || list.find((x) => x.id === b.dataset.watchGo);
      if (!w) return;
      const err = M.watch(w); if (err) P.toast(err, "bad");
    }));
    const sel = el.querySelector("#lbGame");
    if (sel) sel.onchange = () => { watchState.lb = sel.value; V.watch(el); };
  };

  /* ================= Tournaments ================= */
  function tourGame(tag, prefer) {
    const pool = P.games().filter((g) => g.formats.includes("tournament"));
    if (!pool.length) return null;
    const cash = pool.filter((g) => g.cashEligible);
    const src = prefer && cash.length ? cash : pool;
    return src[U.hashSeed(tag) % src.length];
  }
  P.tours = function () {
    const S = P.S;
    const season = (() => { const d = new Date(P.clock.now()); return d.getFullYear() + "-Q" + (Math.floor(d.getMonth() / 3) + 1); })();
    const gold = P.overall() >= 1400;
    const defs = [
      { id: "daily", name: "Daily Championship", entry: 0, added: 5000, once: P.dayKey(), cd: "midnight", ms: P.msToMidnight, tag: "daily:" + P.dayKey(), note: "One run per day. Resets at local midnight." },
      { id: "weekend", name: "Weekend Championship", entry: 250, added: 20000, once: P.weekKey(), cd: "week", ms: P.msToWeekEnd, tag: "weekend:" + P.weekKey(), note: "One run per week." },
      { id: "high", name: "High Stakes", entry: 1000, added: 0, once: null, cd: "hour", ms: P.msToHour, tag: "high:" + Math.floor(P.clock.now() / 3600000), note: "Eight players, 1,000 each. A new field every hour." },
      { id: "world", name: "World Championship", entry: 500, added: 100000, once: season, cd: "season", ms: P.msToSeasonEnd, tag: "world:" + season, prefer: true, locked: !gold, note: "Seasonal. Needs Gold division (overall rating 1,400+). One run per season." },
    ];
    return defs.map((d) => {
      const g = tourGame(d.tag, d.prefer);
      const t = Object.assign({}, d, { game: g ? g.id : null, gameName: g ? g.name : null });
      const rec = S.tours[d.id] || {};
      t.entered = !!(d.once && rec.entered === d.once);
      t.best = rec.best;
      t.entrants = 8 * (40 + (U.hashSeed(d.tag + ":n") % 300)) + Math.floor((P.clock.now() / 60000) % 17);
      t.block = function () {
        if (!g) return "No installed game supports tournaments.";
        if (t.locked) return "Locked: reach Gold division (overall rating 1,400) to qualify. Yours is " + fmt(P.overall()) + ".";
        if (t.entered) return "Entered this period. Come back when it resets.";
        return P.stakeError(t.entry);
      };
      return t;
    });
  };
  const BEST = ["Quarter-final", "Semi-final", "Runner-up", "Champion"];
  function bindJoin(el) {
    el.querySelectorAll("[data-join]").forEach((b) => (b.onclick = () => {
      const t = P.tours().find((x) => x.id === b.dataset.join);
      if (!t) return;
      const why = t.block(); if (why) { P.toast(why, "bad"); return; }
      const err = M.start({ game: t.game, format: "tournament", stake: t.entry, tour: { id: t.id, name: t.name, added: t.added, once: t.once || undefined } });
      if (err) P.toast(err, "bad");
    }));
  }
  const quick = { entry: 0 };
  V.tournaments = function (el) {
    const S = P.S;
    const tours = P.tours();
    const qgames = P.games().filter((g) => g.formats.includes("tournament"));
    const rng = U.rng("season:" + new Date(P.clock.now()).getFullYear() + ":" + Math.floor(new Date(P.clock.now()).getMonth() / 3));
    const rows = []; let tp = 1800 + Math.floor(rng() * 400);
    const used = new Set();
    for (let i = 0; i < 9; i++) { let n = nameAt(rng); while (used.has(n)) n = nameAt(rng); used.add(n); rows.push({ n, tp }); tp -= 60 + Math.floor(rng() * 180); }
    rows.push({ n: S.name, tp: S.tp, me: true });
    rows.sort((a, b) => b.tp - a.tp);
    el.innerHTML = sectionHead("Tournaments", '<span class="dg-muted">8-player brackets · quarter → semi → final</span>') +
      '<div class="tgrid">' + tours.map((t) => {
        const why = t.block();
        const pool = E.tourPool(t.entry, t.added);
        return '<article class="tcard' + (t.locked ? " locked" : "") + '" data-tour="' + t.id + '"><div class="tcard-top"><p class="dg-eyebrow">' + esc(t.gameName || "No game") + '</p>' + (t.locked ? '<span class="badge lock">' + P.icon("lock", "sm") + " Locked</span>" : "") + "</div>" +
          '<h3 class="dg-h">' + esc(t.name) + "</h3>" +
          '<dl class="tstats"><div><dt>Entry</dt><dd class="dg-mono">' + (t.entry ? fmt(t.entry) : "Free") + '</dd></div><div><dt>Prize pool</dt><dd class="dg-mono dg-gold">' + fmt(pool) + '</dd></div><div><dt>Entrants</dt><dd class="dg-mono">' + fmt(t.entrants) + '</dd></div><div><dt>Ends in</dt><dd class="dg-mono" data-cd="' + t.cd + '">' + P.countdown(t.ms()) + "</dd></div></dl>" +
          '<p class="dg-note">' + esc(t.note) + (t.added ? " Includes " + fmt(t.added) + " added by the house." : "") + " Your best: <b>" + (t.best == null ? "–" : BEST[t.best]) + "</b></p>" +
          '<button class="dg-btn primary" data-join="' + t.id + '" id="join-' + t.id + '"' + (why ? " disabled" : "") + ">" + (t.entered ? "Entered" : "Join · " + (t.entry ? fmt(t.entry) : "Free")) + "</button>" +
          (why && !t.entered ? '<p class="dg-note warn-t">' + esc(why) + "</p>" : "") + "</article>";
      }).join("") + "</div>" +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Quick tournaments</h3><span class="dg-eyebrow">Per game · starts now</span></div>' +
      '<div class="chips" role="group" aria-label="Entry fee">' + [0, 100, 250, 1000].map((s) => '<button class="dg-chip dg-mono" data-qentry="' + s + '" aria-pressed="' + (quick.entry === s) + '"' + (s && (P.stakeError(s)) ? " disabled" : "") + ">" + (s ? fmt(s) : "Free") + "</button>").join("") + "</div>" +
      '<p class="dg-note">' + esc(P.potNote("tournament", quick.entry)) + "</p>" +
      (qgames.length ? '<ul class="rowlist qlist">' + qgames.map((g) => { const b = S.tours["quick:" + g.id]; return '<li><span><b>' + esc(g.name) + '</b> <span class="dg-muted">· best ' + (b && b.best != null ? BEST[b.best] : "–") + '</span></span><button class="dg-btn slim" data-quick="' + esc(g.id) + '">Enter</button></li>'; }).join("") + "</ul>" : '<p class="dg-note">No installed game supports tournaments.</p>') + "</section>" +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Season leaderboard</h3><span class="dg-eyebrow">Tournament points · simulated field</span></div><div class="dg-scroll-x"><table class="dg-table"><thead><tr><th>#</th><th>Player</th><th class="num">Points</th></tr></thead><tbody>' +
      rows.map((r, i) => '<tr class="' + (r.me ? "me" : "") + '"><td class="dg-mono">' + (i + 1) + "</td><td>" + esc(r.n) + '</td><td class="num">' + fmt(r.tp) + "</td></tr>").join("") + "</tbody></table></div>" +
      '<p class="dg-note">Points per run: champion 100 · runner-up 50 · semi-final 25 · quarter-final 10.</p></section>';
    bindJoin(el);
    el.querySelectorAll("[data-qentry]").forEach((b) => (b.onclick = () => { quick.entry = +b.dataset.qentry; V.tournaments(el); }));
    el.querySelectorAll("[data-quick]").forEach((b) => (b.onclick = () => {
      const g = P.game(b.dataset.quick); if (!g) return;
      const err = M.start({ game: g.id, format: "tournament", stake: quick.entry });
      if (err) P.toast(err, "bad");
    }));
  };

  /* ================= Social ================= */
  P.CLUBS = [
    { id: "owls", name: "Night Owls", motto: "Late games, sharp minds." },
    { id: "iron", name: "Iron Circle", motto: "Strategy first." },
    { id: "harbour", name: "Harbour Blades", motto: "Fast hands, clean wins." },
    { id: "storm", name: "Quiet Storm", motto: "Calm under the clock." },
  ];
  function friendStatus(f) {
    const r = U.rng("st:" + f.name + ":" + Math.floor(P.clock.now() / 300000))();
    return r < 0.45 ? "Online" : r < 0.7 ? "In a duel" : "Offline";
  }
  function friendFav(f) { const g = P.games(); return g.length ? g[U.hashSeed("fav:" + f.name) % g.length].name : "–"; }
  function clubTable(club) {
    const rng = U.rng("club:" + club.id + ":" + P.weekKey());
    const members = []; const used = new Set();
    for (let i = 0; i < 7; i++) { let n = nameAt(rng); while (used.has(n)) n = nameAt(rng); used.add(n); members.push({ n, dp: Math.floor(rng() * 900) + 40 }); }
    return members;
  }
  const social = { msg: "" };
  V.social = function (el) {
    const S = P.S;
    const rows = S.friends.map((f, i) => {
      const st = friendStatus(f);
      return '<li class="friend"><span class="av ' + (st === "Online" ? "on" : st === "In a duel" ? "busy" : "") + '" aria-hidden="true">' + esc(f.name.slice(0, 1).toUpperCase()) + '</span><span class="fr-main"><b>' + esc(f.name) + '</b><span class="dg-note">' + esc(st) + " · likes " + esc(friendFav(f)) + '</span></span><span class="dg-mono dg-muted">' + fmt(f.rating) + '</span><button class="dg-btn slim" data-challenge="' + i + '"' + (P.games().length ? "" : " disabled") + ">Challenge</button></li>";
    }).join("");
    const clubs = P.CLUBS.map((c) => {
      const t = clubTable(c).reduce((a, m) => a + m.dp, 0) + (S.club === c.id ? S.week.dp : 0);
      return Object.assign({}, c, { total: t });
    }).sort((a, b) => b.total - a.total);
    const my = P.CLUBS.find((c) => c.id === S.club);
    let members = "";
    if (my) {
      const m = clubTable(my).concat([{ n: S.name, dp: S.week.dp, me: true }]).sort((a, b) => b.dp - a.dp);
      members = '<h4 class="sub-h">' + esc(my.name) + ' · members this week</h4><div class="dg-scroll-x"><table class="dg-table"><thead><tr><th>#</th><th>Member</th><th class="num">Duel points</th></tr></thead><tbody>' +
        m.map((x, i) => '<tr class="' + (x.me ? "me" : "") + '"><td class="dg-mono">' + (i + 1) + "</td><td>" + esc(x.n) + '</td><td class="num">' + fmt(x.dp) + "</td></tr>").join("") + "</tbody></table></div>";
    }
    const rng = slotRng("act", 60000);
    const acts = [];
    const games = P.games();
    for (let i = 0; i < 6 && S.friends.length; i++) {
      const f = U.pick(rng, S.friends), g = games.length ? U.pick(rng, games).name : "a duel";
      const k = Math.floor(rng() * 4);
      acts.push("<li><b>" + esc(f.name) + "</b> " + ["won a duel in " + esc(g), "reached a new best in " + esc(g), "joined a tournament in " + esc(g), "is on a " + (2 + Math.floor(rng() * 4)) + "-win streak"][k] + '<span class="dg-mono dg-muted feed-t">' + (1 + Math.floor(rng() * 50)) + "m</span></li>");
    }
    P.ensureToday();
    el.innerHTML = sectionHead("Social", "") +
      '<div class="two">' +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Friends</h3><span class="dg-eyebrow">' + S.friends.length + '</span></div><ul class="friends" id="friendList">' + (rows || '<li class="dg-note">No friends yet.</li>') + "</ul>" +
      '<form class="add-friend" id="addFriend" autocomplete="off"><label for="friendName">Add a friend by name</label><div class="dg-row"><input class="inp" id="friendName" maxlength="20" placeholder="Player name" required><button class="dg-btn" type="submit" id="friendAdd">Add</button></div><p class="dg-note" id="friendMsg" aria-live="polite">' + esc(social.msg) + "</p></form></section>" +
      '<div class="dg-stack">' +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Clubs</h3><span class="dg-eyebrow">Weekly · duel points</span></div>' +
      '<p class="dg-note">' + (my ? "You are in <b class=\"dg-gold\">" + esc(my.name) + "</b>. Your duel points this week count for the club." : "Join a club. Your duel points this week count toward its total.") + "</p>" +
      '<div class="dg-scroll-x"><table class="dg-table" id="clubTable"><thead><tr><th>#</th><th>Club</th><th class="num">Points</th><th></th></tr></thead><tbody>' +
      clubs.map((c, i) => '<tr class="' + (S.club === c.id ? "me" : "") + '"><td class="dg-mono">' + (i + 1) + "</td><td><b>" + esc(c.name) + '</b><span class="dg-note club-motto">' + esc(c.motto) + '</span></td><td class="num">' + fmt(c.total) + '</td><td class="num"><button class="dg-btn slim" data-club="' + c.id + '">' + (S.club === c.id ? "Leave" : "Join") + "</button></td></tr>").join("") + "</tbody></table></div>" + members + "</section>" +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Friend activity</h3><span class="dg-eyebrow">Simulated</span></div><ul class="feedlist">' + (acts.join("") || '<li class="dg-note">Quiet right now.</li>') + "</ul></section>" +
      "</div></div>";
    el.querySelectorAll("[data-challenge]").forEach((b) => (b.onclick = () => {
      const f = S.friends[+b.dataset.challenge]; if (!f) return;
      P.openDuelSheet({ opponent: { name: f.name, rating: f.rating }, format: "1v1", pick: P.game(P.dn.pick) ? P.dn.pick : "any" });
    }));
    el.querySelector("#addFriend").onsubmit = (e) => {
      e.preventDefault();
      const n = el.querySelector("#friendName").value.replace(/\s+/g, " ").trim();
      if (!n) { social.msg = "Enter a name."; return V.social(el); }
      if (n.length > 20) { social.msg = "Names are up to 20 characters."; return V.social(el); }
      if (S.friends.some((f) => f.name.toLowerCase() === n.toLowerCase())) { social.msg = n + " is already your friend."; return V.social(el); }
      if (S.friends.length >= 50) { social.msg = "Friend list is full (50)."; return V.social(el); }
      S.friends.push({ name: n, rating: 1100 + (U.hashSeed("r:" + n) % 500), added: true });
      social.msg = n + " added. Friend requests are simulated in this demo.";
      P.commit();
    };
    el.querySelectorAll("[data-club]").forEach((b) => (b.onclick = () => {
      S.club = S.club === b.dataset.club ? null : b.dataset.club; P.commit();
    }));
  };

  /* ================= Profile ================= */
  const prof = { hist: "all" };
  V.profile = function (el) {
    const S = P.S, games = P.games();
    const total = S.rec.w + S.rec.l + S.rec.d;
    const ov = P.overall();
    const mastered = games.filter((g) => P.mastered(g.id)).length;
    const frame = P.cosVal("frame"), title = P.cosVal("title"), color = P.cosVal("color");
    const tile = (k, v, sub, id) => '<div class="dg-stat"' + (id ? ' id="' + id + '"' : "") + '><span class="dg-eyebrow">' + k + "</span><b>" + v + "</b>" + (sub ? '<span class="dg-note">' + sub + "</span>" : "") + "</div>";
    const hist = S.history.filter((h) => prof.hist === "all" || h.g === prof.hist || (h.games && h.games.includes(prof.hist)));
    const histGames = Array.from(new Set(S.history.map((h) => h.g))).map((id) => ({ id, name: id === "mix" ? "Duel Mix" : (P.game(id) || {}).name || (S.history.find((h) => h.g === id) || {}).gn || id }));
    el.innerHTML =
      '<div class="prof-head"><div class="avatar' + (frame ? " f-" + esc(frame) : "") + '" aria-hidden="true">' + esc((S.name || "Y").slice(0, 1).toUpperCase()) + "</div>" +
      '<div><h2 class="dg-h prof-name" id="profName"' + (color ? ' style="color:' + esc(color) + '"' : "") + ">" + esc(S.name) + "</h2>" +
      '<p class="dg-muted">' + (title ? '<span class="dg-gold">' + esc(title) + "</span> · " : "") + esc(P.division(ov)) + " division · " + "Demo account" + "</p></div>" +
      '<button class="dg-btn prof-set" data-go="settings">Settings</button></div>' +
      '<div class="tiles" id="statTiles">' +
      tile("Player rating", fmt(ov), esc(P.division(ov)), "tRating") +
      tile("Win rate", total ? Math.round((S.rec.w / total) * 100) + "%" : "–", S.rec.w + "–" + S.rec.l + "–" + S.rec.d + (S.rec.p ? " · " + S.rec.p + " placed" : ""), "tWinrate") +
      tile("Gold", '<span class="dg-gold">' + fmt(S.gold) + "</span>", "Demo currency", "tGold") +
      tile("Duel points", fmt(S.dp), "Spend in the shop", "tDp") +
      tile("Tournament points", fmt(S.tp), "This season", "tTp") +
      tile("Rank", "#" + fmt(P.rank(ov)), "of " + fmt(P.POP) + " players", "tRank") +
      tile("Games mastered", mastered + " / " + games.length, "1,400+ or 5 wins", "tMastered") +
      tile("Current streak", String(S.streak), "Best " + S.bestStreak, "tStreak") + "</div>" +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">By game</h3><span class="dg-eyebrow">Bronze · Silver 1250 · Gold 1400 · Diamond 1550 · Master 1700</span></div>' +
      (games.length ? '<div class="dg-scroll-x"><table class="dg-table" id="gameTable"><thead><tr><th>Game</th><th class="num">Rating</th><th>Division</th><th class="num">W–L–D</th><th class="num">Best</th></tr></thead><tbody>' +
        games.map((g) => { const s = S.games[g.id]; return "<tr><td>" + esc(g.name) + (P.mastered(g.id) ? ' <span class="badge cash">Mastered</span>' : "") + '</td><td class="num">' + fmt(P.rating(g.id)) + "</td><td>" + esc(P.division(P.rating(g.id))) + '</td><td class="num">' + (s ? s.w + "–" + s.l + "–" + s.d : "0–0–0") + '</td><td class="num">' + (s && s.best != null ? esc(g.fmtScore(s.best)) : "–") + "</td></tr>"; }).join("") + "</tbody></table></div>" : '<p class="dg-note">No games installed.</p>') + "</section>" +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Match history</h3><span class="dg-eyebrow">Last 50</span></div>' +
      '<label class="sr" for="histFilter">Filter by game</label><select class="inp hist-sel" id="histFilter"><option value="all">All games</option>' + histGames.map((g) => '<option value="' + esc(g.id) + '"' + (prof.hist === g.id ? " selected" : "") + ">" + esc(g.name) + "</option>").join("") + "</select>" +
      (hist.length ? '<div class="dg-scroll-x"><table class="dg-table hist" id="histTable"><thead><tr><th>Game</th><th>Format</th><th>Result</th><th>Opponent</th><th class="num">Net</th><th class="num">Rating</th></tr></thead><tbody>' +
        hist.map((h) => '<tr><td>' + esc(h.gn) + "</td><td>" + esc(P.fmtName(h.f)) + (h.stake ? ' <span class="dg-muted dg-mono">' + fmt(h.stake) + "</span>" : "") + '</td><td class="o-' + esc(h.o) + '"><b>' + esc({ win: "W", loss: "L", draw: "D", place: "2nd" }[h.o] || "") + "</b> " + esc(h.s || "") + "</td><td>" + esc(h.vs || "") + '</td><td class="num ' + (h.net > 0 ? "dg-good" : h.net < 0 ? "dg-bad" : "") + '">' + P.signed(h.net) + '</td><td class="num">' + P.signed(h.dr || 0) + "</td></tr>").join("") + "</tbody></table></div>" : '<p class="dg-note" id="histEmpty">No matches yet.</p>') + "</section>" +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Achievements</h3><span class="dg-eyebrow">' + Object.keys(S.ach).length + " / " + P.ACH.length + '</span></div><ul class="ach" id="achList">' +
      P.ACH.map((a) => '<li class="' + (S.ach[a.id] ? "got" : "") + '" data-ach="' + a.id + '"><b>' + esc(a.name) + '</b><span class="dg-note">' + esc(a.desc) + "</span>" + (S.ach[a.id] ? '<span class="dg-eyebrow dg-gold">Unlocked</span>' : '<span class="dg-eyebrow">Locked</span>') + "</li>").join("") + "</ul></section>" +
      '<section class="dg-box" id="shop"><div class="box-h"><h3 class="dg-h">Duel points shop</h3><span class="dg-eyebrow">Cosmetic only · <span class="dg-mono">' + fmt(S.dp) + '</span> duel points</span></div><ul class="shop" id="shopList">' +
      P.SHOP.map((it) => {
        const own = S.cos.owned.includes(it.id), on = S.cos[it.kind] === it.id;
        const kindName = { frame: "Profile frame", title: "Profile title", color: "Name colour" }[it.kind];
        const label = it.kind === "title" ? String(it.name).replace(/^Title · /, "") : it.name;
        const preview = it.kind === "title" ? '<span class="sw sw-title" aria-hidden="true">T</span>'
          : '<span class="sw sw-' + it.kind + '" style="--sw:' + (it.kind === "frame" ? "var(--" + esc(it.val) + ")" : esc(it.val)) + '" aria-hidden="true"></span>';
        const price = own ? '<span class="shop-price own dg-note">' + (on ? "Equipped" : "Owned") + "</span>"
          : '<span class="shop-price"><b class="dg-mono">' + fmt(it.price) + '</b><small>duel points</small></span>';
        const btn = own ? '<button class="dg-btn slim" data-equip="' + it.id + '" aria-label="' + (on ? "Unequip " : "Equip ") + esc(label) + '">' + (on ? "Unequip" : "Equip") + "</button>"
          : '<button class="dg-btn slim primary" data-buy="' + it.id + '" aria-label="Buy ' + esc(label) + " for " + fmt(it.price) + ' duel points"' + (S.dp < it.price ? " disabled" : "") + ">Buy</button>";
        return '<li class="shop-item' + (on ? " on" : "") + '" data-item="' + it.id + '">' + preview + '<span class="shop-main"><b>' + esc(label) + '</b><span class="dg-note">' + esc(kindName) + "</span></span>" + price + btn + "</li>";
      }).join("") + "</ul></section>";
    el.querySelector("#histFilter").onchange = (e) => { prof.hist = e.target.value; V.profile(el); };
    el.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = () => { const e = P.buy(b.dataset.buy); P.toast(e || "Purchased and equipped.", e ? "bad" : "gold"); }));
    el.querySelectorAll("[data-equip]").forEach((b) => (b.onclick = () => P.equip(b.dataset.equip)));
  };

  /* ================= Settings & responsible play ================= */
  const setMsg = { loss: "" };
  V.settings = function (el) {
    const S = P.S; P.ensureToday();
    const L = S.limits;
    const lossOpts = [0, 1000, 2500, 5000];
    const custom = L.loss > 0 && !lossOpts.includes(L.loss);
    el.innerHTML = sectionHead("Settings", '<span class="dg-muted">Account</span>') +
      '<div class="two">' +
      '<div class="dg-stack">' +
      '<section class="dg-box" id="todayBox"><div class="box-h"><h3 class="dg-h">Today</h3><span class="dg-eyebrow">' + esc(P.dayKey()) + "</span></div>" +
      '<div class="tiles small"><div class="dg-stat"><span class="dg-eyebrow">Played</span><b id="tdPlayed">' + S.today.played + '</b></div><div class="dg-stat"><span class="dg-eyebrow">W–L–D</span><b>' + S.today.w + "–" + S.today.l + "–" + S.today.d + '</b></div><div class="dg-stat"><span class="dg-eyebrow">Net gold</span><b id="tdNet" class="' + (S.today.net > 0 ? "dg-good" : S.today.net < 0 ? "dg-bad" : "") + '">' + P.signed(S.today.net) + '</b></div><div class="dg-stat"><span class="dg-eyebrow">Session</span><b id="tdSession">' + Math.floor((Date.now() - P.sessionStart) / 60000) + " min</b></div></div></section>" +
      '<section class="dg-box" id="lossBox"><div class="box-h"><h3 class="dg-h">Daily loss limit</h3><span class="dg-eyebrow">Gold</span></div>' +
      '<p class="dg-note">Staked play stops for the day once your net loss reaches the limit. Lowering it applies at once; raising or removing it takes effect after 24 hours. Lost today: <b class="dg-mono">' + fmt(P.lossToday()) + "</b>" + (L.loss ? " of " + fmt(L.loss) : "") + ".</p>" +
      (L.pending ? '<p class="dg-note pending" id="lossPending">Change to ' + (L.pending.loss ? fmt(L.pending.loss) : "off") + " takes effect at " + esc(new Date(L.pending.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })) + ".</p>" : "") +
      '<div class="chips" role="group" aria-label="Daily loss limit">' + lossOpts.map((v) => '<button class="dg-chip dg-mono" id="loss-' + v + '" data-loss="' + v + '" aria-pressed="' + (L.loss === v && !custom) + '">' + (v ? fmt(v) : "Off") + "</button>").join("") + "</div>" +
      '<div class="dg-row lim-custom"><label class="sr" for="lossCustom">Custom limit</label><input class="inp dg-mono" id="lossCustom" inputmode="numeric" placeholder="Custom" value="' + (custom ? L.loss : "") + '"><button class="dg-btn" id="lossSet">Set</button></div><p class="dg-note" id="lossMsg">' + esc(setMsg.loss) + "</p></section>" +
      '<section class="dg-box" id="remindBox"><div class="box-h"><h3 class="dg-h">Session reminder</h3></div><p class="dg-note">A reminder shows time played and today\'s result.</p><div class="chips" role="group" aria-label="Session reminder">' +
      [0, 15, 30, 60].map((v) => '<button class="dg-chip" id="remind-' + v + '" data-remind="' + v + '" aria-pressed="' + (L.remind === v) + '">' + (v ? "Every " + v + " min" : "Off") + "</button>").join("") + "</div></section>" +
      "</div>" +
      '<div class="dg-stack">' +
      '<section class="dg-box cash-box" id="cash"><div class="box-h"><h3 class="dg-h">' + P.icon("lock", "sm") + ' Cash wallet</h3><span class="dg-eyebrow">Locked</span></div>' +
      '<p class="cash-bal dg-mono">€0.00</p><p>Cash play is not available. Duel.gold is a demo: gold has no cash value and cannot be bought, sold or withdrawn.</p>' +
      '<p class="dg-note">A real-money version would need all of this before launch:</p><ul class="plain"><li>Age and identity verification (KYC) for every player</li><li>UK-only location checks</li><li>A licensed payment provider</li><li>Legal review of the entry and prize structure</li><li>Server-side score verification</li></ul>' +
      '<p class="dg-note">Only cash-eligible games would qualify: deterministic, skill-dominant games with a luck rating of 2 or less. Games marked "Gold only" would stay demo-only.</p></section>' +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">Player name</h3></div><form class="dg-row" id="nameForm"><label class="sr" for="nameInp">Player name</label><input class="inp" id="nameInp" maxlength="16" value="' + esc(S.name) + '"><button class="dg-btn" type="submit">Save</button></form></section>' +
      '<section class="dg-box"><div class="box-h"><h3 class="dg-h">About</h3></div><p class="dg-note"><a href="#fair" id="fairLink" class="tap-link">How Duel.gold works</a> · identical seeds, skill/luck meters, rating-based matchmaking and the 10% fee.</p>' +
      '<p class="dg-note" id="storageNote">' + (P.storage.ok ? "Progress is saved in this browser." : "This browser blocks storage, so progress lasts only until you close the page.") + "</p></section>" +
      '<section class="dg-box danger-box"><div class="box-h"><h3 class="dg-h">Reset demo data</h3></div><p class="dg-note">Clears gold, ratings, history and achievements on this device. Your loss limit and reminder are kept.</p><button class="dg-btn danger" id="resetBtn">Reset demo data</button></section>' +
      "</div></div>";
    const setLimit = (v) => {
      const r = P.setLossLimit(v);
      setMsg.loss = r.now ? (v ? "Daily loss limit set to " + fmt(v) + "." : "Daily loss limit off.")
        : (v ? "Limit of " + fmt(v) : "Removing the limit") + " takes effect at " + new Date(r.at).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) + ".";
      V.settings(el);
    };
    el.querySelectorAll("[data-loss]").forEach((b) => (b.onclick = () => setLimit(+b.dataset.loss)));
    el.querySelector("#lossSet").onclick = () => {
      const t = el.querySelector("#lossCustom").value.trim();
      if (!/^\d+$/.test(t) || +t < 10 || +t > 1000000) { setMsg.loss = "Enter a whole number from 10 to 1,000,000."; return V.settings(el); }
      setLimit(+t);
    };
    el.querySelectorAll("[data-remind]").forEach((b) => (b.onclick = () => { L.remind = +b.dataset.remind; P.commit(); P.scheduleReminder(); }));
    el.querySelector("#nameForm").onsubmit = (e) => {
      e.preventDefault();
      const n = el.querySelector("#nameInp").value.replace(/\s+/g, " ").trim().slice(0, 16);
      if (n) { S.name = n; P.commit(); P.toast("Name saved."); }
    };
    el.querySelector("#resetBtn").onclick = () => P.confirm({ title: "Reset demo data?", text: "This clears gold, ratings, history and achievements on this device. Your loss limit and reminder stay in place. It cannot be undone.", ok: "Reset", danger: true, testId: "reset-confirm",
      onOk: () => { P.reset(); P.toast("Demo data reset."); } });
  };

  /* ================= Fairness ================= */
  V.fair = function (el) {
    el.innerHTML = sectionHead("How Duel.gold works", '<a class="dg-btn" href="#settings">Back to settings</a>') +
      '<div class="fair">' +
      [["Identical seeds", "Every player in a match gets the same seed, so the same puzzle, board, questions or waves. The seed is shown before you start."],
        ["Skill and luck meters", "Every game is rated 0–10 for how much skill and how much luck decide the winner. High-luck games are marked Gold only."],
        ["Rating-based matchmaking", "Each game has its own Elo rating (K = 24). You meet opponents within about 60 points of your rating."],
        ["10% fee", "The pot is every stake combined. The winner receives the pot minus 10%. In 1v1 that is 1.8× your stake; a draw refunds both players."],
        ["Formats", "2v2 adds team scores. FFA pays 70% / 30% of the net pot to 1st and 2nd. Tournaments pay 60% / 25% / 7.5% / 7.5%. Payouts round down to whole gold."],
        ["Simulated opponents", "In this prototype every opponent is a bot playing the same seeded challenge at a skill set by its rating."],
        ["What production needs", "Scores would be verified on a server that replays each seed and input log, plus identity checks, location checks and a licensed payment provider for any cash play."],
        ["Account", "Set a daily loss limit or session reminders at any time in Settings."]]
        .map((x) => '<div class="fair-i"><b>' + esc(x[0]) + '</b><p class="dg-muted">' + esc(x[1]) + "</p></div>").join("") + "</div>";
  };
})();
