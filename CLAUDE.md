# MovieGifCreator

A local Flask web app for turning video clips into captioned GIFs/MP4s. Workflow:
upload a video or fetch one from YouTube -> mark a start/end range -> auto-caption
the clip with Whisper -> edit captions -> export a burned-in GIF + MP4.

Run it: `venv/bin/python app.py`, then open http://127.0.0.1:5050.

## Key files

- `app.py` — the whole backend (Flask routes, ffmpeg/yt-dlp/whisper calls).
- `templates/index.html` — the single-page frontend.
- `sessions/<id>/` — per-session data (see below). Gitignored. Key files:
  `meta.json` (title, YouTube url/id, preview mode), `source/` (original),
  `source.mp4` (browser preview), `clip.mp4` + `clip.json` (current cut and
  its range), `state.json` (autosaved UI state: range, captions, style),
  `exports/` (finished GIF/MP4s; older sessions have them at the top level).

Slow operations (fetch, preview transcode, cut, transcribe, export) run as
in-memory background jobs: the API returns a job id and the page polls
`/api/jobs/<id>`. Jobs don't survive a server restart.

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
