#!/usr/bin/env python3
"""
YouTube -> Shorts automatico
=============================

Pipeline che prende l'URL di un video YouTube lungo (video o replica di live),
lo trascrive, chiede a Claude di individuare i momenti piu' "intriganti" per
un pubblico social, e produce automaticamente clip verticali 9:16 con
sottotitoli animati bruciati nel video, pronte per essere caricate come
YouTube Shorts / Reels / TikTok.

Passi:
  1. Download del video con yt-dlp
  2. Trascrizione con timestamp parola-per-parola (faster-whisper)
  3. Selezione dei momenti migliori con Claude (Anthropic API)
  4. Taglio + reinquadratura verticale + sottotitoli animati con ffmpeg
  5. Salvataggio di titolo/hook/hashtag suggeriti per ogni clip

Uso:
    python pipeline.py --url "https://www.youtube.com/watch?v=XXXX" \
        --output-dir ./shorts_output --max-clips 5

Richiede: yt-dlp, faster-whisper, anthropic, ffmpeg installato sul sistema.
Vedi README.md per l'installazione.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


# --------------------------------------------------------------------------
# Modelli dati
# --------------------------------------------------------------------------

@dataclass
class Word:
    start: float
    end: float
    text: str


@dataclass
class Segment:
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)


@dataclass
class Clip:
    start: float
    end: float
    title: str
    hook: str
    hashtags: list[str]
    reason: str


# --------------------------------------------------------------------------
# 1. Download
# --------------------------------------------------------------------------

def download_video(url: str, workdir: Path) -> Path:
    """Scarica il video con yt-dlp e restituisce il path del file mp4."""
    workdir.mkdir(parents=True, exist_ok=True)
    out_template = str(workdir / "source.%(ext)s")

    cmd = [
        "yt-dlp",
        "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", out_template,
        url,
    ]
    print(f"[1/5] Scarico il video da {url} ...")
    subprocess.run(cmd, check=True)

    candidates = list(workdir.glob("source.*"))
    video_files = [p for p in candidates if p.suffix.lower() in (".mp4", ".mkv", ".webm")]
    if not video_files:
        raise RuntimeError("Download fallito: nessun file video trovato.")
    return video_files[0]


# --------------------------------------------------------------------------
# 2. Trascrizione
# --------------------------------------------------------------------------

def transcribe(video_path: Path, model_size: str = "medium", language: str = "it") -> list[Segment]:
    """Trascrive il video con faster-whisper, con timestamp parola per parola."""
    from faster_whisper import WhisperModel

    print(f"[2/5] Trascrivo l'audio (modello '{model_size}') ...")
    # compute_type="int8" gira bene anche su CPU; se hai una GPU NVIDIA
    # puoi passare device="cuda", compute_type="float16" per molta piu' velocita'.
    model = WhisperModel(model_size, device="auto", compute_type="int8")

    raw_segments, _info = model.transcribe(
        str(video_path),
        language=language,
        word_timestamps=True,
        vad_filter=True,
    )

    segments: list[Segment] = []
    for seg in raw_segments:
        words = [Word(w.start, w.end, w.word.strip()) for w in (seg.words or [])]
        segments.append(Segment(start=seg.start, end=seg.end, text=seg.text.strip(), words=words))
    return segments


def save_transcript(segments: list[Segment], out_path: Path) -> None:
    lines = [f"[{s.start:7.1f}s - {s.end:7.1f}s] {s.text}" for s in segments]
    out_path.write_text("\n".join(lines), encoding="utf-8")


# --------------------------------------------------------------------------
# 3. Selezione dei momenti migliori (Claude)
# --------------------------------------------------------------------------

HIGHLIGHT_SYSTEM_PROMPT = """Sei un editor esperto di contenuti social specializzato nel trasformare
video lunghi e istituzionali (in questo caso su temi di legge elettorale, politica, diritto pubblico)
in YouTube Shorts / Reels ad alto tasso di retention.

Analizzerai la trascrizione con timestamp di un video lungo e dovrai individuare i momenti che
funzionano meglio come clip autonome di 25-75 secondi. Cerca in particolare:

- affermazioni sorprendenti, controintuitive o "che non sapevi"
- numeri, statistiche o percentuali ad effetto
- dichiarazioni forti, polemiche o controverse
- domande retoriche che creano curiosita' ("sai cosa succederebbe se...")
- aneddoti concreti o esempi pratici (nomi di partiti, casi reali, paragoni)
- momenti in cui il relatore corregge un'idea sbagliata molto diffusa
- frasi ad effetto, quotabili, che stanno bene come titolo

