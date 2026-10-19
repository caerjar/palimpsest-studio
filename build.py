#!/usr/bin/env python3
"""Build the Palimpsest Studio page — one self-contained HTML file.

The playback half of the page IS Palimpsest's Writing Record
(`palimpsest/engine/assets/writing-record.html`). This script takes that page,
fills the placeholders the dossier build normally fills, inlines style.css and
pal.js, adds the studio's source and writing panels above the replay, and
appends studio/studio.js. Nothing in the replay is forked: fix it in
Palimpsest, bump the submodule, rebuild.

    python3 build.py                                  # -> dist/index.html
    python3 build.py --palimpsest ../palimpsest       # build against a local checkout

Stdlib only, like Palimpsest.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STUDIO = HERE / "studio"

REPO = "https://github.com/caerjar/palimpsest-studio"
NS = "palstudio"        # localStorage namespace — never collides with a real book
THEME = "vapor"

HEAD = (
    '<!DOCTYPE html>'
    f'<html lang="en" data-theme="{THEME}" data-ns="{NS}">'
    '<head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
    '<meta name="description" content="Type a passage; hear the typing played back as a score.">'
    "<script>(function(d){try{"
    "var t=localStorage.getItem('pal:'+d.dataset.ns+':theme');"
    "if(t==='paper'||t==='vapor')d.dataset.theme=t;"
    "}catch(e){}})(document.documentElement)</script>"
)

NAV = (
    '<div class="topbar">'
    f'<a class="brand" href="/" title="start a new piece">Palimpsest Studio</a>'
    '<button class="palbtn paltheme" data-pal="theme" aria-pressed="false" '
    'title="switch the look — vapor or paper">'
    '<span class="tg">◐</span><span class="tl">Vapor</span></button>'
    '</div>'
)

HEADER = '<header class="sthead"><h1>Palimpsest <span>Studio</span></h1></header>'

FOOTER = (
    '<footer>Your typing stays in this browser unless you make a share link. '
    'Texts from <a href="https://www.gutenberg.org/">Project Gutenberg</a>. '
    f'Built on <a href="https://github.com/caerjar/Palimpsest">Palimpsest</a> · '
    f'<a href="{REPO}">source</a> (MIT).</footer>'
)


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except OSError as e:
        sys.exit(f"build: cannot read {p} — {e}")


def _gone(what: str) -> None:
    sys.exit(f"build: expected {what} in writing-record.html — the page moved on; "
             f"update build.py")


def sub_once(text: str, old: str, new: str, what: str) -> str:
    if old not in text:
        _gone(what)
    return text.replace(old, new, 1)


def sub_re(text: str, pattern: str, new: str, what: str) -> str:
    """Replace one match, literally — the replacement is HTML, never a template."""
    out, n = re.subn(pattern, lambda m: new, text, count=1, flags=re.S)
    if not n:
        _gone(what)
    return out


def build(palimpsest: Path, out: Path) -> None:
    assets = palimpsest / "palimpsest" / "engine" / "assets"
    page = read(assets / "writing-record.html")
    css = read(assets / "style.css") + "\n" + read(STUDIO / "studio.css")
    paljs = read(assets / "pal.js")
    panels = read(STUDIO / "panels.html")
    studiojs = read(STUDIO / "studio.js")

    page = sub_once(page, "__PAL_HEAD__", HEAD, "the head placeholder")
    page = sub_once(page, '<link rel="stylesheet" href="style.css">',
                    "<style>\n" + css + "\n</style>", "the stylesheet link")
    page = sub_once(page, "__PAL_NAV__", NAV, "the nav placeholder")
    page = sub_re(page, r"<header>.*?</header>", HEADER, "the header")
    # The page's own source pickers and demo recorder stay in the markup (its
    # script wires them unconditionally) and studio.css hides them; the studio
    # panels go in front of them.
    page = sub_once(page, '<div class="src">', panels + '\n<div class="src">', "the source pickers")
    page = sub_re(page, r"<footer>.*?</footer>", FOOTER, "the footer")
    page = page.replace("__PAL_TITLE__", "Palimpsest Studio").replace("__PAL_NS__", NS)
    page = sub_once(page, "Palimpsest Studio — Writing Record", "Palimpsest Studio", "the title")
    page = sub_once(page, '<script src="pal.js"></script>',
                    "<script>\n" + paljs + "\n</script>\n<script>\n" + studiojs + "\n</script>",
                    "the pal.js include")

    left = sorted(set(re.findall(r"__PAL_\w+__", page)))
    if left:
        sys.exit(f"build: unfilled placeholders remain: {left}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page, encoding="utf-8")
    print(f"wrote {out}  ({len(page.encode()) / 1024:.0f} KB, from {palimpsest})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--palimpsest", type=Path, default=HERE / "vendor" / "palimpsest",
                    help="a Palimpsest checkout (default: the vendor/palimpsest submodule)")
    ap.add_argument("--out", type=Path, default=HERE / "dist" / "index.html")
    a = ap.parse_args()
    build(a.palimpsest.resolve(), a.out)


if __name__ == "__main__":
    main()
