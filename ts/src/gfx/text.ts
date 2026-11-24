/**
 * Text drawing with @napi-rs/canvas, positioned like Pillow's ImageDraw.text anchors.
 *
 * Pillow places text using FreeType's size metrics: ascender = ceil(hhea.ascender * size / upem),
 * descender = ceil(-hhea.descender * size / upem). Anchors: first letter l/m/r = left/middle/right
 * of the advance width; second letter a/m/s/d = ascender/middle/baseline/descender.
 */

import { readFileSync } from "node:fs";

import { GlobalFonts, createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

import type { Point, Raster, Rgb } from "./raster.js";

export type HAnchor = "l" | "m" | "r";
export type VAnchor = "a" | "m" | "s" | "d";
export type Anchor = `${HAnchor}${VAnchor}`;

export interface Font {
  readonly family: string;
  readonly size: number;
  /** Pixels from the baseline up to the ascender line. */
  readonly ascent: number;
  /** Pixels from the baseline down to the descender line. */
  readonly descent: number;
}

interface FaceMetrics {
  readonly unitsPerEm: number;
  readonly ascender: number;
  readonly descender: number;
}

const ARIAL_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const HELVETICA = "/System/Library/Fonts/Helvetica.ttc";

/** Read unitsPerEm and hhea ascender/descender from a .ttf (or the first face of a .ttc). */
export function readFaceMetrics(file: Uint8Array): FaceMetrics | null {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  try {
    let offset = 0;
    if (buf.toString("latin1", 0, 4) === "ttcf") offset = buf.readUInt32BE(12);
    const numTables = buf.readUInt16BE(offset + 4);
    let head = -1;
    let hhea = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = offset + 12 + i * 16;
      const tag = buf.toString("latin1", rec, rec + 4);
      if (tag === "head") head = buf.readUInt32BE(rec + 8);
      if (tag === "hhea") hhea = buf.readUInt32BE(rec + 8);
    }
    if (head < 0 || hhea < 0) return null;
    return {
      unitsPerEm: buf.readUInt16BE(head + 18),
      ascender: buf.readInt16BE(hhea + 4),
      descender: buf.readInt16BE(hhea + 6),
    };
  } catch {
    return null;
  }
}

interface LoadedFace {
  readonly family: string;
  readonly metrics: FaceMetrics | null;
}

let loaded: LoadedFace | null = null;

/** Register Arial Bold (falling back to Helvetica, then the default sans-serif) once. */
function face(): LoadedFace {
  if (loaded !== null) return loaded;
  const faces: readonly (readonly [path: string, family: string])[] = [
    [ARIAL_BOLD, "LaneArialBold"],
    [HELVETICA, "LaneHelvetica"],
  ];
  for (const [path, family] of faces) {
    try {
      const bytes = readFileSync(path);
      if (GlobalFonts.registerFromPath(path, family) !== null) {
        loaded = { family, metrics: readFaceMetrics(bytes) };
        return loaded;
      }
    } catch {
      // font not installed here: try the next one
    }
  }
  loaded = { family: "sans-serif", metrics: null };
  return loaded;
}

const fontCache = new Map<number, Font>();

/** The game font at `size` pixels (Python: game_screen.font(size)). */
export function font(size: number): Font {
  const cached = fontCache.get(size);
  if (cached !== undefined) return cached;
  const f = face();
  let ascent: number;
  let descent: number;
  if (f.metrics !== null) {
    ascent = Math.ceil((f.metrics.ascender * size) / f.metrics.unitsPerEm);
    descent = Math.ceil((-f.metrics.descender * size) / f.metrics.unitsPerEm);
  } else {
    const m = measureContext(`${size}px ${f.family}`).measureText("Hg");
    ascent = Math.ceil(m.fontBoundingBoxAscent);
    descent = Math.ceil(m.fontBoundingBoxDescent);
  }
  const result: Font = { family: f.family, size, ascent, descent };
  fontCache.set(size, result);
  return result;
}

let measureCtx: SKRSContext2D | null = null;

function measureContext(cssFont: string): SKRSContext2D {
  measureCtx ??= createCanvas(1, 1).getContext("2d");
  measureCtx.font = cssFont;
  return measureCtx;
}

function cssFont(f: Font): string {
  return `${f.size}px ${f.family}`;
}

/** Advance width in whole pixels (Pillow's getlength with hinted advances). */
export function textLength(text: string, f: Font): number {
  return Math.round(measureContext(cssFont(f)).measureText(text).width);
}

/** Draw `text` onto the raster, anchored like Pillow. */
export function drawText(raster: Raster, at: Point, text: string, f: Font, fill: Rgb, anchor: Anchor): void {
  if (text.length === 0) return;
  const width = textLength(text, f);
  const [x, y] = at;
  const h = anchor.charAt(0);
  const v = anchor.charAt(1);
  const left = h === "m" ? x - width / 2 : h === "r" ? x - width : x;
  const baseline =
    v === "a" ? y + f.ascent : v === "m" ? y + (f.ascent - f.descent) / 2 : v === "d" ? y - f.descent : y;
  // Render white-on-transparent into a scratch canvas big enough for the string, then blend the
  // coverage into the raster with the fill colour (Pillow pastes the fill through a text mask).
  const pad = Math.ceil(f.size / 2);
  const ox = Math.floor(left);
  const oy = Math.floor(baseline) - f.ascent - pad;
  const cw = width + 2 * pad;
  const ch = f.ascent + f.descent + 2 * pad;
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  ctx.font = cssFont(f);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(text, left - ox + pad, baseline - oy);
  const img = ctx.getImageData(0, 0, cw, ch).data;
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      const a = img[(py * cw + px) * 4 + 3] ?? 0;
      if (a > 0) raster.blend(ox - pad + px, oy + py, fill, a);
    }
  }
}
