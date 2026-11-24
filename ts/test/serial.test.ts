import { describe, expect, it } from "bun:test";

import { ingenicoPortsFromIoreg } from "../src/protocol/serial.js";

// Trimmed `ioreg -r -l -w0 -c IOUSBHostDevice` output: a headset that is also a USB serial
// device, then the Lane/3000 with its serial node nested below it.
const IOREG = `+-o Sennheiser Headset@01100000  <class IOUSBHostDevice>
  {
    "USB Product Name" = "Headset"
    "idVendor" = 4141
  }
  | +-o IOUSBHostInterface@0
  |   +-o AppleUSBACMData
  |     +-o IOSerialBSDClient
  |         "IOCalloutDevice" = "/dev/cu.usbmodem201432405"
+-o Lane3000@20130000  <class IOUSBHostDevice>
  {
    "USB Product Name" = "Lane3000"
    "idVendor" = 2816
  }
  | +-o IOUSBHostInterface@1
  |   +-o AppleUSBACMData
  |     +-o IOSerialBSDClient
  |         "IOCalloutDevice" = "/dev/cu.usbmodem201301"
  |         "IODialinDevice" = "/dev/tty.usbmodem201301"
`;

describe("port discovery", () => {
  it("finds only the Ingenico device's serial port in ioreg output", () => {
    expect(ingenicoPortsFromIoreg(IOREG)).toEqual(["/dev/cu.usbmodem201301"]);
  });

  it("returns nothing when no Ingenico device is present", () => {
    expect(ingenicoPortsFromIoreg(IOREG.replace("2816", "1234"))).toEqual([]);
  });

  it("does not match a vendor id that only starts with 2816", () => {
    expect(ingenicoPortsFromIoreg(IOREG.replace('"idVendor" = 2816', '"idVendor" = 28160'))).toEqual([]);
  });
});
