/**
 * SKIMMER HUNT - a turn-based ASCII first-person maze shooter for an Ingenico Lane/3000.
 * (Early experiment, superseded: too small to read.)
 *
 * The Mac raycasts the maze into an 8 x 38 character frame and pushes each row to the terminal's
 * monospace line display (RBA variables 111-118) on the BAMTV.K3Z form. Every key press is one
 * game turn.
 */

import { withLane } from "../protocol/serial.js";
import { PyRandom, type Rng } from "../util/py-random.js";
import { chars, pyRepr } from "../util/py-repr.js";
import { showRows } from "./bamtv.js";

export const USAGE = `SKIMMER HUNT - a turn-based ASCII first-person maze shooter for an Ingenico Lane/3000.

Keys:  F1 turn left   F2 forward   F3 back   F4 turn right   GREEN fire   RED quit

Run:   bun run skimmer-hunt                (plays on the terminal)
       bun run skimmer-hunt --preview   (prints a few frames here; no terminal needed)`;

/** 3D view size; each row gets a '|' border on both sides -> 38 columns. */
export const W = 36;
export const H = 8;
const FOV = (66 * Math.PI) / 180;
const TURN = (45 * Math.PI) / 180;
const STEP = 0.7;

// P = player start, S = skimmer, + = med kit, a = ammo
export const MAP: readonly string[] = [
  "################",
  "#P....#........#",
  "#.##..#..##.##.#",
  "#.#...S..#...#.#",
  "#.#.####.#.S.#.#",
  "#...#a...#...#.#",
  "###.#.####.###.#",
  "#...#....+.#...#",
  "#.S.####.#.#.S.#",
  "#........#...#.#",
  "#.####.#.###.#.#",
  "#.#..+.#..a..#S#",
  "#...##.....#...#",
  "################",
];

interface Enemy {
  x: number;
  y: number;
  hp: number;
}
interface Item {
  readonly x: number;
  readonly y: number;
  readonly kind: "+" | "a";
}
interface Positioned {
  readonly x: number;
  readonly y: number;
}

/** Python's float `%` (result takes the divisor's sign). */
function pyMod(a: number, b: number): number {
  let m = a % b;
  if (m !== 0 && b < 0 !== m < 0) m += b;
  return m;
}

function copysign(mag: number, sign: number): number {
  return sign < 0 || Object.is(sign, -0) ? -Math.abs(mag) : Math.abs(mag);
}

export class Game {
  private readonly walls = new Set<string>();
  readonly enemies: Enemy[] = [];
  readonly items: Item[] = [];
  px = 0;
  py = 0;
  angle = 0;
  hp = 100;
  ammo = 16;
  turns = 0;
  msg = "Find and zap every skimmer";
  readonly total: number;

  constructor(private readonly rng: Rng = new PyRandom()) {
    MAP.forEach((row, y) => {
      chars(row).forEach((c, x) => {
        if (c === "#") this.walls.add(`${x},${y}`);
        else if (c === "P") {
          this.px = x + 0.5;
          this.py = y + 0.5;
        } else if (c === "S") this.enemies.push({ x: x + 0.5, y: y + 0.5, hp: 2 });
        else if (c === "+" || c === "a") this.items.push({ x: x + 0.5, y: y + 0.5, kind: c });
      });
    });
    this.total = this.enemies.length;
  }

  // ---- world helpers ----------------------------------------------------
  private isWallCell(mx: number, my: number): boolean {
    return this.walls.has(`${mx},${my}`);
  }

