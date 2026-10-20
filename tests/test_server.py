"""Server tests — stdlib unittest, no network (Gutenberg calls are stubbed).

    python3 -m unittest discover -s tests -v
"""
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
TMP = tempfile.mkdtemp(prefix="studio-test-")
os.environ["STUDIO_DATA"] = TMP
import server  # noqa: E402

EVENTS = [
    {"type": "editstart", "section": "1", "text0": "", "len": 0, "t": 1000, "session": "s1", "v": 1},
    {"type": "keydown", "section": "1", "key": "H", "code": "KeyH", "len": 0, "caret": 0, "t": 1100},
    {"type": "input", "section": "1", "inputType": "insertText", "data": "H", "len": 1, "caret": 1, "t": 1102},
]

PG = """﻿The Project Gutenberg eBook of Moby Dick
\r\nTitle: Moby Dick; Or,\r\n       The Whale\r\n\r\nAuthor: Herman Melville\r\n
*** START OF THE PROJECT GUTENBERG EBOOK MOBY DICK ***\r\nCall me Ishmael.\r\n
*** END OF THE PROJECT GUTENBERG EBOOK MOBY DICK ***\r\nlicence text
"""


class TestGutenberg(unittest.TestCase):
    def test_strips_header_and_footer(self):
        b = server.strip_gutenberg(PG)
        self.assertEqual(b["text"], "Call me Ishmael.")
        self.assertEqual(b["title"], "Moby Dick; Or, The Whale")
        self.assertEqual(b["author"], "Herman Melville")

    def test_unmarked_file_kept_whole(self):
        self.assertEqual(server.strip_gutenberg("just text")["text"], "just text")

    def test_display_name(self):
        self.assertEqual(server._display_name("Melville, Herman"), "Herman Melville")
        self.assertEqual(server._display_name("Homer"), "Homer")


CSV = '''Text#,Type,Issued,Title,Language,Authors,Subjects,LoCC,Bookshelves
15,Text,1991-06-01,"Moby-Dick; or,
The Whale",en,"Melville, Herman, 1819-1891",,,
2701,Text,2001-07-01,"Moby Dick; Or, The Whale",en,"Melville, Herman, 1819-1891",,,
9999,Sound,2001-07-01,Moby Dick audiobook,en,"Melville, Herman, 1819-1891",,,
5000,Text,2001-07-01,Moby Dick (traduit),fr,"Melville, Herman, 1819-1891",,,
11,Text,2008-06-27,Alice's Adventures in Wonderland,en,"Carroll, Lewis, 1832-1898 [Illustrator]",,,
'''


class TestCatalog(unittest.TestCase):
    def setUp(self):
        self.cat = server.Catalog()
        self.cat.load(io.StringIO(CSV))

    def test_search_matches_title_and_author_words(self):
        self.assertEqual([b["id"] for b in self.cat.search("moby melville")], [15, 2701, 5000])
        self.assertEqual(self.cat.search("alice")[0],
                         {"id": 11, "title": "Alice's Adventures in Wonderland", "author": "Lewis Carroll"})

    def test_titles_are_one_line_and_sound_is_skipped(self):
        self.assertEqual(self.cat.search("moby")[0]["title"], "Moby-Dick; or, The Whale")
        self.assertNotIn(9999, [b["id"] for b in self.cat.search("audiobook")])

    def test_falls_back_when_gutendex_is_slow(self):
        def slow(q):
            raise TimeoutError()
        orig, server._search_gutendex = server._search_gutendex, slow
        orig_cat, server.CATALOG = server.CATALOG, self.cat
        try:
            self.assertEqual(server.search_books("wonderland")[0]["id"], 11)
        finally:
            server._search_gutendex, server.CATALOG = orig, orig_cat


