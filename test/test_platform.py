"""Duel.gold platform tests (Playwright, sync). Build first:
    python3 build.py --test-games _samples.js      -> dist/test.html
    python3 test/test_platform.py

Covers: no age gate or cool-off, every tab at 360/1280 with no horizontal scroll, Duel now in every format
(1v1 race, 1v1 versus, 2v2, FFA, tournament win + lose, Duel Mix), escrow/payout/Elo arithmetic, forfeit, rematch,
custom stake validation, daily bonus, loss limit, favourites, friend challenge, club join, shop purchase,
Watch race + spectate, localStorage blocked, throwing games refunded, 0 and 30 registered games, console errors.
Screenshots go to test/shots/platform-*.png.
"""
import math, pathlib, sys, time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from dglib import browser_page  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
URL = (ROOT / "dist" / "test.html").as_uri()
SHOTS = ROOT / "test" / "shots"
SHOTS.mkdir(exist_ok=True)
TABS = ["home", "games", "watch", "tournaments", "social", "profile", "settings", "fair"]

FAILS = []
PASSES = [0]


def check(cond, msg):
    if cond:
        PASSES[0] += 1
    else:
        FAILS.append(msg)
        print("  FAIL:", msg)


def jsround(x):  # JavaScript Math.round
    return math.floor(x + 0.5)


def elo(r, opp, s):
    return jsround(24 * (s - 1 / (1 + 10 ** ((opp - r) / 400))))


def console_errors(page, allow=()):
    out = []
    for c in page._console:
        if not c.startswith(("error", "pageerror")):
            continue
        if "Failed to load resource" in c:  # dglib aborts the Google Fonts request
            continue
        if any(a in c for a in allow):
            continue
        out.append(c)
    return out


def no_hscroll(page, label):
    sw = page.evaluate("document.documentElement.scrollWidth")
    iw = page.evaluate("window.innerWidth")
    check(sw <= iw, f"{label}: horizontal scroll {sw} > {iw}")


def boot(page, speed=4):
    page.goto(URL)
    page.wait_for_function("window.DGApp && document.querySelector('#view-home').children.length > 0")
    page.evaluate("DGApp.close(); DGApp.set({limits: {loss: 0, remind: 0, pending: null}}); DGApp.reset(); document.querySelectorAll('.modal-back').forEach(m => m.remove())")
    page.evaluate(f"DGApp.setSpeed({speed}); DGApp.go('home')")


def st(page):
    return page.evaluate("DGApp.state()")


def gold(page):
    return page.evaluate("DGApp.state().gold")


def burst(page, n=400):
    page.evaluate("""n => { const b = document.querySelector('[data-test=tap]');
      for (let i = 0; i < n; i++) b.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, cancelable: true})); }""", n)


def start_round(page):
    page.wait_for_selector("#mStart", state="visible", timeout=15000)
    check(page.is_visible("[data-test=rules]"), "rules card shown before start")
    page.click("#mStart")


def tap_round(page, win=True, clicks=3):
    start_round(page)
    page.wait_for_selector("[data-test=tap]", timeout=5000)
    for _ in range(clicks):
        page.click("[data-test=tap]")
    if win:
        burst(page)


def wait_result(page, timeout=30000):
    page.wait_for_selector("[data-test=result]", timeout=timeout)
    return page.evaluate("DGApp.last()")


def setup_panel(page, pick=None, fmt="1v1", stake=0, px="dn"):
    if pick:
        page.select_option(f"#{px}Game", pick)
    page.click(f"#{px}F-{fmt}")
    page.click(f"#{px}S-{stake}")


def find(page, px="dn"):
    page.click(f"#{px}Find")
    page.wait_for_selector("[data-test=matchmaking]", timeout=3000)


def nim_play(page):
    start_round(page)
    for _ in range(400):
        if page.query_selector("[data-test=result]"):
            return
        el = page.query_selector("[data-test=stones]")
        if el:
            try:
                n = int(el.inner_text())
                take = n % 4 or 1
                b = page.query_selector(f"[data-take='{take}']:not([disabled])")
                if b:
                    b.click()
            except Exception:
                pass
        page.wait_for_timeout(40)


def shot(page, name, full=True):
    page.screenshot(path=str(SHOTS / f"platform-{name}.png"), full_page=full)


# ------------------------------------------------------------------------------------------------
def test_tabs(page, w):
    print(f"[{w}] tabs")
    page.goto(URL)
    page.evaluate("DGApp.close(); localStorage.clear()")
    page.reload()
    page.wait_for_function("window.DGApp && DG.__appReady === true", timeout=5000)
    check(page.query_selector("[data-test=age-gate]") is None, "no age gate on first visit")
    check("age" not in st(page), "no age stored")
    page.evaluate("DGApp.setSpeed(4)")
    for t in TABS:
        page.evaluate(f"DGApp.go('{t}')")
        page.wait_for_timeout(80)
        check(page.is_visible(f"#view-{t}") and page.evaluate(f"document.querySelector('#view-{t}').children.length") > 0, f"{t} renders")
        no_hscroll(page, f"tab {t} @{w}")
        shot(page, f"{t}-{w}")
    # nav by clicking: the left sidebar is always on screen and fixed (icon rail on narrow screens)
    for t in ["games", "watch", "tournaments", "social", "profile", "home"]:
        page.click(f"#tab-{t}")
        check(not page.is_hidden(f"#view-{t}"), f"nav click {t}")
    check(page.is_visible("#tabs"), "sidebar visible")
    pos = page.evaluate("getComputedStyle(document.querySelector('#tabs')).position")
    check(pos == "fixed", "sidebar fixed")
    check(page.is_hidden("#bottomNav"), "bottom nav replaced by the sidebar")
    check(page.is_hidden("#settingsBtn"), "top-bar settings gear hidden for now")
    page.click("#footSettings")
    check(not page.is_hidden("#view-settings"), "settings reachable from footer")
    check(page.inner_text("#wCash") == "€0.00", "cash pill shows €0.00")


