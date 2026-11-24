/**
 * RBA serial framing:  STX + body + ETX + LRC   (LRC = XOR of every byte after STX, ETX included).
 * The terminal ACKs (0x06) or NAKs (0x15) each frame; its own replies are frames the host ACKs.
 * Message text maps to bytes one-to-one as latin-1.
 */

export const STX = 0x02;
export const ETX = 0x03;
export const ACK = 0x06;
export const NAK = 0x15;
/** Field separator inside message bodies. */
export const FS = "\x1c";

export function lrc(data: Uint8Array): number {
  let v = 0;
  for (const b of data) v ^= b;
  return v;
}

/** Latin-1 bytes for a message string (every char must be U+0000..U+00FF). */
export function latin1Bytes(text: string): Uint8Array {
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 0xff) throw new RangeError(`character at ${i} is not latin-1`);
  }
  return Buffer.from(text, "latin1");
}

export function latin1Text(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
}

/** Frame one message body: STX + body + ETX + LRC. */
export function encodeFrame(body: string): Uint8Array {
  const text = latin1Bytes(body);
  const out = new Uint8Array(text.length + 3);
  out[0] = STX;
  out.set(text, 1);
  out[text.length + 1] = ETX;
  out[text.length + 2] = lrc(out.subarray(1, text.length + 2));
  return out;
}

/** What the parser pulled out of the byte stream. `corrupt` = a frame whose LRC did not match. */
export type FrameEvent =
  | { readonly kind: "ack" }
  | { readonly kind: "nak" }
  | { readonly kind: "frame"; readonly body: string }
  | { readonly kind: "corrupt" };

/**
 * Incremental parser: feed it chunks as they arrive (frames may be split anywhere, or several
 * may arrive in one chunk). Stray bytes outside a frame are skipped, as in the Python driver.
 */
export class FrameParser {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): FrameEvent[] {
    if (chunk.length > 0) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    }
    const events: FrameEvent[] = [];
    let i = 0;
    while (i < this.buf.length) {
      const b = this.buf[i];
      if (b === ACK || b === NAK) {
        events.push({ kind: b === ACK ? "ack" : "nak" });
        i += 1;
      } else if (b === STX) {
        const end = this.buf.indexOf(ETX, i + 1);
        if (end === -1 || this.buf.length < end + 2) break; // incomplete: wait for more bytes
        const payload = this.buf.subarray(i + 1, end + 1); // body + ETX
        const check = this.buf[end + 1];
        events.push(
          lrc(payload) === check
            ? { kind: "frame", body: latin1Text(payload.subarray(0, payload.length - 1)) }
            : { kind: "corrupt" },
        );
        // Overwrite consumed frame bytes so no copy of a reply (which may hold card data)
        // lingers in this buffer.
        this.buf.fill(0, i, end + 2);
        i = end + 2;
      } else {
        i += 1; // stray byte
      }
    }
    this.buf = this.buf.slice(i);
    return events;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get pending(): number {
    return this.buf.length;
  }
}
