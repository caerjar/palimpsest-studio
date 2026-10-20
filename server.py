#!/usr/bin/env python3
"""Palimpsest Studio server — the page, a Project Gutenberg proxy, share links.

    python3 build.py && python3 server.py          # -> http://127.0.0.1:8080

Recording, playback and WAV rendering all happen in the browser. The server
only does what a browser can't: fetch Gutenberg texts (gutenberg.org sends no
CORS headers) and keep the sessions people choose to publish as share links.

Environment:
    PORT          listen port (default 8080)
    HOST          listen address (default 127.0.0.1; the container sets 0.0.0.0)
    STUDIO_DATA   where share links and cached books live (default ./data)
    STUDIO_DIST   the built page (default ./dist)

Stdlib only.
"""
from __future__ import annotations

import csv
import json
import math
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = Path(os.environ.get("STUDIO_DIST", HERE / "dist"))
DATA = Path(os.environ.get("STUDIO_DATA", HERE / "data"))

GUTENDEX = "https://gutendex.com/books/"
GUTENBERG_TXT = "https://www.gutenberg.org/cache/epub/{id}/pg{id}.txt"
UA = "palimpsest-studio/1 (+https://github.com/caerjar/palimpsest-studio)"

MAX_SHARE_BYTES = 4 * 1024 * 1024
MAX_EVENTS = 40_000
MAX_BOOK_BYTES = 8 * 1024 * 1024
SHARES_PER_HOUR = 20

SHARE_ID = re.compile(r"^[A-Za-z0-9]{10}$")
ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

