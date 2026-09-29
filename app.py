"""
Movie Quote GIF Maker — local web app.

Run it:
    pip install -r requirements.txt
    python app.py
    -> open http://127.0.0.1:5050 in your browser

Everything runs locally. Nothing leaves your machine.

Workflow:
    1. Upload a video, fetch one from YouTube, or reopen one from the library.
    2. Mark the start/end of the part you want.
    3. Auto-caption it with Whisper, edit/style the captions, export a GIF + MP4.

Slow work (downloads, transcodes, cutting, transcription, export) runs as a
background job: the API call returns a job id straight away and the page
polls /api/jobs/<id> for progress, so a dropped request doesn't lose the work.

Set the DATA_DIR environment variable to keep session data somewhere other
than ./sessions (handy for a throwaway test run).
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path

from flask import Flask, abort, jsonify, render_template, request, send_from_directory
from werkzeug.exceptions import HTTPException
from werkzeug.utils import secure_filename

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR") or BASE_DIR / "sessions").resolve()
DATA_DIR.mkdir(exist_ok=True, parents=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024 * 1024 * 1024  # 4GB, movies are big

SID_RE = re.compile(r"^[0-9a-f]{12}$")
YOUTUBE_ID_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|embed/|live/)|youtu\.be/)([A-Za-z0-9_-]{11})")
HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
# Browsers can play these straight from an mp4 without re-encoding.
COPYABLE_VIDEO = {"h264"}
COPYABLE_AUDIO = {"aac"}
# Containers ffmpeg seeks accurately in, so cuts can come straight from the
# original file (skipping a generation of re-encoding) when the preview had
# to be transcoded.
SEEKABLE_EXTS = {".mp4", ".m4v", ".mov", ".mkv", ".webm"}

DEFAULT_MAX_CAPTION_CHARS = 40
WHISPER_MODELS = [
    ("tiny", "Tiny — fastest, least accurate", "75 MB"),
    ("base", "Base — fast", "145 MB"),
    ("small", "Small — balanced", "480 MB"),
    ("medium", "Medium — most accurate, slow", "1.5 GB"),
]
DEFAULT_WHISPER_MODEL = "small"
# (fontconfig family, label). Only the ones actually installed are offered.
FONT_CHOICES = [
    ("DejaVu Sans", "Classic"),
    ("League Gothic", "Meme (Impact-style)"),
    ("Liberation Sans", "Arial-style"),
    ("Open Sans", "Open Sans"),
    ("Ubuntu", "Ubuntu"),
]
DEFAULT_FONT = "DejaVu Sans"


# --- Background jobs ---------------------------------------------------------

class Job:
    def __init__(self, kind: str, sid: str | None):
        self.id = uuid.uuid4().hex[:16]
        self.kind = kind
        self.sid = sid
        self.status = "running"
        self.progress = None  # 0..1, or None when there's no way to tell
        self.message = ""
        self.result = None
        self.error = None

    def update(self, progress=None, message=None):
        if progress is not None:
            self.progress = max(0.0, min(1.0, progress))
        if message is not None:
            self.message = message

    def to_dict(self):
        return {
            "id": self.id, "kind": self.kind, "session": self.sid,
            "status": self.status, "progress": self.progress,
            "message": self.message, "result": self.result, "error": self.error,
        }


jobs: dict[str, Job] = {}
jobs_lock = threading.Lock()
# Jobs that create a session's source video; the library shows these as "working".
SOURCE_JOB_KINDS = {"fetch", "prepare"}


def start_job(kind: str, sid: str | None, fn, *args) -> Job:
    job = Job(kind, sid)
    with jobs_lock:
        jobs[job.id] = job

    def runner():
        try:
            job.result = fn(job, *args)
            job.progress = 1.0
            job.status = "done"
        except Exception as e:  # noqa: BLE001 — surface anything to the page
            traceback.print_exc()
            job.error = str(e) or e.__class__.__name__
            job.status = "error"

    threading.Thread(target=runner, daemon=True).start()
    return job


def running_job(sid: str, kinds=None) -> Job | None:
    with jobs_lock:
        for job in jobs.values():
            if job.sid == sid and job.status == "running" and (kinds is None or job.kind in kinds):
                return job
    return None


# --- Subprocess helpers ------------------------------------------------------

def tail(text: str, n: int = 6) -> str:
    lines = [l for l in text.strip().splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def run(cmd, **kwargs):
    """Run a subprocess, raise with the end of stderr visible if it fails."""
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        raise RuntimeError(f"{Path(cmd[0]).name} failed:\n{tail(result.stderr)}")
    return result


def ffmpeg(args, job: Job | None = None, duration: float | None = None,
           span=(0.0, 1.0), cwd=None):
    """Run ffmpeg, feeding its progress into `job` (scaled into `span`)."""
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-progress", "pipe:1", *map(str, args)]
    # stderr goes to a temp file rather than a pipe so a chatty ffmpeg can't
    # fill the pipe and deadlock while we're reading progress from stdout.
    with tempfile.TemporaryFile(mode="w+") as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True, cwd=cwd)
        for line in proc.stdout:
            if job and duration and line.startswith("out_time_us="):
                value = line.split("=", 1)[1].strip()
                if value.lstrip("-").isdigit():
                    frac = min(1.0, max(0.0, int(value) / 1e6 / duration))
                    job.update(progress=span[0] + (span[1] - span[0]) * frac)
        proc.wait()
        if proc.returncode != 0:
            err.seek(0)
            raise RuntimeError("ffmpeg failed:\n" + tail(err.read()))


def probe(path: Path) -> dict:
    result = run(["ffprobe", "-v", "error", "-print_format", "json",
                  "-show_streams", "-show_format", str(path)])
    return json.loads(result.stdout)


def media_duration(info: dict) -> float:
    try:
        return float(info["format"]["duration"])
    except (KeyError, TypeError, ValueError):
        return 0.0


def first_stream(info: dict, kind: str) -> dict | None:
    return next((s for s in info.get("streams", []) if s.get("codec_type") == kind
                 and not s.get("disposition", {}).get("attached_pic")), None)


def stream_fps(stream: dict | None) -> float | None:
    try:
        num, den = (stream or {}).get("avg_frame_rate", "0/0").split("/")
        fps = float(num) / float(den)
        return round(fps, 3) if 1 <= fps <= 240 else None
    except (ValueError, ZeroDivisionError):
        return None


# --- Fonts & whisper ---------------------------------------------------------

def font_em_factor(font_file: str) -> float | None:
    """libass sizes a font so that usWinAscent + usWinDescent (from the OS/2
    table) equals the requested size. Browsers size by the em square instead,
    so the preview needs this ratio to match the burned-in captions."""
    try:
        data = Path(font_file).read_bytes()
        num_tables = struct.unpack(">H", data[4:6])[0]
        tables = {}
        for i in range(num_tables):
            rec = data[12 + 16 * i: 28 + 16 * i]
            tables[rec[:4]] = struct.unpack(">I", rec[8:12])[0]
        upem = struct.unpack(">H", data[tables[b"head"] + 18: tables[b"head"] + 20])[0]
        os2 = tables[b"OS/2"]
        asc, desc = struct.unpack(">HH", data[os2 + 74: os2 + 78])
        return round((asc + desc) / upem, 4) if upem and asc + desc else None
    except (OSError, KeyError, struct.error, IndexError):
        return None


_fonts_cache = None


def available_fonts() -> list:
    global _fonts_cache
    if _fonts_cache is None:
        fonts = []
        for family, label in FONT_CHOICES:
            # fc-list rather than fc-match: fc-list only returns exact family
            # matches, so an uninstalled font shows up as no output at all.
            try:
                r = subprocess.run(["fc-list", family, "file", "style"], capture_output=True, text=True)
            except OSError:
                break
            candidates = []
            for line in r.stdout.splitlines():
                file, _, style = line.partition(": :style=")
                style = style.lower()
                # Prefer an upright bold face, since captions are bold.
                score = (("bold" in style and "semibold" not in style and "extrabold" not in style) * 4
                         - any(w in style for w in ("italic", "oblique")) * 8
                         - ("condensed" in style) * 2)
                candidates.append((score, file.strip()))
            if not candidates:
                continue  # not installed
            file = max(candidates)[1]
            fonts.append({"family": family, "label": label, "em": font_em_factor(file) or 1.164})
        _fonts_cache = fonts or [{"family": DEFAULT_FONT, "label": "Classic", "em": 1.164}]
    return _fonts_cache


def whisper_cache_dir() -> Path:
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "whisper"


_whisper_models = {}
_whisper_lock = threading.Lock()


def get_whisper_model(name: str):
    if name not in _whisper_models:
        import whisper

        _whisper_models[name] = whisper.load_model(name)
    return _whisper_models[name]


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


# --- Captions ----------------------------------------------------------------

def fmt_ass_time(t: float) -> str:
    t = max(0.0, t)
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def ass_color(hex_color: str) -> str:
    """Convert a '#rrggbb' hex color to ASS's &HAABBGGRR format (opaque)."""
    h = hex_color.lstrip("#")
    r, g, b = h[0:2], h[2:4], h[4:6]
    return f"&H00{b}{g}{r}".upper()


