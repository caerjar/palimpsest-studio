# Palimpsest Studio

Type a passage and hear the typing played back as a score.

1. **Source.** Find a book on Project Gutenberg (search, or paste a
   gutenberg.org link), paste a passage or your own draft, or open a `.txt`/`.md` file.
   It sits above the writing area as a reference.
2. **Write.** Recording starts with your first key. Press **Done** when you're finished.
3. **Playback.** The text retypes itself while the same session is drawn as
   notation and played by a synthesizer. Download the **WAV** or the session
   **JSONL**, or make a **share link**.

This is a public fork of the Writing Record from
[Palimpsest](https://github.com/caerjar/Palimpsest), the manuscript workbench.
The playback half of the page *is* Palimpsest's `writing-record.html`, pulled in
from the `vendor/palimpsest` submodule at build time. Fix the replay there, bump
the submodule, rebuild. A studio `.jsonl` opens in the full Palimpsest app.

## Privacy

Recording, playback and WAV rendering run in your browser. Nothing you type
reaches the server unless you press **Share link → Publish**. That stores what
you typed, its timing, and your sound settings, and anyone with the link can play it.

## Run it

```bash
git clone --recurse-submodules https://github.com/caerjar/palimpsest-studio
cd palimpsest-studio
python3 build.py            # -> dist/index.html
python3 server.py           # -> http://127.0.0.1:8080
```

Stdlib Python 3.11+, no dependencies. `python3 build.py --palimpsest ../palimpsest`
builds against a local Palimpsest checkout instead of the submodule.

| | |
|---|---|
| `build.py` | the Writing Record page + `studio/` panels → one self-contained `dist/index.html` |
| `studio/` | the source, write and share panels (`panels.html`, `studio.js`, `studio.css`) |
| `server.py` | serves the page; `/api/gutenberg/*` proxy; `/api/s` share links on disk |

## Tests

```bash
python3 -m unittest discover -s tests -v     # server
npm install && npx playwright install webkit
npx playwright test                          # clicks the page on iPhone + desktop WebKit
```

## Deploy (Fly.io)

```bash
fly deploy
```

`fly.toml` mounts a volume `studio_data` at `/data` for share links and cached
books. The machine stops when idle and starts on the next request. First time:

```bash
fly apps create palimpsest-studio
fly volumes create studio_data --region ewr --size 1
```

## iPhone sound

iOS mutes Web Audio when the ringer switch is on silent. The page asks for the
"playback" audio session (Safari 16.4+), or plays a silent `<audio>` loop on
older iOS, so it plays like a music app.

## Licence

MIT, as Palimpsest.
