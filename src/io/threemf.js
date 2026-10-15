// Bambu .gcode.3mf: a zip whose Metadata/plate_N.gcode is the print, checked by plate_N.gcode.md5.
// Everything else in the archive is copied through unchanged, in its original order.

import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import SparkMD5 from "spark-md5";

const PLATE = /^Metadata\/plate_(\d+)\.gcode$/;

/**
 * @typedef {object} Archive
 * @property {Record<string, Uint8Array>} files   in original entry order
 * @property {number[]} plates                     plate numbers that carry G-code
 */

/** @param {Uint8Array} bytes @returns {Archive} */
export function readArchive(bytes) {
  const files = unzipSync(bytes);
  const plates = Object.keys(files)
    .map((k) => k.match(PLATE))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  return { files, plates };
}

export const plateGcode = (archive, plate) => strFromU8(archive.files[`Metadata/plate_${plate}.gcode`]);

/** @param {Uint8Array} bytes */
export const md5Hex = (bytes) => SparkMD5.ArrayBuffer.hash(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

/**
 * Checks the stored checksum against the plate's G-code, so a mismatch in format (case,
 * trailing newline) is caught on load rather than by the printer.
 * @returns {{stored: string|null, computed: string, ok: boolean}}
 */
export function checkMd5(archive, plate) {
  const g = archive.files[`Metadata/plate_${plate}.gcode`];
  const m = archive.files[`Metadata/plate_${plate}.gcode.md5`];
  const computed = md5Hex(g);
  const stored = m ? strFromU8(m).trim() : null;
  return { stored, computed, ok: stored == null || stored.toLowerCase() === computed };
}

/**
 * @param {Archive} archive
 * @param {number} plate
 * @param {string} gcode
 * @returns {Uint8Array}
 */
export function writeArchive(archive, plate, gcode) {
  const key = `Metadata/plate_${plate}.gcode`;
  const g = strToU8(gcode);
  /** @type {Record<string, Uint8Array | [Uint8Array, {level: number}]>} */
  const out = {};
  for (const [name, data] of Object.entries(archive.files)) {
    if (name === key) out[name] = g;
    else if (name === `${key}.md5`) {
      // Match the stored file's case; Bambu Studio writes uppercase hex.
      const old = strFromU8(data);
      const sum = md5Hex(g);
      out[name] = strToU8(old.trim() === old.trim().toLowerCase() ? sum : sum.toUpperCase());
    }
    // PNGs are already compressed; deflating them again only costs time.
    else out[name] = name.endsWith(".png") ? [data, { level: 0 }] : data;
  }
  return zipSync(out, { level: 6 });
}
