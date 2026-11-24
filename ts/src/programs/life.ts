/**
 * Conway's Game of Life on an Ingenico Lane/3000, with the card readers as controls.
 *
 * Four-colour Life ("Quad-Life"): a cell is born from exactly 3 neighbours and takes the colour
 * most of those parents share; if all three differ it takes the fourth colour. Colours compete.
 *
 * Card actions work while PAUSED: the board freezes, the readers arm (23.x), and a swipe, tap or
 * insert applies its effect and resumes the game. While running, only the keys are live (24.x):
 * cancelling an armed card read costs ~0.5 s per frame and flashes the contactless LEDs.
 *
 * Card data is discarded in the receive layer: only the exit type and reader letter of each
 * 23.x reply ever reach this module.
 */

import { framePng, savePng } from "../gfx/encode.js";
import { Raster, type Rgb } from "../gfx/raster.js";
import { font } from "../gfx/text.js";
import type { Lane } from "../protocol/lane.js";
import {
  cardEventForReader,
  describeCardReply,
  isGameKey,
  type CardEvent,
  type CardReply,
  type GameKey,
} from "../protocol/messages.js";
import { withLane } from "../protocol/serial.js";
import { PyRandom, type Rng } from "../util/py-random.js";
import { chars } from "../util/py-repr.js";
import { GameScreen } from "./game-screen.js";

export const USAGE = `Conway's Game of Life on an Ingenico Lane/3000, with the card readers as controls.

Four-colour Life ("Quad-Life"): a cell is born from exactly 3 neighbours and takes the colour
most of those parents share; if all three differ it takes the fourth colour. Colours compete.

    swipe a card   -> a Gosper glider gun (orange) starts firing from the left edge
    tap a card     -> a random splash of life (green) lands somewhere
    insert a chip  -> a mirror-symmetric kaleidoscope burst (magenta) in the middle
                      (chip insert is unreliable on this terminal: see README)

Card actions work while PAUSED (GREEN): the board freezes, the readers arm, and a swipe, tap
or insert applies its effect and resumes the game. While running, only the keys are live:
cancelling an armed card read costs ~0.5 s per frame and flashes the contactless LEDs.

Keys: GREEN pause/resume   YELLOW clear   UP reseed   DOWN single step (while paused)
      F1 slower   F4 faster   RED quit

Card data is discarded: only the exit type and reader letter of each 23.x reply are used.

    bun run life                  # play on the terminal (needs \`game-screen --install\` once)
    bun run life --preview     # save a sample frame to preview.png`;

/** 40*8 = 320 wide, 24 + 27*8 = 240 tall. */
export const COLS = 40;
export const ROWS = 27;
export const CELL = 8;
export const TOP = 24;
/** Seconds per generation. */
export const SPEEDS = [1.2, 0.8, 0.5, 0.35] as const;

export const CYAN = 0;
export const ORANGE = 1;
export const GREEN = 2;
export const MAGENTA = 3;
export type Colour = typeof CYAN | typeof ORANGE | typeof GREEN | typeof MAGENTA;
const ALL_COLOURS: readonly Colour[] = [CYAN, ORANGE, GREEN, MAGENTA];

export const COLORS: Readonly<Record<Colour, Rgb>> = {
  [CYAN]: [80, 220, 255],
  [ORANGE]: [255, 150, 40],
  [GREEN]: [140, 255, 90],
  [MAGENTA]: [255, 80, 220],
};
const BG: Rgb = [8, 10, 22];
const YELLOW: Rgb = [255, 220, 0];

export const GOSPER_GUN: readonly (readonly [number, number])[] = [
  [0, 4], [0, 5], [1, 4], [1, 5], [10, 4], [10, 5], [10, 6], [11, 3], [11, 7], [12, 2],
  [12, 8], [13, 2], [13, 8], [14, 5], [15, 3], [15, 7], [16, 4], [16, 5], [16, 6], [17, 5],
  [20, 2], [20, 3], [20, 4], [21, 2], [21, 3], [21, 4], [22, 1], [22, 5], [24, 0], [24, 1],
  [24, 5], [24, 6], [34, 2], [34, 3], [35, 2], [35, 3],
];

/** Board key for (x, y), both in range. */
const keyOf = (x: number, y: number): number => y * COLS + x;
const xyOf = (k: number): readonly [number, number] => [k % COLS, Math.floor(k / COLS)];