  wall(x: number, y: number): boolean {
    return this.isWallCell(Math.floor(x), Math.floor(y));
  }

  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.trunc(d * 8));
    for (let i = 1; i < n; i++) {
      if (this.wall(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n)) return false;
    }
    return true;
  }

  /** DDA raycast. Returns [perpendicular-ish distance, side hit]. */
  cast(ang: number): readonly [number, 0 | 1] {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let mx = Math.trunc(this.px);
    let my = Math.trunc(this.py);
    const ddx = dx !== 0 ? Math.abs(1 / dx) : 1e9;
    const ddy = dy !== 0 ? Math.abs(1 / dy) : 1e9;
    const sx = dx < 0 ? -1 : 1;
    let sdx = dx < 0 ? (this.px - mx) * ddx : (mx + 1 - this.px) * ddx;
    const sy = dy < 0 ? -1 : 1;
    let sdy = dy < 0 ? (this.py - my) * ddy : (my + 1 - this.py) * ddy;
    for (let k = 0; k < 64; k++) {
      if (sdx < sdy) {
        sdx += ddx;
        mx += sx;
        if (this.isWallCell(mx, my)) return [sdx - ddx, 0];
      } else {
        sdy += ddy;
        my += sy;
        if (this.isWallCell(mx, my)) return [sdy - ddy, 1];
      }
    }
    return [20.0, 0];
  }

  /** Distance and bearing (radians, -pi..pi, 0 = straight ahead) of an object. */
  rel(obj: Positioned): readonly [number, number] {
    const dx = obj.x - this.px;
    const dy = obj.y - this.py;
    let a = Math.atan2(dy, dx) - this.angle;
    a = pyMod(a + Math.PI, 2 * Math.PI) - Math.PI;
    return [Math.hypot(dx, dy), a];
  }

  // ---- rendering --------------------------------------------------------
  render(): string[] {
    const grid: string[][] = Array.from({ length: H }, () => Array.from({ length: W }, () => " "));
    const put = (r: number, c: number, ch: string): void => {
      const row = grid[r];
      if (row !== undefined) row[c] = ch;
    };
    for (let r = Math.floor(H / 2) + 2; r < H; r++) {
      for (let c = 0; c < W; c++) put(r, c, r === H - 1 ? "." : " ");
    }
    const zbuf: number[] = Array.from({ length: W }, () => 0);
    for (let c = 0; c < W; c++) {
      const off = (c / (W - 1) - 0.5) * FOV;
      const [dist, side] = this.cast(this.angle + off);
      const d = Math.max(0.05, dist * Math.cos(off));
      zbuf[c] = d;
      const h = Math.min(H, Math.trunc((H * 1.1) / d));
      const top = Math.floor((H - h) / 2);
      const shade = Math.min(4, Math.trunc(d / 1.6));
      const ch = (side === 0 ? "#%=-:" : "H+~-.").charAt(shade);
      for (let r = top; r < top + h; r++) put(r, c, ch);
    }

    const sprites: (readonly [Positioned, "enemy" | "item"])[] = [
      ...this.enemies.map((o): readonly [Positioned, "enemy"] => [o, "enemy"]),
      ...this.items.map((o): readonly [Positioned, "item"] => [o, "item"]),
    ];
    sprites.sort((s, t) => -this.rel(s[0])[0] - -this.rel(t[0])[0]);
    for (const [obj, kind] of sprites) {
      const [d, a] = this.rel(obj);
      if (Math.abs(a) > FOV / 2 + 0.3 || d < 0.2) continue;
      const pd = d * Math.cos(a);
      const col = Math.trunc((a / FOV + 0.5) * (W - 1));
      let h: number;
      let w: number;
      let top: number;
      let rows: string[];
      if (kind === "enemy") {
        h = Math.max(1, Math.min(H, Math.trunc((H * 0.9) / pd)));
        w = Math.max(1, Math.trunc(h * 1.3));
        top = Math.floor((H - h) / 2) + (h < H ? 1 : 0);
        rows = [h < 3 ? "o" : "O", ...Array.from({ length: Math.max(0, h - 2) }, () => "&"), ...(h >= 2 ? ["^"] : [])];
      } else {
        h = pd > 2.5 ? 1 : 2;
        w = Math.max(1, Math.trunc(3 / pd));
        top = H - h - (pd < 2 ? 0 : 1);
        const glyph = "kind" in obj && obj.kind === "+" ? "+" : "=";
        rows = Array.from({ length: h }, () => glyph);
      }
      const start = col - Math.floor(w / 2);
      for (let c = start; c < start + w; c++) {
        if (c >= 0 && c < W && pd < (zbuf[c] ?? 0)) {
          rows.forEach((glyph, i) => {
            if (top + i >= 0 && top + i < H) put(top + i, c, glyph);
          });
        }
      }
    }
    return grid.map((r) => "|" + r.join("") + "|");
  }

  hud(): string {
    return `HP ${this.hp}  AMMO ${this.ammo}  SKIMMERS ${this.enemies.length}/${this.total}   ${this.msg}`;
  }

  // ---- turn logic -------------------------------------------------------
  move(dist: number): void {
    const nx = this.px + Math.cos(this.angle) * dist;
    const ny = this.py + Math.sin(this.angle) * dist;
    const pad = 0.2;
    if (!this.wall(nx + copysign(pad, nx - this.px), this.py)) this.px = nx;
    if (!this.wall(this.px, ny + copysign(pad, ny - this.py))) this.py = ny;
  }

  fire(): void {
    if (this.ammo <= 0) {
      this.msg = "Click. Out of ammo!";
      return;
    }
    this.ammo -= 1;
    let target: Enemy | null = null;
    let best = 99;
    for (const e of this.enemies) {
      const [d, a] = this.rel(e);
      if (Math.abs(a) < Math.atan2(0.45, d) + 0.05 && d < best && this.lineOfSight(this.px, this.py, e.x, e.y)) {
        target = e;
        best = d;
      }
    }
    if (target === null) {
      this.msg = "ZAP! Missed.";
      return;
    }
    target.hp -= 1;
    if (target.hp <= 0) {
      this.enemies.splice(this.enemies.indexOf(target), 1);
      this.msg = this.enemies.length > 0 ? "ZAP! Skimmer destroyed!" : "";
    } else {
      this.msg = "ZAP! Hit - it's still sparking";
    }
  }

  worldTurn(): void {
    for (const it of [...this.items]) {
      if (Math.hypot(it.x - this.px, it.y - this.py) < 0.8) {
        this.items.splice(this.items.indexOf(it), 1);
        if (it.kind === "+") {
          this.hp = Math.min(100, this.hp + 30);
          this.msg = "Med kit: +30 HP";
        } else {
          this.ammo += 8;
          this.msg = "Ammo: +8";
        }
      }
    }
    for (const e of this.enemies) {
      const d = Math.hypot(e.x - this.px, e.y - this.py);
      if (d < 1.1) {
        if (this.rng.random() < 0.6) {
          const dmg = this.rng.randint(6, 14);
          this.hp -= dmg;
          this.msg = `A skimmer zaps you for ${dmg}!`;
        }
      } else if (d < 7 && this.lineOfSight(e.x, e.y, this.px, this.py)) {
        const sx = ((this.px - e.x) / d) * 0.45;
        const sy = ((this.py - e.y) / d) * 0.45;
        if (!this.wall(e.x + sx, e.y) && !this.wall(e.x + sx, e.y + sy)) {
          e.x += sx;
          e.y += sy;
        }
      }
    }
  }

  /** Apply one key. Returns false when the player quits. */
  press(key: string): boolean {
    this.msg = "";
    if (key === "C") this.angle -= TURN;
    else if (key === "N") this.angle += TURN;
    else if (key === "P") this.move(STEP);
    else if (key === "Y") this.move(-STEP);
    else if (key === "\r") this.fire();
    else if (key === "\x1b") return false;
    this.turns += 1;
    this.worldTurn();
    return true;
  }

  get over(): boolean {
    return this.hp <= 0 || this.enemies.length === 0;
  }
}

