"""Playwright helpers for PlayVault tests.

Usage (python3, sync API):
    from dglib import browser_page, open_harness, wait_result
    with browser_page(width=400) as page:
        open_harness(page, files=["brain.js"], game="sudoku", seed=7, skill=0.5, speed=4)
        page.evaluate("__run()")
        ...interact...
        r = wait_result(page, timeout=30)
        assert not page.evaluate("__errors"), page.evaluate("__errors")

The CDN script for chess.js is served from vendor/chess.js (the sandbox has no CDN access).
Google Fonts requests are aborted (fallback fonts are used).
"""
import contextlib, json, os, pathlib, time
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
VENDOR_CHESS = ROOT / "vendor" / "chess.js"


def _routes(page):
    def cdn(route):
        url = route.request.url
        if "chess.js" in url:
            route.fulfill(path=str(VENDOR_CHESS), content_type="application/javascript")
        else:
            route.abort()
    page.route("https://cdnjs.cloudflare.com/**", cdn)
    page.route("https://fonts.googleapis.com/**", lambda r: r.abort())
    page.route("https://fonts.gstatic.com/**", lambda r: r.abort())


@contextlib.contextmanager
def browser_page(width=1280, height=900, touch=False):
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": width, "height": height}, has_touch=touch, is_mobile=touch)
        page = ctx.new_page()
        page._console = []
        page.on("console", lambda m: page._console.append(f"{m.type}: {m.text}"))
        page.on("pageerror", lambda e: page._console.append(f"pageerror: {e}"))
        _routes(page)
        try:
            yield page
        finally:
            b.close()


def open_harness(page, files, game=None, mode="full", fmt="1v1", seed=12345, skill=0.5, speed=1, auto=False):
    q = f"files={','.join(files)}&mode={mode}&format={fmt}&seed={seed}&skill={skill}&speed={speed}"
    if game:
        q += f"&game={game}"
    if auto:
        q += "&auto=1"
    page.goto((ROOT / "test" / "harness.html").as_uri() + "?" + q)
    page.wait_for_function("window.__ready === true", timeout=10000)


def open_app(page, path=None):
    """Open the built app (dist/index.html) or the dev template (src/index.html)."""
    path = path or (ROOT / "dist" / "index.html")
    page.goto(pathlib.Path(path).as_uri())


def wait_result(page, timeout=60):
    page.wait_for_function("window.__result !== null", timeout=timeout * 1000)
    return page.evaluate("window.__result")


def errors(page):
    errs = page.evaluate("window.__errors || []")
    return errs + [c for c in page._console if c.startswith(("error", "pageerror"))]
