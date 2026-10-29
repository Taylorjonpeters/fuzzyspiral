// three.js toolpath preview. Z is up, units are mm, the bed sits at z = 0.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createBeads } from "./beads.js";
import { evalMask } from "../core/patterns.js";

const OFF = new THREE.Color("#5b7fb8");
const ON = new THREE.Color("#ff8a3d");

export function createPreview(host) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 5000);
  camera.up.set(0, 0, 1);
  camera.position.set(128, -120, 160);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(128, 128, 0);
  controls.enableDamping = true;

  const bed = new THREE.GridHelper(256, 26, 0x4a4a4a, 0x2e2e2e);
  bed.rotation.x = Math.PI / 2;
  bed.position.set(128, 128, 0);
  scene.add(bed);

  const geom = new THREE.BufferGeometry();
  const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true }));
  scene.add(lines);

  const beads = createBeads(OFF, ON);
  beads.mesh.visible = false;
  scene.add(beads.mesh);

  const markers = new THREE.Group();
  scene.add(markers);

  // Stroke guide for drawing a spiral onto the part: a line from the press point to the cursor.
  const strokeGeom = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
  const strokeMat = { color: 0xffffff, depthTest: false, transparent: true };
  const strokeLine = new THREE.Line(strokeGeom, new THREE.LineBasicMaterial(strokeMat));
  const strokeEnds = new THREE.Points(strokeGeom, new THREE.PointsMaterial({ ...strokeMat, size: 9, sizeAttenuation: false }));
  for (const o of [strokeLine, strokeEnds]) { o.visible = false; o.renderOrder = 10; o.frustumCulled = false; scene.add(o); }

  // Height rings for the gradient drag: orange where fuzz is strongest, blue where it fades out.
  // Thin tori rather than lines, since WebGL draws every line one pixel wide.
  const rings = [ON, OFF].map((c) => {
    const ring = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.9 }));
    ring.visible = false; ring.renderOrder = 11; ring.frustumCulled = false;
    scene.add(ring);
    return ring;
  });
  const placeRing = (ring, f, z) => {
    const r = f.r + 1.5;
    if (ring.userData.r !== r) {
      ring.geometry.dispose();
      ring.geometry = new THREE.TorusGeometry(r, Math.max(0.25, r * 0.006), 6, 128);
      ring.userData.r = r;
    }
    ring.position.set(f.x, f.y, z);
    ring.visible = true;
  };

  // Pattern sleeve: a see-through cylinder around each part, painted with one layer's mask straight
  // from its parameters. It is cheap enough to redraw on every slider tick, so it shows where the
  // pattern lands while the real fuzz waits for the slider to be let go.
  const sleeves = new THREE.Group();
  scene.add(sleeves);
  const SLEEVE_W = 256;
  // sRGB bytes, since the texture is tagged sRGB and the colors should match the toolpath's.
  const rgb = (c) => { const h = c.getHex(); return [h >> 16, (h >> 8) & 255, h & 255]; };
  const OFF_RGB = rgb(OFF), ON_RGB = rgb(ON);
  const sample = { x: 0, y: 0, z: 0, layer: 0, theta: 0, r: 0, t: 0 };

  /** Paint one frame's sleeve texture: smooth areas faint blue, fuzzed areas solid orange. */
  function paintSleeve(layer, f, H) {
    const data = new Uint8Array(SLEEVE_W * H * 4);
    const stack = [{ ...layer, enabled: true }];
    const h = f.maxZ - f.minZ;
    sample.r = f.r;
    for (let j = 0; j < H; j++) {
      sample.t = (j + 0.5) / H;
      sample.z = f.minZ + sample.t * h;
      for (let i = 0; i < SLEEVE_W; i++) {
        sample.theta = ((i + 0.5) / SLEEVE_W) * Math.PI * 2;
        sample.x = f.x + f.r * Math.cos(sample.theta);
        sample.y = f.y + f.r * Math.sin(sample.theta);
        const v = evalMask(stack, sample);
        const o = (j * SLEEVE_W + i) * 4;
        for (let c = 0; c < 3; c++) data[o + c] = OFF_RGB[c] + (ON_RGB[c] - OFF_RGB[c]) * v;
        data[o + 3] = 50 + 170 * v;
      }
    }
    return data;
  }

  /** An open cylinder in Z-up coordinates whose u runs counter-clockwise from +X, like `theta`. */
  function sleeveGeometry(f) {
    const R = f.r + 1.5, N = 128;
    const pos = [], uv = [], idx = [];
    for (let j = 0; j <= 1; j++) {
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        pos.push(f.x + R * Math.cos(a), f.y + R * Math.sin(a), j ? f.maxZ : f.minZ);
        uv.push(i / N, j);
      }
    }
    for (let i = 0; i < N; i++) idx.push(i, i + 1, N + 2 + i, i, N + 2 + i, N + 1 + i);
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  /** @type {Record<string, {x:number,y:number,r:number,minZ:number,maxZ:number}>} */
  let frames = {};
  let layerStart = new Int32Array(2);
  let framed = false;

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(host);
  resize();

  const loop = () => {
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  loop();

  const bedPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const ray = new THREE.Raycaster();

  const setRay = (clientX, clientY) => {
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
    return ray.ray;
  };

  /**
   * Where the ray meets an object's picking cylinder (its footprint radius around its pattern
   * center). Only angle and height matter to patterns, so a cylinder stands in for the real
   * surface and works for any part shape.
   */
  function hitCylinder(rr, f) {
    const o = rr.origin, d = rr.direction;
    const ox = o.x - f.x, oy = o.y - f.y;
    const A = d.x * d.x + d.y * d.y;
    if (A < 1e-9) return null;
    const B = 2 * (d.x * ox + d.y * oy), C = ox * ox + oy * oy - f.r * f.r;
    const disc = B * B - 4 * A * C;
    if (disc < 0) return null;
    // Only the near side: above or below the part, the far wall is not what the cursor is over,
    // and a drag should keep following the side facing the camera.
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    const z = o.z + t * d.z;
    return t > 0 && z >= f.minZ - 0.5 && z <= f.maxZ + 0.5 ? { t, p: rr.at(t, new THREE.Vector3()) } : null;
  }

  /**
   * Off the part, follow the cursor on the upright plane through the press point that faces the
   * camera. At that depth, up on screen is always up the part, even from a high viewing angle.
   */
  function hitPressPlane(rr, anchor) {
    const n = new THREE.Vector3(camera.position.x - anchor.x, camera.position.y - anchor.y, 0);
    if (n.lengthSq() < 1e-9) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), anchor);
    const p = rr.intersectPlane(plane, new THREE.Vector3());
    return p ? { t: 0, p } : null;
  }


  return {
    /**
     * @param {{pos: Float32Array, amp: Float32Array, bead: Float32Array, layerStart: Int32Array, frames: Record<string, any>}} data
     */
    setData(data) {
      const col = new Float32Array(data.amp.length * 3);
      const c = new THREE.Color();
      for (let i = 0; i < data.amp.length; i++) {
        c.copy(OFF).lerp(ON, data.amp[i]);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      geom.setAttribute("position", new THREE.BufferAttribute(data.pos, 3));
      geom.setAttribute("color", new THREE.BufferAttribute(col, 3));
      geom.computeBoundingSphere();
      beads.setData(data.pos, data.amp, data.bead);
      layerStart = data.layerStart;
      frames = data.frames;

      markers.clear();
      for (const f of Object.values(data.frames)) {
        const g = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(f.x, f.y, 0), new THREE.Vector3(f.x, f.y, f.maxZ + 4),
        ]);
        markers.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf0f0f0, transparent: true, opacity: 0.5 })));
      }

      if (!framed && geom.boundingSphere && data.pos.length) {
        const s = geom.boundingSphere;
        controls.target.copy(s.center);
        camera.position.copy(s.center).add(new THREE.Vector3(0, -2.2 * s.radius, 1.6 * s.radius));
        framed = true;
      }
    },

    /** Show layers lo..hi inclusive (1-based). */
    setLayerRange(lo, hi) {
      const a = layerStart[Math.max(0, lo)] ?? 0;
      const b = layerStart[Math.min(layerStart.length - 1, hi + 1)] ?? 0;
      geom.setDrawRange(a, Math.max(0, b - a));
      beads.setLayerRange(lo, hi);
    },

    /** 'lines' draws toolpath centerlines; 'solid' draws them as printed beads. */
    setDisplay(mode) {
      beads.mesh.visible = mode === "solid";
      lines.visible = mode !== "solid";
    },

    resetFraming() { framed = false; },

    /** Bed coordinates under a client-space pointer position, or null off the bed plane. */
    pickBed(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(bedPlane, hit) ? { x: hit.x, y: hit.y } : null;
    },

    /**
     * Let the user drag a stroke across a part, then fine-tune it with the scroll wheel.
     *
     * Phases: armed (waiting for a press on a part) → dragging → adjusting. Scrolling works while
     * dragging and after release; a click or Esc after release keeps the result, Esc while still
     * armed or dragging cancels it. Orbiting pauses until the tool ends.
     *
     * @param {{onMove: (a: THREE.Vector3, b: THREE.Vector3, frame: any) => void,
     *          onWheel?: (steps: number, a: THREE.Vector3, b: THREE.Vector3, frame: any) => void,
     *          onRelease?: () => void,
     *          onEnd: (a: THREE.Vector3 | null, b: THREE.Vector3 | null, frame: any) => void}} cb
     * @param {{rings?: (frame: any) => [number, number] | null}} [opts]
     *   rings: heights to mark around the part, strongest first; re-read after every change
     */
    startStroke(cb, opts = {}) {
      const el = renderer.domElement;
      controls.enabled = false;
      el.style.cursor = "crosshair";
      let key = null, a = null, b = null;
      let phase = "armed";
      let wheelAcc = 0;
      const pts = strokeGeom.attributes.position;
      const show = () => {
        pts.setXYZ(0, a.x, a.y, a.z); pts.setXYZ(1, b.x, b.y, b.z);
        pts.needsUpdate = true;
        strokeLine.visible = strokeEnds.visible = true;
        const zs = opts.rings?.(frames[key]);
        if (zs) { placeRing(rings[0], frames[key], zs[0]); placeRing(rings[1], frames[key], zs[1]); }
      };
      const down = (e) => {
        if (phase === "adjusting") { e.stopPropagation(); finish(true); return; }
        const rr = setRay(e.clientX, e.clientY);
        let best = null;
        for (const [k, f] of Object.entries(frames)) {
          const h = hitCylinder(rr, f);
          if (h && (!best || h.t < best.t)) best = { ...h, k };
        }
        if (!best) return;
        key = best.k; a = best.p; b = a.clone();
        phase = "dragging";
        // Keeps the drag tracking if the cursor leaves the canvas; not essential if refused.
        try { el.setPointerCapture(e.pointerId); } catch {}
        show();
      };
      const move = (e) => {
        if (phase !== "dragging") return;
        const rr = setRay(e.clientX, e.clientY);
        const f = frames[key];
        const h = hitCylinder(rr, f) ?? hitPressPlane(rr, a);
        if (!h) return;
        b = h.p;
        cb.onMove(a, b, frames[key]);
        show();
      };
      const up = () => {
        if (phase !== "dragging") return;
        if (!cb.onWheel) { finish(true); return; }
        phase = "adjusting";
        el.style.cursor = "ns-resize";
        cb.onRelease?.();
      };
      // One step per wheel notch; trackpads send many small deltas, so they're accumulated.
      const wheel = (e) => {
        if (phase === "armed" || !cb.onWheel) return;
        e.preventDefault();
        // A mouse notch is ~100px (or 3 lines in Firefox), so one notch is one step.
        wheelAcc += e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        const steps = Math.trunc(wheelAcc / 100);
        if (!steps) return;
        wheelAcc -= steps * 100;
        cb.onWheel(-steps, a, b, frames[key]); // scrolling up (negative delta) is +1
        show();
      };
      const key_ = (e) => {
        if (e.key === "Escape") finish(phase === "adjusting");
        else if (e.key === "Enter" && phase === "adjusting") finish(true);
      };
      const finish = (ok) => {
        el.removeEventListener("pointerdown", down, true);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("wheel", wheel);
        removeEventListener("keydown", key_);
        el.style.cursor = "";
        controls.enabled = true;
        strokeLine.visible = strokeEnds.visible = false;
        for (const ring of rings) ring.visible = false;
        cb.onEnd(ok ? a : null, ok ? b : null, ok && key != null ? frames[key] : null);
      };
      // Capture phase, so the click that ends adjusting never reaches the orbit controls.
      el.addEventListener("pointerdown", down, true);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("wheel", wheel, { passive: false });
      addEventListener("keydown", key_);
    },

    canvas: renderer.domElement,
  };
}
