// three.js toolpath preview. Z is up, units are mm, the bed sits at z = 0.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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

  const markers = new THREE.Group();
  scene.add(markers);

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

  return {
    /**
     * @param {{pos: Float32Array, amp: Float32Array, layerStart: Int32Array, frames: Record<string, any>}} data
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
      layerStart = data.layerStart;

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
    },

    resetFraming() { framed = false; },

    /** Bed coordinates under a client-space pointer position, or null off the bed plane. */
    pickBed(clientX, clientY) {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = new THREE.Vector3();
      return ray.ray.intersectPlane(bedPlane, hit) ? { x: hit.x, y: hit.y } : null;
    },

    canvas: renderer.domElement,
  };
}