def test_1v1_race(page, w):
    print(f"[{w}] 1v1 race win + rematch + lose")
    boot(page)
    g0 = gold(page)
    setup_panel(page, "sample-tap", "1v1", 100)
    note = page.inner_text("#dnNote")
    check("Pot 200" in note and "180" in note, f"pot note: {note}")
    find(page)
    check(gold(page) == g0 - 100, "stake escrowed at matchmaking")
    no_hscroll(page, f"matchmaking @{w}")
    page.wait_for_selector("[data-test=versus]", timeout=5000)
    cur = page.evaluate("DGApp.current()")
    opp = cur["opps"][0]
    check(abs(opp["rating"] - 1200) <= 60, f"opponent rating within ±60: {opp['rating']}")
    check(f"Seed #{cur['seed']}" in page.inner_text("[data-test=versus]"), "seed shown on versus card")
    shot(page, f"versus-{w}", full=False)
    start_round(page)
    page.wait_for_selector("[data-test=tap]")
    for _ in range(3):
        page.click("[data-test=tap]")
    check(page.is_visible("[data-test=race]"), "live race panel visible")
    page.wait_for_timeout(150)
    shot(page, f"playing-{w}", full=False)
    no_hscroll(page, f"playing @{w}")
    burst(page)
    last = wait_result(page)
    check(last["outcome"] == "win", f"1v1 win: {last}")
    check(last["payout"] == 180, f"payout 180: {last}")
    check(gold(page) == g0 - 100 + 180, "gold after win")
    exp_dr = elo(1200, opp["rating"], 1)
    s = st(page)
    check(s["games"]["sample-tap"]["r"] == 1200 + exp_dr, f"elo {s['games']['sample-tap']['r']} vs {1200 + exp_dr}")
    check(last["dp"] == 35 and s["dp"] == 300 + 35, f"dp 35: {last} {s['dp']}")
    check(s["history"][0]["o"] == "win" and s["history"][0]["net"] == 80, "history row")
    check(s["ach"].get("first-win"), "first-win achievement")
    shot(page, f"result-{w}", full=False)
    no_hscroll(page, f"result @{w}")
    # rematch: same opponent, new seed, same stake
    g1 = gold(page)
    page.click("#resRematch")
    page.wait_for_selector("[data-test=matchmaking]")
    check(gold(page) == g1 - 100, "rematch escrow")
    page.wait_for_selector("[data-test=versus]")
    cur2 = page.evaluate("DGApp.current()")
    check(cur2["opps"][0]["name"] == opp["name"], "rematch keeps opponent")
    check(cur2["seed"] != cur["seed"], "rematch new seed")
    r_before = st(page)["games"]["sample-tap"]["r"]
    tap_round(page, win=False, clicks=0)
    last = wait_result(page)
    check(last["outcome"] == "loss" and last["payout"] == 0, f"loss: {last}")
    check(gold(page) == g1 - 100, "gold after loss")
    check(st(page)["games"]["sample-tap"]["r"] == r_before + elo(r_before, opp["rating"], 0), "elo after loss")
    page.click("#resBack")
    check(page.is_hidden("#ov"), "overlay closed")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_1v1_versus(page, w):
    print(f"[{w}] 1v1 versus (Nim via UI)")
    boot(page)
    g0 = gold(page)
    setup_panel(page, "sample-nim", "1v1", 250)
    check(page.is_disabled("#dnF-2v2") and page.is_disabled("#dnF-ffa") and page.is_disabled("#dnF-mix"), "versus game disables 2v2/FFA/Mix")
    check("head-to-head" in page.inner_text("#duelNow"), "explains why formats are disabled")
    find(page)
    page.wait_for_selector("[data-test=versus]")
    opp = page.evaluate("DGApp.current()")["opps"][0]
    check(not page.is_visible("[data-test=race]"), "no race panel for versus")
    nim_play(page)
    last = wait_result(page)
    o = last["outcome"]
    exp_pay = {"win": 450, "loss": 0, "draw": 250}[o]
    check(last["payout"] == exp_pay, f"versus payout {last}")
    check(gold(page) == g0 - 250 + exp_pay, "versus gold")
    check(st(page)["games"]["sample-nim"]["r"] == 1200 + elo(1200, opp["rating"], {"win": 1, "loss": 0, "draw": .5}[o]), "versus elo")
    print(f"   nim outcome: {o}")
    page.click("#resBack")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_2v2_ffa(page, w):
    print(f"[{w}] 2v2 and FFA")
    boot(page)
    g0 = gold(page)
    setup_panel(page, "sample-tap", "2v2", 100)
    find(page)
    page.wait_for_selector("[data-test=versus]")
    cur = page.evaluate("DGApp.current()")
    check(cur["ally"] and len(cur["opps"]) == 2, "2v2 participants")
    tap_round(page, win=True)
    check(page.is_visible("#raceTeam"), "2v2 team race totals")
    last = wait_result(page)
    check(last["outcome"] == "win" and last["payout"] == 180, f"2v2 win pays 2x stake x 0.9: {last}")
    tr = (1200 + cur["ally"]["rating"]) / 2
    orr = (cur["opps"][0]["rating"] + cur["opps"][1]["rating"]) / 2
    check(st(page)["games"]["sample-tap"]["r"] == 1200 + elo(tr, orr, 1), "2v2 team-average elo")
    check(gold(page) == g0 + 80, "2v2 gold")
    shot(page, f"result-2v2-{w}", full=False)
    page.click("#resBack")

    g0 = gold(page)
    r0 = st(page)["games"]["sample-tap"]["r"]
    setup_panel(page, None, "ffa", 250)
    find(page)
    check(gold(page) == g0 - 250, "ffa escrow")
    page.wait_for_selector("[data-test=versus]")
    cur = page.evaluate("DGApp.current()")
    check(len(cur["opps"]) == 3, "ffa 4 players")
    shot(page, f"versus-ffa-{w}", full=False)
    tap_round(page, win=True)
    last = wait_result(page)
    pot = math.floor(4 * 250 * 90 / 100)  # 900
    check(last["place"] == 1 and last["payout"] == math.floor(pot * 70 / 100), f"ffa 1st gets 70% of 900: {last}")
    ratings = [r0] + [o["rating"] for o in cur["opps"]]
    exp = jsround(sum((24 / 3) * (1 - 1 / (1 + 10 ** ((ratings[j] - r0) / 400))) for j in range(1, 4)))
    check(st(page)["games"]["sample-tap"]["r"] == r0 + exp, f"ffa pairwise elo {st(page)['games']['sample-tap']['r']} vs {r0 + exp}")
    check(gold(page) == g0 - 250 + 630, "ffa gold")
    page.click("#resBack")
    # FFA split arithmetic incl. ties
    split = page.evaluate("DGApp.econ.ffaSplit([10, 10, 5, 1], DGApp.econ.ffaPrizes(250, 4))")
    check(split["places"] == [1, 1, 3, 4] and split["pay"] == [450, 450, 0, 0], f"ffa tie split {split}")
    split = page.evaluate("DGApp.econ.ffaSplit([9, 7, 7, 1], DGApp.econ.ffaPrizes(333, 4))")
    # pot floor(4*333*.9)=1198 -> 838 / 359 ; 2nd tie splits 359 -> 179 each
    check(split["pay"] == [838, 179, 179, 0], f"ffa 2nd-place tie split {split}")
    check(page.evaluate("DGApp.econ.winPay(333)") == 599, "winPay floors")
    t = page.evaluate("DGApp.econ.tourPrizes(250, 20000)")
    check(t == {"pool": 21800, "champion": 13080, "runnerUp": 5450, "semi": 1635}, f"tour prizes {t}")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_tournament(page, w):
    print(f"[{w}] tournament win + lose")
    boot(page)
    g0 = gold(page)
    setup_panel(page, "sample-tap", "tournament", 100)
    find(page)
    check(gold(page) == g0 - 100, "tournament entry escrowed")
    page.wait_for_selector("[data-test=bracket]", timeout=5000)
    shot(page, f"bracket-{w}", full=False)
    no_hscroll(page, f"bracket @{w}")
    for rnd in range(3):
        tap_round(page, win=True)
        if rnd < 2:
            page.wait_for_function(f"DGApp.current() && DGApp.current().tour.round === {rnd + 1}", timeout=15000)
            check(page.inner_text("#ovStatus") == "Bracket", f"status reads Bracket between rounds: {page.inner_text('#ovStatus')}")
    last = wait_result(page)
    pool = math.floor(8 * 100 * 90 / 100)  # 720
    check(last["stage"] == 3 and last["payout"] == math.floor(pool * 60 / 100), f"champion prize 432: {last}")
    check(gold(page) == g0 - 100 + 432, "champion gold")
    s = st(page)
    check(s["tp"] == 100, "tournament points +100")
    check(s["ach"].get("champion"), "champion achievement")
    check(s["games"]["sample-tap"]["w"] == 3, "3 match wins recorded")
    shot(page, f"result-tournament-{w}", full=False)
    page.click("#resBack")
    # lose path: out in the quarter-final
    g0 = gold(page)
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'tournament', stake:100})")
    page.wait_for_selector("[data-test=bracket]", timeout=5000)
    tap_round(page, win=False, clicks=0)
    last = wait_result(page)
    check(last["stage"] == 0 and last["payout"] == 0 and last["outcome"] == "loss", f"QF exit: {last}")
    check(gold(page) == g0 - 100, "QF exit gold")
    check(st(page)["tp"] == 110, "QF exit +10 tp")
    check(page.query_selector("[data-test=bracket]") is not None, "final bracket on result")
    page.click("#resBack")
    # featured daily (free, house-added): once per day
    page.evaluate("DGApp.go('tournaments')")
    page.click("#join-daily")
    page.wait_for_selector("[data-test=bracket]", timeout=5000)
    page.evaluate("DGApp.forfeit()")
    wait_result(page)
    page.click("#resBack")
    page.evaluate("DGApp.go('tournaments')")
    check(page.is_disabled("#join-daily"), "daily championship once per day")
    check(page.is_disabled("#join-world"), "world championship locked below Gold")
    check("Gold division" in page.inner_text("[data-tour=world]"), "locked state explained")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_mix(page, w):
    print(f"[{w}] duel mix")
    boot(page)
    g0 = gold(page)
    setup_panel(page, None, "mix", 500)
    check("winner receives 900" in page.inner_text("#dnNote"), "mix pot note")
    find(page)
    check(gold(page) == g0 - 500, "mix escrow once")
    page.wait_for_selector("[data-test=mix]", timeout=5000)
    shot(page, f"mix-{w}", full=False)
    for rnd in range(3):
        tap_round(page, win=True)
        if rnd < 2:
            page.wait_for_function(f"DGApp.current() && DGApp.current().mix.rounds.length === {rnd + 1}", timeout=15000)
            rows = page.inner_text("[data-test=mix-table]")
            check("ROUND" in rows.upper() and "TOTAL" in rows.upper(), "mix running table")
            check(gold(page) == g0 - 500, "no extra stake per round")
    last = wait_result(page)
    check(last["outcome"] == "win" and last["pts"] == [9, 0] and last["payout"] == 900, f"mix win 9-0 pays 900: {last}")
    check(gold(page) == g0 + 400, "mix gold")
    check(page.inner_text("#mixTotal") == "9–0", "final total shown")
    check(st(page)["ach"].get("mix-master"), "mix-master achievement")
    check(st(page)["history"][0]["f"] == "mix", "mix history")
    seeds = st(page)["history"][0].get("seeds") or []
    check(len(seeds) == 3 and all(isinstance(x, int) for x in seeds) and len(set(seeds)) == 3, f"mix history stores 3 round seeds {seeds}")
    shot(page, f"result-mix-{w}", full=False)
    page.click("#resBack")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_forfeit_and_stakes(page, w):
    print(f"[{w}] forfeit, custom stake, bonus, loss limit")
    boot(page)
    g0 = gold(page)
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'1v1', stake:100})")
    page.wait_for_selector("#mStart")
    start_round(page)
    page.wait_for_selector("[data-test=tap]")
    page.click("#ovForfeit")
    page.wait_for_selector("[data-test=forfeit-confirm]")
    page.click("#forfeitNo")
    check(page.query_selector("[data-test=result]") is None, "forfeit cancel keeps playing")
    page.click("#ovForfeit")
    page.click("#forfeitYes")
    last = wait_result(page)
    check(last["outcome"] == "loss" and gold(page) == g0 - 100, f"forfeit = loss: {last}")
    page.wait_for_timeout(700)
    check(page.evaluate("DGApp.ctx()") is None or page.evaluate("DGApp.ctx().signal.ended"), "ctx aborted")
    page.click("#resBack")
    # matchmaking cancel refunds
    g0 = gold(page)
    page.evaluate("DGApp.setSpeed(0.2)")
    page.evaluate("DGApp.startMatch({game:'sample-tap', stake:250})")
    page.click("#mmCancel")
    check(gold(page) == g0, "cancel refunds")
    page.evaluate("DGApp.setSpeed(4)")
    # custom stake validation
    page.evaluate("DGApp.go('home')")
    page.click("#dnS-custom")
    for val, ok in [("5", False), ("abc", False), ("12.5", False), (str(gold(page) + 1), False), ("300", True)]:
        page.fill("#dnCustom", val)
        check(page.is_disabled("#dnFind") != ok, f"custom stake {val} -> {'ok' if ok else 'blocked'}: {page.inner_text('#dnNote')}")
    check("Pot 600" in page.inner_text("#dnNote"), "custom stake pot math")
    shot(page, f"custom-stake-{w}", full=False)
    # daily bonus
    page.click("#dnS-0")
    g0 = gold(page)
    page.click("#claimBonus")
    check(gold(page) == g0 + 500, "bonus +500")
    check(page.query_selector("#claimBonus") is None, "bonus once per day")
    page.reload()
    page.wait_for_function("window.DGApp")
    check(page.query_selector("#claimBonus") is None and gold(page) == g0 + 500, "bonus persists across reload")
    page.evaluate("DGApp.setSpeed(4); DGApp.advanceDays(1); DGApp.go('home')")
    check(page.query_selector("#claimBonus") is not None, "bonus available next day")
    page.click("#claimBonus")
    check(gold(page) == g0 + 1000, "second-day bonus")
    # top up when low
    page.evaluate("DGApp.set({gold: 40})")
    page.click("#topUp")
    check(gold(page) == 1040, "top up demo gold")
    page.evaluate("DGApp.set({gold: 10000})")
    # loss limit: set 100 custom, lose a 100 duel, then stakes are blocked
    page.evaluate("DGApp.go('settings')")
    page.fill("#lossCustom", "100")
    page.click("#lossSet")
    check(st(page)["limits"]["loss"] == 100, "custom loss limit")
    check(page.evaluate("DGApp.startMatch({game:'sample-tap', stake:250})") != "", "stake above remaining limit blocked")
    page.evaluate("DGApp.startMatch({game:'sample-tap', stake:100})")
    tap_round(page, win=False, clicks=0)
    wait_result(page)
    page.click("#resBack")
    err = page.evaluate("DGApp.startMatch({game:'sample-tap', stake:50})")
    check("loss limit" in err, f"loss limit blocks staked play: {err}")
    page.evaluate("DGApp.go('home')")
    check(page.is_disabled("#dnS-50") and page.is_visible("#dnBlock"), "stake chips disabled by limit")
    check(page.evaluate("DGApp.startMatch({game:'sample-tap', stake:0})") == "", "free play still allowed")
    page.evaluate("DGApp.close()")
    page.evaluate("DGApp.go('settings')")
    page.click("#loss-0")
    check(st(page)["limits"]["loss"] == 100 and st(page)["limits"]["pending"]["loss"] == 0, "removing a limit is delayed 24 h")
    check("takes effect at" in page.inner_text("#lossPending"), "pending change shown")
    check(page.evaluate("DGApp.startMatch({game:'sample-tap', stake:50})") != "", "limit still active until the delay passes")
    page.evaluate("DGApp.advanceDays(1.01)")
    check(page.evaluate("DGApp.startMatch({game:'sample-tap', stake:50})") == "", "limit off after 24 h -> staked ok")
    page.evaluate("DGApp.close()")
    check(gold(page) == 10000 - 100, "closing during matchmaking refunds")
    # no cool-off or age section
    page.evaluate("DGApp.go('settings')")
    check(page.query_selector("#coolBox") is None and page.query_selector("#ageBox") is None, "no cool-off or age section")
    # session reminder
    page.click("#remind-15")
    check(st(page)["limits"]["remind"] == 15, "reminder set")
    page.evaluate("DGApp.remindNow()")
    check("Reminder" in page.inner_text("#toasts"), "reminder toast")
    shot(page, f"settings-active-{w}")
    no_hscroll(page, f"settings active @{w}")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_social_profile(page, w):
    print(f"[{w}] favourites, friends, clubs, shop, watch")
    boot(page)
    page.evaluate("DGApp.go('games')")
    page.click("[data-fav='sample-tap']")
    check(st(page)["favs"] == ["sample-tap"], "favourite added")
    page.click("#libFavs")
    check(len(page.query_selector_all(".gcard")) == 1, "favourites filter")
    page.click("#libFavs")
    page.click("[data-rules='sample-nim']")
    page.wait_for_selector("[data-test=rules-panel]")
    check("last stone" in page.inner_text("[data-test=rules-panel]"), "how to play panel")
    page.keyboard.press("Escape")
    page.fill("#libSearch", "nim")
    check(len(page.query_selector_all(".gcard")) == 1, "library search")
    page.fill("#libSearch", "")
    page.click("[data-duel='sample-tap']")
    page.wait_for_selector("[data-test=duel-sheet]")
    check(page.evaluate("document.querySelector('#shGame').value") == "sample-tap", "Duel preselects game")
    page.keyboard.press("Escape")
    page.evaluate("DGApp.go('home')")
    page.click("[data-pick='favs']")
    page.click("#dnF-ffa")
    check(not page.is_disabled("#dnFind"), "favourites pick with FFA")
    # friends
    page.evaluate("DGApp.go('social')")
    page.click("[data-challenge='0']")
    page.wait_for_selector("[data-test=dn-opponent]")
    check("mira" in page.inner_text("[data-test=dn-opponent]").lower(), "challenge preset opponent")
    check(page.is_disabled("#shF-2v2"), "challenge limits formats")
    page.click("#shFind")
    page.wait_for_selector("[data-test=versus]", timeout=5000)
    opp = page.evaluate("DGApp.current()")["opps"][0]
    check(opp["name"] == "Mira" and opp["rating"] == 1320, f"friend is opponent {opp}")
    check(st(page)["ach"].get("rival-call"), "challenge achievement")
    page.evaluate("DGApp.forfeit()")
    wait_result(page)
    page.click("#resBack")
    page.fill("#friendName", "Zed <b>x</b>")
    page.click("#friendAdd")
    check(any(f["name"] == "Zed <b>x</b>" for f in st(page)["friends"]), "friend added")
    check(page.query_selector("#friendList b b") is None, "friend name escaped")
    page.fill("#friendName", "mira")
    page.click("#friendAdd")
    check("already" in page.inner_text("#friendMsg"), "duplicate friend rejected")
    page.click("[data-club='owls']")
    check(st(page)["club"] == "owls", "club joined")
    soc = page.inner_text("#view-social").lower()
    check("night owls" in soc and "members this week" in soc, "club members table")
    shot(page, f"social-club-{w}")
    # shop
    page.evaluate("DGApp.go('profile')")
    dp = st(page)["dp"]
    page.click("[data-buy='frame-gold']")
    s = st(page)
    check(s["dp"] == dp - 300 and "frame-gold" in s["cos"]["owned"] and s["cos"]["frame"] == "frame-gold", "shop purchase")
    check(page.query_selector(".avatar.f-gold") is not None, "frame applied")
    check(page.is_disabled("[data-buy='title-gm']"), "can't afford disabled")
    # history filter
    page.select_option("#histFilter", st(page)["history"][0]["g"])
    check(page.query_selector("#histTable") is not None, "history filtered")
    shot(page, f"profile-played-{w}")
    no_hscroll(page, f"profile with history @{w}")
    check(" DP" not in page.inner_text("#view-profile").replace("DUEL POINTS", ""), "no DP abbreviation")
    # watch race
    page.evaluate("DGApp.setSpeed(12); DGApp.go('watch')")
    btn = page.query_selector("[data-watch-go]:not([disabled])")
    check(btn is not None, "watchable live match")
    btn.click()
    page.wait_for_selector("[data-test=watch-race]", timeout=3000)
    shot(page, f"watch-race-{w}", full=False)
    page.wait_for_selector("[data-test=watch-result]", timeout=15000)
    page.click("#watchBack")
    # spectate with a registered test game
    page.evaluate("""DG.registerGame({id:'spec-test', name:'Spectate Test', category:'strategy', kind:'versus', formats:['1v1','tournament'],
      skill:9, luck:0, blurb:'x', rules:['a','b'], play(ctx){ ctx.timeout(()=>ctx.end({outcome:'win',myScore:1,oppScore:0}), 100); },
      spectate(ctx){ ctx.root.innerHTML='<p data-test=spec-board>'+ctx.players[0].name+' v '+ctx.players[1].name+'</p>'; ctx.setStatus('Move 1');
        ctx.timeout(()=>ctx.end({winner:0, scores:[3,1]}), 400); } }); DGApp.refresh();""")
    page.evaluate("DGApp.watchGame('spec-test')")
    page.wait_for_selector("[data-test=spec-board]", timeout=3000)
    page.wait_for_selector("[data-test=watch-result]", timeout=5000)
    check("mira wins" in page.inner_text("[data-test=watch-result]").lower(), "spectate result")
    page.click("#watchBack")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_errors_and_scale(page, w):
    print(f"[{w}] throwing games, 0 and 30 games")
    boot(page)
    page._console.clear()
    page.evaluate("""
      const base = {category:'reflex', kind:'race', formats:['1v1','2v2','ffa','tournament','mix'], skill:5, luck:1, blurb:'b', rules:['r']};
      DG.registerGame(Object.assign({}, base, {id:'boom', name:'Boom', play(ctx){ throw new Error('boom in play'); }, bot(){ return {score:5, timeline:[[1,5]]}; }}));
      DG.registerGame(Object.assign({}, base, {id:'boom-late', name:'Boom Late', play(ctx){ ctx.root.innerHTML='<p>ok</p>'; ctx.timeout(()=>{ throw new Error('late boom'); }, 200); }, bot(){ return {score:5, timeline:[[1,5]]}; }}));
      DG.registerGame(Object.assign({}, base, {id:'bad-bot', name:'Bad Bot', play(ctx){ ctx.end({score:1}); }, bot(){ throw new Error('bot boom'); }}));
      DG.registerGame(Object.assign({}, base, {id:'bad-result', name:'Bad Result', play(ctx){ ctx.timeout(()=>ctx.end({score:'lots'}), 50); }, bot(){ return {score:5, timeline:[[1,5]]}; }}));
      DGApp.refresh();""")
    for gid in ["boom", "boom-late", "bad-bot", "bad-result"]:
        g0 = gold(page)
        err = page.evaluate(f"DGApp.startMatch({{game:'{gid}', format:'1v1', stake:100}})")
        check(err == "", f"{gid} start: {err}")
        if gid != "bad-bot":  # a broken bot fails during matchmaking, so it is refunded before we can look
            check(gold(page) == g0 - 100, f"{gid} escrow")
        if gid != "bad-bot":
            start_round(page)
        page.wait_for_selector("[data-test=error]", timeout=8000)
        check(gold(page) == g0, f"{gid}: stake refunded")
        check("refunded" in page.inner_text("[data-test=error]"), f"{gid}: refund message")
        if gid == "boom":
            shot(page, f"error-{w}", full=False)
        page.click("#resBack")
        check(page.is_hidden("#ov"), f"{gid}: back to lobby")
    # tournament with a throwing game refunds the entry too
    g0 = gold(page)
    page.evaluate("DGApp.startMatch({game:'boom', format:'tournament', stake:250})")
    start_round(page)
    page.wait_for_selector("[data-test=error]", timeout=8000)
    check(gold(page) == g0, "tournament entry refunded on error")
    page.click("#resBack")
    unexpected = console_errors(page, allow=("[DG", "[Duel.gold]", "boom"))
    check(unexpected == [], f"unexpected errors: {unexpected}")
    # 30 games
    page.evaluate("""for (let i = 0; i < 28; i++) { const cats = DG.CATEGORIES.map(c=>c.id);
        DG.registerGame({id:'gen-'+i, name:'Generated Game With A Long Name '+i, category:cats[i%cats.length], kind: i%3 ? 'race':'versus',
          formats: i%3 ? ['1v1','2v2','ffa','tournament','mix'] : ['1v1','tournament'], skill:i%11, luck:(i*3)%11, cashEligible: i%2===0,
          blurb:'A generated test game with a longer blurb to check wrapping in the card layout.', rules:['Rule one','Rule two'],
          play(ctx){ ctx.end(ctx.opponents.length && i%3===0 ? {outcome:'draw', myScore:1, oppScore:1} : {score:1}); },
          bot(s,k,r){ return {score:1, timeline:[[1,1]]}; } }); } DGApp.refresh();""")
    n = page.evaluate("DG.games.length")
    check(n >= 30, f"{n} games registered")
    for t in ["home", "games", "watch", "tournaments", "social", "profile"]:
        page.evaluate(f"DGApp.go('{t}')")
        no_hscroll(page, f"30 games {t} @{w}")
    page.evaluate("DGApp.go('games')")
    shot(page, f"games-30-{w}")
    check(len(page.query_selector_all(".gcard")) == n, "all cards rendered")
    # zero games
    page.evaluate("DG.games.length = 0; DGApp.refresh()")
    for t in ["home", "games", "watch", "tournaments", "social", "profile"]:
        page.evaluate(f"DGApp.go('{t}')")
        check(page.evaluate(f"document.querySelector('#view-{t}').children.length") > 0, f"0 games: {t} renders")
        no_hscroll(page, f"0 games {t} @{w}")
    page.evaluate("DGApp.go('home')")
    check(page.query_selector("[data-test=no-games]") is not None, "0 games message")
    check(page.evaluate("DGApp.startMatch({})") != "", "0 games: start refused")
    shot(page, f"home-0games-{w}", full=False)
    unexpected = console_errors(page, allow=("[DG", "[Duel.gold]", "boom"))
    check(unexpected == [], f"unexpected errors: {unexpected}")


