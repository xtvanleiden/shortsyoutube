"use strict";

/*
 * Shorts Studio – interfaccia.
 *
 * La timeline è fatta così:
 *   #tl-scroll   contenitore con la barra di scorrimento orizzontale
 *   #tl-inner    largo quanto tutto il video allo zoom attuale (durata × pixel al secondo)
 *   #tl-canvas   disegna SOLO la parte visibile (righello, miniature, forma d'onda):
 *                così resta veloce anche con video di ore
 *   #tl-sel      il riquadro giallo della selezione, con le due maniglie
 *   #tl-playhead la linea bianca della posizione attuale
 */

const $ = (id) => document.getElementById(id);

const PAD = 16;          // margine ai lati della timeline (spazio per le maniglie)
const RULER_H = 20;
const LANE_H = 18;       // corsia dei clip suggeriti, sotto il righello
const TRACK_Y = RULER_H + LANE_H;
const THUMB_H = 64;
const TL_H = 168;
const WAVE_H = TL_H - TRACK_Y - THUMB_H;
const MIN_SEL = 0.5;     // durata minima della selezione (secondi)
const MAX_PPS = 200;     // zoom massimo (pixel per secondo)
const MAX_SHORT = 180;   // YouTube Shorts: massimo 3 minuti

const el = {
  player: $("player"), playerBox: $("player-box"), cropBox: $("crop-box"),
  scroll: $("tl-scroll"), inner: $("tl-inner"), canvas: $("tl-canvas"),
  sel: $("tl-sel"), playhead: $("tl-playhead"),
  inStart: $("in-start"), inEnd: $("in-end"), zoom: $("zoom"),
  mode: $("mode"), cropX: $("crop-x"),
};
const ctx = el.canvas.getContext("2d");

const state = {
  videos: [],
  video: null,          // video aperto (meta + thumbs + shorts)
  peaks: null,          // { rate, peaks: [...] }
  sheets: [],           // immagini dei fogli di miniature
  pps: 10,              // zoom attuale: pixel per secondo
  sel: { start: 0, end: 30 },
  cropX: 0.5,
  playSel: false,       // riproduzione limitata alla selezione
  drag: null,
  pendingOpen: null,    // video da aprire quando finisce il download
  seenJobs: {},
  doneAt: {},
  dismissedJobs: new Set(),
  uploads: [],
  transcript: null,     // { words: [{ s, e, w }] }
  suggestions: [],
  frame: { dynamic: false, keys: [] },   // inquadratura: punti {t, x, d, m} (vedi media.py)
  cropDragX: null,      // posizione del riquadro mentre lo trascini      // clip suggeriti: [{ rank, start, end, score, reasons, preview }]
  subY: 0.8,            // altezza del centro dei sottotitoli (0 = in alto, 1 = in basso)
  guideUntil: 0,        // fino a quando mostrare l'anteprima di posizione (dopo una modifica)
  chunks: [],           // gruppi di 2-3 parole, come nei sottotitoli esportati
};

// ---------------------------------------------------------------------------
// Utilità
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const duration = () => (state.video ? state.video.duration : 0);

