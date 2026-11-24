"""Minimal host-side driver for an Ingenico terminal running RBA (Retail Base Application).

Speaks the RBA serial framing over the terminal's USB CDC port:
    STX + "<msg id>." + body + ETX + LRC      (LRC = XOR of every byte after STX, ETX included)
The terminal answers each frame with ACK (0x06) or NAK (0x15), then may send its own
framed response, which the host must ACK.

Standard library only (termios), so it runs on macOS/Linux without installing anything.
"""

import glob
import os
import select
import termios
import time
import tty

STX, ETX, ACK, NAK, FS = 0x02, 0x03, 0x06, 0x15, 0x1C


def find_port():
    ports = sorted(glob.glob("/dev/cu.usbmodem*")) + sorted(glob.glob("/dev/ttyACM*"))
    if not ports:
        raise SystemExit("No terminal found on /dev/cu.usbmodem* — is it plugged in?")
    return ports[0]


def lrc(data: bytes) -> int:
    v = 0
    for b in data:
        v ^= b
    return v


def frame(body: str) -> bytes:
    payload = body.encode("latin-1") + bytes([ETX])
    return bytes([STX]) + payload + bytes([lrc(payload)])


class Lane:
    def __init__(self, port=None, debug=False):
        self.port = port or find_port()
        self.debug = debug
        self.fd = os.open(self.port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        tty.setraw(self.fd)
        attrs = termios.tcgetattr(self.fd)
        attrs[4] = attrs[5] = termios.B115200
        termios.tcsetattr(self.fd, termios.TCSANOW, attrs)
        self.buf = b""
        self.inbox = []  # framed messages received but not yet consumed

    def close(self):
        os.close(self.fd)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ---- low level -------------------------------------------------------
    def _write_all(self, data: bytes):
        """The port is non-blocking, so a single os.write may take only part of a big frame."""
        view = memoryview(data)
        while view:
            try:
                n = os.write(self.fd, view)
                view = view[n:]
            except BlockingIOError:
                select.select([], [self.fd], [], 1.0)

    def _pump(self, timeout):
        r, _, _ = select.select([self.fd], [], [], timeout)
        if r:
            try:
                chunk = os.read(self.fd, 8192)
            except BlockingIOError:
                chunk = b""
            self.buf += chunk
        return self._parse()

    def _parse(self):
        """Pull ACK/NAK bytes and complete frames out of the buffer. Returns list of events."""
        events = []
        while self.buf:
            b = self.buf[0]
            if b in (ACK, NAK):
                events.append(b)
                self.buf = self.buf[1:]
            elif b == STX:
                end = self.buf.find(bytes([ETX]), 1)
                if end == -1 or len(self.buf) < end + 2:
                    break  # incomplete
                payload = self.buf[1:end + 1]
                check = self.buf[end + 1]
                self.buf = self.buf[end + 2:]
                if lrc(payload) == check:
                    os.write(self.fd, bytes([ACK]))
                    msg = payload[:-1].decode("latin-1")
                    if self.debug:
                        print("  <-", repr(msg))
                    events.append(msg)
                else:
                    os.write(self.fd, bytes([NAK]))
            else:
                self.buf = self.buf[1:]  # stray byte
        return events

    def send(self, body: str, retries=3):
        """Send one message and wait for the terminal's ACK."""
        for _ in range(retries):
            if self.debug:
                print("  ->", repr(body))
            self._write_all(frame(body))
            deadline = time.time() + 2
            while time.time() < deadline:
                for ev in self._pump(0.1):
                    if ev == ACK:
                        return
                    if ev == NAK:
                        break
                    self.inbox.append(ev)
                else:
                    continue
                break
        raise IOError(f"Terminal did not ACK {body[:20]!r}")

    def recv(self, prefix=None, timeout=5.0):
        """Wait for a framed message from the terminal (optionally one starting with prefix)."""
        deadline = time.time() + timeout
        while True:
            for i, m in enumerate(self.inbox):
                if prefix is None or m.startswith(prefix):
                    return self.inbox.pop(i)
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            for ev in self._pump(min(remaining, 0.1)):
                if isinstance(ev, str):
                    self.inbox.append(ev)

    def request(self, body, reply_prefix=None, timeout=5.0):
        self.send(body)
        return self.recv(reply_prefix or body[:3], timeout)

    # ---- RBA messages ----------------------------------------------------
    def unit_data(self):
        """07.x Unit Data: returns the response fields (maker, model, ...)."""
        r = self.request("07.")
        return r[3:].split("\x1c") if r else None

    def read_file(self, path):
        """65.x Retrieve File Contents (read-only). Path like '/HOST/OFFLINE.K3Z'."""
        out, first = [], True
        while True:
            r = self.request(f"65.{'1' if first else '0'}0{path}", "65.")
            first = False
            if not r or r[3] != "0":
                return None if not out else "".join(out)
            parts = r[4:].split("\x1c", 4)
            total, block, data = int(parts[0]), int(parts[1]), parts[4]
            out.append(data)
            if block >= total:
                return "".join(out)

    def read_binary(self, path):
        """65.x with base64 transfer, for binary files such as images. Returns bytes or None."""
        import base64
        chunks, first = [], True
        while True:
            r = self.request(f"65.{'1' if first else '0'}1{path}", "65.", 10)
            first = False
            if not r or r[3] != "0":
                return None
            total, block, _crc, _fmt, data = r[4:].split("\x1c", 4)
            chunks.append(data)
            if int(block) >= int(total):
                return base64.b64decode("".join(chunks))

    @staticmethod
    def _encode8(data: bytes) -> bytes:
        """RBA eight-bit file encoding: 00-1F -> FF,(b+20); FF -> FF,FF; everything else as-is."""
        out = bytearray()
        for b in data:
            if b < 0x20:
                out += bytes([0xFF, b + 0x20])
            elif b == 0xFF:
                out += b"\xff\xff"
            else:
                out.append(b)
        return bytes(out)

    def _unlock_and_retry(self, body, wait=30.0):
        """62.7 = uploads locked since a card read (23.x) was armed. 15.6 Stop Action clears it
        (15.0 and 10.x don't), but not while a chip card is still in the slot: then show a
        'remove card' prompt on a stock form (no upload needed) and keep retrying."""
        deadline, prompted = time.time() + wait, False
        while True:
            self.stop_action()
            r = self.request(body, "62.", 15)
            if not r or r[3] != "7" or time.time() > deadline:
                return r
            if not prompted:
                self.send("24.MSG.K3Z\x1cTPROMPTLINE1,Please remove card")
                prompted = True
            time.sleep(0.5)

    def write_file(self, name: str, data: bytes, block=3800):
        """62.x File Write to /HOST, as-is (no unpacking). Name must be upper case, <= 15 chars.

        Image files take effect immediately; .K3Z/.PGZ/.TGZ files need a reboot.
        """
        name = name.upper()
        enc = self._encode8(data)
        # split the encoded stream without cutting an FF-escape pair in half
        pieces, i = [], 0
        while i < len(enc):
            j = min(len(enc), i + block)
            if j < len(enc) and enc[j - 1] == 0xFF:
                # count trailing FFs: an odd run means the last FF starts an escape pair
                k = j - 1
                while k > i and enc[k - 1] == 0xFF:
                    k -= 1
                if (j - k) % 2 == 1:
                    j -= 1
            pieces.append(enc[i:j])
            i = j
        if not pieces:
            pieces = [b""]
        for n, piece in enumerate(pieces):
            if len(pieces) == 1:
                rec = "0"
            else:
                rec = "1" if n == 0 else ("3" if n == len(pieces) - 1 else "2")
            seg = "%02d" % (n % 99 + 1)
            head = f"62.{rec}8{seg}0000" + "1" + "0"
            if rec in "01":
                head += name + "\x1c"
            r = self.request(head + piece.decode("latin-1"), "62.", 15)
            if r and r[3] == "7" and n == 0:
                r = self._unlock_and_retry(head + piece.decode("latin-1"))
            if not r or r[3] != "0":
                raise IOError(f"File write failed at block {n + 1}/{len(pieces)}: {r!r}")
        return r

    def show_form(self, form, texts=None, timeout=None, wait=True, wait_timeout=None):
        """24.x Form Entry: show a .K3Z form, override text elements {id: text}.

        Returns (exit_type, key_id, rest) once the form exits, or None if wait=False.
        """
        body = f"24.{form}"
        for k, v in (texts or {}).items():
            body += f"\x1cT{k},{v}"
        if timeout is not None:
            body += f"\x1ct,{timeout}"
        self.send(body)
        if not wait:
            return None
        r = self.recv("24.", wait_timeout if wait_timeout is not None else 1e9)
        if r is None:
            return None
        return r[3:4], r[4:5], r[5:]

    def update(self, texts):
        """70.x Update Form Element: change text on the form currently on screen."""
        body = "70." + "\x1c".join(f"T{k},{v}" for k, v in texts.items())
        self.send(body)

    def beep(self, tone=1, duration=1):
        """51.x Beep on demand."""
        self.send(f"51.{tone}{duration}")

    def soft_reset(self):
        """15.0 Soft Reset: cancel on-demand screens and go back to the idle screen."""
        self.send("15.0")

    def stop_action(self):
        """15.6 Stop Action. Also lifts the upload lock (62.7) left by any 23.x card read."""
        self.send("15.6")
        self._pump(0.3)

    def offline(self):
        """00.x Offline: show the 'lane closed' screen."""
        self.request("00.0000", "00.", 3)


if __name__ == "__main__":
    import sys
    with Lane(debug="-v" in sys.argv) as lane:
        print("Port:", lane.port)
        print("Unit data:", lane.unit_data())
