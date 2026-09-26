"""
Operazioni sui file video: download, analisi, miniature, waveform, esportazione.

Tutto il lavoro "pesante" passa da ffmpeg/ffprobe (devono essere nel PATH)
e da yt-dlp (libreria Python, installata nel venv).
"""

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Callable

import numpy as np

ProgressCb = Callable[[float, str], None]

# Miniature della timeline: 160x90, raccolte in "fogli" da 10x10
THUMB_W, THUMB_H = 160, 90
SHEET_COLS, SHEET_ROWS = 10, 10

# Waveform: 25 valori al secondo, calcolati su audio mono a 8 kHz
PEAKS_PER_SEC = 25
PEAK_SAMPLE_RATE = 8000

SHORT_W, SHORT_H = 1080, 1920

# Trascrizione: "small" è il miglior compromesso su CPU. "medium" è più preciso ma ~3 volte più lento.
WHISPER_MODEL = "small"
# Parole che Whisper deve "conoscere" (nomi propri, sigle): migliora come le scrive.
WHISPER_PROMPT = "Iniziative POP, legge elettorale, referendum, Lombardia Civica."


# --------------------------------------------------------------------------
# Controlli iniziali
# --------------------------------------------------------------------------

def missing_tools() -> list[str]:
    return [t for t in ("ffmpeg", "ffprobe") if shutil.which(t) is None]


def ensure_ytdlp() -> None:
    """Installa yt-dlp nel venv se manca."""
    try:
        import yt_dlp  # noqa: F401
    except ImportError:
        print("yt-dlp non trovato, lo installo ...")
        subprocess.run([sys.executable, "-m", "pip", "install", "-U", "yt-dlp"], check=True)


# --------------------------------------------------------------------------
# ffmpeg con barra di avanzamento
# --------------------------------------------------------------------------

def run_ffmpeg(args: list[str], duration: float, progress: ProgressCb | None, label: str,
               cwd: Path | None = None) -> None:
    """Esegue ffmpeg leggendo l'avanzamento da -progress e riportandolo come 0..1."""
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1", *args]
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=err, text=True, cwd=cwd)
        for line in proc.stdout:
            key, _, value = line.strip().partition("=")
            if key in ("out_time_us", "out_time_ms") and value.isdigit() and progress and duration > 0:
                progress(min(1.0, int(value) / 1_000_000 / duration), label)
        proc.wait()
        if proc.returncode != 0:
            err.seek(0)
            msg = err.read().decode("utf-8", "replace").strip().splitlines()[-5:]
            raise RuntimeError("ffmpeg ha dato errore:\n" + "\n".join(msg))


# --------------------------------------------------------------------------
# Analisi file
# --------------------------------------------------------------------------

