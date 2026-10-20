// Writes synthetic sliced files to fixtures/ for trying the app without a slicer.
// Usage: node test/make-fixtures.js
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import { bambuGcode, prusaGcode, lampGcode } from "./synth.js";

mkdirSync("fixtures", { recursive: true });
const g = bambuGcode({ layers: 60 });
writeFileSync("fixtures/synthetic-bambu.gcode.3mf", zipSync({
  "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types/>'),
  "Metadata/plate_1.gcode": strToU8(g),
  "Metadata/plate_1.gcode.md5": strToU8(createHash("md5").update(g).digest("hex").toUpperCase()),
  "Metadata/slice_info.config": strToU8("<config/>"),
}));
writeFileSync("fixtures/synthetic-prusa.gcode", prusaGcode({ layers: 40 }));
writeFileSync("fixtures/synthetic-lamp.gcode", lampGcode({ layers: 80 }));
console.log("wrote fixtures/synthetic-bambu.gcode.3mf, synthetic-prusa.gcode, synthetic-lamp.gcode");
