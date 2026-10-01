# MovieGifCreator

A web app for turning video clips into captioned GIFs/MP4s. Workflow:
choose a video (file, or YouTube link when running locally) -> mark a
start/end range -> auto-caption the clip with Whisper -> edit captions ->
export a burned-in GIF + MP4.

It runs two ways from the same front end (`web/`):

- **GitHub Pages / any static host:** everything runs in the browser
  (ffmpeg.wasm, Whisper via transformers.js, IndexedDB storage). No YouTube.
- **Locally:** `venv/bin/python app.py`, then open http://127.0.0.1:5050.
  The page detects the server (`api/config` returns `mode: "server"`) and
  sends the work to it (native ffmpeg, Whisper if installed, yt-dlp).
  `?engine=browser` forces the in-browser engine even with the server up.

## Key files

- `web/index.html`, `web/css/app.css`, `web/js/app.js` — the page. `app.js`
  talks only to a "backend" object with the same methods in both modes.
- `web/js/backend-server.js` — that backend over app.py's HTTP API.
- `web/js/backend-browser.js` — that backend done in-browser; uses
  `media.js` (ffmpeg.wasm wrapper), `speech.js` + `whisper-worker.js`
  (transformers.js Whisper), `store.js` (IndexedDB), `captions.js` (ASS
  writer and word grouping — mirrors `write_ass`/`split_segment` in app.py).
- `web/fonts/` — bundled caption fonts + `fonts.json` (used by both modes;
  app.py passes `fontsdir` to the ass filter).
- `web/vendor/` — vendored `@ffmpeg/ffmpeg` JS wrapper. The ffmpeg core and
  transformers.js load from jsDelivr (pinned versions in media.js /
  whisper-worker.js).
- `app.py` — the local server (Flask routes, ffmpeg/yt-dlp/whisper calls).
  openai-whisper is optional; without it the page captions in the browser.
- `.github/workflows/pages.yml` — deploys `web/` to Pages on push to main.
- `sessions/<id>/` — per-session data for the local server (see below).
  Gitignored. Key files: `meta.json` (title, YouTube url/id, preview mode),
  `source/` (original), `source.mp4` (browser preview), `clip.mp4` +
  `clip.json` (current cut and its range), `state.json` (autosaved UI state:
  range, captions, style, crop), `exports/` (finished GIF/MP4s; older sessions
  have them at the top level).

On the server, slow operations (fetch, preview transcode, cut, transcribe,
export) run as in-memory background jobs: the API returns a job id and the
page polls `/api/jobs/<id>`. Jobs don't survive a server restart. In the
browser, they run in the tab (ffmpeg.wasm does one command at a time).

## Testing

- Static/browser mode: `cd web && python3 -m http.server 8766`.
- Headless browser: Playwright works with the system Chrome
  (`chromium.launch({ executablePath: '/usr/bin/google-chrome' })`); its own
  bundled browsers aren't downloaded.

## Do not clear out `sessions/`

`sessions/<id>/` holds each session's source video, downloaded YouTube video,
thumbnail, clip, captions, and exports. **Previously downloaded YouTube clips
are an important, intentional part of using this app** — the library view
(`/api/library`) exists specifically so past sessions' videos can be reused
without re-downloading. Downloading is slow and sometimes YouTube videos become
unavailable later, so this data is not disposable.

Do not run `rm -rf sessions`, the "Clean: clear session data" VS Code task, or
otherwise delete session folders unless the user gives a specific reason to
(e.g. they explicitly ask to clear it, or a specific session is confirmed
corrupt/broken). This includes during manual testing/debugging — if you need a
throwaway session to test upload/fetch/export flows, use a separate directory
(e.g. `DATA_DIR=/tmp/... PORT=5051 venv/bin/python app.py` — both env vars
are supported — or clean up
only the one specific test session folder you created) rather than wiping
`sessions/` wholesale.
