/**
 * Host-side driver for an Ingenico terminal running RBA (Retail Base Application).
 *
 * Bytes arrive asynchronously from the transport; the receive layer parses frames, ACKs each
 * good one (NAKs a bad LRC), classifies it into an `Inbound` message (card data is dropped right
 * there, see messages.ts) and either hands it to whoever is waiting for that message id or
 * queues it in the inbox. `send` writes a frame and waits for the terminal's ACK, resending on
 * NAK or silence.
 */

import { onInterrupt, sleep } from "../util/interrupt.js";
import { pyRepr } from "../util/py-repr.js";
import {
  BLOCK_SIZE,
  encode8,
  rbaFileName,
  recordType,
  segmentNumber,
  splitEncoded,
} from "./file-encoding.js";
import { ACK, FS, FrameParser, NAK, encodeFrame, latin1Text } from "./framing.js";
import {
  formRequest,
  formatInbound,
  isMessageId,
  parseInbound,
  type FormExit,
  type Inbound,
  type InboundOf,
  type MessageId,
  type Outbound,
} from "./messages.js";
import type { Transport } from "./transport.js";

export class LaneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LaneError";
  }
}

export interface LaneOptions {
  /** Print every message sent and received (card replies are redacted). */
  readonly debug?: boolean;
  /** How long to wait for the terminal's ACK before resending (Python: 2 s). */
  readonly ackTimeoutMs?: number;
  /** Debug output sink (default: console.log). */
  readonly log?: (line: string) => void;
}

interface Waiter {
  /** Take the message if it matches; returns whether it was taken. */
  readonly offer: (m: Inbound) => boolean;
  readonly fail: (err: Error) => void;
}

type AckResult = "ack" | "nak" | "timeout";

/** True if `id` is the message id `body` starts with (the `${I}.` prefix). */
function isIdOf<I extends MessageId>(body: `${I}.${string}`, id: string): id is I {
  return isMessageId(id) && body.startsWith(`${id}.`);
}

function idOf<I extends MessageId>(body: `${I}.${string}`): I {
  const id = body.slice(0, 2);
  if (!isIdOf(body, id)) throw new LaneError(`not an RBA message: ${pyRepr(body.slice(0, 3))}`);
  return id;
}

function isInbound(m: unknown): m is Inbound {
  return typeof m === "object" && m !== null && "id" in m;
}

function isInboundOf<I extends MessageId>(m: Inbound, id: I): m is InboundOf<I> {
  return m.id === id;
}

