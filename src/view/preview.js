// three.js toolpath preview. Z is up, units are mm, the bed sits at z = 0.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { createBeads } from "./beads.js";

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
    for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) {
      const z = o.z + t * d.z;
      if (t > 0 && z >= f.minZ - 0.5 && z <= f.maxZ + 0.5) return { t, p: rr.at(t, new THREE.Vector3()) };
    }
    return null;
  }

  /** Off the part, follow the cursor on the vertical plane through the object's axis that faces the camera. */
  function hitAxisPlane(rr, f) {
    const n = new THREE.Vector3(camera.position.x - f.x, camera.position.y - f.y, 0);
    if (n.lengthSq() < 1e-9) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n.normalize(), new THREE.Vector3(f.x, f.y, 0));
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
     * Let the user drag a stroke across a part. Orbiting pauses until the stroke ends.
     * @param {{onMove: (a: THREE.Vector3, b: THREE.Vector3, frame: {x:number,y:number}) => void,
     *          onEnd: (a: THREE.Vector3 | null, b: THREE.Vector3 | null, frame: {x:number,y:number} | null) => void}} cb
     */
    startStroke(cb) {
      const el = renderer.domElement;
      controls.enabled = false;
      el.style.cursor = "crosshair";
      let key = null, a = null, b = null;
      const pts = strokeGeom.attributes.position;
      const show = () => {
        pts.setXYZ(0, a.x, a.y, a.z); pts.setXYZ(1, b.x, b.y, b.z);
        pts.needsUpdate = true;
        strokeLine.visible = strokeEnds.visible = true;
      };
      const down = (e) => {
        const rr = setRay(e.clientX, e.clientY);
        let best = null;
        for (const [k, f] of Object.entries(frames)) {
          const h = hitCylinder(rr, f);
          if (h && (!best || h.t < best.t)) best = { ...h, k };
        }
        if (!best) return;
        key = best.k; a = best.p; b = a.clone();
        el.setPointerCapture(e.pointerId);
        show();
      };
      const move = (e) => {
        if (!a) return;
        const rr = setRay(e.clientX, e.clientY);
        const f = frames[key];
        const h = hitCylinder(rr, f) ?? hitAxisPlane(rr, f);
        if (!h) return;
        b = h.p;
        show();
        cb.onMove(a, b, frames[key]);
      };
      const finish = (ok) => {
        el.removeEventListener("pointerdown", down);
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        removeEventListener("keydown", esc);
        el.style.cursor = "";
        controls.enabled = true;
        strokeLine.visible = strokeEnds.visible = false;
        cb.onEnd(ok ? a : null, ok ? b : null, ok && key != null ? frames[key] : null);
      };
      const up = () => { if (a) finish(true); };
      const esc = (e) => { if (e.key === "Escape") finish(false); };
      el.addEventListener("pointerdown", down);
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      addEventListener("keydown", esc);
    },

    canvas: renderer.domElement,
  };
}
