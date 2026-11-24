/**
 * Maze for an Ingenico Lane/3000, drawn as full-screen images from the Mac.
 * Every game is a freshly generated maze. Steer the yellow ball to the green exit.
 */

import { savePng } from "../gfx/encode.js";
import { Raster, type Box, type Rgb } from "../gfx/raster.js";
import { font } from "../gfx/text.js";
import { withLane } from "../protocol/serial.js";
import { PyRandom, type Rng } from "../util/py-random.js";
import { GameScreen } from "./game-screen.js";

export const USAGE = `Maze for an Ingenico Lane/3000, drawn as full-screen images from the Mac.

Needs the full-screen layout once: \`npm run game-screen -- --install\`.
Every game is a freshly generated maze. Steer the yellow ball to the green exit.

Keys:  F1 left   F2 (up arrow) up   F3 (down arrow) down   F4 right
       GREEN new maze   RED quit

    npm run maze                  # play on the terminal
    npm run maze -- --preview     # save a sample frame to preview.png`;

/** Maze cells -> (2*CW+1) x (2*CH+1) = 25 x 17 tiles. */
export const CW = 12;
export const CH = 8;
/** 25*12 = 300 px wide, 17*12 = 204 px tall. */
export const TILE = 12;
/** Status bar height. */
export const TOP = 30;
export const OX = Math.floor((320 - (2 * CW + 1) * TILE) / 2);
export const OY = TOP + Math.floor((240 - TOP - (2 * CH + 1) * TILE) / 2);

export type MoveKey = "L" | "U" | "D" | "R";
export const MOVES: Readonly<Record<MoveKey, readonly [number, number]>> = {
  L: [-1, 0],
  U: [0, -1],
  D: [0, 1],
  R: [1, 0],
};
const MOVE_ORDER: readonly MoveKey[] = ["L", "U", "D", "R"];

export function isMoveKey(k: string): k is MoveKey {
  return k === "L" || k === "U" || k === "D" || k === "R";
}

const BG: Rgb = [14, 18, 32];
const WALL: Rgb = [60, 90, 170];
const WALL_EDGE: Rgb = [100, 140, 230];
const TRAIL: Rgb = [70, 70, 40];
const PLAYER: Rgb = [255, 210, 40];
const EXIT: Rgb = [60, 220, 110];

/** grid[y][x] is true for walls. */
export type Grid = boolean[][];

/** Perfect maze via randomized depth-first search. */
export function generate(rng: Rng = new PyRandom()): Grid {
  const w = 2 * CW + 1;
  const h = 2 * CH + 1;
  const grid: Grid = Array.from({ length: h }, () => Array.from({ length: w }, () => true));
  const open = (x: number, y: number): void => {
    const row = grid[y];
    if (row !== undefined) row[x] = false;
  };
  const stack: [number, number][] = [[0, 0]];
  const seen = new Set<number>([0]);
  open(1, 1);
  for (;;) {
    const top = stack.at(-1);
    if (top === undefined) break;
    const [cx, cy] = top;
    const options: (readonly [number, number, number, number])[] = [];
    for (const k of MOVE_ORDER) {
      const [dx, dy] = MOVES[k];
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && nx < CW && ny >= 0 && ny < CH && !seen.has(ny * CW + nx)) options.push([nx, ny, dx, dy]);
    }
    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const [nx, ny, dx, dy] = rng.choice(options);
    open(2 * cx + 1 + dx, 2 * cy + 1 + dy);
    open(2 * nx + 1, 2 * ny + 1);
    seen.add(ny * CW + nx);
    stack.push([nx, ny]);
  }
  return grid;
}

export class Maze {
  readonly walls: Grid;
  pos: readonly [number, number] = [1, 1];
  readonly exit: readonly [number, number] = [2 * CW - 1, 2 * CH - 1];
  readonly trail = new Set<string>(["1,1"]);
  moves = 0;
  readonly start = Date.now();
  won = false;

  constructor(rng: Rng = new PyRandom()) {
    this.walls = generate(rng);
  }

  isWall(x: number, y: number): boolean {
    return this.walls[y]?.[x] ?? true;
  }

  press(key: MoveKey): void {
    const [dx, dy] = MOVES[key];
    const x = this.pos[0] + dx;
    const y = this.pos[1] + dy;
    if (!this.isWall(x, y)) {
      this.pos = [x, y];
      this.trail.add(`${x},${y}`);
      this.moves += 1;
      this.won = x === this.exit[0] && y === this.exit[1];
    }
  }

  static box(x: number, y: number, inset = 0): Box {
    const x0 = OX + x * TILE;
    const y0 = OY + y * TILE;
    return [x0 + inset, y0 + inset, x0 + TILE - 1 - inset, y0 + TILE - 1 - inset];
  }

  render(): Raster {
    const img = new Raster(320, 240, BG);
    img.rectangle([0, 0, 319, TOP - 1], { fill: [0, 0, 0] });
    if (this.won) {
      const secs = Math.trunc((Date.now() - this.start) / 1000);
      img.text([160, TOP / 2], `ESCAPED in ${this.moves} moves, ${secs}s`, font(16), EXIT, "mm");
    } else {
      img.text([8, TOP / 2], `MOVES ${this.moves}`, font(15), [255, 220, 0], "lm");
      img.text([312, TOP / 2], "GREEN new  RED quit", font(12), [150, 150, 170], "rm");
    }
    this.walls.forEach((row, y) => {
      row.forEach((wall, x) => {
        if (wall) {
          const [x0, y0, x1, y1] = Maze.box(x, y);
          img.rectangle([x0, y0, x1, y1], { fill: WALL });
          img.line([x0, y0], [x1, y0], WALL_EDGE);
        } else if (this.trail.has(`${x},${y}`)) {
          img.ellipse(Maze.box(x, y, 4), TRAIL);
        }
      });
    });
    img.rectangle(Maze.box(this.exit[0], this.exit[1], 1), { fill: EXIT });
    img.ellipse(Maze.box(this.pos[0], this.pos[1], 1), PLAYER);
    return img;
  }
}

/** Breadth-first search from the start to the exit; null if unreachable (used by the tests). */
export function solve(maze: Maze): number | null {
  const [ex, ey] = maze.exit;
  const dist = new Map<string, number>([["1,1", 0]]);
  const queue: [number, number][] = [[1, 1]];
  for (const [x, y] of queue) {
    const d = dist.get(`${x},${y}`) ?? 0;
    if (x === ex && y === ey) return d;
    for (const k of MOVE_ORDER) {
      const [dx, dy] = MOVES[k];
      const key = `${x + dx},${y + dy}`;
      if (!maze.isWall(x + dx, y + dy) && !dist.has(key)) {
        dist.set(key, d + 1);
        queue.push([x + dx, y + dy]);
      }
    }
  }
  return null;
}

async function play(): Promise<void> {
  await withLane(async (lane) => {
    const gs = new GameScreen(lane);
    try {
      let m = new Maze();
      for (;;) {
        await gs.push(m.render());
        if (m.won) console.log(`escaped in ${m.moves} moves`);
        for (const k of await gs.keys(3600_000)) {
          if (k === "\x1b") return;
          if (k === "\r") m = new Maze();
          else if (isMoveKey(k) && !m.won) m.press(k);
        }
      }
    } finally {
      await lane.softReset();
    }
  });
}

/** The --preview frame: seed 3, after "RRDDRRRR". */
export function previewFrame(): Raster {
  const m = new Maze(new PyRandom(3));
  for (const k of "RRDDRRRR") if (isMoveKey(k)) m.press(k);
  return m.render();
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
