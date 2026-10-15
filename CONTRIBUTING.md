# Contributing

Issues and pull requests are welcome, and reports from real prints are especially useful.
Please follow the [code of conduct](CODE_OF_CONDUCT.md).

## Reporting a problem with a file

Attach the sliced file if you can (`.gcode.3mf` or `.gcode`), along with:

- the slicer and its version
- the printer
- your pattern, saved with the ⤓ button next to "Pattern"
- what went wrong: the preview, the export, Bambu Studio rejecting the file, or the print itself

## Changing the code

1. `npm install`, then `npm test` and `npm run dev`.
2. Read [SPEC.md](SPEC.md) before touching `src/core/`. In short:
   - `src/core/` stays free of the DOM and three.js.
   - Lines outside a changed wall are copied verbatim.
   - A wall's last point (the seam) never moves.
   - Extrusion per mm is preserved.
   - Noise is seeded, so the same settings always give the same file.
3. Add a test in `test/` for any change to parsing, fuzzing or output. If a new slicer
   dialect needs a fixture, add a generator to `test/synth.js` that copies that slicer's
   real marker lines.
4. Keep pull requests focused. CI runs the tests and the build.
