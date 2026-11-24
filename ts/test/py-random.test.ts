import { describe, expect, it } from "bun:test";

import { PyRandom } from "../src/util/py-random.js";

// Reference values from CPython 3.13 `random.Random(seed)`.
describe("PyRandom matches CPython's random.Random", () => {
  it("seed 3: random, randint, choice, shuffle", () => {
    const r = new PyRandom(3);
    expect([r.random(), r.random(), r.random()]).toEqual([
      0.23796462709189137, 0.5442292252959519, 0.36995516654807925,
    ]);
    expect([0, 1, 2, 3, 4].map(() => r.randint(0, 18))).toEqual([15, 18, 2, 0, 15]);
    expect(r.choice(["a", "b", "c", "d", "e"])).toBe("c");
    const l = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    r.shuffle(l);
    expect(l).toEqual([2, 0, 1, 6, 4, 7, 5, 9, 3, 8]);
  });

  it("multi-word and zero seeds", () => {
    expect(new PyRandom(2n ** 40n + 5n).random()).toBe(0.5043802970418443);
    expect(new PyRandom(0).random()).toBe(0.8444218515250481);
  });
});
