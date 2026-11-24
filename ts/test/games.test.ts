import { describe, expect, it } from "bun:test";

import { CH, CW, Maze, generate, solve } from "../src/programs/maze.js";
import {
  CYAN,
  COLS as LIFE_COLS,
  GOSPER_GUN,
  GREEN,
  Life,
  MAGENTA,
  ORANGE,
  ROWS as LIFE_ROWS,
  birthColor,
} from "../src/programs/life.js";
import { COLS, ROWS, Snake } from "../src/programs/snake.js";
import { PyRandom } from "../src/util/py-random.js";

describe("maze", () => {
  it("every generated maze is a solvable perfect maze (500 seeds)", () => {
    for (let seed = 0; seed < 500; seed++) {
      const m = new Maze(new PyRandom(seed));
      expect(solve(m)).not.toBeNull();
      // perfect maze = spanning tree: CW*CH cells + (CW*CH - 1) opened walls
      const open = m.walls.flat().filter((w) => !w).length;
      expect(open).toBe(2 * CW * CH - 1);
      // border intact
      expect(m.walls[0]?.every((w) => w)).toBe(true);
      expect(m.walls[2 * CH]?.every((w) => w)).toBe(true);
    }
  });

  it("seed 3 matches the Python maze exactly", () => {
    const rows = generate(new PyRandom(3)).map((r) => r.map((w) => (w ? "#" : ".")).join(""));
    expect(rows.slice(1, 4)).toEqual([
      "#.#...#.......#.........#",
      "#.#.###.###.#.#.#######.#",
      "#.#.......#.#.#.....#...#",
    ]);
  });

  it("moves stop at walls and following the solution wins", () => {
    const m = new Maze(new PyRandom(5));
    const blocked = new Maze(new PyRandom(5));
    blocked.press("U"); // (1,0) is the border wall
    expect(blocked.moves).toBe(0);
    expect(blocked.pos).toEqual([1, 1]);
    const path = solutionPath(m);
    for (const k of path) m.press(k);
    expect(m.won).toBe(true);
    expect(m.moves).toBe(path.length);
    expect(solve(new Maze(new PyRandom(5)))).toBe(path.length);
  });
});

type Step = "L" | "U" | "D" | "R";
const STEPS: readonly (readonly [Step, number, number])[] = [
  ["L", -1, 0],
  ["U", 0, -1],
  ["D", 0, 1],
  ["R", 1, 0],
];

/** Keys from the start to the exit (breadth-first search with parent links). */
function solutionPath(m: Maze): Step[] {
  const parent = new Map<string, readonly [string, Step]>();
  const q: [number, number][] = [[1, 1]];
  const seen = new Set(["1,1"]);
  const [ex, ey] = m.exit;
  for (const [x, y] of q) {
    if (x === ex && y === ey) break;
    for (const [k, dx, dy] of STEPS) {
      const key = `${x + dx},${y + dy}`;
      if (!m.isWall(x + dx, y + dy) && !seen.has(key)) {
        seen.add(key);
        parent.set(key, [`${x},${y}`, k]);
        q.push([x + dx, y + dy]);
      }
    }
  }
  const path: Step[] = [];
  let cur = `${ex},${ey}`;
  for (let p = parent.get(cur); p !== undefined; p = parent.get(cur)) {
    path.unshift(p[1]);
    cur = p[0];
  }
  return path;
}

function emptyLife(): Life {
  const l = new Life(new PyRandom(0));
  l.clear();
  return l;
}

function cellsOf(l: Life): string[] {
  return [...l.cells.keys()].sort((a, b) => a - b).map((k) => `${k % LIFE_COLS},${Math.floor(k / LIFE_COLS)}`);
}

