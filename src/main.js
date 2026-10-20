// Wiring only: file in, settings to the worker, buffers to the preview, bytes out.

import { createPreview } from "./view/preview.js";
import { mountPanel } from "./view/panel.js";
import { DEFAULT_FUZZ } from "./core/fuzz.js";
import { PRESETS, spiralFromStroke, gradientFromStroke, tightenGradient } from "./core/patterns.js";

const STORE = "fuzzyspiral.settings.v1";
const $ = (id) => document.getElementById(id);

const defaults = () => ({
  fuzz: { ...DEFAULT_FUZZ },
  center: { mode: "auto", x: 128, y: 128 },
  stack: PRESETS["Spiral, 3-start"](),
});

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE) ?? "null");
    if (s?.fuzz && s?.center && Array.isArray(s.stack)) return { ...defaults(), ...s, fuzz: { ...DEFAULT_FUZZ, ...s.fuzz } };
  } catch {}
  return defaults();
}
const saveSettings = () => { try { localStorage.setItem(STORE, JSON.stringify(state.settings)); } catch {} };

const state = { settings: loadSettings(), info: null, view: "fuzzed", picking: false };

// Worker RPC: each request gets an id; replies resolve the matching promise.
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
let nextId = 1;
const pending = new Map();
worker.onmessage = (ev) => {
  const p = pending.get(ev.data.id);
  if (!p) return;
  pending.delete(ev.data.id);
  ev.data.type === "error" ? p.reject(new Error(ev.data.message)) : p.resolve(ev.data);
};
const call = (msg, transfer = []) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  worker.postMessage({ ...msg, id }, transfer);
});

// The header line shows the current instruction or result; a background preview refresh shows
// "fuzzing…" over it briefly without wiping it, so tool hints survive every slider tweak.
let statusText = "";
let busy = false;
const renderStatus = () => { $("status").textContent = busy ? "fuzzing…" : statusText; };
const status = (t) => { statusText = t; renderStatus(); };
const setBusy = (b) => { busy = b; renderStatus(); };

/** Errors stop the user, so they get a modal rather than a line in the header. */
function showError(title, message) {
  status("");
  $("errorTitle").textContent = title;
  $("errorMessage").textContent = message ? message[0].toUpperCase() + message.slice(1) : "";
  const d = $("errorDialog");
  if (!d.open) d.showModal();
}
const settingsSnapshot = () => JSON.parse(JSON.stringify(state.settings));

const preview = createPreview($("stage"));

// Only the newest preview request matters; older ones are dropped when they land.
let previewSeq = 0;
let previewTimer = 0;
async function refreshPreview() {
  if (!state.info) return;
  const seq = ++previewSeq;
  setBusy(true);
  try {
    const d = await call({ type: "preview", settings: settingsSnapshot(), view: state.view });
    if (seq !== previewSeq) return;
    preview.setData(d);
    applyLayerRange();
    const s = d.stats;
    $("stats").textContent = `${s.runsChanged.toLocaleString()} / ${state.info.runs.toLocaleString()} walls fuzzed`;
    $("stats").title = `${s.runsChanged.toLocaleString()} of ${state.info.runs.toLocaleString()} outer-wall runs changed. Moves: ${s.pointsBefore.toLocaleString()} → ${s.pointsAfter.toLocaleString()}.`;
    setBusy(false);
  } catch (e) {
    setBusy(false);
    showError("Preview failed", e.message);
  }
}
const changed = () => {
  saveSettings();
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 120);
};

const panel = mountPanel($("panel"), state, {
  changed,
  savePattern,
  loadPattern: () => $("settingsFile").click(),
  drawSpiral,
  drawGradient,
  pickCenter: () => {
    state.picking = true;
    $("stage").classList.add("picking");
    status("click the bed to set the pattern center");
  },
});

preview.canvas.addEventListener("click", (e) => {
  if (!state.picking) return;
  const p = preview.pickBed(e.clientX, e.clientY);
  state.picking = false;
  $("stage").classList.remove("picking");
  if (!p) return status("missed the bed");
  Object.assign(state.settings.center, { mode: "custom", x: +p.x.toFixed(2), y: +p.y.toFixed(2) });
  panel.refresh();
  changed();
});