export const TITLE: readonly string[] = [
  "                                      ",
  "   ___ _  _____ __  __ __  __ ___ ___ ",
  "  / __| |/ /_ _|  \\/  |  \\/  | __| _ \\",
  "  \\__ \\ ' < | || |\\/| | |\\/| | _||   /",
  "  |___/_|\\_\\___|_|  |_|_|  |_|___|_|_\\",
  "            H  U  N  T                ",
  "  F1 left  F2 fwd  F3 back  F4 right  ",
  "     GREEN = zap     RED = quit       ",
];

export function endScreen(g: Game): string[] {
  const won = g.hp > 0;
  const lines = [
    "",
    won ? "      *** LANE CLEARED! ***" : "      *** LANE CLOSED ***",
    "",
    `   Skimmers zapped: ${g.total - g.enemies.length}/${g.total}`,
    `   Turns taken:     ${g.turns}`,
    `   HP left:         ${Math.max(0, g.hp)}`,
    "",
    "   GREEN = play again   RED = quit",
  ];
  return lines.map((l) => l.padEnd(38).slice(0, 38));
}

/** Frame a row to 38 columns; the display may trim leading spaces, so frame the row instead. */
export function displayRow(row: string): string {
  let r = row.padEnd(38).slice(0, 38);
  if (r.startsWith(" ")) r = "|" + r.slice(1, -1) + "|";
  return r;
}

async function play(): Promise<void> {
  await withLane(async (lane) => {
    const show = (rows: readonly string[], header: string): Promise<string> =>
      showRows(lane, rows.map(displayRow), header, true);
    try {
      if ((await show(TITLE, "SKIMMER HUNT - press GREEN to start")) === "\x1b") return;
      for (;;) {
        const g = new Game();
        while (!g.over) {
          const frame = g.render();
          console.log(frame.join("\n") + "\n" + g.hud());
          if (!g.press(await show(frame, g.hud()))) return;
        }
        if ((await show(endScreen(g), "GAME OVER")) === "\x1b") return;
      }
    } finally {
      await lane.softReset();
    }
  });
}

export function preview(): string {
  const out: string[] = [TITLE.join("\n")];
  const g = new Game();
  for (const key of ["", "P", "P", "N", "N", "P", "P", "P", "\r"]) {
    if (key !== "") g.press(key);
    out.push(`--- after ${pyRepr(key)}: ${g.hud()}`);
    out.push(g.render().join("\n"));
  }
  return out.join("\n");
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes("--preview")) {
    console.log(preview());
    return 0;
  }
  await play();
  return 0;
}
