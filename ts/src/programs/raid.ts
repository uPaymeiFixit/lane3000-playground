/**
 * SKIMMER RAID: a first-person raycast shooter for an Ingenico Lane/3000, drawn as full-screen
 * images on the Mac and pushed to the terminal's GAME.K3Z layout (`game-screen --install` once).
 */

import { savePng } from "../gfx/encode.js";
import { Raster, type Rgb } from "../gfx/raster.js";
import { font } from "../gfx/text.js";
import type { GameKey } from "../protocol/messages.js";
import { withLane } from "../protocol/serial.js";
import { PyRandom, type Rng } from "../util/py-random.js";
import { GameScreen, textScreen } from "./game-screen.js";

export const USAGE = `SKIMMER RAID - a first-person shooter for an Ingenico Lane/3000.
Needs the full-screen layout once: \`bun run game-screen --install\`.

Keys:  F1 turn left   F4 turn right   UP forward   DOWN back
       GREEN fire     YELLOW turn around   RED quit

    bun run raid               # play on the terminal
    bun run raid --preview     # save a sample frame to preview.png`;

export const W = 320;
export const H = 240;
export const VIEW_H = 200; // 3D view; a 40 px status bar below it
const FOV = (66 * Math.PI) / 180;
const PLANE = Math.tan(FOV / 2);
const TURN = Math.PI / 6;
const STEP = 0.55;
const RADIUS = 0.22;
/** Milliseconds per world tick; the terminal draws ~3-4 frames per second. */
export const TICK_MS = 350;

/** 1-3 = wall textures, . = floor, P = start (facing east), S = skimmer, + = med kit, a = ammo. */
export const MAP: readonly string[] = [
  "1111111111111111",
  "1P.....2.......1",
  "1......2...a...1",
  "1.11...2...22..1",
  "1.1....2....2..1",
  "1.1..S......2S.1",
  "1.1111..3...2..1",
  "1......33......1",
  "1..+...3...S...1",
  "1...........3331",
  "122222..S......1",
  "1......2222....1",
  "1.S....2..+..S.1",
  "1..a...2.......1",
  "1......2...S...1",
  "1111111111111111",
];

export interface Enemy {
  x: number;
  y: number;
  hp: number;
  cooldown: number;
  hurt: number;
}

export interface Item {
  readonly x: number;
  readonly y: number;
  readonly kind: "med" | "ammo";
}