function fmt(t, decimals = 2) {
  if (!isFinite(t)) t = 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Accetta "83.4", "83,4", "1:23.4", "1:02:03.5". Restituisce i secondi o NaN. */
function parseTime(str) {
  const parts = String(str).trim().replace(",", ".").split(":");
  if (parts.length > 3 || parts.some((p) => p === "" || isNaN(Number(p)))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

async function api(url, opts = {}) {
  if (opts.json !== undefined) {
    opts = { ...opts, method: opts.method || "POST", headers: { "Content-Type": "application/json" },
             body: JSON.stringify(opts.json) };
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* ignora */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Libreria video (colonna di sinistra)
// ---------------------------------------------------------------------------

const STATUS_LABEL = { downloading: "Download…", processing: "Elaborazione…", error: "Errore" };

async function loadVideos() {
  state.videos = await api("/api/videos");
  renderVideoList();
}

function renderVideoList() {
  const list = $("video-list");
  if (!state.videos.length) {
    list.innerHTML = '<li class="disabled muted">Nessun video ancora.</li>';
    return;
  }
  list.innerHTML = state.videos.map((v) => {
    const ready = v.status === "ready";
    const active = state.video && state.video.id === v.id;
    const metaText = ready ? fmt(v.duration, 0) : (STATUS_LABEL[v.status] || v.status);
    return `<li data-id="${escapeHtml(v.id)}" class="${active ? "active" : ""} ${ready ? "" : "disabled"}"
                title="${escapeHtml(v.error || v.title)}">
      <div class="v-title">${escapeHtml(v.title)}</div>
      <div class="v-meta ${v.status === "error" ? "error" : ""}">${escapeHtml(metaText)}
        <span class="v-size">${v.size ? fmtSize(v.size) : ""}</span></div>
      <button class="v-del" title="Elimina questo video dal computer" aria-label="Elimina video"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg></button>
    </li>`;
  }).join("");
}

function fmtSize(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

$("video-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  if (e.target.closest(".v-del")) deleteVideo(li.dataset.id);
  else if (!li.classList.contains("disabled")) openVideo(li.dataset.id);
});

async function deleteVideo(id) {
  const v = state.videos.find((x) => x.id === id);
  if (!v) return;
  let msg = `Eliminare "${v.title}"?\n\nVerranno cancellati dal computer il video, la trascrizione, ` +
            `le miniature e la forma d'onda (${fmtSize(v.size || 0)} in tutto).`;
  if (v.shorts_count) {
    msg += `\n\nATTENZIONE: ${v.shorts_count === 1 ? "verrà eliminato anche 1 Short creato" :
           `verranno eliminati anche ${v.shorts_count} Short creati`} da questo video. Se ti servono, scaricali prima.`;
  }
  if (!confirm(msg)) return;

  // Il player tiene aperto il file: va "scollegato" prima, altrimenti Windows non lo lascia cancellare
  const wasOpen = state.video && state.video.id === id;
  if (wasOpen) closeVideo();

  try {
    await api(`/api/videos/${id}`, { method: "DELETE" });
  } catch (err) {
    alert(err.message);
    await loadVideos();
    if (wasOpen) openVideo(id);   // non è stato cancellato: lo riapro com'era
    return;
  }
  await loadVideos();
  if (wasOpen) {
    const next = state.videos.find((x) => x.status === "ready");
    if (next) openVideo(next.id);
  }
}

/** Chiude il video aperto e torna alla schermata iniziale. */
function closeVideo() {
  el.player.pause();
  el.player.removeAttribute("src");
  el.player.load();
  $("shorts-list").innerHTML = '<p class="muted">Nessuno Short per questo video.</p>';
  $("tl-sugs").innerHTML = "";
  state.video = null;
  state.transcript = null;
  state.chunks = [];
  state.suggestions = [];
  state.playSel = false;
  store("lastVideo", "");
  $("workspace").hidden = true;
  $("empty").hidden = false;
  renderVideoList();
}

let openingId = null;

async function openVideo(id) {
  // già aperto (o in apertura): non ripartire da capo, si perderebbe la selezione
  if (openingId === id || (state.video && state.video.id === id)) return;
  openingId = id;
  let v;
  try { v = await api(`/api/videos/${id}`); } catch { v = null; }
  if (openingId !== id) return;   // nel frattempo è stato scelto un altro video
  openingId = null;
  if (!v || v.status !== "ready") return;

  state.video = v;
  state.playSel = false;
  store("lastVideo", id);

  $("empty").hidden = true;
  $("workspace").hidden = false;
  $("video-title").textContent = v.title;
  $("time-total").textContent = fmt(v.duration, 0);
  el.player.src = `/media/${id}/${encodeURIComponent(v.file)}`;

  const t = v.thumbs || { sheets: [] };
  state.sheets = t.sheets.map((name) => {
    const img = new Image();
    img.onload = requestDraw;
    img.src = `/media/${id}/thumbs/${name}`;
    return img;
  });
  state.peaks = null;
  api(`/api/videos/${id}/peaks`).then((p) => {
    if (state.video && state.video.id === id) { state.peaks = p; requestDraw(); }
  });

  state.sel = { start: 0, end: Math.min(30, v.duration) };
  state.cropX = 0.5;
  el.cropX.value = 0.5;
  el.scroll.scrollLeft = 0;
  setPps(viewSpan() / Math.min(v.duration, 300), 0, 0);
  updateSelectionUI();
  updateCropBox();
  state.suggestions = [];
  state.suggestionsReady = false;
  renderShorts(v.shorts);
  renderVideoList();
  loadTranscript();
  loadFrame();
}

// ---------------------------------------------------------------------------
// Aggiungere video: URL YouTube o file dal computer
// ---------------------------------------------------------------------------

$("url-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("url-input");
  const btn = e.submitter;
  btn.disabled = true;
  try {
    const res = await api("/api/videos/url", { json: { url: input.value } });
    input.value = "";
    if (res.already) openVideo(res.video_id);
    else state.pendingOpen = res.video_id;
    await loadVideos();
    pollJobs();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

$("file-input").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  // XMLHttpRequest invece di fetch per avere la percentuale di caricamento
  const upload = { name: file.name, progress: 0 };
  state.uploads.push(upload);
  renderJobs(state.lastJobs || []);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/videos/upload?name=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) { upload.progress = ev.loaded / ev.total; renderJobs(state.lastJobs || []); }
  };
  xhr.onloadend = async () => {
    state.uploads = state.uploads.filter((u) => u !== upload);
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch { /* ignora */ }
    if (xhr.status !== 200) {
      alert(data.error || "Caricamento non riuscito");
    } else {
      state.pendingOpen = data.video_id;
      await loadVideos();
    }
    pollJobs();
  };
  xhr.send(file);
});

// ---------------------------------------------------------------------------
// Lavori in corso (in alto a destra)
// ---------------------------------------------------------------------------

let pollTimer = null;

async function pollJobs() {
  clearTimeout(pollTimer);
  try {
    const jobs = await api("/api/jobs");
    state.lastJobs = jobs;
    for (const job of jobs) {
      const before = state.seenJobs[job.id];
      const finished = job.status === "done" || job.status === "error";
      // al primo controllo ignoriamo i lavori già finiti in una sessione precedente
      if (finished && before !== job.status && (before || state.jobsLoaded)) onJobFinished(job);
      state.seenJobs[job.id] = job.status;
    }
    state.jobsLoaded = true;
    renderJobs(jobs);
    updateTranscriptStatus();
  } catch { /* server momentaneamente non raggiungibile */ }
  pollTimer = setTimeout(pollJobs, 1500);
}

async function onJobFinished(job) {
  if (job.kind === "reframe") {
    if (state.video && state.video.id === job.video_id) await loadFrame();
    const msg = $("track-msg");
    msg.hidden = false;
    if (job.status === "error") {
      msg.className = "small-text warn";
      msg.textContent = "Errore: " + job.error;
    } else if (job.result && job.result.warning) {
      msg.className = "small-text warn";
      msg.textContent = job.result.warning;
    } else if (job.result) {
      msg.className = "small-text ok";
      msg.textContent = `Fatto: volto trovato nel ${Math.round(job.result.coverage * 100)}% dei fotogrammi. ` +
                        "Premi ▶ Selezione per vedere il movimento.";
    }
    return;
  }
  if (job.kind === "transcribe") {
    if (state.video && state.video.id === job.video_id) {
      const v = await api(`/api/videos/${job.video_id}`);
      state.video.transcript = v.transcript;
      loadTranscript();
    }
    return;
  }
  if (job.kind === "short") {
    if (state.video && state.video.id === job.video_id) {
      const v = await api(`/api/videos/${job.video_id}`);
      state.video.shorts = v.shorts;
      renderShorts(v.shorts);
      renderSuggestions();
    }
    return;
  }
  await loadVideos();
  if (job.status === "done" && state.pendingOpen === job.video_id) {
    state.pendingOpen = null;
    openVideo(job.video_id);
  }
}

function renderJobs(jobs) {
  // i lavori completati restano visibili per qualche secondo, gli errori finché non li chiudi
  const now = Date.now();
  const visible = jobs.filter((j) => {
    if (state.dismissedJobs.has(j.id)) return false;
    if (j.status === "cancelled") return false;
    if (j.status !== "done") return true;
    if (!state.doneAt[j.id]) state.doneAt[j.id] = now;
    return now - state.doneAt[j.id] < 6000;
  });

  const uploads = state.uploads.map((u) => `<div class="job">
      <div class="job-title">Caricamento: ${escapeHtml(u.name)}</div>
      <div class="job-step muted">${Math.round(u.progress * 100)}%</div>
      <div class="bar"><div style="width:${u.progress * 100}%"></div></div>
    </div>`);

  const items = visible.map((j) => `<div class="job ${j.status}" data-id="${j.id}"
        title="${escapeHtml(j.error || "")}${j.status === "error" ? " — clic per chiudere" : ""}">
      <div class="job-title">${escapeHtml(j.label)}</div>
      <div class="job-step ${j.status === "error" ? "" : "muted"}">${escapeHtml(
        j.status === "error" ? "Errore: " + j.error : `${j.step} ${j.status === "running" ? Math.round(j.progress * 100) + "%" : ""}`)}</div>
      <div class="bar"><div style="width:${j.progress * 100}%"></div></div>
    </div>`);

  $("jobs").innerHTML = uploads.concat(items).join("");
}

$("jobs").addEventListener("click", (e) => {
  const job = e.target.closest(".job.error");
  if (job) { state.dismissedJobs.add(job.dataset.id); renderJobs(state.lastJobs || []); }
});

// ---------------------------------------------------------------------------
// Zoom e disegno della timeline
// ---------------------------------------------------------------------------

const viewSpan = () => Math.max(50, el.scroll.clientWidth - 2 * PAD);
const fitPps = () => viewSpan() / Math.max(1, duration());
const xOf = (t) => PAD + t * state.pps;

function timeAtClientX(clientX) {
  const rect = el.inner.getBoundingClientRect();
  return clamp((clientX - rect.left - PAD) / state.pps, 0, duration());
}

/** Cambia zoom tenendo il tempo `anchorT` fermo alla posizione `anchorX` della vista. */
function setPps(pps, anchorT, anchorX) {
  const lo = Math.min(fitPps(), MAX_PPS);
  state.pps = clamp(pps, lo, Math.max(lo, MAX_PPS));
  el.inner.style.width = `${2 * PAD + duration() * state.pps}px`;
  el.scroll.scrollLeft = xOf(anchorT) - anchorX;
  // slider logaritmico: 0 = tutto il video, 1000 = zoom massimo
  const ratio = MAX_PPS / lo;
  el.zoom.value = ratio > 1 ? Math.round((Math.log(state.pps / lo) / Math.log(ratio)) * 1000) : 0;
  positionSuggestions();
  updateSelectionUI();
  updatePlayhead();
  requestDraw();
}

function zoomAroundCenter(pps) {
  const anchorX = el.scroll.clientWidth / 2;
  setPps(pps, (el.scroll.scrollLeft + anchorX - PAD) / state.pps, anchorX);
}

el.zoom.addEventListener("input", () => {
  const lo = Math.min(fitPps(), MAX_PPS);
  zoomAroundCenter(lo * Math.pow(MAX_PPS / lo, el.zoom.value / 1000));
});
$("btn-zoom-in").addEventListener("click", () => zoomAroundCenter(state.pps * 1.6));
$("btn-zoom-out").addEventListener("click", () => zoomAroundCenter(state.pps / 1.6));
$("btn-fit").addEventListener("click", () => setPps(fitPps(), 0, 0));
$("btn-zoom-sel").addEventListener("click", zoomToSelection);

function zoomToSelection() {
  const len = state.sel.end - state.sel.start;
  const pps = viewSpan() / (len * 1.3);
  setPps(pps, state.sel.start, 0);
  el.scroll.scrollLeft = xOf((state.sel.start + state.sel.end) / 2) - el.scroll.clientWidth / 2;
}

el.scroll.addEventListener("wheel", (e) => {
  if (!state.video) return;
  e.preventDefault();
  if (e.ctrlKey) {
    const rect = el.scroll.getBoundingClientRect();
    const anchorX = e.clientX - rect.left;
    setPps(state.pps * (e.deltaY < 0 ? 1.25 : 0.8), timeAtClientX(e.clientX), anchorX);
  } else {
    el.scroll.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  }
}, { passive: false });

el.scroll.addEventListener("scroll", requestDraw);

let drawQueued = false;
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawTimeline(); });
}

