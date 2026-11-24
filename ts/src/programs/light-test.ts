/**
 * Beep jingle + a slow, captioned light test for the Lane/3000.
 *
 * The terminal never replies to 92.x on our unit, so the only way to know if a light works is to
 * watch it; the screen says what each step should do.
 */

import { FS } from "../protocol/framing.js";
import type { Lane } from "../protocol/lane.js";
import { withLane } from "../protocol/serial.js";
import { sleep } from "../util/interrupt.js";
import { GameScreen, replyText, textScreen } from "./game-screen.js";

export const USAGE = `Beep jingle + a slow, captioned light test for the Lane/3000.

    bun run light-test --jingle   # four-tone jingle with the 51.x beep command
    bun run light-test --lights   # one 92.x light command every few seconds, captioned on screen`;

type Tone = "0" | "1" | "2" | "3";
type Length = "0" | "1" | "2";

// 51.x tones, lowest to highest: 3 = 3800 Hz, 0 = 4200 Hz, 1 = 6000 Hz, 2 = 9000 Hz
// lengths: 0 = 150 ms, 1 = 500 ms, 2 = 1000 ms
export const JINGLE: readonly (readonly [Tone, Length, number])[] = [
  ["3", "0", 0.0],
  ["0", "0", 0.0],
  ["1", "0", 0.0],
  ["2", "0", 0.15],
  ["1", "0", 0.0],
  ["2", "1", 0.0],
];
const LENGTH_S: Readonly<Record<Length, number>> = { "0": 0.15, "1": 0.5, "2": 1.0 };

async function jingle(lane: Lane): Promise<void> {
  for (const [tone, length, pause] of JINGLE) {
    await lane.request(`51.${tone}${length}`, 2000); // reply arrives as the beep starts
    await sleep((LENGTH_S[length] + pause) * 1000);
  }
}

export const STEPS: readonly (readonly [string, readonly string[]])[] = [
  ["SCREEN: getting DIM", ["Display:ON,10"]],
  ["SCREEN: back to BRIGHT", ["Display:ON,100"]],
  ["KEYPAD light: OFF", ["Keyboard:Off"]],
  ["KEYPAD light: ON", ["Keyboard:ON,100"]],
  ["TAP LIGHTS: all four ON", ["Cless1:Green", "Cless2:Yellow", "Cless3:Green", "Cless4:Red"]],
  ["TAP LIGHTS: OFF", ["Cless1:Off", "Cless2:Off", "Cless3:Off", "Cless4:Off"]],
  ["CHIP SLOT light: RED", ["SMC:Red"]],
  ["CHIP SLOT light: GREEN", ["SMC:Green"]],
  ["SWIPE SLOT light: blinking", ["SMC:Off", "MSR:Green,l2r"]],
  ["all lights back to normal", ["MSR:Off", "Keyboard:ON", "Display:ON"]],
];

async function lights(lane: Lane, holdS = 4.0): Promise<void> {
  const gs = new GameScreen(lane);
  for (const [n, [caption, specs]] of STEPS.entries()) {
    const i = n + 1;
    await gs.push(textScreen([`LIGHT TEST ${i}/${STEPS.length}`, caption, "watch the terminal"]));
    await sleep(400);
    await lane.send(`92.${specs.join(FS)}`);
    const reply = await lane.recv("92", 500);
    console.log(`${String(i).padStart(2)}. ${caption.padEnd(30)} reply: ${replyText(reply)}`);
    await sleep(holdS * 1000);
  }
  await lane.softReset();
}

export async function main(args: readonly string[]): Promise<number> {
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }
  await withLane(async (lane) => {
    await lane.softReset();
    if (args.includes("--jingle")) await jingle(lane);
    if (args.includes("--lights")) await lights(lane);
  });
  return 0;
}
