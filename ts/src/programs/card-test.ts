/**
 * Card reader test that survives the upload lock.
 *
 * Arming a card reader (23.x) locks 62.x uploads (62.7) until a 15.6 Stop Action, so this test
 * uploads one instruction screen first, then only re-arms the readers and beeps: low = swipe,
 * middle = chip, high = tap, error tone = bad read. It sends 15.6 at the end to clear the lock.
 * Contactless is enabled for the session with variable 412 = 1 (until reboot).
 *
 * Card data: only the exit type and reader letter are kept (in the receive layer); the rest of
 * each reply (which holds the card number) is discarded without being printed or stored.
 */

import { framePng } from "../gfx/encode.js";
import { withLane } from "../protocol/serial.js";
import { sleep } from "../util/interrupt.js";
import { pyRepr } from "../util/py-repr.js";
import { replyText, textScreen } from "./game-screen.js";
import { cardEvent, describeResult } from "./io-demo.js";
import { clock } from "./show-image.js";

export const USAGE = `Card reader test that survives the upload lock.

    npm run card-test -- [seconds] [readers]   # default 180 s, readers MSC (M swipe, S chip, C tap)`;

/** 51.<tone><length> per reader: low = swipe, middle = chip, high = tap. */
const BEEP: Readonly<Record<string, string>> = { M: "00", S: "10", Q: "10", C: "20", E: "20", m: "20" };

async function run(seconds: number, devices: string): Promise<void> {
  await withLane(async (lane) => {
    await lane.softReset();
    await lane.writeFile(
      "GAME.PNG",
      await framePng(
        textScreen(["CARD TEST", "swipe, insert or tap", "low beep=swipe  mid=chip", "high=tap  buzz=bad read"]),
      ),
    );
    if (devices.includes("C")) console.log("contactless on:", replyText(await lane.request("28.100004121", 3000)));
    const end = Date.now() + seconds * 1000;
    console.log(`readers: ${devices}`);
    console.log(`ARMED until ${clock(new Date(end))}`);
    while (Date.now() < end) {
      const r = await cardEvent(lane, devices, end - Date.now());
      if (r === null) break;
      console.log(`${clock()}  exit ${pyRepr(r.exit)} source ${pyRepr(r.source)}: ${describeResult(r)}`);
      if (r.exit === "3" && r.source === "\x1b") break;
      await lane.send(`51.${r.exit === "0" ? (BEEP[r.source] ?? "30") : "33"}`);
      await sleep(r.exit === "9" || r.exit === "R" ? 1000 : 300);
    }
    await lane.stopAction(); // 15.6: clears the upload lock (remove any chip card first)
    console.log("done; upload lock cleared with 15.6");
  });
}

export async function main(args: readonly string[]): Promise<number> {
  if (args[0] === "--help") {
    console.log(USAGE);
    return 0;
  }
  const seconds = args[0] === undefined ? 180 : Number.parseInt(args[0], 10);
  if (!Number.isInteger(seconds)) {
    console.error(USAGE);
    return 1;
  }
  await run(seconds, args[1] ?? "MSC");
  return 0;
}