def write_ass(path: Path, captions: list, style: dict):
    # ScaledBorderAndShadow makes the outline scale with the video like the
    # text does, instead of being N real pixels at the source resolution
    # (which made outlines on HD sources nearly vanish once scaled down).
    alignment = 8 if style["position"] == "top" else 2
    outline = style["outline"]
    shadow = 1 if outline else 0
    header = f"""[Script Info]
ScriptType: v4.00+
ScaledBorderAndShadow: yes
PlayResX: 480
PlayResY: 270

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{style["font"]},{style["fontsize"]},{ass_color(style["color"])},&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,{outline},{shadow},{alignment},20,20,20,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for c in captions:
        text = str(c["text"])
        if style["uppercase"]:
            text = text.upper()
        # Braces would otherwise start an ASS override block and vanish.
        text = text.replace("{", "\\{").replace("}", "\\}").replace("\n", "\\N")
        lines.append(
            f"Dialogue: 0,{fmt_ass_time(float(c['start']))},"
            f"{fmt_ass_time(float(c['end']))},Default,,0,0,0,,{text}\n"
        )
    path.write_text("".join(lines))


# --- Sessions ----------------------------------------------------------------

def get_session(sid: str, must_exist: bool = True) -> Path:
    if not isinstance(sid, str) or not SID_RE.match(sid):
        abort(400, "Bad session id")
    d = DATA_DIR / sid
    if must_exist and not d.is_dir():
        abort(404, "That session doesn't exist any more")
    return d


def new_session() -> tuple[str, Path]:
    sid = uuid.uuid4().hex[:12]
    d = DATA_DIR / sid
    (d / "source").mkdir(parents=True)
    return sid, d


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {} if default is None else default


def write_json(path: Path, data):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def read_meta(d: Path) -> dict:
    return read_json(d / "meta.json")


def update_meta(d: Path, **fields):
    meta = read_meta(d)
    meta.update(fields)
    write_json(d / "meta.json", meta)
    return meta


def original_source(d: Path, meta: dict) -> Path | None:
    """The complete original video, if there is one. For YouTube downloads
    that means yt-dlp's final merged file, not its .part / per-format pieces."""
    src_dir = d / "source"
    if not src_dir.is_dir():
        return None
    files = [f for f in src_dir.iterdir() if f.is_file()]
    if meta.get("source_type") == "youtube":
        files = [f for f in files if re.fullmatch(r"download\.[A-Za-z0-9]+", f.name)]
    return max(files, key=lambda f: f.stat().st_size, default=None)


