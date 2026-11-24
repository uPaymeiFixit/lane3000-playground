import { createHash } from "node:crypto";

import sharp from "sharp";
import { describe, expect, it } from "bun:test";
import { expectRejects } from "./reject.js";

import { framePng, toJpeg } from "../src/gfx/encode.js";
import { ellipseSpans, Raster } from "../src/gfx/raster.js";
import { Lane } from "../src/protocol/lane.js";
import { decode8, isEncoded8 } from "../src/protocol/file-encoding.js";
import { FS, latin1Bytes } from "../src/protocol/framing.js";
import * as coinGrab from "../src/programs/coin-grab.js";
import { GameScreen, textScreen } from "../src/programs/game-screen.js";
import { chiptune } from "../src/programs/io-demo.js";
import * as life from "../src/programs/life.js";
import * as maze from "../src/programs/maze.js";
import { buildScript } from "../src/programs/maze-script.js";
import { bounceFrame, testCard } from "../src/programs/show-image.js";
import * as skimmer from "../src/programs/skimmer-hunt.js";
import * as snake from "../src/programs/snake.js";
import { PyRandom } from "../src/util/py-random.js";
import { pySetOrder, tupleHash } from "../src/util/py-set-order.js";
import { FakeTerminal, flush } from "./fake-terminal.js";

const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** Parse the PNG IHDR: width, height, bit depth, colour type. */
function ihdr(png: Uint8Array): { width: number; height: number; depth: number; colourType: number } {
  const b = Buffer.from(png);
  expect(b.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(b.toString("latin1", 12, 16)).toBe("IHDR");
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), depth: b.readUInt8(24), colourType: b.readUInt8(25) };
}

async function colourCount(png: Uint8Array): Promise<number> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const set = new Set<number>();
  for (let i = 0; i < data.length; i += info.channels) set.add(((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0));
  return set.size;
}

describe("frame PNGs", () => {
  const frames: [string, () => Raster][] = [
    ["snake", () => snake.previewFrame(new PyRandom(11))],
    ["maze", () => maze.previewFrame()],
    ["life", () => life.previewLife().render("speed 3/4", "SWIPE: glider gun!")],
    ["life title", () => life.titleScreen()],
    ["life paused", () => life.pausedFrame(life.previewLife())],
    ["text screen", () => textScreen(["GAME OVER", "score 3   best 9", "GREEN again   RED quit"], [60, 0, 0])],
  ];
  for (const [name, make] of frames) {
    it(`${name}: 320x240 palette PNG, <= 32 colours, a few KB`, async () => {
      const png = await framePng(make());
      const h = ihdr(png);
      expect([h.width, h.height, h.colourType]).toEqual([320, 240, 3]); // 3 = indexed colour
      expect(png.length).toBeGreaterThan(300);
      expect(png.length).toBeLessThan(6000);
      expect(await colourCount(png)).toBeLessThanOrEqual(32);
    });
  }

  it("refuses frames that are not 320x240", async () => {
    await expectRejects(framePng(new Raster(10, 10)), RangeError);
  });

  it("show-image JPEGs are baseline 320x240", async () => {
    for (const img of [testCard(new Date(2026, 0, 1, 12, 34, 56)), bounceFrame(3, 20)]) {
      const jpeg = await toJpeg(img);
      const meta = await sharp(jpeg).metadata();
      expect([meta.format, meta.width, meta.height, meta.isProgressive]).toEqual(["jpeg", 320, 240, false]);
    }
  });
});

describe("Pillow-compatible shapes (reference masks from Pillow 13)", () => {
  const mask = (r: Raster): string[] =>
    Array.from({ length: r.height }, (_, y) =>
      Array.from({ length: r.width }, (_, x) => (r.get(x, y)[0] > 0 ? "#" : ".")).join(""),
    );
  const ellipse = (a: number): string[] => {
    const r = new Raster(a + 1, a + 1);
    r.ellipse([0, 0, a, a], [255, 255, 255]);
    return mask(r);
  };

  it("snake eye (5x5), maze player (10x10) and snake food (14x14) ellipses", () => {
    expect(ellipse(4)).toEqual([".###.", "#####", "#####", "#####", ".###."]);
    expect(ellipse(9)).toEqual([
      "...####...", "..######..", ".########.", "##########", "##########",
      "##########", "##########", ".########.", "..######..", "...####...",
    ]);
    expect(ellipse(13).slice(0, 5)).toEqual([
      ".....####.....", "...########...", "..##########..", ".############.", ".############.",
    ]);
  });

  it("ellipse rows stay inside the box and are mirror-symmetric", () => {
    for (let a = 0; a < 40; a++) {
      for (const b of [a, 3, 9]) {
        const rows = new Map<number, [number, number]>();
        for (const [y, x0, x1] of ellipseSpans(a, b)) {
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(b);
          expect(x0).toBeGreaterThanOrEqual(0);
          expect(x1).toBeLessThanOrEqual(a);
          rows.set(y, [x0, x1]);
        }
        for (const [y, span] of rows) expect(rows.get(b - y)).toEqual(span);
      }
    }
  });

  it("snake body segment: rounded rectangle 18x18, radius 5", () => {
    const r = new Raster(18, 18);
    r.roundedRectangle([0, 0, 17, 17], 5, [255, 255, 255]);
    expect(mask(r).slice(0, 6)).toEqual([
      "...############...", "..##############..", ".################.",
      "##################", "##################", "##################",
    ]);
  });
});