class TestCleanShare(unittest.TestCase):
    def test_keeps_known_fields(self):
        s = server.clean_share({"events": EVENTS, "music": {"scale": "pentatonic", "bpm": 96},
                                "source": {"kind": "gutenberg", "id": 2701, "title": "Moby"}})
        self.assertEqual(s["events"][2]["data"], "H")
        self.assertEqual(s["music"], {"scale": "pentatonic", "bpm": 96})
        self.assertEqual(s["source"], {"kind": "gutenberg", "id": 2701, "title": "Moby"})

    def test_drops_unknown_event_fields(self):
        s = server.clean_share({"events": [dict(EVENTS[1], onload="x")]})
        self.assertNotIn("onload", s["events"][0])

    def test_rejects_markup_in_settings(self):
        bad = {"events": EVENTS, "music": {"letterMap": {"a": {"deg": "<img src=x onerror=alert(1)>"}}}}
        with self.assertRaises(server.Invalid):
            server.clean_share(bad)

    def test_keeps_a_rolled_sound(self):
        music = {"sound": "music box", "roll": 3, "paragraphKey": 7, "deleteFall": True,
                 "swell": {"on": True, "ms": 2000, "gain": 0.2}, "fx": {"tone": 4200, "toneMove": 0.6}}
        self.assertEqual(server.clean_share({"events": EVENTS, "music": music})["music"], music)
        with self.assertRaises(server.Invalid):
            server.clean_share({"events": EVENTS, "music": {"sound": "rain's"}})

    def test_rejects_bad_types(self):
        for bad in ({}, {"events": []}, {"events": [{"type": "nope", "t": 1}]},
                    {"events": [dict(EVENTS[1], t="soon")]}, {"events": [dict(EVENTS[1], len=float("nan"))]}):
            with self.assertRaises(server.Invalid, msg=bad):
                server.clean_share(bad)

    def test_rate_limit(self):
        rl = server.RateLimit(2)
        self.assertEqual([rl.allow("a"), rl.allow("a"), rl.allow("a"), rl.allow("b")], [True, True, False, True])


class TestHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        dist = Path(TMP) / "dist"
        dist.mkdir(exist_ok=True)
        (dist / "index.html").write_text("<!doctype html><title>t</title>")
        server.DIST = dist
        server.load_book = lambda i: {"id": i, "title": "Stub", "author": "", "text": "x"}
        cls.srv = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_address[1]}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, path, body=None, headers=None):
        r = urllib.request.Request(self.base + path, data=body, headers=headers or {})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.headers, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.headers, e.read()

    def post(self, obj, **headers):
        return self.req("/api/s", json.dumps(obj).encode(), {"Content-Type": "application/json", **headers})

    def test_page_and_share_paths_serve_the_page(self):
        for p in ("/", "/s/abcdefghij"):
            code, h, _ = self.req(p)
            self.assertEqual(code, 200)
            self.assertIn("frame-ancestors 'none'", h["Content-Security-Policy"])

    def test_share_round_trip(self):
        code, _, body = self.post({"events": EVENTS, "music": {"bpm": 80}})
        self.assertEqual(code, 201)
        sid = json.loads(body)["id"]
        self.assertRegex(sid, r"^[A-Za-z0-9]{10}$")
        code, _, body = self.req("/api/s/" + sid)
        self.assertEqual(code, 200)
        got = json.loads(body)
        self.assertEqual(got["events"][2]["data"], "H")
        self.assertEqual(got["music"], {"bpm": 80})

    def test_unknown_share_is_404(self):
        self.assertEqual(self.req("/api/s/zzzzzzzzzz")[0], 404)
        self.assertEqual(self.req("/api/s/../../etc")[0], 404)

    def test_cross_site_post_refused(self):
        self.assertEqual(self.post({"events": EVENTS}, Origin="https://evil.example")[0], 403)

    def test_invalid_share_is_400(self):
        self.assertEqual(self.post({"events": "no"})[0], 400)

    def test_book_endpoint(self):
        code, _, body = self.req("/api/gutenberg/text/2701")
        self.assertEqual((code, json.loads(body)["title"]), (200, "Stub"))


if __name__ == "__main__":
    unittest.main()