CSP = ("default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


# ------------------------------------------------------------ gutenberg ---

_START = re.compile(r"^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$", re.M | re.I)
_END = re.compile(r"^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG EBOOK.*$", re.M | re.I)


def strip_gutenberg(raw: str) -> dict:
    """Split a Gutenberg plain-text file into title, author and the work itself.

    The licence header and footer go; what's between the START and END markers
    stays. Files without markers are returned whole."""
    raw = raw.replace("\r\n", "\n").lstrip("﻿")
    head = raw[:6000]
    title = _field(head, "Title")
    author = _field(head, "Author")
    s, e = _START.search(raw), _END.search(raw)
    body = raw[s.end():e.start() if e else None] if s else raw
    return {"title": title, "author": author, "text": body.strip("\n")}


def _field(head: str, name: str) -> str:
    m = re.search(rf"^{name}:[ \t]*(.+(?:\n[ \t]+.+)*)", head, re.M)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def _get(url: str, limit: int, timeout: float = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(limit + 1)
    if len(data) > limit:
        raise ValueError("too large")
    return data


_search_cache: dict[str, tuple[float, list]] = {}


def search_books(q: str) -> list[dict]:
    """Gutendex first (it ranks by downloads), the local catalog when it is slow."""
    key = q.lower()
    hit = _search_cache.get(key)
    if hit and time.time() - hit[0] < 3600:
        return hit[1]
    try:
        out = _search_gutendex(q)
    except Exception:
        out = CATALOG.search(q)
        if out is None:
            raise
    if len(_search_cache) > 500:
        _search_cache.clear()
    _search_cache[key] = (time.time(), out)
    return out


def _search_gutendex(q: str) -> list[dict]:
    url = GUTENDEX + "?" + urllib.parse.urlencode({"search": q})
    j = json.loads(_get(url, 2 * 1024 * 1024, timeout=6))
    out = []
    for b in j.get("results", [])[:12]:
        if not any(f.startswith("text/plain") for f in b.get("formats", {})):
            continue
        authors = b.get("authors") or []
        out.append({"id": b["id"], "title": b.get("title", ""),
                    "author": _display_name(authors[0].get("name", "")) if authors else ""})
    return out


class Catalog:
    """Project Gutenberg's own catalog (pg_catalog.csv, ~20 MB, updated daily),
    kept on the volume and refreshed weekly, searched in memory."""

    URL = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv"
    MAX_AGE = 7 * 86400

    def __init__(self):
        self.rows: list[tuple[int, str, str, str, str]] | None = None   # id, title, author, lang, haystack
        self.lock = threading.Lock()

    @property
    def path(self) -> Path:
        return DATA / "pg_catalog.csv"

    def refresh(self) -> None:
        """Download if missing or stale, then load. Safe to call from a thread."""
        try:
            if not self.path.exists() or time.time() - self.path.stat().st_mtime > self.MAX_AGE:
                self._download()
            with open(self.path, encoding="utf-8", errors="replace", newline="") as f:
                self.load(f)
        except Exception as e:                  # search falls back to Gutendex alone
            sys.stderr.write(f"catalog: {e}\n")

    def _download(self) -> None:
        # streamed to disk: the machine has 256 MB and the file is ~20 MB
        tmp = self.path.with_suffix(".tmp")
        req = urllib.request.Request(self.URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 16):
                f.write(chunk)
        tmp.replace(self.path)

    def load(self, lines) -> None:
        """`lines`: an open file or any iterable of CSV lines. Rows are kept as
        small tuples; the full catalog loads in well under 100 MB."""
        rows, reader = [], csv.reader(lines)
        head = next(reader, [])
        try:
            i_id, i_type, i_title, i_lang, i_auth = (head.index(c) for c in
                                                     ("Text#", "Type", "Title", "Language", "Authors"))
        except ValueError:
            raise ValueError("unexpected catalog columns")
        for r in reader:
            if len(r) <= max(i_id, i_type, i_title, i_lang, i_auth) or r[i_type] != "Text":
                continue
            try:
                bid = int(r[i_id])
            except ValueError:
                continue
            title = " ".join(r[i_title].split())
            first = r[i_auth].split(";")[0]
            author = _display_name(re.sub(r",\s*(?:\d|-|\?).*$|\s*\[.*?\]", "", first).strip())
            rows.append((bid, title, author, r[i_lang], sys.intern((title + " " + author).lower())))
        with self.lock:
            self.rows = rows

    def search(self, q: str, limit: int = 12) -> list[dict] | None:
        with self.lock:
            rows = self.rows
        if rows is None:
            return None
        words = re.findall(r"\w+", q.lower())
        if not words:
            return []
        ql = q.lower().strip()
        hits = [r for r in rows if all(w in r[4] for w in words)]
        # English first, then an exact title, then the lowest numbers: Gutenberg
        # catalogued the classics early, so Moby-Dick (#15) beats a directory (#62386)
        hits.sort(key=lambda r: ("en" not in r[3].split("; "), r[1].lower() != ql, r[0]))
        return [{"id": r[0], "title": r[1], "author": r[2]} for r in hits[:limit]]


CATALOG = Catalog()


def _display_name(name: str) -> str:
    """Gutendex lists "Melville, Herman"; people read "Herman Melville"."""
    last, sep, first = name.partition(", ")
    return f"{first} {last}" if sep and "," not in first else name


def load_book(book_id: int) -> dict:
    cache = DATA / "books" / f"{book_id}.json"
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    raw = _get(GUTENBERG_TXT.format(id=book_id), MAX_BOOK_BYTES).decode("utf-8", "replace")
    book = {"id": book_id, **strip_gutenberg(raw)}
    book["title"] = book["title"] or f"Gutenberg #{book_id}"
    cache.parent.mkdir(parents=True, exist_ok=True)
    tmp = cache.with_suffix(".tmp")
    tmp.write_text(json.dumps(book), encoding="utf-8")
    tmp.replace(cache)
    return book


# --------------------------------------------------------------- shares ---

class Invalid(ValueError):
    pass


EVENT_TYPES = {"editstart", "editend", "keydown", "keyup", "input", "save", "revert"}
# field -> (type, max length for strings)
EVENT_FIELDS = {
    "type": (str, 16), "section": (str, 16), "session": (str, 48), "key": (str, 32),
    "code": (str, 32), "inputType": (str, 48), "data": (str, 20_000),
    "text0": (str, 400_000), "text": (str, 400_000),
    "len": (int, None), "caret": (int, None), "t": (int, None), "pt": (int, None),
    "dt": (int, None), "v": (int, None), "ok": (bool, None),
}
SAFE_STR = re.compile(r"^[^<>&\"'`\\]{0,64}$")


def _num(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def clean_event(e) -> dict:
    if not isinstance(e, dict) or e.get("type") not in EVENT_TYPES:
        raise Invalid("bad event")
    out = {}
    for k, v in e.items():
        spec = EVENT_FIELDS.get(k)
        if spec is None or v is None:
            continue
        kind, limit = spec
        if kind is int:
            if not _num(v):
                raise Invalid(f"bad {k}")
            out[k] = int(v)
        elif kind is bool:
            out[k] = bool(v)
        else:
            if not isinstance(v, str) or len(v) > limit:
                raise Invalid(f"bad {k}")
            out[k] = v
    if not isinstance(out.get("t"), int):
        raise Invalid("event without a time")
    return out


def clean_music(m, depth: int = 0):
    """Settings are plain data: numbers, booleans, short strings with no markup,
    and nested objects of the same. The page re-checks them against its own
    defaults; this keeps anything else off the disk."""
    if depth > 4:
        raise Invalid("music too deep")
    if isinstance(m, bool) or _num(m):
        return m
    if isinstance(m, str):
        if not SAFE_STR.match(m):
            raise Invalid("bad setting")
        return m
    if isinstance(m, dict):
        if len(m) > 64:
            raise Invalid("too many settings")
        return {str(k)[:32]: clean_music(v, depth + 1) for k, v in m.items()
                if SAFE_STR.match(str(k)) and v is not None}
    raise Invalid("bad setting")


def clean_share(body) -> dict:
    if not isinstance(body, dict):
        raise Invalid("expected an object")
    events = body.get("events")
    if not isinstance(events, list) or not events or len(events) > MAX_EVENTS:
        raise Invalid("expected a list of events")
    src = body.get("source")
    source = None
    if isinstance(src, dict):
        source = {}
        if src.get("kind") in ("gutenberg", "paste"):
            source["kind"] = src["kind"]
        if isinstance(src.get("id"), int) and not isinstance(src.get("id"), bool):
            source["id"] = src["id"]
        for k in ("title", "author"):
            if isinstance(src.get(k), str):
                source[k] = src[k][:300]
    return {"v": 1, "events": [clean_event(e) for e in events],
            "music": clean_music(body["music"]) if isinstance(body.get("music"), dict) else None,
            "source": source, "created": int(time.time())}


def save_share(share: dict) -> str:
    d = DATA / "s"
    d.mkdir(parents=True, exist_ok=True)
    for _ in range(5):
        sid = "".join(secrets.choice(ALPHABET) for _ in range(10))
        p = d / f"{sid}.json"
        try:
            with open(p, "x", encoding="utf-8") as f:
                json.dump(share, f, separators=(",", ":"))
            return sid
        except FileExistsError:
            continue
    raise RuntimeError("could not allocate an id")


class RateLimit:
    def __init__(self, per_hour: int):
        self.per_hour, self.hits, self.lock = per_hour, {}, threading.Lock()

    def allow(self, who: str) -> bool:
        now = time.time()
        with self.lock:
            recent = [t for t in self.hits.get(who, []) if now - t < 3600]
            if len(recent) >= self.per_hour:
                self.hits[who] = recent
                return False
            recent.append(now)
            self.hits[who] = recent
            if len(self.hits) > 10_000:
                self.hits = {k: v for k, v in self.hits.items() if v and now - v[-1] < 3600}
            return True


SHARE_LIMIT = RateLimit(SHARES_PER_HOUR)


# --------------------------------------------------------------- server ---

class Handler(BaseHTTPRequestHandler):
    server_version = "palimpsest-studio"
    sys_version = ""

    def log_message(self, fmt, *args):      # one line per request, no query strings
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?")[0]))

    def _send(self, code: int, body: bytes, ctype: str, cache: str = "no-store"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, obj, cache: str = "no-store"):
        self._send(code, json.dumps(obj, separators=(",", ":")).encode(), "application/json", cache)

    def _client(self) -> str:
        return self.headers.get("Fly-Client-IP") or self.client_address[0]

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        if path == "/" or re.fullmatch(r"/s/[A-Za-z0-9]+", path):
            page = DIST / "index.html"
            if not page.exists():
                return self._send(500, b"page not built - run build.py", "text/plain")
            return self._send(200, page.read_bytes(), "text/html; charset=utf-8", "no-cache")
        if path == "/healthz":
            return self._send(200, b"ok", "text/plain")
        # the Writing Record asks for these when served over http; a studio has neither
        if path == "/sections.json":
            return self._json(200, {})
        if path == "/keystrokes/index.json":
            return self._json(200, {"sessions": []})
        if path == "/api/gutenberg/search":
            q = urllib.parse.parse_qs(url.query).get("q", [""])[0].strip()[:200]
            if not q:
                return self._json(400, {"error": "empty search"})
            try:
                return self._json(200, {"results": search_books(q)}, "public, max-age=3600")
            except Exception:
                return self._json(502, {"error": "Gutenberg search is not answering"})
        m = re.fullmatch(r"/api/gutenberg/text/(\d{1,7})", path)
        if m:
            try:
                return self._json(200, load_book(int(m.group(1))), "public, max-age=86400")
            except urllib.error.HTTPError as e:
                return self._json(404 if e.code == 404 else 502, {"error": "no plain-text edition"})
            except Exception:
                return self._json(502, {"error": "Gutenberg is not answering"})
        m = re.fullmatch(r"/api/s/([A-Za-z0-9]+)", path)
        if m:
            sid = m.group(1)
            p = DATA / "s" / f"{sid}.json"
            if not SHARE_ID.match(sid) or not p.exists():
                return self._json(404, {"error": "not found"})
            return self._send(200, p.read_bytes(), "application/json", "public, max-age=86400")
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if urllib.parse.urlsplit(self.path).path != "/api/s":
            return self._json(404, {"error": "not found"})
        origin = self.headers.get("Origin")
        if origin and urllib.parse.urlsplit(origin).netloc != self.headers.get("Host"):
            return self._json(403, {"error": "cross-site request"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = -1
        if n <= 0 or n > MAX_SHARE_BYTES:
            return self._json(413, {"error": "session too large to share"})
        if not SHARE_LIMIT.allow(self._client()):
            return self._json(429, {"error": "too many share links this hour"})
        try:
            share = clean_share(json.loads(self.rfile.read(n)))
        except (Invalid, ValueError) as e:
            return self._json(400, {"error": str(e) or "invalid session"})
        return self._json(201, {"id": save_share(share)})


def main() -> None:
    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8080"))
    DATA.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=CATALOG.refresh, daemon=True).start()
    srv = ThreadingHTTPServer((host, port), Handler)
    print(f"palimpsest-studio on http://{host}:{port}  (data: {DATA})", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
