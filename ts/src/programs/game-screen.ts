/**
 * Full-screen graphics + key input on an Ingenico Lane/3000 running RBA.
 *
 * Installs one custom screen layout, GAME.K3Z: a full-screen image (GAME.PNG) with every key
 * enabled. F1-F4 are linked to 1-pixel buttons so the terminal reports them to the host.
 * Each frame is drawn on the Mac, uploaded as a small palette PNG, GAME.PNG (62.x), and shown
 * with 24.GAME.K3Z. A 32-colour PNG of flat game graphics is ~1-3 KB, versus 5-15 KB as JPEG.
 */

import { framePng, rgbPng, SCREEN_H as H, SCREEN_W as W } from "../gfx/encode.js";
import { Raster, type Rgb } from "../gfx/raster.js";
import { font } from "../gfx/text.js";
import type { Lane } from "../protocol/lane.js";
import { formatInbound, isGameKey, type GameKey, type Inbound } from "../protocol/messages.js";
import { waitForTerminal, withLane } from "../protocol/serial.js";
import { pyRepr, pyReprList } from "../util/py-repr.js";

export const USAGE = `Full-screen graphics + key input on an Ingenico Lane/3000 running RBA.

    bun run game-screen --install     # upload GAME.K3Z + images, then reboot the terminal
    bun run game-screen --uninstall   # delete those files, then reboot
    bun run game-screen --keytest     # show pressed keys on screen for 60 s

Key codes reported:  F1 'L'  F2 'U'  F3 'D'  F4 'R'  green '\\r'  yellow '\\x08'  red '\\x1b'`;

export const FILES = ["GAME.K3Z", "GAME.PNG", "GAMEBTN.PNG"] as const;
/** Left over from earlier versions; removed on install. */
export const OBSOLETE = ["GAME.JPG", "MAZE.K3Z"] as const;

function button(bid: string, letter: string): string {
  return (
    `<BmpButton x="0" y="0" width="1" height="1" id="${bid}" key="CUSTOM" buttonid="'${letter}'" ` +
    'upimage="GAMEBTN.PNG" hostupimage=".\\GAMEBTN.PNG" downimage="GAMEBTN.PNG" ' +
    'hostdownimage=".\\GAMEBTN.PNG" textsource="custom" buttontext=" " textoffsetx="0" ' +
    'textoffsety="0" textcolor="000000" fontsize="10px" fontweight="normal" fontfamily="sans-serif" ' +
    'align="center" eventfireon="down" visibility="visible" tonetype="0" />'
  );
}

export const FORM =
  [
    '<Form id="Form" terminalname="Lane 3000" designerversion="1.0" x="0" y="0" width="320" height="240" ' +
      'template="TEMPMENU.HTM" backgroundcolor="000000" timeout="0" enterenabled="true" entertone="0" ' +
      'clearenabled="true" cleartone="0" cancelenabled="true" canceltone="0" tonetype="0" ' +
      'f1enabled="true" f2enabled="true" f3enabled="true" f4enabled="true" ' +
      'F1-link="btnl" F2-link="btnu" F3-link="btnd" F4-link="btnr" ' +
      'swledbarenabled="false" headerenabled="false" clesslogo="false" windowtype="full" />',
    '<Image x="0" y="0" width="320" height="240" id="image1" image="GAME.PNG" hostimage=".\\GAME.PNG" />',
    button("btnl", "L"),
    button("btnu", "U"),
    button("btnd", "D"),
    button("btnr", "R"),
  ].join("\n") + "\n";

export const YELLOW: Rgb = [255, 220, 0];

/** Centred title (yellow, 30 px) and lines (18 px). */
export function textScreen(lines: readonly string[], bg: Rgb = [0, 0, 0], fg: Rgb = [255, 255, 255]): Raster {
  const img = new Raster(W, H, bg);
  let y = Math.floor(H / 2) - 18 * lines.length;
  lines.forEach((line, i) => {
    img.text([Math.floor(W / 2), y], line, font(i === 0 ? 30 : 18), i === 0 ? YELLOW : fg, "mm");
    y += i === 0 ? 44 : 28;
  });
  return img;
}

