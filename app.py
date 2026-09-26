"""
Shorts Studio: app web locale per creare YouTube Shorts dai video lunghi.

Avvio:   venv\\Scripts\\python app.py      (oppure doppio clic su avvia.bat)
Poi si apre il browser su http://127.0.0.1:8765

Struttura dei dati (cartella library/):
    library/<id-video>/
        meta.json          titolo, durata, dimensioni, stato
        source.mp4         video originale
        thumbs/            fogli di miniature + thumbs.json
        peaks.json         forma d'onda
        shorts/            Short esportati + shorts.json
"""

import json
import queue
import sys
import re
import threading
import time
import traceback
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

import media

ROOT = Path(__file__).parent
LIBRARY = ROOT / "library"
STATIC = ROOT / "static"
HOST, PORT = "127.0.0.1", 8765

app = Flask(__name__, static_folder=None)


# --------------------------------------------------------------------------
# Libreria video (tutto salvato su disco in JSON)
# --------------------------------------------------------------------------

def video_dir(video_id: str) -> Path:
    if not re.fullmatch(r"[\w\-]+", video_id):
        abort(404)
    return LIBRARY / video_id


def read_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def write_json(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def load_meta(video_id: str) -> dict:
    meta = read_json(video_dir(video_id) / "meta.json")
    if meta is None:
        abort(404)
    return meta


def save_meta(meta: dict) -> None:
    write_json(video_dir(meta["id"]) / "meta.json", meta)


# --------------------------------------------------------------------------
# Coda dei lavori: uno alla volta, in background, così il PC non si blocca
# --------------------------------------------------------------------------

JOBS: dict[str, dict] = {}
JOB_QUEUE: "queue.Queue[tuple[str, callable]]" = queue.Queue()


def submit(kind: str, label: str, video_id: str | None, fn) -> dict:
    job = {"id": uuid.uuid4().hex[:10], "kind": kind, "label": label, "video_id": video_id,
           "status": "queued", "progress": 0.0, "step": "In coda", "error": None,
           "created": time.time()}
    JOBS[job["id"]] = job
    JOB_QUEUE.put((job["id"], fn))
    return job


def worker() -> None:
    while True:
        job_id, fn = JOB_QUEUE.get()
        job = JOBS[job_id]
        job["status"] = "running"

        def progress(value: float, step: str) -> None:
            job["progress"], job["step"] = value, step

        try:
            fn(job, progress)
            job["status"], job["progress"], job["step"] = "done", 1.0, "Completato"
        except Exception as exc:  # noqa: BLE001 - mostriamo qualsiasi errore nella GUI
            traceback.print_exc()
            job["status"], job["error"] = "error", str(exc)


def analyze_video(video_id: str, progress) -> None:
    """Passi comuni dopo download/import: probe, miniature, waveform."""
    folder = video_dir(video_id)
    meta = load_meta(video_id)
    meta["status"] = "processing"
    save_meta(meta)
    try:
        src = folder / meta["file"]
        meta.update(media.probe(src))
        save_meta(meta)
        thumbs = media.make_thumbnails(src, folder / "thumbs", meta["duration"], progress)
        write_json(folder / "thumbs" / "thumbs.json", thumbs)
        write_json(folder / "peaks.json", media.make_peaks(src, meta["duration"], progress))
        meta["status"] = "ready"
    except Exception as exc:
        meta["status"], meta["error"] = "error", str(exc)
        raise
    finally:
        save_meta(meta)


# --------------------------------------------------------------------------
# API: libreria
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC, name)


@app.get("/api/videos")
def list_videos():
    videos = [m for p in LIBRARY.glob("*/meta.json") if (m := read_json(p))]
    videos.sort(key=lambda m: m.get("created", 0), reverse=True)
    return jsonify(videos)


@app.get("/api/videos/<video_id>")
def get_video(video_id):
    folder = video_dir(video_id)
    meta = load_meta(video_id)
    return jsonify({
        **meta,
        "thumbs": read_json(folder / "thumbs" / "thumbs.json"),
        "shorts": read_json(folder / "shorts" / "shorts.json", []),
    })


@app.get("/api/videos/<video_id>/peaks")
def get_peaks(video_id):
    return jsonify(read_json(video_dir(video_id) / "peaks.json", {"rate": 25, "peaks": []}))


@app.post("/api/videos/url")
def add_from_url():
    url = (request.get_json(silent=True) or {}).get("url", "").strip()
    if not url:
        return jsonify(error="Inserisci un URL YouTube"), 400
    try:
        info = media.youtube_info(url)
    except Exception as exc:  # noqa: BLE001
        return jsonify(error=f"URL non valido o video non disponibile: {exc}"), 400

    video_id = "yt-" + re.sub(r"[^\w\-]", "_", info["id"])
    folder = LIBRARY / video_id
    if (existing := read_json(folder / "meta.json")) and existing.get("status") == "ready":
        return jsonify(video_id=video_id, already=True)
    for job in JOBS.values():
        if job["video_id"] == video_id and job["status"] in ("queued", "running"):
            return jsonify(video_id=video_id, job=job)

    folder.mkdir(parents=True, exist_ok=True)
    save_meta({"id": video_id, "title": info.get("title") or video_id, "source_url": url,
               "duration": info.get("duration") or 0, "file": "source.mp4",
               "status": "downloading", "created": time.time()})

    def run(job, progress):
        src = media.download_youtube(url, folder, progress)
        meta = load_meta(video_id)
        meta["file"] = src.name
        save_meta(meta)
        analyze_video(video_id, progress)

    job = submit("download", info.get("title") or url, video_id, run)
    return jsonify(video_id=video_id, job=job)


