"""
Suggerimento automatico dei clip, con regole semplici sulla trascrizione (niente IA).

Come ragiona:
  1. divide il parlato in frasi (punteggiatura o pause)
  2. prova tutti i segmenti da 30 a 90 secondi che iniziano e finiscono con una frase intera
  3. dà un punteggio a ciascuno:
       - pausa lunga PRIMA dell'inizio  -> probabile cambio di argomento, il clip parte "pulito"
       - la frase precedente si chiude col punto -> non si parte a metà di un ragionamento
       - pausa DOPO la fine e frase chiusa dal punto -> il discorso si conclude
       - parlato più fitto della media del video -> momento vivace
       - parole chiave (configurabili dalla GUI), con bonus se compaiono nei primi secondi
       - lunghezza ideale 40-65 secondi
       - penalità per silenzi lunghi dentro il clip
  4. sceglie i migliori senza sovrapposizioni: circa uno ogni 6 minuti di video (minimo 3).
     "Genera altri" ripete la scelta escludendo i tratti già proposti o già usati per uno Short.

I pesi sono qui sotto in PESI: aumentali o diminuiscili per cambiare cosa conta di più.
"""

import re
import unicodedata

MIN_LEN, MAX_LEN = 30.0, 90.0          # durata ammessa di un clip (secondi)
IDEAL_MIN, IDEAL_MAX = 40.0, 65.0      # durata preferita
SENTENCE_GAP = 0.7                     # una pausa più lunga chiude la frase
PAUSE_FULL = 2.0                       # pausa che vale il punteggio pieno
HOOK_SECONDS = 8.0                     # "gancio": parola chiave nei primi secondi

PESI = {
    "pausa_inizio": 2.0,
    "inizio_frase": 1.5,
    "pausa_fine": 1.0,
    "frase_chiusa": 0.5,
    "parlato_vivace": 1.5,
    "parole_chiave": 2.5,
    "gancio": 1.0,
    "durata_ideale": 0.5,
    "silenzi_interni": -2.0,
}

DEFAULT_KEYWORDS = [
    "Iniziative POP",
    "legge elettorale",
    "referendum",
    "firme",
    "importante",
    "fondamentale",
    "dovete sapere",
    "non tutti sanno",
    "attenzione",
    "il punto è",
    "la verità",
    "vi spiego",
    "ecco perché",
    "democrazia",
    "costituzione",
]


