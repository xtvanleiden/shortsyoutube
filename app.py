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
import os
import queue
import sys
import re
import shutil
import threading
import time
import traceback
import uuid
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

import media
import suggest

ROOT = Path(__file__).parent
# SHORTS_LIBRARY / SHORTS_PORT permettono di avviare una seconda copia (es. per provare) senza
# toccare la libreria vera
LIBRARY = Path(os.environ.get("SHORTS_LIBRARY", ROOT / "library"))
STATIC = ROOT / "static"
HOST, PORT = "127.0.0.1", int(os.environ.get("SHORTS_PORT", 8765))

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


META_LOCK = threading.Lock()


def update_meta(video_id: str, **fields) -> dict:
    """Aggiorna solo alcuni campi di meta.json (sicuro anche con due lavori in parallelo)."""
    with META_LOCK:
        meta = load_meta(video_id)
        meta.update(fields)
        save_meta(meta)
        return meta


# --------------------------------------------------------------------------
# Code dei lavori, in background, così il PC non si blocca:
#   JOB_QUEUE        download, analisi, esportazioni (uno alla volta)
#   TRANSCRIBE_QUEUE trascrizioni (lente): girano in parallelo, così intanto puoi tagliare
# --------------------------------------------------------------------------

JOBS: dict[str, dict] = {}
JOB_QUEUE: "queue.Queue[tuple[str, callable]]" = queue.Queue()
TRANSCRIBE_QUEUE: "queue.Queue[tuple[str, callable]]" = queue.Queue()


def submit(kind: str, label: str, video_id: str | None, fn, q: queue.Queue = JOB_QUEUE) -> dict:
    job = {"id": uuid.uuid4().hex[:10], "kind": kind, "label": label, "video_id": video_id,
           "status": "queued", "progress": 0.0, "step": "In coda", "error": None, "result": None,
           "created": time.time()}
    JOBS[job["id"]] = job
    q.put((job["id"], fn))
    return job


def worker(q: queue.Queue) -> None:
    while True:
        job_id, fn = q.get()
        job = JOBS[job_id]
        if job["status"] == "cancelled":   # il video è stato eliminato mentre era in coda
            continue
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
    meta = update_meta(video_id, status="processing")
    try:
        src = folder / meta["file"]
        meta = update_meta(video_id, **media.probe(src))
        thumbs = media.make_thumbnails(src, folder / "thumbs", meta["duration"], progress)
        write_json(folder / "thumbs" / "thumbs.json", thumbs)
        write_json(folder / "peaks.json", media.make_peaks(src, meta["duration"], progress))
        update_meta(video_id, status="ready")
    except Exception as exc:
        update_meta(video_id, status="error", error=str(exc))
        raise
    if not (folder / "transcript.json").exists():
        start_transcription(video_id)


def download_job(video_id: str, url: str):
    """Lavoro di download + analisi (usato anche per riprendere un download interrotto)."""
    def run(job, progress):
        try:
            src = media.download_youtube(url, video_dir(video_id), progress)
        except Exception as exc:
            # senza questo il video restava "Download…" per sempre nella lista
            reason = "connessione lenta o interrotta" if "timed out" in str(exc).lower() else str(exc)[-200:]
            update_meta(video_id, status="error",
                        error=f"Download non riuscito ({reason}). Clicca il video per riprovare.")
            raise
        update_meta(video_id, file=src.name, error=None)
        analyze_video(video_id, progress)
    return run


def start_transcription(video_id: str) -> dict:
    meta = update_meta(video_id, transcript="queued")

    def run(job, progress):
        update_meta(video_id, transcript="running")
        try:
            folder = video_dir(video_id)
            data = media.transcribe(folder / meta["file"], meta["duration"], progress)
            write_json(folder / "transcript.json", data)
            # i clip suggeriti dipendono dal testo: con una trascrizione nuova si ricalcolano
            (folder / "suggerimenti.json").unlink(missing_ok=True)
            update_meta(video_id, transcript="ready")
        except Exception:
            update_meta(video_id, transcript="error")
            raise
        finally:
            if TRANSCRIBE_QUEUE.empty():   # nessun'altra trascrizione in attesa: libera la memoria
                media.unload_whisper()

    return submit("transcribe", "Trascrizione: " + meta.get("title", video_id), video_id, run,
                  TRANSCRIBE_QUEUE)


# --------------------------------------------------------------------------
# API: libreria
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/static/<path:name>")
def static_files(name):
    return send_from_directory(STATIC, name)


def library_metas():
    """Tutti i video della libreria (le cartelle che iniziano con "_" sono in eliminazione)."""
    for p in LIBRARY.glob("*/meta.json"):
        if not p.parent.name.startswith("_") and (meta := read_json(p)):
            yield p, meta


