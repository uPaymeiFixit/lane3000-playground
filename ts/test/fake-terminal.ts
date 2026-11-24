/** A scripted stand-in for the terminal, speaking real RBA framing over the Transport interface. */

import { ACK, FrameParser, NAK, encodeFrame } from "../src/protocol/framing.js";
import type { Transport } from "../src/protocol/transport.js";

export interface Reaction {
  /** What the terminal answers the frame with (default "ack"). */
  readonly answer?: "ack" | "nak" | "silent";
  /** Frames the terminal sends afterwards. */
  readonly replies?: readonly string[];
}

export type Script = (body: string, terminal: FakeTerminal) => Reaction | undefined;

export class FakeTerminal implements Transport {
  readonly name = "fake";
  /** Every frame body the host sent, in order (including resends). */
  readonly received: string[] = [];
  /** ACK / NAK bytes the host sent in answer to our frames. */
  readonly hostControl: ("ack" | "nak")[] = [];
  /** Total bytes the host wrote. */
  bytesWritten = 0;
  private listener: ((chunk: Uint8Array) => void) | null = null;
  private readonly parser = new FrameParser();
  closed = false;

  constructor(
    private readonly script: Script = () => ({}),
    /** Deliver our bytes in chunks of at most this many (exercises partial reads). */
    private readonly chunk = 3,
  ) {}

  write(data: Uint8Array): Promise<void> {
    this.bytesWritten += data.length;
    for (const ev of this.parser.push(data)) {
      if (ev.kind === "ack" || ev.kind === "nak") this.hostControl.push(ev.kind);
      else if (ev.kind === "frame") {
        this.received.push(ev.body);
        const reaction = this.script(ev.body, this) ?? {};
        const answer = reaction.answer ?? "ack";
        if (answer !== "silent") this.emitBytes(Uint8Array.of(answer === "ack" ? ACK : NAK));
        for (const r of reaction.replies ?? []) this.emitFrame(r);
      }
    }
    return Promise.resolve();
  }

  /** Send a framed message to the host, split into small chunks. */
  emitFrame(body: string): void {
    this.emitBytes(encodeFrame(body));
  }

  emitBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i += this.chunk) {
      const part = bytes.slice(i, i + this.chunk);
      setImmediate(() => {
        this.listener?.(part);
      });
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.listener = listener;
  }

  onError(): void {
    // the fake never fails
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Resolve after pending setImmediate callbacks have run. */
export function flush(rounds = 50): Promise<void> {
  return new Promise((resolve) => {
    let n = 0;
    const tick = (): void => {
      n += 1;
      if (n >= rounds) resolve();
      else setImmediate(tick);
    };
    setImmediate(tick);
  });
}