interface Hit {
  readonly dist: number;
  readonly side: 0 | 1;
  readonly u: number;
  readonly type: number;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function shade(c: Rgb, f: number): Rgb {
  return [clamp255(c[0] * f), clamp255(c[1] * f), clamp255(c[2] * f)];
}

const WALL_BASE: Readonly<Record<number, Rgb>> = { 1: [150, 70, 50], 2: [70, 90, 150], 3: [60, 130, 80] };
const MORTAR: Rgb = [60, 55, 50];

/** Procedural wall textures: 1 brick, 2 metal panels, 3 tiles. u, v in [0, 1). */
function wallTexel(type: number, u: number, v: number): Rgb {
  const base = WALL_BASE[type] ?? [128, 128, 128];
  if (type === 1) {
    const row = Math.floor(v * 6);
    const off = row % 2 === 0 ? 0 : 0.5;
    const bu = (u * 2 + off) % 1;
    if (v * 6 - row < 0.1 || bu < 0.05) return MORTAR;
    return shade(base, 0.85 + 0.15 * Math.sin(row * 7.3 + Math.floor(u * 2 + off) * 3.1));
  }
  if (type === 2) {
    if (u % 0.5 < 0.04 || v % 0.25 < 0.03) return shade(base, 0.55);
    if (Math.abs(u % 0.5 - 0.25) < 0.02 && Math.abs(v % 0.25 - 0.125) < 0.02) return [200, 210, 230]; // rivets
    return shade(base, 0.9 + 0.1 * (1 - v));
  }
  if (u % 0.25 < 0.035 || v % 0.25 < 0.035) return [40, 70, 45];
  return shade(base, 1.05 - 0.15 * ((Math.floor(u * 4) + Math.floor(v * 4)) % 2));
}

/** Skimmer creature: a card-reader body with a glowing slot, eyes, arms and legs. Null = clear. */
function skimmerTexel(u: number, v: number, hurt: boolean): Rgb | null {
  const body: Rgb = hurt ? [255, 255, 255] : [90, 95, 105];
  if (u > 0.22 && u < 0.78 && v > 0.12 && v < 0.78) {
    if ((u - 0.38) ** 2 + (v - 0.27) ** 2 < 0.006 || (u - 0.62) ** 2 + (v - 0.27) ** 2 < 0.006) {
      return [255, 230, 60]; // eyes
    }
    if (v > 0.42 && v < 0.48 && u > 0.3 && u < 0.7) return [255, 40, 40]; // card slot
    if (v > 0.56 && v < 0.7 && u > 0.32 && u < 0.68) return [30, 200, 255]; // little screen
    const edge = u < 0.25 || u > 0.75 || v < 0.15 || v > 0.75;
    return edge ? shade(body, 0.6) : body;
  }
  if (v > 0.35 && v < 0.42 && (u > 0.06 && u < 0.22 || u > 0.78 && u < 0.94)) return shade(body, 0.75); // arms
  if (v >= 0.78 && v < 0.98 && (Math.abs(u - 0.35) < 0.04 || Math.abs(u - 0.65) < 0.04)) return shade(body, 0.7); // legs
  return null;
}

function itemTexel(kind: Item["kind"], u: number, v: number): Rgb | null {
  if (u < 0.15 || u > 0.85 || v < 0.3 || v > 0.95) return null;
  if (kind === "med") {
    const cross = (Math.abs(u - 0.5) < 0.08 && v > 0.45 && v < 0.85) || (Math.abs(v - 0.65) < 0.08 && u > 0.3 && u < 0.7);
    return cross ? [220, 30, 30] : [235, 235, 235];
  }
  return Math.floor(u * 6) % 2 === 0 ? [230, 190, 40] : [150, 120, 20];
}

export class Raid {
  readonly walls: number[][];
  px = 1.5;
  py = 1.5;
  angle = 0;
  hp = 100;
  ammo = 24;
  kills = 0;
  readonly enemies: Enemy[] = [];
  readonly items: Item[] = [];
  readonly total: number;
  msg = "Clear the lane of skimmers";
  flash = 0;
  hurt = 0;
  ticks = 0;

  constructor(private readonly rng: Rng) {
    this.walls = MAP.map((row, y) =>
      Array.from({ length: row.length }, (_, x) => row.charAt(x)).map((c, x) => {
        if (c === "P") {
          this.px = x + 0.5;
          this.py = y + 0.5;
        } else if (c === "S") {
          this.enemies.push({ x: x + 0.5, y: y + 0.5, hp: 2, cooldown: 0, hurt: 0 });
        } else if (c === "+" || c === "a") {
          this.items.push({ x: x + 0.5, y: y + 0.5, kind: c === "+" ? "med" : "ammo" });
        }
        return c >= "1" && c <= "9" ? Number(c) : 0;
      }),
    );
    this.total = this.enemies.length;
  }

  get won(): boolean {
    return this.enemies.length === 0;
  }

  get lost(): boolean {
    return this.hp <= 0;
  }

  wallAt(x: number, y: number): number {
    return this.walls[Math.floor(y)]?.[Math.floor(x)] ?? 1;
  }

  /** DDA raycast from the player. `dist` is Euclidean distance along the ray. */
  cast(rayAngle: number): Hit {
    const dx = Math.cos(rayAngle);
    const dy = Math.sin(rayAngle);
    let mx = Math.floor(this.px);
    let my = Math.floor(this.py);
    const ddx = dx === 0 ? 1e9 : Math.abs(1 / dx);
    const ddy = dy === 0 ? 1e9 : Math.abs(1 / dy);
    const stepX = dx < 0 ? -1 : 1;
    const stepY = dy < 0 ? -1 : 1;
    let sdx = dx < 0 ? (this.px - mx) * ddx : (mx + 1 - this.px) * ddx;
    let sdy = dy < 0 ? (this.py - my) * ddy : (my + 1 - this.py) * ddy;
    for (let i = 0; i < 64; i++) {
      let side: 0 | 1;
      if (sdx < sdy) {
        sdx += ddx;
        mx += stepX;
        side = 0;
      } else {
        sdy += ddy;
        my += stepY;
        side = 1;
      }
      const type = this.walls[my]?.[mx] ?? 1;
      if (type > 0) {
        const dist = side === 0 ? sdx - ddx : sdy - ddy;
        const along = side === 0 ? this.py + dist * dy : this.px + dist * dx;
        return { dist, side, u: along - Math.floor(along), type };
      }
    }
    return { dist: 30, side: 0, u: 0, type: 1 };
  }

