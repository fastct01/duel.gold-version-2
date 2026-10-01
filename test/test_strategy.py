"""Pack A (strategy) tests: chess, four, reversi, gomoku.

Run: python3 test/test_strategy.py        (about 6-10 minutes; prints a summary and exits non-zero on failure)
"""
import json, pathlib, random, sys, time, traceback

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from dglib import browser_page, open_harness, wait_result, errors  # noqa: E402

SHOTS = pathlib.Path(__file__).resolve().parent / "shots"
SHOTS.mkdir(exist_ok=True)
FILES = ["strategy.js"]
GAMES = ["chess", "four", "reversi", "gomoku"]
REGISTERED = ["chess", "chess-custom", "four", "reversi", "gomoku"]  # chess-custom = Chess with its own setup (tested in test_chess_setup)
FAILS = []
REPORT = {}


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("  FAIL:", msg)
    return cond


def section(name):
    print("\n==", name)


def T(page, js):
    return page.evaluate("(() => { const t = window.__handle.ctx.test; return " + js + "; })()")


def wait_human_or_end(page, timeout=30):
    page.wait_for_function(
        "window.__result !== null || (window.__handle && window.__handle.ctx.test && window.__handle.ctx.test.legalMoves().length > 0)",
        timeout=timeout * 1000)
    return page.evaluate("window.__result")


def assert_versus_result(r, where):
    ok = check(isinstance(r, dict) and r.get("outcome") in ("win", "loss", "draw"), f"{where}: bad outcome {r}")
    if ok:
        check(isinstance(r.get("myScore"), (int, float)) and isinstance(r.get("oppScore"), (int, float)), f"{where}: scores not numbers {r}")
        o, a, b = r["outcome"], r["myScore"], r["oppScore"]
        check((o == "win" and a > b) or (o == "loss" and a < b) or (o == "draw" and a == b), f"{where}: outcome/score mismatch {r}")


def assert_no_errors(page, where):
    e = errors(page)
    check(not e, f"{where}: errors {e}")


# ---------------------------------------------------------------- UI play
def click_chess_move(page, m):
    page.click(f"[data-test=sq-{m['from']}]")
    page.click(f"[data-test=sq-{m['to']}]")
    if "promotion" in m:
        page.click("[data-test=promo-q]")


