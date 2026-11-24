#!/usr/bin/env node
/**
 * One entry point for every program:  node dist/cli.js <program> [args...]
 * (or `npm run <program> -- [args...]`).
 */

import { LaneError } from "./protocol/lane.js";
import { InterruptedError, interruptPending } from "./util/interrupt.js";

type Main = (args: readonly string[]) => Promise<number>;

/** Programs load lazily: only the chosen one (and its dependencies) is imported. */
const PROGRAMS: Readonly<Record<string, () => Promise<{ main: Main }>>> = {
  lane: () => import("./programs/lane-info.js"),
  "game-screen": () => import("./programs/game-screen.js"),
  snake: () => import("./programs/snake.js"),
  maze: () => import("./programs/maze.js"),
  life: () => import("./programs/life.js"),
  "show-image": () => import("./programs/show-image.js"),
  "io-demo": () => import("./programs/io-demo.js"),
  "card-test": () => import("./programs/card-test.js"),
  "light-test": () => import("./programs/light-test.js"),
  "lock-probe": () => import("./programs/lock-probe.js"),
  "maze-script": () => import("./programs/maze-script.js"),
  "coin-grab": () => import("./programs/coin-grab.js"),
  "skimmer-hunt": () => import("./programs/skimmer-hunt.js"),
};

async function run(argv: readonly string[]): Promise<number> {
  const [name, ...args] = argv;
  const load = name === undefined ? undefined : PROGRAMS[name];
  if (load === undefined) {
    console.error(`usage: node dist/cli.js <program> [args...]\nprograms: ${Object.keys(PROGRAMS).join(", ")}`);
    return 2;
  }
  // First Ctrl-C: cancel what the program waits on, so its cleanup (15.0 etc.) still runs.
  // Second Ctrl-C: exit at once.
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    interruptPending();
  });
  try {
    const mod = await load();
    return await mod.main(args);
  } catch (err: unknown) {
    if (err instanceof InterruptedError) return 130;
    if (err instanceof LaneError) {
      console.error(`error: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  },
);
