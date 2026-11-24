import { expect } from "bun:test";

/**
 * Await a promise that must reject and return what it rejected with.
 *
 * bun:test types `expect(p).rejects.*` as returning void, so `await expect(p).rejects...` trips
 * the strict lint rules; awaiting the promise ourselves keeps the assertions fully typed.
 * Capture every rejection you expect before awaiting any of them, or Bun reports the others as
 * unhandled.
 */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err: unknown) {
    return err;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

type ErrorClass = abstract new (...args: never[]) => Error;

/** Expect `promise` to reject with an instance of `want`, or an Error whose message matches. */
export async function expectRejects(promise: Promise<unknown>, want: ErrorClass | RegExp): Promise<void> {
  const err = await rejectionOf(promise);
  if (want instanceof RegExp) {
    expect(err).toBeInstanceOf(Error);
    expect(err instanceof Error ? err.message : "").toMatch(want);
  } else {
    expect(err).toBeInstanceOf(want);
  }
}