def drag_chess_move(page, m):
    a = page.locator(f"[data-test=sq-{m['from']}]").bounding_box()
    b = page.locator(f"[data-test=sq-{m['to']}]").bounding_box()
    page.mouse.move(a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
    page.mouse.down()
    for k in range(1, 6):
        page.mouse.move(a["x"] + a["width"] / 2 + (b["x"] - a["x"]) * k / 5, a["y"] + a["height"] / 2 + (b["y"] - a["y"]) * k / 5)
    page.mouse.up()


def play_chess_ui(page, width):
    page.evaluate("__run({game:'chess', seed:11, skill:0.2, speed:4})")
    rnd = random.Random(width)
    # one move by drag
    wait_human_or_end(page)
    moves = T(page, "t.legalMoves()")
    before = len(T(page, "t.state().sans"))
    m = next((x for x in moves if x["piece"] == "n"), moves[0])
    drag_chess_move(page, m)
    page.wait_for_timeout(100)
    check(len(T(page, "t.state().sans")) == before + 1, f"chess@{width}: drag move not applied")
    # a few moves by tap
    for i in range(6):
        if wait_human_or_end(page):
            break
        moves = T(page, "t.legalMoves()")
        before = len(T(page, "t.state().sans"))
        click_chess_move(page, rnd.choice(moves))
        page.wait_for_timeout(60)
        check(len(T(page, "t.state().sans")) == before + 1, f"chess@{width}: tap move {i} not applied")
        if i == 3:
            page.screenshot(path=str(SHOTS / f"chess-{width}.png"), full_page=True)
    # finish with the engine playing the human side
    T(page, "t.autoplay(0.9)")
    r = wait_result(page, 240)
    assert_versus_result(r, f"chess@{width}")
    st = T(page, "t.state()")
    print(f"  chess@{width}: {r['outcome']} {r['myScore']}-{r['oppScore']} in {len(st['sans'])} plies ({st['result']['sub']})")
    page.screenshot(path=str(SHOTS / f"chess-{width}-end.png"), full_page=True)


def play_turn_ui(page, game, width, sel):
    page.evaluate(f"__run({{game:'{game}', seed:{width + 3}, skill:0.3, speed:8}})")
    rnd = random.Random(width)
    n = 0
    shot = False
    while True:
        if wait_human_or_end(page, 40):
            break
        moves = T(page, "t.legalMoves()")
        if game == "gomoku":  # keep random stones near the action
            st = T(page, "t.state()")
            occ = [i for i, v in enumerate(st["cells"]) if v]
            near = [m for m in moves if any(abs(m % 15 - o % 15) <= 2 and abs(m // 15 - o // 15) <= 2 for o in occ)] or moves
            moves = near
        before = T(page, "JSON.stringify(t.state().cells)")
        page.click(sel(rnd.choice(moves)))
        page.wait_for_timeout(40)
        after = T(page, "JSON.stringify(t.state().cells)")
        check(before != after or page.evaluate("__result") is not None, f"{game}@{width}: click did not place")
        n += 1
        if n == 3 and not shot:
            page.screenshot(path=str(SHOTS / f"{game}-{width}.png"), full_page=True)
            shot = True
        if n > 250:
            check(False, f"{game}@{width}: game did not end")
            break
    r = wait_result(page, 10)
    if not shot:
        page.screenshot(path=str(SHOTS / f"{game}-{width}.png"), full_page=True)
    assert_versus_result(r, f"{game}@{width}")
    print(f"  {game}@{width}: {r['outcome']} {r['myScore']}-{r['oppScore']} after {n} clicked moves")
    page.screenshot(path=str(SHOTS / f"{game}-{width}-end.png"), full_page=True)


SEL = {
    "four": lambda m: f"[data-test=col-{m}]",
    "reversi": lambda m: f"[data-test=sq-{m}]",
    "gomoku": lambda m: f"[data-test=pt-{m}]",
}


def test_ui_play():
    for width in (400, 1280):
        section(f"UI play to completion @ {width}px")
        with browser_page(width=width) as page:
            open_harness(page, FILES)
            games = page.evaluate("__games()")
            check([g["id"] for g in games] == REGISTERED, f"registered games {[g['id'] for g in games]}")
            for g in games:
                check(g["kind"] == "versus" and g["formats"] == ["1v1", "tournament"] and g["category"] == "strategy"
                      and g["hasSpectate"] and g["cashEligible"] and g["pack"] == "strategy", f"meta {g}")
            for game in GAMES:
                try:
                    if game == "chess":
                        play_chess_ui(page, width)
                    else:
                        play_turn_ui(page, game, width, SEL[game])
                except Exception as e:  # keep going, record failure
                    check(False, f"{game}@{width}: exception {e}")
                    traceback.print_exc()
                assert_no_errors(page, f"{game}@{width}")


# ---------------------------------------------------------------- chess special rules through the UI
def chess_fen_case(page, name, fens, clicks, promo=None, expect=None):
    page.evaluate("__run({game:'chess', seed:5, skill:0.3, speed:2})")
    wait_human_or_end(page)
    T(page, "t.freezeClocks()")
    human = T(page, "t.state().human")
    check(T(page, f"t.loadFen({json.dumps(fens[human])})"), f"{name}: loadFen failed")
    page.wait_for_timeout(50)
    for sq in clicks[human]:
        page.click(f"[data-test=sq-{sq}]")
    if promo:
        check(page.locator("[data-test=promo]").is_visible(), f"{name}: promotion picker not shown")
        page.click(f"[data-test=promo-{promo}]")
    page.wait_for_timeout(50)
    st = T(page, "t.state()")
    ok = expect(st, human)
    check(ok, f"{name}: unexpected state {st['fen']} sans={st['sans']}")
    print(f"  {name} ({'White' if human == 'w' else 'Black'}): {st['sans']} -> {'ok' if ok else 'BAD'}")
    return st


def test_chess_rules_ui():
    section("chess special moves through the UI (castling, en passant, under-promotion, flag)")
    with browser_page(width=400) as page:
        open_harness(page, FILES)
        # castling king side
        chess_fen_case(page, "castling",
                       {"w": "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1", "b": "r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R b KQkq - 0 1"},
                       {"w": ["e1", "g1"], "b": ["e8", "g8"]},
                       expect=lambda st, h: st["sans"][:1] == ["O-O"])
        page.evaluate("__handle.abort()")
        # en passant
        chess_fen_case(page, "en passant",
                       {"w": "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1", "b": "4k3/8/8/8/3Pp3/8/8/4K3 b - d3 0 1"},
                       {"w": ["e5", "d6"], "b": ["e4", "d3"]},
                       expect=lambda st, h: st["sans"][:1] == (["exd6"] if h == "w" else ["exd3"]))
        page.evaluate("__handle.abort()")
        # under-promotion to a knight -> K+N vs K = insufficient material -> draw
        chess_fen_case(page, "promotion",
                       {"w": "8/P7/8/8/8/8/k7/4K3 w - - 0 1", "b": "4k3/8/8/8/8/8/p6K/8 b - - 0 1"},
                       {"w": ["a7", "a8"], "b": ["a2", "a1"]}, promo="n",
                       expect=lambda st, h: st["sans"][:1] == (["a8=N"] if h == "w" else ["a1=N"]))
        r = wait_result(page, 10)
        check(r["outcome"] == "draw" and r["myScore"] == 0.5, f"promotion->insufficient material should draw: {r}")
        # checkmate by the human through the UI (back-rank mate)
        chess_fen_case(page, "checkmate",
                       {"w": "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1", "b": "r5k1/5ppp/8/8/8/8/5PPP/6K1 b - - 0 1"},
                       {"w": ["a1", "a8"], "b": ["a8", "a1"]},
                       expect=lambda st, h: st["sans"][:1] in (["Ra8#"], ["Ra1#"]))
        r = wait_result(page, 10)
        check(r["outcome"] == "win" and r["myScore"] == 1, f"checkmate should win: {r}")
        # flag: the human runs out of time with the rival holding mating material -> loss
        page.evaluate("__run({game:'chess', seed:5, skill:0.3, speed:4})")
        wait_human_or_end(page)
        human = T(page, "t.state().human")
        T(page, f"t.setClock('{human}', 400)")
        r = wait_result(page, 10)
        check(r["outcome"] == "loss", f"flag should lose: {r}")
        print("  flag:", r["outcome"], T(page, "t.state().result.sub"))
        # flag with the rival unable to mate -> draw
        page.evaluate("__run({game:'chess', seed:5, skill:0.3, speed:4})")
        wait_human_or_end(page)
        human = T(page, "t.state().human")
        fen = "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1" if human == "w" else "4k3/4p3/8/8/8/8/8/4K3 b - - 0 1"
        T(page, f"t.loadFen('{fen}')")
        T(page, f"t.setClock('{human}', 300)")
        r = wait_result(page, 10)
        check(r["outcome"] == "draw", f"flag vs lone king should draw: {r}")
        print("  flag vs bare king:", r["outcome"], T(page, "t.state().result.sub"))
        assert_no_errors(page, "chess rules ui")


# ---------------------------------------------------------------- engine / rules termination
def test_engines(page):
    section("AI vs AI through the rules code (termination)")
    res = page.evaluate("""(() => {
      const E = DG.getGame('chess')._engine, out = [];
      for (let s = 1; s <= 20; s++) {
        const r = E.simulate({ white: 0.05 + (s % 4) * 0.08, black: 0.05 + ((s + 1) % 4) * 0.08, seed: s, maxPlies: 1200 });
        out.push(r);
      }
      return out; })()""")
    flags = {}
    reasons = {}
    for r in res:
        check("error" not in r, f"chess sim error {r}")
        check(r.get("reason") != "ply cap", f"chess sim did not terminate {r}")
        for k, v in r.get("flags", {}).items():
            flags[k] = flags.get(k, 0) + v
        reasons[r.get("reason")] = reasons.get(r.get("reason"), 0) + 1
    print(f"  chess 20 low-skill games: reasons {reasons}; move flags {flags} (k/q castle, e en passant, p promotion)")
    check(flags.get("p", 0) > 0 and (flags.get("k", 0) + flags.get("q", 0)) > 0, "chess sims never promoted or castled")
    REPORT["chess_sim"] = reasons
    perft = page.evaluate("""(() => { const E = DG.getGame('chess')._engine; return [
      E.perft('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 4),
      E.perft('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', 3),
      E.perft('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', 4),
      E.perft('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', 3)]; })()""")
    check(perft == [197281, 97862, 43238, 62379], f"engine perft mismatch {perft}")
    print("  engine perft (start d4, kiwipete d3, pos3 d4, pos5 d3):", perft)
    for game in ["four", "reversi", "gomoku"]:
        res = page.evaluate(f"""(() => {{ const E = DG.getGame('{game}')._engine, out = [];
          for (let s = 1; s <= 20; s++) out.push(E.sim(s, 0.05 + (s % 5) * 0.1, 0.05 + ((s + 2) % 5) * 0.1));
          return out; }})()""")
        w = [0, 0, 0]
        for r in res:
            check("error" not in r, f"{game} sim error {r}")
            w[r.get("winner", 0) + 1] += 1
        print(f"  {game} 20 games: draws {w[0]}, gold wins {w[1]}, red wins {w[2]}; max {max(r.get('moves', 0) for r in res)} moves")


def test_strength_and_speed(page):
    section("AI think time at max skill (0.98) and strength 0.9 vs 0.5")
    t = page.evaluate("""(() => {
      const C = DG.getGame('chess')._engine, out = {};
      const fens = ['rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R2QK2R w KQ - 0 8',
        'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
        '2r2rk1/pp3ppp/2n1b3/3q4/3P4/2PB1N2/P4PPP/R2Q1RK1 b - - 0 15'];
      let mx = 0, depths = [];
      for (const f of fens) { const r = C.think(f, { skill: 0.98, budget: 30 + 0.98 * 110 }); mx = Math.max(mx, r.ms); depths.push(r.depth); }
      out.chess = { maxMs: mx, depths };
      for (const g of ['four', 'reversi', 'gomoku']) {
        const E = DG.getGame(g)._engine; let m = 0;
        for (let s = 1; s <= 3; s++) m = Math.max(m, E.sim(100 + s, 0.98, 0.98).maxMs);
        out[g] = { maxMs: m };
      }
      return out; })()""")
    for g, v in t.items():
        print(f"  {g}: max think {v['maxMs']:.0f} ms" + (f", depths {v['depths']}" if "depths" in v else ""))
        check(v["maxMs"] < 175, f"{g} AI move too slow at max skill: {v}")
    REPORT["think"] = t
    # strength: skill 0.9 plays the 'human' side against the rival at 0.5, colours alternate
    rates = {}
    for game in GAMES:
        wins = draws = 0
        for s in range(10):
            if game == "chess":
                r = page.evaluate(f"""DG.getGame('chess')._engine.simulate({{ white: {0.9 if s % 2 == 0 else 0.5}, black: {0.5 if s % 2 == 0 else 0.9}, seed: {300 + s}, maxPlies: 600 }})""")
                strong = "w" if s % 2 == 0 else "b"
                wins += r["winner"] == strong
                draws += r["winner"] == "draw"
            else:
                r = page.evaluate(f"DG.getGame('{game}')._engine.sim({300 + s}, 0.9, 0.5)")
                wins += r["winner"] == 0
                draws += r["winner"] == -1
        rates[game] = (wins, draws, 10 - wins - draws)
        print(f"  {game}: skill 0.9 vs 0.5 over 10 games -> W{wins} D{draws} L{10 - wins - draws}")
        check(wins >= 6, f"{game}: 0.9 should beat 0.5 most of the time ({rates[game]})")
    REPORT["strength"] = rates


# ---------------------------------------------------------------- abort, timers, touch, 360px, spectate
def test_abort(page):
    section("abort mid-game")
    for game in GAMES:
        page.evaluate(f"__run({{game:'{game}', seed:21, skill:0.5, speed:4}})")
        wait_human_or_end(page)
        m = T(page, "t.legalMoves()")[0]
        T(page, f"t.playMove({json.dumps(m)})")
        page.wait_for_timeout(150)  # rival is now thinking (timer pending)
        page.evaluate("__handle.abort()")
        status = page.evaluate("__status")
        html = page.evaluate("document.getElementById('root').innerHTML")
        page.wait_for_timeout(2500)
        check(page.evaluate("__result") is None, f"{game}: ctx.end called after abort")
        check(page.evaluate("__status") == status, f"{game}: status kept updating after abort")
        check(page.evaluate("document.getElementById('root').innerHTML") == html, f"{game}: DOM changed after abort")
        # clicking after abort must do nothing
        T(page, f"t.playMove({json.dumps(m)})")
        assert_no_errors(page, f"{game} abort")
        print(f"  {game}: abort ok")
    # abort while the autoplay engine plays the human side and during the end banner delay
    page.evaluate("__run({game:'four', seed:3, skill:0.05, speed:10})")
    T(page, "t.autoplay(0.98)")
    page.wait_for_function("window.__handle.ctx.test.state().over === true", timeout=30000)
    page.evaluate("__handle.abort()")
    page.wait_for_timeout(1500)
    check(page.evaluate("__result") is None, "four: end fired after abort during end banner")
    assert_no_errors(page, "abort during banner")


def test_move_timer(page):
    section("per-move timers")
    for game, ms in (("four", 15000), ("reversi", 20000), ("gomoku", 20000)):
        page.evaluate(f"__run({{game:'{game}', seed:9, skill:0.5, speed:20}})")
        wait_human_or_end(page)
        before = T(page, "t.state().moves")
        page.wait_for_timeout(ms / 20 + 700)
        after = T(page, "t.state().moves")
        note = page.inner_text("[data-test=note]")
        check(after > before and "Time ran out" in note, f"{game}: timeout did not auto-play ({before}->{after}, note {note!r})")
        print(f"  {game}: timeout auto-played a move ({before} -> {after})")
        page.evaluate("__handle.abort()")
    assert_no_errors(page, "move timers")


def test_gomoku_touch():
    section("gomoku touch confirm (tap twice)")
    with browser_page(width=360, height=740, touch=True) as page:
        open_harness(page, FILES)
        page.evaluate("__run({game:'gomoku', seed:4, skill:0.5, speed:4})")
        wait_human_or_end(page)
        st = T(page, "t.state()")
        occ = [i for i, v in enumerate(st["cells"]) if v]
        target = next(i for i in range(225) if not st["cells"][i] and (not occ or any(abs(i % 15 - o % 15) <= 1 and abs(i // 15 - o // 15) <= 1 for o in occ)))
        box = page.locator(f"[data-test=pt-{target}]").bounding_box()
        print(f"  point hit area at 360px: {box['width']:.1f} x {box['height']:.1f}px")
        check(abs(box["width"] - box["height"]) < 0.6 and box["width"] >= 22, f"gomoku: hit area not square or too small {box}")
        sizes = page.evaluate("""[...document.querySelectorAll('.g-gomoku-pt')].map(b => { const r = b.getBoundingClientRect(); return [r.width, r.height]; })""")
        check(all(abs(w - h) < 0.6 and w >= 22 for w, h in sizes), "gomoku: some points are not square / >= 22px")
        page.tap(f"[data-test=pt-{target}]")
        page.wait_for_timeout(80)
        check(T(page, f"t.state().cells[{target}]") == 0, "gomoku: first tap placed a stone on touch")
        check(page.locator(f"[data-test=pt-{target}] .g-gomoku-st.ghost").count() == 1, "gomoku: no preview after first tap")
        page.tap(f"[data-test=pt-{target}]")
        page.wait_for_timeout(80)
        check(T(page, f"t.state().cells[{target}]") == 1, "gomoku: second tap did not place")
        print("  first tap previews, second tap places: ok")
        assert_no_errors(page, "gomoku touch")


def test_narrow():
    section("360 px: no horizontal scroll")
    with browser_page(width=360, height=740) as page:
        open_harness(page, FILES)
        for game in GAMES:
            page.evaluate(f"__run({{game:'{game}', seed:2, skill:0.5, speed:4}})")
            wait_human_or_end(page)
            sw, iw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
            check(sw <= iw, f"{game}: horizontal scroll at 360px ({sw} > {iw})")
            print(f"  {game}: scrollWidth {sw} <= {iw}")
            page.evaluate("__handle.abort()")
        # chess: empty move list stays on one line
        page.evaluate("__run({game:'chess', seed:1, skill:0.5, speed:1})")
        page.wait_for_timeout(200)
        if T(page, "t.state().sans.length") == 0:
            h = page.evaluate("(() => { const e = document.querySelector('.g-chess-empty'); const lh = parseFloat(getComputedStyle(e).lineHeight); return [e.getBoundingClientRect().height, lh]; })()")
            check(h[0] <= h[1] * 1.3, f"chess: 'No moves yet' wraps at 360px (height {h[0]} vs line {h[1]})")
            print(f"  chess 'No moves yet': {h[0]:.0f}px tall (one line = {h[1]:.0f}px)")
        page.evaluate("__handle.abort()")
        # arrow / space / page keys never scroll the page while a board is shown
        for game in GAMES:
            page.evaluate(f"__run({{game:'{game}', seed:2, skill:0.5, speed:1}})")
            page.wait_for_timeout(150)
            page.evaluate("document.body.style.minHeight = '3000px'; window.scrollTo(0, 200)")
            y0 = page.evaluate("window.scrollY")
            targets = [None]
            first_btn = {"four": "[data-test=col-0]", "reversi": "[data-test=sq-0]", "gomoku": "[data-test=pt-0]"}.get(game)
            if first_btn:
                targets.append(first_btn)
            for tgt in targets:
                if tgt:
                    page.evaluate(f"document.querySelector('{tgt}').focus({{preventScroll:true}})")
                else:
                    page.evaluate("document.activeElement && document.activeElement.blur()")
                for k in ["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "PageDown"] + ([] if tgt else ["Space"]):
                    page.keyboard.press(k)
                    page.wait_for_timeout(30)
                y1 = page.evaluate("window.scrollY")
                check(y1 == y0, f"{game}: keys scrolled the page ({y0} -> {y1}, focus {tgt})")
            print(f"  {game}: arrow/space/page keys do not scroll")
            page.evaluate("__handle.abort(); document.body.style.minHeight = ''; window.scrollTo(0, 0)")
        page.evaluate("__spectate({game:'chess', speed:4})")
        page.wait_for_timeout(500)
        sw, iw = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
        check(sw <= iw, f"chess spectate: horizontal scroll at 360px ({sw} > {iw})")
        page.screenshot(path=str(SHOTS / "chess-360.png"), full_page=True)
        page.evaluate("__handle.abort()")
        assert_no_errors(page, "narrow")


def test_spectate(page):
    section("spectate to completion at speed 10")
    for game in GAMES:
        t0 = time.time()
        page.evaluate(f"__spectate({{game:'{game}', seed:17, speed:10}})")
        page.wait_for_timeout(1500)
        if game == "chess":
            page.screenshot(path=str(SHOTS / "chess-spectate-1280.png"), full_page=True)
        r = wait_result(page, 180)
        ok = check(isinstance(r, dict) and r.get("winner") in (0, 1, -1) and isinstance(r.get("scores"), list) and len(r["scores"]) == 2,
                   f"{game} spectate result {r}")
        if ok:
            print(f"  {game}: winner {r['winner']} scores {r['scores']} in {time.time() - t0:.1f}s")
        assert_no_errors(page, f"{game} spectate")


def test_chess_setup(page):
    section("Chess (your settings): time control, colour and rating options reach the game")
    def run(seed, opts=None, speed=1):
        o = "" if opts is None else ", options:" + json.dumps(opts)
        page.evaluate(f"__run({{game:'chess-custom', seed:{seed}, skill:0.3, speed:{speed}{o}}})")
        page.wait_for_timeout(120)
        return T(page, "t.state()")
    base = {"custom": False, "more": False, "rated": True, "range": 100}
    s = run(5)
    c = s["clocks"]
    check(max(c.values()) == 600000 and min(c.values()) > 595000, f"default is 10 min, no increment ({c})")
    s = run(5, dict(base, base=60, inc=1, color="black", rated=False))
    check(s["human"] == "b" and max(s["clocks"].values()) <= 60000 and min(s["clocks"].values()) > 55000, f"1 | 1 as Black: human b, 1:00 clocks ({s['human']}, {s['clocks']})")
    note = page.inner_text("[data-test=note]")
    check("1 | 1 Bullet" in note and "Unrated" in note, f"game note shows the time control: {note!r}")
    wait_human_or_end(page)
    cb = T(page, "t.state().clocks.b")
    m = T(page, "t.legalMoves()")[0]
    T(page, f"t.playMove({json.dumps(m)})")
    cb2 = T(page, "t.state().clocks.b")
    check(cb2 - cb > 800, f"increment added after the move ({cb:.0f} -> {cb2:.0f})")
    whites = [run(sd, dict(base, base=180, inc=2, color="white"))["human"] for sd in range(1, 7)]
    check(set(whites) == {"w"}, f"'White' always plays White ({whites})")
    rand = [run(sd, dict(base, base=180, inc=2, color="random"))["human"] for sd in range(1, 13)]
    check(set(rand) == {"w", "b"}, f"'Random' gives both colours over seeds ({rand})")
    s = run(5, {"base": 7, "inc": 99, "color": "purple", "rated": "x", "range": 3})
    check(max(s["clocks"].values()) == 600000, f"invalid options fall back to the defaults ({s['clocks']})")
    r = page.evaluate("""(() => { const g = DG.getGame('chess-custom'), S = g.setup, L = g._setup;
      const v = Object.assign(S.defaults(), { base: 180, inc: 2 });
      return { sum: S.summary(v), unr: S.summary(Object.assign({}, v, { rated: false, color: 'black' })), any: S.ratingRange(Object.assign({}, v, { range: 0 })),
        r100: S.ratingRange(Object.assign({}, v, { range: 100 })), bad: S.validate({ base: 7, inc: 0, color: 'random', rated: true, range: 100 }), ok: S.validate(v),
        cls: [L.tcClass(120, 1), L.tcClass(60, 3), L.tcClass(300, 7), L.tcClass(300, 8), L.tcClass(600, 0)] }; })()""")
    check(r["sum"] == "3 | 2 Blitz" and r["unr"] == "3 | 2 Blitz · Unrated · as Black", f"summaries {r['sum']!r} / {r['unr']!r}")
    check(r["any"] == 800 and r["r100"] == 100, f"rating range: Any = ±800, ±100 = 100 ({r['any']}, {r['r100']})")
    check(r["bad"] != "" and r["ok"] == "", f"validate rejects a non-offered clock ({r['bad']!r})")
    check(r["cls"] == ["bullet", "blitz", "blitz", "rapid", "rapid"], f"Bullet < 3 min ≤ Blitz < 10 min ≤ Rapid (base + 40 × inc): {r['cls']}")
    run(9, dict(base, base=60, inc=0, color="white"), speed=6)
    T(page, "t.autoplay(0.9)")
    page.wait_for_function("window.__result !== null", timeout=120000)
    res = page.evaluate("window.__result")
    check(res.get("outcome") in ("win", "loss", "draw") and "1 min Bullet" in (res.get("detail") or ""), f"1 min game plays to a result ({res.get('outcome')}): {res.get('detail')!r}")
    check(not page.evaluate("__errors"), f"no errors {page.evaluate('__errors')}")


def test_no_chess_lib():
    section("chess without chess.js")
    with browser_page(width=400) as page:
        open_harness(page, FILES)
        page.evaluate("window.Chess = undefined")
        page.evaluate("__run({game:'chess', seed:1})")
        page.wait_for_timeout(300)
        check(page.locator("[data-test=chess-error]").is_visible(), "chess: missing-library message not shown")
        page.evaluate("__handle.abort()")
        page.evaluate("__spectate({game:'chess', speed:10})")
        r = wait_result(page, 5)
        check(r == {"winner": -1, "scores": [0, 0]}, f"chess spectate without lib: {r}")
        assert_no_errors(page, "no chess lib")
        print("  message shown, no crash")


def main():
    t0 = time.time()
    test_ui_play()
    test_chess_rules_ui()
    with browser_page(width=1280) as page:
        open_harness(page, FILES)
        test_engines(page)
        test_abort(page)
        test_move_timer(page)
        test_spectate(page)
        test_chess_setup(page)
        test_strength_and_speed(page)
    test_gomoku_touch()
    test_narrow()
    test_no_chess_lib()
    print(f"\nfinished in {time.time() - t0:.0f}s")
    if FAILS:
        print(f"{len(FAILS)} FAILURES:")
        for f in FAILS:
            print(" -", f)
        sys.exit(1)
    print("ALL PASSED")


if __name__ == "__main__":
    main()
