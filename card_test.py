"""Card reader test that survives the upload lock.

Arming a card reader (23.x) locks 62.x uploads (62.7) until a 15.6 Stop Action, so this test
uploads one instruction screen first, then only re-arms the readers and beeps: low = swipe,
middle = chip, high = tap, error tone = bad read. It sends 15.6 at the end to clear the lock.
Contactless is enabled for the session with variable 412 = 1 (until reboot).

Card data: only the exit type and reader letter are kept; the rest of each reply (which holds
the card number) is discarded without being printed or stored.

    python3 card_test.py [seconds] [readers]   # default 180 s, readers MSC (M swipe, S chip, C tap)
"""

import sys
import time

import io_demo
from game_screen import Lane, frame_png, text_screen

BEEP = {"M": "00", "S": "10", "Q": "10", "C": "20", "E": "20", "m": "20"}   # 51.<tone><length>


def run(seconds=180, devices="MSC"):
    with Lane() as lane:
        lane.soft_reset()
        lane.write_file("GAME.PNG", frame_png(text_screen(
            ["CARD TEST", "swipe, insert or tap", "low beep=swipe  mid=chip", "high=tap  buzz=bad read"])))
        if "C" in devices:
            print("contactless on:", lane.request("28.100004121", "28.", 3), flush=True)
        end = time.time() + seconds
        print(f"readers: {devices}", flush=True)
        print(f"ARMED until {time.strftime('%H:%M:%S', time.localtime(end))}", flush=True)
        while time.time() < end:
            exit_type, source = io_demo.card_event(lane, devices=devices, timeout=end - time.time())
            if exit_type is None:
                break
            what = io_demo.SOURCES.get(source, source) if exit_type == "0" else io_demo.EXITS.get(exit_type, exit_type)
            print(f"{time.strftime('%H:%M:%S')}  exit {exit_type!r} source {source!r}: {what}", flush=True)
            if exit_type == "3" and source == "\x1b":
                break
            lane.send("51." + (BEEP.get(source, "30") if exit_type == "0" else "33"))
            time.sleep(1.0 if exit_type in ("9", "R") else 0.3)
        lane.stop_action()   # 15.6: clears the upload lock (remove any chip card first)
        print("done; upload lock cleared with 15.6", flush=True)


if __name__ == "__main__":
    run(int(sys.argv[1]) if len(sys.argv) > 1 else 180, sys.argv[2] if len(sys.argv) > 2 else "MSC")