export class Lane {
  readonly port: string;
  private readonly parser = new FrameParser();
  private readonly inbox: Inbound[] = [];
  private readonly waiters = new Set<Waiter>();
  private ackListener: ((r: "ack" | "nak") => void) | null = null;
  private sendQueue: Promise<unknown> = Promise.resolve();
  private discardUntil = 0;
  private fatal: Error | null = null;
  private closed = false;
  private readonly debug: boolean;
  private readonly ackTimeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly transport: Transport,
    options: LaneOptions = {},
  ) {
    this.port = transport.name;
    this.debug = options.debug ?? false;
    this.ackTimeoutMs = options.ackTimeoutMs ?? 2000;
    this.log =
      options.log ??
      ((line: string) => {
        console.log(line);
      });
    transport.onData((chunk) => {
      this.receive(chunk);
    });
    transport.onError((err) => {
      this.failAll(err);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new LaneError("port closed"));
    await this.transport.close();
  }

  // ---- receive layer ------------------------------------------------------------------

  private receive(chunk: Uint8Array): void {
    for (const ev of this.parser.push(chunk)) {
      switch (ev.kind) {
        case "ack":
        case "nak": {
          const listener = this.ackListener;
          if (listener !== null) {
            this.ackListener = null;
            listener(ev.kind);
          }
          break;
        }
        case "frame":
          this.writeControl(ACK);
          this.deliver(parseInbound(ev.body));
          break;
        case "corrupt":
          this.writeControl(NAK);
          break;
        default: {
          const unreachable: never = ev;
          throw new LaneError(`unexpected frame event ${JSON.stringify(unreachable)}`);
        }
      }
    }
  }

  private writeControl(byte: number): void {
    this.transport.write(Uint8Array.of(byte)).catch((err: unknown) => {
      this.failAll(err instanceof Error ? err : new LaneError(String(err)));
    });
  }

  private deliver(m: Inbound): void {
    if (Date.now() < this.discardUntil) {
      if (this.debug) this.log(`  <- ${formatInbound(m)} (discarded)`);
      return;
    }
    if (this.debug) this.log(`  <- ${formatInbound(m)}`);
    for (const w of this.waiters) {
      if (w.offer(m)) return;
    }
    this.inbox.push(m);
  }

  private failAll(err: Error): void {
    this.fatal ??= err;
    const all = [...this.waiters];
    this.waiters.clear();
    for (const w of all) w.fail(err);
    const listener = this.ackListener;
    this.ackListener = null;
    if (listener !== null) listener("nak");
  }

  /** Take the first queued message matching `guard`, waiting up to `timeoutMs` for one. */
  private take<T extends Inbound>(guard: (m: Inbound) => m is T, timeoutMs: number): Promise<T | null> {
    for (let i = 0; i < this.inbox.length; i++) {
      const m = this.inbox[i];
      if (m !== undefined && guard(m)) {
        this.inbox.splice(i, 1);
        return Promise.resolve(m);
      }
    }
    if (this.fatal !== null) return Promise.reject(this.fatal);
    if (timeoutMs <= 0) return Promise.resolve(null);
    return new Promise<T | null>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const cleanup = (): void => {
        this.waiters.delete(waiter);
        unregister();
        if (timer !== undefined) clearTimeout(timer);
      };
      const waiter: Waiter = {
        offer: (m) => {
          if (!guard(m)) return false;
          cleanup();
          resolve(m);
          return true;
        },
        fail: (err) => {
          cleanup();
          reject(err);
        },
      };
      const unregister = onInterrupt((err) => {
        waiter.fail(err);
      });
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, timeoutMs);
      }
      this.waiters.add(waiter);
    });
  }

  /** Wait for a message with this id (Python: `recv(prefix, timeout)`). */
  recv<I extends MessageId>(id: I, timeoutMs = 5000): Promise<InboundOf<I> | null> {
    return this.take((m): m is InboundOf<I> => isInboundOf(m, id), timeoutMs);
  }

  /** Wait for any message (Python: `recv(None, timeout)`). */
  recvAny(timeoutMs = 5000): Promise<Inbound | null> {
    return this.take(isInbound, timeoutMs);
  }

  /** Wait `ms`, discarding whatever arrives meanwhile (Python: `_pump(timeout)`). */
  async drain(ms: number): Promise<void> {
    this.discardUntil = Math.max(this.discardUntil, Date.now() + ms);
    await sleep(ms);
  }

  /** Card-data-free summaries of the queued messages. */
  inboxSummary(): string[] {
    return this.inbox.map(formatInbound);
  }

  clearInbox(): void {
    this.inbox.length = 0;
  }

  /** Keep only the queued messages that pass `keep`. */
  retainInbox(keep: (m: Inbound) => boolean): void {
    const kept = this.inbox.filter(keep);
    this.inbox.length = 0;
    this.inbox.push(...kept);
  }

  // ---- send ---------------------------------------------------------------------------

  private waitAck(): Promise<AckResult> {
    return new Promise<AckResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackListener = null;
        unregister();
        resolve("timeout");
      }, this.ackTimeoutMs);
      const unregister = onInterrupt((err) => {
        clearTimeout(timer);
        this.ackListener = null;
        reject(err);
      });
      this.ackListener = (r) => {
        clearTimeout(timer);
        unregister();
        resolve(r);
      };
    });
  }

  /** Send one message and wait for the terminal's ACK; resend on NAK or silence. */
  send(body: Outbound, retries = 3): Promise<void> {
    const run = async (): Promise<void> => {
      const frame = encodeFrame(body);
      for (let attempt = 0; attempt < retries; attempt++) {
        if (this.fatal !== null) throw this.fatal;
        if (this.debug) this.log(`  -> ${pyRepr(body)}`);
        const ack = this.waitAck(); // listen before writing: the ACK can beat the write callback
        try {
          await this.transport.write(frame);
        } catch (err: unknown) {
          this.ackListener = null;
          throw err;
        }
        if ((await ack) === "ack") return;
      }
      throw new LaneError(`Terminal did not ACK ${pyRepr(body.slice(0, 20))}`);
    };
    const result = this.sendQueue.then(run, run);
    this.sendQueue = result.catch(() => undefined);
    return result;
  }

  /** Send and wait for the reply with the same message id. */
  async request<I extends MessageId>(body: `${I}.${string}`, timeoutMs = 5000): Promise<InboundOf<I> | null> {
    const id = idOf(body);
    await this.send(body);
    return this.recv(id, timeoutMs);
  }

  // ---- RBA messages -------------------------------------------------------------------

  /** 07.x Unit Data: the response fields (maker, model, ...). */
  async unitData(): Promise<string[] | null> {
    const r = await this.request("07.");
    return r === null ? null : r.body.split(FS);
  }

  /** 65.x Retrieve File Contents as text. Path like '/HOST/OFFLINE.K3Z'. */
  async readFile(path: string): Promise<string | null> {
    const out: string[] = [];
    let first = true;
    for (;;) {
      const r = await this.request(`65.${first ? "1" : "0"}0${path}`);
      first = false;
      if (r?.file.ok !== true) return out.length === 0 ? null : out.join("");
      out.push(r.file.data);
      if (r.file.block >= r.file.total) return out.join("");
    }
  }

  /** 65.x with base64 transfer, for binary files such as images. */
  async readBinary(path: string): Promise<Uint8Array | null> {
    const chunks: string[] = [];
    let first = true;
    for (;;) {
      const r = await this.request(`65.${first ? "1" : "0"}1${path}`, 10_000);
      first = false;
      if (r?.file.ok !== true) return null;
      chunks.push(r.file.data);
      if (r.file.block >= r.file.total) return new Uint8Array(Buffer.from(chunks.join(""), "base64"));
    }
  }

  /**
   * 62.7 = uploads locked since a card read (23.x) was armed. 15.6 Stop Action clears it (15.0 and
   * 10.x don't), but not while a chip card is still in the slot: then show a 'remove card' prompt
   * on a stock form (no upload needed) and keep retrying for up to `waitMs`.
   */
  private async unlockAndRetry(body: `62.${string}`, waitMs = 30_000): Promise<InboundOf<"62"> | null> {
    const deadline = Date.now() + waitMs;
    let prompted = false;
    for (;;) {
      await this.stopAction();
      const r = await this.request(body, 15_000);
      if (r?.status !== "7" || Date.now() > deadline) return r;
      if (!prompted) {
        await this.send(formRequest("MSG.K3Z", { texts: { PROMPTLINE1: "Please remove card" } }));
        prompted = true;
      }
      await sleep(500);
    }
  }

  /**
   * 62.x File Write to /HOST, as-is (no unpacking). The name is upper-cased and must be <= 15
   * characters. Images take effect immediately; .K3Z/.PGZ/.TGZ files need a reboot.
   */
  async writeFile(name: string, data: Uint8Array, block: number = BLOCK_SIZE): Promise<InboundOf<"62">> {
    const fileName = rbaFileName(name);
    const pieces = splitEncoded(encode8(data), block);
    let last: InboundOf<"62"> | null = null;
    for (const [n, piece] of pieces.entries()) {
      const rec = recordType(n, pieces.length);
      // 62.<record type>8<segment>0000 then "1" (write as-is, no unpacking) and "0"
      let head: `62.${string}` = `62.${rec}8${segmentNumber(n)}000010`;
      if (rec === "0" || rec === "1") head = `${head}${fileName}${FS}`;
      const body: `62.${string}` = `${head}${latin1Text(piece)}`;
      let r = await this.request(body, 15_000);
      if (r !== null && r.status === "7" && n === 0) r = await this.unlockAndRetry(body);
      if (r?.status !== "0") {
        throw new LaneError(
          `File write failed at block ${n + 1}/${pieces.length}: ${r === null ? "None" : formatInbound(r)}`,
        );
      }
      last = r;
    }
    if (last === null) throw new LaneError("File write sent no blocks");
    return last;
  }

  /**
   * 24.x Form Entry: show a .K3Z form, override text elements {id: text}.
   * Resolves to the form's exit once a key closes it, or null when `wait` is false.
   */
  async showForm(
    form: string,
    options: {
      readonly texts?: Readonly<Record<string, string>>;
      readonly timeout?: number;
      readonly wait?: boolean;
      readonly waitTimeoutMs?: number;
    } = {},
  ): Promise<FormExit | null> {
    const req: { texts?: Readonly<Record<string, string>>; timeout?: number } = {};
    if (options.texts !== undefined) req.texts = options.texts;
    if (options.timeout !== undefined) req.timeout = options.timeout;
    await this.send(formRequest(form, req));
    if (options.wait === false) return null;
    const r = await this.recv("24", options.waitTimeoutMs ?? Number.POSITIVE_INFINITY);
    return r === null ? null : r.form;
  }

  /** 70.x Update Form Element (ACKed but does not redraw labels on our unit). */
  async update(texts: Readonly<Record<string, string>>): Promise<void> {
    await this.send(`70.${Object.entries(texts).map(([k, v]) => `T${k},${v}`).join(FS)}`);
  }

  /** 51.x Beep on demand. */
  async beep(tone: 0 | 1 | 2 | 3 = 1, duration: 0 | 1 | 2 = 1): Promise<void> {
    await this.send(`51.${tone}${duration}`);
  }

  /** 15.0 Soft Reset: cancel on-demand screens and go back to the idle screen. */
  async softReset(): Promise<void> {
    await this.send("15.0");
  }

  /** 15.6 Stop Action. Also lifts the upload lock (62.7) left by any 23.x card read. */
  async stopAction(): Promise<void> {
    await this.send("15.6");
    await this.drain(300);
  }

  /** 00.x Offline: show the 'lane closed' screen. */
  async offline(): Promise<void> {
    await this.request("00.0000", 3000);
  }
}