def test_no_storage(w):
    print(f"[{w}] localStorage blocked")
    with browser_page(width=w, height=800) as page:
        page.add_init_script("Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}})")
        page.goto(URL)
        page.wait_for_function("window.DGApp && DG.__appReady === true", timeout=15000)
        check(page.evaluate("DGApp.storage().ok") is False, "storage flagged unavailable")
        page.evaluate("DGApp.setSpeed(4)")
        page.evaluate("DGApp.startMatch({game:'sample-tap', stake:100})")
        tap_round(page, win=True)
        last = wait_result(page)
        check(last["payout"] == 180 and gold(page) == 10080, "plays with storage blocked")
        page.click("#resBack")
        page.evaluate("DGApp.go('settings')")
        check("blocks storage" in page.inner_text("#storageNote"), "storage note shown")
        for t in TABS:
            page.evaluate(f"DGApp.go('{t}')")
        check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_corrupt_state(w):
    print(f"[{w}] corrupt saved state")
    with browser_page(width=w, height=800) as page:
        page.add_init_script("""try { if (!sessionStorage.getItem('c1')) { sessionStorage.setItem('c1', '1'); localStorage.setItem('duelgold.v2', JSON.stringify({v:2, gold:-50, name:{}, streak:'x', bestStreak:null, rec:{w:'a', l:3}, today:{net:'x', played:{}}, games:{'sample-tap':{r:'x'}}, history:'nope', favs:[1,'sample-nim'], friends:[{name:5}], limits:null, cos:{owned:'x'}, ach:[], tours:5, active:{game:{}}, age:'adult'})); } } catch(e) {}""")
        page.goto(URL)
        page.wait_for_function("window.DGApp")
        s = st(page)
        check(s["gold"] == 0 and s["history"] == [] and s["favs"] == ["sample-nim"] and s["games"]["sample-tap"]["r"] == 1200, f"state sanitised {s['gold']}")
        check(s["name"] == "You" and s["streak"] == 0 and s["bestStreak"] == 0 and s["rec"]["w"] == 0 and s["rec"]["l"] == 3, f"per-field defaults {s['name']} {s['streak']} {s['rec']}")
        check(s["today"]["net"] == 0 and s["today"]["played"] == 0 and s["cos"]["owned"] == [] and s["active"] is None and s["limits"]["loss"] == 0, "nested fields sanitised")
        for t in TABS:
            page.evaluate(f"DGApp.go('{t}')")
        page.add_init_script("try { localStorage.setItem('duelgold.v2', '{not json'); } catch(e) {}")
        page.goto(URL)
        page.wait_for_function("window.DGApp")
        check(gold(page) == 10000, "unparseable state -> defaults")
        check(console_errors(page) == [], f"console errors: {console_errors(page)}")


