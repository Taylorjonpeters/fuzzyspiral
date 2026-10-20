// Fuzzy skin, applied only where the mask says.
//
// Same idea as PrusaSlicer/Orca/Bambu fuzzy skin: walk the wall, drop a point every
// ~point distance, push each one sideways by a random amount. The difference is that the
// push is scaled by the mask, and where the mask is zero the original segment is kept as-is.

import { evalMask } from "./patterns.js";
import { rng, perlin3 } from "./noise.js";
import { airSides, runPoints, outerProfiles } from "./geometry.js";

/**
 * @typedef {object} FuzzSettings
 * @property {number} thickness      max sideways offset, mm (Bambu default 0.3)
 * @property {number} pointDist      mean spacing of new points, mm (Bambu default 0.8)
 * @property {'classic'|'perlin'} noise
 * @property {number} noiseScale     perlin feature size, mm
 * @property {'both'|'outward'} mode
 * @property {number} seed
 * @property {number} maxPtsPerMm    caps point density so fast walls don't stutter
 * @property {boolean} skipFirstLayer
 * @property {'all'|'contour'|'outermost'} walls
 *   'contour' leaves the outer walls of holes smooth; 'outermost' fuzzes only wall points with
 *   nothing further out at the same angle from the pattern center, so a lamp's inner tube, cable
 *   slot and inside face all stay smooth
 */

/**
 * @typedef {object} Settings
 * @property {FuzzSettings} fuzz
 * @property {{mode:'auto'|'custom', x:number, y:number}} center
 * @property {import('./patterns.js').MaskLayer[]} stack
 */

/** @typedef {import('./parse.js').Seg & {amp: number}} OutSeg */

export const DEFAULT_FUZZ = {
  thickness: 0.3,
  pointDist: 0.8,
  noise: "classic",
  noiseScale: 1.5,
  mode: "both",
  seed: 1,
  maxPtsPerMm: 5,
  skipFirstLayer: true,
  walls: "all",
};

/**
 * Pattern centers and height ranges per object.
 * @param {import('./parse.js').Parsed} parsed
 * @param {Settings['center']} center
 */
export function objectFrames(parsed, center) {
  /** @type {Record<string, {x:number,y:number,r:number,minZ:number,maxZ:number}>} */
  const out = {};
  for (const [k, b] of Object.entries(parsed.objects)) {
    out[k] = {
      // Half the larger footprint side: a cylinder the preview can pick strokes against.
      r: Math.max(b.maxX - b.minX, b.maxY - b.minY) / 2,
      x: center?.mode === "custom" ? center.x : (b.minX + b.maxX) / 2,
      y: center?.mode === "custom" ? center.y : (b.minY + b.maxY) / 2,
      minZ: b.minZ,
      maxZ: b.maxZ,
    };
  }
  return out;
}

/**
 * Builds the function that maps a point to its mask value.
 * @param {Settings} settings
 * @param {ReturnType<typeof objectFrames>} frames
 */
export function maskSampler(settings, frames) {
  const fallback = { x: 0, y: 0, minZ: 0, maxZ: 1 };
  return (x, y, z, layer, obj) => {
    const fr = frames[obj] ?? frames[""] ?? fallback;
    const h = fr.maxZ - fr.minZ;
    return evalMask(settings.stack, {
      x, y, z, layer,
      theta: Math.atan2(y - fr.y, x - fr.x),
      r: Math.hypot(x - fr.x, y - fr.y),
      t: h > 0 ? (z - fr.minZ) / h : 0,
    });
  };
}

/**
 * @param {import('./parse.js').Parsed} parsed
 * @param {Settings} settings
 * @returns {{ out: (OutSeg[] | null)[], frames: ReturnType<typeof objectFrames>, stats: {runsChanged:number, pointsBefore:number, pointsAfter:number} }}
 */
