/**
 * The real transport: the terminal's USB CDC serial port, plus port discovery and the
 * wait-for-reboot helper.
 *
 * Bun can't load the `serialport` package (its native binding calls libuv's uv_default_loop,
 * which Bun doesn't implement: oven-sh/bun#18546), so this talks to the device file directly,
 * like the Python driver: open it, put it in raw mode with `stty` while it is open (the shell
 * equivalent of Python's termios/tty.setraw), then read and write bytes. CDC ignores the baud
 * rate, but raw mode matters.
 */

import { closeSync, constants, openSync, readdirSync } from "node:fs";
import { read, write } from "node:fs";
import { promisify } from "node:util";

import { InterruptedError, sleep } from "../util/interrupt.js";
import { Lane, LaneError, type LaneOptions } from "./lane.js";
import type { Transport } from "./transport.js";

const readAsync = promisify(read);
const writeAsync = promisify(write);

/**
 * Raw 8-bit, no echo or line editing, 115200 baud. `min 0 time 1`: a read returns as soon as a
 * byte arrives, or after 0.1 s with nothing, so the read loop can notice close().
 */
const STTY_ARGS = ["raw", "-echo", "-echoe", "-echok", "-echoctl", "-echoke", "115200", "min", "0", "time", "1"];

function setRawMode(path: string): void {
  const flag = process.platform === "darwin" ? "-f" : "-F";
  const result = Bun.spawnSync(["stty", flag, path, ...STTY_ARGS], { stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new LaneError(`stty failed on ${path}: ${result.stderr.toString().trim()}`);
  }
}

export class SerialTransport implements Transport {
  private closed = false;
  private dataListener: ((chunk: Uint8Array) => void) | null = null;
  private errorListener: ((err: Error) => void) | null = null;
  private readonly reading: Promise<void>;

  private constructor(
    private readonly fd: number,
    readonly name: string,
  ) {
    this.reading = this.readLoop();
  }

  static open(path: string): Promise<SerialTransport> {
    // O_NOCTTY: don't let the port become our controlling terminal. Blocking fd; the stty
    // "min 0 time 1" setting bounds each read to 0.1 s.
    const fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
    try {
      setRawMode(path); // applies to the open device; stays in force while our fd is open
    } catch (err: unknown) {
      closeSync(fd);
      return Promise.reject(err instanceof Error ? err : new LaneError(String(err)));
    }
    return Promise.resolve(new SerialTransport(fd, path));
  }

  /** A method, not a field read, so TypeScript doesn't assume it can't change across an await. */
  private isOpen(): boolean {
    return !this.closed;
  }

  private async readLoop(): Promise<void> {
    const buf = new Uint8Array(4096);
    while (this.isOpen()) {
      let n: number;
      try {
        ({ bytesRead: n } = await readAsync(this.fd, buf, 0, buf.length, null));
      } catch (err: unknown) {
        if (this.isOpen()) this.errorListener?.(err instanceof Error ? err : new LaneError(String(err)));
        return;
      }
      if (n > 0) this.dataListener?.(buf.slice(0, n));
    }
  }

  async write(data: Uint8Array): Promise<void> {
    // Loop until the kernel has taken every byte: a single write may be partial on a big frame.
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await writeAsync(this.fd, data, offset, data.length - offset, null);
      offset += bytesWritten;
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListener = listener;
  }

  onError(listener: (err: Error) => void): void {
    this.errorListener = listener;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reading; // the 0.1 s read timeout lets the loop exit before the fd is closed
    closeSync(this.fd);
  }
}

/** USB vendor id of Ingenico ("Lane3000" product), as ioreg prints it (0x0b00). */
export const INGENICO_VENDOR_ID = 2816;

/** USB serial device nodes: /dev/cu.usbmodem* (macOS) then /dev/ttyACM* (Linux), sorted. */
export function devicePorts(): string[] {
  let names: string[];
  try {
    names = readdirSync("/dev");
  } catch {
    return [];
  }
  const mac = names.filter((n) => n.startsWith("cu.usbmodem")).sort();
  const linux = names.filter((n) => n.startsWith("ttyACM")).sort();
  return [...mac, ...linux].map((n) => `/dev/${n}`);
}

/**
 * macOS: serial ports that belong to an Ingenico USB device, from the IORegistry. Each top-level
 * USB device in `ioreg -c IOUSBHostDevice` lists its interfaces' serial nodes beneath it.
 */
export function ingenicoPortsFromIoreg(ioregOutput: string): string[] {
  const devices = ioregOutput.split(/^\+-o /m);
  const ports: string[] = [];
  for (const device of devices) {
    if (!new RegExp(`"idVendor" = ${INGENICO_VENDOR_ID}\\b`).test(device)) continue;
    for (const m of device.matchAll(/"IOCalloutDevice" = "([^"]+)"/g)) {
      const path = m[1];
      if (path !== undefined && !ports.includes(path)) ports.push(path);
    }
  }
  return ports;
}