  lineOfSight(x0: number, y0: number, x1: number, y1: number): boolean {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(d * 8));
    for (let i = 1; i < n; i++) {
      if (this.wallAt(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n) > 0) return false;
    }
    return true;
  }

  /** Distance and bearing (radians, -pi..pi, 0 = straight ahead) of a point. */
  relative(x: number, y: number): { dist: number; bearing: number } {
    const a = Math.atan2(y - this.py, x - this.px) - this.angle;
    return { dist: Math.hypot(x - this.px, y - this.py), bearing: Math.atan2(Math.sin(a), Math.cos(a)) };
  }

  private move(dist: number): void {
    const nx = this.px + Math.cos(this.angle) * dist;
    const ny = this.py + Math.sin(this.angle) * dist;
    if (this.wallAt(nx + Math.sign(nx - this.px) * RADIUS, this.py) === 0) this.px = nx;
    if (this.wallAt(this.px, ny + Math.sign(ny - this.py) * RADIUS) === 0) this.py = ny;
  }

  private fire(): void {
    if (this.ammo <= 0) {
      this.msg = "Click. Out of ammo!";
      return;
    }
    this.ammo--;
    this.flash = 1;
    let target: Enemy | null = null;
    let best = Infinity;
    for (const e of this.enemies) {
      const { dist, bearing } = this.relative(e.x, e.y);
      if (Math.abs(bearing) < Math.atan2(0.35, dist) + 0.03 && dist < best && this.lineOfSight(this.px, this.py, e.x, e.y)) {
        target = e;
        best = dist;
      }
    }
    if (target === null) {
      this.msg = "Missed";
      return;
    }
    target.hp--;
    target.hurt = 1;
    if (target.hp <= 0) {
      this.enemies.splice(this.enemies.indexOf(target), 1);
      this.kills++;
      this.msg = this.won ? "Lane cleared!" : "Skimmer destroyed!";
    } else {
      this.msg = "Hit!";
    }
  }

  /** Apply one key press. */
  press(key: GameKey): void {
    switch (key) {
      case "L":
        this.angle -= TURN;
        break;
      case "R":
        this.angle += TURN;
        break;
      case "U":
        this.move(STEP);
        break;
      case "D":
        this.move(-STEP);
        break;
      case "\r":
        this.fire();
        break;
      case "\b":
        this.angle += Math.PI;
        break;
      case "\x1b":
        break;
      default: {
        const unreachable: never = key;
        throw new Error(`unhandled key ${String(unreachable)}`);
      }
    }
  }

