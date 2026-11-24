/**
 * Other inputs and outputs on the Lane/3000: beeps, lights, music and card readers.
 * See USAGE for the results on our unit.
 *
 * Card reads: the terminal returns track data, which contains the card number. The receive
 * layer keeps only the exit type and which reader fired; this module never sees the rest.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { framePng } from "../gfx/encode.js";
import type { Lane } from "../protocol/lane.js";
import { FS } from "../protocol/framing.js";
import type { CardReply } from "../protocol/messages.js";
import { withLane } from "../protocol/serial.js";
import { sleep } from "../util/interrupt.js";
import { repoPath } from "../util/paths.js";
import { pyRepr } from "../util/py-repr.js";
import { replyText, textScreen } from "./game-screen.js";

export const USAGE = `Other inputs and outputs on the Lane/3000: beeps, lights, music and card readers.

    bun run io-demo --beeps    # 51.x: the four built-in tones                       WORKS
    bun run io-demo --lights   # 92.x: LEDs, keypad light, backlight        no reply on our unit
    bun run io-demo --music    # synthesize a chiptune, upload as OGG, play (72.x)  72.9 on our unit
    bun run io-demo --cards    # 23.x: report swipe / insert events for 60 s  see card-test

Results on our Lane/3000 (Unified Payment Platform 6.80.09):
- 51.x beeps work: 4200, 6000, 9000, 3800 Hz; 150/500/1000 ms. Too few tones for music.
- 92.x light control is ACKed, never answered, and changes nothing visible (watched).
- 72.x audio answers 72.9 to every play request, even for a missing file (72.0 stop answers
  72.5 "nothing playing"), so this model can't play audio files - no chiptunes.
- 23.x card read: swipe and chip insert are enabled; contactless is disabled in configuration.
  28.100004121 (variable 412 = 1) enables contactless until reboot. An Apple Pay tap then
  returns 23.1 (bad read) - a usable tap event.

Card reads: the terminal returns track data, which contains the card number. This program keeps
only the exit type and which reader fired, and throws the rest away without printing or saving it.`;

// ---------------------------------------------------------------- beeps (51.x)
async function beeps(lane: Lane): Promise<void> {
  for (const tone of "0123") {
    // 4200, 6000, 9000, 3800 Hz
    console.log(`51.${tone}0 ->`, replyText(await lane.request(`51.${tone}0`, 3000)));
    await sleep(300);
  }
}

// ---------------------------------------------------------------- lights (92.x)
function light(lane: Lane, ...specs: string[]): Promise<string> {
  return lane.request(`92.${specs.join(FS)}`, 3000).then(replyText);
}

const ALL_OFF = ["Cless1:Off", "Cless2:Off", "Cless3:Off", "Cless4:Off", "SMC:Off", "MSR:Off"];

async function lights(lane: Lane): Promise<void> {
  const cless = ["Cless1:Green", "Cless2:Yellow", "Cless3:Green", "Cless4:Red"];
  console.log("all off:", await light(lane, ...ALL_OFF));
  for (let round = 0; round < 3; round++) {
    // chase across the four contactless LEDs
    for (const [i, spec] of cless.entries()) {
      const others = [0, 1, 2, 3].filter((j) => j !== i).map((j) => `Cless${j + 1}:Off`);
      await light(lane, spec, ...others);
      await sleep(150);
    }
  }
  console.log("all four:", await light(lane, ...cless));
  await sleep(600);
  console.log("card slot red:", await light(lane, "SMC:Red"));
  await sleep(600);
  console.log("card slot green:", await light(lane, "SMC:Green"));
  await sleep(600);
  console.log("swipe blink l2r:", await light(lane, "MSR:Green,l2r"));
  await sleep(1500);
  console.log("keypad off:", await light(lane, "Keyboard:Off"));
  await sleep(800);
  console.log("keypad on:", await light(lane, "Keyboard:ON"));
  for (const level of [10, 40, 70, 100, 30, 100]) {
    // screen backlight
    await light(lane, `Display:ON,${level}`);
    await sleep(350);
  }
  console.log("restore:", await light(lane, ...ALL_OFF, "Keyboard:ON", "Display:ON"));
}

// ---------------------------------------------------------------- music (72.x)
export const RATE = 22050;
export const BPM = 140;
/** One eighth note, in seconds. */
export const STEP = 60 / BPM / 2;
// Original tune: A minor / F / C / G, eight eighth-notes per bar (MIDI note numbers, null = rest)
export const LEAD: readonly (number | null)[] = [
  76, null, 72, 74, 76, 79, 76, 74, 72, null, 69, 72, 77, 76, 74, 72,
  72, 76, 79, null, 79, 77, 76, 72, 74, null, 71, 74, 79, 77, 74, 71,
  76, null, 72, 74, 76, 79, 81, 79, 77, null, 72, 77, 81, 79, 77, 76,
  79, 76, 72, 76, 79, 84, 79, 76, 74, 76, 79, 83, 81, null, null, null,
];
type Chord = readonly [number, number, number];
const BASE_CHORDS: readonly Chord[] = [
  [57, 60, 64],
  [53, 57, 60],
  [48, 52, 55],
  [55, 59, 62],
];
/** One chord per bar. */
export const CHORDS: readonly Chord[] = [...BASE_CHORDS, ...BASE_CHORDS];

