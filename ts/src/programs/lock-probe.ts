/**
 * Experiments on the post-card-read upload lock (62.x -> 62.7).
 * Card data is never involved: these arm the readers without a card present.
 */

import { framePng } from "../gfx/encode.js";
import { FS } from "../protocol/framing.js";
import { LaneError, type Lane } from "../protocol/lane.js";
import { isOutbound } from "../protocol/messages.js";
import { waitForTerminal, withLane } from "../protocol/serial.js";
import { sleep } from "../util/interrupt.js";
import { pyRepr, pyReprList } from "../util/py-repr.js";
import { replyText, textScreen } from "./game-screen.js";

export const USAGE = `Experiments on the post-card-read upload lock (62.x -> 62.7).

    npm run lock-probe -- trigger <readers>       # arm readers (e.g. M, S, MS, C) 2 s, cancel, test upload
    npm run lock-probe -- unlock <msg> [<msg>...]  # send each message, test upload after each
    npm run lock-probe -- reboot

In <msg>, the letters FS stand for the field separator (0x1C).`;

async function uploadOk(lane: Lane, png: Uint8Array): Promise<boolean> {
  try {
    await lane.writeFile("GAME.PNG", png);
    return true;
  } catch (err: unknown) {
    if (err instanceof LaneError) return false;
    throw err;
  }
}

export async function main(args: readonly string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (cmd === "reboot") {
    await withLane((lane) => lane.send("97."));
    console.log("back:", pyReprList((await waitForTerminal()).slice(0, 2)));
    return 0;
  }
  if (cmd !== "trigger" && cmd !== "unlock") {
    console.error(USAGE);
    return 1;
  }
  const msgs: string[] = [];
  for (const raw of rest) {
    const msg = raw.replaceAll("FS", FS);
    if (cmd === "unlock" && !isOutbound(msg)) {
      console.error(`not an RBA message: ${pyRepr(msg)}`);
      return 1;
    }
    msgs.push(msg);
  }
  const devices = rest[0];
  if (cmd === "trigger" && devices === undefined) {
    console.error(USAGE);
    return 1;
  }
  const png = await framePng(textScreen(["LOCK PROBE"]));
  await withLane(async (lane) => {
    await lane.drain(500);
    lane.clearInbox();
    console.log("upload before:", (await uploadOk(lane, png)) ? "OK" : "LOCKED");
    if (cmd === "trigger" && devices !== undefined) {
      if (devices.includes("C")) console.log("412=1:", replyText(await lane.request("28.100004121", 3000)));
      await lane.softReset();
      await lane.send(`23.${FS}GAME.K3Z${FS}${FS}${devices}`);
      const r = await lane.recv("23", 2000);
      console.log(`armed ${devices}:`, r === null ? "waiting" : `reply 23.${r.card.exit === "other" ? r.card.code : r.card.exit}`);
      await lane.softReset();
      await sleep(500);
      await lane.drain(500);
      console.log("queued after cancel:", pyReprList(lane.inboxSummary()));
      lane.clearInbox();
      console.log("upload after cancel:", (await uploadOk(lane, png)) ? "OK" : "LOCKED");
    } else {
      for (const msg of msgs) {
        if (!isOutbound(msg)) continue;
        await lane.send(msg);
        const r = await lane.recvAny(3000);
        await sleep(500);
        await lane.drain(300);
        const extra = lane.inboxSummary();
        lane.clearInbox();
        const ok = await uploadOk(lane, png);
        console.log(
          `${pyRepr(msg).padEnd(22)} reply ${replyText(r).padEnd(20)} extra ${pyReprList(extra)} -> upload ${ok ? "OK" : "LOCKED"}`,
        );
        if (ok) break;
      }
    }
  });
  return 0;
}
