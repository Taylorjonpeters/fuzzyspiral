// Solid view: each toolpath segment drawn as an extruded bead, like a slicer's preview.
//
// One small tube (an elliptical cross-section swept along +X) is instanced once per segment;
// the vertex shader stretches it from the segment's start to its end and sizes it to the bead's
// width and height. Instancing keeps memory to a few floats per segment, which matters on prints
// with hundreds of thousands of outer-wall moves.

import * as THREE from "three";

const SIDES = 10;

/** Unit tube: x is 0 at the start ring and 1 at the end ring; y, z trace a unit circle. */
function unitTube() {
  const pos = [], nrm = [], idx = [];
  for (let end = 0; end < 2; end++) {
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      pos.push(end, Math.cos(a), Math.sin(a));
      nrm.push(0, Math.cos(a), Math.sin(a));
    }
  }
  for (let k = 0; k < SIDES; k++) {
    const k2 = (k + 1) % SIDES;
    idx.push(k, k2, SIDES + k, k2, SIDES + k2, SIDES + k);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

const vertexShader = /* glsl */ `
  attribute vec3 iStart;
  attribute vec3 iEnd;
  attribute float iAmp0;
  attribute float iAmp1;
  attribute vec3 iBead;   // layer, width, height
  uniform vec2 uLayers;
  varying vec3 vNormal;
  varying float vAmp;

  void main() {
    if (iBead.x < uLayers.x || iBead.x > uLayers.y) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // outside the clip volume: culled
      return;
    }
    vec3 d = iEnd - iStart;
    float len = length(d);
    vec3 t = len > 1e-6 ? d / len : vec3(1.0, 0.0, 0.0);
    vec3 up = vec3(0.0, 0.0, 1.0);
    vec3 side = normalize(cross(up, t) + vec3(1e-6, 0.0, 0.0));
    float w = iBead.y * 0.5, h = iBead.z * 0.5;
    // Overlap neighbours by half a bead so corners between short fuzz segments stay closed.
    float along = position.x * len + (position.x * 2.0 - 1.0) * w * 0.5;
    // The nozzle path is the top of the bead, so the bead's center sits half a layer lower.
    vec3 p = iStart + t * along + side * position.y * w + up * (position.z * h - h);
    vNormal = normalize(normalMatrix * normalize(side * normal.y * h + up * normal.z * w));
    vAmp = mix(iAmp0, iAmp1, position.x);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uOff;
  uniform vec3 uOn;
  uniform vec3 uPlain;
  uniform float uPattern;  // 1 tints by fuzz amount, 0 draws plain filament
  varying vec3 vNormal;
  varying float vAmp;

  void main() {
    vec3 n = normalize(vNormal);
    vec3 base = mix(uPlain, mix(uOff, uOn, clamp(vAmp, 0.0, 1.0)), uPattern);
    float key = max(dot(n, normalize(vec3(0.35, 0.55, 0.75))), 0.0);
    float fill = max(dot(n, normalize(vec3(-0.6, -0.2, 0.4))), 0.0);
    float spec = pow(max(dot(n, normalize(vec3(0.2, 0.35, 1.0))), 0.0), 24.0);
    vec3 c = base * (0.16 + 0.74 * key + 0.16 * fill) + vec3(0.2) * spec;
    gl_FragColor = vec4(c, 1.0);
    // Uniform colors are linear; convert to the renderer's output (sRGB) like built-in materials do.
    #include <colorspace_fragment>
  }
`;

export function createBeads(offColor, onColor) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uLayers: { value: new THREE.Vector2(0, 1e9) },
      uOff: { value: new THREE.Color(offColor) },
      uOn: { value: new THREE.Color(onColor) },
      // Off-white, like natural PLA, so only the surface texture is on show.
      uPlain: { value: new THREE.Color("#d8d4cc") },
      uPattern: { value: 0 },
    },
  });
  let geometry = unitTube();
  const mesh = new THREE.Mesh(geometry, material);
  // The base tube's bounds say nothing about where instances end up.
  mesh.frustumCulled = false;

  return {
    mesh,
    /** Same buffers the line view uses: pos is segment pairs, amp per end, bead per segment. */
    setData(pos, amp, bead) {
      geometry.dispose();
      geometry = unitTube();
      const p = new THREE.InstancedInterleavedBuffer(pos, 6);
      const a = new THREE.InstancedInterleavedBuffer(amp, 2);
      geometry.setAttribute("iStart", new THREE.InterleavedBufferAttribute(p, 3, 0));
      geometry.setAttribute("iEnd", new THREE.InterleavedBufferAttribute(p, 3, 3));
      geometry.setAttribute("iAmp0", new THREE.InterleavedBufferAttribute(a, 1, 0));
      geometry.setAttribute("iAmp1", new THREE.InterleavedBufferAttribute(a, 1, 1));
      geometry.setAttribute("iBead", new THREE.InstancedBufferAttribute(bead, 3));
      geometry.instanceCount = bead.length / 3;
      mesh.geometry = geometry;
    },
    /** true colors beads by fuzz amount like the line view; false shows plain filament. */
    setShowPattern(on) {
      material.uniforms.uPattern.value = on ? 1 : 0;
    },
    setLayerRange(lo, hi) {
      material.uniforms.uLayers.value.set(lo - 0.5, hi + 0.5);
    },
  };
}
