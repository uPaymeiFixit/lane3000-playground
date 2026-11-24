/**
 * Full-screen real-time Snake for an Ingenico Lane/3000 (needs `game-screen --install` once).
 */

import { savePng } from "../gfx/encode.js";
import { Raster, WHITE, type Box, type Rgb } from "../gfx/raster.js";
import { font } from "../gfx/text.js";
import type { GameKey } from "../protocol/messages.js";
import { withLane } from "../protocol/serial.js";
import { sleep } from "../util/interrupt.js";
import { PyRandom, type Rng } from "../util/py-random.js";
import { GameScreen, textScreen } from "./game-screen.js";

export const USAGE = `Full-screen real-time Snake for an Ingenico Lane/3000 (needs \`bun run game-screen --install\` once).

Keys:  F1 left   F2 (up arrow) up   F3 (down arrow) down   F4 right
       GREEN start / restart   YELLOW pause   RED quit

    bun run snake                  # play on the terminal
    bun run snake --preview     # save a sample frame to preview.png, no terminal needed`;

export const CELL = 20;
export const COLS = 16; // 320 x 220 board under a 20 px score bar
export const ROWS = 11;
export const TOP = 20;
/** Seconds per step (the terminal manages ~5 frames/s). */
export const TICK = 0.22;

export type Cell = readonly [x: number, y: number];
export type Dir = readonly [dx: -1 | 0 | 1, dy: -1 | 0 | 1];
export type SteerKey = "L" | "U" | "D" | "R";

export const DIRS: Readonly<Record<SteerKey, Dir>> = { L: [-1, 0], U: [0, -1], D: [0, 1], R: [1, 0] };

function isSteerKey(k: string): k is SteerKey {
  return k === "L" || k === "U" || k === "D" || k === "R";
}

const BG: Rgb = [12, 16, 28];
const GRID: Rgb = [22, 28, 44];
const BODY: Rgb = [60, 200, 90];
const HEAD: Rgb = [150, 255, 120];
const FOOD: Rgb = [240, 60, 60];

const same = (a: Cell | Dir, b: Cell | Dir): boolean => a[0] === b[0] && a[1] === b[1];

export class Snake {
  body: Cell[];
  dir: Dir = [1, 0];
  readonly pending: Dir[] = [];
  score = 0;
  dead = false;
  food: Cell = [0, 0];

  constructor(private readonly rng: Rng = new PyRandom()) {
    const y = Math.floor(ROWS / 2);
    this.body = [
      [5, y],
      [4, y],
      [3, y],
    ];
    this.placeFood();
  }