def probe(path: Path) -> dict:
    """Durata e dimensioni (già corrette per eventuale rotazione, es. video da telefono)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height:stream_side_data=rotation:format=duration",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    stream = (data.get("streams") or [{}])[0]
    width, height = int(stream.get("width", 0)), int(stream.get("height", 0))
    rotation = 0
    for sd in stream.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(sd["rotation"])
    if abs(rotation) % 180 == 90:
        width, height = height, width
    return {
        "duration": float(data.get("format", {}).get("duration", 0) or 0),
        "width": width,
        "height": height,
    }


# --------------------------------------------------------------------------
# 1. Download da YouTube
# --------------------------------------------------------------------------

def youtube_info(url: str) -> dict:
    import yt_dlp

    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        return ydl.extract_info(url, download=False)


def download_youtube(url: str, dest_dir: Path, progress: ProgressCb) -> Path:
    """Scarica il video in dest_dir/source.mp4 (H.264 fino a 1080p, così il browser lo riproduce)."""
    import yt_dlp

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            if total:
                progress(d.get("downloaded_bytes", 0) / total, "Download")
        elif d.get("status") == "finished":
            progress(1.0, "Unione audio/video")

    opts = {
        "format": "bv*[vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])

    for p in dest_dir.glob("source.*"):
        if p.suffix.lower() in (".mp4", ".mkv", ".webm"):
            return p
    raise RuntimeError("Download fallito: nessun file video trovato.")


# --------------------------------------------------------------------------
# 3a. Miniature per la timeline
# --------------------------------------------------------------------------

def thumb_interval(duration: float) -> int:
    if duration <= 600:
        return 2
    if duration <= 1800:
        return 3
    return 5


def make_thumbnails(src: Path, out_dir: Path, duration: float, progress: ProgressCb) -> dict:
    """
    Crea i fogli di miniature (sheet_000.jpg, ...) e restituisce le info per la GUI.

    Trucco per la velocità: -skip_frame nokey decodifica solo i fotogrammi chiave,
    quindi anche un video di 1-2 ore si elabora in poco tempo.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("sheet_*.jpg"):
        old.unlink()

    interval = thumb_interval(duration)
    vf = (
        f"fps=1/{interval},"
        f"scale={THUMB_W}:{THUMB_H}:force_original_aspect_ratio=decrease,"
        f"pad={THUMB_W}:{THUMB_H}:(ow-iw)/2:(oh-ih)/2,"
        f"tile={SHEET_COLS}x{SHEET_ROWS}"
    )
    per_sheet = SHEET_COLS * SHEET_ROWS
    run_ffmpeg(
        ["-y", "-skip_frame", "nokey", "-i", str(src), "-an", "-sn", "-dn",
         "-vf", vf, "-fps_mode", "vfr", "-q:v", "5", str(out_dir / "sheet_%03d.jpg")],
        duration, progress, "Miniature",
    )
    sheets = sorted(p.name for p in out_dir.glob("sheet_*.jpg"))
    return {
        "interval": interval,
        "count": min(math.floor(duration / interval) + 1, len(sheets) * per_sheet),
        "width": THUMB_W,
        "height": THUMB_H,
        "cols": SHEET_COLS,
        "rows": SHEET_ROWS,
        "sheets": sheets,
    }


# --------------------------------------------------------------------------
# 3b. Forma d'onda audio
# --------------------------------------------------------------------------

def make_peaks(src: Path, duration: float, progress: ProgressCb) -> dict:
    """Legge l'audio mono a 8 kHz e calcola il picco di ogni 1/25 di secondo (valori 0-100)."""
    bucket = PEAK_SAMPLE_RATE // PEAKS_PER_SEC
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(src),
           "-vn", "-ac", "1", "-ar", str(PEAK_SAMPLE_RATE), "-f", "s16le", "-"]
    peaks: list[np.ndarray] = []
    leftover = np.zeros(0, dtype=np.int16)
    done_samples = 0
    total_samples = max(1, duration * PEAK_SAMPLE_RATE)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    while True:
        chunk = proc.stdout.read(bucket * 2 * 2000)
        if not chunk:
            break
        samples = np.concatenate([leftover, np.frombuffer(chunk, dtype=np.int16)])
        n = len(samples) // bucket
        if n:
            block = np.abs(samples[: n * bucket].astype(np.int32)).reshape(n, bucket)
            peaks.append(block.max(axis=1))
        leftover = samples[n * bucket:]
        done_samples += len(chunk) // 2
        progress(min(1.0, done_samples / total_samples), "Forma d'onda")
    proc.wait()

    if not peaks:  # video senza audio
        return {"rate": PEAKS_PER_SEC, "peaks": []}
    values = np.concatenate(peaks).astype(np.float32)
    ref = float(np.percentile(values, 99.5)) or 1.0
    scaled = np.clip(values / ref * 100, 0, 100).round().astype(int)
    return {"rate": PEAKS_PER_SEC, "peaks": scaled.tolist()}


# --------------------------------------------------------------------------
# 2. Trascrizione (faster-whisper, in locale)
# --------------------------------------------------------------------------

_whisper = None