export function applyFuzz(parsed, settings) {
  const F = { ...DEFAULT_FUZZ, ...settings.fuzz };
  const frames = objectFrames(parsed, settings.center);
  const { sides, holes } = airSides(parsed.runs, frames);
  const skipWall = (idx) => F.walls === "contour" && holes[idx];
  const sampler = maskSampler(settings, frames);
  /** @type {(p: {x:number,y:number,z:number}, run: import('./parse.js').Run) => number} */
  let mask = (p, run) => sampler(p.x, p.y, p.z, run.layer, run.obj);
  if (F.walls === "outermost") {
    const profiles = outerProfiles(parsed.runs, frames);
    const base = mask;
    mask = (p, run) => {
      const prof = profiles.get(`${run.layer}|${run.obj}`);
      // Within a line and a half of the furthest wall counts as that wall: fuzz and the inner
      // face of a thin shell are both further in than that.
      const inside = prof && prof.bins[prof.binOf(p)] - Math.hypot(p.x - prof.cx, p.y - prof.cy) > 1.5 * run.width;
      return inside ? 0 : base(p, run);
    };
  }
  const perlin = perlin3(F.seed);
  const spacing = Math.max(F.pointDist, 1 / Math.max(F.maxPtsPerMm, 0.01));
  const stats = { runsChanged: 0, pointsBefore: 0, pointsAfter: 0 };

  const out = parsed.runs.map((run, idx) => {
    stats.pointsBefore += run.segs.length;
    if ((F.skipFirstLayer && run.layer <= 1) || skipWall(idx)) {
      stats.pointsAfter += run.segs.length;
      return null;
    }
    const res = fuzzRun(run, sides[idx], F, spacing, mask, perlin, rng((F.seed * 2654435761) ^ (idx + 1)));
    stats.pointsAfter += res ? res.length : run.segs.length;
    if (res) stats.runsChanged++;
    return res;
  });
  return { out, frames, stats };
}

/**
 * @returns {OutSeg[] | null}  null when no point of the run is fuzzed
 */
function fuzzRun(run, side, F, spacing, mask, perlin, rand) {
  const pts = runPoints(run);
  const n = run.segs.length;
  const noiseAt = (p) => {
    if (F.noise === "perlin") {
      const v = Math.max(-1, Math.min(1, 1.6 * perlin(p.x / F.noiseScale, p.y / F.noiseScale, p.z / F.noiseScale)));
      return F.mode === "outward" ? (v + 1) / 2 : v;
    }
    // Classic draws from the run's own sequence, which is always consumed the same way
    // regardless of the mask, so editing the pattern doesn't reshuffle the noise.
    const r = rand();
    return F.mode === "outward" ? r : r * 2 - 1;
  };
  const m = (p) => mask(p, run);
  const normal = (k) => {
    const a = pts[k], b = pts[k + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: (side * (b.y - a.y)) / len, y: (side * -(b.x - a.x)) / len };
  };

  /** @type {OutSeg[]} */
  const res = [];
  let changed = false;
  let prev = pts[0];
  let carry = rand() * spacing * 0.5;
  const vertexMask = pts.map(m);

  for (let k = 0; k < n; k++) {
    const a = pts[k], b = pts[k + 1], seg = run.segs[k];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nrm = normal(k);

    // Interior samples, drawn the same way whatever the mask so noise stays stable.
    const samples = [];
    let d = carry;
    while (d < len) {
      const t = d / len;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
      samples.push({ p, r: noiseAt(p), amp: m(p) });
      d += spacing * (0.75 + rand() * 0.5);
    }
    carry = len > 0 ? d - len : carry;

    // The run's last point is never moved: it is the seam, and the next move starts from it.
    const last = k === n - 1;
    const endAmp = last ? 0 : vertexMask[k + 1];
    const endR = noiseAt(b);
    const prevMoved = prev !== a;

    if (len === 0 || (!prevMoved && endAmp === 0 && samples.every((s) => s.amp === 0))) {
      res.push({ to: b, e: seg.e, f: seg.f, amp: 0 });
      prev = b;
      continue;
    }
    changed = true;
    const ePerMm = seg.e / len;
    const push = (q, amp) => {
      const l = Math.hypot(q.x - prev.x, q.y - prev.y);
      res.push({ to: q, e: ePerMm * l, f: seg.f, amp });
      prev = q;
    };
    for (const s of samples) {
      if (s.amp <= 0) continue; // an unmoved interior point is collinear: drop it
      const off = F.thickness * s.amp * s.r;
      push({ x: s.p.x + nrm.x * off, y: s.p.y + nrm.y * off, z: s.p.z }, s.amp);
    }
    if (endAmp > 0) {
      // Offset a corner along the average of its two edges' normals, so it doesn't pinch.
      const n2 = normal(k + 1);
      let vx = nrm.x + n2.x, vy = nrm.y + n2.y;
      const vl = Math.hypot(vx, vy) || 1;
      vx /= vl; vy /= vl;
      const off = F.thickness * endAmp * endR;
      push({ x: b.x + vx * off, y: b.y + vy * off, z: b.z }, endAmp);
    } else {
      push(b, 0);
    }
  }
  return changed ? res : null;
}