def normalize(text: str) -> str:
    """minuscolo, senza accenti né punteggiatura: 'Perché?' -> 'perche'"""
    text = unicodedata.normalize("NFKD", text.lower())
    text = "".join(c for c in text if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def split_sentences(words: list[dict]) -> list[dict]:
    """Raggruppa le parole in frasi. Se Whisper non mette punti, spezza comunque le frasi troppo lunghe."""
    sents: list[dict] = []
    start = 0
    for i, w in enumerate(words):
        last = i == len(words) - 1
        gap = 0.0 if last else words[i + 1]["s"] - w["e"]
        length = w["e"] - words[start]["s"]
        if (last or gap > SENTENCE_GAP or w["w"][-1:] in ".?!"
                or (length > 20 and gap > 0.25) or length > 30):
            chunk = words[start:i + 1]
            sents.append({
                "s": chunk[0]["s"], "e": chunk[-1]["e"], "i0": start, "i1": i,
                "text": " ".join(x["w"] for x in chunk),
                "closed": chunk[-1]["w"][-1:] in ".?!",
            })
            start = i + 1
    return sents


def _keyword_hits(norm_text: str, keywords: list[tuple[str, str]]) -> list[str]:
    padded = f" {norm_text} "
    hits = []
    for original, norm in keywords:
        hits += [original] * padded.count(f" {norm} ")
    return hits


MINUTES_PER_SUGGESTION = 6    # un suggerimento ogni 6 minuti di video
MIN_SUGGESTIONS, MAX_SUGGESTIONS = 3, 25
MORE_BATCH = 5                 # quanti ne aggiunge "Genera altri suggerimenti"


def target_count(video_duration: float) -> int:
    n = round(video_duration / (MINUTES_PER_SUGGESTION * 60))
    return max(MIN_SUGGESTIONS, min(MAX_SUGGESTIONS, n))


def suggest(words: list[dict], keywords: list[str], video_duration: float,
            exclude: list[tuple[float, float]] = (), count: int | None = None) -> list[dict]:
    """
    `exclude`: tratti (inizio, fine) da non riproporre (suggerimenti già mostrati, Short già fatti).
    `count`: quanti cercarne (se manca, dipende dalla durata del video).
    """
    sents = split_sentences(words)
    if not sents or sents[-1]["e"] - sents[0]["s"] < MIN_LEN:
        return []

    kw = [(k.strip(), normalize(k)) for k in keywords if normalize(k)]
    for s in sents:
        s["hits"] = _keyword_hits(normalize(s["text"]), kw)

    n = len(sents)
    before = [PAUSE_FULL if i == 0 else sents[i]["s"] - sents[i - 1]["e"] for i in range(n)]
    after = [PAUSE_FULL if i == n - 1 else sents[i + 1]["s"] - sents[i]["e"] for i in range(n)]
    avg_density = len(words) / max(1.0, words[-1]["e"] - words[0]["s"])

    candidates = []
    for i in range(n):
        for j in range(i, n):
            start, end = sents[i]["s"], sents[j]["e"]
            length = end - start
            if length > MAX_LEN:
                break
            if length < MIN_LEN:
                continue

            n_words = sents[j]["i1"] - sents[i]["i0"] + 1
            density = n_words / length
            dead = sum(max(0.0, sents[k]["s"] - sents[k - 1]["e"] - 1.0) for k in range(i + 1, j + 1))
            hits = [h for k in range(i, j + 1) for h in sents[k]["hits"]]
            hook = [h for k in range(i, j + 1) if sents[k]["s"] < start + HOOK_SECONDS for h in sents[k]["hits"]]

            parts = {
                "pausa_inizio": min(before[i], PAUSE_FULL) / PAUSE_FULL,
                "inizio_frase": 1.0 if i == 0 or sents[i - 1]["closed"] else 0.0,
                "pausa_fine": min(after[j], PAUSE_FULL) / PAUSE_FULL,
                "frase_chiusa": 1.0 if sents[j]["closed"] else 0.0,
                "parlato_vivace": min(1.0, max(0.0, (density / avg_density - 0.8) / 0.4)),
                "parole_chiave": min(len(hits), 4) / 4,
                "gancio": 1.0 if hook else 0.0,
                "durata_ideale": 1.0 if IDEAL_MIN <= length <= IDEAL_MAX else 0.5,
                "silenzi_interni": min(dead / 5.0, 1.0),
            }
            score = sum(PESI[k] * v for k, v in parts.items())
            candidates.append({"i": i, "j": j, "start": start, "end": end, "score": score,
                               "parts": parts, "hits": hits, "hook": hook,
                               "density": density, "before": before[i], "first": i == 0})

    # i migliori senza sovrapposizioni
    target = count or target_count(video_duration)
    # si tollera mezzo secondo di contatto ai bordi, non di più
    blocked = [(a + 0.5, b - 0.5) for a, b in exclude]
    chosen: list[dict] = []
    for c in sorted(candidates, key=lambda c: c["score"], reverse=True):
        if any(c["start"] < b and c["end"] > a for a, b in blocked):
            continue
        if all(c["end"] <= o["start"] or c["start"] >= o["end"] for o in chosen):
            chosen.append(c)
            if len(chosen) == target:
                break

    best_possible = sum(v for v in PESI.values() if v > 0)
    result = []
    for rank, c in enumerate(chosen, start=1):
        result.append({
            "rank": rank,
            "start": round(c["start"], 2),
            "end": round(c["end"], 2),
            "score": round(100 * max(0.0, c["score"]) / best_possible),
            "reasons": _reasons(c, avg_density),
            "preview": " ".join(sents[k]["text"] for k in range(c["i"], min(c["j"] + 1, c["i"] + 2)))[:160],
        })
    return result


def _reasons(c: dict, avg_density: float) -> list[str]:
    """Spiegazione in parole semplici del perché il clip è stato scelto."""
    reasons = []
    if c["hits"]:
        unique = list(dict.fromkeys(c["hits"]))
        reasons.append("Parole chiave: " + ", ".join(unique[:4]) + ("…" if len(unique) > 4 else ""))
    if c["hook"]:
        reasons.append("Parola chiave nei primi secondi")
    if c["first"]:
        reasons.append("Apertura del video")
    elif c["before"] >= 1.0:
        reasons.append(f"Inizia dopo una pausa di {c['before']:.1f} s (cambio di argomento?)")
    if not c["first"] and not c["parts"]["inizio_frase"]:
        reasons.append("Attenzione: potrebbe iniziare a metà frase")
    if c["parts"]["parlato_vivace"] >= 0.5:
        reasons.append(f"Parlato vivace: {c['density']:.1f} parole/s (media {avg_density:.1f})")
    if c["parts"]["frase_chiusa"] and c["parts"]["pausa_fine"] >= 0.5:
        reasons.append("Finisce a fine frase, con una pausa")
    if c["parts"]["silenzi_interni"] > 0.3:
        reasons.append("Attenzione: contiene silenzi lunghi")
    return reasons
