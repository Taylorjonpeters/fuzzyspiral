# FuzzySpiral spec

## 1. What it is

A post-processor for sliced G-code. It never re-slices. It finds outer-wall extrusion, then
moves points sideways (slicer-style fuzzy skin) scaled by a 0..1 mask that comes from a stack
of parametric pattern layers. Everything else in the file passes through untouched.

The other route, generating fuzzy-skin modifier volumes in a project 3MF for the slicer to
handle natively, was deliberately left for later. It keeps the file editable in Bambu Studio,
but the slicer splits wall regions coarsely, so sharp spirals and stripes come out blurred.

## 2. Inputs

| Slicer | Outer wall | Layer change | Object labels |
|---|---|---|---|
| Bambu Studio | `; FEATURE: Outer wall` | `; CHANGE_LAYER` | `; start printing object, unique label id: N` / `M624`–`M625` |
| OrcaSlicer | `; FEATURE: Outer wall` or `;TYPE:Outer wall` | `;LAYER_CHANGE` | `EXCLUDE_OBJECT_START NAME=` or `M486` |
| PrusaSlicer | `;TYPE:External perimeter` | `;LAYER_CHANGE` | `M486 S<n>` |
| Cura | `;TYPE:WALL-OUTER` | `;LAYER:<n>` | `;MESH:<name>` |

A layer is counted once per run of back-to-back layer markers, so a slicer that writes two
markers doesn't double the count. Layers are 1-based to match Bambu Studio's slider.

A **run** is a maximal stretch of consecutive outer-wall extrusion moves (`G1`/`G2`/`G3` with
positive E and XY motion). Feed-only `G1 F…` lines inside a wall stay in the run. Any comment,
wipe section (`; WIPE_START`…`; WIPE_END`), retraction, travel or mode change ends it. Runs
under `G91` relative XY are never created.

`.gcode.3mf`: a zip holding `Metadata/plate_N.gcode` plus `plate_N.gcode.md5`. Bambu Studio
writes the md5 as uppercase hex. On load the stored md5 is checked, and a mismatch shows a
warning. On export the md5 is rewritten in the stored file's case, every other entry is kept
byte-identical and in its original order, and PNGs are stored uncompressed.

## 3. Fuzz

- The spacing is `max(pointDist, 1/maxPtsPerMm)`, with each step jittered ×0.75–1.25. The first
  sample starts at a random distance, as PrusaSlicer's does.
- Offset = `thickness × mask × r` along the air-side normal. `r` is in [-1, 1] (or [0, 1] for
  outward-only), drawn from classic per-run seeded random or from 3D Perlin noise at
  `noiseScale` mm.
- **Air side.** Closed loops in the same layer and object are nested by containment. Odd depth
  means a hole. Air is outside a contour and inside a hole. Open runs use the side facing away
  from the object's center.
- Corners are offset along the average of the two edge normals.
- Unmoved interior samples are dropped as collinear. A segment whose start, end and samples all
  have mask 0 is copied as-is. A run with no moved point is emitted as its original lines.
- `skipFirstLayer` (default on) leaves layer 1 smooth for bed adhesion.
- `walls: 'contour'` leaves the outer walls of holes smooth, like Bambu's "Contour" fuzzy skin
  option. It uses the same hole test as the air side, so open runs always count as outside.

## 4. Patterns

Each layer gives 0..1. It can be inverted, is scaled by `strength`, and blends into the running
value (union = max, intersect = multiply, subtract, add, min). The first enabled layer replaces
the value rather than blending. Periodic patterns are a phase `u` in [0, 1) with a duty cycle,
and `feather` is in fractions of a period, so edge softness behaves the same for every pattern.

`θ` is measured around the pattern center: each object's XY bounding-box center, or one custom
point picked on the bed. `t` is height as a fraction of the object's outer-wall Z range.

- spiral: `u = frac(starts · (±θ/2π − z/pitch) + phase)`
- stripes: `u = frac(count · θ/2π + phase)`
- bands: `u = frac(z/period + phase)`
- checker: XOR of a stripe band and a Z band
- zrange: inclusive range of layers, or millimetres with a soft edge
- gradient: lerp from `startAmp` to `endAmp` between two `t` percentages

## 5. Known gaps

- Not yet checked against a real Bambu Studio export or a real print. The tests use synthetic
  files that copy Bambu's marker format. Bambu Studio's CLI segfaulted or refused its own system
  profiles here (2.05.00.66), so the fixtures could not be sliced automatically.
- The print-time and filament estimates in `slice_info.config` and the G-code header still
  describe the original.
- Arc fitting: once a run is changed, its arcs become line segments. Unchanged runs keep their
  arcs.
- Multi-object plates with no object labels share one center, the plate's outer-wall bbox.
- Spiral vase mode should work, since Z is interpolated along the run and written when it
  changes, but it hasn't been tested.

## 6. Notes for the next session

- First priority: load a real Bambu `.gcode.3mf` (X1 and A1). Check that the md5 matches on
  load, the runs look right, and Bambu Studio previews the export. Then do a test print.
- Ideas not yet built: per-object pattern overrides, a painted mask, a noise-based mask layer,
  and the modifier-volume 3MF route described in §1.