def folder_size(folder: Path) -> int:
    return sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())


@app.get("/api/videos")
def list_videos():
    videos = []
    for p, meta in library_metas():
        meta["size"] = folder_size(p.parent)
        meta["shorts_count"] = len(read_json(p.parent / "shorts" / "shorts.json", []))
        videos.append(meta)
    videos.sort(key=lambda m: m.get("created", 0), reverse=True)
    return jsonify(videos)


def remove_tree(folder: Path, attempts: int = 10) -> bool:
    """Cancella una cartella riprovando un po': su Windows un file appena chiuso può restare bloccato."""
    for _ in range(attempts):
        try:
            shutil.rmtree(folder)
            return True
        except FileNotFoundError:
            return True
        except OSError:
            time.sleep(0.3)
    return False


@app.delete("/api/videos/<video_id>")
def delete_video(video_id):
    """Elimina il video e tutto ciò che gli appartiene: file, miniature, forma d'onda, trascrizione, Short."""
    folder = video_dir(video_id)
    if not (folder / "meta.json").exists():
        abort(404)
    busy = [j for j in JOBS.values() if j["video_id"] == video_id and j["status"] == "running"]
    if busy:
        return jsonify(error=f"Sto ancora lavorando su questo video ({busy[0]['step'].lower()}): "
                             "riprova quando ha finito."), 409
    for job in JOBS.values():
        if job["video_id"] == video_id and job["status"] == "queued":
            job["status"], job["step"] = "cancelled", "Annullato"

    freed = folder_size(folder)
    # Prima si rinomina la cartella: se un file è ancora aperto Windows rifiuta e non si cancella
    # niente a metà. Dopo, la cartella rinominata non compare più nella libreria.
    trash = LIBRARY / f"_eliminare_{video_id}_{uuid.uuid4().hex[:6]}"
    for _ in range(10):
        try:
            folder.rename(trash)
            break
        except OSError:
            time.sleep(0.3)
    else:
        return jsonify(error="Non riesco a eliminare il video: un file è ancora aperto "
                             "(magari in un altro programma). Riprova tra qualche secondo."), 409
    remove_tree(trash)   # se resta qualcosa, lo ripulisce il prossimo avvio
    return jsonify(ok=True, freed=freed)


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

    job = submit("download", info.get("title") or url, video_id, download_job(video_id, url))
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
# API: trascrizione
# --------------------------------------------------------------------------

TRANSCRIPT_LOCK = threading.Lock()


@app.get("/api/videos/<video_id>/transcript")
def get_transcript(video_id):
    data = read_json(video_dir(video_id) / "transcript.json")
    return jsonify(data) if data else (jsonify(error="Trascrizione non disponibile"), 404)


@app.post("/api/videos/<video_id>/transcribe")
def transcribe_video(video_id):
    meta = load_meta(video_id)
    if meta.get("status") != "ready":
        return jsonify(error="Il video non è ancora pronto"), 400
    if meta.get("transcript") in ("queued", "running"):
        return jsonify(error="Trascrizione già in corso"), 400
    return jsonify(job=start_transcription(video_id))


@app.post("/api/videos/<video_id>/transcript/word")
def edit_word(video_id):
    """Corregge una parola (testo vuoto = la elimina)."""
    body = request.get_json(silent=True) or {}
    path = video_dir(video_id) / "transcript.json"
    with TRANSCRIPT_LOCK:
        data = read_json(path)
        if not data:
            abort(404)
        try:
            i = int(body["index"])
            word = data["words"][i]
        except (KeyError, ValueError, TypeError, IndexError):
            return jsonify(error="Parola non trovata"), 400
        text = str(body.get("text", "")).strip()
        if text:
            word["w"] = text
        else:
            del data["words"][i]
        write_json(path, data)
    return jsonify(ok=True)


# --------------------------------------------------------------------------
# API: clip suggeriti + impostazioni (parole chiave)
# --------------------------------------------------------------------------

SETTINGS_PATH = ROOT / "impostazioni.json"


def load_settings() -> dict:
    return {"keywords": suggest.DEFAULT_KEYWORDS, **read_json(SETTINGS_PATH, {})}


@app.get("/api/settings")
def get_settings():
    return jsonify(load_settings())


@app.put("/api/settings")
def put_settings():
    body = request.get_json(silent=True) or {}
    settings = load_settings()
    if isinstance(body.get("keywords"), list):
        settings["keywords"] = [str(k).strip() for k in body["keywords"] if str(k).strip()]
    write_json(SETTINGS_PATH, settings)
    return jsonify(settings)


SUGGEST_LOCK = threading.Lock()