function pickRulerStep() {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s * state.pps >= 70) || 3600;
}

function drawTimeline() {
  if (!state.video) return;
  const dpr = window.devicePixelRatio || 1;
  const w = el.scroll.clientWidth;
  if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(TL_H * dpr)) {
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(TL_H * dpr);
    el.canvas.style.width = `${w}px`;
  }
  const sl = el.scroll.scrollLeft;
  el.canvas.style.left = `${sl}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, TL_H);

  const dur = duration();
  const X = (t) => xOf(t) - sl;          // da secondi a coordinate della vista
  const t0 = clamp((sl - PAD) / state.pps, 0, dur);
  const t1 = clamp((sl + w - PAD) / state.pps, 0, dur);
  const xa = Math.max(0, X(0));
  const xb = Math.min(w, X(dur));

  // --- righello
  ctx.fillStyle = "#1c1c1c";
  ctx.fillRect(0, 0, w, RULER_H);
  const step = pickRulerStep();
  ctx.font = "11px Segoe UI, Arial, sans-serif";
  ctx.textBaseline = "middle";
  for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) {
    const x = X(t);
    if (x < -50 || t > dur) continue;
    ctx.fillStyle = "#777";
    ctx.fillRect(Math.round(x), RULER_H - 7, 1, 7);
    ctx.fillStyle = "#bbb";
    ctx.fillText(fmt(t, step < 1 ? 1 : 0), x + 4, RULER_H / 2 - 1);
    const half = X(t + step / 2);
    ctx.fillStyle = "#555";
    ctx.fillRect(Math.round(half), RULER_H - 4, 1, 4);
  }

  // --- corsia dei clip suggeriti (i riquadri colorati sono elementi HTML sopra)
  ctx.fillStyle = "#141414";
  ctx.fillRect(xa, RULER_H, xb - xa, LANE_H);

  // --- miniature
  const th = state.video.thumbs;
  ctx.save();
  ctx.beginPath();
  ctx.rect(xa, TRACK_Y, xb - xa, THUMB_H);
  ctx.clip();
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(xa, TRACK_Y, xb - xa, THUMB_H);
  if (th && th.count) {
    const slotW = (THUMB_H * th.width) / th.height;
    const perSheet = th.cols * th.rows;
    for (let k = Math.max(0, Math.floor((sl - PAD) / slotW)); ; k++) {
      const x = PAD + k * slotW - sl;
      const t = (k * slotW) / state.pps;
      if (x > w || t > dur) break;
      const idx = Math.min(th.count - 1, Math.round(t / th.interval));
      const img = state.sheets[Math.floor(idx / perSheet)];
      if (!img || !img.complete || !img.naturalWidth) continue;
      const i = idx % perSheet;
      ctx.drawImage(img, (i % th.cols) * th.width, Math.floor(i / th.cols) * th.height,
                    th.width, th.height, x, TRACK_Y, slotW, THUMB_H);
    }
  }
  ctx.restore();

  // --- punti di inquadratura (solo in modalità dinamica)
  if (state.frame.dynamic) {
    for (const k of state.frame.keys) {
      const x = X(k.t);
      if (x < -6 || x > w + 6) continue;
      if (k.m) {   // messo a mano: rombo giallo
        ctx.fillStyle = "#ffd400";
        ctx.strokeStyle = "#000";
        ctx.beginPath();
        ctx.moveTo(x, TRACK_Y + 1); ctx.lineTo(x + 5, TRACK_Y + 7); ctx.lineTo(x, TRACK_Y + 13); ctx.lineTo(x - 5, TRACK_Y + 7);
        ctx.closePath(); ctx.fill(); ctx.stroke();
      } else {     // dal volto: trattino azzurro
        ctx.fillStyle = "#37d6e6";
        ctx.fillRect(Math.round(x) - 1, TRACK_Y, 2, 7);
      }
    }
  }

  // --- forma d'onda
  const y0 = TRACK_Y + THUMB_H;
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(xa, y0, xb - xa, WAVE_H);
  const peaks = state.peaks && state.peaks.peaks;
  if (peaks && peaks.length) {
    const rate = state.peaks.rate;
    const mid = y0 + WAVE_H / 2;
    const amp = WAVE_H / 2 - 4;
    ctx.fillStyle = "#4f8fd8";
    for (let px = Math.floor(xa); px < xb; px++) {
      const ta = (px + sl - PAD) / state.pps;
      const ia = Math.floor(ta * rate);
      const ib = Math.max(ia + 1, Math.floor((ta + 1 / state.pps) * rate));
      let v = 0;
      for (let i = ia; i < ib && i < peaks.length; i++) if (peaks[i] > v) v = peaks[i];
      const hgt = Math.max(1, (v / 100) * amp);
      ctx.fillRect(px, mid - hgt, 1, hgt * 2);
    }
  }
}

// ---------------------------------------------------------------------------
// Selezione: maniglie, trascinamento, campi numerici
// ---------------------------------------------------------------------------

function setSel(start, end) {
  const dur = duration();
  start = clamp(start, 0, dur);
  end = clamp(end, 0, dur);
  state.sel = { start: Math.min(start, end), end: Math.max(start, end) };
  updateSelectionUI();
}

function updateSelectionUI() {
  const { start, end } = state.sel;
  el.sel.style.left = `${xOf(start)}px`;
  el.sel.style.width = `${(end - start) * state.pps}px`;
  if (document.activeElement !== el.inStart) el.inStart.value = start.toFixed(2);
  if (document.activeElement !== el.inEnd) el.inEnd.value = end.toFixed(2);
  el.inStart.title = fmt(start);
  el.inEnd.title = fmt(end);
  const len = end - start;
  $("sel-duration").textContent = `${len.toFixed(1)} s`;
  const warn = $("sel-warning");
  warn.hidden = len <= MAX_SHORT;
  warn.textContent = "Oltre 3 minuti: YouTube non lo considererà uno Short";
  scheduleTranscriptRender();
  markActiveSuggestion();
}

// Anteprima nel player mentre trascini (al massimo un salto per fotogramma)
let seekQueued = null;
function previewSeek(t) {
  if (seekQueued === null) {
    requestAnimationFrame(() => { el.player.currentTime = seekQueued; seekQueued = null; });
  }
  seekQueued = t;
}

/*
 * Sulla timeline ci sono due strumenti separati:
 *  - le maniglie gialle (solo se le prendi direttamente) cambiano Inizio/Fine
 *  - ovunque altro, clic o trascinamento muovono solo la testina bianca (e il player),
 *    anche dentro l'area gialla, senza toccare la selezione
 * Maiusc + trascina disegna una selezione nuova.
 */
el.inner.addEventListener("pointerdown", (e) => {
  if (!state.video || e.button !== 0) return;
  const sug = e.target.closest(".tl-sug");
  if (sug) {
    e.preventDefault();
    useSuggestion(Number(sug.dataset.k), false);
    return;
  }
  const t = timeAtClientX(e.clientX);
  const handle = e.target.dataset && e.target.dataset.handle;
  // grab = distanza tra il punto in cui prendi la maniglia e il bordo vero: così non "salta"
  if (handle) state.drag = { type: handle, grab: t - state.sel[handle] };
  else if (e.shiftKey) state.drag = { type: "new", t0: t };
  else state.drag = { type: "scrub" };
  state.drag.clientX = state.drag.x0 = e.clientX;
  el.inner.setPointerCapture(e.pointerId);
  el.player.pause();
  state.playSel = false;
  e.preventDefault();
  if (state.drag.type === "scrub") seek(t);   // un semplice clic salta lì
  autoScrollLoop();
});

el.inner.addEventListener("pointermove", (e) => {
  if (!state.drag) return;
  state.drag.clientX = e.clientX;
  applyDrag();
});

el.inner.addEventListener("pointerup", (e) => {
  const d = state.drag;
  state.drag = null;
  if (!d) return;
  if (d.type === "new" && state.sel.end - state.sel.start < MIN_SEL) {
    setSel(state.sel.start, Math.min(duration(), state.sel.start + MIN_SEL));
  }
});

function applyDrag() {
  const d = state.drag;
  const t = timeAtClientX(d.clientX);
  const { start, end } = state.sel;
  if (d.type === "scrub") {
    seek(t);
  } else if (d.type === "new") {
    setSel(d.t0, t);
    previewSeek(t);
  } else if (d.type === "start") {
    setSel(Math.min(t - d.grab, end - MIN_SEL), end);
    previewSeek(state.sel.start);
  } else if (d.type === "end") {
    setSel(start, Math.max(t - d.grab, start + MIN_SEL));
    previewSeek(state.sel.end);
  }
}

/** Se trascini vicino al bordo, la timeline scorre da sola. */
function autoScrollLoop() {
  const d = state.drag;
  if (!d) return;
  const rect = el.scroll.getBoundingClientRect();
  const edge = 40;
  let dx = 0;
  // scorre solo se ti stai davvero muovendo verso quel bordo (non appena prendi una maniglia)
  if (d.clientX > rect.right - edge && d.clientX > d.x0 + 5) dx = (d.clientX - (rect.right - edge)) / 2;
  else if (d.clientX < rect.left + edge && d.clientX < d.x0 - 5) dx = -((rect.left + edge) - d.clientX) / 2;
  if (dx) { el.scroll.scrollLeft += dx; applyDrag(); }
  requestAnimationFrame(autoScrollLoop);
}

function bindTimeInput(input, which) {
  input.addEventListener("change", () => {
    const t = parseTime(input.value);
    if (isNaN(t)) { input.classList.add("invalid"); return; }
    input.classList.remove("invalid");
    if (which === "start") setSel(Math.min(t, state.sel.end - MIN_SEL), state.sel.end);
    else setSel(state.sel.start, Math.max(t, state.sel.start + MIN_SEL));
    input.value = state.sel[which].toFixed(2);
    seek(state.sel[which]);
  });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
}
bindTimeInput(el.inStart, "start");
bindTimeInput(el.inEnd, "end");

function setStartHere() { setSel(Math.min(el.player.currentTime, state.sel.end - MIN_SEL), state.sel.end); }
function setEndHere() { setSel(state.sel.start, Math.max(el.player.currentTime, state.sel.start + MIN_SEL)); }
$("btn-set-start").addEventListener("click", setStartHere);
$("btn-set-end").addEventListener("click", setEndHere);

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

function seek(t) {
  el.player.currentTime = clamp(t, 0, duration());
  updatePlayhead();
}

function togglePlay() {
  if (el.player.paused) { state.playSel = false; el.player.play(); } else el.player.pause();
}

function playSelection() {
  el.player.currentTime = state.sel.start;
  state.playSel = true;
  el.player.play();
}

$("btn-play").addEventListener("click", togglePlay);
$("btn-play-sel").addEventListener("click", playSelection);
el.player.addEventListener("click", togglePlay);
el.player.addEventListener("play", () => { $("btn-play").textContent = "❚❚"; });
el.player.addEventListener("pause", () => { $("btn-play").textContent = "▶"; });
el.player.addEventListener("loadedmetadata", updateCropBox);

function updatePlayhead() {
  el.playhead.style.left = `${xOf(el.player.currentTime || 0)}px`;
}

/** Ciclo continuo: aggiorna tempo e testina, ferma la riproduzione a fine selezione. */
function tick() {
  if (state.video) {
    const t = el.player.currentTime || 0;
    if (state.playSel && !el.player.paused && t >= state.sel.end) {
      el.player.pause();
      state.playSel = false;
    }
    $("time-now").textContent = fmt(t);
    updatePlayhead();
    updateSubtitles(t);
    drawShortPreview();
    if (state.frame.dynamic && state.frame.keys.length) updateCropBox();
    // durante la riproduzione la timeline segue la testina
    if (!el.player.paused && !state.drag) {
      const x = xOf(t) - el.scroll.scrollLeft;
      const w = el.scroll.clientWidth;
      if (x < 0 || x > w - 30) el.scroll.scrollLeft = xOf(t) - w * 0.15;
    }
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ---------------------------------------------------------------------------
// Riquadro 9:16 sul player (trascinabile)
// ---------------------------------------------------------------------------

/** Regola dell'inquadratura dinamica, identica a frame_x_at in media.py. */
function frameXAt(keys, t) {
  if (!keys.length) return null;
  if (t <= keys[0].t) return keys[0].x;
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1], cur = keys[i];
    if (t < cur.t) {
      const d = Math.min(cur.d || 0, cur.t - prev.t);
      const a = cur.t - d;
      if (t <= a || d <= 0) return prev.x;
      return prev.x + (cur.x - prev.x) * (t - a) / d;
    }
  }
  return keys[keys.length - 1].x;
}

/** Posizione del riquadro 9:16 in questo momento (0 = sinistra, 1 = destra). */
function currentCropX() {
  if (state.cropDragX !== null) return state.cropDragX;
  if (state.frame.dynamic && state.frame.keys.length) return frameXAt(state.frame.keys, el.player.currentTime || 0);
  return state.cropX;
}

function cropGeometry() {
  const v = state.video;
  const W = el.player.clientWidth, H = el.player.clientHeight;
  if (!v || !W || !H || !v.width || !v.height) return null;
  if (v.width / v.height > 9 / 16) {
    const cw = (H * 9) / 16;
    return { left: (W - cw) * currentCropX(), top: 0, width: cw, height: H, free: W - cw };
  }
  const ch = Math.min(H, (W * 16) / 9);
  return { left: 0, top: (H - ch) / 2, width: W, height: ch, free: 0 };
}

function updateCropBox() {
  const g = cropGeometry();
  const show = g && el.mode.value === "crop";
  el.cropBox.hidden = !show;
  el.cropBox.classList.toggle("dynamic", state.frame.dynamic);
  // i controlli dell'inquadratura servono solo col ritaglio di un video orizzontale
  $("frame-controls").hidden = !show || g.free === 0;
  $("crop-label").hidden = state.frame.dynamic;
  $("dyn-tools").hidden = !state.frame.dynamic;
  document.querySelectorAll("[data-frame]").forEach((b) =>
    b.classList.toggle("on", (b.dataset.frame === "dynamic") === state.frame.dynamic));
  layoutSubtitles();
  if (!show) return;
  Object.assign(el.cropBox.style, {
    left: `${g.left}px`, top: `${g.top}px`, width: `${g.width}px`, height: `${g.height}px`,
  });
}

el.mode.addEventListener("change", updateCropBox);
el.cropX.addEventListener("input", () => { state.cropX = Number(el.cropX.value); updateCropBox(); });

el.cropBox.addEventListener("pointerdown", (e) => {
  const g = cropGeometry();
  if (!g || !g.free) return;
  const dynamic = state.frame.dynamic;
  if (dynamic) { el.player.pause(); state.playSel = false; }
  const startX = e.clientX, startCrop = currentCropX();
  el.cropBox.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const x = clamp(startCrop + (ev.clientX - startX) / g.free, 0, 1);
    if (dynamic) {
      state.cropDragX = x;
    } else {
      state.cropX = x;
      el.cropX.value = x;
    }
    updateCropBox();
  };
  const up = () => {
    el.cropBox.removeEventListener("pointermove", move);
    el.cropBox.removeEventListener("pointerup", up);
    if (dynamic && state.cropDragX !== null) {
      // lasciando il riquadro nasce (o si aggiorna) un punto di inquadratura in questo istante
      upsertKey(el.player.currentTime || 0, state.cropDragX);
      state.cropDragX = null;
      updateCropBox();
    }
  };
  el.cropBox.addEventListener("pointermove", move);
  el.cropBox.addEventListener("pointerup", up);
  e.preventDefault();
});

new ResizeObserver(() => { updateCropBox(); }).observe(el.playerBox);
new ResizeObserver(() => {
  if (!state.video) return;
  if (state.pps < fitPps()) setPps(fitPps(), 0, 0);
  requestDraw();
}).observe(el.scroll);

// ---------------------------------------------------------------------------
// Crea Short + galleria
// ---------------------------------------------------------------------------

$("btn-create").addEventListener("click", async () => {
  if (!state.video) return;
  let subtitles = $("subs").checked;
  if (subtitles && !state.transcript) {
    if (!confirm("La trascrizione non è ancora pronta. Creo lo Short senza sottotitoli?")) return;
    subtitles = false;
  }
  const btn = $("btn-create");
  btn.disabled = true;
  try {
    await api(`/api/videos/${state.video.id}/shorts`, {
      json: { start: state.sel.start, end: state.sel.end, mode: el.mode.value, crop_x: state.cropX,
              subtitles, sub_y: state.subY, dynamic: state.frame.dynamic, title: exportTitle() },
    });
    pollJobs();
  } catch (err) {
    alert(err.message);
  } finally {
    setTimeout(() => { btn.disabled = false; }, 600);
  }
});

function renderShorts(shorts) {
  const list = $("shorts-list");
  if (!shorts || !shorts.length) {
    list.innerHTML = '<p class="muted">Nessuno Short per questo video.</p>';
    return;
  }
  const id = state.video.id;
  list.innerHTML = shorts.map((s) => {
    const src = `/media/${id}/shorts/${encodeURIComponent(s.file)}`;
    return `<div class="short-card" data-file="${escapeHtml(s.file)}">
      <video src="${src}" controls preload="metadata"></video>
      <div class="s-info">${fmt(s.start, 1)} → ${fmt(s.end, 1)} · ${(s.end - s.start).toFixed(1)} s ·
        ${s.mode === "blur" ? "sfondo sfocato" : "ritaglio"}${s.dynamic ? " · inquadratura dinamica" : ""}${s.subtitles ? " · sottotitoli" : ""}${s.title ? ` · titolo “${escapeHtml(s.title)}”` : ""}</div>
      <div class="s-actions">
        <a class="btn small" href="${src}?download=1" download="${escapeHtml(s.file)}">Scarica</a>
        <button class="btn small" data-action="reselect" data-start="${s.start}" data-end="${s.end}">Riseleziona</button>
        <button class="btn small danger" data-action="delete">Elimina</button>
      </div>
    </div>`;
  }).join("");
}

$("shorts-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn || !state.video) return;
  const card = btn.closest(".short-card");
  if (btn.dataset.action === "reselect") {
    setSel(Number(btn.dataset.start), Number(btn.dataset.end));
    zoomToSelection();
    seek(state.sel.start);
  } else if (btn.dataset.action === "delete" && confirm("Eliminare questo Short?")) {
    await api(`/api/videos/${state.video.id}/shorts/${encodeURIComponent(card.dataset.file)}`, { method: "DELETE" });
    state.video.shorts = state.video.shorts.filter((s) => s.file !== card.dataset.file);
    renderShorts(state.video.shorts);
    renderSuggestions();
  }
});

// ---------------------------------------------------------------------------
// Trascrizione e sottotitoli
// ---------------------------------------------------------------------------

// Stesse regole di media.py (chunk_words): cambiale insieme
const MAX_WORDS_PER_LINE = 3, MAX_CHARS_PER_LINE = 22, MAX_GAP = 0.6, HOLD = 0.4;
// Posizione e dimensione del testo nello Short 1080x1920 (come ASS_HEADER in media.py)
const SUB_FONT = 86 / 1920, SUB_MARGIN_SIDE = 70 / 1080;
// Parte bassa del frame coperta dai pulsanti di Shorts/Reels/TikTok (circa 12-15%)
const SAFE_BOTTOM = 0.15;
// Metà altezza di una riga di testo, in frazione del frame: serve per l'avviso
const SUB_HALF_LINE = (86 * 1.15) / 1920 / 2;

async function loadTranscript() {
  const id = state.video.id;
  state.transcript = null;
  state.chunks = [];
  if (state.video.transcript === "ready") {
    try {
      const data = await api(`/api/videos/${id}/transcript`);
      if (!state.video || state.video.id !== id) return;
      state.transcript = data;
      buildChunks();
    } catch { /* manca il file: si potrà ritrascrivere */ }
  }
  updateTranscriptStatus();
  renderTranscript();
  loadSuggestions();
}

function buildChunks() {
  const words = state.transcript.words;
  const chunks = [];
  let cur = [];
  words.forEach((w, i) => {
    const item = { ...w, i };
    if (cur.length) {
      const last = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
      if (cur.length >= MAX_WORDS_PER_LINE || chars > MAX_CHARS_PER_LINE ||
          w.s - last.e > MAX_GAP || ".?!".includes(last.w.slice(-1)) ||
          (",;:".includes(last.w.slice(-1)) && cur.length >= 2)) {
        chunks.push(cur);
        cur = [];
      }
    }
    cur.push(item);
  });
  if (cur.length) chunks.push(cur);
  chunks.forEach((c, k) => {
    const next = chunks[k + 1];
    c.start = c[0].s;
    c.end = Math.min(c[c.length - 1].e + HOLD, next ? next[0].s : Infinity);
  });
  state.chunks = chunks;
}

/** Indice del primo elemento con valore >= t (lista ordinata). */
function lowerBound(list, t, key) {
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(list[mid]) < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function updateTranscriptStatus() {
  if (!state.video) return;
  const status = state.transcript ? "ready" : state.video.transcript;
  const job = (state.lastJobs || []).find((j) => j.kind === "transcribe" && j.video_id === state.video.id &&
                                          (j.status === "queued" || j.status === "running"));
  let text = "";
  if (status === "ready") text = `${state.transcript.words.length} parole trascritte`;
  else if (job) text = job.status === "queued" ? "Trascrizione in coda…" : `${job.step} ${Math.round(job.progress * 100)}%`;
  else if (status === "error") text = "La trascrizione non è riuscita";
  else text = "Questo video non è ancora trascritto";
  $("tr-status").textContent = text;
  $("btn-transcribe").hidden = status === "ready" || !!job;
}

$("btn-transcribe").addEventListener("click", async () => {
  try {
    await api(`/api/videos/${state.video.id}/transcribe`, { method: "POST" });
    state.video.transcript = "queued";
    pollJobs();
  } catch (err) {
    alert(err.message);
  }
});

// --- testo della selezione (aggiornato con un piccolo ritardo mentre trascini)
let trTimer = null;
let trSpans = new Map();   // indice parola -> <span>
let trActive = null;

/** Dice quante parole ci sono e se ai bordi della selezione c'è silenzio (lì non ci sono parole da mostrare). */
function renderTranscriptRange(words, from) {
  const { start, end } = state.sel;
  const inside = [];
  for (let i = from; i < words.length && words[i].s < end; i++) inside.push(words[i]);
  const el2 = $("tr-range");
  if (!inside.length) { el2.textContent = ""; return; }
  const first = inside[0], last = inside[inside.length - 1];
  let html = `${inside.length} parole, da ${fmt(first.s, 1)} a ${fmt(last.e, 1)}`;
  const before = first.s - start, after = end - last.e;
  if (before >= 1.5) html += ` · <span class="gap">${before.toFixed(1)} s senza parole all'inizio</span>`;
  if (after >= 1.5) {
    const next = words[from + inside.length];
    html += ` · <span class="gap">${after.toFixed(1)} s senza parole alla fine` +
            (next ? ` (la prossima frase inizia a ${fmt(next.s, 1)})` : "") + "</span>";
  }
  el2.innerHTML = html;
}