export function freq(n: number): number {
  return 440 * 2 ** ((n - 69) / 12);
}

/** Square-wave lead, 16th-note arpeggio, pulsing bass and noise hats, mixed to 16-bit mono. */
export function chiptune(): Int16Array {
  const total = Math.trunc(LEAD.length * STEP * RATE);
  const mix = new Float64Array(total);

  const add = (startS: number, durS: number, f: number, vol: number, duty = 0.5, kind: "square" | "noise" = "square"): void => {
    const s0 = Math.trunc(startS * RATE);
    const n = Math.trunc(durS * RATE);
    let phase = 0;
    for (let i = 0; i < n; i++) {
      if (s0 + i >= total) break;
      let env = Math.min(1, (n - i) / (0.02 * RATE)) * Math.min(1, i / (0.003 * RATE));
      let v: number;
      if (kind === "noise") {
        // Python: hash(k) == k for these small non-negative ints, then & 0xFFFF
        v = (((s0 + i) * 2654435761) % 65536) / 32768 - 1;
        env *= 1 - i / n;
      } else {
        phase = (phase + f / RATE) % 1;
        v = phase < duty ? 1 : -1;
      }
      mix[s0 + i] = (mix[s0 + i] ?? 0) + v * vol * env;
    }
  };

  LEAD.forEach((note, i) => {
    if (note !== null) add(i * STEP, STEP * 0.9, freq(note), 0.22, 0.5);
  });
  CHORDS.forEach((chord, bar) => {
    const t0 = bar * 8 * STEP;
    for (let k = 0; k < 16; k++) {
      // 16th-note arpeggio, octave up, thin pulse
      add(t0 + (k * STEP) / 2, (STEP / 2) * 0.8, freq((chord[k % 3] ?? chord[0]) + 12), 0.08, 0.125);
    }
    for (let k = 0; k < 8; k++) {
      // bass: root, octave-jumping eighths
      add(t0 + k * STEP, STEP * 0.7, freq(chord[0] - 12 + (k % 2 === 1 ? 12 : 0)), 0.18, 0.5);
    }
    for (let k = 0; k < 8; k++) {
      // hats on every eighth, accent off-beats
      add(t0 + k * STEP, 0.03, 0, k % 2 === 0 ? 0.05 : 0.09, 0.5, "noise");
    }
  });
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) peak = 1;
  const out = new Int16Array(total);
  for (let i = 0; i < total; i++) out[i] = Math.trunc(((mix[i] ?? 0) / peak) * 26000);
  return out;
}

/** 16-bit mono PCM WAV file bytes. */
export function wavBytes(samples: Int16Array, rate: number = RATE): Uint8Array {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVE", 8, "latin1");
  buf.write("fmt ", 12, "latin1");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "latin1");
  buf.writeUInt32LE(data, 40);
  for (const [i, s] of samples.entries()) buf.writeInt16LE(s, 44 + i * 2);
  return new Uint8Array(buf);
}

