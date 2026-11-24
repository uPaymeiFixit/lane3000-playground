/**
 * 62.x file write helpers: RBA eight-bit file encoding and block splitting.
 *
 * Encoding: bytes 00-1F -> FF,(b+20); FF -> FF,FF; everything else as-is. So an encoded stream
 * never contains a control byte, and every FF starts a two-byte escape pair.
 */

declare const encodedBrand: unique symbol;
declare const fileNameBrand: unique symbol;

/** Bytes in RBA eight-bit encoding (not raw file bytes). Created only by `encode8`/`splitEncoded`. */
export type Encoded8 = Uint8Array & { readonly [encodedBrand]: true };

/** A /HOST file name the terminal accepts: upper case, 1-15 characters. */
export type RbaFileName = string & { readonly [fileNameBrand]: true };

const FILE_NAME = /^[A-Z0-9_.-]{1,15}$/;

export function isRbaFileName(name: string): name is RbaFileName {
  return FILE_NAME.test(name);
}

/** Upper-case a name (as the Python driver does) and check it fits the terminal's rules. */
export function rbaFileName(name: string): RbaFileName {
  const upper = name.toUpperCase();
  if (!isRbaFileName(upper)) {
    throw new RangeError(`${JSON.stringify(name)} is not a valid RBA file name (A-Z 0-9 _ . -, at most 15)`);
  }
  return upper;
}

/** True when `bytes` is a well-formed encoded stream: no bytes < 0x20, every FF escape complete. */
export function isEncoded8(bytes: Uint8Array): bytes is Encoded8 {
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    if (b < 0x20) return false;
    if (b === 0xff) {
      const next = bytes[i + 1];
      if (next === undefined || !(next === 0xff || (next >= 0x20 && next < 0x40))) return false;
      i += 1;
    }
  }
  return true;
}

function checked(bytes: Uint8Array): Encoded8 {
  if (!isEncoded8(bytes)) throw new Error("internal error: produced a malformed eight-bit stream");
  return bytes;
}

export function encode8(data: Uint8Array): Encoded8 {
  const out = new Uint8Array(data.length * 2);
  let n = 0;
  for (const b of data) {
    if (b < 0x20) {
      out[n++] = 0xff;
      out[n++] = b + 0x20;
    } else if (b === 0xff) {
      out[n++] = 0xff;
      out[n++] = 0xff;
    } else {
      out[n++] = b;
    }
  }
  return checked(out.slice(0, n));
}

export function decode8(enc: Encoded8): Uint8Array {
  const out = new Uint8Array(enc.length);
  let n = 0;
  for (let i = 0; i < enc.length; i++) {
    const b = enc[i] ?? 0;
    if (b === 0xff) {
      const next = enc[i + 1] ?? 0;
      out[n++] = next === 0xff ? 0xff : next - 0x20;
      i += 1;
    } else {
      out[n++] = b;
    }
  }
  return out.slice(0, n);
}

/** Default 62.x block size: ~3.8 KB works over USB. */
export const BLOCK_SIZE = 3800;

/**
 * Split an encoded stream into blocks of at most `block` bytes without cutting an FF escape
 * pair in half. Always returns at least one (possibly empty) block.
 */
export function splitEncoded(enc: Encoded8, block: number = BLOCK_SIZE): Encoded8[] {
  if (!Number.isInteger(block) || block < 2) throw new RangeError("block size must be an integer >= 2");
  const pieces: Encoded8[] = [];
  let i = 0;
  while (i < enc.length) {
    let j = Math.min(enc.length, i + block);
    if (j < enc.length && enc[j - 1] === 0xff) {
      // count trailing FFs: an odd run means the last FF starts an escape pair
      let k = j - 1;
      while (k > i && enc[k - 1] === 0xff) k -= 1;
      if ((j - k) % 2 === 1) j -= 1;
    }
    pieces.push(checked(enc.slice(i, j)));
    i = j;
  }
  if (pieces.length === 0) pieces.push(checked(new Uint8Array(0)));
  return pieces;
}

/** Record type of block n of `count`: 0 = only block, 1 = first, 2 = middle, 3 = last. */
export type RecordType = "0" | "1" | "2" | "3";

export function recordType(n: number, count: number): RecordType {
  if (count === 1) return "0";
  if (n === 0) return "1";
  return n === count - 1 ? "3" : "2";
}

/** Two-digit segment number, 01..99 repeating. */
export function segmentNumber(n: number): string {
  return String((n % 99) + 1).padStart(2, "0");
}