function scheduleTranscriptRender() {
  clearTimeout(trTimer);
  trTimer = setTimeout(renderTranscript, 120);
}

function renderTranscript() {
  const box = $("tr-words");
  trSpans = new Map();
  trActive = null;
  if (!state.transcript) { box.innerHTML = ""; return; }
  const words = state.transcript.words;
  const from = lowerBound(words, state.sel.start, (w) => w.e);
  const frag = document.createDocumentFragment();
  for (let i = from; i < words.length && words[i].s < state.sel.end; i++) {
    const span = document.createElement("span");
    span.textContent = words[i].w;
    span.dataset.i = i;
    frag.append(span, " ");
    trSpans.set(i, span);
  }
  box.replaceChildren(frag);
  if (!trSpans.size) box.innerHTML = '<span class="muted">Nessun parlato in questa selezione.</span>';
  renderTranscriptRange(words, from);
}

$("tr-words").addEventListener("click", (e) => {
  const i = e.target.dataset.i;
  if (i !== undefined) seek(state.transcript.words[i].s);
});

$("tr-words").addEventListener("dblclick", async (e) => {
  const i = Number(e.target.dataset.i);
  if (isNaN(i)) return;
  const words = state.transcript.words;
  const text = prompt("Correggi la parola (lascia vuoto per eliminarla):", words[i].w);
  if (text === null) return;
  try {
    await api(`/api/videos/${state.video.id}/transcript/word`, { json: { index: i, text } });
    if (text.trim()) words[i].w = text.trim(); else words.splice(i, 1);
    buildChunks();
    renderTranscript();
    loadSuggestions();
  } catch (err) {
    alert(err.message);
  }
});

