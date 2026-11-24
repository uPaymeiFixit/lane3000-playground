/** Image encoding with sharp: palette PNG frames, baseline JPEGs, RGB preview PNGs. */

import sharp, { type Sharp } from "sharp";

import { quantizeRgb } from "./quantize.js";
import type { Raster } from "./raster.js";

export const SCREEN_W = 320;
export const SCREEN_H = 240;

function fromRaster(img: Raster): Sharp {
  return sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } });
}

/** 320x240 palette PNG without dithering: tiny for flat game graphics (Python: frame_png). */
export async function framePng(img: Raster, colors = 32): Promise<Uint8Array> {
  if (img.width !== SCREEN_W || img.height !== SCREEN_H) {
    throw new RangeError(`frames must be ${SCREEN_W}x${SCREEN_H}, got ${img.width}x${img.height}`);
  }
  // Reduce to `colors` here (sharp would round 32 up to 256); sharp then stores that palette as-is.
  const reduced = quantizeRgb(img.data, colors);
  const out = await sharp(reduced, { raw: { width: img.width, height: img.height, channels: 3 } })
    .png({ palette: true, colours: 256, dither: 0, compressionLevel: 9, effort: 10, adaptiveFiltering: false })
    .toBuffer();
  return new Uint8Array(out);
}

/** Plain RGB PNG of the raster (Python: img.save("preview.png")). */
export async function savePng(img: Raster, path: string): Promise<void> {
  await fromRaster(img).png({ compressionLevel: 9 }).toFile(path);
}

/** RGB PNG bytes of the raster (e.g. the 1x1 GAMEBTN.PNG). */
export async function rgbPng(img: Raster): Promise<Uint8Array> {
  return new Uint8Array(await fromRaster(img).png().toBuffer());
}

/**
 * Baseline (non-progressive) 320x240 RGB JPEG, which the terminal's decoder accepts. The input
 * is scaled and centre-cropped to fill the screen (Python: ImageOps.fit).
 */
export async function toJpeg(input: Raster | string, quality = 80): Promise<Uint8Array> {
  const pipeline = typeof input === "string" ? sharp(input).removeAlpha() : fromRaster(input);
  const out = await pipeline
    .resize(SCREEN_W, SCREEN_H, { fit: "cover", position: "centre" })
    .toColourspace("srgb")
    .jpeg({ quality, progressive: false, optimiseCoding: true, mozjpeg: false, chromaSubsampling: "4:2:0" })
    .toBuffer();
  return new Uint8Array(out);
}
