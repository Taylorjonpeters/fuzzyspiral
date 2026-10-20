// Pattern masks: where the fuzz goes, as a pure function of position.
//
// A mask is a stack of layers. Each layer maps a sample point to 0..1, then blends into the
// running value. Every periodic pattern is expressed as a phase `u` in [0, 1) plus a duty
// cycle, so feathering works the same way for spirals, stripes, bands and checkers.

/**
 * @typedef {object} Sample
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} layer   1-based, matching the layer numbers Bambu Studio shows
 * @property {number} theta   angle around the object's pattern center, radians [-π, π]
 * @property {number} r       distance from the object's pattern center, mm
 * @property {number} t       height as a fraction of the object's printed height, 0..1
 */

/**
 * @typedef {object} MaskLayer
 * @property {string} id
 * @property {'constant'|'zrange'|'radius'|'spiral'|'stripes'|'bands'|'checker'|'gradient'} type
 * @property {boolean} enabled
 * @property {'max'|'add'|'multiply'|'subtract'|'min'} blend   ignored for the first enabled layer
 * @property {boolean} invert
 * @property {number} strength  0..1, scales this layer's output before blending
 * @property {number} feather   edge softness as a fraction of one period (zrange: mm)
 * @property {Record<string, any>} params
 */

const TAU = Math.PI * 2;

