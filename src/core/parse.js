// G-code parsing: find the outer-wall runs and leave everything else alone.
//
// The output of this module is an index over the original text, not a rewrite of it. A run
// records the line range it came from; emit.js copies every other line verbatim. That is
// what makes "a mask of zero gives byte-identical output" true by construction.

import { linearizeArc } from "./geometry.js";

/**
 * @typedef {object} Pt
 * @property {number} x
 * @property {number} y
 * @property {number} z
 */

/**
 * One extruding move inside a run, from the previous point to `to`.
 * @typedef {object} Seg
 * @property {Pt} to
 * @property {number} e      filament for this move (relative, whatever the file's E mode)
 * @property {number} f      feedrate in effect for this move
 */

/**
 * A maximal stretch of consecutive outer-wall extrusion moves.
 * @typedef {object} Run
 * @property {number} start     first line index (inclusive)
 * @property {number} end       last line index (inclusive)
 * @property {number} layer     1-based
 * @property {string} obj       object key ("" when the file has no object labels)
 * @property {Pt} from          where the nozzle was before the first move
 * @property {Seg[]} segs
 * @property {number} fIn       feedrate in effect before the run
 * @property {number} fOut      feedrate in effect after the run
 * @property {number} width     extrusion width from the slicer's comments, mm (preview only)
 * @property {number} height    layer height from the slicer's comments, mm (preview only)
 * @property {boolean} absE     file was in M82 absolute-E mode during this run
 * @property {number} eIn       absolute E before the run (absE only)
 */

/**
 * @typedef {object} Parsed
 * @property {string[]} lines       original lines, without the newline
 * @property {string} eol           "\n" or "\r\n"
 * @property {Run[]} runs
 * @property {'bambu'|'prusa'|'orca'|'cura'|'unknown'} dialect
 * @property {number} layerCount
 * @property {Record<string, {minX:number,maxX:number,minY:number,maxY:number,minZ:number,maxZ:number}>} objects
 * @property {string[]} warnings
 */

const OUTER = [
  /^;\s*FEATURE:\s*Outer wall/i,      // Bambu Studio, OrcaSlicer
  /^;TYPE:\s*External perimeter/i,    // PrusaSlicer, SuperSlicer
  /^;TYPE:\s*Outer wall/i,            // OrcaSlicer (Prusa-style labels)
  /^;TYPE:\s*WALL-OUTER/i,            // Cura
];
const FEATURE = /^;\s*(FEATURE|TYPE):/i;
const LAYER = /^;\s*(CHANGE_LAYER|LAYER_CHANGE)\b|^;LAYER:-?\d+/;
const WIDTH = /^;\s*(?:LINE_)?WIDTH:\s*([\d.]+)/;          // Bambu/Orca "; LINE_WIDTH:", Prusa ";WIDTH:"
const HEIGHT = /^;\s*(?:LAYER_)?HEIGHT:\s*([\d.]+)/;        // Bambu/Orca "; LAYER_HEIGHT:", Prusa ";HEIGHT:"
const WIPE_START = /^;\s*WIPE_START/;
const WIPE_END = /^;\s*WIPE_END/;
const OBJ_START = [
  /^;\s*start printing object, unique label id:\s*(\S+)/,   // Bambu
  /^EXCLUDE_OBJECT_START\s+NAME=(\S+)/i,                     // Klipper
  /^M486\s+S(\d+)/,                                           // Prusa / Marlin labels
  /^;MESH:(.+)/,                                              // Cura
];
const OBJ_END = [
  /^;\s*stop printing object/,
  /^EXCLUDE_OBJECT_END/i,
  /^M486\s+S-1/,
];

/**
 * @param {string} line  already stripped of a trailing \r
 * @returns {{cmd: string, w: Record<string, number>} | null}
 */
function parseCommand(line) {
  const semi = line.indexOf(";");
  const code = (semi >= 0 ? line.slice(0, semi) : line).trim();
  if (!code) return null;
  const parts = code.split(/\s+/);
  const cmd = parts[0].toUpperCase();
  /** @type {Record<string, number>} */
  const w = {};
  for (let i = 1; i < parts.length; i++) {
    const k = parts[i][0]?.toUpperCase();
    const v = parseFloat(parts[i].slice(1));
    if (k && !Number.isNaN(v)) w[k] = v;
  }
  return { cmd, w };
}

function detectDialect(head) {
  if (/BambuStudio|BBL/i.test(head)) return "bambu";
  if (/OrcaSlicer/i.test(head)) return "orca";
  if (/PrusaSlicer|SuperSlicer/i.test(head)) return "prusa";
  if (/Cura_SteamEngine|;FLAVOR:/i.test(head)) return "cura";
  return "unknown";
}

/**
 * @param {string} text
 * @returns {Parsed}
 */