def stored_suggestions(video_id: str, words: list[dict]) -> list[dict]:
    """
    I suggerimenti si salvano (suggerimenti.json) per sapere quali sono già stati proposti.
    Se le parole chiave sono cambiate, si ricalcolano da capo.
    """
    path = video_dir(video_id) / "suggerimenti.json"
    keywords = load_settings()["keywords"]
    saved = read_json(path)
    if saved and saved.get("keywords") == keywords:
        return saved["items"]
    items = suggest.suggest(words, keywords, load_meta(video_id).get("duration", 0))
    for item in items:
        item["batch"] = 1
    write_json(path, {"keywords": keywords, "items": items})
    return items


@app.get("/api/videos/<video_id>/suggestions")
def get_suggestions(video_id):
    data = read_json(video_dir(video_id) / "transcript.json")
    if not data:
        return jsonify(ready=False, suggestions=[])
    with SUGGEST_LOCK:
        return jsonify(ready=True, suggestions=stored_suggestions(video_id, data["words"]))


@app.post("/api/videos/<video_id>/suggestions/more")
def more_suggestions(video_id):
    """Altri suggerimenti, lontani da quelli già proposti e dagli Short già creati."""
    meta = load_meta(video_id)
    folder = video_dir(video_id)
    data = read_json(folder / "transcript.json")
    if not data:
        return jsonify(error="Serve prima la trascrizione"), 400
    with SUGGEST_LOCK:
        items = stored_suggestions(video_id, data["words"])
        shorts = read_json(folder / "shorts" / "shorts.json", [])
        exclude = [(g["start"], g["end"]) for g in items] + [(s["start"], s["end"]) for s in shorts]
        new = suggest.suggest(data["words"], load_settings()["keywords"], meta.get("duration", 0),
                              exclude=exclude, count=suggest.MORE_BATCH)
        batch = max((g.get("batch", 1) for g in items), default=0) + 1
        next_rank = max((g["rank"] for g in items), default=0) + 1
        for i, item in enumerate(new):
            item["rank"], item["batch"] = next_rank + i, batch
        items += new
        write_json(folder / "suggerimenti.json", {"keywords": load_settings()["keywords"], "items": items})
    return jsonify(suggestions=items, added=len(new))


# --------------------------------------------------------------------------
# API: inquadratura dinamica (punti di inquadratura + segui il volto)
# --------------------------------------------------------------------------

FRAME_LOCK = threading.Lock()


def frame_path(video_id: str) -> Path:
    return video_dir(video_id) / "inquadratura.json"


def load_frame(video_id: str) -> dict:
    return {"dynamic": False, "keys": [], **read_json(frame_path(video_id), {})}


def clean_keys(keys) -> list[dict]:
    out = []
    for k in keys if isinstance(keys, list) else []:
        try:
            out.append({"t": round(float(k["t"]), 3), "x": min(1.0, max(0.0, float(k["x"]))),
                        "d": max(0.0, float(k.get("d", 0))), "m": bool(k.get("m", True))})
        except (KeyError, TypeError, ValueError):
            continue
    return sorted(out, key=lambda k: k["t"])


@app.get("/api/videos/<video_id>/inquadratura")
def get_frame(video_id):
    load_meta(video_id)
    return jsonify(load_frame(video_id))


@app.put("/api/videos/<video_id>/inquadratura")
def put_frame(video_id):
    load_meta(video_id)
    body = request.get_json(silent=True) or {}
    with FRAME_LOCK:
        data = load_frame(video_id)
        if "dynamic" in body:
            data["dynamic"] = bool(body["dynamic"])
        if "keys" in body:
            data["keys"] = clean_keys(body["keys"])
        write_json(frame_path(video_id), data)
    return jsonify(data)


@app.post("/api/videos/<video_id>/reframe")
def reframe(video_id):
    """Segui il volto nel segmento [start, end]: sostituisce i punti di inquadratura in quel tratto."""
    meta = load_meta(video_id)
    if meta.get("status") != "ready":
        return jsonify(error="Il video non è ancora pronto"), 400
    body = request.get_json(silent=True) or {}
    try:
        start, end = max(0.0, float(body["start"])), min(meta["duration"], float(body["end"]))
    except (KeyError, TypeError, ValueError):
        return jsonify(error="Inizio/fine non validi"), 400
    if end - start < 1:
        return jsonify(error="Seleziona almeno 1 secondo"), 400

    def run(job, progress):
        result = media.track_face(video_dir(video_id) / meta["file"], start, end,
                                  meta["width"], meta["height"], progress)
        if result["keys"]:
            with FRAME_LOCK:
                data = load_frame(video_id)
                kept = [k for k in data["keys"] if k["t"] < start or k["t"] > end]
                data["keys"] = clean_keys(kept + result["keys"])
                data["dynamic"] = True
                write_json(frame_path(video_id), data)
        job["result"] = {"warning": result["warning"], "count": len(result["keys"]),
                         "coverage": result["coverage"]}

    job = submit("reframe", f"Segui il volto {fmt_time(start)}–{fmt_time(end)}", video_id, run)
    return jsonify(job=job)


