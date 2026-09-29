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

1. **Get a video** — paste a YouTube link and press Fetch, click "Upload a
   file", or drop a video file onto the box. It can be a whole movie, not
   just a pre-trimmed clip. Downloads show live progress and resume where
   they stopped if interrupted. Anything you've fetched before is in the
   library below — click it to reuse it (fetching the same link again just
   reopens it). Hover a library card to rename or delete it.
2. **Pick the part you want** — drag the handles on the whole-video bar,
   then fine-tune on the zoomed bar that appears around your selection.
   You can also type times (`83.5` or `1:23.5`), nudge with the ±buttons,
   or use the keyboard: <kbd>Space</kbd> play/pause, <kbd>I</kbd>/<kbd>O</kbd>
   set start/end, <kbd>,</kbd>/<kbd>.</kbd> step a frame, <kbd>P</kbd> loop
   the selection, <kbd>Enter</kbd> cut & continue.
3. **Caption & export** — click Auto-caption (Whisper transcribes the
   clip), fix any misheard words, drag captions on the timeline to adjust
   timing, and style them (font, size, color, outline, top/bottom, ALL
   CAPS) with a live preview. Then Make GIF. You get a GIF and an MP4 —
   send the MP4 when the app supports it (smaller, better quality).

Your work is saved automatically: refresh the page, or come back to a video
from the library later, and your range, captions and style are still there.
Every GIF made from a video is listed under it.

## Notes

- Each video's files live in `sessions/<id>/` (the original download,
  a browser-friendly preview, the current clip, and your exports in
  `exports/`). Delete videos you don't need from the library in the app.
- The speech model can be picked next to the Auto-caption button: Tiny and
  Base are much faster, Medium is the most accurate. Each downloads once on
  first use.
- To try things out without touching your library, run with
  `DATA_DIR=/some/other/folder python app.py` (and `PORT=5051` to run it
  alongside your normal copy).
