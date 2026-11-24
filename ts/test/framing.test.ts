import { describe, expect, it } from "vitest";

import { ACK, ETX, FrameParser, NAK, STX, encodeFrame, lrc, type FrameEvent } from "../src/protocol/framing.js";

describe("framing", () => {
  it("LRC is the XOR of every byte after STX, ETX included", () => {
    const f = encodeFrame("07.");
    expect([...f]).toEqual([STX, 0x30, 0x37, 0x2e, ETX, 0x30 ^ 0x37 ^ 0x2e ^ ETX]);
    expect(lrc(f.subarray(1, f.length - 1))).toBe(f.at(-1));
  });

  it("maps message text one-to-one as latin-1", () => {
    const f = encodeFrame("24.\x1cT\xe9\xff");
    expect([...f.subarray(1, 7)]).toEqual([0x32, 0x34, 0x2e, 0x1c, 0x54, 0xe9]);
    expect(f[7]).toBe(0xff);
    expect(() => encodeFrame("snake \u{1f40d}")).toThrow(RangeError);
  });

  it("parses ACK, NAK, frames and skips stray bytes", () => {
    const p = new FrameParser();
    const bytes = Uint8Array.of(0x41, ACK, ...encodeFrame("24.0L"), 0x00, NAK, ...encodeFrame("62.0"));
    expect(p.push(bytes)).toEqual<FrameEvent[]>([
      { kind: "ack" },
      { kind: "frame", body: "24.0L" },
      { kind: "nak" },
      { kind: "frame", body: "62.0" },
    ]);
    expect(p.pending).toBe(0);
  });

  it("reports a frame with a bad LRC as corrupt", () => {
    const f = encodeFrame("24.0L");
    f[f.length - 1] = (f.at(-1) ?? 0) ^ 0x01;
    expect(new FrameParser().push(f)).toEqual([{ kind: "corrupt" }]);
  });

  it("reassembles frames split at every possible position", () => {
    const stream = Uint8Array.of(...encodeFrame("65.0\x1c1\x1c1\x1c0\x1cABC"), ACK, ...encodeFrame("23.3\r"));
    for (let cut1 = 0; cut1 <= stream.length; cut1++) {
      for (let cut2 = cut1; cut2 <= stream.length; cut2++) {
        const p = new FrameParser();
        const events = [
          ...p.push(stream.subarray(0, cut1)),
          ...p.push(stream.subarray(cut1, cut2)),
          ...p.push(stream.subarray(cut2)),
        ];
        expect(events).toEqual([
          { kind: "frame", body: "65.0\x1c1\x1c1\x1c0\x1cABC" },
          { kind: "ack" },
          { kind: "frame", body: "23.3\r" },
        ]);
      }
    }
  });

  it("handles byte-at-a-time delivery of many frames", () => {
    const bodies = Array.from({ length: 50 }, (_, i) => `24.0${"LUDR"[i % 4] ?? "L"}${"x".repeat(i)}`);
    const stream = bodies.flatMap((b) => [...encodeFrame(b)]);
    const p = new FrameParser();
    const got: FrameEvent[] = [];
    for (const b of stream) got.push(...p.push(Uint8Array.of(b)));
    expect(got).toEqual(bodies.map((body) => ({ kind: "frame", body })));
  });
});
