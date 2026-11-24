/** A byte pipe to the terminal. The real one is a USB CDC serial port; tests use a fake. */
export interface Transport {
  /** Write every byte of `data`; resolves once all of it has been handed to the OS. */
  write(data: Uint8Array): Promise<void>;
  /** Register the single receiver for incoming bytes. */
  onData(listener: (chunk: Uint8Array) => void): void;
  /** Register a listener for fatal transport errors (e.g. the USB device went away). */
  onError(listener: (err: Error) => void): void;
  close(): Promise<void>;
  /** Human-readable name, e.g. the device path. */
  readonly name: string;
}