// --- anteprima dei sottotitoli sopra il player
let subChunk = null, subWord = -1;

function currentChunk(t) {
  const k = lowerBound(state.chunks, t, (c) => c.start) - 1;
  const c = state.chunks[k];
  return c && t < c.end ? c : null;
}

function updateSubtitles(t) {
  const box = $("sub-preview");
  const on = $("subs").checked && state.transcript;
  const c = on ? currentChunk(t) : null;
  const guide = $("subs").checked && Date.now() < state.guideUntil;
  $("safe-zone").hidden = !guide;
  box.hidden = !c && !guide;
  box.classList.toggle("sample", !c);

  // parola evidenziata nel testo della selezione
  let wi = -1;
  if (c) for (const w of c) if (w.s <= t) wi = w.i;
  const span = trSpans.get(wi) || null;
  if (span !== trActive) {
    if (trActive) trActive.classList.remove("on");
    if (span) span.classList.add("on");
    trActive = span;
  }

  if (!c) {
    // nessuna frase in questo punto: testo di esempio per vedere dove cadrà
    if (guide && subChunk !== "sample") {
      box.innerHTML = '<span class="on">Esempio</span> <span>di</span> <span>sottotitolo</span>';
      subChunk = "sample";
    } else if (!guide) {
      subChunk = null;
    }
    return;
  }
  if (c !== subChunk) {
    box.innerHTML = c.map((w) => `<span>${escapeHtml(w.w)}</span>`).join(" ");
    subChunk = c;
    subWord = -1;
  }
  // la parola resta evidenziata finché non inizia la successiva (come nell'export)
  let active = 0;
  c.forEach((w, k) => { if (w.s <= t) active = k; });
  if (active !== subWord) {
    box.querySelectorAll("span").forEach((s, k) => s.classList.toggle("on", k === active));
    subWord = active;
  }
}

