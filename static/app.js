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
const THUMB_H = 64;
const TL_H = 150;
const WAVE_H = TL_H - RULER_H - THUMB_H;
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
      <div class="v-meta ${v.status === "error" ? "error" : ""}">${escapeHtml(metaText)}</div>
    </li>`;
  }).join("");
}

$("video-list").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-id]");
  if (li && !li.classList.contains("disabled")) openVideo(li.dataset.id);
});

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
  renderShorts(v.shorts);
  renderVideoList();
  loadTranscript();
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

  // --- miniature
  const th = state.video.thumbs;
  ctx.save();
  ctx.beginPath();
  ctx.rect(xa, RULER_H, xb - xa, THUMB_H);
  ctx.clip();
  ctx.fillStyle = "#2a2a2a";
  ctx.fillRect(xa, RULER_H, xb - xa, THUMB_H);
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
                    th.width, th.height, x, RULER_H, slotW, THUMB_H);
    }
  }
  ctx.restore();

  // --- forma d'onda
  const y0 = RULER_H + THUMB_H;
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

function cropGeometry() {
  const v = state.video;
  const W = el.player.clientWidth, H = el.player.clientHeight;
  if (!v || !W || !H || !v.width || !v.height) return null;
  if (v.width / v.height > 9 / 16) {
    const cw = (H * 9) / 16;
    return { left: (W - cw) * state.cropX, top: 0, width: cw, height: H, free: W - cw };
  }
  const ch = Math.min(H, (W * 16) / 9);
  return { left: 0, top: (H - ch) / 2, width: W, height: ch, free: 0 };
}

function updateCropBox() {
  const g = cropGeometry();
  const show = g && el.mode.value === "crop";
  el.cropBox.hidden = !show;
  $("crop-label").hidden = el.mode.value !== "crop" || !g || g.free === 0;
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
  const startX = e.clientX, startCrop = state.cropX;
  el.cropBox.setPointerCapture(e.pointerId);
  const move = (ev) => {
    state.cropX = clamp(startCrop + (ev.clientX - startX) / g.free, 0, 1);
    el.cropX.value = state.cropX;
    updateCropBox();
  };
  const up = () => {
    el.cropBox.removeEventListener("pointermove", move);
    el.cropBox.removeEventListener("pointerup", up);
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
              subtitles, sub_y: state.subY },
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
        ${s.mode === "blur" ? "sfondo sfocato" : "ritaglio"}${s.subtitles ? " · sottotitoli" : ""}</div>
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

/** Mette l'anteprima dove comparirà nello Short: dentro il riquadro 9:16 (o al centro se sfocato). */
function layoutSubtitles() {
  const W = el.player.clientWidth, H = el.player.clientHeight;
  if (!W || !H) return;
  let g = el.mode.value === "crop" ? cropGeometry() : null;
  if (!g) {
    const w = Math.min(W, (H * 9) / 16);
    g = { left: (W - w) / 2, top: 0, width: w, height: H };
  }
  const font = g.height * SUB_FONT;
  Object.assign($("sub-preview").style, {
    left: `${g.left + g.width * SUB_MARGIN_SIDE}px`,
    width: `${g.width * (1 - 2 * SUB_MARGIN_SIDE)}px`,
    top: `${g.top + g.height * state.subY}px`,   // il centro del testo (translateY -50% nel CSS)
    fontSize: `${font}px`,
  });
  $("sub-preview").style.setProperty("--stroke", `${Math.max(1.5, font * 0.16)}px`);
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