def transcribe(src: Path, duration: float, progress: ProgressCb) -> dict:
    """Restituisce {"model", "words": [{"s", "e", "w"}, ...]} con i tempi di ogni parola."""
    global _whisper
    from faster_whisper import BatchedInferencePipeline, WhisperModel

    if _whisper is None:
        progress(0.0, "Carico il modello (la prima volta lo scarica, ~500 MB)")
        model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8",
                             cpu_threads=os.cpu_count() or 4)
        # modalità "a lotti": su CPU circa 2 volte più veloce, stessa qualità nei test
        _whisper = BatchedInferencePipeline(model=model)
    progress(0.0, "Trascrizione")
    segments, _info = _whisper.transcribe(
        str(src), language="it", word_timestamps=True, batch_size=8, beam_size=1,
        initial_prompt=WHISPER_PROMPT,
    )
    words: list[dict] = []
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            # Whisper spezza "c'è" in "c" + "'è" e "42%" in "42" + "%": il pezzo senza
            # spazio davanti appartiene alla parola precedente
            if words and not w.word.startswith(" "):
                words[-1]["w"] += text
                words[-1]["e"] = round(float(w.end), 2)
            else:
                words.append({"s": round(float(w.start), 2), "e": round(float(w.end), 2), "w": text})
        progress(min(1.0, seg.end / max(1.0, duration)), "Trascrizione")
    return {"model": WHISPER_MODEL, "words": words}


# --------------------------------------------------------------------------
# 6. Sottotitoli stile Shorts (file .ass bruciato nel video da ffmpeg)
# --------------------------------------------------------------------------

# Colori ASS in formato &HBBGGRR: bianco con contorno nero, parola attiva gialla.
# La posizione verticale si sceglie dalla GUI (vedi SUB_Y_DEFAULT) e si applica riga per riga.
ASS_HEADER = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {SHORT_W}
PlayResY: {SHORT_H}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,86,&H00FFFFFF,&H00FFFFFF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,7,3,2,70,70,560,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
ACTIVE = r"{\c&H00D7FF&\fscx112\fscy112}"   # giallo e leggermente più grande
NORMAL = r"{\c&HFFFFFF&\fscx100\fscy100}"

MAX_WORDS_PER_LINE = 3
MAX_CHARS_PER_LINE = 22
MAX_GAP = 0.6       # una pausa più lunga di così chiude il gruppo di parole
HOLD = 0.4          # quanto resta a schermo l'ultimo gruppo dopo l'ultima parola

# Altezza del CENTRO del testo, da 0 (in alto) a 1 (in basso). 0.80 lascia libero il 15% in
# basso, dove YouTube Shorts/Reels/TikTok mettono pulsanti e didascalie.
SUB_Y_DEFAULT = 0.80


def chunk_words(words: list[dict]) -> list[list[dict]]:
    """Raggruppa le parole a 2-3 per volta (stessa regola usata dall'anteprima nel browser)."""
    chunks: list[list[dict]] = []
    cur: list[dict] = []
    for w in words:
        chars = sum(len(x["w"]) + 1 for x in cur) + len(w["w"])
        if cur and (len(cur) >= MAX_WORDS_PER_LINE or chars > MAX_CHARS_PER_LINE
                    or w["s"] - cur[-1]["e"] > MAX_GAP or cur[-1]["w"][-1] in ".?!"
                    or (cur[-1]["w"][-1] in ",;:" and len(cur) >= 2)):
            chunks.append(cur)
            cur = []
        cur.append(w)
    if cur:
        chunks.append(cur)
    return chunks