const fontScaleCache = {};
/**
 * Nei sottotitoli .ass la "dimensione" di un carattere è l'altezza dell'intera riga (ascendenti +
 * discendenti), nel browser è il corpo del carattere. Questo è il rapporto (es. Arial Black 0,71):
 * serve perché l'anteprima abbia il testo grande esattamente come nel video esportato.
 */
function assFontScale(font) {
  if (!(font in fontScaleCache)) {
    const c = document.createElement("canvas").getContext("2d");
    c.font = `100px "${font}"`;
    const m = c.measureText("Hg");
    fontScaleCache[font] = 100 / (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) || 1;
  }
  return fontScaleCache[font];
}

/** Dimensiona l'anteprima 9:16 (alta quanto il player) e ci mette sottotitoli, zona coperta e titolo. */
function layoutSubtitles() {
  const H = el.player.clientHeight;
  if (!H) return;
  const W = Math.round((H * 9) / 16);
  Object.assign($("short-preview").style, { width: `${W}px`, height: `${H}px` });
  const g = { left: 0, top: 0, width: W, height: H };
  layoutTitle(g);
  const scale = assFontScale("Arial Black");
  const font = g.height * SUB_FONT * scale;
  Object.assign($("sub-preview").style, {
    left: `${g.left + g.width * SUB_MARGIN_SIDE}px`,
    width: `${g.width * (1 - 2 * SUB_MARGIN_SIDE)}px`,
    top: `${g.top + g.height * state.subY}px`,   // il centro del testo (translateY -50% nel CSS)
    fontSize: `${font}px`,
  });
  $("sub-preview").style.lineHeight = `${1 / scale}`;
  // contorno di 7 px su 1920 (come in ASS_HEADER); nel browser il tratto è metà dentro e metà fuori, quindi x2
  $("sub-preview").style.setProperty("--stroke", `${Math.max(1, (2 * 7 * g.height) / 1920)}px`);
  Object.assign($("safe-zone").style, {
    left: `${g.left}px`, width: `${g.width}px`,
    top: `${g.top + g.height * (1 - SAFE_BOTTOM)}px`, height: `${g.height * SAFE_BOTTOM}px`,
  });
}

function setSubY(percent, showGuide = true) {
  state.subY = clamp(percent, 5, 95) / 100;
  $("sub-y").value = Math.round(state.subY * 100);
  $("sub-y-val").textContent = `${Math.round(state.subY * 100)}%`;
  $("sub-y-warn").hidden = state.subY + SUB_HALF_LINE <= 1 - SAFE_BOTTOM;
  store("subY", state.subY);
  if (showGuide) state.guideUntil = Date.now() + 2500;
  layoutSubtitles();
}

$("sub-y").addEventListener("input", () => setSubY(Number($("sub-y").value)));
$("sub-pos").addEventListener("click", (e) => {
  if (e.target.dataset.y) setSubY(Number(e.target.dataset.y));
});
// passando col mouse sul controllo si vede subito dove cade il testo
$("sub-pos").addEventListener("mousemove", () => { state.guideUntil = Date.now() + 1500; });
$("subs").addEventListener("change", () => {
  $("sub-pos").classList.toggle("disabled", !$("subs").checked);
  updateSubtitles(el.player.currentTime || 0);
});
setSubY(Number(recall("subY") || 0.8) * 100, false);

