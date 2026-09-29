# Movie Quote GIF Maker

Turn any moment from a video into a captioned GIF you can text to a friend.
Pick the part you want, let it write the captions for you, fix any words it
misheard, and download a GIF (plus a smaller MP4).

There are two ways to use it. They're the same app with the same page:

| | **Online** (GitHub Pages) | **On your own computer** |
| --- | --- | --- |
| Install | Nothing, just open the link | Python, ffmpeg, a few minutes |
| Video files | ✅ | ✅ |
| YouTube links | ❌ Browsers can't download from YouTube | ✅ Via yt-dlp |
| Where the work happens | In your browser tab | In the local server (faster) |
| Where your videos are kept | This browser's storage | The `sessions/` folder |

Either way, your videos stay on your computer. Nothing is uploaded anywhere.

## Use it online

Open **<https://thulrus.github.io/MovieGifCreator/>** in a recent desktop
browser (Chrome, Edge or Firefox work best).

The first time you make a GIF, your browser downloads the tools it needs: a
video engine (about 30 MB) and a speech model for auto-captions (41–250 MB,
depending on which one you pick). Both are cached, so later visits start
right away. Your video is read straight from your device and never copied.
Your clips, captions and GIFs are kept in the browser's storage on that
device. Download the GIFs you want to keep, because clearing the site's data
deletes them. To pick a new moment from a video on a later visit, you choose
the file again.

## Run it on your own computer (adds YouTube downloads)

You'll need Python 3.10+ and [ffmpeg](https://ffmpeg.org/download.html)
(`sudo apt install ffmpeg`, `brew install ffmpeg`, or `winget install ffmpeg`).

```bash
git clone https://github.com/Thulrus/MovieGifCreator.git
cd MovieGifCreator
python3 -m venv venv
venv/bin/pip install -r requirements.txt     # Windows: venv\Scripts\pip ...
venv/bin/python app.py
```

Then open **<http://127.0.0.1:5050>**. A YouTube box appears in step 1.

**Optional: faster, better auto-captions.** Out of the box, the local version
makes captions in the browser, the same way the online version does. To have
the server do it with OpenAI's Whisper instead (quicker, a bit more
accurate, and it can detect the language on its own), install it too:

```bash
venv/bin/pip install openai-whisper    # large: pulls in PyTorch (~2 GB)
```

Its first run downloads the speech model you pick (75 MB–1.5 GB).

**If YouTube downloads start failing** (HTTP 403 errors are common),
update yt-dlp. YouTube breaks older versions regularly:
`venv/bin/pip install --upgrade yt-dlp`.

## Using it

1. **Choose a video.** Drop in a video file, click *Choose a video file*, or,
   running locally, paste a YouTube link. It can be a whole movie. Videos
   you've used before are listed under *Your videos*; click one to pick up
   where you left off. Hover a card to rename or delete it.
2. **Pick the moment.** Play the video and press *Set start here* and
   *Set end here*, or drag the handles on the bar under the video. A zoomed
   bar appears for fine-tuning. You can also type times (`83.5` or `1:23.5`),
   nudge with the ± buttons, or use the keyboard: <kbd>Space</kbd>
   play/pause, <kbd>I</kbd>/<kbd>O</kbd> set start/end, <kbd>,</kbd>/<kbd>.</kbd>
   step a frame, <kbd>P</kbd> watch just the selection, <kbd>Enter</kbd>
   continue.
3. **Caption and make the GIF.** Press *Auto-caption*, fix any misheard
   words, and drag captions on the timeline to adjust their timing. Style
   them (font, size, color, outline, top/bottom, ALL CAPS) with a live
   preview, then press *Make GIF*. You get a GIF and an MP4. Send the MP4 when
   the app you're sending to supports it; it's smaller and sharper.

Your work saves automatically. Refresh the page or come back to a video
later, and your range, captions and style are still there.

## How it works

The whole front end is a static site in [`web/`](web/). When it starts, it
checks whether it was served by `app.py`:

- **No server** (GitHub Pages, or any static host): everything runs in the
  tab. Video is cut and encoded with [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm)
  (captions are burned in with libass, using the fonts in `web/fonts/`).
  Speech is transcribed by Whisper running on
  [transformers.js](https://github.com/huggingface/transformers.js) in a
  web worker. The library lives in IndexedDB. See
  [`web/js/backend-browser.js`](web/js/backend-browser.js).
- **Served by `app.py`**: the same page sends the work to the server, which
  uses the native ffmpeg, Whisper (if installed) and yt-dlp. See
  [`web/js/backend-server.js`](web/js/backend-server.js) and
  [`app.py`](app.py).

Add `?engine=browser` to the local URL to try the in-browser engine while
running the server.

## Notes for developers

- **Local data:** each video's files live in `sessions/<id>/`: the original
  download, a browser-friendly preview, the current clip, and exports in
  `exports/`. Delete videos you don't need from the list in the app.
- **Throwaway test runs:** `DATA_DIR=/some/other/folder PORT=5051 python app.py`
  keeps your real library untouched.
- **Testing the static site without the server:** `cd web && python3 -m http.server 8000`.
- **Publishing:** [`.github/workflows/pages.yml`](.github/workflows/pages.yml)
  deploys `web/` to GitHub Pages on every push to `main`. It needs
  *Settings → Pages → Source: GitHub Actions* to be set once.
- **Third-party code:** `web/vendor/` has the small JavaScript wrapper from
  `@ffmpeg/ffmpeg` 0.12.15 (MIT). The ffmpeg core (0.12.10) and
  transformers.js (3.7.6) load from the jsDelivr CDN, and speech models
  load from Hugging Face. Font licenses are in [`web/fonts/LICENSES.md`](web/fonts/LICENSES.md).
