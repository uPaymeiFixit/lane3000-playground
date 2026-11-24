/**
 * The stock BAMTV.K3Z line display used by the early text experiments (coin-grab,
 * skimmer-hunt): 8 rows of 38 monospace columns in variables 111-118, title label PROMPTLINE1,
 * F1-F4 reporting C P Y N when their buttons are shown.
 */

import { LaneError, type Lane } from "../protocol/lane.js";
import { formRequest } from "../protocol/messages.js";

export const BAMTV_BUTTONS = ["btnc", "btnp", "btny", "btnn"] as const;

/** Show BAMTV.K3Z with our header, draw up to 8 rows, and resolve to the key pressed. */
export async function showRows(
  lane: Lane,
  rows: readonly string[],
  header: string,
  buttons: boolean,
): Promise<string> {
  await lane.send(
    formRequest("BAMTV.K3Z", {
      texts: { PROMPTLINE1: header.replaceAll(",", " ").slice(0, 120) },
      showButtons: buttons ? BAMTV_BUTTONS : [],
    }),
  );
  for (const [i, row] of rows.slice(0, 8).entries()) {
    await lane.send(`28.90000${String(111 + i).padStart(3, "0")}${row}`);
  }
  for (;;) {
    const r = await lane.recv("24", 3600_000);
    if (r === null) throw new LaneError("No key pressed for an hour; quitting.");
    if (r.form.exitType === "0" && r.form.keyChar !== "") return r.form.keyChar;
  }
}

/** Python's str() of a bool. */
export function pyBool(b: boolean): string {
  return b ? "True" : "False";
}