def list_exports(d: Path) -> list:
    # New exports live in exports/; older versions of the app wrote them
    # straight into the session folder.
    out = []
    for folder, prefix in ((d / "exports", "exports/"), (d, "")):
        if not folder.is_dir():
            continue
        for gif in folder.glob("*.gif"):
            mp4 = gif.with_suffix(".mp4")
            # ?v= so a re-export under the same name doesn't show a cached copy.
            v = int(gif.stat().st_mtime)
            out.append({
                "name": gif.stem,
                "gif_url": f"/sessions/{d.name}/{prefix}{gif.name}?v={v}",
                "gif_size": gif.stat().st_size,
                "mp4_url": f"/sessions/{d.name}/{prefix}{mp4.name}?v={v}" if mp4.exists() else None,
                "mp4_size": mp4.stat().st_size if mp4.exists() else None,
                "mtime": gif.stat().st_mtime,
            })
    out.sort(key=lambda e: e["mtime"], reverse=True)
    return out


def session_duration(d: Path, meta: dict) -> float | None:
    """Duration of the preview video, probed once and cached in meta.json."""
    if meta.get("duration"):
        return meta["duration"]
    preview = d / "source.mp4"
    if not preview.exists():
        return None
    try:
        info = probe(preview)
    except RuntimeError:
        return None
    dur = media_duration(info)
    update_meta(d, duration=dur, fps=stream_fps(first_stream(info, "video")))
    meta["duration"] = dur
    return dur


