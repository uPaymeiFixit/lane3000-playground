/**
 * The real transport: the terminal's USB CDC serial port (raw 8N1; CDC ignores the baud rate,
 * but raw mode matters), plus port discovery and the wait-for-reboot helper.
 */

import { readdirSync } from "node:fs";
import { SerialPort } from "serialport";

import { InterruptedError, sleep } from "../util/interrupt.js";
import { Lane, LaneError, type LaneOptions } from "./lane.js";
import type { Transport } from "./transport.js";

export class SerialTransport implements Transport {
  private constructor(private readonly port: SerialPort) {}

  get name(): string {
    return this.port.path;
  }

  static open(path: string): Promise<SerialTransport> {
    return new Promise<SerialTransport>((resolve, reject) => {
      const port = new SerialPort({
        path,
        baudRate: 115_200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        rtscts: false,
        xon: false,
        xoff: false,
        autoOpen: false,
      });
      port.open((err) => {
        if (err) reject(err);
        else resolve(new SerialTransport(port));
      });
    });
  }

  write(data: Uint8Array): Promise<void> {
    // The binding writes the whole buffer (it loops over partial writes on the non-blocking
    // fd) before calling back, so a big frame is never cut short.
    return new Promise<void>((resolve, reject) => {
      this.port.write(Buffer.from(data), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.port.on("data", (chunk: unknown) => {
      if (chunk instanceof Uint8Array) listener(chunk);
    });
  }

  onError(listener: (err: Error) => void): void {
    this.port.on("error", listener);
    this.port.on("close", () => {
      listener(new LaneError(`${this.port.path} closed`));
    });
  }

  close(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (!this.port.isOpen) {
        resolve();
        return;
      }
      this.port.close(() => {
        resolve();
      });
    });
  }
}

/** USB vendor id of Ingenico ("Lane3000" product). */
export const INGENICO_VENDOR_ID = "0b00";

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
 * Ports to try, in order. When the USB descriptors show an Ingenico device, only its ports are
 * returned, so nothing is ever written to another USB serial device (e.g. a headset that also
 * shows up as cu.usbmodem*). Without descriptor info, every device port is a candidate.
 */
export async function candidatePorts(): Promise<string[]> {
  const ports = devicePorts();
  let ingenico: string[] = [];
  try {
    const infos = await SerialPort.list();
    ingenico = infos
      .filter((p) => p.vendorId?.toLowerCase() === INGENICO_VENDOR_ID)
      .map((p) => p.path.replace(/^\/dev\/tty\.usbmodem/, "/dev/cu.usbmodem"));
  } catch {
    // no descriptor info: probe every port
  }
  const preferred = ports.filter((p) => ingenico.includes(p));
  return preferred.length > 0 ? preferred : ports;
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