describe("life", () => {
  it("birth colour: majority of the three parents, else the fourth colour", () => {
    expect(birthColor([CYAN, CYAN, ORANGE])).toBe(CYAN);
    expect(birthColor([ORANGE, GREEN, GREEN])).toBe(GREEN);
    expect(birthColor([MAGENTA, MAGENTA, MAGENTA])).toBe(MAGENTA);
    expect(birthColor([CYAN, ORANGE, GREEN])).toBe(MAGENTA);
    expect(birthColor([MAGENTA, ORANGE, GREEN])).toBe(CYAN);
    expect(birthColor([CYAN, MAGENTA, GREEN])).toBe(ORANGE);
    expect(birthColor([CYAN, MAGENTA, ORANGE])).toBe(GREEN);
  });

  it("applies the colour rule to births on the board", () => {
    const l = emptyLife();
    l.put(10, 10, CYAN);
    l.put(11, 10, ORANGE);
    l.put(12, 10, GREEN); // blinker of three colours: the births at (11,9) and (11,11) get MAGENTA
    l.step();
    expect(l.cells.get(9 * LIFE_COLS + 11)).toBe(MAGENTA);
    expect(l.cells.get(11 * LIFE_COLS + 11)).toBe(MAGENTA);
    expect(l.cells.get(10 * LIFE_COLS + 11)).toBe(ORANGE); // survivor keeps its colour
    expect(l.age.get(10 * LIFE_COLS + 11)).toBe(1);
  });

  it("blinker oscillates and block is still", () => {
    const l = emptyLife();
    for (const x of [5, 6, 7]) l.put(x, 5, CYAN);
    for (const [x, y] of [[20, 20], [21, 20], [20, 21], [21, 21]] as const) l.put(x, y, GREEN);
    const start = cellsOf(l);
    l.step();
    expect(cellsOf(l)).not.toEqual(start);
    l.step();
    expect(cellsOf(l)).toEqual(start);
    expect(l.gen).toBe(2);
  });

  it("dead edges: a glider flies off the board instead of wrapping", () => {
    const l = emptyLife();
    // glider heading down-right, placed near the bottom-right corner
    for (const [x, y] of [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]] as const) l.put(LIFE_COLS - 6 + x, LIFE_ROWS - 6 + y, ORANGE);
    for (let i = 0; i < 60; i++) {
      l.step();
      for (const k of l.cells.keys()) {
        const x = k % LIFE_COLS;
        const y = Math.floor(k / LIFE_COLS);
        expect(x).toBeGreaterThanOrEqual(LIFE_COLS - 8); // never wraps to the left side
        expect(y).toBeGreaterThanOrEqual(LIFE_ROWS - 8); // or to the top
      }
    }
    expect(l.cells.size).toBeLessThanOrEqual(4); // it dies or leaves a still life at the edge
  });

  it("a Gosper glider gun keeps firing for 120 generations", () => {
    const l = emptyLife();
    for (const [x, y] of GOSPER_GUN) l.put(1 + x, 9 + y, ORANGE);
    const gunCells = new Set(cellsOf(l));
    const pops: number[] = [];
    for (let g = 1; g <= 120; g++) {
      l.step();
      if (g % 30 === 0) {
        // period 30: the gun itself is back in its starting shape
        const now = new Set(cellsOf(l));
        for (const c of gunCells) expect(now.has(c)).toBe(true);
        pops.push(l.cells.size);
      }
    }
    // gliders leave the gun every 30 generations (until they fly off the bottom edge)
    expect(pops[0]).toBeGreaterThan(gunCells.size);
    for (const p of pops) expect(p).toBeGreaterThan(gunCells.size);
    expect([...l.cells.values()].every((c) => c === ORANGE)).toBe(true);
  });

  it("seed 7 preview board matches the Python run exactly", () => {
    const l = new Life(new PyRandom(7));
    for (let i = 0; i < 12; i++) l.step();
    l.gliderGun();
    l.splash();
    l.kaleidoscope();
    for (let i = 0; i < 6; i++) l.step();
    let checksum = 0;
    for (const [k, c] of l.cells) checksum += (k % LIFE_COLS) * 31 + Math.floor(k / LIFE_COLS) * 7 + c;
    expect([l.gen, l.cells.size, checksum]).toEqual([18, 215, 155095]);
  });

  it("card effects stay on the board and use their colours", () => {
    const l = emptyLife();
    l.gliderGun();
    l.splash();
    l.kaleidoscope();
    const colours = new Set(l.cells.values());
    expect(colours).toEqual(new Set([ORANGE, GREEN, MAGENTA]));
    for (const k of l.cells.keys()) expect(k).toBeLessThan(LIFE_COLS * LIFE_ROWS);
  });
});

describe("snake", () => {
  it("moves one cell per step in the current direction", () => {
    const s = new Snake(new PyRandom(1));
    s.food = [0, 0];
    expect(s.body[0]).toEqual([5, 5]);
    s.step();
    expect(s.body).toEqual([[6, 5], [5, 5], [4, 5]]);
  });

  it("queues quick turns so a double tap both count, ignoring reversals and repeats", () => {
    const s = new Snake(new PyRandom(1));
    s.food = [0, 0];
    s.turn("L"); // reverse of right: ignored
    s.turn("R"); // same as current: ignored
    s.turn("D");
    s.turn("D"); // repeat of the queued turn: ignored
    s.turn("L");
    expect(s.pending).toEqual([[0, 1], [-1, 0]]);
    s.step();
    expect(s.body[0]).toEqual([5, 6]);
    s.step();
    expect(s.body[0]).toEqual([4, 6]);
  });

  it("dies on the wall", () => {
    const s = new Snake(new PyRandom(1));
    s.food = [0, 0];
    for (let i = 0; i < COLS - 6; i++) s.step();
    expect(s.dead).toBe(false);
    s.step();
    expect(s.dead).toBe(true);
  });

  it("dies running into itself", () => {
    const s = new Snake(new PyRandom(1));
    s.body = [[5, 5], [4, 5], [3, 5], [3, 6], [4, 6], [5, 6], [6, 6]];
    s.food = [0, 0];
    s.dir = [0, -1];
    s.turn("L");
    s.turn("D");
    s.step(); // turning left from (5,5) runs into (4,5), its own body
    expect(s.dead).toBe(true);
  });

  it("grows and scores when it eats, then places new food off the body", () => {
    const s = new Snake(new PyRandom(1));
    s.food = [6, 5];
    s.step();
    expect(s.score).toBe(1);
    expect(s.body).toHaveLength(4);
    expect(s.body.some((c) => c[0] === s.food[0] && c[1] === s.food[1])).toBe(false);
    expect(s.food[0]).toBeLessThan(COLS);
    expect(s.food[1]).toBeLessThan(ROWS);
  });

  it("moving into the cell the tail is leaving is allowed", () => {
    const s = new Snake(new PyRandom(1));
    s.body = [[5, 5], [5, 6], [4, 6], [4, 5]];
    s.dir = [0, -1];
    s.food = [0, 0];
    s.turn("L"); // into (4,5), the tail, which moves away this step
    s.step();
    expect(s.dead).toBe(false);
    expect(s.body[0]).toEqual([4, 5]);
  });
});