const frac = (v) => v - Math.floor(v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (a, b, v) => {
  if (a === b) return v < a ? 0 : 1;
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/**
 * 1 inside [0, duty) of a unit period, 0 outside, with feathered edges.
 * The signed distance to the nearest band edge is in period units, so `feather` is too.
 */
export function band(u, duty, feather) {
  if (duty >= 1) return 1;
  if (duty <= 0) return 0;
  const inside = u < duty;
  const d = inside ? Math.min(u, duty - u) : -Math.min(u - duty, 1 - u);
  if (feather <= 0) return d >= 0 ? 1 : 0;
  return smoothstep(-feather / 2, feather / 2, d);
}

/** Angle as a fraction of a turn, 0..1, starting at +X and running counter-clockwise. */
const turn = (theta) => frac(theta / TAU);

/** @type {Record<MaskLayer['type'], (s: Sample, p: any, feather: number) => number>} */
const EVAL = {
  constant: () => 1,

  // Fuzz only between two heights. `unit` picks layer numbers or millimetres.
  zrange(s, p, feather) {
    const v = p.unit === "layer" ? s.layer : s.z;
    const lo = Number(p.from), hi = Number(p.to);
    // A layer range is inclusive at both ends; feathering in layers is meaningless.
    if (p.unit === "layer") return v >= lo && v <= hi ? 1 : 0;
    const f = feather / 2;
    return smoothstep(lo - f, lo + f, v) * (1 - smoothstep(hi - f, hi + f, v));
  },

  // Fuzz only between two distances from the pattern center: keeps a lamp's core or a
  // vase's inner features smooth however they connect to the outer skin.
  radius(s, p, feather) {
    const f = feather / 2;
    const hi = p.max > 0 ? 1 - smoothstep(p.max - f, p.max + f, s.r) : 1;
    return smoothstep(p.min - f, p.min + f, s.r) * hi;
  },

  // A helix: stripes that wind around the object as it rises.
  // `pitch` is the height one stripe climbs in a full turn; `starts` is how many stripes.
  spiral(s, p, feather) {
    const hand = p.hand === "left" ? -1 : 1;
    const u = frac(p.starts * (hand * turn(s.theta) - s.z / p.pitch) + p.phase);
    return band(u, p.duty, feather);
  },

  // Vertical stripes evenly spaced around the object.
  stripes(s, p, feather) {
    return band(frac(p.count * turn(s.theta) + p.phase), p.duty, feather);
  },

  // Horizontal rings every `period` mm.
  bands(s, p, feather) {
    return band(frac(s.z / p.period + p.phase), p.duty, feather);
  },

  checker(s, p, feather) {
    const a = band(frac(p.count * turn(s.theta) + p.phase), 0.5, feather);
    const b = band(frac(s.z / p.period), 0.5, feather);
    return a * (1 - b) + b * (1 - a);
  },

  // Amplitude ramps between two heights given as percent of the object's height.
  gradient(s, p) {
    const lo = p.from / 100, hi = p.to / 100;
    const k = lo === hi ? (s.t < lo ? 0 : 1) : clamp01((s.t - lo) / (hi - lo));
    const eased = p.ease ? k * k * (3 - 2 * k) : k;
    return p.startAmp + (p.endAmp - p.startAmp) * eased;
  },
};

/**
 * Evaluate a mask stack at one sample.
 * @param {MaskLayer[]} stack
 * @param {Sample} s
 * @returns {number} 0..1
 */
export function evalMask(stack, s) {
  let acc = 0;
  let first = true;
  for (const L of stack) {
    if (!L.enabled) continue;
    const fn = EVAL[L.type];
    if (!fn) continue;
    let v = clamp01(fn(s, L.params, L.feather ?? 0));
    if (L.invert) v = 1 - v;
    v *= L.strength ?? 1;
    if (first) { acc = v; first = false; continue; }
    switch (L.blend) {
      case "add": acc = acc + v; break;
      case "multiply": acc = acc * v; break;
      case "subtract": acc = acc - v; break;
      case "min": acc = Math.min(acc, v); break;
      default: acc = Math.max(acc, v);
    }
    acc = clamp01(acc);
  }
  return acc;
}

let nextId = 1;
const uid = () => `L${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Defaults per type, so a freshly added layer already does something visible. */
export const LAYER_DEFAULTS = {
  constant: { feather: 0, params: {} },
  zrange: { feather: 0, params: { unit: "layer", from: 2, to: 40 } },
  radius: { feather: 1, params: { min: 20, max: 0 } },
  spiral: { feather: 0.1, params: { starts: 3, pitch: 30, duty: 0.5, hand: "right", phase: 0 } },
  stripes: { feather: 0.1, params: { count: 12, duty: 0.5, phase: 0 } },
  bands: { feather: 0.1, params: { period: 4, duty: 0.5, phase: 0 } },
  checker: { feather: 0.05, params: { count: 8, period: 5, phase: 0 } },
  gradient: { feather: 0, params: { from: 0, to: 100, startAmp: 1, endAmp: 0, ease: true } },
};

/**
 * @param {MaskLayer['type']} type
 * @param {Partial<MaskLayer> & {params?: object}} [over]
 * @returns {MaskLayer}
 */
export function makeLayer(type, over = {}) {
  const d = LAYER_DEFAULTS[type];
  return {
    id: uid(),
    type,
    enabled: true,
    blend: "max",
    invert: false,
    strength: 1,
    feather: d.feather,
    ...over,
    params: { ...d.params, ...(over.params ?? {}) },
  };
}

/** Named starting points. Each returns a fresh stack so presets are never shared by reference. */
export const PRESETS = {
  "Spiral, 3-start": () => [makeLayer("spiral")],
  "Stripes ×12": () => [makeLayer("stripes")],
  "Fuzz up to layer 40": () => [makeLayer("zrange", { params: { unit: "layer", from: 2, to: 40 } })],
  "Fade out toward the top": () => [makeLayer("gradient")],
  "Spiral that fades out": () => [
    makeLayer("spiral", { params: { starts: 2, pitch: 40 } }),
    makeLayer("gradient", { blend: "multiply" }),
  ],
  "Checker": () => [makeLayer("checker")],
  "Everywhere (plain fuzzy skin)": () => [makeLayer("constant")],
};

/**
 * Spiral settings from a stroke dragged along the part: the stripe should run from `a` to `b`.
 *
 * A stripe is a line of constant phase, so along it hand·Δturn = Δz / pitch. The stroke's change
 * in angle and height gives pitch and twist; phase is then set so a stripe's middle passes
 * through `a`. The stroke is taken as the short way round (under half a turn), which is what
 * dragging across the visible side of a part gives.
 *
 * @param {{x:number,y:number,z:number}} a
 * @param {{x:number,y:number,z:number}} b
 * @param {{x:number,y:number}} center
 * @param {{starts:number, duty:number}} params
 * @returns {{pitch:number, hand:'right'|'left', phase:number} | null}  null for a stroke too short to read
 */
export function spiralFromStroke(a, b, center, params, limits = { minPitch: 2, maxPitch: 1000 }) {
  const turnOf = (p) => frac(Math.atan2(p.y - center.y, p.x - center.x) / TAU);
  let dTurn = turnOf(b) - turnOf(a);
  dTurn -= Math.round(dTurn);
  const dz = b.z - a.z;
  const r = Math.hypot(a.x - center.x, a.y - center.y);
  // Ignore strokes shorter than about a millimetre along the surface.
  if (Math.hypot(dTurn * TAU * r, dz) < 1) return null;
  const hand = dTurn * dz >= 0 ? "right" : "left";
  const raw = Math.abs(dTurn) < 1e-6 ? Infinity : Math.abs(dz / dTurn);
  const pitch = Math.min(limits.maxPitch, Math.max(limits.minPitch, raw));
  const sign = hand === "left" ? -1 : 1;
  const phase = frac(params.duty / 2 - params.starts * (sign * turnOf(a) - a.z / pitch));
  return { pitch: Math.round(pitch * 10) / 10, hand, phase: Math.round(phase * 1000) / 1000 };
}

/**
 * Gradient settings from a stroke dragged up or down the part: full fuzz where the drag starts,
 * fading to none where it ends. Heights become percentages of the object's printed height, the
 * unit the gradient layer works in. The layer's own amounts are kept as the strong and weak ends
 * when they differ, so a gentler gradient stays gentle.
 *
 * @param {{z:number}} a  where the fuzz is strongest
 * @param {{z:number}} b  where it has faded out
 * @param {{minZ:number, maxZ:number}} frame
 * @param {{startAmp:number, endAmp:number}} params
 * @returns {{from:number, to:number, startAmp:number, endAmp:number} | null}  null for a stroke too short to read
 */
export function gradientFromStroke(a, b, frame, params) {
  const h = frame.maxZ - frame.minZ;
  if (h <= 0 || Math.abs(b.z - a.z) < 0.5) return null;
  const pct = (z) => Math.round(clamp01((z - frame.minZ) / h) * 1000) / 10;
  let strong = Math.max(params.startAmp, params.endAmp);
  let weak = Math.min(params.startAmp, params.endAmp);
  if (strong === weak) { strong = 1; weak = 0; }
  const up = b.z > a.z;
  return {
    from: pct(Math.min(a.z, b.z)),
    to: pct(Math.max(a.z, b.z)),
    // The gradient runs bottom to top, so a downward drag puts the strong end on top.
    startAmp: up ? strong : weak,
    endAmp: up ? weak : strong,
  };
}

/**
 * Tighten (steps > 0) or loosen (steps < 0) a gradient's falloff: the ramp between its start and
 * end heights shrinks or grows about its middle, 15% per step, staying inside the part.
 * @param {{from:number, to:number}} params  heights in percent of the part
 * @param {number} steps
 * @returns {{from:number, to:number}}
 */
export function tightenGradient(params, steps) {
  const mid = (params.from + params.to) / 2;
  let half = (Math.abs(params.to - params.from) / 2) * Math.pow(0.85, steps);
  half = Math.max(0.5, Math.min(50, half));
  // Keep the whole ramp on the part: slide the middle in if it would hang off either end.
  const m = Math.max(half, Math.min(100 - half, mid));
  const r = (v) => Math.round(v * 10) / 10;
  return { from: r(m - half), to: r(m + half) };
}