def _ass_time(t: float) -> str:
    t = max(0.0, t)
    cs = int(round(t * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _ass_text(s: str) -> str:
    return s.replace("\\", "").replace("{", "(").replace("}", ")").upper()


def build_ass(words: list[dict], start: float, end: float, out_path: Path,
              sub_y: float = SUB_Y_DEFAULT) -> None:
    """Crea il file dei sottotitoli per il segmento [start, end] (tempi relativi alla clip)."""
    # \an5 = il punto di \pos è il centro del testo (anche se va a capo su due righe)
    pos = rf"{{\an5\pos({SHORT_W // 2},{round(min(0.95, max(0.05, sub_y)) * SHORT_H)})}}"
    clip = [dict(w, s=w["s"] - start, e=w["e"] - start)
            for w in words if w["e"] > start and w["s"] < end]
    clip_len = end - start
    chunks = chunk_words(clip)
    events = []
    for ci, chunk in enumerate(chunks):
        next_start = chunks[ci + 1][0]["s"] if ci + 1 < len(chunks) else clip_len
        chunk_end = min(chunk[-1]["e"] + HOLD, next_start, clip_len)
        for i, w in enumerate(chunk):
            # ogni parola resta evidenziata finché non inizia la successiva: niente sfarfallio
            a = w["s"] if i else max(0.0, w["s"])
            b = chunk[i + 1]["s"] if i + 1 < len(chunk) else chunk_end
            if b - a < 0.02:
                continue
            text = " ".join((ACTIVE if j == i else NORMAL) + _ass_text(x["w"]) for j, x in enumerate(chunk))
            events.append(f"Dialogue: 0,{_ass_time(a)},{_ass_time(b)},Default,,0,0,0,,{pos}{text}")
    out_path.write_text(ASS_HEADER + "\n".join(events) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------
# 5. Taglio + formato verticale 9:16
# --------------------------------------------------------------------------

def _even(x: float) -> int:
    return max(2, int(round(x / 2)) * 2)


def vertical_filter(mode: str, src_w: int, src_h: int, crop_x: float) -> str:
    """
    mode="crop": ritaglia una finestra 9:16 dal video (crop_x = 0 sinistra, 0.5 centro, 1 destra).
    mode="blur": video intero al centro con sfondo sfocato sopra e sotto.
    """
    if mode == "blur":
        return (
            f"split=2[a][b];"
            f"[a]scale={SHORT_W}:{SHORT_H}:force_original_aspect_ratio=increase,"
            f"crop={SHORT_W}:{SHORT_H},gblur=sigma=30[bg];"
            f"[b]scale={SHORT_W}:{SHORT_H}:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1"
        )

    crop_x = min(1.0, max(0.0, crop_x))
    if src_w / src_h > 9 / 16:  # sorgente orizzontale: si taglia ai lati
        cw, ch = _even(src_h * 9 / 16), src_h
        x, y = int((src_w - cw) * crop_x), 0
    else:  # sorgente già verticale (o più stretta): si taglia sopra/sotto
        cw, ch = src_w, min(src_h, _even(src_w * 16 / 9))
        x, y = 0, int((src_h - ch) / 2)
    return f"crop={cw}:{ch}:{x}:{y},scale={SHORT_W}:{SHORT_H},setsar=1"


def export_short(
    src: Path, out_path: Path, start: float, end: float,
    src_w: int, src_h: int, mode: str, crop_x: float, progress: ProgressCb,
    words: list[dict] | None = None, sub_y: float = SUB_Y_DEFAULT,
) -> None:
    """Taglia [start, end], converte in 9:16 e, se ci sono `words`, brucia i sottotitoli."""
    duration = end - start
    tmp = out_path.with_suffix(".part.mp4")
    vf = vertical_filter(mode, src_w, src_h, crop_x)
    ass = out_path.with_suffix(".ass")
    if words:
        build_ass(words, start, end, ass, sub_y)
        # ffmpeg gira nella cartella del file .ass: così niente problemi con "C:\" nel filtro
        vf += f",ass={ass.name}"
    try:
        run_ffmpeg(
            ["-y", "-ss", f"{start:.3f}", "-i", str(src.resolve()), "-t", f"{duration:.3f}",
             "-filter_complex", f"[0:v]{vf}[v]",
             "-map", "[v]", "-map", "0:a?",
             "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(tmp.resolve())],
            duration, progress, "Esportazione", cwd=out_path.parent,
        )
    finally:
        ass.unlink(missing_ok=True)
    tmp.replace(out_path)
