"""
Movie Quote GIF Maker — local web app.

Run it:
    pip install -r requirements.txt
    python app.py
    -> open http://127.0.0.1:5050 in your browser

Everything runs locally. Nothing leaves your machine.

Workflow:
    1. Upload a video (your screen-recording / DVD rip / whatever).
    2. Scrub the player, click "Mark Start" / "Mark End" to pick the clip.
    3. Click "Auto-Caption" — Whisper transcribes the clip with timestamps.
    4. Edit any misheard words in the caption boxes.
    5. Click "Make GIF" — get a GIF and an MP4, both captioned.
"""

import json
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_from_directory

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "sessions"
DATA_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4GB, movies are big

# Whisper model is loaded lazily (and only once) since it's slow to load.
_whisper_model = None


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        import whisper

        _whisper_model = whisper.load_model("small")
    return _whisper_model


DEFAULT_MAX_CAPTION_CHARS = 40


def split_segment(seg: dict, max_chars: int) -> list:
    """Break one Whisper segment into shorter caption chunks, at most
    max_chars long, splitting on word boundaries. Uses per-word timestamps
    when Whisper provides them so each chunk keeps accurate timing; falls
    back to interpolating time proportionally by character offset."""
    text = seg["text"].strip()
    if len(text) <= max_chars:
        return [{"start": round(seg["start"], 2), "end": round(seg["end"], 2), "text": text}]

    words = seg.get("words") or []
    if words:
        tokens = [(w["word"].strip(), w["start"], w["end"]) for w in words if w["word"].strip()]
    else:
        # No word-level timestamps available: fake them by spreading the
        # segment's duration evenly across characters.
        raw_words = text.split()
        total_chars = sum(len(w) for w in raw_words) or 1
        duration = seg["end"] - seg["start"]
        tokens = []
        pos = 0
        for w in raw_words:
            frac_start = pos / total_chars
            pos += len(w)
            frac_end = pos / total_chars
            tokens.append((w, seg["start"] + frac_start * duration, seg["start"] + frac_end * duration))

    chunks, cur, cur_len = [], [], 0
    for word, w_start, w_end in tokens:
        addition = len(word) + (1 if cur else 0)
        if cur and cur_len + addition > max_chars:
            chunks.append(cur)
            cur, cur_len = [], 0
            addition = len(word)
        cur.append((word, w_start, w_end))
        cur_len += addition
    if cur:
        chunks.append(cur)

    return [
        {
            "start": round(chunk[0][1], 2),
            "end": round(chunk[-1][2], 2),
            "text": " ".join(w for w, _, _ in chunk),
        }
        for chunk in chunks
    ]


def session_dir(sid: str) -> Path:
    d = DATA_DIR / sid
    d.mkdir(exist_ok=True, parents=True)
    return d


def run(cmd):
    """Run a subprocess, raise with stderr visible if it fails."""
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{result.stderr}")
    return result


def fmt_ass_time(t: float) -> str:
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def ass_color(hex_color: str) -> str:
    """Convert a '#rrggbb' hex color to ASS's &HAABBGGRR format (opaque)."""
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()


def write_ass(path: Path, captions: list, fontsize: int, color: str = "#ffffff"):
    primary_colour = ass_color(color)
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: 480
PlayResY: 270

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,DejaVu Sans,{fontsize},{primary_colour},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,2,20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for c in captions:
        text = str(c["text"]).replace("\n", "\\N")
        lines.append(
            f"Dialogue: 0,{fmt_ass_time(float(c['start']))},"
            f"{fmt_ass_time(float(c['end']))},Default,,0,0,0,,{text}\n"
        )
    path.write_text("".join(lines))


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/library")
def library():
    entries = []
    for d in DATA_DIR.iterdir():
        video = d / "source.mp4"
        if not d.is_dir() or not video.exists():
            continue

        title = d.name
        meta_path = d / "meta.json"
        if meta_path.exists():
            try:
                title = json.loads(meta_path.read_text()).get("title", title)
            except (OSError, ValueError):
                pass

        src_dir = d / "source"
        original = next(src_dir.iterdir(), None) if src_dir.exists() else None
        thumb = d / "thumb.jpg"

        entries.append({
            "session": d.name,
            "title": title,
            "video_url": f"/sessions/{d.name}/source.mp4",
            "download_url": f"/sessions/{d.name}/source/{original.name}" if original else None,
            "thumb_url": f"/sessions/{d.name}/thumb.jpg" if thumb.exists() else None,
            "mtime": video.stat().st_mtime,
        })

    entries.sort(key=lambda e: e["mtime"], reverse=True)
    for e in entries:
        del e["mtime"]
    return jsonify(sessions=entries)