// ---------------------------------------------------------------------------
// Anteprima dello Short 9:16 (disegnata dal video del player, come farà ffmpeg)
// ---------------------------------------------------------------------------

const SHORT_W = 1080, SP_W = 360, SP_H = 640;   // anteprima a 1/3 della risoluzione finale
const spCtx = $("sp-canvas").getContext("2d");

function drawShortPreview() {
  const v = el.player;
  if (!state.video || v.readyState < 2 || !v.videoWidth) return;
  const vw = v.videoWidth, vh = v.videoHeight;
  spCtx.filter = "none";
  if (el.mode.value === "crop") {
    // stessa finestra di media.vertical_filter("crop"), che segue anche l'inquadratura dinamica
    if (vw / vh > 9 / 16) {
      const cw = (vh * 9) / 16;
      spCtx.drawImage(v, (vw - cw) * currentCropX(), 0, cw, vh, 0, 0, SP_W, SP_H);
    } else {
      const ch = Math.min(vh, (vw * 16) / 9);
      spCtx.drawImage(v, 0, (vh - ch) / 2, vw, ch, 0, 0, SP_W, SP_H);
    }
  } else {
    // blur fill, come media.vertical_filter("blur"): sfondo = video che riempie tutto, sfocato
    // (gblur sigma 30 su 1080 px), sopra il video intero centrato
    const blur = (30 * SP_W) / SHORT_W;
    const cover = Math.max(SP_W / vw, SP_H / vh);
    const bw = vw * cover + 4 * blur, bh = vh * cover + 4 * blur;   // più grande: niente bordi scuri
    spCtx.filter = `blur(${blur}px)`;
    spCtx.drawImage(v, (SP_W - bw) / 2, (SP_H - bh) / 2, bw, bh);
    spCtx.filter = "none";
    const fit = Math.min(SP_W / vw, SP_H / vh);
    spCtx.drawImage(v, (SP_W - vw * fit) / 2, (SP_H - vh * fit) / 2, vw * fit, vh * fit);
  }
}

// ---------------------------------------------------------------------------
// Titolo fisso (bruciato nel video per tutta la durata, separato dai sottotitoli)
// ---------------------------------------------------------------------------

const TITLE_DEFAULTS = { on: false, text: "", font: "Arial Black", size: 90, color: "#ffffff",
                         band: false, bandColor: "#d32f2f", y: 0.15 };
state.title = { ...TITLE_DEFAULTS };
try { Object.assign(state.title, JSON.parse(recall("title") || "{}")); } catch { /* ignora */ }

const titleInputs = {
  on: ["title-on", "checked"], text: ["title-text", "value"], font: ["title-font", "value"],
  size: ["title-size", "value"], color: ["title-color", "value"], band: ["title-band", "checked"],
  bandColor: ["title-band-color", "value"], y: ["title-y", "value"],
};

function showTitleControls() {
  for (const [key, [id, prop]] of Object.entries(titleInputs)) {
    $(id)[prop] = key === "y" ? Math.round(state.title.y * 100) : state.title[key];
  }
  $("title-y-val").textContent = `${Math.round(state.title.y * 100)}%`;
  $("title-opts").classList.toggle("disabled", !state.title.on);
}

function readTitleControls() {
  for (const [key, [id, prop]] of Object.entries(titleInputs)) {
    let v = $(id)[prop];
    if (key === "size") v = Number(v);
    if (key === "y") v = Number(v) / 100;
    state.title[key] = v;
  }
  store("title", JSON.stringify(state.title));
  showTitleControls();
  layoutSubtitles();
}

Object.values(titleInputs).forEach(([id]) => $(id).addEventListener("input", readTitleControls));
showTitleControls();

function layoutTitle(g) {
  const t = state.title, box = $("title-preview"), span = box.firstElementChild;
  box.hidden = !(t.on && t.text.trim());
  if (box.hidden) return;
  // dimensioni in proporzione al fotogramma 1080x1920, come nel file .ass (_title_style in media.py)
  const px = g.height / 1920;              // 1 pixel dello Short, nell'anteprima
  const scale = assFontScale(t.font);
  const font = t.size * px * scale;
  span.textContent = t.text;
  Object.assign(box.style, {
    left: `${g.left + g.width * SUB_MARGIN_SIDE}px`,
    width: `${g.width * (1 - 2 * SUB_MARGIN_SIDE)}px`,
    top: `${g.top + g.height * t.y}px`,
    fontFamily: `"${t.font}", sans-serif`,
    fontSize: `${font}px`,
    lineHeight: `${1 / scale}`,
    color: t.color,
  });
  box.classList.toggle("band", t.band);
  span.style.background = t.band ? t.bandColor : "";
  const pad = Math.round(t.size * 0.22) * px;                 // margine della fascia
  span.style.padding = t.band ? `${pad}px` : "";
  box.style.setProperty("--stroke", `${2 * Math.max(2, Math.round(t.size * 0.07)) * px}px`);
}

/** Il titolo da mandare all'esportazione (null se spento o vuoto). */
function exportTitle() {
  const t = state.title;
  if (!t.on || !t.text.trim()) return null;
  return { text: t.text.trim(), font: t.font, size: t.size, color: t.color,
           band: t.band, band_color: t.bandColor, y: t.y };
}

// ---------------------------------------------------------------------------
// Clip suggeriti (calcolati dal server in suggest.py)
// ---------------------------------------------------------------------------

async function loadSuggestions() {
  if (!state.video) return;
  const id = state.video.id;
  let data = { ready: false, suggestions: [] };
  try { data = await api(`/api/videos/${id}/suggestions`); } catch { /* ignora */ }
  if (!state.video || state.video.id !== id) return;
  state.suggestions = data.suggestions;
  state.suggestionsReady = data.ready;
  renderSuggestions();
}

/** Un suggerimento è "usato" se almeno metà del suo tratto è già diventata uno Short. */
function isUsed(g) {
  return (state.video.shorts || []).some((sh) =>
    Math.min(g.end, sh.end) - Math.max(g.start, sh.start) >= 0.5 * (g.end - g.start));
}

function visibleSuggestions() {
  const hide = $("sug-hide-used").checked;
  return state.suggestions.map((g, k) => ({ g, k, used: isUsed(g) })).filter((x) => !(hide && x.used));
}

$("sug-hide-used").checked = recall("hideUsed") === "1";
$("sug-hide-used").addEventListener("change", () => {
  store("hideUsed", $("sug-hide-used").checked ? "1" : "0");
  renderSuggestions();
});

$("btn-sug-more").addEventListener("click", async () => {
  const btn = $("btn-sug-more");
  btn.disabled = true;
  try {
    const res = await api(`/api/videos/${state.video.id}/suggestions/more`, { method: "POST" });
    state.suggestions = res.suggestions;
    renderSuggestions(res.added ? `+${res.added} nuovi suggerimenti (in viola “nuovo”)`
                                : "Non ho trovato altri tratti adatti lontani da quelli già proposti");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
  }
});

