import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { zipSync, strToU8, strFromU8, unzipSync } from "fflate";
import { parseGcode } from "../src/core/parse.js";
import { applyFuzz } from "../src/core/fuzz.js";
import { emitGcode } from "../src/core/emit.js";
import { evalMask, makeLayer, band, spiralFromStroke, gradientFromStroke, tightenGradient } from "../src/core/patterns.js";
import { readArchive, plateGcode, checkMd5, writeArchive } from "../src/io/threemf.js";
import { bambuGcode, prusaGcode, lampGcode, slottedBaseGcode } from "./synth.js";

const everywhere = { fuzz: { seed: 7 }, center: { mode: "auto" }, stack: [makeLayer("constant")] };
const nowhere = { fuzz: { seed: 7 }, center: { mode: "auto" }, stack: [] };

const md5 = (s) => createHash("md5").update(s).digest("hex");

describe("parse", () => {
  it("finds one outer-wall run per loop and ignores inner walls and wipes", () => {
    const p = parseGcode(bambuGcode({ layers: 3 }));
    // cylinder + square + hole per layer
    expect(p.runs.length).toBe(9);
    expect(p.dialect).toBe("bambu");
    expect(p.layerCount).toBe(3);
    expect(new Set(p.runs.map((r) => r.obj))).toEqual(new Set(["15", "22"]));
  });

  it("keeps a mid-wall feed line inside the run instead of splitting it", () => {
    const p = parseGcode(bambuGcode({ layers: 1 }));
    const run = p.runs[0];
    expect(p.lines.slice(run.start, run.end + 1)).toContain("G1 F2400");
    expect(run.segs.at(-1).f).toBe(2400);
  });

  it("linearizes arcs and keeps their total extrusion", () => {
    const p = parseGcode(prusaGcode({ layers: 1 }));
    expect(p.dialect).toBe("prusa");
    expect(p.eol).toBe("\r\n");
    const e = p.runs[0].segs.reduce((a, s) => a + s.e, 0);
    expect(e).toBeCloseTo(2 * Math.PI * 20 * 0.03, 4);
    expect(p.runs[0].segs.length).toBeGreaterThan(100);
  });
});

describe("emit", () => {
  it("is byte-identical when the mask is empty", () => {
    const src = bambuGcode();
    const p = parseGcode(src);
    expect(emitGcode(p, applyFuzz(p, nowhere).out)).toBe(src);
  });

  it("is byte-identical for CRLF absolute-E files when the mask is empty", () => {
    const src = prusaGcode();
    const p = parseGcode(src);
    expect(emitGcode(p, applyFuzz(p, nowhere).out)).toBe(src);
  });

  it("leaves every non-outer-wall line in place when fuzzing everywhere", () => {
    const src = bambuGcode({ layers: 4 });
    const p = parseGcode(src);
    const out = emitGcode(p, applyFuzz(p, everywhere).out);
    const nonMoves = (t) => t.split("\n").filter((l) => !/^G1 X/.test(l) && !/^G1 F(3000|2400)$/.test(l));
    expect(nonMoves(out)).toEqual(nonMoves(src));
  });

  it("does not fuzz the first layer by default", () => {
    const src = bambuGcode({ layers: 2 });
    const p = parseGcode(src);
    const out = applyFuzz(p, everywhere).out;
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).not.toBeNull();
  });

  it("resyncs absolute E with G92 after a fuzzed run", () => {
    const p = parseGcode(prusaGcode({ layers: 3 }));
    const res = applyFuzz(p, everywhere);
    const out = emitGcode(p, res.out).split("\r\n");
    const run = p.runs[1];
    const eAfter = run.eIn + run.segs.reduce((a, s) => a + s.e, 0);
    expect(out).toContain(`G92 E${Number(eAfter.toFixed(5))}`);
  });

  it("is deterministic for a given seed", () => {
    const p = parseGcode(bambuGcode({ layers: 4 }));
    expect(emitGcode(p, applyFuzz(p, everywhere).out)).toBe(emitGcode(p, applyFuzz(p, everywhere).out));
  });
});

