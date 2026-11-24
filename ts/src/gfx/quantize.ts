/**
 * Median-cut colour reduction without dithering (what Pillow's `Image.quantize(colors=32,
 * dither=NONE)` does for RGB images). sharp's own palette option rounds the colour limit up to a
 * power-of-two bit depth (32 becomes 256), so frames are reduced here first; sharp then writes
 * the already-small palette exactly.
 */

import type { Rgb } from "./raster.js";

interface ColourCount {
  readonly rgb: Rgb;
  readonly key: number;
  readonly count: number;
}

type Channel = 0 | 1 | 2;
const CHANNELS: readonly Channel[] = [0, 1, 2];

function widestChannel(box: readonly ColourCount[]): readonly [Channel, number] {
  let best: Channel = 0;
  let bestRange = -1;
  for (const ch of CHANNELS) {
    let lo = 255;
    let hi = 0;
    for (const c of box) {
      lo = Math.min(lo, c.rgb[ch]);
      hi = Math.max(hi, c.rgb[ch]);
    }
    if (hi - lo > bestRange) {
      best = ch;
      bestRange = hi - lo;
    }
  }
  return [best, bestRange];
}

function mean(box: readonly ColourCount[]): Rgb {
  let n = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (const c of box) {
    n += c.count;
    r += c.rgb[0] * c.count;
    g += c.rgb[1] * c.count;
    b += c.rgb[2] * c.count;
  }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/** Split the box at the pixel-weighted median of its widest channel. */
function split(box: readonly ColourCount[], ch: Channel): readonly [ColourCount[], ColourCount[]] {
  const sorted = [...box].sort((a, b) => a.rgb[ch] - b.rgb[ch] || a.key - b.key);
  const total = sorted.reduce((s, c) => s + c.count, 0);
  let acc = 0;
  let cut = 1;
  for (const [i, c] of sorted.entries()) {
    acc += c.count;
    if (acc * 2 >= total) {
      cut = i + 1;
      break;
    }
  }
  cut = Math.min(Math.max(cut, 1), sorted.length - 1);
  return [sorted.slice(0, cut), sorted.slice(cut)];
}

/** The palette (at most `colors` entries) for RGB pixel data. */
export function medianCutPalette(data: Uint8Array, colors: number): Rgb[] {
  const counts = new Map<number, number>();
  for (let i = 0; i + 2 < data.length; i += 3) {
    const key = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const all: ColourCount[] = [...counts].map(([key, count]) => ({
    key,
    count,
    rgb: [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff],
  }));
  if (all.length <= colors) return all.map((c) => c.rgb);
  const boxes: ColourCount[][] = [all];
  while (boxes.length < colors) {
    // split the box with the widest channel range (ties: the one holding more pixels)
    let pick = -1;
    let pickRange = 0;
    let pickPixels = 0;
    let pickChannel: Channel = 0;
    for (const [i, box] of boxes.entries()) {
      if (box.length < 2) continue;
      const [ch, range] = widestChannel(box);
      const pixels = box.reduce((s, c) => s + c.count, 0);
      if (range > pickRange || (range === pickRange && pixels > pickPixels)) {
        pick = i;
        pickRange = range;
        pickPixels = pixels;
        pickChannel = ch;
      }
    }
    const box = boxes[pick];
    if (box === undefined) break;
    const [a, b] = split(box, pickChannel);
    boxes.splice(pick, 1, a, b);
  }
  return boxes.map(mean);
}

/** Map every pixel to its nearest palette colour (no dithering). Returns new RGB data. */
export function quantizeRgb(data: Uint8Array, colors: number): Uint8Array {
  const palette = medianCutPalette(data, colors);
  const nearest = new Map<number, Rgb>();
  const out = new Uint8Array(data.length);
  for (let i = 0; i + 2 < data.length; i += 3) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    let best = nearest.get(key);
    if (best === undefined) {
      let bestDist = Number.POSITIVE_INFINITY;
      for (const p of palette) {
        const dist = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2;
        if (dist < bestDist) {
          bestDist = dist;
          best = p;
        }
      }
      best ??= [r, g, b];
      nearest.set(key, best);
    }
    out[i] = best[0];
    out[i + 1] = best[1];
    out[i + 2] = best[2];
  }
  return out;
}
