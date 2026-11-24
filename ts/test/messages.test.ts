import { describe, expect, it } from "vitest";

import { FS } from "../src/protocol/framing.js";
import {
  FORM_REQUEST_LIMIT,
  formRequest,
  formatInbound,
  parseCardReply,
  parseInbound,
} from "../src/protocol/messages.js";
import { INSERT_WINDOW_MS, classify } from "../src/programs/life.js";
import { cardResult } from "../src/programs/io-demo.js";

const TRACK = `${FS}%B4111111111111111^TEST/CARD^2512101?${FS};4111111111111111=2512101?`;

describe("23.x card replies", () => {
  it("keep only the exit type and the reader letter", () => {
    expect(parseCardReply(`0M${TRACK}`)).toEqual({ exit: "0", reader: "M", letter: "M" });
    expect(parseCardReply(`0S${TRACK}`)).toEqual({ exit: "0", reader: "S", letter: "S" });
    expect(parseCardReply(`0C${TRACK}`)).toEqual({ exit: "0", reader: "C", letter: "C" });
    expect(parseCardReply(`0Z${TRACK}`)).toEqual({ exit: "0", reader: null, letter: "Z" });
    expect(parseCardReply("1")).toEqual({ exit: "1" });
    expect(parseCardReply("N")).toEqual({ exit: "N" });
    expect(parseCardReply("3\r")).toEqual({ exit: "3", keyField: "\r" });
    expect(parseCardReply("X")).toEqual({ exit: "other", code: "X" });
    expect(JSON.stringify(parseInbound(`23.0M${TRACK}`))).not.toContain("4111");
    expect(formatInbound(parseInbound(`23.0M${TRACK}`))).not.toContain("4111");
  });

  it("life: swipe / insert / tap / keys / bad reads", () => {
    const now = 1_000_000;
    const never = 0;
    const c = (body: string, lastInsert = never): ReturnType<typeof classify> =>
      classify(parseCardReply(body), lastInsert, now);
    expect(c(`0M${TRACK}`)).toEqual({ kind: "card", card: "swipe" });
    expect(c(`0S${TRACK}`)).toEqual({ kind: "card", card: "insert" });
    expect(c(`0Q${TRACK}`)).toEqual({ kind: "card", card: "insert" });
    expect(c(`0C${TRACK}`)).toEqual({ kind: "card", card: "tap" });
    expect(c(`0E${TRACK}`)).toEqual({ kind: "card", card: "tap" });
    expect(c("3\r")).toEqual({ kind: "key", key: "\r" });
    expect(c("3?\x1b")).toEqual({ kind: "key", key: "\x1b" });
    expect(c("3??")).toBeNull();
    expect(c("2")).toEqual({ kind: "key", key: "\x1b" });
    expect(c("9")).toBeNull();
    expect(c("R")).toBeNull();
    // 23.1 and the undocumented 23.N are taps...
    expect(c("1")).toEqual({ kind: "card", card: "tap" });
    expect(c("N")).toEqual({ kind: "card", card: "tap" });
    // ...except right after a chip insert, where N/1 means the card was pulled out
    expect(c("N", now - 1000)).toBeNull();
    expect(c("1", now - 1000)).toBeNull();
    expect(c("N", now - INSERT_WINDOW_MS - 1)).toEqual({ kind: "card", card: "tap" });
  });

  it("io_demo (exit, source) pairs", () => {
    expect(cardResult(parseCardReply(`0M${TRACK}`))).toEqual({ exit: "0", source: "M" });
    expect(cardResult(parseCardReply("3?\x1b"))).toEqual({ exit: "3", source: "\x1b" }); // Python r[5:6]
    expect(cardResult(parseCardReply("9"))).toEqual({ exit: "9", source: "" });
    expect(cardResult(parseCardReply("N"))).toEqual({ exit: "N", source: "" });
  });
});

describe("other replies", () => {
  it("24.x form exits carry the key", () => {
    const m = parseInbound("24.0L");
    expect(m).toEqual({ id: "24", form: { exitType: "0", keyChar: "L", key: "L", rest: "" } });
    expect(parseInbound("24.0\x08")).toMatchObject({ form: { key: "\b" } });
    expect(parseInbound("24.07")).toMatchObject({ form: { key: null, keyChar: "7" } });
  });

  it("text replies and unknown ids", () => {
    expect(parseInbound("64.0")).toEqual({ id: "64", body: "0" });
    expect(parseInbound("62.7")).toEqual({ id: "62", status: "7" });
    expect(parseInbound("99.x")).toEqual({ id: "unknown", prefix: "99.", length: 4 });
    expect(formatInbound(parseInbound("28.0"))).toBe("'28.0'");
  });
});

describe("24.x request builder", () => {
  it("adds label overrides, shown buttons and timeout in order", () => {
    expect(formRequest("BAMTV.K3Z", { texts: { PROMPTLINE1: "hi" }, showButtons: ["btnc", "btnp"], timeout: 5 })).toBe(
      `24.BAMTV.K3Z${FS}TPROMPTLINE1,hi${FS}Bbtnc,S${FS}Bbtnp,S${FS}t,5`,
    );
  });

  it("stays under 247 bytes", () => {
    const base = `24.BAMTV.K3Z${FS}TPROMPTLINE1,`.length;
    expect(formRequest("BAMTV.K3Z", { texts: { PROMPTLINE1: "x".repeat(FORM_REQUEST_LIMIT - 1 - base) } })).toHaveLength(
      FORM_REQUEST_LIMIT - 1,
    );
    expect(() => formRequest("BAMTV.K3Z", { texts: { PROMPTLINE1: "x".repeat(FORM_REQUEST_LIMIT - base) } })).toThrow(
      RangeError,
    );
    // the longest header the BAMTV games send (120 chars + all four buttons) fits
    expect(() =>
      formRequest("BAMTV.K3Z", {
        texts: { PROMPTLINE1: "x".repeat(120) },
        showButtons: ["btnc", "btnp", "btny", "btnn"],
      }),
    ).not.toThrow();
  });
});
