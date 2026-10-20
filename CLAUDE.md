# FuzzySpiral

Patterned fuzzy skin as a G-code post-processor, in the browser. Load a sliced Bambu
`.gcode.3mf` or a plain `.gcode`, stack pattern layers (spiral, stripes, bands, checker,
layer range, height gradient), and the outer-wall moves get slicer-style fuzzy skin only
where the pattern says. Export back to `.gcode.3mf` (Bambu X1/P1/A1) or `.gcode`.

Vite + vanilla ES modules, JSDoc typedefs, no TypeScript. Deps: `three`, `fflate`, `spark-md5`.

**[SPEC.md](SPEC.md)** has the dialect markers, the E-handling rules, known gaps and notes for
the next session. Read it before changing `core/`.

## Hard rules

1. **`src/core/` is pure.** No DOM, no three.js, no workers. It runs under vitest in Node.
   `src/io/` may use fflate/spark-md5 but nothing browser-only.
2. **Lines outside a changed run are copied verbatim.** The parser indexes the original text
   rather than rewriting it, so an empty mask gives byte-identical output. A test enforces
   this; don't add any "normalise while we're here" pass.
3. **A run's last point never moves.** It is the seam, and the next move starts from it.
4. **Extrusion per mm is preserved, not total E.** Fuzz lengthens the path; each new segment
   gets the original segment's E/mm times its own length. Absolute-E files get a `G92 E` after
   each changed run so later lines still line up.
5. **Noise is seeded and consumed the same way whatever the mask.** Editing the pattern must not
   reshuffle the jitter, and exporting twice must give the same bytes.

## Layout

- `src/core/parse.js`: finds outer-wall runs, tracks modes, object labels, layers
- `src/core/geometry.js`: arcs, winding, hole detection (which side is air)
- `src/core/patterns.js`: mask layers, blend stack, presets
- `src/core/fuzz.js`: the fuzz itself
- `src/core/emit.js`: rebuilds the G-code text
- `src/io/threemf.js`: unzip, md5 check, repack
- `src/worker.js`: holds the parsed file; preview and export run here
- `src/view/`: three.js preview (lines, plus `beads.js` for the instanced solid view), the sidebar,
  and `fuzzSwatch.js` (close-up beside the fuzz sliders); `src/main.js` is wiring only

## Running and verifying

```bash
npm run dev            # http://localhost:5274
npm test               # vitest, core + 3mf round trip
npm run build          # static site; CI deploys main to GitHub Pages
node test/make-fixtures.js   # synthetic Bambu .gcode.3mf and Prusa .gcode into fixtures/
```