/** Colour of a newborn cell from its three parents (Quad-Life rule). */
export function birthColor(parents: readonly Colour[]): Colour {
  const counts = new Map<Colour, number>();
  for (const c of parents) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: Colour | null = null;
  let bestCount = 0;
  for (const c of ALL_COLOURS) {
    const n = counts.get(c) ?? 0;
    if (n > bestCount) {
      best = c;
      bestCount = n;
    }
  }
  if (best !== null && bestCount >= 2) return best;
  // three different colours -> the fourth
  return ALL_COLOURS.find((c) => !counts.has(c)) ?? CYAN;
}

export class Life {
  /** Live cells: board key -> colour (insertion order like the Python dict). */
  cells = new Map<number, Colour>();
  /** Generations each live cell has been alive. */
  age = new Map<number, number>();
  gen = 0;

  constructor(private readonly rng: Rng = new PyRandom()) {
    this.seed(CYAN, 0.22);
  }

  put(x: number, y: number, color: Colour): void {
    if (x >= 0 && x < COLS && y >= 0 && y < ROWS) {
      this.cells.set(keyOf(x, y), color);
      this.age.set(keyOf(x, y), 0);
    }
  }

  has(x: number, y: number): boolean {
    return x >= 0 && x < COLS && y >= 0 && y < ROWS && this.cells.has(keyOf(x, y));
  }

  seed(color: Colour, density: number): void {
    for (let x = 0; x < COLS; x++) {
      for (let y = 0; y < ROWS; y++) if (this.rng.random() < density) this.put(x, y, color);
    }
  }

  clear(): void {
    this.cells.clear();
    this.age.clear();
  }

  // --- card actions ------------------------------------------------------------------

  gliderGun(): void {
    const oy = this.rng.randint(0, ROWS - 9);
    for (const [x, y] of GOSPER_GUN) this.put(1 + x, oy + y, ORANGE);
  }

  splash(): void {
    const cx = this.rng.randint(4, COLS - 5);
    const cy = this.rng.randint(4, ROWS - 5);
    const r = 5;
    for (let x = cx - r; x <= cx + r; x++) {
      for (let y = cy - r; y <= cy + r; y++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r && this.rng.random() < 0.45) this.put(x, y, GREEN);
      }
    }
  }

  kaleidoscope(): void {
    const cx = Math.floor(COLS / 2);
    const cy = Math.floor(ROWS / 2);
    const halfW = 7;
    const halfH = 5;
    for (let dx = 0; dx < halfW; dx++) {
      for (let dy = 0; dy < halfH; dy++) {
        if (this.rng.random() < 0.4) {
          for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
              this.put(cx + sx * dx - (sx < 0 ? 1 : 0), cy + sy * dy - (sy < 0 ? 1 : 0), MAGENTA);
            }
          }
        }
      }
    }
  }

  // --- rules -------------------------------------------------------------------------

  step(): void {
    const counts = new Map<number, Colour[]>();
    for (const [k, c] of this.cells) {
      const [x, y] = xyOf(k);
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < COLS && ny >= 0 && ny < ROWS) {
            // dead edges: gliders fly off
            const nk = keyOf(nx, ny);
            const list = counts.get(nk);
            if (list === undefined) counts.set(nk, [c]);
            else list.push(c);
          }
        }
      }
    }
    const next = new Map<number, Colour>();
    const age = new Map<number, number>();
    for (const [pos, parents] of counts) {
      const alive = this.cells.get(pos);
      if (alive !== undefined && (parents.length === 2 || parents.length === 3)) {
        next.set(pos, alive);
        age.set(pos, (this.age.get(pos) ?? 0) + 1);
      } else if (alive === undefined && parents.length === 3) {
        next.set(pos, birthColor(parents));
        age.set(pos, 0);
      }
    }
    this.cells = next;
    this.age = age;
    this.gen += 1;
  }

  render(status: string, toast = ""): Raster {
    const img = new Raster(320, 240, BG);
    for (const [k, c] of this.cells) {
      const [x, y] = xyOf(k);
      const fade = Math.max(0.45, 1 - (this.age.get(k) ?? 0) * 0.05);
      const base = COLORS[c];
      const rgb: Rgb = [Math.trunc(base[0] * fade), Math.trunc(base[1] * fade), Math.trunc(base[2] * fade)];
      const x0 = x * CELL;
      const y0 = TOP + y * CELL;
      img.rectangle([x0, y0, x0 + CELL - 2, y0 + CELL - 2], { fill: rgb });
    }
    img.rectangle([0, 0, 319, TOP - 1], { fill: [0, 0, 0] });
    img.text([6, TOP / 2], `GEN ${this.gen}  POP ${this.cells.size}`, font(13), [220, 220, 230], "lm");
    if (toast !== "") img.text([314, TOP / 2], toast, font(13), YELLOW, "rm");
    else if (status !== "") img.text([314, TOP / 2], status, font(12), [140, 140, 160], "rm");
    return img;
  }
}