/**
 * Ports to try, in order. When the USB descriptors show an Ingenico device, only its ports are
 * returned, so nothing is ever written to another USB serial device (e.g. a headset that also
 * shows up as cu.usbmodem*). Without descriptor info, every device port is a candidate.
 */
export function candidatePorts(): Promise<string[]> {
  const ports = devicePorts();
  let ingenico: string[] = [];
  if (process.platform === "darwin") {
    const result = Bun.spawnSync(["ioreg", "-r", "-l", "-w0", "-c", "IOUSBHostDevice"], { stderr: "ignore" });
    if (result.exitCode === 0) ingenico = ingenicoPortsFromIoreg(result.stdout.toString());
  }
  const preferred = ports.filter((p) => ingenico.includes(p));
  return Promise.resolve(preferred.length > 0 ? preferred : ports);
}

/** Does a 07. unit-data reply identify an Ingenico Lane/3000? */
export function looksLikeLane(fields: readonly string[]): boolean {
  return fields.some((f) => f.includes("INGNAR") || f.includes("L3000"));
}

export interface ConnectOptions extends LaneOptions {
  /** Use this port as-is, without probing. */
  readonly port?: string;
}

/**
 * Open the terminal. With no explicit port, try each candidate (Ingenico USB devices first, see
 * candidatePorts) and keep the first whose `07.` answers INGNAR / L3000.
 */
export async function connect(options: ConnectOptions = {}): Promise<Lane> {
  if (options.port !== undefined) return new Lane(await SerialTransport.open(options.port), options);
  const ports = await candidatePorts();
  if (ports.length === 0) throw new LaneError("No terminal found on /dev/cu.usbmodem* - is it plugged in?");
  const tried: string[] = [];
  for (const path of ports) {
    let lane: Lane | null = null;
    try {
      lane = new Lane(await SerialTransport.open(path), options);
      const info = await lane.unitData();
      if (info !== null && looksLikeLane(info)) return lane;
      tried.push(`${path}: not a Lane/3000`);
    } catch (err: unknown) {
      tried.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await lane?.close();
  }
  throw new LaneError(`No Lane/3000 answered 07. (${tried.join("; ")})`);
}

/** Open the terminal, run `body`, and always close the port. */
export async function withLane<T>(body: (lane: Lane) => Promise<T>, options: ConnectOptions = {}): Promise<T> {
  const lane = await connect(options);
  try {
    return await body(lane);
  } finally {
    await lane.close();
  }
}

/** After a reboot (97.) the USB port disappears and comes back; wait until RBA answers again. */
export async function waitForTerminal(timeoutMs = 180_000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  await sleep(5000);
  while (Date.now() < deadline) {
    if (devicePorts().some((p) => p.startsWith("/dev/cu.usbmodem"))) {
      try {
        const info = await withLane(async (lane) => {
          await lane.drain(500);
          return lane.unitData();
        });
        if (info !== null) return info;
      } catch (err: unknown) {
        if (err instanceof InterruptedError) throw err; // Ctrl-C; anything else = not ready yet
      }
    }
    await sleep(2000);
  }
  throw new LaneError("Terminal did not come back after reboot.");
}