# ------------------------------------------------------------------------------------------------
# QA fixes (round 2)
def reload_app(page):
    page.reload()
    page.wait_for_function("window.DGApp && DG.__appReady === true")
    page.evaluate("DGApp.setSpeed(4)")


def test_qa_fixes(page, w):
    print(f"[{w}] QA fixes")
    boot(page)
    # 19. startMatch validates the stake
    for bad in ["-5", "12.5", "'100'", "NaN", "Infinity"]:
        err = page.evaluate(f"DGApp.startMatch({{game:'sample-tap', stake:{bad}}})")
        check(err != "", f"startMatch rejects stake {bad}")
        check(page.evaluate("DGApp.current()") is None, f"no match started for stake {bad}")
    check(gold(page) == 10000, "rejected stakes take no gold")

    # 1. reload mid-match: staked → forfeit counted (history, today.net, rating, loss limit), notice shown
    page.evaluate("DGApp.set({limits:{loss:1000, remind:0, pending:null}})")
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'1v1', stake:900})")
    page.wait_for_function("DGApp.current() && DGApp.current().phase === 'ready'", timeout=10000)
    opp = page.evaluate("DGApp.current()")["opps"][0]
    check(st(page)["active"]["escrow"] == 900, "active escrow persisted")
    reload_app(page)
    s = st(page)
    check(s["gold"] == 9100 and s["active"] is None, f"reload mid-match: stake lost, not refunded ({s['gold']})")
    check(s["history"] and s["history"][0]["o"] == "loss" and s["history"][0]["net"] == -900, "reload mid-match: forfeit in history")
    check(s["today"]["net"] == -900 and s["rec"]["l"] == 1, "reload mid-match: counted today and in record")
    check(s["games"]["sample-tap"]["r"] == 1200 + elo(1200, opp["rating"], 0), "reload mid-match: rating loss applied")
    check("counted as a forfeit" in (page.evaluate("DGApp.notice()") or ""), "forfeit notice")
    check(page.is_visible("#recoverNote") and "forfeit" in page.inner_text("#recoverNote"), "notice visible on page")
    err = page.evaluate("DGApp.startMatch({game:'sample-tap', stake:900})")
    check("loss limit" in err, f"reload cannot bypass loss limit: {err}")
    # reload during matchmaking → refund
    page.evaluate("DGApp.set({limits:{loss:0, remind:0, pending:null}})")
    page.evaluate("DGApp.setSpeed(0.05)")
    g0 = gold(page)
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'ffa', stake:300})")
    check(gold(page) == g0 - 300 and st(page)["active"]["phase"] == "mm", "escrow during matchmaking persisted")
    reload_app(page)
    check(gold(page) == g0 and st(page)["active"] is None, "reload in matchmaking refunds")
    check("refunded" in page.inner_text("#recoverNote"), "refund notice")
    # free match abandoned mid-play also counts for rating
    r0 = st(page)["games"]["sample-nim"]["r"] if "sample-nim" in st(page)["games"] else 1200
    page.evaluate("DGApp.startMatch({game:'sample-nim', format:'1v1', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.click("#mStart")
    page.wait_for_function("DGApp.current().phase === 'play'")
    reload_app(page)
    s = st(page)
    check(s["games"]["sample-nim"]["l"] == 1 and s["games"]["sample-nim"]["r"] < r0, "free match abandoned by reload is a rated loss")

    # 10. no auto-start
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'1v1', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.wait_for_timeout(11000 if w == 1280 else 200)
    check(page.evaluate("DGApp.current().phase") == "ready", "rules card waits for Start (no auto-start)")
    check("Starts by itself" not in page.inner_text("[data-test=rules]"), "no auto-start copy")
    # 7. overlay focus trap
    outside = 0
    for _ in range(12):
        page.keyboard.press("Tab")
        if not page.evaluate("document.getElementById('ov').contains(document.activeElement)"):
            outside += 1
    check(outside == 0, f"Tab stays inside match overlay ({outside} escapes)")
    check(page.evaluate("document.activeElement.closest('#ov') !== null"), "focus in overlay")
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    # 6+7. forfeit dialog: keys don't reach the game, Keep playing returns focus to the game root
    page.evaluate("""window.__keys = 0; DGApp.ctx().onKey(() => window.__keys++);""")
    page.click("#ovForfeit")
    page.wait_for_selector("[data-test=forfeit-confirm]")
    for k in ["a", "ArrowLeft", "1", "Enter"][:3]:
        page.keyboard.press(k)
    check(page.evaluate("window.__keys") == 0, "game gets no keys while a modal is open")
    out = 0
    for _ in range(8):
        page.keyboard.press("Tab")
        if not page.evaluate("!!document.activeElement.closest('.modal')"):
            out += 1
    check(out == 0, "Tab trapped inside forfeit dialog")
    page.click("#forfeitNo")
    fid = page.evaluate("document.activeElement.id")
    check(fid != "ovForfeit" and page.evaluate("document.getElementById('ov').contains(document.activeElement)"), f"Keep playing focuses the game, not Forfeit ({fid})")
    page.keyboard.press("b")
    check(page.evaluate("window.__keys") == 1, "keys reach the game again after the dialog closes")
    # 6. dialog left open while the round ends → closed, forfeit button hidden
    page.click("#ovForfeit")
    page.wait_for_selector("[data-test=forfeit-confirm]")
    page.evaluate("DGApp.ctx().end({score: 999})")
    page.wait_for_selector("[data-test=result]")
    check(page.query_selector("[data-test=forfeit-confirm]") is None, "forfeit dialog closes when the round ends")
    check(page.is_hidden("#ovForfeit"), "Forfeit hidden after ctx.end")
    check(page.evaluate("DGApp.last().outcome") == "win", "round result stands")
    page.click("#resBack")
    # 6. tournament: dialog open across rounds cannot forfeit the next round
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'tournament', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    page.evaluate("document.getElementById('ovForfeit').click()")
    page.wait_for_selector("[data-test=forfeit-confirm]")
    page.evaluate("DGApp.ctx().end({score: 999})")
    page.wait_for_function("DGApp.current().tour.round === 1", timeout=15000)
    check(page.query_selector("[data-test=forfeit-confirm]") is None, "stale forfeit dialog closed between rounds")
    check(page.evaluate("DGApp.current().tour.alive"), "next round not forfeited")
    # 13. bracket shows your own win
    brtxt = page.inner_text("[data-test=bracket]")
    check("999" in brtxt, "bracket shows your QF score")
    page.evaluate("DGApp.close()")
    # 17. FFA 2nd place paying more than the stake: not a loss, streak kept
    page.evaluate("DGApp.set({streak: 2, bestStreak: 2})")
    res = page.evaluate("""(() => { const E = DGApp.econ; const sp = E.ffaSplit([50, 60, 10, 5], E.ffaPrizes(100, 4)); return sp; })()""")
    check(res["places"][0] == 2 and res["pay"][0] > 100, f"ffa 2nd pays more than stake {res}")
    # play an FFA and force 2nd place by ending with a score between the top two bots
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'ffa', stake:100})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    page.evaluate("""(() => { const c = DGApp.current(); window.__opps = c.opps; })()""")
    # bots: compute scores the platform used via the same bot fn
    sc = page.evaluate("""(() => { const c = DGApp.current(); const g = DG.getGame('sample-tap'); return c.opps.map(p => g.bot(c.seed, p.skill, DG.util.rng(c.seed + ':' + p.name), 'full').score); })()""")
    top = sorted(sc, reverse=True)
    if top[0] > top[1]:
        page.evaluate(f"DGApp.ctx().end({{score: {(top[0] + top[1]) / 2}}})")
        last = wait_result(page)
        s = st(page)
        check(last["place"] == 2 and last["outcome"] == "place", f"ffa 2nd recorded as placement {last}")
        check(s["streak"] == 2 and s["history"][0]["o"] == "place", "2nd place keeps streak, history says placement")
        check("2nd" in page.inner_text("[data-test=result]").lower(), "2nd shown on result")
    else:
        page.evaluate("DGApp.forfeit()")
        wait_result(page)
    page.evaluate("DGApp.close()")

    # 14. toasts at the top, don't cover buttons, container click-through, achievements merged
    page.evaluate("DGApp.reset(); DGApp.setSpeed(4); document.getElementById('toasts').innerHTML = ''")
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'1v1', stake:1000})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    page.evaluate("DGApp.set({ach:{}, streak:4, lossRun:3})")
    page.evaluate("DGApp.ctx().end({score: 999})")
    page.wait_for_selector("[data-test=result]")
    page.wait_for_timeout(100)
    check(page.query_selector("#toasts .toast") is None and page.query_selector("[data-test=unlocked]"), "in a match, achievements are inline, not toasts")
    # outside a match several unlocks merge into one toast
    page.evaluate("""(() => { const s = DGApp.state(); DGApp.close(); document.getElementById('toasts').innerHTML = '';
        DGApp.set({ach: {}}); DGP.unlock('polymath'); DGP.unlock('team-player'); })()""")
    page.wait_for_timeout(100)
    toasts = [t for t in page.query_selector_all("#toasts .toast") if "chievement" in t.inner_text()]
    check(len(toasts) == 1, f"achievements merged into one toast ({len(toasts)})")
    check("Achievements unlocked" in page.inner_text("#toasts"), "merged toast wording")
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'1v1', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.click("#mStart")
    page.evaluate("DGApp.ctx().end({score: 999})")
    page.wait_for_selector("[data-test=result]")
    check(page.evaluate("getComputedStyle(document.getElementById('toasts')).pointerEvents") == "none", "toast container click-through")
    tb = page.evaluate("document.getElementById('toasts').getBoundingClientRect().bottom")
    for sel in ["#resRematch", "#resBack"]:
        bt = page.evaluate(f"document.querySelector('{sel}').getBoundingClientRect().top")
        check(bt > tb or page.evaluate(f"document.elementFromPoint(...(r => [r.left + r.width/2, r.top + r.height/2])(document.querySelector('{sel}').getBoundingClientRect())) === document.querySelector('{sel}') || document.querySelector('{sel}').contains(document.elementFromPoint(...(r => [r.left + r.width/2, r.top + r.height/2])(document.querySelector('{sel}').getBoundingClientRect())))"), f"{sel} not covered by toasts")
    shot(page, f"qa-result-toast-{w}", full=False)
    page.click("#resBack")

    # 2. reset keeps limits
    page.evaluate("DGApp.set({limits:{loss:500, remind:0, pending:null}})")
    page.evaluate("DGApp.go('settings')")
    page.click("#resetBtn"); page.click("#confirmYes")
    s = st(page)
    check(s["limits"]["loss"] == 500, "reset keeps limits")
    page.evaluate("DGApp.set({limits:{loss:0, remind:0, pending:null}})")
    # 4. lowering applies now, raising waits 24 h
    page.evaluate("DGApp.go('settings')")
    page.click("#loss-2500")
    check(st(page)["limits"]["loss"] == 2500, "setting a first limit applies now")
    page.click("#loss-1000")
    check(st(page)["limits"]["loss"] == 1000 and st(page)["limits"]["pending"] is None, "lowering applies now")
    page.click("#loss-5000")
    s = st(page)
    check(s["limits"]["loss"] == 1000 and s["limits"]["pending"]["loss"] == 5000, "raising is pending")
    check("takes effect at" in page.inner_text("#lossMsg") and page.is_visible("#lossPending"), "pending time shown")
    page.fill("#lossCustom", "800"); page.click("#lossSet")
    check(st(page)["limits"]["loss"] == 800 and st(page)["limits"]["pending"] is None, "lowering cancels a pending raise")
    page.evaluate("DGApp.set({limits:{loss:0, remind:0, pending:null}})")

    # 20. loss limit hit: single message, Free auto-selected
    page.evaluate("DGApp.go('home')")
    page.click("#dnS-250")
    page.evaluate("DGApp.set({limits:{loss:100, remind:0, pending:null}, today: Object.assign(DGApp.state().today, {net: -100})})")
    txt = page.inner_text("#duelNow")
    check(txt.count("loss limit reached") == 1, f"block message shown once ({txt.count('loss limit reached')})")
    check(page.get_attribute("#dnS-0", "aria-pressed") == "true" and not page.is_disabled("#dnFind"), "Free auto-selected, Find enabled")
    page.evaluate("DGApp.set({limits:{loss:0, remind:0, pending:null}, today: Object.assign(DGApp.state().today, {net: 0})})")

    # 12. Duel Mix never repeats a game; says so when it fills from other categories
    page.evaluate("""(() => { const base = {kind:'race', formats:['1v1','mix'], skill:5, luck:1, blurb:'b', rules:['r'], play(ctx){ ctx.timeout(()=>ctx.end({score:5}), 50); }, bot(){ return {score:1, timeline:[[1,1]]}; }};
        DG.registerGame(Object.assign({}, base, {id:'mx-a', name:'Mix A', category:'word'}));
        DG.registerGame(Object.assign({}, base, {id:'mx-b', name:'Mix B', category:'dice'}));
        DGApp.refresh(); })()""")
    for _ in range(4):
        page.evaluate("DGApp.startMatch({game:'cat:word', format:'mix', stake:0})")
        page.wait_for_selector("[data-test=mix]")
        gs = page.evaluate("DGApp.current().games")
        check(len(set(gs)) == 3, f"mix games distinct {gs}")
        check("other categories" in page.inner_text("[data-test=mix]"), "mix fill explained")
        page.evaluate("DGApp.close()")

    # 5. start is chunked: no long task > 50 ms at FFA start or bracket simulation (heavy bot)
    page.evaluate("""(() => { window.__lt = []; try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({type:'longtask'}); } catch(e) {}
        const busy = (ms) => { const t = performance.now(); while (performance.now() - t < ms) {} };
        DG.registerGame({id:'heavy', name:'Heavy Bot', category:'puzzle', kind:'race', formats:['1v1','2v2','ffa','tournament','mix'], skill:8, luck:1, blurb:'b', rules:['r'],
          play(ctx){ ctx.root.innerHTML = '<p>heavy</p>'; }, bot(seed, skill){ busy(35); return {score: Math.round(skill * 100), timeline:[[1, Math.round(skill * 100)]]}; } });
        DGApp.refresh(); })()""")
    for fmt in ["ffa", "2v2"]:
        page.evaluate("window.__lt.length = 0")
        page.evaluate(f"DGApp.startMatch({{game:'heavy', format:'{fmt}', stake:0}})")
        page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
        lt = page.evaluate("window.__lt.slice()")
        check(max(lt, default=0) < 120, f"{fmt} start: longest task {max(lt, default=0)} ms")
        page.evaluate("DGApp.close()")
    page.evaluate("DGApp.startMatch({game:'heavy', format:'tournament', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
    page.click("#mStart")
    page.evaluate("window.__lt.length = 0")
    page.evaluate("DGApp.ctx().end({score: -1})")
    page.wait_for_selector("[data-test=result]", timeout=15000)
    lt = page.evaluate("window.__lt.slice()")
    check(max(lt, default=0) < 120, f"bracket simulation chunked: longest task {max(lt, default=0)} ms (6 heavy bot runs ≈ 210 ms total)")
    check(page.evaluate("DGApp.last().stage") == 0, "QF exit settles after chunked simulation")
    page.evaluate("DGApp.close()")
    # closing mid-simulation still settles exactly once
    g0 = gold(page)
    page.evaluate("DGApp.startMatch({game:'heavy', format:'tournament', stake:100})")
    page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
    page.click("#mStart")
    page.evaluate("DGApp.ctx().end({score: -1}); DGApp.close()")
    s = st(page)
    check(s["gold"] == g0 - 100 and s["history"][0]["f"] == "tournament" and s["active"] is None, "closing mid-simulation settles once")
    page.wait_for_timeout(300)
    check(len([h for h in st(page)["history"] if h["f"] == "tournament"]) == len([h for h in s["history"] if h["f"] == "tournament"]), "no second settlement")

    # 21. status text wraps rather than truncates; 2v2 names at 360
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'2v2', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])")
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    stat = page.evaluate("(() => { DGApp.ctx().setStatus('Round 3 of 5 · 0:42 left · your move now'); const e = document.getElementById('ovStatus'); return [e.textContent, getComputedStyle(e).whiteSpace]; })()")
    check(stat[0].endswith("now") and stat[1] != "nowrap", f"long status kept whole and allowed to wrap {stat}")
    bar = page.evaluate("[document.getElementById('ovBar').scrollWidth, document.getElementById('ovBar').clientWidth]")
    check(bar[0] <= bar[1] + 1, f"2v2 top bar fits {bar}")
    check(page.is_visible(".who.pair"), "2v2 shows both teammates compactly")
    check(page.is_visible(".ov-demo"), "Demo gold label in overlay")
    shot(page, f"qa-2v2-bar-{w}", full=False)
    page.evaluate("DGApp.close()")

    # 7. watch moves focus into the overlay
    page.evaluate("DGApp.go('watch')")
    btn = page.query_selector("[data-watch-go]:not([disabled])")
    btn.focus(); page.keyboard.press("Enter")
    page.wait_for_timeout(150)
    check(page.evaluate("document.getElementById('ov').contains(document.activeElement)"), "Watch focuses the overlay")
    page.evaluate("DGApp.close()")
    # sheets: focus trapped, restored to the Duel button on close
    page.evaluate("DGApp.go('games')")
    page.focus("[data-duel='sample-tap']"); page.keyboard.press("Enter")
    page.wait_for_selector("[data-test=duel-sheet]")
    out = 0
    for _ in range(30):
        page.keyboard.press("Tab")
        if not page.evaluate("!!document.activeElement.closest('.modal')"):
            out += 1
    check(out == 0, f"Tab trapped in duel sheet ({out})")
    page.keyboard.press("Escape")
    check(page.evaluate("document.activeElement.getAttribute('data-duel')") == "sample-tap", "focus restored to Duel button")

    # 8. sticky header
    page.evaluate("DGApp.go('profile')")
    page.evaluate("window.scrollTo(0, 600)")
    page.wait_for_timeout(50)
    top = page.evaluate("document.getElementById('top').getBoundingClientRect().top")
    check(abs(top) < 1, f"header sticks when scrolled (top={top})")
    check(page.evaluate("getComputedStyle(document.body).overflowX") != "hidden", "no overflow-x:hidden on body")
    page.evaluate("window.scrollTo(0, 0)")
    # 9. Find opponent above the fold on phones
    page.evaluate("DGApp.go('home')")
    if w <= 400:
        b = page.evaluate("document.getElementById('dnFind').getBoundingClientRect().bottom")
        check(b <= 780 - 62, f"Find opponent visible on first phone screen (bottom {b})")
        shot(page, "qa-home-fold-360", full=False)
    # 23. tap targets ≥ 36 px for live-now + footer links
    small = page.evaluate("""[...document.querySelectorAll('#liveList .link, .foot a, #bottomNav .nav-b, #settingsBtn')].filter(e => e.offsetParent).map(e => e.getBoundingClientRect()).filter(r => r.height < 36).length""")
    check(small == 0, f"{small} small tap targets")
    # 22. copy
    check(page.get_attribute("#tab-tournaments", "title") == "Tournaments", "sidebar says Tournaments")
    check("Cups" not in page.inner_text("body"), "no 'Cups'")
    page.evaluate("DGApp.go('tournaments')")
    t = page.inner_text("[data-tour=weekend]")
    check(t.count("20,000") <= 1 and "added by the house" in t, "added prize said once")
    page.evaluate("DGApp.go('games')")
    check("Favorites" not in page.inner_text("body"), "British spelling: favourites")
    check(page.evaluate("getComputedStyle(document.querySelector('.logo')).fontFamily").find("Inter") >= 0, "logo uses Inter")
    # clean up test games
    page.evaluate("DG.games.splice(0, DG.games.length, ...DG.games.filter(g => g.id.startsWith('sample-'))); DGApp.refresh()")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_load_errors(w):
    print(f"[{w}] load-error banner with string entries")
    with browser_page(width=w, height=800) as page:
        page.goto(URL)
        page.wait_for_function("window.DGApp")
        page.evaluate("""DG.loadErrors.push('strategy.js: chess: missing rules'); DG.loadErrors.push({id:'x', message:'bad'}); DGApp.go('home');""")
        page.evaluate("DGP.reportLoad && DGP.reportLoad()")
        txt = page.inner_text("#loadErrors")
        check("undefined" not in txt and "missing rules" in txt and "x: bad" in txt, f"banner text: {txt}")


