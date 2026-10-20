// A close-up of the fuzz on a short straight wall, drawn top-down at a fixed zoom.
//
// On a whole part, 0.3 mm of jitter is a few pixels, so thickness and point distance are hard to
// judge from the main preview. The swatch runs the real fuzz code on a synthetic wall, so what
// it shows is exactly what the export will do with those settings.

import { applyFuzz } from "../core/fuzz.js";
import { makeLayer } from "../core/patterns.js";

const VIEW_MM = 8;         // wall length shown
const PAD_MM = 4;          // extra wall each side, so the unmoved seam ends stay out of view
const BEAD_MM = 0.42;      // typical outer-wall line width
const W = 280, H = 120;    // CSS pixels
const SCALE = W / VIEW_MM; // px per mm

/** A single straight outer wall, in the shape parse.js produces. */
function syntheticWall() {
  const x0 = -PAD_MM, x1 = VIEW_MM + PAD_MM;
  return {
    runs: [{
      start: 0, end: 0, layer: 2, obj: "",
      from: { x: x0, y: 0, z: 0.4 },
      segs: [{ to: { x: x1, y: 0, z: 0.4 }, e: (x1 - x0) * 0.03, f: 3000 }],
      fIn: 3000, fOut: 3000, absE: false, eIn: 0,
    }],
    // The object's center sits below the wall, so the air side (outward) is +y.
    objects: { "": { minX: x0, maxX: x1, minY: -10, maxY: -10, minZ: 0, maxZ: 1 } },
  };
}

const STACK = [makeLayer("constant")];

export function createSwatch() {
  const canvas = document.createElement("canvas");
  canvas.width = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  canvas.style.width = `${W}px`;
  canvas.style.height = `${H}px`;
  const caption = document.createElement("div");
  caption.className = "swatch-cap";
  const el = document.createElement("div");
  el.className = "swatch";
  el.hidden = true;
  el.append(canvas, caption);
  document.body.append(el);

  const ctx = canvas.getContext("2d");
  const wall = syntheticWall();

  /** @param {import('../core/fuzz.js').FuzzSettings} fuzz */
  function draw(fuzz) {
    const settings = {
      fuzz: { ...fuzz, skipFirstLayer: false, walls: "all" },
      center: { mode: "auto" },
      stack: STACK,
    };
    const segs = applyFuzz(wall, settings).out[0] ?? wall.runs[0].segs;
    const pts = [wall.runs[0].from, ...segs.map((s) => s.to)];

    const css = getComputedStyle(document.documentElement);
    const cool = css.getPropertyValue("--cool").trim() || "#5b7fb8";
    const accent = css.getPropertyValue("--accent").trim() || "#ff8a3d";
    const dim = css.getPropertyValue("--dim").trim() || "#9a9a9a";

    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cy = H / 2 - 6;
    const X = (x) => x * SCALE;
    const Y = (y) => cy - y * SCALE;

    // The original bead: a straight band one line width wide.
    ctx.fillStyle = cool;
    ctx.globalAlpha = 0.22;
    ctx.fillRect(0, Y(BEAD_MM / 2), W, BEAD_MM * SCALE);
    ctx.globalAlpha = 1;

    // The fuzzed bead, drawn at its printed width, then its centerline.
    const path = () => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
    };
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    path();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = BEAD_MM * SCALE;
    ctx.stroke();
    ctx.globalAlpha = 1;
    path();
    ctx.lineWidth = 1.25;
    ctx.stroke();

    // New points, so point distance reads directly.
    ctx.fillStyle = accent;
    for (const p of pts) {
      if (p.x < 0 || p.x > VIEW_MM) continue;
      ctx.beginPath();
      ctx.arc(X(p.x), Y(p.y), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // 1 mm scale bar.
    ctx.strokeStyle = dim;
    ctx.fillStyle = dim;
    ctx.lineWidth = 1;
    const by = H - 10;
    ctx.beginPath();
    ctx.moveTo(8, by); ctx.lineTo(8 + SCALE, by);
    ctx.moveTo(8, by - 3); ctx.lineTo(8, by + 3);
    ctx.moveTo(8 + SCALE, by - 3); ctx.lineTo(8 + SCALE, by + 3);
    ctx.stroke();
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("1 mm", 12 + SCALE, by + 3.5);

    const shown = pts.filter((p) => p.x >= 0 && p.x <= VIEW_MM).length;
    caption.textContent = `Top-down close-up of ${VIEW_MM} mm of wall · ${shown} points · blue is the original bead`;
  }

  /** Place the swatch beside `anchor`: right of the sidebar, or below it when stacked. */
  function showAt(anchor) {
    el.hidden = false;
    const r = anchor.getBoundingClientRect();
    const side = anchor.closest(".side")?.getBoundingClientRect() ?? r;
    const bw = el.offsetWidth, bh = el.offsetHeight;
    let left = side.right + 10;
    let top = r.top + r.height / 2 - bh / 2;
    if (left + bw > innerWidth - 8) { left = Math.max(8, r.left); top = r.bottom + 6; }
    el.style.left = `${left}px`;
    el.style.top = `${Math.min(Math.max(8, top), innerHeight - bh - 8)}px`;
  }

  return { draw, showAt, hide: () => { el.hidden = true; } };
}
