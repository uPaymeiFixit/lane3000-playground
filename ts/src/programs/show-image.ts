/**
 * Show a full-screen image on an Ingenico Lane/3000 running RBA.
 *
 * RBA ships 13 ad screens (AD1.K3Z ... AD13.K3Z), each a single full-screen 320x240 image named
 * AD<n>.JPG. We overwrite AD13.JPG with our own picture (62.x File Write, no reboot needed for
 * images) and show the AD13.K3Z screen (24.x Form Entry).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { SCREEN_H as H, SCREEN_W as W, toJpeg } from "../gfx/encode.js";
import { Raster, WHITE, type Rgb } from "../gfx/raster.js";
import { font } from "../gfx/text.js";
import type { Lane } from "../protocol/lane.js";
import { withLane } from "../protocol/serial.js";
import { repoPath } from "../util/paths.js";

export const USAGE = `Show a full-screen image on an Ingenico Lane/3000 running RBA.

How it works: RBA ships 13 ad screens (AD1.K3Z ... AD13.K3Z), each a single full-screen
320x240 image named AD<n>.JPG. We overwrite AD13.JPG with our own picture (62.x File Write,
no reboot needed for images) and show the AD13.K3Z screen (24.x Form Entry).

    npm run show-image -- --test-card        # generated test card
    npm run show-image -- photo.png          # any image, resized/cropped to 320x240
    npm run show-image -- --bounce 20        # frame-rate test: 20 frames of a bouncing ball
    npm run show-image -- --restore          # put the original AD13.JPG back (backups/AD13.JPG)`;

export const SLOT = "AD13";
export const BACKUP = repoPath("backups", `${SLOT}.JPG`);

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Local time as %H:%M:%S. */
export function clock(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function testCard(now: Date = new Date()): Raster {
  const img = new Raster(W, H, [0, 0, 0]);
  for (let y = 0; y < H; y++) {
    // vertical gradient
    img.line([0, y], [W, y], [20, 20 + Math.floor(y / 3), 60 + Math.floor(y / 2)]);
  }
  const bars: readonly Rgb[] = [
    [255, 255, 255], [255, 255, 0], [0, 255, 255], [0, 255, 0],
    [255, 0, 255], [255, 0, 0], [0, 0, 255], [0, 0, 0],
  ];
  const bw = Math.floor(W / bars.length);
  bars.forEach((c, i) => {
    img.rectangle([i * bw, 170, (i + 1) * bw - 1, 210], { fill: c });
  });
  for (let x = 0; x < W; x += 2) img.line([x, 214], [x, 239], WHITE); // 1-pixel stripes to check sharpness
  img.text([W / 2, 50], "IT WORKS!", font(46), [255, 220, 0], "mm");
  img.text([W / 2, 100], "Full-screen image from a Mac", font(16), WHITE, "mm");
  img.text([W / 2, 124], "RBA 62.x upload + AD13.K3Z", font(14), [180, 220, 255], "mm");
  img.text([W / 2, 148], clock(now), font(14), [180, 255, 180], "mm");
  img.rectangle([0, 0, W - 1, H - 1], { outline: [255, 0, 0] }); // 1px border: shows any cropping
  return img;
}

export function bounceFrame(i: number, n: number): Raster {
  const img = new Raster(W, H, [10, 10, 40]);
  const t = i / Math.max(1, n - 1);
  const x = Math.trunc(30 + (W - 60) * t);
  const y = Math.trunc(H - 30 - (H - 80) * Math.abs(Math.sin(i * 0.45)));
  img.ellipse([x - 22, y - 22, x + 22, y + 22], [255, 80, 60]);
  img.text([8, 8], `frame ${i + 1}/${n}`, font(18), WHITE);
  return img;
}

/** Upload the JPEG into the ad slot and display it. Returns seconds spent uploading. */
async function show(lane: Lane, jpeg: Uint8Array): Promise<number> {
  const t = Date.now();
  await lane.writeFile(`${SLOT}.JPG`, jpeg);
  const up = (Date.now() - t) / 1000;
  await lane.softReset(); // leave any screen we left up before
  await lane.send(`24.${SLOT}.K3Z`); // ad screens have no exit keys, so no reply comes back
  return up;
}

export async function main(args: readonly string[]): Promise<number> {
  const first = args[0];
  if (first === undefined) {
    console.error(USAGE);
    return 1;
  }
  await withLane(async (lane) => {
    if (first === "--restore") {
      const data = readFileSync(BACKUP);
      await lane.writeFile(`${SLOT}.JPG`, data);
      await lane.softReset();
      console.log(`Restored original ${SLOT}.JPG (${data.length} bytes) and returned to the idle screen.`);
      return;
    }
    if (!existsSync(BACKUP)) {
      mkdirSync(dirname(BACKUP), { recursive: true });
      const original = await lane.readBinary(`/HOST/${SLOT}.JPG`);
      if (original !== null && original.length > 0) {
        writeFileSync(BACKUP, original);
        console.log("Backed up original to", BACKUP);
      }
    }
    if (first === "--bounce") {
      const n = args[1] === undefined ? 20 : Number.parseInt(args[1], 10);
      if (!Number.isInteger(n) || n <= 0) throw new RangeError(`bad frame count ${JSON.stringify(args[1])}`);
      const frames: Uint8Array[] = [];
      for (let i = 0; i < n; i++) frames.push(await toJpeg(bounceFrame(i, n), 60));
      const t0 = Date.now();
      for (const f of frames) await show(lane, f);
      const dt = (Date.now() - t0) / 1000;
      const avg = frames.reduce((s, f) => s + f.length, 0) / n;
      console.log(`${n} frames, avg ${(avg / 1024).toFixed(1)} KB, ${dt.toFixed(1)}s total -> ${(n / dt).toFixed(2)} fps`);
      return;
    }
    const jpeg = await toJpeg(first === "--test-card" ? testCard() : first);
    const up = await show(lane, jpeg);
    console.log(`Uploaded ${(jpeg.length / 1024).toFixed(1)} KB in ${up.toFixed(2)}s and showed it full-screen.`);
  });
  return 0;
}