def normalize_preview(src_path: Path, d: Path) -> Path:
    """Transcode whatever we got into a browser-friendly mp4 preview."""
    preview = d / "source.mp4"
    run(["ffmpeg", "-y", "-i", str(src_path), "-c:v", "libx264",
         "-c:a", "aac", "-movflags", "+faststart", str(preview)])
    return preview


def make_thumbnail(video_path: Path, d: Path):
    """Grab a frame for the library grid. Tries 1s in, falls back to the
    very first frame for clips shorter than that."""
    thumb = d / "thumb.jpg"
    for ts in ("00:00:01", "00:00:00"):
        result = subprocess.run(
            ["ffmpeg", "-y", "-ss", ts, "-i", str(video_path),
             "-frames:v", "1", "-vf", "scale=320:-1", str(thumb)],
            capture_output=True, text=True,
        )
        if result.returncode == 0 and thumb.exists():
            return


def make_waveform(clip: Path, d: Path) -> bool:
    """Render the clip's audio as a waveform strip for the caption timeline.
    Measures the peak level first and boosts it to 0dB so quiet dialogue
    still shows up. Returns False if the clip has no audio or ffmpeg fails."""
    probe = subprocess.run(
        ["ffmpeg", "-i", str(clip), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"max_volume: (-?[\d.]+) dB", probe.stderr)
    if probe.returncode != 0 or not m:
        return False
    gain = min(max(-float(m.group(1)), 0), 40)
    wave = d / "waveform.png"
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(clip), "-filter_complex",
         f"aformat=channel_layouts=mono,volume={gain}dB,"
         "showwavespic=s=1600x160:colors=0x7aa2ff:scale=sqrt:draw=full:filter=peak",
         "-frames:v", "1", str(wave)],
        capture_output=True, text=True,
    )
    return result.returncode == 0 and wave.exists()


def write_meta(d: Path, title: str, source_type: str):
    (d / "meta.json").write_text(json.dumps({
        "title": title, "source_type": source_type, "created": time.time(),
    }))


@app.route("/api/upload", methods=["POST"])
def upload():
    f = request.files.get("video")
    if not f:
        return jsonify(error="No file uploaded"), 400

    sid = uuid.uuid4().hex[:12]
    d = session_dir(sid)
    src_path = d / "source" / f.filename
    src_path.parent.mkdir(exist_ok=True)
    f.save(src_path)

    # Thumbnail + metadata first, from the raw upload — ffmpeg can grab a
    # frame from almost any container, so this doesn't need to wait on the
    # (possibly slow, for a big file) transcode below. That way the library
    # entry is complete even if something interrupts the transcode.
    make_thumbnail(src_path, d)
    write_meta(d, Path(f.filename).stem, "upload")

    # Normalize to mp4 so the browser can always preview it, regardless of
    # source container/codec (DVD rips especially can be finicky).
    normalize_preview(src_path, d)

    return jsonify(
        session=sid,
        title=Path(f.filename).stem,
        video_url=f"/sessions/{sid}/source.mp4",
        download_url=f"/sessions/{sid}/source/{src_path.name}",
    )


