import { describe, expect, it } from "bun:test";

import {
  decode8,
  encode8,
  isEncoded8,
  rbaFileName,
  recordType,
  segmentNumber,
  splitEncoded,
} from "../src/protocol/file-encoding.js";
import { PyRandom } from "../src/util/py-random.js";

function randomBytes(rng: PyRandom, n: number, ffBias: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = rng.random();
    out[i] = r < ffBias ? 0xff : r < ffBias * 1.5 ? rng.randint(0, 0x1f) : rng.randint(0, 255);
  }
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe("RBA eight-bit file encoding", () => {
  it("escapes control bytes and FF", () => {
    expect([...encode8(Uint8Array.of(0x00, 0x1f, 0x20, 0x41, 0xfe, 0xff))]).toEqual([
      0xff, 0x20, 0xff, 0x3f, 0x20, 0x41, 0xfe, 0xff, 0xff,
    ]);
  });

  it("round-trips random data (many seeds, FF-heavy)", () => {
    const rng = new PyRandom(1234);
    for (let t = 0; t < 300; t++) {
      const data = randomBytes(rng, rng.randint(0, 3000), [0, 0.05, 0.5, 0.95][t % 4] ?? 0);
      const enc = encode8(data);
      expect(isEncoded8(enc)).toBe(true);
      expect(decode8(enc)).toEqual(data);
    }
  });

  it("rejects malformed encoded streams", () => {
    expect(isEncoded8(Uint8Array.of(0x10))).toBe(false);
    expect(isEncoded8(Uint8Array.of(0x41, 0xff))).toBe(false);
    expect(isEncoded8(Uint8Array.of(0xff, 0x41))).toBe(false);
  });

  it("splits into blocks without cutting an FF escape pair (randomized)", () => {
    const rng = new PyRandom(99);
    for (let t = 0; t < 400; t++) {
      const data = randomBytes(rng, rng.randint(0, 9000), [0.02, 0.3, 0.9][t % 3] ?? 0);
      const block = [2, 3, 7, 64, 3800][t % 5] ?? 3800;
      const enc = encode8(data);
      const pieces = splitEncoded(enc, block);
      expect(pieces.length).toBeGreaterThanOrEqual(1);
      for (const p of pieces) {
        expect(p.length).toBeLessThanOrEqual(block);
        expect(isEncoded8(p)).toBe(true); // every escape pair complete inside its block
        if (enc.length > 0) expect(p.length).toBeGreaterThan(0);
      }
      expect(concat(pieces)).toEqual(enc);
      expect(concat(pieces.map(decode8))).toEqual(data);
    }
  });

  it("cuts one byte early when a block would end on the first byte of a pair", () => {
    // 3 plain bytes, then FF FF (escaped FF): a 4-byte block must stop before the pair.
    const enc = encode8(Uint8Array.of(0x41, 0x42, 0x43, 0xff, 0x44));
    expect(splitEncoded(enc, 4).map((p) => [...p])).toEqual([[0x41, 0x42, 0x43], [0xff, 0xff, 0x44]]);
    // an even run of FFs ending at the cut is two whole pairs: no adjustment
    const enc2 = encode8(Uint8Array.of(0x41, 0x42, 0xff, 0x44));
    expect(splitEncoded(enc2, 4).map((p) => [...p])).toEqual([[0x41, 0x42, 0xff, 0xff], [0x44]]);
  });

  it("returns one empty block for an empty file", () => {
    expect(splitEncoded(encode8(new Uint8Array(0)))).toHaveLength(1);
  });

  it("record types 0/1/2/3 and segment numbers 01..99", () => {
    expect(recordType(0, 1)).toBe("0");
    expect([0, 1, 2, 3].map((n) => recordType(n, 4))).toEqual(["1", "2", "2", "3"]);
    expect([0, 8, 98, 99, 100].map(segmentNumber)).toEqual(["01", "09", "99", "01", "02"]);
  });

  it("file names are upper-cased and at most 15 characters", () => {
    expect<string>(rbaFileName("game.png")).toBe("GAME.PNG");
    expect<string>(rbaFileName("CHIPTUNE.OGG")).toBe("CHIPTUNE.OGG");
    expect(() => rbaFileName("A_VERY_LONG_NAME.PNG")).toThrow(RangeError);
    expect(() => rbaFileName("")).toThrow(RangeError);
    expect(() => rbaFileName("../HOST/X")).toThrow(RangeError);
  });
});