def session_summary(d: Path) -> dict:
    meta = read_meta(d)
    sid = d.name
    ready = (d / "source.mp4").exists()
    job = running_job(sid, SOURCE_JOB_KINDS)
    if job:
        status = "working"
    elif ready:
        status = "ready"
    else:
        status = "incomplete"
    original = original_source(d, meta)
    # How an incomplete session could be finished off: re-run the preview
    # step if the original is all there, otherwise resume the download.
    resume = None
    if status == "incomplete":
        if original:
            resume = "prepare"
        elif meta.get("source_type") == "youtube":
            resume = "download" if meta.get("url") else "needs_url"
    has_thumb = (d / "thumb.jpg").exists()
    return {
        "session": sid,
        "title": meta.get("title") or sid,
        "source_type": meta.get("source_type"),
        "url": meta.get("url"),
        "status": status,
        "resume": resume,
        "job": job.to_dict() if job else None,
        "duration": session_duration(d, meta) if ready else None,
        "fps": meta.get("fps"),
        "created": meta.get("created") or d.stat().st_mtime,
        "video_url": f"/sessions/{sid}/source.mp4" if ready else None,
        "download_url": (f"/sessions/{sid}/source/{original.name}"
                         if original and ready else None),
        "thumb_url": (f"/sessions/{sid}/thumb.jpg?v={int((d / 'thumb.jpg').stat().st_mtime)}"
                      if has_thumb else None),
        "export_count": len(list_exports(d)),
    }


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
    probe_run = subprocess.run(
        ["ffmpeg", "-i", str(clip), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True,
    )
    m = re.search(r"max_volume: (-?[\d.]+) dB", probe_run.stderr)
    if probe_run.returncode != 0 or not m:
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


def prepare_preview(job: Job, d: Path, src: Path, span=(0.0, 1.0)):
    """Make source.mp4, the browser-playable copy of the video. If the source
    is already H.264/AAC it's just remuxed (near-instant, lossless); otherwise
    it's transcoded. Written under a temp name so an interrupted run never
    leaves a half-written source.mp4 that looks finished."""
    job.update(progress=span[0], message="Checking the video…")
    info = probe(src)
    video, audio = first_stream(info, "video"), first_stream(info, "audio")
    if not video:
        raise RuntimeError("That file doesn't have a video track.")
    duration = media_duration(info)

    copy_video = (video.get("codec_name") in COPYABLE_VIDEO
                  and video.get("pix_fmt") in ("yuv420p", "yuvj420p"))
    copy_audio = audio is None or audio.get("codec_name") in COPYABLE_AUDIO
    tmp = d / "source.tmp.mp4"
    maps = ["-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]
    encode_v = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]
    audio_args = ["-c:a", "copy"] if copy_audio else ["-c:a", "aac", "-b:a", "160k"]

    mode = "encoded"
    if copy_video:
        job.update(message="Preparing preview (no re-encode needed)…")
        try:
            ffmpeg(["-i", src, *maps, "-c:v", "copy", *audio_args, "-movflags", "+faststart", tmp],
                   job, duration, span)
            mode = "copy"
        except RuntimeError:
            pass  # odd stream that won't remux cleanly; fall back to transcoding
    if mode != "copy":
        job.update(message="Converting to a browser-friendly format…")
        ffmpeg(["-i", src, *maps, *encode_v, *audio_args, "-movflags", "+faststart", tmp],
               job, duration, span)
    tmp.replace(d / "source.mp4")
    update_meta(d, preview_mode=mode, duration=duration, fps=stream_fps(video))
    if not (d / "thumb.jpg").exists():
        make_thumbnail(d / "source.mp4", d)


def prepare_job(job: Job, d: Path, src: Path):
    prepare_preview(job, d, src)
    return {"session": d.name}


# --- Page + config -----------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.errorhandler(Exception)
def handle_error(e):
    """API errors come back as JSON so the page can show the real reason."""
    if not request.path.startswith("/api/"):
        return e if isinstance(e, HTTPException) else ("Internal error", 500)
    if isinstance(e, HTTPException):
        return jsonify(error=e.description), e.code
    traceback.print_exc()
    return jsonify(error=str(e) or e.__class__.__name__), 500


@app.route("/api/config")
def config():
    cache = whisper_cache_dir()
    return jsonify(
        fonts=available_fonts(),
        default_font=DEFAULT_FONT,
        models=[{"name": n, "label": label, "size": size,
                 "downloaded": (cache / f"{n}.pt").exists()}
                for n, label, size in WHISPER_MODELS],
        default_model=DEFAULT_WHISPER_MODEL,
    )


@app.route("/api/jobs/<job_id>")
def job_status(job_id):
    job = jobs.get(job_id)
    if not job:
        abort(404, "That job isn't running any more (did the server restart?)")
    return jsonify(job.to_dict())


# --- Library -----------------------------------------------------------------

@app.route("/api/library")
def library():
    entries = [session_summary(d) for d in DATA_DIR.iterdir()
               if d.is_dir() and SID_RE.match(d.name)]
    entries.sort(key=lambda e: e["created"], reverse=True)
    return jsonify(sessions=entries)


@app.route("/api/sessions/<sid>")
def get_session_info(sid):
    d = get_session(sid)
    info = session_summary(d)
    # Clips cut by older versions of the app have no clip.json (so no known
    # range); those sessions just open at the range-picking step.
    clip = read_json(d / "clip.json") if (d / "clip.mp4").exists() else None
    if not (clip and "start" in clip and "end" in clip):
        clip = None
    info.update(
        state=read_json(d / "state.json"),
        clip=clip,
        clip_url=f"/sessions/{sid}/clip.mp4?v={int((d / 'clip.mp4').stat().st_mtime)}" if clip else None,
        waveform_url=(f"/sessions/{sid}/waveform.png?v={int((d / 'waveform.png').stat().st_mtime)}"
                      if clip and (d / "waveform.png").exists() else None),
        exports=list_exports(d),
    )
    return jsonify(info)


@app.route("/api/sessions/<sid>/state", methods=["PUT", "POST"])
def save_state(sid):
    # POST too, so the page can flush with navigator.sendBeacon on unload.
    d = get_session(sid)
    data = request.get_json(force=True, silent=True)
    if not isinstance(data, dict):
        abort(400, "State must be a JSON object")
    write_json(d / "state.json", data)
    return jsonify(ok=True)


@app.route("/api/sessions/<sid>", methods=["PATCH"])
def rename_session(sid):
    d = get_session(sid)
    title = str((request.get_json() or {}).get("title") or "").strip()[:200]
    if not title:
        abort(400, "Title can't be empty")
    update_meta(d, title=title)
    return jsonify(session_summary(d))


@app.route("/api/sessions/<sid>", methods=["DELETE"])
def delete_session(sid):
    d = get_session(sid)
    if running_job(sid):
        abort(409, "That video is still being processed — wait for it to finish first.")
    shutil.rmtree(d)
    return jsonify(ok=True)


# --- Getting a video ---------------------------------------------------------

@app.route("/api/upload", methods=["POST"])
def upload():
    f = request.files.get("video")
    if not f or not f.filename:
        abort(400, "No file uploaded")

    sid, d = new_session()
    name = secure_filename(f.filename) or "upload" + Path(f.filename).suffix
    src_path = d / "source" / name
    f.save(src_path)

    # Thumbnail + metadata first, from the raw upload — ffmpeg can grab a
    # frame from almost any container, so this doesn't need to wait on the
    # (possibly slow, for a big file) preview step. That way the library
    # entry is complete even if something interrupts it.
    make_thumbnail(src_path, d)
    update_meta(d, title=Path(f.filename).stem, source_type="upload", created=time.time())

    job = start_job("prepare", sid, prepare_job, d, src_path)
    return jsonify(session=sid, job=job.id)


def find_youtube_session(video_id: str | None, url: str) -> Path | None:
    for d in DATA_DIR.iterdir():
        if not (d.is_dir() and SID_RE.match(d.name)):
            continue
        meta = read_meta(d)
        if meta.get("source_type") != "youtube":
            continue
        if (video_id and meta.get("video_id") == video_id) or meta.get("url") == url:
            return d
    return None


def yt_dlp_cmd():
    # Invoked as a module of the current interpreter (not the bare "yt-dlp"
    # command) so it always resolves to the venv's copy, even when the venv
    # isn't activated — YouTube breaks old yt-dlp releases often enough that
    # this matters.
    return [sys.executable, "-m", "yt_dlp", "--no-playlist"]


# Prefer H.264 (avc1): browsers play it straight from the download, so the
# preview is a quick remux instead of a full re-encode. YouTube increasingly
# serves AV1 as its "best" mp4, which would need transcoding every time.
YT_FORMAT = "bv*[vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b"


def youtube_job(job: Job, url: str, sid: str | None):
    """Download a YouTube video into session `sid` (a new one if None) and
    prepare its preview. Downloads resume from yt-dlp's .part files, so an
    interrupted fetch picks up where it stopped."""
    job.update(message="Looking up the video…")
    meta_run = subprocess.run(
        yt_dlp_cmd() + ["--skip-download", "-f", YT_FORMAT, "--print",
                        "%(id)s\t%(format_id)s\t%(thumbnail)s\t%(title)s", url],
        capture_output=True, text=True,
    )
    video_id = title = thumb_url = None
    n_parts = 1
    if meta_run.returncode == 0 and meta_run.stdout.strip():
        parts = meta_run.stdout.strip().splitlines()[-1].split("\t", 3)
        if len(parts) == 4:
            video_id, format_id, thumb_url, title = parts
            n_parts = format_id.count("+") + 1
            thumb_url = None if thumb_url == "NA" else thumb_url
    elif sid is None:
        raise RuntimeError("Couldn't find that video: " + (tail(meta_run.stderr, 2) or "unknown error"))

    if sid is None:
        existing = find_youtube_session(video_id, url)
        if existing and (existing / "source.mp4").exists():
            return {"session": existing.name, "existing": True}
        if existing and not running_job(existing.name, SOURCE_JOB_KINDS):
            sid, d = existing.name, existing  # resume the earlier, unfinished download
        else:
            sid, d = new_session()
        job.sid = sid
    else:
        d = get_session(sid)

    meta = read_meta(d)
    update_meta(d, source_type="youtube", url=url,
                video_id=video_id or meta.get("video_id"),
                title=title or meta.get("title") or "YouTube video",
                created=meta.get("created") or time.time())

    if thumb_url and not (d / "thumb.jpg").exists():
        subprocess.run(["ffmpeg", "-y", "-i", thumb_url, "-frames:v", "1",
                        "-vf", "scale=480:-2", str(d / "thumb.jpg")],
                       capture_output=True, text=True)

    src_dir = d / "source"
    src_dir.mkdir(exist_ok=True)
    if not original_source(d, read_meta(d)):
        job.update(progress=0, message="Downloading…")
        proc = subprocess.Popen(
            yt_dlp_cmd() + ["-f", YT_FORMAT,
                            "--newline", "--progress-template",
                            "download:PROGRESS %(progress._percent_str)s",
                            "-o", str(src_dir / "download.%(ext)s"), url],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        # Video and audio usually download separately, so count the parts to
        # keep the bar moving forward rather than jumping back to 0.
        part, output = 0, []
        for line in proc.stdout:
            output.append(line)
            if line.startswith("[download] Destination:") or "has already been downloaded" in line:
                part = min(part + 1, n_parts)
            m = re.search(r"PROGRESS\s+([\d.]+)%", line)
            if m:
                pct = float(m.group(1)) / 100
                what = ("video", "audio")[part - 1] if n_parts == 2 and part else "video"
                overall = (max(part, 1) - 1 + pct) / n_parts
                job.update(progress=overall * 0.8, message=f"Downloading {what}… {pct:.0%}")
            elif "[Merger]" in line:
                job.update(progress=0.8, message="Merging video and audio…")
        proc.wait()
        if proc.returncode != 0:
            errors = [l for l in output if "ERROR" in l] or output
            raise RuntimeError("Couldn't download that video: " + tail("".join(errors), 2))

    src = original_source(d, read_meta(d))
    if not src:
        raise RuntimeError("Download finished but no video file was found")
    prepare_preview(job, d, src, span=(0.8, 1.0))
    return {"session": sid}


@app.route("/api/fetch-youtube", methods=["POST"])
def fetch_youtube():
    url = str((request.get_json() or {}).get("url") or "").strip()
    if not url:
        abort(400, "No URL given")

    # Quick check before touching the network: already have this video?
    m = YOUTUBE_ID_RE.search(url)
    existing = find_youtube_session(m.group(1) if m else None, url)
    if existing:
        job = running_job(existing.name, SOURCE_JOB_KINDS)
        if job:
            return jsonify(session=existing.name, job=job.id)
        if (existing / "source.mp4").exists():
            return jsonify(session=existing.name, existing=True)
        job = start_job("fetch", existing.name, youtube_job, url, existing.name)
        return jsonify(session=existing.name, job=job.id, resumed=True)

    job = start_job("fetch", None, youtube_job, url, None)
    return jsonify(job=job.id)


@app.route("/api/sessions/<sid>/resume", methods=["POST"])
def resume_session(sid):
    """Finish off a session whose download or preview step got interrupted."""
    d = get_session(sid)
    job = running_job(sid, SOURCE_JOB_KINDS)
    if job:
        return jsonify(session=sid, job=job.id)
    info = session_summary(d)
    if info["status"] == "ready":
        return jsonify(session=sid, existing=True)
    if info["resume"] == "prepare":
        src = original_source(d, read_meta(d))
        job = start_job("prepare", sid, prepare_job, d, src)
        return jsonify(session=sid, job=job.id)
    url = str((request.get_json(silent=True) or {}).get("url") or read_meta(d).get("url") or "").strip()
    if info["source_type"] != "youtube":
        abort(400, "This session can't be resumed — the original file is missing.")
    if not url:
        abort(400, "Paste the YouTube link this came from to resume the download.")
    job = start_job("fetch", sid, youtube_job, url, sid)
    return jsonify(session=sid, job=job.id)


# --- Cut, caption, export ----------------------------------------------------

def cut_job(job: Job, d: Path, start: float, end: float):
    meta = read_meta(d)
    src = d / "source.mp4"
    original = original_source(d, meta)
    # If the preview was transcoded, cut from the original instead so the
    # clip doesn't lose quality twice. (A remuxed preview is identical.)
    if (meta.get("preview_mode") == "encoded" and original
            and original.suffix.lower() in SEEKABLE_EXTS):
        src = original

    job.update(progress=0, message="Cutting clip…")
    tmp = d / "clip.tmp.mp4"
    # -ss before -i seeks straight to the start instead of decoding the whole
    # video up to it; since we re-encode, the cut is still frame-accurate.
    ffmpeg(["-ss", f"{start:.3f}", "-i", src, "-t", f"{end - start:.3f}",
            "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-avoid_negative_ts", "make_zero", tmp],
           job, end - start, (0, 0.85))
    tmp.replace(d / "clip.mp4")
    write_json(d / "clip.json", {"start": start, "end": end})

    job.update(progress=0.9, message="Drawing waveform…")
    (d / "waveform.png").unlink(missing_ok=True)
    has_wave = make_waveform(d / "clip.mp4", d)
    bust = int(time.time() * 1000)
    return {
        "clip": {"start": start, "end": end},
        "clip_url": f"/sessions/{d.name}/clip.mp4?v={bust}",
        "waveform_url": f"/sessions/{d.name}/waveform.png?v={bust}" if has_wave else None,
    }


@app.route("/api/cut", methods=["POST"])
def cut():
    data = request.get_json() or {}
    d = get_session(data.get("session"))
    try:
        start, end = float(data["start"]), float(data["end"])
    except (KeyError, TypeError, ValueError):
        abort(400, "Missing start/end")
    if end <= start or start < 0:
        abort(400, "End must be after start")
    if not (d / "source.mp4").exists():
        abort(400, "This video isn't ready yet")
    job = start_job("cut", d.name, cut_job, d, start, end)
    return jsonify(job=job.id)


def transcribe_job(job: Job, d: Path, max_chars: int, model_name: str):
    clip = d / "clip.mp4"
    audio = d / "clip.wav"
    job.update(message="Extracting audio…")
    run(["ffmpeg", "-y", "-i", str(clip), "-ar", "16000", "-ac", "1", str(audio)])

    with _whisper_lock:
        if model_name not in _whisper_models:
            downloaded = (whisper_cache_dir() / f"{model_name}.pt").exists()
            job.update(message="Loading speech model…" if downloaded else
                       f"Downloading the '{model_name}' speech model (one-time)…")
        model = get_whisper_model(model_name)
        job.update(message="Listening to the clip…")
        result = model.transcribe(str(audio), fp16=False, word_timestamps=True)

    segments = []
    words = []
    for seg in result["segments"]:
        segments.extend(split_segment(seg, max_chars))
        # Word boundaries are sent along so the caption timeline can snap to them.
        for w in seg.get("words") or []:
            if w["word"].strip():
                words.append({"start": round(w["start"], 2), "end": round(w["end"], 2)})
    return {"segments": segments, "words": words}


@app.route("/api/transcribe", methods=["POST"])
def transcribe():
    data = request.get_json() or {}
    d = get_session(data.get("session"))
    if not (d / "clip.mp4").exists():
        abort(400, "Cut a clip first")
    try:
        max_chars = int(data.get("max_chars", DEFAULT_MAX_CAPTION_CHARS))
    except (TypeError, ValueError):
        max_chars = DEFAULT_MAX_CAPTION_CHARS
    max_chars = max(15, min(max_chars, 200))
    model = data.get("model") or DEFAULT_WHISPER_MODEL
    if model not in {n for n, _, _ in WHISPER_MODELS}:
        abort(400, "Unknown speech model")
    job = start_job("transcribe", d.name, transcribe_job, d, max_chars, model)
    return jsonify(job=job.id)


def clamp_int(value, default, lo, hi):
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def export_job(job: Job, d: Path, name: str, captions: list, style: dict, width: int, fps: int):
    clip = d / "clip.mp4"
    out_dir = d / "exports"
    out_dir.mkdir(exist_ok=True)
    ass = d / "captions.ass"
    write_ass(ass, captions, style)
    duration = media_duration(probe(clip)) or None

    # Scale down at the burn-in step so both the MP4 and the GIF derived
    # from it come out smaller. ffmpeg runs from the session folder so the
    # ass filter gets a plain relative filename (no path escaping needed).
    job.update(progress=0, message="Burning in captions…")
    burned = d / "burned.mp4"
    ffmpeg(["-i", clip, "-vf", f"ass=captions.ass,scale={width}:-2:flags=lanczos",
            "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", burned],
           job, duration, (0, 0.55), cwd=d)

    job.update(message="Building the GIF colour palette…")
    palette = d / "palette.png"
    ffmpeg(["-i", burned, "-vf", f"fps={fps},palettegen=stats_mode=diff", palette],
           job, duration, (0.55, 0.65))

    job.update(message="Rendering GIF…")
    gif_tmp = d / "export.tmp.gif"
    ffmpeg(["-i", burned, "-i", palette, "-filter_complex",
            f"fps={fps}[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle", gif_tmp],
           job, duration, (0.65, 1.0))

    out_gif, out_mp4 = out_dir / f"{name}.gif", out_dir / f"{name}.mp4"
    shutil.copy(burned, out_mp4)
    gif_tmp.replace(out_gif)
    bust = int(time.time() * 1000)
    return {
        "name": name,
        "gif_url": f"/sessions/{d.name}/exports/{out_gif.name}?v={bust}",
        "mp4_url": f"/sessions/{d.name}/exports/{out_mp4.name}?v={bust}",
        "gif_size": out_gif.stat().st_size,
        "mp4_size": out_mp4.stat().st_size,
    }


@app.route("/api/export", methods=["POST"])
def export():
    data = request.get_json() or {}
    d = get_session(data.get("session"))
    if not (d / "clip.mp4").exists():
        abort(400, "Cut a clip first")
    name = "".join(c for c in str(data.get("name") or "") if c.isalnum() or c in "-_")[:80] or "clip"
    if (d / "exports" / f"{name}.gif").exists() and not data.get("overwrite"):
        return jsonify(error=f'There\'s already a GIF called "{name}".', conflict=True), 409

    captions = []
    for c in data.get("captions") or []:
        try:
            start, end, text = float(c["start"]), float(c["end"]), str(c["text"])
        except (KeyError, TypeError, ValueError):
            continue
        if text.strip() and end > start:
            captions.append({"start": start, "end": end, "text": text})

    fonts = {f["family"] for f in available_fonts()}
    style = {
        "fontsize": clamp_int(data.get("fontsize"), 32, 8, 120),
        "color": data.get("color") if HEX_COLOR_RE.match(str(data.get("color"))) else "#ffffff",
        "font": data.get("font") if data.get("font") in fonts else DEFAULT_FONT,
        "outline": clamp_int(data.get("outline"), 3, 0, 8),
        "position": "top" if data.get("position") == "top" else "bottom",
        "uppercase": bool(data.get("uppercase")),
    }
    width = clamp_int(data.get("width"), 360, 120, 1280)
    width -= width % 2
    fps = clamp_int(data.get("fps"), 15, 5, 30)
    job = start_job("export", d.name, export_job, d, name, captions, style, width, fps)
    return jsonify(job=job.id)


@app.route("/sessions/<sid>/<path:filename>")
def serve_session_file(sid, filename):
    return send_from_directory(get_session(sid), filename)


if __name__ == "__main__":
    app.run(debug=True, host="127.0.0.1", port=int(os.environ.get("PORT", 5050)), threaded=True)