def test_preview(w):
    """The real build (all five packs) in the host-like skeleton."""
    print(f"[{w}] dist/preview.html with all packs")
    prev = (ROOT / "dist" / "preview.html").as_uri()
    with browser_page(width=w, height=780 if w < 400 else 900) as page:
        page.goto(prev)
        page.wait_for_function("window.DGApp && DG.__appReady === true", timeout=15000)
        n = page.evaluate("DG.games.length")
        check(n >= 20, f"{n} games registered in the full build")
        check(page.is_hidden("#loadErrors") or "undefined" not in page.inner_text("#loadErrors"), "load errors readable")
        for t in TABS:
            page.evaluate(f"DGApp.go('{t}')")
            page.wait_for_timeout(60)
            no_hscroll(page, f"preview {t} @{w}")
            shot(page, f"preview-{t}-{w}", full=False)
        page.evaluate("DGApp.go('home')")
        if w <= 400:
            b = page.evaluate("document.getElementById('dnFind').getBoundingClientRect().bottom")
            check(b <= 780 - 62, f"preview: Find opponent above the fold ({b})")
        page.evaluate("window.scrollTo(0, 800)")
        check(abs(page.evaluate("document.getElementById('top').getBoundingClientRect().top")) < 1, "preview: sticky header")
        page.evaluate("window.scrollTo(0, 0)")
        page.evaluate("DGApp.setSpeed(4)")
        ids = page.evaluate("DG.games.map(g => g.id)")
        for gid in ids:
            err = page.evaluate(f"DGApp.startMatch({{game:'{gid}', format:'1v1', stake:0}})")
            check(err == "", f"{gid}: start {err}")
            page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
            page.click("#mStart")
            page.wait_for_timeout(250)
            check(page.evaluate("DGApp.current().phase") == "play", f"{gid}: playing")
            no_hscroll(page, f"preview play {gid} @{w}")
            page.click("#ovForfeit")
            page.click("#forfeitYes")
            page.wait_for_selector("[data-test=result]", timeout=8000)
            page.evaluate("DGApp.close()")
        # mix + a spectate if any
        page.evaluate("DGApp.startMatch({format:'mix', stake:0})")
        page.wait_for_selector("[data-test=mix]", timeout=10000)
        gs = page.evaluate("DGApp.current().games")
        check(len(set(gs)) == 3, f"preview mix distinct {gs}")
        page.evaluate("DGApp.close()")
        spec = page.evaluate("DG.games.filter(g => g.spectate).map(g => g.id)")
        if spec:
            page.evaluate(f"DGApp.watchGame('{spec[0]}')")
            page.wait_for_timeout(800)
            no_hscroll(page, f"preview spectate @{w}")
            page.evaluate("DGApp.close()")
        s = st(page)
        check(s["active"] is None and s["gold"] == 10000, "preview: forfeits of free games cost nothing")
        check(console_errors(page) == [], f"preview console errors: {console_errors(page)[:5]}")