function renderSuggestions(note = "") {
  if (!state.video) return;
  const all = state.suggestions;
  const shown = visibleSuggestions();
  const lastBatch = Math.max(1, ...all.map((g) => g.batch || 1));
  const usedCount = all.filter(isUsed).length;
  const hidden = all.length - shown.length;
  $("sug-status").textContent = note || (!state.suggestionsReady ? "Arrivano appena finisce la trascrizione"
    : !all.length ? "Nessun segmento adatto (serve almeno 30 s di parlato)"
    : `${all.length} proposte` + (usedCount ? `, ${usedCount} già usate` : "") + (hidden ? ` (${hidden} nascoste)` : ""));
  $("btn-sug-more").hidden = !state.suggestionsReady;

  $("tl-sugs").innerHTML = shown.map(({ g, k, used }) =>
    `<div class="tl-sug ${used ? "used" : ""}" data-k="${k}" title="Clip ${g.rank}${used ? " (già usato per uno Short)" : ""}: ${fmt(g.start, 1)} → ${fmt(g.end, 1)}\n${escapeHtml(g.reasons.join("\n"))}">${g.rank}</div>`
  ).join("");
  $("sug-list").innerHTML = shown.map(({ g, k, used }) => `
    <div class="sug-item ${used ? "used" : ""}" data-k="${k}">
      <div class="sug-top">
        <span class="sug-rank">${g.rank}</span>
        <span class="sug-time">${fmt(g.start, 1)} → ${fmt(g.end, 1)}</span>
        <span class="muted">${(g.end - g.start).toFixed(0)} s</span>
        ${used ? '<span class="sug-badge">✓ già usato</span>' : ""}
        ${!used && lastBatch > 1 && g.batch === lastBatch ? '<span class="sug-badge new">nuovo</span>' : ""}
        <span class="sug-score" title="Punteggio dell'euristica, da 0 a 100">${g.score}/100</span>
      </div>
      <div class="sug-preview">“${escapeHtml(g.preview)}…”</div>
      <ul class="sug-reasons">${g.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join("")}</ul>
      <div class="sug-actions">
        <button class="btn small" data-action="use">Usa questo</button>
        <button class="btn small" data-action="listen">▶ Ascolta</button>
      </div>
    </div>`).join("");
  positionSuggestions();
  markActiveSuggestion();
}

function positionSuggestions() {
  document.querySelectorAll(".tl-sug").forEach((div) => {
    const g = state.suggestions[div.dataset.k];
    if (!g) return;
    // larghezza reale (meno 2 px di stacco): con tanti suggerimenti vicini non si accavallano;
    // il numero compare solo se c'è spazio (altrimenti è nel suggerimento al passaggio del mouse)
    const w = Math.max(4, (g.end - g.start) * state.pps - 2);
    div.style.left = `${xOf(g.start) + 1}px`;
    div.style.width = `${w}px`;
    div.style.padding = w >= 18 ? "" : "0";
    div.style.color = w >= 18 ? "" : "transparent";
  });
}

function markActiveSuggestion() {
  const { start, end } = state.sel;
  document.querySelectorAll(".tl-sug, .sug-item").forEach((node) => {
    const g = state.suggestions[node.dataset.k];
    node.classList.toggle("active", !!g && Math.abs(g.start - start) < 0.05 && Math.abs(g.end - end) < 0.05);
  });
}

/** Porta il suggerimento nella selezione (poi lo rifinisci con le maniglie). */
function useSuggestion(k, zoom = true) {
  const g = state.suggestions[k];
  if (!g) return;
  state.playSel = false;
  setSel(g.start, g.end);
  if (zoom) zoomToSelection();
  seek(g.start);
}

$("sug-list").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const k = Number(btn.closest(".sug-item").dataset.k);
  useSuggestion(k);
  if (btn.dataset.action === "listen") playSelection();
});

// --- parole chiave
async function loadSettings() {
  try {
    const settings = await api("/api/settings");
    $("kw-text").value = settings.keywords.join("\n");
    $("kw-count").textContent = `(${settings.keywords.length})`;
  } catch { /* ignora */ }
}

$("btn-kw-save").addEventListener("click", async () => {
  const keywords = $("kw-text").value.split("\n").map((k) => k.trim()).filter(Boolean);
  try {
    const settings = await api("/api/settings", { method: "PUT", json: { keywords } });
    $("kw-count").textContent = `(${settings.keywords.length})`;
    loadSuggestions();
  } catch (err) {
    alert(err.message);
  }
});
loadSettings();

// ---------------------------------------------------------------------------
// Inquadratura dinamica
// ---------------------------------------------------------------------------

async function loadFrame() {
  const id = state.video.id;
  let data = { dynamic: false, keys: [] };
  try { data = await api(`/api/videos/${id}/inquadratura`); } catch { /* ignora */ }
  if (!state.video || state.video.id !== id) return;
  state.frame = data;
  $("track-msg").hidden = true;   // il messaggio del video precedente non vale più
  $("track-msg").textContent = "";
  updateCropBox();
  requestDraw();
}

let frameSaveTimer = null;
function saveFrame() {
  const id = state.video.id, data = state.frame;
  clearTimeout(frameSaveTimer);
  frameSaveTimer = setTimeout(() => {
    api(`/api/videos/${id}/inquadratura`, { method: "PUT", json: data }).catch((err) => alert(err.message));
  }, 300);
  updateCropBox();
  requestDraw();
}

/** Aggiunge un punto a mano; se ce n'è già uno vicinissimo lo sposta. */
function upsertKey(t, x) {
  const keys = state.frame.keys;
  const near = keys.find((k) => Math.abs(k.t - t) < 0.25);
  if (near) {
    near.x = x;
    near.m = true;
    near.d = Math.max(near.d, 0.6);
  } else {
    keys.push({ t, x, d: 0.6, m: true });   // 0,6 s di panoramica per arrivare qui
    keys.sort((a, b) => a.t - b.t);
  }
  saveFrame();
}

document.querySelectorAll("[data-frame]").forEach((btn) => btn.addEventListener("click", () => {
  const dynamic = btn.dataset.frame === "dynamic";
  if (dynamic === state.frame.dynamic) return;
  state.frame.dynamic = dynamic;
  // passando a "dinamica" senza punti, si parte dalla posizione fissa attuale
  if (dynamic && !state.frame.keys.length) {
    state.frame.keys.push({ t: state.sel.start, x: state.cropX, d: 0, m: true });
  }
  $("track-msg").hidden = true;
  saveFrame();
}));

$("btn-track").addEventListener("click", async () => {
  const msg = $("track-msg");
  try {
    await api(`/api/videos/${state.video.id}/reframe`, { json: { start: state.sel.start, end: state.sel.end } });
    msg.hidden = false;
    msg.className = "small-text muted";
    msg.textContent = "Cerco il volto nella selezione…";
    pollJobs();
  } catch (err) {
    alert(err.message);
  }
});

$("btn-key-del").addEventListener("click", () => {
  const t = el.player.currentTime || 0;
  const keys = state.frame.keys;
  let best = -1;
  keys.forEach((k, i) => { if (Math.abs(k.t - t) < 0.4 && (best < 0 || Math.abs(k.t - t) < Math.abs(keys[best].t - t))) best = i; });
  if (best < 0) {
    alert("Nessun punto vicino alla testina. Porta la testina su un rombo giallo (o un trattino azzurro) della timeline.");
    return;
  }
  keys.splice(best, 1);
  saveFrame();
});

$("btn-keys-clear").addEventListener("click", () => {
  const { start, end } = state.sel;
  const inside = state.frame.keys.filter((k) => k.t >= start && k.t <= end).length;
  if (!inside) return;
  if (!confirm(`Eliminare ${inside} punti di inquadratura nella selezione?`)) return;
  state.frame.keys = state.frame.keys.filter((k) => k.t < start || k.t > end);
  saveFrame();
});

// ---------------------------------------------------------------------------
// Scorciatoie da tastiera
// ---------------------------------------------------------------------------

document.addEventListener("keydown", (e) => {
  if (!state.video || e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === " ") { e.preventDefault(); togglePlay(); }
  else if (key === "i") setStartHere();
  else if (key === "o") setEndHere();
  else if (key === "p") playSelection();
  else if (key === "arrowleft" || key === "arrowright") {
    e.preventDefault();
    const step = (e.shiftKey ? 0.1 : 1) * (key === "arrowleft" ? -1 : 1);
    seek(el.player.currentTime + step);
  }
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

(async function init() {
  await loadVideos();
  const last = recall("lastVideo");
  const first = state.videos.find((v) => v.id === last && v.status === "ready") ||
                state.videos.find((v) => v.status === "ready");
  if (first) openVideo(first.id);
  pollJobs();
})();