describe("parity with the Python programs", () => {
  it("chiptune samples are identical to io_demo.chiptune()", () => {
    const s = chiptune();
    expect(s.length).toBe(302400);
    expect(sha256(new Uint8Array(s.buffer))).toBe("bcac165ea1931db288b5743acca2d304ba54009c53b7920ad40552a35fdb37db");
  });

  it("CPython set iteration order of (x, y) tuples", () => {
    const parts: string[] = [];
    for (let seed = 0; seed < 40; seed++) {
      const r = new PyRandom(seed);
      const cells: [number, number][] = [];
      for (let x = 0; x < 17; x++) for (let y = 0; y < 8; y++) cells.push([x, y]);
      r.shuffle(cells);
      const k = r.randint(0, cells.length);
      const order = pySetOrder(cells.slice(0, k), (c) => tupleHash(c), (a, b) => a[0] === b[0] && a[1] === b[1]);
      parts.push(order.map(([x, y]) => `${x},${y}`).join(";"));
    }
    expect(parts[5]?.startsWith("4,4;12,7;13,1;12,0;16,3;10,1;5,1;2,3;14,3;7,6;0,5;8,2")).toBe(true);
    expect(sha256(parts.join("|"))).toBe("bdcc680456948b71135661f52e25556c7b0158cce34663bfd3c88665f107108f");
  });

  it("coin_grab, skimmer_hunt and maze_script text output is byte-identical", () => {
    expect(sha256(coinGrab.preview() + "\n")).toBe("01ded380375ebb49d416c2f6f5347d1ffcf6e94a5f04d7738a7c68a2c170bf11");
    expect(sha256(skimmer.preview() + "\n")).toBe("0fb1390c875940fc732346c0179891a24ee911f64f227ba2f6b136a61754cf4d");
    expect(sha256(buildScript() + "\n")).toBe("22cfaf7b553c4ba8d3cf2f1890717d622904f9fc613f52a90b7f78d6a163ea04");
  });
});

describe("GameScreen over a fake terminal", () => {
  it("push uploads GAME.PNG, soft-resets, shows GAME.K3Z; keys collects 24.0<key> replies", async () => {
    const term = new FakeTerminal((body) => (body.startsWith("62.") ? { replies: ["62.0"] } : {}));
    const lane = new Lane(term, { ackTimeoutMs: 300 });
    const gs = new GameScreen(lane);
    await gs.push(textScreen(["HELLO"]));
    expect(term.received.map((b) => b.slice(0, 3))).toEqual(["62.", "15.", "24."]);
    expect(term.received[1]).toBe("15.0");
    expect(term.received[2]).toBe("24.GAME.K3Z");
    const first = term.received[0] ?? "";
    expect(first.startsWith(`62.0801000010GAME.PNG${FS}`)).toBe(true);
    const enc = latin1Bytes(first.slice(first.indexOf(FS) + 1));
    if (!isEncoded8(enc)) throw new Error("upload not eight-bit encoded");
    expect(ihdr(decode8(enc)).width).toBe(320);

    expect(await gs.keys()).toEqual([]);
    term.emitFrame("24.0L");
    term.emitFrame("24.0\x08");
    term.emitFrame("24.1"); // not a key exit: ignored
    term.emitFrame("24.0\x1b");
    await flush();
    expect(await gs.keys()).toEqual(["L", "\b", "\x1b"]);
    setTimeout(() => {
      term.emitFrame("24.0\r");
    }, 20);
    expect(await gs.keys(2000)).toEqual(["\r"]);
  });
});