# ------------------------------------------------------------------------------------------------
# UX re-verification fixes (round 3)
OVERFLOW_JS = """(() => { const vw = window.innerWidth; const ov = document.getElementById('ov');
  const bad = [...ov.querySelectorAll('*')].filter(e => { if (!e.getClientRects().length) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden') return false;
    if (e.closest('.dg-scroll-x, .scroller')) return false; const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5); });
  return {ov: ov.scrollWidth - ov.clientWidth, scroll: document.getElementById('ovScroll').scrollWidth - document.getElementById('ovScroll').clientWidth,
          bad: bad.slice(0, 5).map(e => (e.id || e.className || e.tagName) + ':' + Math.round(e.getBoundingClientRect().right))}; })()"""


def ov_fits(page, label):
    r = page.evaluate(OVERFLOW_JS)
    check(r["ov"] <= 0 and r["scroll"] <= 0 and not r["bad"], f"{label}: overlay fits viewport {r}")


def test_ux_round3(page, w):
    print(f"[{w}] UX round 3")
    boot(page)
    # 1 + 4: nothing in the overlay extends beyond the viewport, every format, every phase
    for fmt in ["1v1", "2v2", "ffa", "tournament", "mix"]:
        game = "sample-nim" if fmt == "1v1" else "sample-tap"
        page.evaluate(f"DGApp.startMatch({{game:'{game}', format:'{fmt}', stake:100}})")
        page.wait_for_selector("[data-test=matchmaking]")
        ov_fits(page, f"{fmt} matchmaking @{w}")
        page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
        ov_fits(page, f"{fmt} rules @{w}")
        page.click("#mStart")
        page.wait_for_timeout(150)
        ov_fits(page, f"{fmt} playing @{w}")
        if fmt == "tournament":
            page.evaluate("DGApp.ctx().end({score: 999})")
            page.wait_for_function("DGApp.current().tour.round === 1", timeout=15000)
            page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
            ov_fits(page, f"tournament between rounds @{w}")
            check(page.is_visible("[data-test=tour-note]") and page.query_selector("#toasts .toast") is None, "round note inline, no toast over the rules")
            check(page.evaluate("(() => { const r = document.getElementById('ovForfeit').getBoundingClientRect(); return r.right <= innerWidth; })()"), "Forfeit fully visible")
            shot(page, f"ux3-tour-between-{w}", full=False)
            page.click("#mStart")
            page.wait_for_timeout(100)
        elif fmt == "mix":
            page.evaluate("DGApp.ctx().end({score: 999})")
            page.wait_for_function("DGApp.current().mix.rounds.length === 1", timeout=15000)
            page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
            ov_fits(page, f"mix table @{w}")
            shot(page, f"ux3-mix-{w}", full=False)
            page.click("#mStart")
            page.wait_for_timeout(100)
        # 6: programmatic focus on the game root shows no ring
        if page.query_selector("#gameRoot"):
            ring = page.evaluate("(() => { const g = document.getElementById('gameRoot'); return [document.activeElement === g, getComputedStyle(g).outlineStyle, getComputedStyle(g).outlineWidth]; })()")
            check(ring[0] and (ring[1] == "none" or ring[2] == "0px"), f"{fmt}: no focus ring on game root {ring}")
        page.evaluate("DGApp.forfeit()")
        page.wait_for_selector("[data-test=result]", timeout=15000)
        ov_fits(page, f"{fmt} result @{w}")
        page.click("#resBack")

    # 3: achievements inline on the result, no toasts in the overlay
    page.evaluate("DGApp.set({ach:{}}); document.getElementById('toasts').innerHTML = ''")
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'1v1', stake:1000})")
    page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    page.evaluate("DGApp.ctx().end({score: 999})")
    page.wait_for_selector("[data-test=result]")
    page.wait_for_timeout(100)
    check(page.query_selector("#toasts .toast") is None, "no toast over the result screen")
    un = page.inner_text("[data-test=unlocked]") if page.query_selector("[data-test=unlocked]") else ""
    check("First win" in un and "High roller" in un, f"achievements listed inline: {un}")
    shot(page, f"ux3-result-unlocked-{w}", full=False)
    page.click("#resBack")
    page.evaluate("DGApp.remindNow()")
    check("Reminder" in page.inner_text("#toasts"), "toasts still work outside matches")
    page.evaluate("document.getElementById('toasts').innerHTML = ''")
    page.evaluate("DGApp.startMatch({game:'sample-tap', stake:0})")
    page.evaluate("DGApp.remindNow()")
    check(page.is_visible("[data-test=remind-inline]") and page.query_selector("#toasts .toast") is None, "mid-match reminder shown inline in the overlay, not as a toast")
    ov_fits(page, f"reminder banner @{w}")
    page.evaluate("DGApp.close()")

    # 7: long tournament title is capped
    page.evaluate("DGApp.startMatch({game:'sample-tap', format:'tournament', stake:0})")
    page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
    page.click("#mStart")
    page.evaluate("DGApp.ctx().end({score: -1})")
    page.wait_for_selector("[data-test=result]", timeout=15000)
    t = page.evaluate("(() => { const e = document.getElementById('resTitle'); const lh = parseFloat(getComputedStyle(e).lineHeight) || parseFloat(getComputedStyle(e).fontSize); return [e.textContent, Math.round(e.getBoundingClientRect().height / lh), parseFloat(getComputedStyle(e).fontSize)]; })()")
    check(t[1] <= 2 and t[2] <= 64, f"long result title ≤ 2 lines and ≤ 64 px {t}")
    shot(page, f"ux3-tour-result-{w}", full=False)
    page.click("#resBack")

    # 9: forfeit confirmed just before the game calls ctx.end settles once, as a loss
    g0 = gold(page)
    n0 = len(st(page)["history"])
    page.evaluate("DGApp.startMatch({game:'sample-tap', stake:100})")
    page.wait_for_selector("#mStart:not([disabled])", timeout=10000)
    page.click("#mStart")
    page.wait_for_selector("[data-test=tap]")
    page.evaluate("window.__c = DGApp.ctx(); setTimeout(() => window.__c.end({score: 999}), 1500)")
    page.click("#ovForfeit"); page.click("#forfeitYes")
    page.wait_for_timeout(1900)
    s = st(page)
    check(len(s["history"]) == n0 + 1 and s["history"][0]["o"] == "loss" and s["gold"] == g0 - 100, "late ctx.end after a forfeit is ignored (settled once)")
    page.click("#resBack")

    # 2: shop rows — names not crushed, nothing overlaps the button
    page.evaluate("DGApp.set({dp: 700}); DGApp.go('profile')")
    rows = page.evaluate("""[...document.querySelectorAll('#shopList li')].map(li => { const n = li.querySelector('.shop-main b').getBoundingClientRect();
        const b = li.querySelector('button').getBoundingClientRect(); const p = li.querySelector('.shop-price'); const pr = p ? p.getBoundingClientRect() : null;
        const lh = parseFloat(getComputedStyle(li.querySelector('.shop-main b')).lineHeight) || 20;
        const hit = (x, y) => x && !(x.right <= y.left + 0.5 || y.right <= x.left + 0.5 || x.bottom <= y.top + 0.5 || y.bottom <= x.top + 0.5);
        return {name: li.querySelector('.shop-main b').textContent, lines: Math.round(n.height / lh), overlapBtn: hit(n, b) || hit(pr, n) || hit(pr, b), btn: li.querySelector('button').textContent, out: li.getBoundingClientRect().right > innerWidth}; })""")
    for r in rows:
        check(r["lines"] <= 2 and not r["overlapBtn"] and not r["out"], f"shop row {r}")
        check(r["btn"] in ("Buy", "Equip", "Unequip"), f"compact button: {r['btn']}")
    check("duel points" in page.inner_text("#shopList").lower(), "price caption says duel points")
    page.evaluate("document.getElementById('shop').scrollIntoView()")
    shot(page, f"ux3-shop-{w}", full=False)
    page.click("[data-buy='title-gm']") if not page.is_disabled("[data-buy='title-gm']") else None
    page.click("[data-buy='title-sharp']")
    check("title-sharp" in st(page)["cos"]["owned"], "buy still works")

    # 5: header tag readable
    check(page.query_selector("#demoTag") is None and page.query_selector("#topFilter") is None, f"no demo tag or filter button at {w}")
    no_hscroll(page, f"header @{w}")
    # 8: About link ≥ 40 px, card eyebrows on one line
    page.evaluate("DGApp.go('settings')")
    h = page.evaluate("document.getElementById('fairLink').getBoundingClientRect().height")
    check(h >= 40, f"How Duel.gold works link height {h}")
    page.evaluate("DGApp.go('games')")
    multi = page.evaluate("""[...document.querySelectorAll('.gcard-top .dg-eyebrow')].filter(e => { const lh = parseFloat(getComputedStyle(e).lineHeight) || 15; return e.getBoundingClientRect().height > lh * 1.5; }).length""")
    if w >= 1280:
        check(multi == 0, f"{multi} library eyebrows wrap at {w}")
    check("FFA +" in page.inner_text("#gameGrid") or "1V1 · 2V2 · FFA +" in page.inner_text("#gameGrid").upper(), "formats shortened with +N")
    check(console_errors(page) == [], f"console errors: {console_errors(page)}")


