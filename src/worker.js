// Parsing and fuzzing run here so a multi-million-line file doesn't freeze the page.
// The parsed file lives only in the worker; the page gets summaries and preview buffers.

import { parseGcode } from "./core/parse.js";
import { applyFuzz, maskSampler, objectFrames } from "./core/fuzz.js";
import { emitGcode } from "./core/emit.js";
import { runPoints } from "./core/geometry.js";
import { readArchive, plateGcode, checkMd5, writeArchive } from "./io/threemf.js";

/** @type {{name:string, archive: any, plate: number, parsed: any} | null} */
let doc = null;
/** @type {{key: string, result: ReturnType<typeof applyFuzz>} | null} */
let cache = null;

const isZip = (b) => b[0] === 0x50 && b[1] === 0x4b;

function fuzzed(settings) {
  const key = JSON.stringify(settings);
  if (cache?.key !== key) cache = { key, result: applyFuzz(doc.parsed, settings) };
  return cache.result;
}

function loadPlate(plate) {
  const text = doc.archive ? plateGcode(doc.archive, plate) : doc.text;
  doc.plate = plate;
  doc.parsed = parseGcode(text);
  cache = null;
  const p = doc.parsed;
  const md5 = doc.archive ? checkMd5(doc.archive, plate) : null;
  const warnings = [...p.warnings];
  if (md5 && !md5.ok) warnings.push("The stored checksum doesn't match this plate's G-code. The export will carry a correct one.");
  return {
    name: doc.name,
    kind: doc.archive ? "3mf" : "gcode",
    plates: doc.archive?.plates ?? [],
    plate,
    dialect: p.dialect,
    layerCount: p.layerCount,
    runs: p.runs.length,
    lines: p.lines.length,
    objects: Object.keys(p.objects),
    warnings,
  };
}

/** Line-segment buffers for the preview, colored by mask value, grouped by layer. */
function previewBuffers(settings, view) {
  const p = doc.parsed;
  const { out, frames, stats } = fuzzed(settings);
  const mask = maskSampler(settings, objectFrames(p, settings.center));
  let n = 0;
  p.runs.forEach((r, k) => { n += view === "fuzzed" && out[k] ? out[k].length : r.segs.length; });
  const pos = new Float32Array(n * 6);
  const amp = new Float32Array(n * 2);
  const layerStart = new Int32Array(p.layerCount + 2).fill(-1);
  let v = 0;
  p.runs.forEach((r, k) => {
    for (let L = 0; L <= r.layer; L++) if (layerStart[L] < 0) layerStart[L] = v;
    let prev = r.from;
    let prevAmp = 0;
    if (view === "fuzzed" && out[k]) {
      for (const s of out[k]) {
        pos.set([prev.x, prev.y, prev.z, s.to.x, s.to.y, s.to.z], v * 3);
        amp[v] = prevAmp; amp[v + 1] = s.amp;
        v += 2; prev = s.to; prevAmp = s.amp;
      }
    } else {
      // Original view shows where the pattern lands; fuzzed view shows only what changed,
      // so runs left alone (first layer, holes when skipped) are drawn smooth.
      const ampAt = view === "fuzzed" ? () => 0 : (q) => mask(q.x, q.y, q.z, r.layer, r.obj);
      const pts = runPoints(r);
      prevAmp = ampAt(prev);
      for (let i = 1; i < pts.length; i++) {
        const q = pts[i];
        const a = ampAt(q);
        pos.set([prev.x, prev.y, prev.z, q.x, q.y, q.z], v * 3);
        amp[v] = prevAmp; amp[v + 1] = a;
        v += 2; prev = q; prevAmp = a;
      }
    }
  });
  for (let L = 0; L < layerStart.length; L++) if (layerStart[L] < 0) layerStart[L] = v;
  return { pos, amp, layerStart, frames, stats };
}

function exportBytes(settings, format) {
  const g = emitGcode(doc.parsed, fuzzed(settings).out);
  if (format === "3mf") return writeArchive(doc.archive, doc.plate, g);
  return new TextEncoder().encode(g);
}

self.onmessage = (ev) => {
  const m = ev.data;
  try {
    if (m.type === "load") {
      const bytes = new Uint8Array(m.bytes);
      doc = { name: m.name, archive: null, text: null, plate: 0, parsed: null };
      if (isZip(bytes)) {
        doc.archive = readArchive(bytes);
        if (!doc.archive.plates.length) throw new Error("This 3MF has no sliced G-code. In Bambu Studio, slice the plate and use File › Export › Export plate sliced file.");
        self.postMessage({ id: m.id, type: "loaded", info: loadPlate(doc.archive.plates[0]) });
      } else {
        doc.text = new TextDecoder().decode(bytes);
        self.postMessage({ id: m.id, type: "loaded", info: loadPlate(0) });
      }
    } else if (m.type === "plate") {
      self.postMessage({ id: m.id, type: "loaded", info: loadPlate(m.plate) });
    } else if (m.type === "preview") {
      const b = previewBuffers(m.settings, m.view);
      self.postMessage({ id: m.id, type: "preview", ...b }, [b.pos.buffer, b.amp.buffer, b.layerStart.buffer]);
    } else if (m.type === "export") {
      const bytes = exportBytes(m.settings, m.format);
      self.postMessage({ id: m.id, type: "exported", bytes }, [bytes.buffer]);
    }
  } catch (err) {
    self.postMessage({ id: m.id, type: "error", message: err?.message ?? String(err) });
  }
};
