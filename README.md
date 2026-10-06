# Shorts Studio

App **locale** per creare **YouTube Shorts / Reels / TikTok** (video verticali 9:16) a partire da video
lunghi, con un'interfaccia grafica simile all'editor di YouTube Studio: player, timeline con miniature e
forma d'onda, selezione con le maniglie, sottotitoli automatici e anteprima dello Short in tempo reale.

Tutto gira sul tuo PC: niente account, niente servizi a pagamento, nessun video caricato su server esterni.

Nata per il canale YouTube [@iniziativepop](https://www.youtube.com/@iniziativepop) (video in italiano su
legge elettorale e iniziative popolari), funziona con qualsiasi video parlato in italiano.

---

## Indice

- [Cosa fa](#cosa-fa)
- [Requisiti](#requisiti)
- [Installazione](#installazione)
- [Avvio](#avvio)
- [Come si usa](#come-si-usa)
- [Scorciatoie da tastiera](#scorciatoie-da-tastiera)
- [Dove finiscono i file](#dove-finiscono-i-file)
- [Personalizzare](#personalizzare)
- [Tempi indicativi](#tempi-indicativi)
- [Problemi comuni](#problemi-comuni)
- [Struttura del progetto](#struttura-del-progetto)
- [Privacy](#privacy)
- [Script a riga di comando (versione precedente)](#script-a-riga-di-comando-versione-precedente)

---

## Cosa fa

**Libreria video**
- Scarica un video da un URL di YouTube (fino a 1080p) oppure carica un file dal computer (mp4, mov, m4v, webm, mkv).
- Più video in libreria: si passa dall'uno all'altro con un clic; si eliminano con il cestino (con conferma).
- Se l'app viene chiusa a metà di un download o di un'elaborazione, alla riapertura riprende da sola.

**Timeline e selezione**
- Player, timeline con miniature e forma d'onda audio, zoom (Ctrl+rotella).
- Testina bianca indipendente: clic o trascinamento ovunque sposta solo la posizione di riproduzione.
- Selezione del tratto con le maniglie gialle, oppure scrivendo inizio/fine (`83.4` o `1:23.4`).

**Trascrizione automatica**
- Con [Whisper](https://github.com/SYSTRAN/faster-whisper) (modello `small`), in italiano, con i tempi di ogni parola. Gira sul processore, non serve una scheda video.
- Parte da sola dopo ogni download; intanto si può continuare a lavorare.
- Le parole si correggono con un doppio clic.

**Clip suggeriti**
- Propone in automatico tratti da 30 a 90 secondi (circa uno ogni 6 minuti di video), scelti in base a pause, frasi intere, ritmo del parlato e **parole chiave** (modificabili dall'app).
- Appaiono come barre viola numerate sulla timeline e come schede con punteggio e motivazioni; si possono ordinare per punteggio o in ordine cronologico.
- "Genera altri suggerimenti" ne aggiunge di nuovi, senza ripetere quelli già proposti o già usati.

**Formato verticale 1080×1920**
- **Ritaglio 9:16**: si sceglie quale parte del video orizzontale inquadrare, trascinando un riquadro sul player.
  - **Inquadratura dinamica**: "Segui il volto" muove l'inquadratura seguendo la testa di chi parla (senza tremolii); oppure si ricentra a mano in qualunque momento.
- **Blur fill 9:16**: il video resta intero al centro, sopra e sotto lo stesso video ingrandito e sfocato.
- **Anteprima dello Short** accanto al player, disegnata in tempo reale come verrà esportata.

**Sottotitoli e titolo**
- Sottotitoli "bruciati" nel video in stile Shorts: 2-3 parole alla volta, la parola detta evidenziata in giallo. Posizione verticale regolabile (default 65%, sopra pulsanti e didascalie di YouTube).
- Titolo fisso opzionale (es. il nome del programma): testo, carattere, dimensione, colore, fascia colorata, posizione.

**Editor degli Short già creati**
- "Modifica" su uno Short: correggi il testo dei sottotitoli parola per parola e **taglia parole o frasi** direttamente dal video (i sottotitoli restano sincronizzati).
- Le parole da tagliare restano barrate finché non premi "Applica modifiche"; si può ascoltare il risultato prima e tornare alla versione precedente.

---

## Requisiti

| | |
|---|---|
| Sistema | **Windows 10 o 11** (l'avvio usa un file `.bat` e i caratteri dei sottotitoli sono quelli di Windows) |
| Python | **3.11 o più recente** |
| ffmpeg | versione **"full"** (serve il supporto ai sottotitoli, `libass`) |
| Memoria | consigliati **8 GB di RAM** o più (durante una trascrizione l'app usa circa 3 GB) |
| Disco | circa **2 GB** per librerie e modelli, più lo spazio dei video |
| Internet | per scaricare i video da YouTube e, la prima volta, librerie e modelli |

Non serve una scheda video dedicata.

---

## Installazione

### 1. Installa Python

Scaricalo da [python.org/downloads](https://www.python.org/downloads/) e avvia l'installazione.
**Importante:** nella prima schermata spunta la casella **"Add python.exe to PATH"**.

### 2. Installa ffmpeg

Il modo più semplice: apri il **Prompt dei comandi** (o PowerShell) e scrivi

```
winget install Gyan.FFmpeg
```

In alternativa scarica `ffmpeg-release-full.7z` da [gyan.dev/ffmpeg/builds](https://www.gyan.dev/ffmpeg/builds/),
estrailo (per esempio in `C:\ffmpeg`) e aggiungi la cartella `bin` alla variabile di sistema PATH.

Per controllare che sia tutto a posto, apri **un nuovo** Prompt dei comandi e scrivi:

```
python --version
ffmpeg -version
```

Entrambi devono rispondere con un numero di versione.

### 3. Scarica Shorts Studio

- Su questa pagina GitHub: pulsante verde **Code → Download ZIP**, poi estrai lo ZIP in una cartella a tua scelta;
- oppure, se usi git: `git clone https://github.com/xtvanleiden/shortsyoutube.git`

---

## Avvio

**Doppio clic su `avvia.bat`.**

- La **prima volta** crea un ambiente Python nella cartella `venv` e installa le librerie (Flask, faster-whisper,
  OpenCV, yt-dlp…): servono alcuni minuti e una connessione a Internet.
- Poi si apre il browser su **http://127.0.0.1:8765**. Se non si apre, apri tu quell'indirizzo.
- Si apre anche una **finestra nera**: è il "motore" dell'app. Finché resta aperta l'app funziona;
  **chiudila per spegnere l'app**.

Comodo: crea un collegamento a `avvia.bat` sul desktop (tasto destro → *Mostra altre opzioni* → *Invia a* →
*Desktop*). Nella cartella `static` c'è anche un'icona, `icona.ico`, che puoi assegnare al collegamento.

Al **primo utilizzo** di alcune funzioni l'app scarica da sola:
- il modello di Whisper per la trascrizione (circa 500 MB, alla prima trascrizione);
- il modello per riconoscere i volti (230 KB, al primo "Segui il volto").

---

## Come si usa

1. **Aggiungi un video**: incolla l'URL di YouTube in alto e premi *Scarica* (oppure *Carica file…*).
   La barra in alto a destra mostra l'avanzamento: download, miniature e forma d'onda, poi trascrizione.
2. **Scegli il tratto**:
   - clicca una barra viola (clip suggerito) oppure una scheda in *Clip suggeriti* → *Usa questo*;
   - rifinisci con le maniglie gialle sulla timeline, *▶ Selezione* per riascoltare.
3. **Imposta lo Short** (pannello sotto la timeline, *Impostazioni dello Short*):
   - *Formato*: *Ritaglio 9:16* oppure *Blur fill 9:16*;
   - *Inquadratura*: fissa (trascina il riquadro giallo sul video) oppure dinamica (*Segui il volto*);
   - *Titolo fisso* e posizione dei *Sottotitoli*.
   Guarda l'*Anteprima Short* accanto al player: è come verrà il video.
4. **Correggi il testo** se serve: nel pannello *Testo della selezione*, doppio clic su una parola.
5. **Crea Short**. Il video compare nella colonna di destra: lì lo rivedi, lo **scarichi** o lo **modifichi**.
6. **Modifica** (facoltativo): correggi parole o tagliane alcune (si cliccano, poi tasto *Canc*),
   *▶ Ascolta con i tagli*, poi *Applica modifiche*. *⟲ Versione precedente* annulla l'ultima modifica.

Il pulsante **?** accanto allo zoom riassume i comandi della timeline. La barra orizzontale tra la parte
alta e il pannello sotto si trascina per cambiare l'altezza del video.

---

## Scorciatoie da tastiera

| Tasto | Azione |
|---|---|
| Spazio | Play / pausa |
| I | Inizio della selezione nel punto attuale |
| O | Fine della selezione nel punto attuale |
| P | Riproduci solo la selezione |
| ← / → | Indietro / avanti di 1 secondo (con Maiusc: 0,1 secondi) |
| Ctrl + rotella | Zoom della timeline |
| Maiusc + trascina | Nuova selezione sulla timeline |
| Canc | Nell'editor dello Short: segna da tagliare le parole selezionate |

---

## Dove finiscono i file

Tutto resta nella cartella del programma:

```
library/
  <id-video>/
    source.mp4          il video originale
    meta.json           titolo, durata, stato
    thumbs/             miniature della timeline
    peaks.json          forma d'onda
    transcript.json     trascrizione (con le correzioni)
    suggerimenti.json   clip suggeriti
    inquadratura.json   punti dell'inquadratura dinamica
    shorts/             gli Short creati (.mp4) e le loro "ricette" per l'editor
impostazioni.json       parole chiave dei clip suggeriti
modelli/                modello per il riconoscimento dei volti
```

Il modello di Whisper viene salvato nella cache di Hugging Face (`%USERPROFILE%\.cache\huggingface`).
Eliminando un video dall'app si cancella tutta la sua cartella, Short compresi: **scarica prima gli Short
che vuoi tenere**.

---

## Personalizzare

- **Parole chiave dei clip suggeriti**: direttamente dall'app (*Clip suggeriti → Parole chiave*).
- **Parole che Whisper deve riconoscere** (nomi propri, sigle): `WHISPER_PROMPT` in `media.py`.
- **Qualità/velocità della trascrizione**: `WHISPER_MODEL` in `media.py` (`small` di base; `medium` è più
  preciso ma circa 3 volte più lento).
- **Cosa conta di più nei clip suggeriti**: i pesi `PESI` all'inizio di `suggest.py`; durata ammessa
  (`MIN_LEN`, `MAX_LEN`) e quanti suggerimenti (`MINUTES_PER_SUGGESTION`).
- **Stile dei sottotitoli** (carattere, dimensione, colori): `ASS_HEADER` in `media.py`.
- **Seguire il volto** (quanto si muove la testa prima che la camera la segua): `DEADZONE` in `media.py`.

Dopo aver modificato un file `.py`, chiudi la finestra nera e riavvia con `avvia.bat`.

Per usi avanzati, le variabili d'ambiente `SHORTS_LIBRARY` (cartella della libreria) e `SHORTS_PORT`
(porta, di base 8765) permettono di avviare una seconda copia separata dell'app.

---

## Tempi indicativi

Misurati su un PC con processore a 12 core, senza scheda video dedicata:

| Operazione | Tempo |
|---|---|
| Trascrizione | circa 15 minuti per un'ora di video |
| Miniature e forma d'onda | da pochi secondi a qualche minuto, secondo la durata del video |
| Esportazione di uno Short di 60 s | 10-40 secondi |
| "Segui il volto" | circa 8 secondi per minuto di video |

---

## Problemi comuni

**La finestra nera si chiude subito o scrive "Mancano ffmpeg, ffprobe"**
ffmpeg non è installato o non è nel PATH: vedi [Installazione](#2-installa-ffmpeg). Dopo averlo installato
apri una nuova finestra (o riavvia il PC).

**"python non è riconosciuto…" / "Qualcosa è andato storto"**
Python non è installato o manca la spunta *Add python.exe to PATH*: reinstallalo e spunta la casella.

**Il download da YouTube fallisce ("timed out", errore 403)**
YouTube a volte risponde lentamente o rifiuta per un po'. Il video risulta *Errore* nella lista:
cliccalo per riprovare, magari dopo qualche minuto. Se succede sempre, aggiorna yt-dlp: nella cartella del
programma esegui `venv\Scripts\python -m pip install -U yt-dlp`.

**Mancano pezzi di trascrizione**
Le trascrizioni fatte con versioni vecchie dell'app potevano saltare dei tratti: l'app lo segnala e
propone *Ritrascrivi*.

**Un taglio nell'editor lascia mezza sillaba**
Succede quando le parole sono pronunciate senza pausa (i tempi di Whisper sono precisi a ±0,1-0,2 s).
Ascolta con *▶ Ascolta con i tagli* prima di applicare e, se serve, taglia una parola in più o in meno.

**Il PC rallenta durante la trascrizione**
È normale: Whisper usa tutto il processore. Finita la coda delle trascrizioni la memoria viene liberata.

**L'indirizzo 127.0.0.1:8765 non risponde**
Controlla che la finestra nera sia aperta e senza errori. Se la porta è occupata da un altro programma,
avvia con un'altra porta impostando `SHORTS_PORT`.

---

## Struttura del progetto

| File | Contenuto |
|---|---|
| `avvia.bat` | Avvio con doppio clic (crea l'ambiente Python, installa le librerie, avvia l'app) |
| `app.py` | Server web locale (Flask), libreria video, coda dei lavori |
| `media.py` | Tutto il lavoro sui video: download, trascrizione, miniature, sottotitoli, ritaglio, tagli, volti |
| `suggest.py` | Regole dei clip suggeriti |
| `static/` | Interfaccia: `index.html`, `app.js`, `style.css`, `icona.ico` |
| `pipeline.py` | Vecchio script a riga di comando (vedi sotto) |
| `requirements.txt` | Librerie Python necessarie |

---

## Privacy

L'app gira solo sul tuo computer ed è raggiungibile solo da lì (indirizzo `127.0.0.1`). Si collega a Internet
soltanto per:
- scaricare i video da YouTube (yt-dlp);
- la prima volta, le librerie Python (PyPI), il modello di Whisper (Hugging Face) e quello dei volti (GitHub).

Trascrizioni, Short e impostazioni restano nella cartella del programma.

---

## Script a riga di comando (versione precedente)

`pipeline.py` è la prima versione del progetto, **senza interfaccia**: scarica un video, lo trascrive, chiede
a Claude (API di Anthropic) di scegliere i momenti migliori e genera gli Short in automatico. A differenza
dell'app, **richiede una chiave API di Anthropic (a pagamento)**.

```
set ANTHROPIC_API_KEY=sk-ant-...
venv\Scripts\python pipeline.py --url "https://www.youtube.com/watch?v=XXXXXXXX" --output-dir shorts_output --max-clips 5
```

Opzioni principali: `--max-clips`, `--whisper-model`, `--anthropic-model`, `--no-captions`, `--keep-source`
(elenco completo con `--help`). Il criterio di scelta dei momenti è nel testo `HIGHLIGHT_SYSTEM_PROMPT`
dentro `pipeline.py`.