describe("fuzz", () => {
  const p = parseGcode(bambuGcode({ layers: 5 }));
  const res = applyFuzz(p, everywhere);

  it("keeps extrusion per millimetre equal to the original wall's", () => {
    const k = 3; // cylinder, layer 2
    const segs = res.out[k];
    const len = segs.reduce((a, s, i) => {
      const prev = i ? segs[i - 1].to : p.runs[k].from;
      return a + Math.hypot(s.to.x - prev.x, s.to.y - prev.y);
    }, 0);
    const e = segs.reduce((a, s) => a + s.e, 0);
    expect(e / len).toBeCloseTo(0.031, 5);
  });

  it("ends every fuzzed loop exactly on its seam", () => {
    for (const [k, segs] of res.out.entries()) {
      if (!segs) continue;
      expect(segs.at(-1).to).toEqual(p.runs[k].segs.at(-1).to);
    }
  });

  it("never offsets a point further than the thickness", () => {
    const segs = res.out[3];
    for (const s of segs) {
      const r = Math.hypot(s.to.x - 100, s.to.y - 100);
      expect(Math.abs(r - 15)).toBeLessThanOrEqual(0.3 + 1e-3);
    }
  });

  it("pushes outward-only fuzz away from the part on contours and into holes", () => {
    const out = applyFuzz(p, { ...everywhere, fuzz: { seed: 7, mode: "outward" } }).out;
    const cyl = out[3], hole = out[5];
    const radial = (segs, cx, cy) => segs.map((s) => Math.hypot(s.to.x - cx, s.to.y - cy));
    expect(Math.min(...radial(cyl, 100, 100))).toBeGreaterThan(15 - 0.02);
    expect(Math.max(...radial(hole, 160, 100))).toBeLessThan(4 + 0.02);
  });

  it("leaves hole walls smooth when set to outside only", () => {
    const out = applyFuzz(p, { ...everywhere, fuzz: { seed: 7, walls: "contour" } }).out;
    // Layer 2: cylinder, square, hole
    expect(out[3]).not.toBeNull();
    expect(out[4]).not.toBeNull();
    expect(out[5]).toBeNull();
  });

  it("changes only the layers inside a layer range", () => {
    const stack = [makeLayer("zrange", { params: { unit: "layer", from: 3, to: 4 } })];
    const out = applyFuzz(p, { fuzz: { seed: 1 }, center: { mode: "auto" }, stack }).out;
    const changedLayers = [...new Set(p.runs.filter((_, k) => out[k]).map((r) => r.layer))];
    expect(changedLayers).toEqual([3, 4]);
  });
});

describe("lamp walls", () => {
  const lamp = parseGcode(lampGcode());
  // Layer 2 holds runs 4..7: shell outside, shell inside, tube outside, tube bore.
  const changed = (settings) => applyFuzz(lamp, settings).out.slice(4, 8).map((o) => o !== null);

  it("fuzzes only the shell's outside when set to outermost skin", () => {
    expect(changed({ ...everywhere, fuzz: { seed: 1, walls: "outermost" } })).toEqual([true, false, false, false]);
  });

  it("still fuzzes the socket tube's outside when only holes are skipped", () => {
    expect(changed({ ...everywhere, fuzz: { seed: 1, walls: "contour" } })).toEqual([true, false, true, false]);
  });

  it("keeps walls inside the distance-from-center radius smooth", () => {
    const stack = [makeLayer("radius", { feather: 0, params: { min: 20, max: 0 } })];
    expect(changed({ fuzz: { seed: 1 }, center: { mode: "auto" }, stack })).toEqual([true, true, false, false]);
  });
});

describe("outermost skin on a slotted lamp base", () => {
  const base = parseGcode(slottedBaseGcode());
  const res = applyFuzz(base, { ...everywhere, fuzz: { seed: 1, walls: "outermost" } });
  const moved = res.out.flatMap((o) => o ?? []).filter((s) => s.amp > 0);
  const radius = (s) => Math.hypot(s.to.x - 128, s.to.y - 128);

  it("fuzzes the rim", () => {
    expect(moved.length).toBeGreaterThan(100);
  });

  it("leaves the slot walls and the central tube smooth", () => {
    expect(Math.min(...moved.map(radius))).toBeGreaterThan(39);
  });
});