# --------------------------------------------------------------------------
# API: Short
# --------------------------------------------------------------------------

HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")


def clean_title(raw) -> dict | None:
    """Controlla il titolo fisso ricevuto dalla pagina (valori sbagliati -> valori di default)."""
    if not isinstance(raw, dict) or not str(raw.get("text", "")).strip():
        return None

    def num(key, default, lo, hi):
        try:
            return min(hi, max(lo, float(raw.get(key, default))))
        except (TypeError, ValueError):
            return default

    color = str(raw.get("color", ""))
    band_color = str(raw.get("band_color", ""))
    return {
        "text": " ".join(str(raw["text"]).split())[:80],
        "font": raw.get("font") if raw.get("font") in media.TITLE_FONTS else "Arial Black",
        "size": int(num("size", 90, 30, 200)),
        "color": color if HEX_COLOR.fullmatch(color) else "#ffffff",
        "band": bool(raw.get("band")),
        "band_color": band_color if HEX_COLOR.fullmatch(band_color) else "#d32f2f",
        "y": num("y", 0.15, 0.03, 0.97),
    }


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
    subtitles = bool(body.get("subtitles"))
    dynamic = bool(body.get("dynamic")) and mode == "crop"
    title = clean_title(body.get("title"))
    try:
        sub_y = min(0.95, max(0.05, float(body.get("sub_y", media.SUB_Y_DEFAULT))))
    except (TypeError, ValueError):
        sub_y = media.SUB_Y_DEFAULT
    if subtitles and not (video_dir(video_id) / "transcript.json").exists():
        return jsonify(error="Per i sottotitoli serve prima la trascrizione (in corso o da avviare)"), 400

    folder = video_dir(video_id)
    shorts_dir = folder / "shorts"
    shorts_dir.mkdir(exist_ok=True)
    filename = f"short_{fmt_time(start)}-{fmt_time(end)}_{time.strftime('%H%M%S')}.mp4"

    def run(job, progress):
        # la trascrizione si legge ora, così include le correzioni fatte fino all'ultimo
        words = read_json(folder / "transcript.json", {}).get("words") if subtitles else None
        # anche i punti di inquadratura si leggono ora (con le ultime modifiche)
        frame_keys = load_frame(video_id)["keys"] if dynamic else None
        media.export_short(folder / meta["file"], shorts_dir / filename, start, end,
                           meta["width"], meta["height"], mode, crop_x, progress, words, sub_y,
                           frame_keys, title)
        shorts = read_json(shorts_dir / "shorts.json", [])
        shorts.insert(0, {"file": filename, "start": start, "end": end, "mode": mode,
                          "crop_x": crop_x, "dynamic": bool(frame_keys), "subtitles": subtitles, "sub_y": sub_y,
                          "title": title["text"] if title else None,
                          "created": time.time()})
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
    for leftover in LIBRARY.glob("_eliminare_*"):   # eliminazioni non completate
        remove_tree(leftover, attempts=1)
    for p, meta in library_metas():
        if meta.get("status") == "ready" and meta.get("transcript") in ("queued", "running"):
            start_transcription(meta["id"])
        if meta.get("status") == "ready":
            continue
        vid = meta["id"]
        if meta.get("status") == "downloading" and meta.get("source_url"):
            # download interrotto (app chiusa a metà): si riprende da dove era arrivato
            submit("download", meta.get("title", vid), vid, download_job(vid, meta["source_url"]))
        elif (p.parent / meta.get("file", "")).is_file():
            submit("analyze", meta.get("title", vid), vid, lambda job, progress, vid=vid: analyze_video(vid, progress))
        else:
            meta["status"], meta["error"] = "error", "Download interrotto: riprova dall'URL"
            write_json(p, meta)


def main() -> None:
    if missing := media.missing_tools():
        raise SystemExit(f"Mancano {', '.join(missing)}: installa ffmpeg e aggiungilo al PATH.")
    media.ensure_ytdlp()
    LIBRARY.mkdir(exist_ok=True)
    threading.Thread(target=worker, args=(JOB_QUEUE,), daemon=True).start()
    threading.Thread(target=worker, args=(TRANSCRIBE_QUEUE,), daemon=True).start()
    resume_unfinished()
    url = f"http://{HOST}:{PORT}"
    print(f"\n  Shorts Studio è pronto: {url}\n  (chiudi questa finestra per fermarlo)\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host=HOST, port=PORT, threaded=True, debug=False)


if __name__ == "__main__":
    main()