  placeFood(): void {
    const free: Cell[] = [];
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) if (!this.body.some((c) => c[0] === x && c[1] === y)) free.push([x, y]);
    }
    this.food = this.rng.choice(free);
  }

  /** Queue a turn so quick double-taps both count; reversing or repeating is ignored. */
  turn(key: string): void {
    if (!isSteerKey(key)) return;
    const d = DIRS[key];
    const last = this.pending.at(-1) ?? this.dir;
    if (!same(d, last) && !(d[0] === -last[0] && d[1] === -last[1])) this.pending.push(d);
  }

  step(): void {
    const next = this.pending.shift();
    if (next !== undefined) this.dir = next;
    const [hx, hy] = this.body[0] ?? [0, 0];
    const head: Cell = [hx + this.dir[0], hy + this.dir[1]];
    const grow = same(head, this.food);
    const body = grow ? this.body : this.body.slice(0, -1);
    if (!(head[0] >= 0 && head[0] < COLS && head[1] >= 0 && head[1] < ROWS) || body.some((c) => same(c, head))) {
      this.dead = true;
      return;
    }
    this.body = [head, ...body];
    if (grow) {
      this.score += 1;
      if (this.body.length === COLS * ROWS) this.dead = true;
      else this.placeFood();
    }
  }

  static cell(x: number, y: number): Box {
    return [x * CELL, TOP + y * CELL, x * CELL + CELL - 1, TOP + y * CELL + CELL - 1];
  }

  render(best: number, paused = false): Raster {
    const img = new Raster(320, 240, BG);
    img.rectangle([0, 0, 319, TOP - 1], { fill: [0, 0, 0] });
    img.text([6, 2], `SCORE ${this.score}`, font(15), [255, 220, 0]);
    img.text([314, 2], `BEST ${best}`, font(15), [180, 180, 180], "ra");
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) if ((x + y) % 2 === 1) img.rectangle(Snake.cell(x, y), { fill: GRID });
    }
    {
      const [x0, y0, x1, y1] = Snake.cell(this.food[0], this.food[1]);
      img.ellipse([x0 + 3, y0 + 3, x1 - 3, y1 - 3], FOOD);
      img.line([x0 + 10, y0 + 1], [x0 + 12, y0 + 5], [90, 200, 90], 2);
    }
    for (const [x, y] of [...this.body].reverse()) {
      const [x0, y0, x1, y1] = Snake.cell(x, y);
      img.roundedRectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1], 5, BODY);
    }
    const [hx, hy] = this.body[0] ?? [0, 0];
    const [x0, y0, x1, y1] = Snake.cell(hx, hy);
    img.roundedRectangle([x0, y0, x1, y1], 6, HEAD);
    const [dx, dy] = this.dir;
    const cx = Math.floor((x0 + x1) / 2) + dx * 4;
    const cy = Math.floor((y0 + y1) / 2) + dy * 4;
    for (const s of [-1, 1]) {
      // eyes, placed sideways relative to the direction of travel
      const ex = cx + s * 4 * dy;
      const ey = cy + s * 4 * dx;
      img.ellipse([ex - 2, ey - 2, ex + 2, ey + 2], [0, 0, 0]);
    }
    if (paused) {
      img.rectangle([90, 100, 230, 140], { fill: [0, 0, 0] });
      img.text([160, 120], "PAUSED", font(24), WHITE, "mm");
    }
    return img;
  }
}

async function waitKey<K extends GameKey>(gs: GameScreen, accept: readonly K[]): Promise<K> {
  for (;;) {
    for (const k of await gs.keys(3600_000)) {
      const hit = accept.find((a) => a === k);
      if (hit !== undefined) return hit;
    }
  }
}

async function play(): Promise<void> {
  let best = 0;
  await withLane(async (lane) => {
    const gs = new GameScreen(lane);
    try {
      await gs.push(textScreen(["SNAKE", "arrows / F1 F4 to steer", "GREEN start   RED quit"]));
      if ((await waitKey(gs, ["\r", "\x1b"])) === "\x1b") return;
      for (;;) {
        const s = new Snake();
        let paused = false;
        for (;;) {
          const t = Date.now();
          for (const k of await gs.keys()) {
            if (k === "\x1b") return;
            if (k === "\b") paused = !paused;
            else s.turn(k);
          }
          if (!paused) s.step();
          if (s.dead) break;
          await gs.push(s.render(best, paused));
          await sleep(Math.max(0, TICK * 1000 - (Date.now() - t)));
        }
        best = Math.max(best, s.score);
        console.log(`score ${s.score}  best ${best}`);
        await gs.push(
          textScreen(["GAME OVER", `score ${s.score}   best ${best}`, "GREEN again   RED quit"], [60, 0, 0]),
        );
        if ((await waitKey(gs, ["\r", "\x1b"])) === "\x1b") return;
      }
    } finally {
      await lane.softReset();
    }
  });
}

/** The --preview frame: a fresh snake after "RRDDDLL". */
export function previewFrame(rng: Rng = new PyRandom()): Raster {
  const s = new Snake(rng);
  for (const k of "RRDDDLL") {
    s.turn(k);
    s.step();
  }
  return s.render(7);
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes("--preview")) {
    await savePng(previewFrame(), "preview.png");
    console.log("wrote preview.png");
    return 0;
  }
  await play();
  return 0;
}
