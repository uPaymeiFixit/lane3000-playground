/**
 * The iteration order CPython (3.8+, 64-bit) gives a `set` of (int, int) tuples built by adding
 * the items one by one. coin_grab picks "the first six coins of a set", so reproducing this
 * order keeps seeded games identical to the Python version.
 *
 * Mirrors Objects/tupleobject.c tuplehash (xxHash-style) and Objects/setobject.c
 * set_add_entry / set_table_resize / set_insert_clean (LINEAR_PROBES = 9, PERTURB_SHIFT = 5).
 */

const MASK64 = (1n << 64n) - 1n;
const XXPRIME_1 = 11400714785074694791n;
const XXPRIME_2 = 14029467366897019727n;
const XXPRIME_5 = 2870177450012600261n;
const LINEAR_PROBES = 9;
const PERTURB_SHIFT = 5n;
const MINSIZE = 8;

/** hash() of a non-negative small int is the int itself; of -1 it is -2. */
function intHash(n: number): bigint {
  const h = BigInt(n === -1 ? -2 : n);
  return h & MASK64;
}

/** hash((a, b)) as an unsigned 64-bit value. */
export function tupleHash(items: readonly number[]): bigint {
  let acc = XXPRIME_5;
  for (const item of items) {
    acc = (acc + intHash(item) * XXPRIME_2) & MASK64;
    acc = ((acc << 31n) | (acc >> 33n)) & MASK64;
    acc = (acc * XXPRIME_1) & MASK64;
  }
  acc = (acc + (BigInt(items.length) ^ (XXPRIME_5 ^ 3527539n))) & MASK64;
  if (acc === MASK64) return 1546275796n;
  return acc;
}

interface Slot<T> {
  readonly key: T;
  readonly hash: bigint;
}

function insertClean<T>(table: (Slot<T> | null)[], slot: Slot<T>): void {
  const mask = BigInt(table.length - 1);
  let perturb = slot.hash;
  let i = slot.hash & mask;
  for (;;) {
    const n = Number(i);
    const probes = n + LINEAR_PROBES <= table.length - 1 ? LINEAR_PROBES : 0;
    for (let j = 0; j <= probes; j++) {
      if (table[n + j] === null) {
        table[n + j] = slot;
        return;
      }
    }
    perturb >>= PERTURB_SHIFT;
    i = (i * 5n + 1n + perturb) & mask;
  }
}

/** Items in the order `list(set(items))` returns them (duplicates by `same` are dropped). */
export function pySetOrder<T>(
  items: readonly T[],
  hash: (item: T) => bigint,
  same: (a: T, b: T) => boolean,
): T[] {
  let table: (Slot<T> | null)[] = Array.from({ length: MINSIZE }, () => null);
  let fill = 0;
  for (const key of items) {
    const h = hash(key);
    const mask = BigInt(table.length - 1);
    let perturb = h;
    let i = h & mask;
    let placed = false;
    let duplicate = false;
    while (!placed && !duplicate) {
      const n = Number(i);
      const probes = n + LINEAR_PROBES <= table.length - 1 ? LINEAR_PROBES : 0;
      for (let j = 0; j <= probes; j++) {
        const entry = table[n + j];
        if (entry === undefined) break;
        if (entry === null) {
          table[n + j] = { key, hash: h };
          placed = true;
          break;
        }
        if (entry.hash === h && same(entry.key, key)) {
          duplicate = true;
          break;
        }
      }
      perturb >>= PERTURB_SHIFT;
      i = (i * 5n + 1n + perturb) & mask;
    }
    if (duplicate) continue;
    fill += 1;
    if (fill * 5 >= (table.length - 1) * 3) {
      const used = fill; // no deletions, so fill == used
      let size = MINSIZE;
      while (size <= used * 4) size <<= 1;
      const old = table;
      table = Array.from({ length: size }, () => null);
      for (const slot of old) if (slot !== null) insertClean(table, slot);
    }
  }
  const out: T[] = [];
  for (const slot of table) if (slot !== null) out.push(slot.key);
  return out;
}