describe("walls split mid-loop", () => {
  // Layer 2's walls are the 5th–8th outer walls; the 6th is the shell's inside (r 38), a hole.
  const lines = lampGcode({ layers: 2 }).split("\n");
  const walls = lines.flatMap((l, i) => (l === "; FEATURE: Outer wall" ? [i] : []));
  lines.splice(walls[5] + 30, 0, "M73 P50 R10");
  const p = parseGcode(lines.join("\n"));

  it("arrives as two runs", () => {
    expect(p.runs.length).toBe(9);
  });

  it("still treats the split wall as a hole", () => {
    const out = applyFuzz(p, { ...everywhere, fuzz: { seed: 1, walls: "contour" } }).out;
    const fuzzedRadii = p.runs
      .map((r, i) => ({ r, o: out[i] }))
      .filter((x) => x.r.layer === 2 && x.o)
      .map((x) => Math.round(Math.hypot(x.r.segs[0].to.x - 128, x.r.segs[0].to.y - 128)));
    expect([...new Set(fuzzedRadii)].sort((a, b) => a - b)).toEqual([8, 40]);
  });
});

describe("gradient from a stroke", () => {
  const frame = { minZ: 0, maxZ: 50 };
  const params = { startAmp: 1, endAmp: 0 };

  it("turns the drag's heights into percent of the part's height", () => {
    const g = gradientFromStroke({ z: 10 }, { z: 40 }, frame, params);
    expect([g.from, g.to]).toEqual([20, 80]);
  });

  it("puts full fuzz at the bottom when dragging up", () => {
    const g = gradientFromStroke({ z: 10 }, { z: 40 }, frame, params);
    expect([g.startAmp, g.endAmp]).toEqual([1, 0]);
  });

  it("puts full fuzz at the top when dragging down", () => {
    const g = gradientFromStroke({ z: 40 }, { z: 10 }, frame, params);
    expect([g.from, g.to, g.startAmp, g.endAmp]).toEqual([20, 80, 0, 1]);
  });

  it("keeps a gentler gradient's amounts", () => {
    const g = gradientFromStroke({ z: 10 }, { z: 40 }, frame, { startAmp: 0.2, endAmp: 0.7 });
    expect([g.startAmp, g.endAmp]).toEqual([0.7, 0.2]);
  });

  it("ignores a click without a drag", () => {
    expect(gradientFromStroke({ z: 10 }, { z: 10.2 }, frame, params)).toBeNull();
  });
});

describe("tightening a gradient", () => {
  it("shrinks the ramp about its middle", () => {
    expect(tightenGradient({ from: 20, to: 80 }, 1)).toEqual({ from: 24.5, to: 75.5 });
  });

  it("widens it when scrolled the other way", () => {
    expect(tightenGradient({ from: 40, to: 60 }, -1)).toEqual({ from: 38.2, to: 61.8 });
  });

  it("never squeezes the ramp to nothing", () => {
    expect(tightenGradient({ from: 49, to: 51 }, 40)).toEqual({ from: 49.5, to: 50.5 });
  });

  it("keeps a widened ramp on the part", () => {
    expect(tightenGradient({ from: 80, to: 100 }, -6)).toEqual({ from: 47, to: 100 });
  });
});

describe("spiral from a stroke", () => {
  const center = { x: 0, y: 0 };
  const params = { starts: 3, duty: 0.4 };
  const onCyl = (turn, z) => ({ x: 20 * Math.cos(turn * 2 * Math.PI), y: 20 * Math.sin(turn * 2 * Math.PI), z });

  it("reads pitch as height climbed per full turn", () => {
    expect(spiralFromStroke(onCyl(0, 0), onCyl(0.25, 10), center, params).pitch).toBe(40);
  });

  it("is right-handed when the stroke rises counter-clockwise", () => {
    expect(spiralFromStroke(onCyl(0, 0), onCyl(0.25, 10), center, params).hand).toBe("right");
  });

  it("is left-handed when the stroke rises clockwise", () => {
    expect(spiralFromStroke(onCyl(0, 0), onCyl(-0.25, 10), center, params).hand).toBe("left");
  });

  it("takes the short way across the seam at the -X side", () => {
    expect(spiralFromStroke(onCyl(0.45, 0), onCyl(0.55, 4), center, params).pitch).toBe(40);
  });

  it("puts a stripe through both ends of the stroke", () => {
    const a = onCyl(0.1, 3), b = onCyl(0.3, 11);
    const s = spiralFromStroke(a, b, center, params);
    const stack = [makeLayer("spiral", { feather: 0, params: { ...params, ...s } })];
    const sample = (p) => ({ ...p, layer: 10, t: 0.5, r: 20, theta: Math.atan2(p.y, p.x) });
    expect(evalMask(stack, sample(a))).toBe(1);
    expect(evalMask(stack, sample(b))).toBe(1);
  });

  it("ignores a click without a drag", () => {
    expect(spiralFromStroke(onCyl(0, 0), onCyl(0.001, 0.1), center, params)).toBeNull();
  });
});

