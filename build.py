#!/usr/bin/env python3
"""Build PlayVault into single-file pages.

Reads src/index.html and inlines every LOCAL <link rel="stylesheet" href="..."> and <script src="..."></script>
(paths relative to src/). Remote URLs (https://...) are left untouched.

Outputs:
  dist/index.html    artifact form (no doctype/html/head/body — the artifact host wraps it)
  dist/preview.html  same content wrapped in a standards-mode document mimicking the host skeleton (for tests)

  python3 build.py --test-games _samples.js   -> dist/test.html with the games/* script tags replaced
                                                 (lets the platform be tested before the game packs exist)
"""
import pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent
SRC = ROOT / "src"
DIST = ROOT / "dist"


def inline(html: str) -> str:
    def css(m):
        href = m.group(1)
        if href.startswith(("http:", "https:")):
            return m.group(0)
        text = (SRC / href).read_text()
        return f"<style>/* {href} */\n{text}\n</style>"

    def js(m):
        src = m.group(1)
        if src.startswith(("http:", "https:")):
            return m.group(0)
        text = (SRC / src).read_text()
        if "</script" in text.lower():
            sys.exit(f"build error: {src} contains a literal </script — escape it as <\\/script")
        return f"<script>/* {src} */\n{text}\n</script>"

    html = re.sub(r'<link\s+rel="stylesheet"\s+href="([^"]+)"\s*/?>', css, html)
    html = re.sub(r'<script\s+src="([^"]+)"\s*>\s*</script>', js, html)
    return html


def main():
    tpl = (SRC / "index.html").read_text()
    test_games = None
    if "--test-games" in sys.argv:
        test_games = sys.argv[sys.argv.index("--test-games") + 1].split(",")
        tags = re.findall(r'<script\s+src="games/[^"]+"\s*>\s*</script>\s*', tpl)
        if not tags:
            sys.exit("build error: no games/*.js script tags in src/index.html")
        first = tpl.index(tags[0])
        for t in tags:
            tpl = tpl.replace(t, "")
        tpl = tpl[:first] + "".join(f'<script src="games/{g}"></script>\n' for g in test_games) + tpl[first:]
    if re.search(r"<!doctype|<html|<head|<body", tpl, re.I):
        sys.exit("build error: src/index.html must not contain doctype/html/head/body tags")
    out = inline(tpl)
    DIST.mkdir(exist_ok=True)
    if not test_games:
        (DIST / "index.html").write_text(out)
    skeleton = (
        "<!doctype html><html><head><meta charset=\"utf-8\">"
        "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">"
        "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}"
        "body{margin:0;font:14px system-ui,sans-serif;background:#faf9f7}img{max-width:100%}[hidden]{display:none!important}</style>"
        "</head><body>\n" + out + "\n</body></html>"
    )
    if test_games:
        (DIST / "test.html").write_text(skeleton)
        print(f"built dist/test.html with test games {test_games}")
        return
    (DIST / "preview.html").write_text(skeleton)
    kb = len(out.encode()) / 1024
    print(f"built dist/index.html ({kb:.0f} KB) and dist/preview.html")


if __name__ == "__main__":
    main()
