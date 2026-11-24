/**
 * COIN GRAB - a top-down proof-of-concept game for an Ingenico Lane/3000 running RBA.
 * (Early text-grid experiment, superseded: ASCII looks bad on this screen.)
 *
 * Move the @ around the box, grab every $ and don't let the skimmer & catch you.
 * Each key press is one turn; the skimmer steps toward you every other turn.
 */

import { withLane } from "../protocol/serial.js";
import { PyRandom } from "../util/py-random.js";
import { pyRepr } from "../util/py-repr.js";
import { pySetOrder, tupleHash } from "../util/py-set-order.js";
import { pyBool, showRows } from "./bamtv.js";

export const USAGE = `COIN GRAB - a top-down proof-of-concept game for an Ingenico Lane/3000 running RBA.

Keys (the four keys under the screen):
    [ - ] F1 = left    [ ^ ] F2 = up    [ v ] F3 = down    [ - ] F4 = right
    GREEN = new game   RED = quit

Run:   bun run coin-grab                (plays on the terminal)
       bun run coin-grab --preview   (prints frames here; no terminal needed)`;

/** Logical cells; each is drawn 2 characters wide -> "#" + 34 + "#" = 36 chars. */
export const COLS = 17;
export const ROWS = 8;
export const N_COINS = 6;

type MoveKey = "C" | "P" | "Y" | "N";
const KEYS: Readonly<Record<MoveKey, readonly [number, number]>> = {
  C: [-1, 0], // F1
  P: [0, -1], // F2 (up)
  Y: [0, 1], // F3 (down)
  N: [1, 0], // F4
};
function isMoveKey(k: string): k is MoveKey {
  return k === "C" || k === "P" || k === "Y" || k === "N";
}

type Cell = readonly [number, number];
const same = (a: Cell, b: Cell): boolean => a[0] === b[0] && a[1] === b[1];

export class Game {
  player: Cell;
  skimmer: Cell;
  coins: Cell[];
  moves = 0;
  readonly total: number;
  msg = "Grab every $";

  constructor(seed?: number) {
    const rng = new PyRandom(seed);
    const cells: Cell[] = [];
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) cells.push([x, y]);
    rng.shuffle(cells);
    this.player = [1, Math.floor(ROWS / 2)];
    const p = this.player;
    const rest = cells.filter((c) => !same(c, p));
    const skimmer = rest.find((c) => Math.abs(c[0] - p[0]) > 8);
    if (skimmer === undefined) throw new RangeError("board too small for a skimmer");
    this.skimmer = skimmer;
    const candidates = rest.filter((c) => !same(c, skimmer) && Math.abs(c[0] - p[0]) + Math.abs(c[1] - p[1]) > 2);
    // Python: set(list(set(candidates))[:N_COINS]) - the first six in CPython's set order
    this.coins = pySetOrder(candidates, (c) => tupleHash(c), same).slice(0, N_COINS);
    this.total = this.coins.length;
  }

  get won(): boolean {
    return this.coins.length === 0;
  }

  get lost(): boolean {
    return same(this.player, this.skimmer);
  }

  press(key: string): void {
    if (!isMoveKey(key)) return;
    const [dx, dy] = KEYS[key];
    const x = Math.min(COLS - 1, Math.max(0, this.player[0] + dx));
    const y = Math.min(ROWS - 1, Math.max(0, this.player[1] + dy));
    this.player = [x, y];
    this.moves += 1;
    this.msg = "";
    const hit = this.coins.findIndex((c) => same(c, [x, y]));
    if (hit >= 0) {
      this.coins.splice(hit, 1);
      this.msg = "Cha-ching!";
    }
    if (this.lost || this.won) return;
    if (this.moves % 2 === 0) {
      // skimmer moves every other turn, toward the player
      let [sx, sy] = this.skimmer;
      const [px, py] = this.player;
      if (Math.abs(px - sx) >= Math.abs(py - sy)) sx += Math.sign(px - sx);
      else sy += Math.sign(py - sy);
      this.skimmer = [sx, sy];
    }
  }

  render(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < ROWS; y++) {
      let line = "";
      for (let x = 0; x < COLS; x++) {
        const c: Cell = [x, y];
        let ch: string;
        if (same(c, this.player) && same(c, this.skimmer)) ch = "X";
        else if (same(c, this.player)) ch = "@";
        else if (same(c, this.skimmer)) ch = "&";
        else if (this.coins.some((k) => same(k, c))) ch = "$";
        else ch = ".";
        line += ch + " ";
      }
      rows.push("#" + line + "#");
    }
    return rows;
  }

  hud(): string {
    const got = this.total - this.coins.length;
    if (this.lost) return `CAUGHT by the skimmer!  Coins ${got}/${this.total}   GREEN = again  RED = quit`;
    if (this.won) return `YOU WIN in ${this.moves} moves!   GREEN = again  RED = quit`;
    return `COINS ${got}/${this.total}   MOVES ${this.moves}   ${this.msg}`;
  }
}

export const TITLE: readonly string[] = [
  "#..................................#",
  "#   C O I N   G R A B              #",
  "#                                  #",
  "#   @ = you    $ = coin            #",
  "#   & = skimmer (it chases you)    #",
  "#                                  #",
  "#   arrows: [-] [^] [v] [-]        #",
  "#..................................#",
];

async function play(): Promise<void> {
  await withLane(async (lane) => {
    try {
      // Try with the payment-button labels hidden. If the F-keys don't fire that way,
      // the player presses GREEN instead and we fall back to showing the buttons.
      let key = await showRows(
        lane,
        TITLE,
        "COIN GRAB - press UP arrow to start  (if nothing happens press GREEN)",
        false,
      );
      const buttons = !isMoveKey(key);
      console.log("F-keys work with buttons hidden:", pyBool(!buttons));
      if (key === "\x1b") return;
      for (;;) {
        const g = new Game();
        while (!(g.won || g.lost)) {
          key = await showRows(lane, g.render(), g.hud(), buttons);
          if (key === "\x1b") return;
          if (key === "\r") break;
          g.press(key);
          console.log(`${pyRepr(key)} -> ${g.hud()}`);
        }
        if (g.won || g.lost) {
          if ((await showRows(lane, g.render(), g.hud(), buttons)) === "\x1b") return;
        }
      }
    } finally {
      await lane.softReset();
    }
  });
}

export function preview(): string {
  const out: string[] = [TITLE.join("\n")];
  const g = new Game(1);
  for (const key of ["", "N", "N", "P", "Y"]) {
    if (key !== "") g.press(key);
    out.push(`--- after ${pyRepr(key)}: ${g.hud()}`);
    out.push(g.render().join("\n"));
  }
  if (![...g.render(), ...TITLE].every((r) => r.length === 36)) throw new RangeError("rows must be 36 wide");
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