export function titleScreen(): Raster {
  const img = new Raster(320, 240, BG);
  img.text([160, 26], "GAME OF LIFE", font(26), YELLOW, "mm");
  const lines: readonly (readonly [string, string, Rgb])[] = [
    ["SWIPE", "glider gun", COLORS[ORANGE]],
    ["TAP", "life splash", COLORS[GREEN]],
    ["INSERT", "kaleidoscope", COLORS[MAGENTA]],
  ];
  lines.forEach(([what, does, col], i) => {
    const y = 66 + i * 26;
    img.rectangle([40, y - 7, 54, y + 7], { fill: col });
    img.text([64, y], what, font(15), col, "lm");
    img.text([150, y], does, font(15), [220, 220, 230], "lm");
  });
  const keys = ["GREEN pause   YELLOW clear   RED quit", "UP reseed   DOWN step   F1/F4 speed"];
  keys.forEach((k, i) => {
    img.text([160, 168 + i * 20], k, font(12), [160, 160, 180], "mm");
  });
  img.text([160, 222], "GREEN start - pause to use cards", font(15), [255, 255, 255], "mm");
  return img;
}

// --- terminal I/O --------------------------------------------------------------------------
// Cancelling an armed card read costs ~0.5 s and re-arming lights the contactless LEDs, so the
// readers are only armed while the game is paused. Running frames use 24.x (keys only).

export const CARD_HINT = "swipe / tap / insert  -  GREEN resume";
/** A chip insert can swallow the read without replying; re-arm after this many ms. */
export const REARM_EVERY_MS = 15_000;
/** After a chip insert, a 23.1/23.N within this window means the card was pulled, not a tap. */
export const INSERT_WINDOW_MS = 8_000;

export function pausedFrame(life: Life): Raster {
  const img = life.render("PAUSED");
  img.rectangle([20, 104, 300, 152], { fill: [0, 0, 0], outline: YELLOW });
  img.text([160, 118], "PAUSED", font(16), YELLOW, "mm");
  img.text([160, 138], CARD_HINT, font(12), [220, 220, 230], "mm");
  return img;
}

/** Show img and arm all three readers (keys still arrive, as 23.3<key>). */
async function armCards(lane: Lane, img: Raster): Promise<void> {
  await lane.send("15.6"); // end any earlier read, lift upload lock
  lane.retainInbox((m) => m.id === "23");
  await lane.writeFile("GAME.PNG", await framePng(img));
  await lane.send("23.\x1cGAME.K3Z\x1c\x1cMSC");
}

/** What a 23.x reply means to the game. */
export type LifeInput = { readonly kind: "card"; readonly card: CardEvent } | { readonly kind: "key"; readonly key: GameKey };

/**
 * Turn a classified 23.x reply into a game input.
 * - 23.0<reader>: M = swipe, S/Q = insert, anything else = tap
 * - 23.3<key>: a key pressed while armed; 23.2: red cancelled the read
 * - 23.1 (bad read) / 23.N (card left early): a tap, except within 8 s of a chip insert, where it
 *   means the chip card was pulled out
 * - anything else (9 = busy with a card in the slot, ...): nothing
 */
export function classify(card: CardReply, lastInsertMs: number, nowMs: number): LifeInput | null {
  switch (card.exit) {
    case "0":
      return { kind: "card", card: cardEventForReader(card.letter) };
    case "3": {
      const key = chars(card.keyField).find(isGameKey);
      return key === undefined ? null : { kind: "key", key };
    }
    case "2":
      return { kind: "key", key: "\x1b" }; // red cancels the read
    case "1":
    case "N":
      return nowMs - lastInsertMs < INSERT_WINDOW_MS ? null : { kind: "card", card: "tap" };
    case "6":
    case "7":
    case "9":
    case "A":
    case "R":
    case "other":
      return null;
    default: {
      const unreachable: never = card;
      return unreachable;
    }
  }
}

