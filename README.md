# Shorts Studio (interfaccia grafica)

App locale per creare Shorts scegliendo i tagli a mano su una timeline, come nell'editor di YouTube Studio.
Gira solo sul tuo computer: niente account, niente servizi a pagamento.

**Avvio:** doppio clic su `avvia.bat` (si apre il browser su http://127.0.0.1:8765).
Per fermarla chiudi la finestra nera.

- **Scarica / Carica file…**: aggiunge un video alla libreria (colonna a sinistra)
- **Timeline**: trascina su un'area vuota per selezionare, trascina le maniglie gialle per rifinire,
  trascina il riquadro giallo per spostarlo, clic semplice per saltare in quel punto.
  Ctrl+rotella = zoom, rotella = scorri.
- **Riquadro 9:16 sul player**: trascinalo per scegliere cosa inquadrare nello Short.
- **Tastiera**: spazio play/pausa · I inizio qui · O fine qui · P riproduci selezione · frecce ±1 s (Maiusc ±0,1 s)
- I file stanno in `library/<video>/` (gli Short in `library/<video>/shorts/`).

File: `app.py` (server e coda lavori), `media.py` (ffmpeg/yt-dlp), `static/` (interfaccia).

---

# Script a riga di comando (versione precedente, automatica con Claude)

Script che prende un video YouTube lungo (o la replica di una live) e genera in automatico
delle clip verticali 9:16 con sottotitoli animati bruciati nel video, scegliendo i momenti
più "intriganti" con l'aiuto di Claude.

## Come funziona (pipeline)

1. **Download** del video con `yt-dlp`.
2. **Trascrizione** con timestamp parola-per-parola usando `faster-whisper` (gira in locale,
   nessun costo per l'audio).
3. **Selezione dei momenti migliori**: la trascrizione con i timestamp viene mandata a Claude
   (Anthropic API), a cui viene chiesto di individuare fino a N clip da 25-75 secondi che
   funzionano bene come contenuto autonomo (affermazioni sorprendenti, numeri ad effetto,
   dichiarazioni forti, domande retoriche, aneddoti concreti...). Claude restituisce anche un
   titolo, un "hook" di apertura suggerito e gli hashtag per ogni clip.
4. **Taglio + reinquadratura verticale**: ogni clip viene tagliata con `ffmpeg`, riformattata in
   9:16 (sfondo sfocato + video centrato) e, se richiesto, vengono bruciati i sottotitoli con
   evidenziazione della parola attiva (stile TikTok/Reels).
5. **Output**: nella cartella scelta trovi gli mp4 pronti da caricare, la trascrizione completa
   e un `metadata.json` con titolo/hook/hashtag/motivazione di ogni clip.

## Installazione

```bash
# 1. Installa ffmpeg (se non c'è già)
#    macOS:   brew install ffmpeg
#    Ubuntu:  sudo apt install ffmpeg
#    Windows: https://ffmpeg.org/download.html

# 2. Crea un ambiente virtuale e installa le dipendenze Python
python3 -m venv venv
source venv/bin/activate   # su Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Serve una **API key Anthropic** (https://console.anthropic.com/ -> Settings -> API Keys).
Impostala come variabile d'ambiente:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
```

## Uso

```bash
python pipeline.py --url "https://www.youtube.com/watch?v=XXXXXXXX" \
    --output-dir ./shorts_output \
    --max-clips 5
```

Opzioni principali:

| Opzione              | Default                        | Descrizione                                                             |
|----------------------|---------------------------------|--------------------------------------------------------------------------|
| `--url`              | (obbligatorio)                  | URL del video YouTube sorgente                                          |
| `--output-dir`       | `./shorts_output`               | Cartella dove salvare gli shorts generati                               |
| `--max-clips`        | `5`                              | Numero massimo di clip da generare                                      |
| `--whisper-model`    | `medium`                        | Dimensione modello whisper: `tiny`/`base`/`small`/`medium`/`large-v3`    |
| `--anthropic-model`  | `claude-sonnet-4-5-20250929`    | Modello Claude usato per scegliere i momenti (verifica l'ultimo id su docs.claude.com) |
| `--no-captions`      | (spento)                        | Non bruciare i sottotitoli nel video                                    |
| `--keep-source`      | (spento)                        | Non cancellare il video sorgente scaricato dopo l'elaborazione          |

## Note pratiche

- **Prima esecuzione lenta**: `faster-whisper` scarica il modello scelto la prima volta (qualche
  centinaio di MB per `medium`). Le esecuzioni successive sono più veloci.
- **GPU opzionale**: se hai una GPU NVIDIA con CUDA, la trascrizione è molto più veloce. Lo script
  la rileva da solo (`device="auto"`); su CPU funziona comunque, solo più lentamente.
- **Costo Claude**: mandare la trascrizione di un video di ~1 ora a Claude costa tipicamente pochi
  centesimi di dollaro per l'analisi (dipende dalla lunghezza).
- **Qualità del taglio**: Claude sceglie gli inizio/fine dei segmenti in base al testo, non guarda
  il video. Rivedi sempre la clip generata prima di pubblicarla: a volte conviene spostare l'inizio
  di 1-2 secondi per un taglio più pulito (puoi farlo modificando `start`/`end` in `metadata.json`
  e rilanciando solo il passo di taglio, oppure con un editor video).
- **Font sottotitoli**: lo stile di default usa "Arial Black" in grande, con la parola attiva
  evidenziata in giallo/oro. Puoi cambiare font, colore e dimensione modificando la riga `Style:`
  in `pipeline.py` (funzione `ASS_HEADER`).
- **Se non hai una API key Anthropic**: puoi comunque generare `trascrizione_completa.txt` con lo
  script (limitandoti ai passi 1-2, commentando la chiamata a `select_highlights`) e incollare tu
  la trascrizione a Claude in chat chiedendo di indicarti i timestamp migliori; poi usa
  `cut_clip_vertical_with_subs` a mano per generare le clip.

## Adattare la selezione dei momenti al tuo canale

Il criterio di scelta è nel prompt `HIGHLIGHT_SYSTEM_PROMPT` dentro `pipeline.py`. Per un canale
sulla legge elettorale puoi affinarlo ulteriormente aggiungendo esempi concreti di clip che hanno
già funzionato bene sul tuo canale (Claude impara meglio da 2-3 esempi reali che da istruzioni
generiche).