/** Print-friendly reply (Python printed the raw reply or None). */
export function replyText(m: Inbound | null): string {
  return m === null ? "None" : formatInbound(m);
}

/** Push frames to the full-screen layout and collect key presses without blocking. */
export class GameScreen {
  constructor(readonly lane: Lane) {}

  async push(img: Raster, colors = 32): Promise<void> {
    await this.lane.writeFile("GAME.PNG", await framePng(img, colors));
    await this.lane.softReset(); // close the previous frame's screen (if still open)
    await this.lane.send("24.GAME.K3Z"); // reply comes later, when a key closes the screen
  }

  /** Keys pressed since the last call (waits up to `waitMs` for the first one). */
  async keys(waitMs = 0): Promise<GameKey[]> {
    const out: GameKey[] = [];
    const deadline = Date.now() + waitMs;
    for (;;) {
      const m = await this.lane.recv("24", out.length > 0 ? 0 : Math.max(0, deadline - Date.now()));
      if (m === null) return out;
      if (m.form.exitType === "0" && isGameKey(m.form.keyChar)) out.push(m.form.keyChar);
    }
  }
}

async function install(): Promise<void> {
  const btn = await rgbPng(new Raster(1, 1, [0, 0, 0]));
  await withLane(async (lane) => {
    await lane.softReset();
    await lane.writeFile("GAMEBTN.PNG", btn);
    await lane.writeFile("GAME.PNG", await framePng(textScreen(["GAME SCREEN", "installed"])));
    await lane.writeFile("GAME.K3Z", Buffer.from(FORM, "latin1"));
    for (const f of OBSOLETE) await lane.request(`64./HOST/${f}`, 5000);
    console.log("Uploaded", FILES.join(", "), "- rebooting terminal (about a minute)...");
    await lane.send("97.");
  });
  console.log("Back:", pyReprList((await waitForTerminal()).slice(0, 2)));
  await withLane(async (lane) => {
    const form = await lane.readFile("/HOST/GAME.K3Z");
    console.log("GAME.K3Z on terminal:", form?.includes("GAME.PNG") === true ? "OK" : (form ?? "None"));
  });
}

async function uninstall(): Promise<void> {
  await withLane(async (lane) => {
    await lane.softReset();
    for (const f of FILES) console.log(f, "->", replyText(await lane.request(`64./HOST/${f}`, 5000)));
    await lane.send("97.");
  });
  console.log("Back:", pyReprList((await waitForTerminal()).slice(0, 2)));
}

const KEY_NAMES: Readonly<Record<GameKey, string>> = {
  L: "F1",
  U: "F2 (up)",
  D: "F3 (down)",
  R: "F4",
  "\r": "GREEN",
  "\b": "YELLOW",
  "\x1b": "RED",
};

async function keytest(seconds = 60): Promise<void> {
  const seen: GameKey[] = [];
  await withLane(async (lane) => {
    const gs = new GameScreen(lane);
    const end = Date.now() + seconds * 1000;
    await gs.push(textScreen(["KEY TEST", "press any key", `${seconds}s`]));
    while (Date.now() < end) {
      const ks = await gs.keys(end - Date.now());
      for (const k of ks) {
        seen.push(k);
        console.log("key", pyRepr(k));
      }
      const last = ks.at(-1);
      if (last !== undefined) {
        await gs.push(textScreen(["KEY TEST", "last: " + KEY_NAMES[last], `${seen.length} presses`]));
      }
    }
    await lane.softReset();
  });
  console.log("seen:", pyReprList(seen));
}

export async function main(args: readonly string[]): Promise<number> {
  const arg = args[0];
  if (arg === "--install") await install();
  else if (arg === "--uninstall") await uninstall();
  else if (arg === "--keytest") await keytest();
  else {
    console.error(USAGE);
    return 1;
  }
  return 0;
}