// Drawing on the part: a drag sets a layer's parameters live through `tool.solve`, then the
// scroll wheel fine-tunes them through `tool.wheel` until the user clicks or presses Enter.
/**
 * @param {import('./core/patterns.js').MaskLayer} layer
 * @param {{drag: string, adjust: () => string,
 *          solve: (a: any, b: any, frame: any, params: any) => object | null,
 *          wheel: (steps: number, a: any, b: any, frame: any) => void,
 *          rings?: (frame: any) => [number, number] | null}} tool
 */
function drawOnModel(layer, tool) {
  if (!state.info) return showError("Open a file first", "Load a sliced .gcode.3mf or .gcode, then draw on it.");
  status(`${tool.drag} · Esc cancels`);
  // Light up the button that started this; the panel rebuild at the end clears it.
  if (document.activeElement?.matches("button.draw")) document.activeElement.classList.add("on");
  const before = { ...layer.params };
  const adjustHint = () => status(`${tool.adjust()} · click or Enter when done`);
  preview.startStroke({
    onMove(a, b, frame) {
      const s = tool.solve(a, b, frame, layer.params);
      if (s) { Object.assign(layer.params, s); changed(); }
    },
    onRelease: adjustHint,
    onWheel(steps, a, b, frame) {
      tool.wheel(steps, a, b, frame);
      panel.refresh();
      adjustHint();
      changed();
    },
    onEnd(a) {
      // Esc before letting go, or a press that missed the part, puts the layer back as it was.
      if (!a) Object.assign(layer.params, before);
      status("");
      panel.refresh();
      changed();
    },
  }, { rings: tool.rings });
}

// Declarations, not consts: the panel is handed these before this point in the file.
function drawSpiral(layer) {
  const p = layer.params;
  drawOnModel(layer, {
    drag: "drag along the part where one stripe should run",
    adjust: () => `${p.starts} start${p.starts === 1 ? "" : "s"} · scroll for more or fewer`,
    solve: spiralFromStroke,
    wheel(steps, a, b, frame) {
      p.starts = Math.max(1, Math.min(32, p.starts + steps));
      // Re-solve so a stripe still runs along the drawn stroke with the new count.
      const s = spiralFromStroke(a, b, frame, p);
      if (s) Object.assign(p, s);
    },
  });
}

function drawGradient(layer) {
  const p = layer.params;
  drawOnModel(layer, {
    drag: "drag from where fuzz is strongest to where it fades out",
    adjust: () => `fade over ${Math.round(p.to - p.from)}% of the height · scroll to tighten or loosen`,
    solve: gradientFromStroke,
    wheel: (steps) => Object.assign(p, tightenGradient(p, steps)),
    // The rings follow the layer, not the cursor, so they show the falloff scrolling sets.
    rings(frame) {
      const z = (pct) => frame.minZ + (pct / 100) * (frame.maxZ - frame.minZ);
      return p.startAmp >= p.endAmp ? [z(p.from), z(p.to)] : [z(p.to), z(p.from)];
    },
  });
}

// Layer range sliders.
function applyLayerRange() {
  let lo = +$("layerLo").value, hi = +$("layerHi").value;
  if (lo > hi) [lo, hi] = [hi, lo];
  $("layerLabel").textContent = `layers ${lo}–${hi}`;
  preview.setLayerRange(lo, hi);
}
$("layerLo").addEventListener("input", applyLayerRange);
$("layerHi").addEventListener("input", applyLayerRange);

for (const b of document.querySelectorAll("[data-view]")) {
  b.addEventListener("click", () => {
    state.view = b.dataset.view;
    for (const o of document.querySelectorAll("[data-view]")) o.classList.toggle("on", o === b);
    refreshPreview();
  });
}

// Lines or solid beads. Kept per viewer, since it's a viewing preference rather than a setting.
const DISPLAY_KEY = "fuzzyspiral.display";
function setDisplay(mode) {
  preview.setDisplay(mode);
  for (const o of document.querySelectorAll("[data-display]")) o.classList.toggle("on", o.dataset.display === mode);
  try { localStorage.setItem(DISPLAY_KEY, mode); } catch {}
}
for (const b of document.querySelectorAll("[data-display]")) b.addEventListener("click", () => setDisplay(b.dataset.display));
try { setDisplay(localStorage.getItem(DISPLAY_KEY) === "solid" ? "solid" : "lines"); } catch { setDisplay("lines"); }

