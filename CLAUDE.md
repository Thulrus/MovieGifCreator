# MovieGifCreator

A local Flask web app for turning video clips into captioned GIFs/MP4s. Workflow:
upload a video or fetch one from YouTube -> mark a start/end range -> auto-caption
the clip with Whisper -> edit captions -> export a burned-in GIF + MP4.

Run it: `venv/bin/python app.py`, then open http://127.0.0.1:5050.

## Key files

- `app.py` — the whole backend (Flask routes, ffmpeg/yt-dlp/whisper calls).
- `templates/index.html` — the single-page frontend.
- `sessions/<id>/` — per-session data (see below). Gitignored.

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
(e.g. point `DATA_DIR` at something under `/tmp` for the test run, or clean up
only the one specific test session folder you created) rather than wiping
`sessions/` wholesale.