export function parseGcode(text) {
  const lines = text.split("\n");
  const eol = lines.length > 1 && lines[0].endsWith("\r") ? "\r\n" : "\n";
  const dialect = detectDialect(lines.slice(0, 400).join("\n"));
  /** @type {string[]} */
  const warnings = [];

  let x = 0, y = 0, z = 0, e = 0, f = 0;
  let absXYZ = true, absE = true;
  let outer = false, wipe = false;
  let layer = 0;
  // Some slicers write two layer markers back to back; count a layer once per move.
  let movedSinceLayer = true;
  let obj = "";
  // Cura writes neither; these are typical 0.4 mm nozzle values.
  let width = 0.42, height = 0.2;
  let arcCount = 0;

  /** @type {Run[]} */
  const runs = [];
  /** @type {Run | null} */
  let run = null;
  const objects = {};

  const close = () => {
    if (run && run.segs.length) runs.push(run);
    run = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const t = line.trimStart();

    if (t.startsWith(";")) {
      // Any comment ends a run. Runs only ever span move lines, so the replaced range
      // never swallows a marker that some other tool (or the printer) reads.
      close();
      const wm = t.match(WIDTH); if (wm) width = parseFloat(wm[1]) || width;
      const hm = t.match(HEIGHT); if (hm) height = parseFloat(hm[1]) || height;
      if (LAYER.test(t)) { if (movedSinceLayer) layer++; movedSinceLayer = false; }
      else if (FEATURE.test(t)) outer = OUTER.some((r) => r.test(t));
      else if (WIPE_START.test(t)) wipe = true;
      else if (WIPE_END.test(t)) wipe = false;
      else {
        for (const r of OBJ_START) { const m = t.match(r); if (m && r !== OBJ_START[2]) { obj = m[1].trim(); break; } }
        if (OBJ_END[0].test(t)) obj = "";
      }
      continue;
    }

    const c = parseCommand(line);
    if (!c) { close(); continue; }

    if (OBJ_END.some((r) => r.test(t))) { close(); obj = ""; continue; }
    const m486 = t.match(OBJ_START[2]);
    if (m486) { close(); obj = m486[1]; continue; }
    const kl = t.match(OBJ_START[1]);
    if (kl) { close(); obj = kl[1]; continue; }

    switch (c.cmd) {
      case "G90": absXYZ = true; close(); continue;
      case "G91": absXYZ = false; close(); continue;
      case "M82": absE = true; close(); continue;
      case "M83": absE = false; close(); continue;
      case "G92": if ("E" in c.w) e = c.w.E; close(); continue;
      case "G0": case "G1": case "G2": case "G3": break;
      default: close(); continue;
    }

    const w = c.w;
    movedSinceLayer = true;
    const nx = "X" in w ? (absXYZ ? w.X : x + w.X) : x;
    const ny = "Y" in w ? (absXYZ ? w.Y : y + w.Y) : y;
    const nz = "Z" in w ? (absXYZ ? w.Z : z + w.Z) : z;
    const de = "E" in w ? (absE ? w.E - e : w.E) : 0;
    const nf = "F" in w ? w.F : f;
    const moves = nx !== x || ny !== y;

    // A feed-only G1 inside a run is kept in the run: overhang slowdowns emit these mid-wall.
    const feedOnly = c.cmd === "G1" && !moves && nz === z && de === 0 && "F" in w;
    const extruding = c.cmd !== "G0" && moves && de > 0;

    // Relative XY (G91) runs are left alone: offsetting one point would shift every later one.
    if (outer && !wipe && absXYZ && (extruding || (feedOnly && run))) {
      if (!run) {
        run = { start: i, end: i, layer, obj, from: { x, y, z }, segs: [], fIn: f, fOut: f, absE, eIn: e, width, height };
      }
      run.end = i;
      run.fOut = nf;
      if (extruding) {
        if (c.cmd === "G2" || c.cmd === "G3") {
          arcCount++;
          const pts = linearizeArc({ x, y, z }, { x: nx, y: ny, z: nz }, w.I ?? 0, w.J ?? 0, c.cmd === "G2");
          let prev = { x, y, z }, total = 0;
          const lens = pts.map((p) => { const d = Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; total += d; return d; });
          pts.forEach((p, k) => run.segs.push({ to: p, e: total > 0 ? (de * lens[k]) / total : de / pts.length, f: nf }));
        } else {
          run.segs.push({ to: { x: nx, y: ny, z: nz }, e: de, f: nf });
        }
        const b = (objects[obj] ??= { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity });
        for (const p of [{ x, y, z }, { x: nx, y: ny, z: nz }]) {
          if (p.x < b.minX) b.minX = p.x; if (p.x > b.maxX) b.maxX = p.x;
          if (p.y < b.minY) b.minY = p.y; if (p.y > b.maxY) b.maxY = p.y;
          if (p.z < b.minZ) b.minZ = p.z; if (p.z > b.maxZ) b.maxZ = p.z;
        }
      }
    } else {
      close();
    }

    x = nx; y = ny; z = nz; f = nf;
    if ("E" in w) e = absE ? w.E : e + w.E;
  }
  close();

  if (!runs.length) warnings.push("No outer-wall moves found. Is this sliced G-code with feature comments (; FEATURE: / ;TYPE:)?");
  if (arcCount) warnings.push(`${arcCount} arc moves in outer walls were converted to line segments where fuzz applies.`);
  if (dialect === "unknown") warnings.push("Couldn't tell which slicer made this file; using generic markers.");

  return { lines, eol, runs, dialect, layerCount: layer, objects, warnings };
}
