# FuzzySpiral

**Patterned fuzzy skin for 3D prints, in your browser.** Spirals, stripes, bands, checkers,
"fuzz only up to layer 40", fades. It uses the same wall jitter as your slicer's fuzzy skin,
applied only where you want it.

**[Open the app →](https://taylorjonpeters.github.io/fuzzyspiral/)**

Slicers can turn fuzzy skin on for a whole object or part. FuzzySpiral works on the sliced
G-code instead: it finds the outer-wall moves and fuzzes them through a mask you build from
stackable pattern layers. Everything else in the file is copied exactly. Files never leave
your computer, because everything runs in the page.

## Works with

| Printer / slicer | Load | Export |
|---|---|---|
| Bambu Lab X1, P1, A1, A1 mini (Bambu Studio) | `.gcode.3mf` from *Export plate sliced file* | `.gcode.3mf`, with the checksum regenerated |
| OrcaSlicer | `.gcode` or `.gcode.3mf` | same as input |
| PrusaSlicer, SuperSlicer | `.gcode` (turn off binary G-code) | `.gcode` |
| Cura | `.gcode` | `.gcode` |

## How to use it

1. Slice as usual with fuzzy skin **off**.
   - **Bambu Studio:** File › Export › *Export plate sliced file* (⌘G / Ctrl+G).
   - **Others:** export plain `.gcode`.
2. Open the file in FuzzySpiral, or drop it on the page.
3. Pick a preset or stack pattern layers. Orange in the preview is fuzzed, blue is smooth.
4. Export, and print the exported file. For Bambu, open it in Bambu Studio and choose
   *Print plate*, or copy it to the SD card.

## Patterns

| Layer | What it does |
|---|---|
| Everywhere | Plain fuzzy skin, like the slicer's |
| Layer range | Fuzz between two layers or heights |
| Spiral | Helical stripes. Set the starts, pitch, width and twist |
| Vertical stripes | Evenly spaced around the part |
| Horizontal bands | Rings at a fixed spacing |
| Checker | Alternating squares around and up the part |
| Height gradient | Fuzz that fades in or out with height |

Layers combine with union, intersect or subtract. For example, a spiral intersected with a
gradient gives a spiral that fades out toward the top. Patterns wrap around each object's
middle, or around a point you pick on the bed. Save and load patterns as JSON.

Fuzz settings match the slicer's: thickness, point distance, in-and-out or outward only, and
outside walls only (holes stay smooth). There is also Perlin noise, for a texture that lines
up from layer to layer.

## Good to know

- Only outer walls change. Inner walls, infill, supports, travels and retractions are copied
  byte for byte.
- Extrusion per millimetre is preserved, so the fuzzed wall gets the same flow as the original.
- The print-time estimate inside the file still describes the original print.
- Arc moves (`G2`/`G3`) in fuzzed walls become straight segments. Untouched walls keep their
  arcs.
- **Status:** early. The output has been tested against synthetic files that copy each
  slicer's format. Reports from real prints are very welcome, good or bad.

## Development

```bash
npm install
npm run dev     # http://localhost:5274
npm test        # vitest
npm run build   # static site in dist/
```

Vite with vanilla ES modules, plus three.js for the preview and fflate for 3MF. The G-code
core (`src/core/`) is pure JavaScript with no DOM, so it runs under the tests in Node.
[SPEC.md](SPEC.md) describes the model, the slicer markers, and the rules the code relies on.
[CONTRIBUTING.md](CONTRIBUTING.md) covers sending changes.

Every push to `main` is tested and deployed to GitHub Pages by
[`.github/workflows/pages.yml`](.github/workflows/pages.yml).

## License

[MIT](LICENSE)
