/* Duel.gold platform — match runner: matchmaking, escrow, every format, settlement, spectating.
   Money rules live in DGP.econ (state.js); everything here uses integer gold. */
(function () {
  "use strict";
  const DG = window.DG, U = DG.util, P = window.DGP, E = P.econ;
  const esc = P.esc, $ = P.$;
  const M = (P.match = { cur: null, speed: 1, last: null });
  let token = 0;

  /* ---------------- small helpers ---------------- */
  const newSeed = () => 100000 + Math.floor(Math.random() * 900000);
  const rnd = () => Math.random();
  function later(cur, fn, ms, realTime) {
    const id = setTimeout(() => { cur.timers.delete(id); if (M.cur === cur && !cur.closed) { try { fn(); } catch (e) { console.error("[Duel.gold] runner error", e); } } }, Math.max(0, ms) / (realTime ? 1 : M.speed));
    cur.timers.add(id);
    return id;
  }
  function every(cur, fn, ms) {
    const id = setInterval(() => { if (M.cur === cur && !cur.closed) { try { fn(); } catch (e) { console.error(e); clearInterval(id); } } }, ms);
    cur.timers.add(id);
    return id;
  }
  /* the active match is mirrored into saved state so a reload can settle it (see M.recover) */
  function persist(cur) {
    if (!cur || cur.format === "watch") return;
    const g = cur.games[0];
    const phase = cur.phase === "mm" ? "mm" : "play";
    P.S.active = { game: g.id, gn: cur.format === "mix" ? "Duel Mix" : g.name, format: cur.format, stake: cur.stake, escrow: cur.escrow, phase,
      opp: cur.opps && cur.opps[0] ? cur.opps[0].rating : P.rating(g.id), vs: cur.opps ? cur.opps.map((p) => p.name).join(", ") : "", unrated: unrated(cur, g.id),
      tour: cur.setup.tour && cur.setup.tour.once ? { id: cur.setup.tour.id, once: cur.setup.tour.once } : null };
  }
  function unpersist() { P.S.active = null; }
  M.persist = persist;
  function clearTimers(cur) { cur.timers.forEach((id) => { clearTimeout(id); clearInterval(id); }); cur.timers.clear(); }

  /* sanitise game-provided detail HTML: strip active content */
  P.cleanHTML = function (html) {
    if (html == null || html === "") return "";
    const t = document.createElement("template");
    t.innerHTML = String(html);
    t.content.querySelectorAll("script,style,iframe,object,embed,link,meta,form,base").forEach((n) => n.remove());
    t.content.querySelectorAll("*").forEach((n) => {
      for (const a of Array.from(n.attributes)) {
        const nm = a.name.toLowerCase();
        if (nm.startsWith("on") || ((nm === "href" || nm === "src" || nm === "xlink:href") && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name);
      }
    });
    const d = document.createElement("div");
    d.appendChild(t.content.cloneNode(true));
    return d.innerHTML;
  };

  /* A game's own setup (def.setup) travels as setup.options = { game, values }; it only applies to that game. */
  const optsFor = (cur, gid) => { const o = cur.setup.options; return o && o.game === gid && o.values ? o.values : null; };
  const setupDefOf = (gid) => { const g = P.game(gid); return (g && g.raw && g.raw.setup) || null; };
  function setupAsk(cur, gid, fn, d) {
    const v = optsFor(cur, gid), def = setupDefOf(gid);
    if (!v || !def || typeof def[fn] !== "function") return d;
    try { return def[fn](v); } catch (e) { console.error("[Duel.gold] game setup error", e); return d; }
  }
  const unrated = (cur, gid) => setupAsk(cur, gid, "rated", true) === false;
  const spreadFor = (cur) => { const r = Number(setupAsk(cur, cur.games[0].id, "ratingRange", 60)); return r > 0 ? r : 60; };
  const setupLabel = (cur) => (cur.format === "mix" ? "" : String(setupAsk(cur, cur.games[0].id, "summary", "") || ""));

  /* opponents: names from the pool, rating = base ± spread (60 unless the game's setup sets a range), skill from rating */
  function makePeople(n, base, exclude, spread) {
    const sp = spread > 0 ? spread : 60;
    const used = new Set((exclude || []).map((x) => x.toLowerCase()));
    used.add("you");
    const pool = U.shuffle(rnd, P.NAMES).filter((nm) => !used.has(nm.toLowerCase()));
    const out = [];
    for (let i = 0; i < n; i++) {
      const name = pool[i % pool.length] + (i >= pool.length ? " " + (i + 1) : "");
      const rating = Math.max(600, Math.round(base + (rnd() * 2 - 1) * sp));
      out.push({ name, rating, skill: U.skillFromRating(rating) });
    }
    return out;
  }
  const personOf = (o) => ({ name: String(o.name).slice(0, 24), rating: Math.round(o.rating), skill: U.skillFromRating(o.rating) });
  const meFor = (gid) => ({ name: P.S.name || "You", rating: P.rating(gid) });

  /* run a race bot safely and normalise its output */
  function runBot(game, seed, p, mode) {
    const r = game.raw.bot(seed, p.skill, U.rng(seed + ":" + p.name), mode);
    if (!r || !Number.isFinite(Number(r.score))) throw new Error(game.id + ".bot returned no numeric score");
    const score = Number(r.score);
    let tl = Array.isArray(r.timeline) ? r.timeline.filter((e) => Array.isArray(e) && Number.isFinite(+e[0]) && Number.isFinite(+e[1])).map((e) => [+e[0], +e[1]]) : [];
    tl.sort((a, b) => a[0] - b[0]);
    if (!tl.length) tl = [[0, 0], [mode === "mix" ? 30 : 60, score]];
    if (tl[tl.length - 1][1] !== score) tl.push([tl[tl.length - 1][0], score]);
    return { score, timeline: tl };
  }
  M.runBot = runBot;
  function atTime(tl, t) {
    let pt = 0, ps = 0;
    for (const [tt, s] of tl) {
      if (tt <= t) { pt = tt; ps = s; continue; }
      const f = tt === pt ? 1 : (t - pt) / (tt - pt);
      return ps + (s - ps) * Math.max(0, Math.min(1, f));
    }
    return ps;
  }
  M.atTime = atTime;

  /* ---------------- choosing games ---------------- */
  P.poolFor = function (pick, format) {
    let g = P.games().filter((x) => P.supports(x, format));
    if (pick === "favs") g = g.filter((x) => P.S.favs.includes(x.id));
    else if (pick && pick.startsWith("cat:")) g = g.filter((x) => x.category === pick.slice(4));
    else if (pick && pick !== "any" && pick !== "surprise") g = g.filter((x) => x.id === pick);
    return g;
  };
  function choose(pick, format, n, info) {
    const pool = P.poolFor(pick, format);
    if (!pool.length) return [];
    if (n === 1) {
      if (pick === "any") { // weighted by live popularity
        const w = pool.map((g) => P.playing(g.id)); let r = rnd() * w.reduce((a, b) => a + b, 0);
        for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return [pool[i]]; }
        return [pool[pool.length - 1]];
      }
      if (pick === "surprise") { // prefer games you have not played yet
        const fresh = pool.filter((g) => !P.S.games[g.id]);
        return [U.pick(rnd, fresh.length ? fresh : pool)];
      }
      return [U.pick(rnd, pool)];
    }
    /* Duel Mix: n different games, preferring different categories */
    const out = [], cats = new Set();
    const shuffled = U.shuffle(rnd, pool);
    for (const g of shuffled) if (out.length < n && !cats.has(g.category)) { out.push(g); cats.add(g.category); }
    for (const g of shuffled) if (out.length < n && !out.includes(g)) out.push(g);
    if (out.length < n) {
      /* not enough distinct games in the chosen filter: fill from the rest of the mix pool */
      const extra = U.shuffle(rnd, P.poolFor("any", format).filter((g) => !out.includes(g)));
      for (const g of extra) if (out.length < n) { out.push(g); if (info) info.filled = (info.filled || 0) + 1; }
    }
    while (out.length < n) out.push(out[out.length % Math.max(1, out.length)] || shuffled[0]);
    return out;
  }

  /* ---------------- overlay chrome ---------------- */
  const ov = () => $("#ov");
  function openOverlay() {
    const o = ov();
    const ae = document.activeElement;
    M.returnTo = ae && ae !== document.body && !o.contains(ae) && !(ae.closest && ae.closest(".modal-back")) ? ae : null;
    P.closeModals();
    o.hidden = false;
    document.documentElement.classList.add("ov-open");
    $("#ovRace").hidden = true; $("#ovRace").innerHTML = "";
    $("#ovWarn").hidden = true;
    $("#ovStage").innerHTML = "";
    $("#ovStatus").textContent = "";
    setButtons({});
    setTimeout(() => { if (!o.hidden && !o.contains(document.activeElement)) P.focusHome(); }, 0);
  }
  function closeOverlay() {
    const cur = M.cur;
    if (cur) cur.closing = true;
    if (cur && cur.sim) { try { drainSim(cur); } catch (e) { console.error(e); } }
    if (cur && cur.format !== "watch") {
      /* never leave a match half-settled: before the game starts → refund; once playing (staked or free) → forfeit */
      if (cur.phase === "mm" || cur.phase === "prep" || cur.phase === "error") refund(cur);
      else if (["versus", "ready", "play", "between"].includes(cur.phase)) { try { M.forfeit(false); } catch (e) { console.error(e); refund(cur); } }
      if (cur.escrow > 0) refund(cur);
      unpersist();
    }
    if (cur) {
      cur.closed = true; clearTimers(cur);
      if (cur.handle) { try { cur.handle.abort(); } catch (e) { /* ignore */ } }
    }
    M.cur = null;
    P.matchAch = null;
    ov().hidden = true;
    document.documentElement.classList.remove("ov-open");
    $("#ovStage").innerHTML = ""; $("#ovRace").innerHTML = "";
    P.closeModals("forfeit");
    P.commit();
    const back = M.returnTo; M.returnTo = null;
    if (back && document.contains(back) && P.focusable(back)) try { back.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    else { const m = document.getElementById("main"); if (m) { m.setAttribute("tabindex", "-1"); try { m.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }
  }
  M.close = closeOverlay;
  function setButtons(o) {
    if (!o.forfeit) P.closeModals("forfeit");
    $("#ovForfeit").hidden = !o.forfeit;
    $("#ovForfeit").disabled = false;
    $("#ovForfeit").textContent = o.forfeitLabel || "Forfeit";
    $("#ovLeave").hidden = !o.leave;
    $("#ovLeave").textContent = o.leaveLabel || "Leave";
  }
  function who(p, cls) {
    return '<div class="who ' + cls + '"><b>' + esc(p.name) + '</b><span class="dg-mono">' + P.fmt(p.rating) + "</span></div>";
  }
  /* two players on one side (2v2): one compact block; the partner shows as an initial on narrow screens */
  function pair(a, b, clsA, clsB) {
    const avg = P.fmt((a[0].rating + b[0].rating) / 2);
    return '<div class="who pair"><b><span class="' + clsA + '">' + esc(a[0].name) + '</span> <span class="amp">&amp;</span> <span class="' + clsB + ' full">' + esc(b[0].name) + '</span><span class="' + clsB + ' ini">' + esc(String(b[0].name).slice(0, 1)) + '.</span></b><span class="dg-mono">avg ' + avg + "</span></div>";
  }
  function setBar(left, right, info) {
    $("#ovLeft").innerHTML = left.length === 2 ? pair(left[0], left[1], "c-" + left[0][1], "c-" + left[1][1]) : left.map((x) => who(x[0], x[1])).join("");
    $("#ovRight").innerHTML = right.length > 2
      ? '<div class="who rival"><b>' + right.length + ' rivals</b><span class="dg-mono">avg ' + P.fmt(right.reduce((a, x) => a + x[0].rating, 0) / right.length) + "</span></div>"
      : right.length === 2 ? pair(right[0], right[1], "c-rival", "c-rival") : right.map((x) => who(x[0], x[1])).join("");
    $("#ovInfo").innerHTML = info || "";
  }
  function stage(html) { const s = $("#ovStage"); s.innerHTML = html; $("#ovScroll").scrollTop = 0; return s; }
  function stakeTxt(n) { return n > 0 ? P.fmt(n) + " gold" : "Free"; }

  /* ---------------- start ---------------- */
  /* setup: {game: id | 'any' | 'favs' | 'surprise' | 'cat:<id>', format, stake, opponent?:{name,rating}, tour?:{id,name,added,once}} */
  M.start = function (setup) {
    if (M.cur) return "A match is already running.";
    const format = setup.format || "1v1";
    if (!P.FORMATS.some((f) => f.id === format)) return "Unknown format.";
    const rawStake = setup.stake == null ? 0 : setup.stake;
    if (typeof rawStake !== "number" || !Number.isInteger(rawStake) || rawStake < 0) return "Stake must be a whole number of gold, 0 or more.";
    const stake = rawStake;
    const err = P.stakeError(stake); if (err) return err;
    const info = {};
    const games = choose(setup.game || "any", format, format === "mix" ? 3 : 1, info);
    if (!games.length) {
      const g = P.game(setup.game);
      return g ? g.name + " does not support " + P.fmtName(format) + "." : "No game available for " + P.fmtName(format) + " with this filter.";
    }
    if (setup.opponent && !(format === "1v1" || format === "mix")) return "Friend challenges are 1v1 or Duel Mix.";
    if (setup.tour && setup.tour.once) {
      const t = P.S.tours[setup.tour.id];
      if (t && t.entered === setup.tour.once) return "You have already entered " + setup.tour.name + " this period.";
    }
    /* escrow */
    P.S.gold -= stake;
    if (setup.tour && setup.tour.once) { P.S.tours[setup.tour.id] = Object.assign({}, P.S.tours[setup.tour.id], { entered: setup.tour.once }); }
    if (setup.opponent) { P.S.flags.challenged++; P.unlock("rival-call"); }
    const cur = (M.cur = { tok: ++token, setup: Object.assign({}, setup, { format, stake }), format, stake, escrow: stake, games, timers: new Set(), phase: "mm", closed: false, log: [], mixFilled: info.filled || 0 });
    P.matchAch = []; cur.ach = P.matchAch;
    persist(cur); P.commit();
    openOverlay();
    matchmaking(cur);
    return "";
  };

  function refund(cur) {
    if (cur.escrow > 0) { P.S.gold += cur.escrow; }
    const amt = cur.escrow; cur.escrow = 0;
    unpersist();
    if (cur.setup.tour && cur.setup.tour.once) { const t = P.S.tours[cur.setup.tour.id]; if (t) delete t.entered; }
    P.commit();
    return amt;
  }

  function matchmaking(cur) {
    const g = cur.games[0];
    const label = cur.format === "mix" ? "Duel Mix · 3 games" : g.name;
    const base = cur.format === "mix" ? Math.round(cur.games.reduce((a, x) => a + P.rating(x.id), 0) / 3) : P.rating(g.id);
    const sl = setupLabel(cur), spread = spreadFor(cur), noRating = unrated(cur, g.id);
    setBar([[meFor(g.id), "me"]], [], P.fmtName(cur.format) + (sl ? " · " + sl : "") + " · " + stakeTxt(cur.stake));
    $("#ovStatus").textContent = "Matchmaking";
    stage('<div class="mm" data-test="matchmaking"><div class="radar" aria-hidden="true"><i></i></div>' +
      '<p class="mm-line">Finding opponent · ' + esc(label) + (sl ? " · " + esc(sl) : "") + " · " + esc(stakeTxt(cur.stake)) + " · rating ± " + spread + "</p>" +
      '<p class="dg-note">' + (cur.stake > 0 ? P.fmt(cur.stake) + " gold is held in escrow until the result." : noRating ? "Free duel." : "Free duel. Ratings still count.") + (noRating ? " Unrated: your rating will not change." : "") + "</p>" +
      '<button class="dg-btn" id="mmCancel">Cancel</button></div>');
    $("#mmCancel").onclick = () => { refund(cur); closeOverlay(); P.toast("Matchmaking cancelled. Stake returned."); };
    const minMs = 1100 + Math.random() * 700;
    let ready = false, waited = false;
    const proceed = () => { if (ready && waited && M.cur === cur && cur.phase === "mm") versusCard(cur); };
    later(cur, () => { waited = true; proceed(); }, minMs);
    later(cur, async () => {
      try { buildParticipants(cur, base); }
      catch (e) { return fail(cur, e, "before the match started"); }
      /* first round's seed + bot runs happen now, one bot per task, while the radar spins */
      cur.seed = newSeed();
      const spec0 = firstSpec(cur);
      if (spec0) {
        try { cur.pre = { spec: spec0, bots: await prepBots(cur, spec0) }; }
        catch (e) { if (M.cur === cur) fail(cur, e, "while preparing the opponents"); return; }
        if (M.cur !== cur || cur.closed) return;
      }
      ready = true; proceed();
    }, 0);
  }
  /* yield to the event loop so input and rendering stay smooth */
  const yieldTask = () => new Promise((res) => setTimeout(res, 0));
  /* run the race bots for one round, one per task */
  async function prepBots(cur, spec) {
    const g = spec.game;
    if (g.kind !== "race") return null;
    const rivals = spec.opps || cur.opps;
    const out = { rivals: [] };
    for (const p of rivals) {
      await yieldTask();
      if (M.cur !== cur || cur.closed) throw new Error("cancelled");
      out.rivals.push(Object.assign({ p }, runBot(g, spec.seed, p, spec.mode)));
    }
    if (cur.format === "2v2") { await yieldTask(); out.ally = Object.assign({ p: cur.ally }, runBot(g, spec.seed, cur.ally, spec.mode)); }
    return out;
  }
  /* the first round a format will play (tournament and mix set their own specs later) */
  function firstSpec(cur) {
    const f = cur.format;
    if (f === "tournament") return null;
    if (f === "mix") return { game: cur.games[0], mode: "mix", seed: cur.seed, opps: cur.opps };
    return { game: cur.games[0], mode: "full", seed: cur.seed, opps: cur.opps };
  }

  function buildParticipants(cur, base) {
    const f = cur.format, gid = cur.games[0].id;
    const fixed = cur.setup.opponent ? [personOf(cur.setup.opponent)] : null;
    const sp = spreadFor(cur);
    const reuse = cur.setup.people; // rematch: same opponents
    if (f === "1v1" || f === "mix") cur.opps = reuse && reuse.opps || fixed || makePeople(1, base, null, sp);
    else if (f === "2v2") { const ps = reuse ? null : makePeople(3, base, null, sp); cur.ally = reuse ? reuse.ally : ps[0]; cur.opps = reuse ? reuse.opps : ps.slice(1); }
    else if (f === "ffa") cur.opps = reuse && reuse.opps || makePeople(3, base, null, sp);
    else if (f === "tournament") cur.opps = makePeople(7, base, null, sp);
    cur.me = meFor(gid);
    if (f === "tournament") initTour(cur);
  }

  function versusCard(cur) {
    cur.phase = "versus";
    persist(cur); P.save();
    const f = cur.format, g = cur.games[0];
    const seed = cur.seed || (cur.seed = newSeed());
    let left = [[cur.me, "me"]], right = cur.opps.map((p) => [p, "rival"]);
    if (f === "2v2") left.push([cur.ally, "ally"]);
    if (f === "tournament") right = [];
    const sl = setupLabel(cur);
    setBar(left, right, P.fmtName(f) + (sl ? " · " + sl : "") + " · " + stakeTxt(cur.stake));
    $("#ovStatus").textContent = f === "tournament" ? "Bracket" : "Versus";
    setButtons({ forfeit: true });
    if (f === "tournament") return showBracket(cur, true);
    if (f === "mix") return mixTable(cur, true);
    const card = (p, cls) => '<div class="vs-p ' + cls + '"><b>' + esc(p.name) + '</b><span class="dg-mono">' + P.fmt(p.rating) + " · " + esc(P.division(p.rating)) + "</span></div>";
    let sides;
    if (f === "2v2") sides = '<div class="vs-team">' + card(cur.me, "me") + card(cur.ally, "ally") + '</div><div class="vs-x">VS</div><div class="vs-team">' + cur.opps.map((p) => card(p, "rival")).join("") + "</div>";
    else if (f === "ffa") sides = '<div class="vs-ffa">' + card(cur.me, "me") + cur.opps.map((p) => card(p, "rival")).join("") + "</div>";
    else sides = '<div class="vs-team">' + card(cur.me, "me") + '</div><div class="vs-x">VS</div><div class="vs-team">' + card(cur.opps[0], "rival") + "</div>";
    const n = f === "2v2" || f === "ffa" ? 4 : 2;
    const pot = cur.stake * n;
    stage('<div class="versus" data-test="versus"><p class="dg-eyebrow">' + esc(g.name) + " · " + esc(P.fmtName(f)) + '</p><div class="vs-sides' + (f === "ffa" ? " ffa" : "") + '">' + sides + "</div>" +
      '<p class="vs-meta dg-mono">Seed #' + seed + " · identical for every player</p>" +
      '<p class="vs-meta">' + (cur.stake > 0 ? "Stake " + P.fmt(cur.stake) + " each · pot " + P.fmt(pot) + " · " + esc(potLine(f, cur.stake)) : "Free duel · rating and duel points only") + "</p></div>" +
      '<div id="rulesSlot"></div>');
    playRound(cur, { game: g, mode: "full", seed, slot: "#rulesSlot", opps: cur.opps }, (out) => settleSimple(cur, out));
  }

  function potLine(f, stake) {
    if (f === "ffa") { const p = E.ffaPrizes(stake, 4); return "1st receives " + P.fmt(p[0]) + ", 2nd " + P.fmt(p[1]); }
    if (f === "tournament") { const t = E.tourPrizes(stake, 0); return "champion " + P.fmt(t.champion); }
    return (f === "2v2" ? "each winner receives " : "winner receives ") + P.fmt(E.winPay(stake));
  }
  P.potNote = function (f, stake, added) {
    if (!stake && !added) return "Free play. No gold changes hands; ratings and duel points still count.";
    if (f === "1v1") return "Pot " + P.fmt(stake * 2) + " · winner receives " + P.fmt(E.winPay(stake)) + " after the 10% fee. A draw refunds both.";
    if (f === "2v2") return "4 players stake " + P.fmt(stake) + " · each winning player receives " + P.fmt(E.winPay(stake)) + " after the 10% fee.";
    if (f === "ffa") { const p = E.ffaPrizes(stake, 4); return "Pot " + P.fmt(stake * 4) + " · " + P.fmt(E.ffaPot(stake, 4)) + " after the 10% fee · 1st " + P.fmt(p[0]) + " · 2nd " + P.fmt(p[1]) + "."; }
    if (f === "tournament") { const t = E.tourPrizes(stake, added || 0); return "8 entries of " + P.fmt(stake) + (added ? " + " + P.fmt(added) + " added" : "") + " · prize pool " + P.fmt(t.pool) + " · champion " + P.fmt(t.champion) + " · runner-up " + P.fmt(t.runnerUp) + " · semi-finalists " + P.fmt(t.semi) + " each."; }
    if (f === "mix") return "3 rounds, one stake · pot " + P.fmt(stake * 2) + " · winner receives " + P.fmt(E.winPay(stake)) + " after the 10% fee.";
    return "";
  };

  /* ---------------- one game round ----------------
     spec: {game, mode, seed, slot (selector for the rules card), opps (ctx opponents), label}
     done({ok:true, res, bots}) | ({ok:false, err}) | ({forfeit:true, bots}) */
  function playRound(cur, spec, done) {
    const g = spec.game, f = cur.format;
    const rivals = spec.opps || cur.opps;
    const rid = (cur.rid = (cur.rid || 0) + 1);
    cur.round = { spec, bots: null, done, finished: false, id: rid };
    cur.phase = "ready";
    P.closeModals("forfeit");
    setButtons({ forfeit: true });
    const slot = $(spec.slot || "#ovStage");
    const rules = g.rules.map((r) => "<li>" + esc(r) + "</li>").join("");
    slot.innerHTML = '<div class="rules-card dg-box" data-test="rules">' +
      '<div class="rules-head"><div><p class="dg-eyebrow">' + esc(spec.label || "How to play") + '</p><h2 class="dg-h">' + esc(g.name) + '</h2></div><span class="dg-chip">' + esc(g.duration || (g.kind === "race" ? "Race" : "Versus")) + "</span></div>" +
      '<ul class="rules-list">' + rules + "</ul>" +
      (g.kind === "race" ? '<p class="dg-note">Race: you and ' + (rivals.length > 1 || f === "2v2" ? "every bot" : esc(rivals[0].name)) + " get the same seed. Higher " + esc(g.scoreLabel) + " wins." + (spec.mode === "mix" ? " Short Duel Mix version." : "") + "</p>" : '<p class="dg-note">Head-to-head against ' + esc(rivals[0].name) + ".</p>") +
      '<div class="rules-go"><button class="dg-btn primary big" id="mStart" data-test="start" disabled>Start</button><span class="dg-note" id="mAuto" aria-live="polite">Preparing opponents…</span></div></div>';
    const btn = $("#mStart");
    const enable = () => {
      if (M.cur !== cur || cur.round.id !== rid) return;
      btn.disabled = false;
      const a = $("#mAuto"); if (a) a.textContent = "Press Start when you are ready.";
      if (!P.topModal()) try { btn.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    };
    btn.onclick = () => {
      if (cur.phase !== "ready" || cur.round.id !== rid || btn.disabled) return;
      startGame(cur, spec, cur.round.bots, done);
    };
    const pre = cur.pre && cur.pre.spec.game === g && cur.pre.spec.seed === spec.seed ? cur.pre : null;
    cur.pre = null;
    if (pre || g.kind !== "race") { cur.round.bots = pre ? pre.bots : null; enable(); return; }
    prepBots(cur, spec).then((bots) => { if (M.cur === cur && cur.round.id === rid) { cur.round.bots = bots; enable(); } })
      .catch((e) => { if (M.cur === cur && cur.round.id === rid && String(e && e.message) !== "cancelled") fail(cur, e, "while preparing the opponents"); });
  }

  function startGame(cur, spec, bots, done) {
    const g = spec.game, f = cur.format;
    cur.phase = "play";
    $("#ovStatus").textContent = "";
    const s = stage('<div class="game-root" id="gameRoot" data-game="' + esc(g.id) + '"></div>');
    const root = s.querySelector("#gameRoot");
    const rivals = spec.opps || cur.opps;
    let errored = null, handle = null;
    const r = cur.round;
    r.my = 0;
    const onError = (e) => {
      if (r.finished || M.cur !== cur) return;
      errored = e || new Error("game error");
      r.finished = true;
      if (handle) try { handle.abort(); } catch (x) { /* ignore */ }
      Promise.resolve().then(() => fail(cur, errored, "during play"));
    };
    try {
      handle = DG.start(g.raw, {
        root, seed: spec.seed, mode: spec.mode, format: f === "mix" ? "mix" : f,
        me: { name: cur.me.name, rating: P.rating(g.id) },
        opponents: rivals.map((p) => ({ name: p.name, rating: p.rating, skill: p.skill })),
        teammates: f === "2v2" ? [{ name: cur.ally.name, rating: cur.ally.rating, skill: cur.ally.skill }] : [],
        speed: M.speed,
        options: optsFor(cur, g.id) || undefined,
        onStatus: (t) => { if (!r.finished) $("#ovStatus").textContent = String(t).slice(0, 80); },
        onProgress: (sc) => { const n = Number(sc); if (Number.isFinite(n)) { r.my = n; } },
        onEnd: (res) => {
          if (r.finished || M.cur !== cur) return;
          r.finished = true;
          clearTimers(cur);
          $("#ovRace").hidden = true;
          $("#ovForfeit").disabled = true; $("#ovForfeit").hidden = true;
          P.closeModals("forfeit");
          const bad = validate(g, res);
          if (bad) return fail(cur, new Error(bad), "when reporting the result");
          if (g.kind === "race") r.my = Number(res.score);
          try { done({ ok: true, res, bots }); } catch (e) { console.error("[Duel.gold] settle error", e); fail(cur, e, "while settling"); }
        },
        onError,
      });
    } catch (e) { onError(e); }
    cur.handle = handle;
    if (errored && handle) { try { handle.abort(); } catch (x) { /* ignore */ } }
    if (errored) return;
    if (g.kind === "race") racePanel(cur, bots, handle);
    if (!P.topModal() && !root.contains(document.activeElement)) {
      root.setAttribute("tabindex", "-1");
      try { root.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    }
  }

  function validate(g, res) {
    if (!res || typeof res !== "object") return g.name + " ended without a result.";
    if (g.kind === "race") return Number.isFinite(Number(res.score)) ? "" : g.name + " reported a score that is not a number.";
    return ["win", "loss", "draw"].includes(res.outcome) ? "" : g.name + " reported an unknown outcome.";
  }

  /* live race panel: your ctx.progress score vs each bot timeline at ctx.now()/1000 */
  function racePanel(cur, bots, handle) {
    const box = $("#ovRace");
    const g = cur.round.spec.game;
    const rows = [{ key: "me", name: "You", cls: "me", tl: null }];
    if (bots.ally) rows.push({ key: "ally", name: bots.ally.p.name, cls: "ally", tl: bots.ally.timeline });
    bots.rivals.forEach((b, i) => rows.push({ key: "r" + i, name: b.p.name, cls: "rival", tl: b.timeline }));
    box.innerHTML = '<div class="race" data-test="race">' + rows.map((r) =>
      '<div class="race-row ' + r.cls + '" data-k="' + r.key + '"><span class="race-name">' + esc(r.name) + '</span><span class="race-bar"><i></i></span><b class="dg-mono race-val">0</b></div>').join("") +
      (cur.format === "2v2" ? '<div class="race-team dg-mono" id="raceTeam"></div>' : "") + "</div>";
    box.hidden = false;
    const upd = () => {
      if (!handle || !handle.ctx) return;
      const t = handle.ctx.now() / 1000;
      const vals = rows.map((r) => (r.tl ? atTime(r.tl, t) : cur.round.my));
      const top = Math.max(1, ...vals.map((v) => Math.abs(v))) * 1.15;
      rows.forEach((r, i) => {
        const el = box.querySelector('[data-k="' + r.key + '"]');
        if (!el) return;
        el.querySelector("i").style.width = Math.max(0, Math.min(100, (vals[i] / top) * 100)) + "%";
        el.querySelector(".race-val").textContent = g.fmtScore(Math.round(vals[i] * 100) / 100);
      });
      const tm = box.querySelector("#raceTeam");
      if (tm) tm.innerHTML = '<span class="dg-gold">Team ' + esc(g.fmtScore(Math.round(vals[0] + vals[1]))) + '</span><span class="dg-rival">Rivals ' + esc(g.fmtScore(Math.round(vals[2] + vals[3]))) + "</span>";
    };
    upd();
    every(cur, upd, 200);
  }

  /* ---------------- errors: stop, refund, explain ---------------- */
  function fail(cur, err, when) {
    if (M.cur !== cur || cur.phase === "error") return;
    console.error("[Duel.gold] game failure " + (when || ""), err);
    cur.phase = "error";
    clearTimers(cur);
    if (cur.handle) { try { cur.handle.abort(); } catch (e) { /* ignore */ } }
    $("#ovRace").hidden = true;
    const amt = refund(cur);
    const gname = cur.round ? cur.round.spec.game.name : cur.games[0].name;
    setButtons({ leave: true, leaveLabel: "Back" });
    $("#ovStatus").textContent = "Stopped";
    stage('<div class="result err" data-test="error"><p class="dg-eyebrow">Match stopped</p><h2 class="dg-h">Game error</h2>' +
      '<p>' + esc(gname) + " hit an error " + esc(when || "") + " and was stopped. " + (amt > 0 ? "Your stake of <b class=\"dg-mono\">" + P.fmt(amt) + "</b> gold was refunded." : "No gold was taken.") + "</p>" +
      '<p class="dg-note">' + esc(String((err && err.message) || err).slice(0, 200)) + "</p>" +
      '<div class="res-actions"><button class="dg-btn primary" id="resBack" data-test="back">Back to lobby</button></div></div>');
    $("#resBack").onclick = closeOverlay;
    M.last = { phase: "error", refunded: amt };

  }

  /* ---------------- forfeit ---------------- */
  M.forfeit = function (confirmFirst) {
    const cur = M.cur;
    if (!cur || !["versus", "ready", "play", "between"].includes(cur.phase)) return;
    const doIt = () => {
      if (M.cur !== cur || !["versus", "ready", "play", "between"].includes(cur.phase)) return;
      if (cur.handle) try { cur.handle.abort(); } catch (e) { /* ignore */ }
      if (cur.round) cur.round.finished = true;
      clearTimers(cur);
      $("#ovRace").hidden = true;
      if (cur.format === "tournament") return tourMyResult(cur, { forfeit: true });
      if (cur.format === "mix") return mixForfeit(cur);
      settleSimple(cur, { forfeit: true, bots: cur.round ? cur.round.bots : null });
    };
    if (!confirmFirst) return doIt();
    const rid = cur.round ? cur.round.id : 0, phase = cur.phase;
    const still = () => M.cur === cur && (cur.round ? cur.round.id : 0) === rid && !(cur.round && cur.round.finished) && ["versus", "ready", "play", "between"].includes(cur.phase) && (phase === cur.phase || (phase === "ready" && cur.phase === "play"));
    P.closeModals("forfeit");
    P.modal({
      title: "Forfeit this match?", testId: "forfeit-confirm", tag: "forfeit",
      returnFocus: () => document.getElementById("gameRoot") || document.getElementById("mStart"),
      body: '<p class="modal-text">Forfeiting counts as a loss' + (cur.escrow > 0 ? " and your stake of " + P.fmt(cur.escrow) + " gold goes to the pot" : "") + ".</p>",
      actions: [{ label: "Keep playing", id: "forfeitNo" }, { label: "Forfeit", id: "forfeitYes", kind: "danger", onClick: () => { if (still()) doIt(); } }],
    });
  };

  /* ---------------- settlement: 1v1 / 2v2 / FFA ---------------- */
  function applyGame(gid, outcome, dr, score) {
    const gs = P.gs(gid);
    gs.r = Math.max(100, gs.r + dr);
    if (outcome === "win") gs.w++; else if (outcome === "loss") gs.l++; else gs.d++;
    if (score != null && Number.isFinite(score) && (gs.best == null || score > gs.best)) gs.best = score;
  }
  const sc = (x) => (x === "win" ? 1 : x === "draw" ? 0.5 : 0);

  function settleSimple(cur, out) {
    if (M.cur !== cur || cur.phase === "result") return;
    cur.phase = "result";
    const g = cur.games[0], f = cur.format, stake = cur.stake;
    const myR = P.rating(g.id);
    const res = out.res || {};
    let outcome, payout = 0, dr, place = null, lines = "", table = "";
    let bots = out.bots;
    if (!bots && g.kind === "race" && (f === "2v2" || f === "ffa")) {
      /* forfeited before the bots were ready: run them now (rare) */
      const seed = cur.seed || newSeed();
      bots = { rivals: cur.opps.map((p) => { try { return Object.assign({ p }, runBot(g, seed, p, "full")); } catch (e) { return { p, score: 0, timeline: [[0, 0]] }; } }) };
      if (f === "2v2") { try { bots.ally = Object.assign({ p: cur.ally }, runBot(g, seed, cur.ally, "full")); } catch (e) { bots.ally = { p: cur.ally, score: 0, timeline: [[0, 0]] }; } }
    }
    if (f === "1v1" || (f !== "2v2" && f !== "ffa")) {
      const opp = cur.opps[0];
      let my = null, op = null;
      if (out.forfeit) outcome = "loss";
      else if (g.kind === "race") { my = Number(res.score); op = bots.rivals[0].score; outcome = my > op ? "win" : my < op ? "loss" : "draw"; }
      else { outcome = res.outcome; my = Number.isFinite(+res.myScore) ? +res.myScore : null; op = Number.isFinite(+res.oppScore) ? +res.oppScore : null; }
      if (g.kind === "race" && out.forfeit && bots) op = bots.rivals[0].score;
      payout = outcome === "win" ? E.winPay(stake) : outcome === "draw" ? stake : 0;
      dr = E.elo(myR, opp.rating, sc(outcome));
      if (outcome === "win" && opp.rating >= 1600) P.unlock("giant-slayer");
      lines = scoreLine(g, [["You", my, "me"], [opp.name, op, "rival"]], out.forfeit);
      finish(cur, { outcome, payout, dr: { [g.id]: dr }, score: g.kind === "race" && !out.forfeit ? my : null, lines, detail: res.detail, place,
        summary: (my != null && op != null ? g.fmtScore(my) + "–" + g.fmtScore(op) : outcome), vs: opp.name });
      return;
    }
    if (f === "2v2") {
      const my = out.forfeit ? 0 : Number(res.score);
      const ally = bots.ally.score, r1 = bots.rivals[0].score, r2 = bots.rivals[1].score;
      const team = out.forfeit ? -Infinity : my + ally, them = r1 + r2;
      outcome = team > them ? "win" : team < them ? "loss" : "draw";
      payout = outcome === "win" ? E.winPay(stake) : outcome === "draw" ? stake : 0;
      const tr = (myR + cur.ally.rating) / 2, or = (cur.opps[0].rating + cur.opps[1].rating) / 2;
      dr = E.elo(tr, or, sc(outcome));
      if (outcome === "win") P.unlock("team-player");
      table = '<table class="dg-table res-table"><thead><tr><th>Player</th><th class="num">' + esc(g.scoreLabel) + "</th></tr></thead><tbody>" +
        '<tr class="me"><td>You</td><td class="num">' + (out.forfeit ? "forfeit" : esc(g.fmtScore(my))) + "</td></tr>" +
        '<tr class="ally"><td>' + esc(cur.ally.name) + '</td><td class="num">' + esc(g.fmtScore(ally)) + "</td></tr>" +
        '<tr class="tot"><td>Your team</td><td class="num">' + (out.forfeit ? "–" : esc(g.fmtScore(my + ally))) + "</td></tr>" +
        '<tr class="rival"><td>' + esc(cur.opps[0].name) + '</td><td class="num">' + esc(g.fmtScore(r1)) + "</td></tr>" +
        '<tr class="rival"><td>' + esc(cur.opps[1].name) + '</td><td class="num">' + esc(g.fmtScore(r2)) + "</td></tr>" +
        '<tr class="tot"><td>Rivals</td><td class="num">' + esc(g.fmtScore(them)) + "</td></tr></tbody></table>";
      finish(cur, { outcome, payout, dr: { [g.id]: dr }, score: out.forfeit ? null : my, lines: table, detail: res.detail,
        summary: out.forfeit ? "forfeit" : g.fmtScore(my + ally) + "–" + g.fmtScore(them), vs: cur.opps.map((p) => p.name).join(" & ") });
      return;
    }
    /* FFA */
    const scores = [out.forfeit ? -Infinity : Number(res.score)].concat(bots.rivals.map((b) => b.score));
    const split = E.ffaSplit(scores, E.ffaPrizes(stake, 4));
    place = split.places[0];
    payout = stake > 0 ? split.pay[0] : 0;
    const tiedFirst = place === 1 && split.places.filter((p) => p === 1).length > 1;
    outcome = place === 1 ? (tiedFirst ? "draw" : "win") : payout > stake ? "place" : "loss";
    if (outcome === "win") P.unlock("last-standing");
    const ratings = [myR].concat(cur.opps.map((p) => p.rating));
    dr = E.eloFFA(ratings, scores, 0);
    const names = ["You"].concat(cur.opps.map((p) => p.name));
    const order = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
    table = '<table class="dg-table res-table"><thead><tr><th>#</th><th>Player</th><th class="num">' + esc(g.scoreLabel) + '</th><th class="num">Prize</th></tr></thead><tbody>' +
      order.map((i) => '<tr class="' + (i === 0 ? "me" : "rival") + '"><td class="dg-mono">' + split.places[i] + "</td><td>" + esc(names[i]) + '</td><td class="num">' + (scores[i] === -Infinity ? "forfeit" : esc(g.fmtScore(scores[i]))) + '</td><td class="num">' + (stake > 0 ? P.fmt(split.pay[i]) : "–") + "</td></tr>").join("") + "</tbody></table>";
    finish(cur, { outcome, payout, dr: { [g.id]: dr }, score: out.forfeit ? null : scores[0], lines: table, detail: res.detail, place,
      summary: ordinal(place) + " of 4", vs: cur.opps.map((p) => p.name).join(", ") });
  }
  const ordinal = (n) => n + (n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th");

  function scoreLine(g, sides, forfeit) {
    return '<div class="scoreline">' + sides.map((s, i) =>
      (i ? '<span class="sl-dash">–</span>' : "") + '<div class="sl ' + s[2] + '"><span>' + esc(s[0]) + '</span><b class="dg-mono">' +
      (s[1] == null ? (forfeit && i === 0 ? "FF" : "–") : esc(g.fmtScore(s[1]))) + "</b></div>").join("") + "</div>" +
      (g.kind === "race" ? '<p class="dg-note">' + esc(g.scoreLabel) + "</p>" : "");
  }

  /* apply money + ratings + history, then render the result screen */
  function finish(cur, r) {
    const S = P.S, stake = cur.stake;
    const g = cur.games[0];
    S.gold += r.payout;
    cur.escrow = 0; unpersist();
    const net = r.payout - stake;
    for (const gid in r.dr) if (unrated(cur, gid)) r.dr[gid] = 0;
    for (const gid in r.dr) applyGame(gid, r.outcome === "place" ? "draw" : r.outcome, r.dr[gid], gid === g.id ? r.score : null);
    const dp = E.dpFor(r.outcome === "place" ? "draw" : r.outcome, stake);
    P.addDp(dp);
    P.recordDuel(r.outcome, net);
    if (r.outcome === "win" && stake >= 1000) P.unlock("high-roller");
    P.checkPolymath();
    const drTotal = Object.values(r.dr).reduce((a, b) => a + b, 0);
    P.addHistory({ g: g.id, gn: g.name, f: cur.format, stake, o: r.outcome, place: r.place, s: r.summary, net, dr: drTotal, vs: r.vs, seed: cur.seed });
    P.commit();
    M.last = { phase: "result", outcome: r.outcome, payout: r.payout, net, dr: drTotal, dp, place: r.place, stake };
    resultScreen(cur, Object.assign({}, r, { net, dp, drTotal }));
  }

  function resultScreen(cur, r) {
    cur.phase = "result";
    setButtons({});
    const g = cur.games[0];
    const title = r.title || (cur.format === "ffa" && r.place > 1 ? ordinal(r.place) + " place" : { win: "Victory", loss: "Defeat", draw: "Draw", place: "Placed" }[r.outcome]);
    $("#ovStatus").textContent = "Final";
    const rematchLabel = cur.format === "tournament" ? "Enter again" : "Rematch";
    const rmErr = canRematch(cur);
    const tile = (k, v, cls) => '<div class="dg-stat"><span class="dg-eyebrow">' + k + '</span><b class="' + (cls || "") + '">' + v + "</b></div>";
    stage('<div class="result" data-test="result" data-outcome="' + esc(r.outcome) + '">' +
      '<p class="dg-eyebrow">' + esc(cur.format === "mix" ? "Duel Mix · 3 rounds" : g.name + " · " + P.fmtName(cur.format)) + "</p>" +
      '<h2 class="dg-h res-title ' + esc(r.outcome) + (title.length > 12 ? " long" : "") + '" id="resTitle">' + esc(title) + "</h2>" +
      (r.lines || "") +
      '<div class="res-tiles">' +
      tile("Stake", cur.stake > 0 ? P.fmt(cur.stake) : "Free", "") +
      tile("Payout", P.fmt(r.payout), r.payout > 0 ? "dg-gold" : "") +
      tile("Net", P.signed(r.net), r.net > 0 ? "dg-good" : r.net < 0 ? "dg-bad" : "") +
      (cur.format !== "mix" && unrated(cur, g.id) ? tile("Rating", "Unrated", "") : tile("Rating", P.signed(r.drTotal), r.drTotal > 0 ? "dg-good" : r.drTotal < 0 ? "dg-bad" : "")) +
      tile("Duel points", "+" + P.fmt(r.dp), "") + "</div>" +
      (cur.ach && cur.ach.length ? '<p class="res-ach" data-test="unlocked"><span class="dg-eyebrow dg-gold">Unlocked</span> ' + cur.ach.map((n) => '<span class="ach-pill">' + esc(n) + "</span>").join("") + "</p>" : "") +
      (r.detail ? '<div class="res-detail dg-box">' + P.cleanHTML(r.detail) + "</div>" : "") +
      (r.extra || "") +
      '<div class="res-actions"><button class="dg-btn" id="resBack" data-test="back">Back</button>' +
      (cur.setup.tour && cur.setup.tour.once ? "" : '<button class="dg-btn primary" id="resRematch" data-test="rematch"' + (rmErr ? " disabled" : "") + ">" + rematchLabel + " · " + (cur.stake > 0 ? P.fmt(cur.stake) : "Free") + "</button>") + "</div>" +
      (rmErr && !(cur.setup.tour && cur.setup.tour.once) ? '<p class="dg-note">' + esc(rmErr) + "</p>" : "") + "</div>");
    $("#resBack").onclick = closeOverlay;
    const rb = $("#resRematch");
    if (rb) rb.onclick = () => rematch(cur);
    P.closeModals("forfeit");
    if (!P.topModal()) try { (rb && !rb.disabled ? rb : $("#resBack")).focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }
  function canRematch(cur) {
    if (cur.format !== "mix" && !P.game(cur.games[0].id)) return "This game is no longer available.";
    return P.stakeError(cur.stake);
  }
  function rematch(cur) {
    const setup = Object.assign({}, cur.setup);
    if (cur.format !== "mix") setup.game = cur.games[0].id;
    if (cur.format === "2v2") setup.people = { ally: cur.ally, opps: cur.opps };
    else if (cur.format !== "tournament") setup.people = { opps: cur.opps };
    const back = M.returnTo;
    closeOverlay();
    M.returnTo = back;
    const err = M.start(setup);
    if (err) P.toast(err, "bad");
  }

  /* ---------------- Duel Mix ---------------- */
  function mixTable(cur, first) {
    if (first) { cur.mix = { rounds: [], pts: [0, 0] }; }
    cur.phase = "between";
    $("#ovStatus").textContent = "Duel Mix";
    const mx = cur.mix, opp = cur.opps[0];
    const n = mx.rounds.length;
    const rows = cur.games.map((g, i) => {
      const r = mx.rounds[i];
      return '<tr class="' + (i === n ? "next" : "") + '"><td class="dg-mono">' + (i + 1) + "</td><td>" + esc(g.name) + '</td><td class="num">' + (r ? esc(g.fmtScore(r.my)) : "–") + '</td><td class="num">' + (r ? esc(g.fmtScore(r.op)) : "–") + '</td><td class="num">' + (r ? r.pm + "–" + r.po : "") + "</td></tr>";
    }).join("");
    const done = n >= 3;
    stage('<div class="mix" data-test="mix"><p class="dg-eyebrow">Duel Mix · 3 challenges · one opponent</p>' +
      '<div class="vs-sides"><div class="vs-team"><div class="vs-p me"><b>You</b><span class="dg-mono">' + P.fmt(cur.me.rating) + '</span></div></div><div class="vs-x dg-mono">' + mx.pts[0] + "–" + mx.pts[1] + '</div><div class="vs-team"><div class="vs-p rival"><b>' + esc(opp.name) + '</b><span class="dg-mono">' + P.fmt(opp.rating) + "</span></div></div></div>" +
      '<div class="dg-scroll-x"><table class="dg-table mix-table" data-test="mix-table"><thead><tr><th>Round</th><th>Game</th><th class="num">You</th><th class="num">' + esc(opp.name) + '</th><th class="num">Pts</th></tr></thead><tbody>' + rows +
      '</tbody><tfoot><tr class="tot"><td></td><td>Total</td><td></td><td></td><td class="num dg-mono" id="mixTotal">' + mx.pts[0] + "–" + mx.pts[1] + "</td></tr></tfoot></table></div>" +
      (cur.mixFilled ? '<p class="dg-note">Your filter has fewer than 3 Duel Mix games, so ' + (cur.mixFilled === 1 ? "one round comes" : cur.mixFilled + " rounds come") + " from other categories.</p>" : "") +
      '<p class="dg-note">Round win 3 pts · draw 1 pt. ' + (cur.stake > 0 ? "One stake of " + P.fmt(cur.stake) + " · winner receives " + P.fmt(E.winPay(cur.stake)) + "." : "Free play.") + "</p>" +
      (done ? "" : '<div id="rulesSlot"></div>') + "</div>");
    if (!done) {
      const g = cur.games[n];
      const seed = n === 0 && cur.seed ? cur.seed : newSeed();
      if (n > 0) cur.seed = seed;
      playRound(cur, { game: g, mode: "mix", seed, slot: "#rulesSlot", opps: cur.opps, label: "Round " + (n + 1) + " of 3" }, (out) => mixRound(cur, out));
    }
  }
  function mixRound(cur, out) {
    const g = cur.round.spec.game, opp = cur.opps[0];
    const my = Number(out.res.score), op = out.bots.rivals[0].score;
    const o = my > op ? "win" : my < op ? "loss" : "draw";
    const pm = o === "win" ? 3 : o === "draw" ? 1 : 0, po = o === "loss" ? 3 : o === "draw" ? 1 : 0;
    const dr = E.elo(P.rating(g.id), opp.rating, sc(o));
    cur.mix.rounds.push({ gid: g.id, my, op, o, pm, po, dr, detail: out.res.detail, seed: cur.round.spec.seed });
    cur.mix.pts[0] += pm; cur.mix.pts[1] += po;
    applyGame(g.id, o, dr, my); P.commit();
    cur.phase = "between";
    if (cur.mix.rounds.length >= 3) return mixFinish(cur, false);
    mixTable(cur, false);
  }
  function mixForfeit(cur) { mixFinish(cur, true); }
  function mixFinish(cur, forfeit) {
    if (M.cur !== cur || cur.phase === "result") return;
    const mx = cur.mix, opp = cur.opps[0];
    let outcome;
    if (forfeit) outcome = "loss";
    else outcome = mx.pts[0] > mx.pts[1] ? "win" : mx.pts[0] < mx.pts[1] ? "loss" : "draw";
    if (forfeit) {
      /* the forfeited round counts as a lost round for that game's rating */
      const g = cur.games[mx.rounds.length];
      if (g) { const dr = E.elo(P.rating(g.id), opp.rating, 0); applyGame(g.id, "loss", dr, null); mx.rounds.push({ gid: g.id, my: null, op: null, o: "loss", pm: 0, po: 3, dr, ff: true, seed: cur.round && cur.round.spec.game === g ? cur.round.spec.seed : null }); mx.pts[1] += 3; }
    }
    if (outcome === "win") { P.unlock("mix-master"); P.S.flags.mixWins++; }
    const payout = outcome === "win" ? E.winPay(cur.stake) : outcome === "draw" ? cur.stake : 0;
    const table = '<div class="dg-scroll-x"><table class="dg-table mix-table" data-test="mix-table"><thead><tr><th>Round</th><th>Game</th><th class="num">You</th><th class="num">' + esc(opp.name) + '</th><th class="num">Pts</th></tr></thead><tbody>' +
      mx.rounds.map((r, i) => { const g = P.game(r.gid) || cur.games[i]; return "<tr><td class=\"dg-mono\">" + (i + 1) + "</td><td>" + esc(g.name) + '</td><td class="num">' + (r.ff ? "FF" : esc(g.fmtScore(r.my))) + '</td><td class="num">' + (r.ff ? "–" : esc(g.fmtScore(r.op))) + '</td><td class="num">' + r.pm + "–" + r.po + "</td></tr>"; }).join("") +
      '</tbody><tfoot><tr class="tot"><td></td><td>Total</td><td></td><td></td><td class="num dg-mono" id="mixTotal">' + mx.pts[0] + "–" + mx.pts[1] + "</td></tr></tfoot></table></div>";
    /* ratings for the rounds were applied per game already; record the mix overall */
    cur.phase = "result";
    const S = P.S, stake = cur.stake;
    S.gold += payout; cur.escrow = 0; unpersist();
    const net = payout - stake;
    const dp = E.dpFor(outcome, stake);
    P.addDp(dp); P.recordDuel(outcome, net);
    if (outcome === "win" && stake >= 1000) P.unlock("high-roller");
    if (outcome === "win" && opp.rating >= 1600) P.unlock("giant-slayer");
    P.checkPolymath();
    const drTotal = mx.rounds.reduce((a, r) => a + r.dr, 0);
    P.addHistory({ g: "mix", gn: "Duel Mix", games: mx.rounds.map((r) => r.gid), seeds: mx.rounds.map((r) => r.seed), f: "mix", stake, o: outcome, s: mx.pts[0] + "–" + mx.pts[1] + " pts", net, dr: drTotal, vs: opp.name, seed: mx.rounds[0] ? mx.rounds[0].seed : cur.seed });
    P.commit();
    M.last = { phase: "result", outcome, payout, net, dr: drTotal, dp, stake, pts: mx.pts.slice() };
    resultScreen(cur, { outcome, payout, net, dp, drTotal, lines: table });
  }

  /* ---------------- Tournament (8-player single elimination) ---------------- */
  const RNAMES = ["Quarter-final", "Semi-final", "Final"];
  function initTour(cur) {
    const t = cur.setup.tour || {};
    const players = [Object.assign({ me: true }, cur.me)].concat(cur.opps);
    cur.T = { players, round: 0, alive: true, results: [[], [], []], added: t.added || 0, name: t.name || cur.games[0].name + " Cup", prizes: E.tourPrizes(cur.stake, t.added || 0), stage: 0, ties: 0 };
  }
  /* participants of round r, as pairs of player indexes */
  function pairs(T, r) {
    if (r === 0) return [[0, 1], [2, 3], [4, 5], [6, 7]];
    const prev = T.results[r - 1];
    const out = [];
    for (let i = 0; i < prev.length; i += 2) out.push([prev[i].w, prev[i + 1].w]);
    return out;
  }
  /* one simulated bracket match; a generator so each bot run gets its own task */
  function* simMatchGen(cur, a, b, seed, out) {
    const T = cur.T, g = cur.games[0], pa = T.players[a], pb = T.players[b];
    if (g.kind === "race") {
      let sa = null, sb = null;
      try { sa = runBot(g, seed, pa, "full").score; } catch (e) { sa = null; }
      if (sa != null) { yield; try { sb = runBot(g, seed, pb, "full").score; } catch (e) { sa = null; } }
      if (sa != null) {
        const w = sa > sb ? a : sb > sa ? b : pa.rating >= pb.rating ? a : b;
        return Object.assign(out, { a, b, w, sa, sb });
      }
    }
    const p = E.expect(pa.rating, pb.rating);
    const w = U.rng(seed + ":" + a + ":" + b)() < p ? a : b;
    return Object.assign(out, { a, b, w, sa: w === a ? 1 : 0, sb: w === b ? 1 : 0, sim2: true });
  }
  function bracketHTML(cur) {
    const T = cur.T, g = cur.games[0];
    let html = '<div class="bracket" data-test="bracket">';
    for (let r = 0; r < 3; r++) {
      html += '<div class="br-col"><p class="dg-eyebrow">' + RNAMES[r] + "</p>";
      const count = [4, 2, 1][r];
      for (let i = 0; i < count; i++) {
        const res = T.results[r][i];
        let pa = null, pb = null;
        if (r === 0 || (T.results[r - 1].length === count * 2)) { const pr = pairs(T, r)[i]; pa = pr[0]; pb = pr[1]; }
        const line = (ix, s) => {
          if (ix == null) return '<div class="br-p tbd"><span>TBD</span></div>';
          const p = T.players[ix];
          const cls = (p.me ? "me" : "") + (res ? (res.w === ix ? " w" : " l") : "");
          const shown = !res ? "" : g.kind === "race" && !res.sim2 && s != null ? esc(g.fmtScore(s)) : res.w === ix ? "W" : "";
          return '<div class="br-p ' + cls + '"><span>' + esc(p.name) + '</span><b class="dg-mono">' + shown + "</b></div>";
        };
        html += '<div class="br-m">' + line(pa, res && res.sa) + line(pb, res && res.sb) + "</div>";
      }
      html += "</div>";
    }
    return html + "</div>";
  }
  function showBracket(cur) {
    const T = cur.T;
    cur.phase = "between";
    $("#ovStatus").textContent = "Bracket";
    const p = T.prizes;
    const myPair = T.alive && T.round < 3 ? pairs(T, T.round).findIndex((pr) => pr.includes(0)) : -1;
    const note = cur.note; cur.note = "";
    stage('<div class="tour" data-test="tournament">' + (note ? '<p class="tour-note" data-test="tour-note" role="status">' + esc(note) + "</p>" : "") + '<p class="dg-eyebrow">' + esc(T.name) + " · " + esc(cur.games[0].name) + " · 8 players</p>" +
      '<p class="tour-prizes dg-mono">Pool ' + P.fmt(p.pool) + " · 1st " + P.fmt(p.champion) + " · 2nd " + P.fmt(p.runnerUp) + " · semis " + P.fmt(p.semi) + "</p>" +
      bracketHTML(cur) + (T.alive && T.round < 3 ? '<div id="rulesSlot"></div>' : "") + "</div>");
    if (T.alive && T.round < 3 && myPair >= 0) {
      const pr = pairs(T, T.round)[myPair];
      const oppIx = pr[0] === 0 ? pr[1] : pr[0];
      const opp = T.players[oppIx];
      setBar([[cur.me, "me"]], [[opp, "rival"]], esc(T.name) + " · " + RNAMES[T.round]);
      const seed = (cur.seed = newSeed());
      playRound(cur, { game: cur.games[0], mode: "full", seed, slot: "#rulesSlot", opps: [opp], label: RNAMES[T.round] + (T.ties ? " · replay after a tie" : "") + " vs " + opp.name }, (out) => tourMyResult(cur, out, oppIx, seed));
    }
  }
  function tourMyResult(cur, out, oppIx, seed) {
    if (M.cur !== cur || cur.phase === "result") return;
    const T = cur.T, g = cur.games[0];
    const r = T.round;
    const pr = pairs(T, r);
    const mi = pr.findIndex((x) => x.includes(0));
    if (oppIx == null) oppIx = pr[mi][0] === 0 ? pr[mi][1] : pr[mi][0];
    const opp = T.players[oppIx];
    let o, my = null, op = null;
    if (out.forfeit) o = "loss";
    else if (g.kind === "race") { my = Number(out.res.score); op = out.bots.rivals[0].score; o = my > op ? "win" : my < op ? "loss" : "draw"; }
    else { o = out.res.outcome; }
    if (o === "draw") {
      T.ties++;
      if (T.ties < 3) { cur.note = "Tie — the match is replayed with a new seed."; return showBracket(cur); }
      o = U.rng(seed + ":tb")() < 0.5 ? "win" : "loss"; // after 3 ties a seeded coin decides
    }
    T.ties = 0;
    const dr = unrated(cur, g.id) ? 0 : E.elo(P.rating(g.id), opp.rating, sc(o));
    applyGame(g.id, o, dr, my);
    T.drTotal = (T.drTotal || 0) + dr;
    T.dpTotal = (T.dpTotal || 0) + E.dpFor(o, 0);
    P.addDp(E.dpFor(o, 0));
    if (o === "win" && opp.rating >= 1600) P.unlock("giant-slayer");
    if (r < 2 || o === "loss") P.recordDuel(o, 0); // the final is recorded with the net below
    const mine = { a: pr[mi][0], b: pr[mi][1], w: o === "win" ? 0 : oppIx, sa: null, sb: null, sim2: g.kind !== "race" || !!out.forfeit };
    if (g.kind === "race" && !out.forfeit) { mine.sa = pr[mi][0] === 0 ? my : op; mine.sb = pr[mi][0] === 0 ? op : my; }
    /* the rest of the bracket is simulated one match per task (see runSim) */
    const base = seed || newSeed();
    const lost = o === "loss";
    function* sim() {
      T.results[r] = pr.map((x, i) => (i === mi ? mine : null));
      for (let i = 0; i < pr.length; i++) { if (i === mi) continue; yield; T.results[r][i] = yield* simMatchGen(cur, pr[i][0], pr[i][1], base + i * 7919, {}); }
      if (lost) {
        for (let rr = r + 1; rr < 3; rr++) {
          const ps = pairs(T, rr); T.results[rr] = [];
          for (let i = 0; i < ps.length; i++) { yield; T.results[rr][i] = yield* simMatchGen(cur, ps[i][0], ps[i][1], base + rr * 104729 + i, {}); }
        }
      }
    }
    const after = () => {
      P.commit();
      if (lost) { T.alive = false; T.stage = r; T.round = 3; return tourFinish(cur); } // stage 0 QF exit, 1 SF exit, 2 runner-up
      T.round++;
      if (T.round >= 3) { T.stage = 3; return tourFinish(cur); }
      if (cur.closing) return tourMyResult(cur, { forfeit: true }); // leaving mid-tournament forfeits the next round
      if (M.cur !== cur) return;
      cur.note = RNAMES[r] + " won. Next: " + RNAMES[T.round] + ".";
      showBracket(cur);
    };
    cur.phase = "sim";
    $("#ovStatus").textContent = "Bracket";
    setButtons({});
    runSim(cur, sim(), after);
  }
  /* drive a simulation generator in ~8 ms slices, yielding between them; closeOverlay can drain it synchronously */
  function runSim(cur, it, after) {
    if (cur.closing) { while (!it.next().done) { /* closing: finish now */ } cur.sim = null; after(); return; }
    cur.sim = { it, after };
    const step = () => {
      if (M.cur !== cur || !cur.sim || cur.sim.it !== it) return;
      const t0 = performance.now();
      let done = false;
      while (performance.now() - t0 < 8) { if (it.next().done) { done = true; break; } }
      if (done) { cur.sim = null; after(); } else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  }
  function drainSim(cur) {
    if (!cur.sim) return;
    const { it, after } = cur.sim; cur.sim = null;
    while (!it.next().done) { /* finish synchronously */ }
    after();
  }
  function tourFinish(cur) {
    if (cur.phase === "result") return;
    const T = cur.T, p = T.prizes, g = cur.games[0];
    cur.phase = "result";
    const stageIx = T.stage; // 0 QF, 1 SF, 2 runner-up, 3 champion
    const prize = cur.stake > 0 || T.added ? [0, p.semi, p.runnerUp, p.champion][stageIx] : 0;
    const tp = [10, 25, 50, 100][stageIx];
    const titles = ["Out in the quarter-final", "Semi-finalist", "Runner-up", "Champion"];
    const outcome = stageIx === 3 ? "win" : "loss";
    const S = P.S;
    S.gold += prize; cur.escrow = 0; unpersist();
    S.tp += tp;
    const net = prize - cur.stake;
    if (stageIx === 3) { P.unlock("champion"); S.flags.tourWins++; P.recordDuel("win", net); if (cur.stake >= 1000) P.unlock("high-roller"); }
    else { P.ensureToday(); S.today.net += net; } // the lost match was already recorded
    const key = cur.setup.tour ? cur.setup.tour.id : "quick:" + g.id;
    const prev = S.tours[key] || {};
    S.tours[key] = Object.assign({}, prev, { best: Math.max(prev.best == null ? -1 : prev.best, stageIx) });
    P.checkPolymath();
    P.addHistory({ g: g.id, gn: g.name, f: "tournament", stake: cur.stake, o: outcome, s: titles[stageIx], net, dr: T.drTotal || 0, vs: T.name, seed: cur.seed });
    P.commit();
    M.last = { phase: "result", outcome, payout: prize, net, dr: T.drTotal || 0, dp: T.dpTotal || 0, stage: stageIx, tp, stake: cur.stake };
    if (M.cur !== cur) return; // settled while closing: no screen to show
    const champ = T.players[T.results[2][0].w];
    resultScreen(cur, {
      outcome, payout: prize, net, dp: T.dpTotal || 0, drTotal: T.drTotal || 0, title: titles[stageIx],
      lines: '<p class="res-sub">Champion: <b class="' + (champ.me ? "dg-gold" : "dg-rival") + '">' + esc(champ.name) + "</b> · +" + tp + " tournament points</p>" + bracketHTML(cur),
    });
  }

  /* ---------------- Watch: spectate or simulated live race ---------------- */
  M.watch = function (w) {
    if (M.cur) return "Finish your current match first.";
    const g = P.game(w.game);
    if (!g) return "That game is not available.";
    const cur = (M.cur = { tok: ++token, setup: {}, format: "watch", stake: 0, escrow: 0, games: [g], timers: new Set(), phase: "watch", closed: false });
    openOverlay();
    const pl = w.players.map(personOf);
    setTimeout(() => { if (M.cur === cur && !cur.closed) { const b = $("#ovLeave"); try { b.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, 0);
    setBar([[pl[0], "me watch"]], [[pl[1], "rival"]], "Watching · " + esc(g.name) + (w.pot ? " · pot " + P.fmt(w.pot) : ""));
    setButtons({ leave: true });
    const seed = w.seed || newSeed();
    if (g.hasSpectate) {
      const s = stage('<div class="game-root spect" id="gameRoot" data-test="spectate"></div>');
      const root = s.querySelector("#gameRoot");
      let h = null;
      const onErr = (e) => { if (M.cur !== cur || cur.phase !== "watch") return; if (h) try { h.abort(); } catch (x) { /* ignore */ } watchError(cur, e); };
      try {
        h = DG.createContext({ root, seed, mode: "full", format: "1v1", speed: M.speed, me: pl[0], opponents: [pl[1]],
          onStatus: (t) => { $("#ovStatus").textContent = String(t).slice(0, 80); },
          onEnd: (r) => watchEnd(cur, g, pl, r && Array.isArray(r.scores) ? r.scores : null, r ? r.winner : null),
          onError: (e) => Promise.resolve().then(() => onErr(e)) });
        h.ctx.players = pl;
        cur.handle = h;
        g.raw.spectate(h.ctx);
      } catch (e) { onErr(e); }
      return "";
    }
    if (g.kind !== "race") { watchError(cur, new Error("No spectator view for this game.")); return ""; }
    let runs;
    try { runs = pl.map((p) => runBot(g, seed, p, "full")); } catch (e) { watchError(cur, e); return ""; }
    stage('<div class="watch-race" data-test="watch-race"><p class="dg-eyebrow">Live race · seed #' + seed + '</p><div class="race big" id="wRace">' +
      pl.map((p, i) => '<div class="race-row ' + (i ? "rival" : "me watch") + '" data-k="' + i + '"><span class="race-name">' + esc(p.name) + '</span><span class="race-bar"><i></i></span><b class="dg-mono race-val">0</b></div>').join("") +
      '</div><p class="dg-note">Both players face the same seeded challenge. Scores update as they play.</p></div>');
    const end = Math.max(...runs.map((r) => r.timeline[r.timeline.length - 1][0]));
    const t0 = performance.now();
    const upd = () => {
      const t = ((performance.now() - t0) / 1000) * M.speed * 1.5;
      const vals = runs.map((r) => atTime(r.timeline, t));
      const top = Math.max(1, ...runs.map((r) => Math.abs(r.score))) * 1.1;
      vals.forEach((v, i) => { const el = document.querySelector('#wRace [data-k="' + i + '"]'); if (!el) return; el.querySelector("i").style.width = Math.max(0, Math.min(100, (v / top) * 100)) + "%"; el.querySelector(".race-val").textContent = g.fmtScore(Math.round(v * 100) / 100); });
      $("#ovStatus").textContent = Math.min(end, t).toFixed(0) + " s";
      if (t >= end) { clearTimers(cur); const s = runs.map((r) => r.score); watchEnd(cur, g, pl, s, s[0] > s[1] ? 0 : s[1] > s[0] ? 1 : -1); }
    };
    every(cur, upd, 100);
    return "";
  };
  function watchEnd(cur, g, pl, scores, winner) {
    if (M.cur !== cur || cur.phase !== "watch") return;
    cur.phase = "result";
    clearTimers(cur);
    const w = winner === 0 || winner === 1 ? winner : -1;
    const box = document.createElement("div");
    box.className = "watch-end dg-box";
    box.setAttribute("data-test", "watch-result");
    box.innerHTML = '<p class="dg-eyebrow">Final</p><h2 class="dg-h">' + (w < 0 ? "Draw" : esc(pl[w].name) + " wins") + "</h2>" +
      (scores && scores.length >= 2 ? '<p class="dg-mono">' + esc(g.fmtScore(scores[0])) + " – " + esc(g.fmtScore(scores[1])) + "</p>" : "") +
      '<div class="res-actions"><button class="dg-btn primary" id="watchBack" data-test="back">Back to Watch</button></div>';
    $("#ovStage").appendChild(box);
    $("#watchBack").onclick = closeOverlay;
    $("#ovStatus").textContent = "Final";
    if (!P.topModal()) try { $("#watchBack").focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    M.last = { phase: "watch-result", winner: w, scores };
    try { box.scrollIntoView({ block: "nearest" }); } catch (e) { /* ignore */ }
  }
  function watchError(cur, e) {
    console.error("[Duel.gold] spectate error", e);
    cur.phase = "error"; clearTimers(cur);
    stage('<div class="result err" data-test="error"><h2 class="dg-h">Broadcast unavailable</h2><p>' + esc(cur.games[0].name) + " could not be shown.</p><p class=\"dg-note\">" + esc(String((e && e.message) || e).slice(0, 200)) + '</p><div class="res-actions"><button class="dg-btn primary" id="resBack" data-test="back">Back</button></div></div>');
    $("#resBack").onclick = closeOverlay;
    M.last = { phase: "error" };
  }

  /* ---------------- recovery: a match left unfinished by a reload ----------------
     matchmaking → refund; anything later (staked or free) → forfeit: loss, stake lost, rating and history updated */
  M.recover = function () {
    const a = P.S.active;
    if (!a) return null;
    P.S.active = null;
    if (a.phase === "mm") {
      P.S.gold += a.escrow;
      if (a.tour && a.tour.once) { const t = P.S.tours[a.tour.id]; if (t && t.entered === a.tour.once) delete t.entered; }
      P.commit();
      return { kind: "refund", amount: a.escrow };
    }
    const gid = a.format === "mix" ? null : a.game;
    let dr = 0;
    if (gid) { dr = a.unrated ? 0 : E.elo(P.rating(gid), a.opp, 0); applyGame(gid, "loss", dr, null); }
    P.addDp(E.dpFor("loss", a.stake));
    P.recordDuel("loss", -a.stake);
    P.addHistory({ g: a.format === "mix" ? "mix" : a.game, gn: a.gn, f: a.format, stake: a.stake, o: "loss", s: "forfeit (left)", net: -a.stake, dr, vs: a.vs });
    P.commit();
    M.last = { phase: "recovered", outcome: "loss", net: -a.stake, dr };
    return { kind: "forfeit", stake: a.stake, gn: a.gn };
  };

  /* overlay buttons */
  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("#ovForfeit, #ovLeave");
    if (!t) return;
    if (t.id === "ovForfeit") M.forfeit(true);
    else closeOverlay();
  });
})();
