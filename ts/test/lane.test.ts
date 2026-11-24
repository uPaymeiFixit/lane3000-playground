import { describe, expect, it } from "bun:test";

import { decode8, isEncoded8 } from "../src/protocol/file-encoding.js";
import { FS, latin1Bytes } from "../src/protocol/framing.js";
import { Lane, LaneError } from "../src/protocol/lane.js";
import { InterruptedError, interruptPending, sleep } from "../src/util/interrupt.js";
import { FakeTerminal, flush, type Script } from "./fake-terminal.js";
import { expectRejects, rejectionOf } from "./reject.js";

const FAKE_PAN = "4111111111111111";
const FAKE_TRACK = `%B${FAKE_PAN}^TEST/CARD^25121010000000000000?`;

function lane(script: Script, opts: { ackTimeoutMs?: number; chunk?: number } = {}): {
  lane: Lane;
  term: FakeTerminal;
  log: string[];
} {
  const term = new FakeTerminal(script, opts.chunk ?? 3);
  const log: string[] = [];
  const l = new Lane(term, {
    debug: true,
    ackTimeoutMs: opts.ackTimeoutMs ?? 300,
    log: (line) => log.push(line),
  });
  return { lane: l, term, log };
}

/** Decode the data part of a 62.x block body. */
function blockData(body: string): Uint8Array {
  const rec = body.charAt(3);
  const head = 3 + 1 + 1 + 2 + 4 + 2; // "62." + rec + "8" + seg + "0000" + "10"
  const start = rec === "0" || rec === "1" ? body.indexOf(FS, head) + 1 : head;
  return latin1Bytes(body.slice(start));
}

