/**
 * Python's `random.Random`: MT19937 with CPython's seeding and its random(), randint(), choice()
 * and shuffle() algorithms. A seeded game (e.g. `maze --preview`, seed 3) therefore produces
 * exactly the same board as the Python version.
 */

import { randomBytes } from "node:crypto";

const N = 624;
const M = 397;

/** Any value except undefined (so a missing array element can be told apart). */
export type Defined = object | string | number | boolean | bigint | symbol | null;

/** The random-number interface the games use (a subset of Python's `random.Random`). */
export interface Rng {
  /** Float in [0, 1). */
  random(): number;
  /** Integer in [a, b], both inclusive. */
  randint(a: number, b: number): number;
  choice<T extends Defined>(items: readonly T[]): T;
  shuffle(items: unknown[]): void;
}

export class PyRandom implements Rng {
  private readonly mt = new Uint32Array(N);
  private index = N + 1;

  /** Seed with a non-negative integer like `random.Random(seed)`; omit for an OS-random seed. */
  constructor(seed?: number | bigint) {
    if (seed === undefined) {
      const bytes = randomBytes(16);
      this.seedArray([bytes.readUInt32LE(0), bytes.readUInt32LE(4), bytes.readUInt32LE(8), bytes.readUInt32LE(12)]);
    } else {
      let n = typeof seed === "bigint" ? seed : BigInt(Math.trunc(seed));
      if (n < 0n) n = -n;
      const key: number[] = [];
      while (n > 0n) {
        key.push(Number(n & 0xffffffffn));
        n >>= 32n;
      }
      if (key.length === 0) key.push(0);
      this.seedArray(key);
    }
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = mt[i - 1] ?? 0;
      mt[i] = (Math.imul(1812433253, prev ^ (prev >>> 30)) + i) >>> 0;
    }
    this.index = N;
  }

  private seedArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = mt[i - 1] ?? 0;
      mt[i] = (((mt[i] ?? 0) ^ Math.imul(prev ^ (prev >>> 30), 1664525)) + (key[j] ?? 0) + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] ?? 0;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = mt[i - 1] ?? 0;
      mt[i] = (((mt[i] ?? 0) ^ Math.imul(prev ^ (prev >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] ?? 0;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  private nextUint32(): number {
    const mt = this.mt;
    if (this.index >= N) {
      for (let kk = 0; kk < N; kk++) {
        const y = ((mt[kk] ?? 0) & 0x80000000) | ((mt[(kk + 1) % N] ?? 0) & 0x7fffffff);
        mt[kk] = ((mt[(kk + M) % N] ?? 0) ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0)) >>> 0;
      }
      this.index = 0;
    }
    let y = mt[this.index++] ?? 0;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.nextUint32() >>> 5;
    const b = this.nextUint32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** getrandbits(k) for 0 <= k <= 32. */
  private getrandbits(k: number): number {
    if (k === 0) return 0;
    return this.nextUint32() >>> (32 - k);
  }

  /** CPython `_randbelow_with_getrandbits`. */
  private randbelow(n: number): number {
    if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new RangeError(`randbelow(${n})`);
    const k = 32 - Math.clz32(n);
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  randint(a: number, b: number): number {
    const width = b + 1 - a;
    if (width <= 0) throw new RangeError(`empty range for randint(${a}, ${b})`);
    return a + this.randbelow(width);
  }

  choice<T extends Defined>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError("Cannot choose from an empty sequence");
    const item = items[this.randbelow(items.length)];
    if (item === undefined) throw new RangeError("choice index out of range");
    return item;
  }

  shuffle(items: unknown[]): void {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.randbelow(i + 1);
      const tmp = items[i];
      items[i] = items[j];
      items[j] = tmp;
    }
  }
}