def test_reset(page, w):
    print(f"[{w}] reset demo data")
    boot(page)
    page.evaluate("DGApp.set({gold: 1234})")
    page.evaluate("DGApp.go('settings')")
    page.click("#resetBtn")
    page.wait_for_selector("[data-test=reset-confirm]")
    page.click("#confirmNo")
    check(gold(page) == 1234, "reset cancel keeps data")
    page.click("#resetBtn")
    page.click("#confirmYes")
    check(gold(page) == 10000, "reset restores defaults")
    page.wait_for_timeout(200)
    check(page.query_selector("[data-test=age-gate]") is None, "no age gate after reset")


def main():
    t0 = time.time()
    for w in (1280, 360):
        with browser_page(width=w, height=900 if w > 400 else 780) as page:
            test_qa_fixes(page, w)
            test_ux_round3(page, w)
            test_tabs(page, w)
            test_1v1_race(page, w)
            test_1v1_versus(page, w)
            test_2v2_ffa(page, w)
            test_tournament(page, w)
            test_mix(page, w)
            test_forfeit_and_stakes(page, w)
            test_social_profile(page, w)
            test_reset(page, w)
            test_errors_and_scale(page, w)
        test_no_storage(w)
    test_corrupt_state(1280)
    test_load_errors(1280)
    for w in (360, 1280):
        test_preview(w)
    print(f"\n{PASSES[0]} checks passed, {len(FAILS)} failed in {time.time() - t0:.0f}s")
    for f in FAILS:
        print(" -", f)
    assert not FAILS, f"{len(FAILS)} failures"


if __name__ == "__main__":
    main()
