# Movie Quote GIF Maker

A local web app: upload a clip, mark the part you want with the video player,
auto-caption it, tweak the text, and export a captioned GIF + MP4. Runs
entirely on your machine — nothing uploads anywhere else.

## Setup (one time)

```bash
# System dependency (you likely already have this)
sudo apt install ffmpeg

# Python dependencies
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

The first time you click "Auto-Caption," `openai-whisper` will download its
speech model (~500MB for the `small` model) — that only happens once.

## Running it

```bash
source venv/bin/activate   # if not already active
python app.py
```

Then open **http://127.0.0.1:5050** in a browser.

## Using it

1. **Get your video** — paste a YouTube URL and click Fetch, or switch to
   the Upload tab for a local file (a screen-recording, a DVD rip,
   whatever you've got). It can be a whole video, not just a pre-trimmed
   clip — you mark the part you want next. Already grabbed this video
   before? Click its thumbnail in the "Already downloaded" grid instead
   of re-downloading it.
2. **Pick the part you want** — drag the two handles on the timeline (or
   nudge them with the ±0.1s/±1s buttons, or click "Mark Start"/"Mark End"
   at the current playhead position) to set the range precisely. Click
   "Preview Selection" to loop just that range before committing, then
   "Cut Clip."
3. **Auto-Caption** — transcribes the clip's audio with timing already
   worked out.
4. **Check the captions** — fix any word Whisper misheard. Text only;
   timing is already correct.
5. **Make GIF** — name it, pick a caption size and color, done. You get a
   GIF and an MP4 — send the MP4 when the app supports it (smaller, better
   quality); GIF as the universal fallback.

## Notes

- Each session's files live in `sessions/<id>/` — safe to delete that
  folder periodically to reclaim disk space (or run the "Clean: clear
  session data" VS Code task).
- If transcription is slow on your machine, swap `"small"` for `"base"`
  in `app.py`'s `get_whisper_model()` — faster, slightly less accurate.
  For short movie-quote clips the accuracy hit is usually negligible.
- Caption styling (font, size, outline, position) is controlled in
  `write_ass()` in `app.py` if you want to go beyond the size slider —
  e.g. change the font, add a background box, move it to top-of-frame.