describe("Lane over a fake terminal", () => {
  it("sends a frame, waits for the ACK, routes the reply by message id", async () => {
    const { lane: l, term } = lane((body) =>
      body === "07." ? { replies: ["24.0R", `07.INGNAR${FS}L3000${FS}x`] } : {},
    );
    expect(await l.unitData()).toEqual(["INGNAR", "L3000", "x"]);
    expect(term.received).toEqual(["07."]);
    // the 24.x that arrived first stays queued for whoever asks for it
    const r = await l.recv("24", 100);
    expect(r?.form.key).toBe("R");
    await flush();
    expect(term.hostControl).toEqual(["ack", "ack"]); // the host ACKs each terminal frame
  });

  it("resends on NAK", async () => {
    let naks = 0;
    const { lane: l, term } = lane((body) => {
      if (body === "15.0" && naks < 2) {
        naks += 1;
        return { answer: "nak" };
      }
      return {};
    });
    await l.softReset();
    expect(term.received).toEqual(["15.0", "15.0", "15.0"]);
  });

  it("resends on silence and gives up after 3 tries", async () => {
    const { lane: l, term } = lane(() => ({ answer: "silent" }), { ackTimeoutMs: 30 });
    await expectRejects(l.send("51.10"), LaneError);
    expect(term.received).toEqual(["51.10", "51.10", "51.10"]);
  });

  it("NAKs a corrupt frame from the terminal and drops it", async () => {
    const { lane: l, term } = lane(() => ({}));
    const bad = Uint8Array.of(0x02, 0x32, 0x34, 0x2e, 0x30, 0x4c, 0x03, 0x00);
    term.emitBytes(bad);
    await flush();
    expect(term.hostControl).toEqual(["nak"]);
    expect(await l.recv("24", 0)).toBeNull();
  });

  it("recv times out with null and waits for late replies", async () => {
    const { lane: l, term } = lane(() => ({}));
    expect(await l.recv("24", 20)).toBeNull();
    setTimeout(() => {
      term.emitFrame("24.0\r");
    }, 30);
    const r = await l.recv("24", 1000);
    expect(r?.form.key).toBe("\r");
  });

  it("serializes concurrent sends", async () => {
    const { lane: l, term } = lane(() => ({}));
    await Promise.all([l.send("51.00"), l.send("51.10"), l.send("51.20")]);
    expect(term.received).toEqual(["51.00", "51.10", "51.20"]);
  });

  it("writes a multi-block file with record types, segments and the name on the first block", async () => {
    const data = new Uint8Array(12_000);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 256;
    const { lane: l, term } = lane((body) => (body.startsWith("62.") ? { replies: ["62.0"] } : {}));
    const r = await l.writeFile("game.png", data);
    expect(r.status).toBe("0");
    expect(term.received.map((b) => b.slice(0, 13))).toEqual([
      "62.18010000" + "10",
      "62.28020000" + "10",
      "62.28030000" + "10",
      "62.38040000" + "10",
    ]);
    expect(term.received[0]?.slice(13, 22)).toBe(`GAME.PNG${FS}`);
    const encodedParts = term.received.map(blockData);
    for (const p of encodedParts) {
      expect(p.length).toBeLessThanOrEqual(3800);
      expect(isEncoded8(p)).toBe(true);
    }
    const joined = new Uint8Array(encodedParts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of encodedParts) {
      joined.set(p, o);
      o += p.length;
    }
    if (!isEncoded8(joined)) throw new Error("joined stream malformed");
    expect(decode8(joined)).toEqual(data); // every byte arrived
  });

  it("a single-block file uses record type 0", async () => {
    const { lane: l, term } = lane((body) => (body.startsWith("62.") ? { replies: ["62.0"] } : {}));
    await l.writeFile("GAMEBTN.PNG", Uint8Array.of(1, 2, 3));
    expect(term.received[0]?.startsWith(`62.0801000010GAMEBTN.PNG${FS}`)).toBe(true);
  });

  it("on 62.7 sends 15.6 Stop Action and retries the block", async () => {
    let locked = true;
    const { lane: l, term } = lane((body) => {
      if (body === "15.6") {
        locked = false;
        return {};
      }
      if (body.startsWith("62.")) return { replies: [locked ? "62.7" : "62.0"] };
      return {};
    });
    const r = await l.writeFile("GAME.PNG", Uint8Array.of(0x89, 0x50));
    expect(r.status).toBe("0");
    expect(term.received.map((b) => b.slice(0, 4))).toEqual(["62.0", "15.6", "62.0"]);
  });

  it("prompts 'Please remove card' once while the lock persists, then succeeds", async () => {
    let stops = 0;
    const { lane: l, term } = lane((body) => {
      if (body === "15.6") stops += 1;
      if (body.startsWith("62.")) return { replies: [stops >= 3 ? "62.0" : "62.7"] };
      return {};
    });
    await l.writeFile("GAME.PNG", Uint8Array.of(1));
    const prompts = term.received.filter((b) => b.startsWith("24.MSG.K3Z"));
    expect(prompts).toEqual([`24.MSG.K3Z${FS}TPROMPTLINE1,Please remove card`]);
    expect(stops).toBe(3);
  });

  it("fails a write that the terminal rejects", async () => {
    const { lane: l } = lane((body) => (body.startsWith("62.") ? { replies: ["62.1"] } : {}));
    await expectRejects(l.writeFile("GAME.PNG", Uint8Array.of(1)), /block 1\/1/);
  });

  it("reads text and base64 files block by block (65.x)", async () => {
    const { lane: l, term } = lane((body) => {
      if (body === "65.10/HOST/A.TXT") return { replies: [`65.02${FS}1${FS}c1${FS}0${FS}hello `] };
      if (body === "65.00/HOST/A.TXT") return { replies: [`65.02${FS}2${FS}c2${FS}0${FS}world`] };
      if (body === "65.11/HOST/B.JPG") return { replies: [`65.01${FS}1${FS}c${FS}1${FS}${Buffer.from([1, 2, 255]).toString("base64")}`] };
      if (body === "65.11/HOST/NONE") return { replies: ["65.2"] };
      return {};
    });
    expect(await l.readFile("/HOST/A.TXT")).toBe("hello world");
    expect(await l.readBinary("/HOST/B.JPG")).toEqual(Uint8Array.of(1, 2, 255));
    expect(await l.readBinary("/HOST/NONE")).toBeNull();
    expect(term.received).toContain("65.00/HOST/A.TXT");
  });

  it("stopAction drops replies that arrive in the next 300 ms (Python _pump)", async () => {
    const { lane: l } = lane((body) => (body === "15.6" ? { replies: ["23.2"] } : {}));
    await l.stopAction();
    expect(await l.recv("23", 0)).toBeNull();
  });

  it("never keeps, logs or reports card data from a 23.x reply", async () => {
    const { lane: l, term, log } = lane((body) =>
      body.startsWith("23.") ? { replies: [`23.0M${FS}${FAKE_TRACK}${FS}${FAKE_TRACK}`] } : {},
    );
    await l.send(`23.${FS}GAME.K3Z${FS}${FS}MSC`);
    await flush();
    expect(l.inboxSummary().join("")).not.toContain("4111");
    const r = await l.recv("23", 1000);
    expect(r?.card).toEqual({ exit: "0", reader: "M", letter: "M" });
    expect(JSON.stringify(r)).not.toContain("4111");
    expect(log.join("\n")).not.toContain("4111");
    expect(log.join("\n")).toContain("23.0M [card data discarded]");
    // unknown message ids (e.g. EMV messages from the terminal's own payment flow) are redacted too
    term.emitFrame(`33.02.0000${FS}T5A:08:h${FAKE_PAN}`);
    await flush();
    const any = await l.recvAny(100);
    expect(any?.id).toBe("unknown");
    expect(JSON.stringify(any) + log.join("\n")).not.toContain("4111");
  });

  it("24.x form requests over the size limit are refused before sending", async () => {
    const { lane: l, term } = lane(() => ({}));
    await expectRejects(l.showForm("BAMTV.K3Z", { texts: { PROMPTLINE1: "x".repeat(240) }, wait: false }), RangeError);
    expect(term.received).toEqual([]);
  });

  it("Ctrl-C rejects pending waits like KeyboardInterrupt, and the lane still works afterwards", async () => {
    const { lane: l, term } = lane(() => ({}));
    const waiting = l.recv("24", Number.POSITIVE_INFINITY);
    const sleeping = sleep(60_000);
    setTimeout(interruptPending, 10);
    // capture both rejections before awaiting either, so neither is reported as unhandled
    const [waitErr, sleepErr] = await Promise.all([rejectionOf(waiting), rejectionOf(sleeping)]);
    expect(waitErr).toBeInstanceOf(InterruptedError);
    expect(sleepErr).toBeInstanceOf(InterruptedError);
    await l.softReset(); // cleanup in a finally block can still talk to the terminal
    expect(term.received).toEqual(["15.0"]);
    await l.close();
    expect(term.closed).toBe(true);
    await expectRejects(l.recv("24", 10), LaneError);
  });
});