@app.post("/api/videos/upload")
def upload_file():
    """Il browser invia il file grezzo nel corpo della richiesta (niente multipart: più veloce)."""
    name = request.args.get("name", "video.mp4")
    stem, ext = Path(name).stem, Path(name).suffix.lower() or ".mp4"
    if ext not in (".mp4", ".mov", ".m4v", ".webm", ".mkv"):
        return jsonify(error="Formato non supportato (usa mp4, mov, m4v, webm, mkv)"), 400

    video_id = "file-" + (re.sub(r"[^\w\-]+", "_", stem)[:40].strip("_") or "video") + "-" + uuid.uuid4().hex[:6]
    folder = LIBRARY / video_id
    folder.mkdir(parents=True)
    with open(folder / f"source{ext}", "wb") as f:
        while chunk := request.stream.read(4 * 1024 * 1024):
            f.write(chunk)

    save_meta({"id": video_id, "title": stem, "source_url": None, "duration": 0,
               "file": f"source{ext}", "status": "processing", "created": time.time()})
    job = submit("analyze", stem, video_id, lambda job, progress: analyze_video(video_id, progress))
    return jsonify(video_id=video_id, job=job)


@app.get("/media/<video_id>/<path:name>")
def media_file(video_id, name):
    # conditional=True abilita le richieste "Range": serve per saltare nel video
    return send_from_directory(video_dir(video_id), name, conditional=True,
                               as_attachment=request.args.get("download") == "1")


# --------------------------------------------------------------------------
# API: Short
# --------------------------------------------------------------------------

def fmt_time(t: float) -> str:
    m, s = divmod(int(t), 60)
    return f"{m}m{s:02d}s"


@app.post("/api/videos/<video_id>/shorts")
def create_short(video_id):
    meta = load_meta(video_id)
    if meta.get("status") != "ready":
        return jsonify(error="Il video non è ancora pronto"), 400
    body = request.get_json(silent=True) or {}
    try:
        start, end = float(body["start"]), float(body["end"])
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Inizio/fine non validi"), 400
    start, end = max(0.0, start), min(meta["duration"], end)
    if end - start < 1:
        return jsonify(error="Il segmento deve durare almeno 1 secondo"), 400
    mode = body.get("mode") if body.get("mode") in ("crop", "blur") else "crop"
    crop_x = float(body.get("crop_x", 0.5))

    folder = video_dir(video_id)
    shorts_dir = folder / "shorts"
    shorts_dir.mkdir(exist_ok=True)
    filename = f"short_{fmt_time(start)}-{fmt_time(end)}_{time.strftime('%H%M%S')}.mp4"

    def run(job, progress):
        media.export_short(folder / meta["file"], shorts_dir / filename, start, end,
                           meta["width"], meta["height"], mode, crop_x, progress)
        shorts = read_json(shorts_dir / "shorts.json", [])
        shorts.insert(0, {"file": filename, "start": start, "end": end, "mode": mode,
                          "crop_x": crop_x, "created": time.time()})
        write_json(shorts_dir / "shorts.json", shorts)

    job = submit("short", f"Short {fmt_time(start)}–{fmt_time(end)}", video_id, run)
    return jsonify(job=job)


@app.delete("/api/videos/<video_id>/shorts/<name>")
def delete_short(video_id, name):
    shorts_dir = video_dir(video_id) / "shorts"
    shorts = read_json(shorts_dir / "shorts.json", [])
    if not any(s["file"] == name for s in shorts):
        abort(404)
    write_json(shorts_dir / "shorts.json", [s for s in shorts if s["file"] != name])
    (shorts_dir / name).unlink(missing_ok=True)
    return jsonify(ok=True)


@app.get("/api/jobs")
def list_jobs():
    recent = time.time() - 3600
    jobs = [j for j in JOBS.values() if j["status"] in ("queued", "running") or j["created"] > recent]
    return jsonify(sorted(jobs, key=lambda j: j["created"], reverse=True))


# --------------------------------------------------------------------------
# Avvio
# --------------------------------------------------------------------------

def resume_unfinished() -> None:
    """Se l'app è stata chiusa durante un'elaborazione, la riprende."""
    for p in LIBRARY.glob("*/meta.json"):
        meta = read_json(p)
        if not meta or meta.get("status") == "ready":
            continue
        if (p.parent / meta.get("file", "")).is_file():
            vid = meta["id"]
            submit("analyze", meta.get("title", vid), vid, lambda job, progress, vid=vid: analyze_video(vid, progress))
        else:
            meta["status"], meta["error"] = "error", "Download interrotto: riprova dall'URL"
            write_json(p, meta)


def main() -> None:
    if missing := media.missing_tools():
        raise SystemExit(f"Mancano {', '.join(missing)}: installa ffmpeg e aggiungilo al PATH.")
    media.ensure_ytdlp()
    LIBRARY.mkdir(exist_ok=True)
    threading.Thread(target=worker, daemon=True).start()
    resume_unfinished()
    url = f"http://{HOST}:{PORT}"
    print(f"\n  Shorts Studio è pronto: {url}\n  (chiudi questa finestra per fermarlo)\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()
