/** `lane` program (Python: `python3 lane.py [-v]`): open the terminal and print its unit data. */

import { withLane } from "../protocol/serial.js";
import { pyReprList } from "../util/py-repr.js";

export async function main(args: readonly string[]): Promise<number> {
  await withLane(
    async (lane) => {
      console.log("Port:", lane.port);
      const info = await lane.unitData();
      console.log("Unit data:", info === null ? "None" : pyReprList(info));
    },
    { debug: args.includes("-v") },
  );
  return 0;
}