  /** One world tick: pickups, then every skimmer chases or attacks. */
  tick(): void {
    this.ticks++;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it === undefined || Math.hypot(it.x - this.px, it.y - this.py) > 0.6) continue;
      this.items.splice(i, 1);
      if (it.kind === "med") {
        this.hp = Math.min(100, this.hp + 30);
        this.msg = "Med kit +30";
      } else {
        this.ammo += 10;
        this.msg = "Ammo +10";
      }
    }
    for (const e of this.enemies) {
      e.hurt = Math.max(0, e.hurt - 1);
      e.cooldown = Math.max(0, e.cooldown - 1);
      const d = Math.hypot(this.px - e.x, this.py - e.y);
      if (d < 1.0) {
        if (e.cooldown === 0) {
          const dmg = this.rng.randint(6, 12);
          this.hp -= dmg;
          this.hurt = 1;
          e.cooldown = 3;
          this.msg = `Skimmed! -${dmg}`;
        }
      } else if (d < 8 && this.lineOfSight(e.x, e.y, this.px, this.py)) {
        const sx = ((this.px - e.x) / d) * 0.18;
        const sy = ((this.py - e.y) / d) * 0.18;
        if (this.wallAt(e.x + sx, e.y) === 0) e.x += sx;
        if (this.wallAt(e.x, e.y + sy) === 0) e.y += sy;
      }
    }
  }

  render(): Raster {
    const img = new Raster(W, H);
    const data = img.data;
    const zbuf = new Float64Array(W);
    const half = VIEW_H / 2;
    for (let x = 0; x < W; x++) {
      const camera = (2 * x) / (W - 1) - 1;
      const rayAngle = this.angle + Math.atan(camera * PLANE);
      const hit = this.cast(rayAngle);
      const perp = Math.max(0.05, hit.dist * Math.cos(rayAngle - this.angle));
      zbuf[x] = perp;
      const lineH = (VIEW_H * 0.95) / perp;
      const top = Math.floor(half - lineH / 2);
      const bottom = Math.ceil(half + lineH / 2);
      const fog = Math.max(0.18, 1 - perp / 11) * (hit.side === 1 ? 0.78 : 1);
      for (let y = 0; y < VIEW_H; y++) {
        let c: Rgb;
        if (y < top) {
          const t = y / half;
          c = [18 + 22 * t, 18 + 20 * t, 30 + 26 * t]; // ceiling
        } else if (y >= bottom) {
          const t = (y - half) / half;
          c = [40 + 60 * t, 34 + 44 * t, 28 + 30 * t]; // floor
        } else {
          c = shade(wallTexel(hit.type, hit.u, (y - (half - lineH / 2)) / lineH), fog);
        }
        const i = (y * W + x) * 3;
        data[i] = clamp255(c[0]);
        data[i + 1] = clamp255(c[1]);
        data[i + 2] = clamp255(c[2]);
      }
    }
    this.drawSprites(img, zbuf);
    this.drawGun(img);
    if (this.hurt > 0) {
      for (let y = 0; y < VIEW_H; y++) for (let x = 0; x < W; x++) img.blend(x, y, [255, 0, 0], 80);
    }
    this.drawHud(img);
    return img;
  }

  private drawSprites(img: Raster, zbuf: Float64Array): void {
    const sprites: Sprite[] = [
      ...this.enemies.map((e) => ({
        x: e.x, y: e.y, dist: 0, scale: 0.8, floor: false,
        draw: (u: number, v: number) => skimmerTexel(u, v, e.hurt > 0),
      })),
      ...this.items.map((it) => ({
        x: it.x, y: it.y, dist: 0, scale: 0.35, floor: true,
        draw: (u: number, v: number) => itemTexel(it.kind, u, v),
      })),
    ];
    for (const s of sprites) s.dist = Math.hypot(s.x - this.px, s.y - this.py);
    sprites.sort((a, b) => b.dist - a.dist);
    const half = VIEW_H / 2;
    for (const s of sprites) {
      const { dist, bearing } = this.relative(s.x, s.y);
      if (Math.abs(bearing) > FOV / 2 + 0.4 || dist < 0.2) continue;
      const perp = dist * Math.cos(bearing);
      if (perp < 0.15) continue;
      const cx = W / 2 + (Math.tan(bearing) / PLANE) * (W / 2);
      const size = (VIEW_H * 0.95 * s.scale) / perp;
      const floorY = half + (VIEW_H * 0.95) / perp / 2;
      const top = s.floor ? floorY - size : half - size / 2 + size * 0.08;
      const left = cx - size / 2;
      const fog = Math.max(0.25, 1 - perp / 11);
      for (let x = Math.max(0, Math.floor(left)); x < Math.min(W, Math.ceil(left + size)); x++) {
        if (perp >= (zbuf[x] ?? 0)) continue;
        const u = (x - left) / size;
        for (let y = Math.max(0, Math.floor(top)); y < Math.min(VIEW_H, Math.ceil(top + size)); y++) {
          const c = s.draw(u, (y - top) / size);
          if (c !== null) img.set(x, y, shade(c, fog));
        }
      }
    }
  }

  private drawGun(img: Raster): void {
    const cx = W / 2;
    img.convexPolygon([[cx - 30, VIEW_H], [cx - 16, VIEW_H - 46], [cx + 16, VIEW_H - 46], [cx + 30, VIEW_H]], [60, 62, 70]);
    img.rectangle([cx - 7, VIEW_H - 70, cx + 7, VIEW_H - 44], { fill: [95, 98, 110] });
    img.rectangle([cx - 7, VIEW_H - 70, cx + 7, VIEW_H - 67], { fill: [140, 145, 160] });
    if (this.flash > 0) {
      img.ellipse([cx - 13, VIEW_H - 90, cx + 13, VIEW_H - 66], [255, 170, 40]);
      img.ellipse([cx - 6, VIEW_H - 84, cx + 6, VIEW_H - 72], [255, 245, 170]);
    }
    img.line([cx - 5, half(img)], [cx + 5, half(img)], [230, 230, 230]);
    img.line([cx, half(img) - 5], [cx, half(img) + 5], [230, 230, 230]);
  }

  private drawHud(img: Raster): void {
    img.rectangle([0, VIEW_H, W - 1, H - 1], { fill: [10, 10, 14] });
    img.line([0, VIEW_H], [W - 1, VIEW_H], [70, 70, 90]);
    const hpColor: Rgb = this.hp > 50 ? [120, 230, 120] : this.hp > 25 ? [255, 200, 60] : [255, 80, 80];
    img.text([8, VIEW_H + 4], `HP ${Math.max(0, this.hp)}`, font(15), hpColor);
    img.text([100, VIEW_H + 4], `AMMO ${this.ammo}`, font(15), [255, 220, 0]);
    img.text([312, VIEW_H + 4], `SKIMMERS ${this.kills}/${this.total}`, font(15), [220, 220, 230], "ra");
    img.text([W / 2, VIEW_H + 29], this.msg, font(12), [170, 170, 190], "mm");
  }
}