Ogni clip deve avere un inizio e una fine che si reggono da sole anche senza il contesto del video
intero (evita di tagliare a meta' di un ragionamento). Preferisci iniziare la clip 1-3 secondi prima
della frase "gancio" per dare un minimo di contesto, e chiudere subito dopo la battuta/il concetto
forte, senza code morte.

Rispondi SOLO con un JSON valido (nessun testo fuori dal JSON), con questa struttura:

{
  "clips": [
    {
      "start": <secondi, float>,
      "end": <secondi, float>,
      "title": "<titolo breve e curioso per lo short, max 60 caratteri>",
      "hook": "<le primissime parole/il testo di apertura suggerito per il video, per massimizzare la retention nei primi 2 secondi>",
      "hashtags": ["#tag1", "#tag2", "#tag3"],
      "reason": "<1 frase sul perche' questo momento funziona>"
    }
  ]
}
"""


def _format_transcript_for_prompt(segments: list[Segment]) -> str:
    return "\n".join(f"[{s.start:.1f}-{s.end:.1f}] {s.text}" for s in segments)


def select_highlights(
    segments: list[Segment],
    api_key: str,
    model: str,
    max_clips: int,
) -> list[Clip]:
    """Chiede a Claude di scegliere i momenti migliori dalla trascrizione."""
    import anthropic

    print(f"[3/5] Chiedo a Claude ({model}) di scegliere i {max_clips} momenti migliori ...")
    client = anthropic.Anthropic(api_key=api_key)

    transcript_text = _format_transcript_for_prompt(segments)
    user_prompt = (
        f"Trascrizione (formato [inizio-fine in secondi] testo):\n\n{transcript_text}\n\n"
        f"Scegli al massimo {max_clips} clip, ordinate dalla piu' forte alla meno forte."
    )

    message = client.messages.create(
        model=model,
        max_tokens=4096,
        system=HIGHLIGHT_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )

    raw_text = "".join(block.text for block in message.content if block.type == "text")
    json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
    if not json_match:
        raise RuntimeError(f"Risposta di Claude non contiene JSON valido:\n{raw_text}")

    data = json.loads(json_match.group(0))
    clips = [
        Clip(
            start=float(c["start"]),
            end=float(c["end"]),
            title=c.get("title", "Short"),
            hook=c.get("hook", ""),
            hashtags=c.get("hashtags", []),
            reason=c.get("reason", ""),
        )
        for c in data.get("clips", [])[:max_clips]
    ]
    if not clips:
        raise RuntimeError("Claude non ha restituito nessuna clip.")
    return clips


# --------------------------------------------------------------------------
# 4. Sottotitoli animati (ASS) + taglio/reinquadratura verticale
# --------------------------------------------------------------------------

ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial Black,84,&H00FFFFFF,&H0000FFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,0,2,60,60,260,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

ACTIVE_COLOR = "&H0000D7FF&"  # giallo/oro in formato ASS (&HBBGGRR&)
DEFAULT_COLOR = "&H00FFFFFF&"  # bianco


def _fmt_ass_time(t: float) -> str:
    if t < 0:
        t = 0
    h = int(t // 3600)
    m = int((t % 3600) // 60)
    s = t % 60
    return f"{h:d}:{m:02d}:{s:05.2f}"


def _chunk_words(words: list[Word], max_words: int = 4, max_gap: float = 0.6) -> list[list[Word]]:
    """Raggruppa le parole in piccole frasi per i sottotitoli stile Shorts."""
    chunks: list[list[Word]] = []
    current: list[Word] = []
    for w in words:
        if current and (len(current) >= max_words or (w.start - current[-1].end) > max_gap):
            chunks.append(current)
            current = []
        current.append(w)
    if current:
        chunks.append(current)
    return chunks


def build_ass_subtitles(words_in_clip: list[Word], clip_start: float, out_path: Path) -> None:
    """Genera un file .ass con evidenziazione della parola attiva, stile Shorts."""
    events = []
    for chunk in _chunk_words(words_in_clip):
        chunk_text_plain = " ".join(w.text for w in chunk)
        for i, active_word in enumerate(chunk):
            start = active_word.start - clip_start
            end = active_word.end - clip_start
            if end <= start:
                end = start + 0.05

            parts = []
            for j, w in enumerate(chunk):
                color = ACTIVE_COLOR if j == i else DEFAULT_COLOR
                parts.append(f"{{\\c{color}}}{w.text}")
            text = " ".join(parts)

            events.append(
                f"Dialogue: 0,{_fmt_ass_time(start)},{_fmt_ass_time(end)},Default,,0,0,0,,{text}"
            )
        _ = chunk_text_plain  # tenuto per eventuale logging/debug

    out_path.write_text(ASS_HEADER + "\n".join(events) + "\n", encoding="utf-8")


def cut_clip_vertical_with_subs(
    source_video: Path,
    clip: Clip,
    words_in_clip: list[Word],
    out_path: Path,
    burn_captions: bool,
) -> None:
    """Taglia la clip, la reinquadra in verticale 9:16 e (opzionalmente) brucia i sottotitoli."""
    duration = clip.end - clip.start
    ass_path = out_path.with_suffix(".ass")

    # sfondo sfocato a schermo intero + video originale centrato sopra, in stile Shorts
    vf_parts = [
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,gblur=sigma=25[bg]",
        "[0:v]scale=1080:-2:force_original_aspect_ratio=decrease[fg]",
        "[bg][fg]overlay=(W-w)/2:(H-h)/2[base]",
    ]

    if burn_captions:
        build_ass_subtitles(words_in_clip, clip.start, ass_path)
        escaped_ass = str(ass_path).replace("\\", "/").replace(":", "\\:")
        vf_parts.append(f"[base]ass='{escaped_ass}'[outv]")
        final_label = "[outv]"
    else:
        final_label = "[base]"

    filter_complex = ";".join(vf_parts)

    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{clip.start:.3f}",
        "-i", str(source_video),
        "-t", f"{duration:.3f}",
        "-filter_complex", filter_complex,
        "-map", final_label,
        "-map", "0:a?",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-c:a", "aac", "-b:a", "160k",
        str(out_path),
    ]
    subprocess.run(cmd, check=True)


# --------------------------------------------------------------------------
# Utility: parole di un intervallo
# --------------------------------------------------------------------------

def words_between(segments: list[Segment], start: float, end: float) -> list[Word]:
    words: list[Word] = []
    for seg in segments:
        for w in seg.words:
            if w.end >= start and w.start <= end:
                words.append(w)
    return words


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Genera YouTube Shorts automaticamente da un video lungo.")
    parser.add_argument("--url", required=True, help="URL del video YouTube sorgente")
    parser.add_argument("--output-dir", default="./shorts_output", help="Cartella di output")
    parser.add_argument("--max-clips", type=int, default=5, help="Numero massimo di clip da generare")
    parser.add_argument("--whisper-model", default="medium", help="Dimensione modello faster-whisper (tiny/base/small/medium/large-v3)")
    parser.add_argument("--language", default="it", help="Lingua audio per la trascrizione")
    parser.add_argument(
        "--anthropic-model",
        default="claude-sonnet-4-5-20250929",
        help="Modello Anthropic da usare per scegliere i momenti migliori "
             "(controlla l'ultimo id valido su docs.claude.com/en/docs/about-claude/models)",
    )
    parser.add_argument("--no-captions", action="store_true", help="Non bruciare i sottotitoli nel video")
    parser.add_argument("--keep-source", action="store_true", help="Non cancellare il video sorgente scaricato")
    args = parser.parse_args()

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("Errore: imposta la variabile d'ambiente ANTHROPIC_API_KEY con la tua chiave Anthropic.")

    outdir = Path(args.output_dir)
    workdir = outdir / "_work"
    outdir.mkdir(parents=True, exist_ok=True)

    source_video = download_video(args.url, workdir)
    segments = transcribe(source_video, model_size=args.whisper_model, language=args.language)
    save_transcript(segments, outdir / "trascrizione_completa.txt")

    clips = select_highlights(segments, api_key=api_key, model=args.anthropic_model, max_clips=args.max_clips)

    print(f"[4/5] Taglio {len(clips)} clip e le reinquadro in verticale ...")
    metadata = []
    for i, clip in enumerate(clips, start=1):
        safe_title = re.sub(r"[^\w\-]+", "_", clip.title)[:40].strip("_") or f"short_{i}"
        out_file = outdir / f"{i:02d}_{safe_title}.mp4"
        clip_words = words_between(segments, clip.start, clip.end)
        cut_clip_vertical_with_subs(
            source_video=source_video,
            clip=clip,
            words_in_clip=clip_words,
            out_path=out_file,
            burn_captions=not args.no_captions,
        )
        metadata.append({
            "file": out_file.name,
            "start": clip.start,
            "end": clip.end,
            "title": clip.title,
            "hook": clip.hook,
            "hashtags": clip.hashtags,
            "reason": clip.reason,
        })
        print(f"    -> {out_file.name}  ({clip.start:.1f}s - {clip.end:.1f}s)  \"{clip.title}\"")

    (outdir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    if not args.keep_source:
        try:
            source_video.unlink()
        except OSError:
            pass

    print(f"[5/5] Fatto. Shorts e metadata salvati in: {outdir.resolve()}")


if __name__ == "__main__":
    main()
