// Plane geometry for toolpaths: arcs, winding, containment, and which side of a wall is air.

/**
 * Split a G2/G3 arc into chords no longer than `maxSeg` mm.
 * Returns the points after `from`, ending exactly at `to`.
 * @param {{x:number,y:number,z:number}} from
 * @param {{x:number,y:number,z:number}} to
 * @param {number} i  center offset X from `from`
 * @param {number} j  center offset Y from `from`
 * @param {boolean} cw  true for G2
 */
export function linearizeArc(from, to, i, j, cw, maxSeg = 0.2) {
  const cx = from.x + i, cy = from.y + j;
  const r = Math.hypot(i, j);
  const a0 = Math.atan2(from.y - cy, from.x - cx);
  let a1 = Math.atan2(to.y - cy, to.x - cx);
  let sweep = a1 - a0;
  if (cw && sweep >= 0) sweep -= Math.PI * 2;
  if (!cw && sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(1, Math.ceil((Math.abs(sweep) * r) / maxSeg));
  const out = [];
  for (let k = 1; k < n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: from.z + ((to.z - from.z) * k) / n });
  }
  out.push({ x: to.x, y: to.y, z: to.z });
  return out;
}

/** Shoelace area; positive when the polygon runs counter-clockwise. */
export function signedArea(pts) {
  let a = 0;
  for (let k = 0, n = pts.length; k < n; k++) {
    const p = pts[k], q = pts[(k + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(px, py, pts) {
  let inside = false;
  for (let k = 0, j = pts.length - 1; k < pts.length; j = k++) {
    const a = pts[k], b = pts[j];
    if ((a.y > py) !== (b.y > py) && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Points of a run including its starting position. */
export const runPoints = (run) => [run.from, ...run.segs.map((s) => s.to)];

/**
 * For every run, the sign that turns a segment's right-hand normal (dy, -dx) into one that
 * points at air rather than into the part.
 *
 * Outer walls trace both the part's outside and the inside of holes. Air is outside a contour
 * but inside a hole, and a loop's interior is on its left when it runs counter-clockwise. So the
 * sign depends on both winding and whether the loop is a hole, which is decided by how many other
 * loops of the same layer and object contain it. Slicers usually print contours CCW and holes CW,
 * which makes this +1 everywhere, but not all of them do.
 *
 * Open runs (a wall split by a comment or an overhang change) can't be classified this way, so
 * they take the sign that points away from the object's center at their midpoint.
 *
 * @param {import('./parse.js').Run[]} runs
 * @param {Record<string, {x:number,y:number}>} centers
 * @returns {Int8Array}
 */
export function airSides(runs, centers) {
  const sides = new Int8Array(runs.length).fill(1);
  /** @type {Map<string, {idx:number, pts:any[], area:number}[]>} */
  const groups = new Map();
  runs.forEach((run, idx) => {
    const pts = runPoints(run);
    const a = pts[0], b = pts[pts.length - 1];
    const closed = pts.length > 3 && Math.hypot(a.x - b.x, a.y - b.y) < 1.0;
    if (closed) {
      const key = `${run.layer}|${run.obj}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ idx, pts, area: signedArea(pts) });
    } else {
      sides[idx] = openRunSide(pts, centers[run.obj] ?? centers[""] ?? { x: 0, y: 0 });
    }
  });
  for (const loops of groups.values()) {
    for (const L of loops) {
      const p = L.pts[0];
      let depth = 0;
      for (const M of loops) {
        if (M !== L && Math.abs(M.area) > Math.abs(L.area) && pointInPolygon(p.x, p.y, M.pts)) depth++;
      }
      const hole = depth % 2 === 1;
      const ccw = L.area > 0;
      // Right-hand normal points outside the loop when CCW. Air is outside unless it's a hole.
      sides[L.idx] = ccw !== hole ? 1 : -1;
    }
  }
  return sides;
}

function openRunSide(pts, c) {
  const k = Math.max(1, Math.floor(pts.length / 2));
  const a = pts[k - 1], b = pts[k];
  const dx = b.x - a.x, dy = b.y - a.y;
  const mx = (a.x + b.x) / 2 - c.x, my = (a.y + b.y) / 2 - c.y;
  return dy * mx - dx * my >= 0 ? 1 : -1;
}