@app.route("/api/fetch-youtube", methods=["POST"])
def fetch_youtube():
    data = request.get_json()
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify(error="No URL given"), 400

    sid = uuid.uuid4().hex[:12]
    d = session_dir(sid)
    src_dir = d / "source"
    src_dir.mkdir(exist_ok=True)

    # Invoked as a module of the current interpreter (not the bare "yt-dlp"
    # command) so it always resolves to the venv's copy, even when the venv
    # isn't activated — YouTube breaks old yt-dlp releases often enough that
    # this matters.
    yt_dlp_cmd = [sys.executable, "-m", "yt_dlp", "--no-playlist"]

    # Title + YouTube's own thumbnail first — this is a quick metadata-only
    # call, so the library entry is complete before the much slower video
    # download/transcode below even starts. That way a big video that gets
    # interrupted partway through (server restart, closed laptop, whatever)
    # still leaves behind a session with a real title and thumbnail instead
    # of a blank one.
    meta_result = subprocess.run(
        # --print implies --simulate, which would otherwise silently skip
        # --write-thumbnail; --no-simulate overrides that back off.
        yt_dlp_cmd + ["--skip-download", "--no-simulate", "--write-thumbnail",
                      "--convert-thumbnails", "jpg",
                      "-o", str(d / "thumb.%(ext)s"),
                      "--print", "%(title)s", url],
        capture_output=True, text=True,
    )
    title = meta_result.stdout.strip().splitlines()[-1] if meta_result.stdout.strip() else "YouTube video"
    write_meta(d, title, "youtube")

    result = subprocess.run(
        yt_dlp_cmd + ["-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b",
                      "-o", str(src_dir / "download.%(ext)s"), url],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return jsonify(error="Couldn't download that video: " + result.stderr.strip().splitlines()[-1]), 400

    downloaded = next(src_dir.iterdir(), None)
    if not downloaded:
        return jsonify(error="Download finished but no file was found"), 400

    preview = normalize_preview(downloaded, d)
    if not (d / "thumb.jpg").exists():
        make_thumbnail(preview, d)  # fallback if YouTube didn't have one

    return jsonify(
        session=sid,
        title=title,
        video_url=f"/sessions/{sid}/source.mp4",
        download_url=f"/sessions/{sid}/source/{downloaded.name}",
    )


@app.route("/api/cut", methods=["POST"])
def cut():
    data = request.get_json()
    sid = data["session"]
    start, end = float(data["start"]), float(data["end"])
    if end <= start:
        return jsonify(error="End must be after start"), 400

    d = session_dir(sid)
    src = d / "source.mp4"
    clip = d / "clip.mp4"
    run(["ffmpeg", "-y", "-i", str(src), "-ss", str(start), "-to", str(end),
         "-c:v", "libx264", "-c:a", "aac", "-avoid_negative_ts", "make_zero",
         str(clip)])

    has_wave = make_waveform(clip, d)
    return jsonify(
        clip_url=f"/sessions/{sid}/clip.mp4",
        waveform_url=f"/sessions/{sid}/waveform.png" if has_wave else None,
    )


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    data = request.get_json()
    sid = data["session"]
    d = session_dir(sid)
    clip = d / "clip.mp4"
    audio = d / "clip.wav"

    run(["ffmpeg", "-y", "-i", str(clip), "-ar", "16000", "-ac", "1", str(audio)])

    try:
        max_chars = int(data.get("max_chars", DEFAULT_MAX_CAPTION_CHARS))
    except (TypeError, ValueError):
        max_chars = DEFAULT_MAX_CAPTION_CHARS
    max_chars = max(15, min(max_chars, 200))

    model = get_whisper_model()
    result = model.transcribe(str(audio), fp16=False, word_timestamps=True)
    segments = []
    words = []
    for seg in result["segments"]:
        segments.extend(split_segment(seg, max_chars))
        # Word boundaries are sent along so the caption timeline can snap to them.
        for w in seg.get("words") or []:
            if w["word"].strip():
                words.append({"start": round(w["start"], 2), "end": round(w["end"], 2)})
    # Whisper occasionally returns nothing for very short/quiet clips.
    if not segments:
        segments = [{"start": 0, "end": 3, "text": "(couldn't hear speech — type the quote here)"}]

    return jsonify(segments=segments, words=words)


@app.route("/api/export", methods=["POST"])
def export():
    data = request.get_json()
    sid = data["session"]
    captions = data["captions"]
    fontsize = int(data.get("fontsize", 32))
    color = data.get("color", "#ffffff")
    width = int(data.get("width", 480))
    name = "".join(c for c in data.get("name", "clip") if c.isalnum() or c in "-_") or "clip"

    d = session_dir(sid)
    clip = d / "clip.mp4"
    ass = d / "captions.ass"
    write_ass(ass, captions, fontsize, color)

    # Scale down at the burn-in step so both the MP4 and the GIF derived
    # from it come out smaller — otherwise the MP4 kept the source's full
    # resolution even though the GIF was already downscaled.
    burned = d / "burned.mp4"
    run(["ffmpeg", "-y", "-i", str(clip), "-vf",
         f"ass={ass},scale={width}:-2:flags=lanczos",
         "-c:v", "libx264", "-crf", "23", "-preset", "medium",
         "-c:a", "aac", "-b:a", "128k", str(burned)])

    out_mp4 = d / f"{name}.mp4"
    shutil.copy(burned, out_mp4)

    palette = d / "palette.png"
    run(["ffmpeg", "-y", "-i", str(burned),
         "-vf", "fps=15,palettegen", str(palette)])

    out_gif = d / f"{name}.gif"
    run(["ffmpeg", "-y", "-i", str(burned), "-i", str(palette),
         "-filter_complex",
         "fps=15[x];[x][1:v]paletteuse",
         str(out_gif)])

    return jsonify(
        gif_url=f"/sessions/{sid}/{name}.gif",
        mp4_url=f"/sessions/{sid}/{name}.mp4",
    )


@app.route("/sessions/<sid>/<path:filename>")
def serve_session_file(sid, filename):
    return send_from_directory(DATA_DIR / sid, filename)


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=5050)
