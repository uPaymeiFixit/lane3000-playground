/**
 * Ctrl-C handling that behaves like Python's KeyboardInterrupt: whatever the program is waiting
 * on (a reply, an ACK, a sleep) rejects with InterruptedError, so `finally` blocks still run and
 * can talk to the terminal (e.g. send 15.0) before the port closes.
 */

export class InterruptedError extends Error {
  constructor() {
    super("interrupted");
    this.name = "InterruptedError";
  }
}

type Canceller = (err: InterruptedError) => void;
const pending = new Set<Canceller>();

/** Register a wait that should be cancelled on interrupt. Returns the unregister function. */
export function onInterrupt(cancel: Canceller): () => void {
  pending.add(cancel);
  return () => {
    pending.delete(cancel);
  };
}

/** Reject every wait currently registered. Later waits are unaffected. */
export function interruptPending(): void {
  const all = [...pending];
  pending.clear();
  const err = new InterruptedError();
  for (const cancel of all) cancel(err);
}

/** setTimeout as a promise; rejects with InterruptedError on Ctrl-C. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unregister();
      resolve();
    }, Math.max(0, ms));
    const unregister = onInterrupt((err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