function showInfo(info) {
  state.info = info;
  const n = Math.max(1, info.layerCount);
  for (const id of ["layerLo", "layerHi"]) { $(id).max = String(n); $(id).min = "1"; }
  $("layerLo").value = "1";
  $("layerHi").value = String(n);
  $("fileInfo").replaceChildren(
    Object.assign(document.createElement("div"), { className: "fname", textContent: info.name }),
    Object.assign(document.createElement("div"), {
      className: "meta",
      textContent: `${info.layerCount} layers · ${info.objects.length} object${info.objects.length === 1 ? "" : "s"}`,
      title: `Made by ${info.dialect} · ${info.lines.toLocaleString()} lines · ${info.runs.toLocaleString()} outer-wall runs`,
    }),
    ...info.warnings.map((w) => Object.assign(document.createElement("div"), { className: "warn", textContent: w })),
  );
  const plateSel = $("plate");
  plateSel.hidden = info.plates.length < 2;
  plateSel.replaceChildren(...info.plates.map((p) => Object.assign(document.createElement("option"), { value: p, textContent: `Plate ${p}`, selected: p === info.plate })));
  $("export3mf").disabled = info.kind !== "3mf";
  $("exportGcode").disabled = false;
  $("empty").hidden = true;
}

async function openFile(file) {
  status(`reading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const { info } = await call({ type: "load", name: file.name, bytes: buf }, [buf]);
    preview.resetFraming();
    showInfo(info);
    status("");
    await refreshPreview();
  } catch (e) {
    showError("Couldn't open the file", e.message);
  }
}

$("plate").addEventListener("change", async (e) => {
  const { info } = await call({ type: "plate", plate: +e.target.value });
  preview.resetFraming();
  showInfo(info);
  refreshPreview();
});

$("open").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", (e) => { const f = e.target.files?.[0]; if (f) openFile(f); e.target.value = ""; });
window.addEventListener("dragover", (e) => { e.preventDefault(); document.body.classList.add("drag"); });
window.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("drag"); });
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("drag");
  const f = e.dataTransfer?.files?.[0];
  if (f) openFile(f);
});

function outName(format) {
  const base = state.info.name.replace(/\.gcode\.3mf$|\.3mf$|\.gcode$/i, "");
  return format === "3mf" ? `${base}-fuzzy.gcode.3mf` : `${base}-fuzzy.gcode`;
}

async function doExport(format) {
  if (!state.info) return;
  status("writing…");
  try {
    const { bytes } = await call({ type: "export", settings: settingsSnapshot(), format });
    const blob = new Blob([bytes], { type: format === "3mf" ? "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" : "text/plain" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: outName(format) });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    const saved = `saved ${a.download}`;
    status(saved);
    // Clear it later, unless something else (a drawing tool's hint) has taken the line since.
    setTimeout(() => { if (statusText === saved) status(""); }, 4000);
  } catch (e) {
    showError("Couldn't export", e.message);
  }
}
$("export3mf").addEventListener("click", () => doExport("3mf"));
$("help").addEventListener("click", () => $("helpDialog").showModal());
$("exportGcode").addEventListener("click", () => doExport("gcode"));

// Pattern settings as a file, for sharing or keeping a library of looks.
function savePattern() {
  const blob = new Blob([JSON.stringify(state.settings, null, 2)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: "fuzzy-pattern.json" });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
$("settingsFile").addEventListener("change", async (e) => {
  const f = e.target.files?.[0];
  e.target.value = "";
  if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (!Array.isArray(s.stack)) throw new Error("not a pattern file");
    state.settings = { ...defaults(), ...s, fuzz: { ...DEFAULT_FUZZ, ...s.fuzz } };
    panel.refresh();
    changed();
  } catch (err) {
    showError("Couldn't load the pattern", err.message);
  }
});