interface Sprite {
  x: number;
  y: number;
  dist: number;
  draw: (u: number, v: number) => Rgb | null;
  scale: number;
  floor: boolean;
}

function half(img: Raster): number {
  return Math.min(VIEW_H, img.height) / 2;
}

function titleScreen(): Raster {
  return textScreen(["SKIMMER RAID", "F1/F4 turn   UP/DOWN move", "GREEN fire   YELLOW about-face", "GREEN start   RED quit"]);
}

function endScreen(g: Raid): Raster {
  return g.won
    ? textScreen(["LANE CLEARED", `skimmers ${g.kills}/${g.total}   hp ${g.hp}`, "GREEN again   RED quit"], [0, 40, 0])
    : textScreen(["YOU GOT SKIMMED", `skimmers ${g.kills}/${g.total}`, "GREEN again   RED quit"], [60, 0, 0]);
}

async function waitFor(gs: GameScreen, wanted: readonly GameKey[]): Promise<GameKey> {
  for (;;) {
    for (const k of await gs.keys(3_600_000)) if (wanted.includes(k)) return k;
  }
}

async function play(): Promise<void> {
  await withLane(async (lane) => {
    const gs = new GameScreen(lane);
    try {
      await gs.push(titleScreen());
      if ((await waitFor(gs, ["\r", "\x1b"])) === "\x1b") return;
      for (;;) {
        const g = new Raid(new PyRandom());
        while (!g.won && !g.lost) {
          const t0 = Date.now();
          await gs.push(g.render());
          g.flash = 0;
          g.hurt = 0;
          const keys = await gs.keys(Math.max(50, TICK_MS - (Date.now() - t0)));
          for (const k of keys) {
            if (k === "\x1b") return;
            g.press(k);
          }
          g.tick();
        }
        await gs.push(g.render());
        await gs.push(endScreen(g));
        console.log(g.won ? `cleared in ${g.ticks} ticks` : `skimmed with ${g.kills}/${g.total}`);
        if ((await waitFor(gs, ["\r", "\x1b"])) === "\x1b") return;
      }
    } finally {
      await lane.stopAction();
      await lane.softReset();
    }
  });
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes("--preview")) {
    const g = new Raid(new PyRandom(3));
    for (const k of ["U", "U", "R", "U", "U", "U", "L"] as const) {
      g.press(k);
      g.tick();
    }
    g.press("\r");
    await savePng(g.render(), "preview.png");
    console.log(`wrote preview.png (hp ${g.hp}, ammo ${g.ammo}, ${g.enemies.length} skimmers left)`);
    return 0;
  }
  await play();
  return 0;
}