/** Synthesize the tune and encode it to OGG Vorbis at `path` with ffmpeg. */
export async function makeOgg(path: string): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), "lane-tune-"));
  try {
    const wav = join(tmp, "tune.wav");
    writeFileSync(wav, wavBytes(chiptune()));
    await promisify(execFile)("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-c:a", "libvorbis", "-q:a", "3", path,
    ]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const AUDIO_STATUS: Readonly<Record<string, string>> = {
  "0": "play complete",
  "1": "file not on terminal",
  "2": "empty list",
  "3": "interrupted",
  "4": "already playing",
  "5": "invalid request",
};

async function music(lane: Lane): Promise<void> {
  const path = repoPath("chiptune.ogg");
  await makeOgg(path);
  const data = readFileSync(path);
  console.log(`chiptune.ogg: ${(data.length / 1024).toFixed(1)} KB, ${(LEAD.length * STEP).toFixed(1)} s`);
  await lane.writeFile("CHIPTUNE.OGG", data);
  const t = Date.now();
  await lane.send("72.1CHIPTUNE.OGG");
  const r = await lane.recv("72", 60_000);
  const status = r === null ? "no reply" : (AUDIO_STATUS[r.body.slice(0, 1)] ?? "?");
  console.log(`72 -> ${replyText(r)} (${status}) after ${((Date.now() - t) / 1000).toFixed(1)}s`);
}

// ---------------------------------------------------------------- cards (23.x)
export const SOURCES: Readonly<Record<string, string>> = {
  C: "tap (contactless)",
  E: "tap (EMV contactless)",
  M: "swipe",
  S: "chip insert",
  Q: "chip insert (quick chip)",
  c: "key/coupon card",
  m: "phone tap",
  H: "manual entry",
};
export const EXITS: Readonly<Record<string, string>> = {
  "0": "good read",
  "1": "bad read",
  "2": "cancelled",
  "3": "key pressed",
  "6": "invalid prompt",
  "7": "encryption failed",
  "9": "rejected (busy)",
  A: "contactless needs an amount",
  R: "a requested reader is disabled",
};

/** Exit type and source of a card read: the only parts of a 23.x reply this program uses. */
export interface CardResult {
  readonly exit: string;
  /** Reader letter for a good read; for a key press the character after the exit type's key field. */
  readonly source: string;
}

/** (exit, source) as io_demo.card_event computed them from the reply. */
export function cardResult(card: CardReply): CardResult {
  switch (card.exit) {
    case "0":
      return { exit: "0", source: card.letter };
    case "3":
      return { exit: "3", source: card.keyField.slice(1, 2) }; // Python: r[5:6]
    case "other":
      return { exit: card.code, source: "" };
    case "1":
    case "2":
    case "6":
    case "7":
    case "9":
    case "A":
    case "R":
    case "N":
      return { exit: card.exit, source: "" };
    default: {
      const unreachable: never = card;
      return unreachable;
    }
  }
}

export function describeResult(r: CardResult): string {
  return r.exit === "0" ? (SOURCES[r.source] ?? r.source) : (EXITS[r.exit] ?? r.exit);
}

/**
 * Arm the readers over the GAME.K3Z screen; resolve to (exit, source) only.
 * devices "" = every reader enabled in the terminal's configuration (on our unit swipe and chip
 * insert; contactless is disabled and "C" alone returns 23.R).
 */
export async function cardEvent(lane: Lane, devices = "", timeoutMs = 60_000): Promise<CardResult | null> {
  await lane.softReset();
  await lane.send(`23.${FS}GAME.K3Z${FS}${FS}${devices}`);
  const r = await lane.recv("23", timeoutMs);
  return r === null ? null : cardResult(r.card);
}

async function cards(lane: Lane, seconds = 60): Promise<void> {
  await lane.softReset(); // make sure no earlier on-demand screen is still open
  const end = Date.now() + seconds * 1000;
  let last = "swipe, insert or tap a card";
  while (Date.now() < end) {
    const left = Math.trunc((end - Date.now()) / 1000);
    await lane.writeFile("GAME.PNG", await framePng(textScreen(["CARD TEST", last, `${left}s left - RED quits`])));
    const r = await cardEvent(lane, "", end - Date.now());
    if (r === null) break;
    const what = describeResult(r);
    console.log(`exit ${pyRepr(r.exit)} source ${pyRepr(r.source)}: ${what}`);
    if (r.exit === "3" && r.source === "\x1b") break;
    if (["6", "9", "A", "R"].includes(r.exit)) {
      last = what;
      if (r.exit === "9" || r.exit === "R") await sleep(1000);
      continue;
    }
    last = "got: " + what;
  }
  await lane.softReset();
}

const ACTIONS: Readonly<Record<string, (lane: Lane) => Promise<void>>> = {
  "--beeps": beeps,
  "--lights": lights,
  "--music": music,
  "--cards": (lane) => cards(lane),
};

export async function main(args: readonly string[]): Promise<number> {
  const chosen = args.filter((a) => Object.hasOwn(ACTIONS, a));
  if (chosen.length === 0) {
    console.error(USAGE);
    return 1;
  }
  await withLane(async (lane) => {
    await lane.softReset();
    for (const a of chosen) {
      const action = ACTIONS[a];
      if (action === undefined) continue;
      console.log("==", a);
      await action(lane);
    }
  });
  return 0;
}