export function applyCard(life: Life, event: CardEvent): string {
  switch (event) {
    case "swipe":
      life.gliderGun();
      return "SWIPE: glider gun!";
    case "tap":
      life.splash();
      return "TAP: splash!";
    case "insert":
      life.kaleidoscope();
      return "INSERT: kaleidoscope!";
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** Keys shared by both modes. Returns a toast or "". */
export function applyKey(life: Life, key: GameKey, running: boolean): string {
  if (key === "\b") {
    life.clear();
    return "cleared";
  }
  if (key === "U") {
    life.seed(CYAN, 0.22);
    return "reseeded";
  }
  if (key === "D" && !running) life.step();
  return "";
}

interface PauseResult {
  readonly action: "resume" | "quit";
  readonly toast: string;
  readonly lastInsertMs: number;
}

/** Freeze the board with the readers armed until a card, GREEN or RED. */
async function pause(lane: Lane, life: Life, lastInsertMs: number): Promise<PauseResult> {
  await armCards(lane, pausedFrame(life));
  let armedAt = Date.now();
  for (;;) {
    const r = await lane.recv("23", 1000);
    if (r === null) {
      if (Date.now() - armedAt > REARM_EVERY_MS) {
        await armCards(lane, pausedFrame(life));
        armedAt = Date.now();
      }
      continue;
    }
    if (r.card.exit !== "0" && r.card.exit !== "1" && r.card.exit !== "N") {
      console.log("23 reply:", describeCardReply(r.card)); // key/status replies carry no card data
    }
    const event = classify(r.card, lastInsertMs, Date.now());
    if (event?.kind === "card") {
      if (event.card === "insert") lastInsertMs = Date.now();
      await lane.send("15.6");
      await lane.send("51.21"); // high short beep
      console.log(event.card);
      return { action: "resume", toast: applyCard(life, event.card), lastInsertMs };
    }
    if (event?.kind === "key") {
      if (event.key === "\x1b") return { action: "quit", toast: "", lastInsertMs };
      if (event.key === "\r") {
        await lane.send("15.6");
        return { action: "resume", toast: "", lastInsertMs };
      }
      applyKey(life, event.key, false);
    }
    await armCards(lane, pausedFrame(life)); // redraw (and re-arm) after a key
    armedAt = Date.now();
  }
}

async function play(): Promise<void> {
  await withLane(async (lane) => {
    const gs = new GameScreen(lane);
    await lane.send("15.6");
    await lane.softReset();
    await lane.request("28.100004121", 3000); // contactless on until reboot
    const life = new Life();
    let speed = 2;
    let lastInsertMs = 0;
    let toast = "";
    let toastUntil = 0;
    try {
      await gs.push(titleScreen());
      for (;;) {
        const keys = await gs.keys(3600_000);
        if (keys.includes("\x1b")) return;
        if (keys.includes("\r")) break;
      }
      for (;;) {
        const t0 = Date.now();
        const status = `GREEN pause  speed ${speed + 1}/${SPEEDS.length}`;
        await gs.push(life.render(status, Date.now() < toastUntil ? toast : ""));
        const keys = await gs.keys(Math.max(50, (SPEEDS[speed] ?? 0.5) * 1000 - (Date.now() - t0)));
        for (const k of keys) {
          if (k === "\x1b") return;
          if (k === "\r") {
            const res = await pause(lane, life, lastInsertMs);
            toast = res.toast;
            lastInsertMs = res.lastInsertMs;
            if (res.action === "quit") return;
            toastUntil = toast !== "" ? Date.now() + 2500 : 0;
          } else if (k === "L") {
            speed = Math.max(0, speed - 1);
          } else if (k === "R") {
            speed = Math.min(SPEEDS.length - 1, speed + 1);
          } else {
            const t = applyKey(life, k, true);
            if (t !== "") {
              toast = t;
              toastUntil = Date.now() + 1500;
            }
          }
        }
        if (keys.length === 0) life.step();
      }
    } finally {
      await lane.send("15.6");
      await lane.softReset();
    }
  });
}

/** The --preview board: seed 7, 12 generations, all three card effects, 6 more generations. */
export function previewLife(): Life {
  const life = new Life(new PyRandom(7));
  for (let i = 0; i < 12; i++) life.step();
  life.gliderGun();
  life.splash();
  life.kaleidoscope();
  for (let i = 0; i < 6; i++) life.step();
  return life;
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  if (args.includes("--preview")) {
    const life = previewLife();
    await savePng(life.render("speed 3/4", "SWIPE: glider gun!"), "preview.png");
    await savePng(titleScreen(), "preview_title.png");
    const frame = await framePng(life.render("x"));
    console.log(`wrote preview.png, preview_title.png; frame ${frame.length} bytes`);
    return 0;
  }
  await play();
  return 0;
}