describe("patterns", () => {
  const at = (theta, z, layer = 10) => ({ x: 0, y: 0, z, layer, theta, t: 0.5 });

  it("band is on inside its duty cycle and off outside", () => {
    expect(band(0.1, 0.5, 0)).toBe(1);
    expect(band(0.7, 0.5, 0)).toBe(0);
  });

  it("feathered band is half on at its edge", () => {
    expect(band(0.5, 0.5, 0.2)).toBeCloseTo(0.5, 5);
  });

  it("a one-start spiral moves a quarter turn per quarter pitch", () => {
    const s = [makeLayer("spiral", { feather: 0, params: { starts: 1, pitch: 40, duty: 0.25, phase: 0 } })];
    expect(evalMask(s, at(0.1, 0))).toBe(1);
    expect(evalMask(s, at(0.1, 20))).toBe(0);
    expect(evalMask(s, at(Math.PI / 2 + 0.1, 10))).toBe(1);
  });

  it("stripes repeat count times around", () => {
    const s = [makeLayer("stripes", { feather: 0, params: { count: 4, duty: 0.5, phase: 0 } })];
    expect(evalMask(s, at(0.1, 0))).toBe(1);
    expect(evalMask(s, at(Math.PI / 4 + 0.1, 0))).toBe(0);
    expect(evalMask(s, at(Math.PI / 2 + 0.1, 0))).toBe(1);
  });

  it("multiply blend intersects two layers", () => {
    const s = [
      makeLayer("bands", { feather: 0, params: { period: 10, duty: 0.5, phase: 0 } }),
      makeLayer("stripes", { blend: "multiply", feather: 0, params: { count: 2, duty: 0.5, phase: 0 } }),
    ];
    expect(evalMask(s, at(0.1, 1))).toBe(1);
    expect(evalMask(s, at(0.1, 6))).toBe(0);
    expect(evalMask(s, at(Math.PI / 2 + 0.1, 1))).toBe(0);
  });

  it("gradient ramps from start to end amplitude over height", () => {
    const s = [makeLayer("gradient", { params: { from: 0, to: 100, startAmp: 1, endAmp: 0, ease: false } })];
    expect(evalMask(s, { ...at(0, 0), t: 0.25 })).toBeCloseTo(0.75, 5);
  });

  it("invert flips a layer", () => {
    const s = [makeLayer("constant", { invert: true })];
    expect(evalMask(s, at(0, 0))).toBe(0);
  });
});

describe("3mf", () => {
  const gcode = bambuGcode({ layers: 3 });
  const md5Upper = md5(gcode).toUpperCase();
  const src = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "Metadata/plate_1.gcode": strToU8(gcode),
    "Metadata/plate_1.gcode.md5": strToU8(md5Upper),
    "Metadata/plate_1.png": new Uint8Array([137, 80, 78, 71]),
    "Metadata/slice_info.config": strToU8("<config/>"),
  });

  it("finds the plate and verifies its stored checksum", () => {
    const a = readArchive(src);
    expect(a.plates).toEqual([1]);
    expect(plateGcode(a, 1)).toBe(gcode);
    expect(checkMd5(a, 1).ok).toBe(true);
  });

  it("writes the new G-code with a matching uppercase checksum and keeps other entries", () => {
    const a = readArchive(src);
    const out = unzipSync(writeArchive(a, 1, "G28\n"));
    expect(Object.keys(out)).toEqual(Object.keys(a.files));
    expect(strFromU8(out["Metadata/plate_1.gcode.md5"])).toBe(md5("G28\n").toUpperCase());
    expect(out["Metadata/plate_1.png"]).toEqual(a.files["Metadata/plate_1.png"]);
  });
});
