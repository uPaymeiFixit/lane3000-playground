"""Experiments on the post-card-read upload lock (62.x -> 62.7).

    python3 lock_probe.py trigger <readers>       # arm readers (e.g. M, S, MS, C) 2 s, cancel, test upload
    python3 lock_probe.py unlock <msg> [<msg>...]  # send each message, test upload after each
    python3 lock_probe.py reboot

Card data is never involved: these arm the readers without a card present.
"""

import sys
import time

from game_screen import Lane, frame_png, text_screen, wait_for_terminal

PNG = frame_png(text_screen(["LOCK PROBE"]))


def upload_ok(lane):
    try:
        lane.write_file("GAME.PNG", PNG)
        return True
    except IOError:
        return False


def main():
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "reboot":
        with Lane() as lane:
            lane.send("97.")
        print("back:", wait_for_terminal()[:2])
        return
    with Lane() as lane:
        lane._pump(0.5)
        lane.inbox.clear()
        print("upload before:", "OK" if upload_ok(lane) else "LOCKED", flush=True)
        if cmd == "trigger":
            devices = args[0]
            if "C" in devices:
                print("412=1:", lane.request("28.100004121", "28.", 3))
            lane.soft_reset()
            lane.send(f"23.\x1cGAME.K3Z\x1c\x1c{devices}")
            r = lane.recv("23.", 2)
            print(f"armed {devices}:", "waiting" if r is None else f"reply 23.{r[3:4]}")
            del r
            lane.soft_reset()
            time.sleep(0.5)
            lane._pump(0.5)
            print("queued after cancel:", [m[:6] for m in lane.inbox])
            lane.inbox.clear()
            print("upload after cancel:", "OK" if upload_ok(lane) else "LOCKED", flush=True)
        elif cmd == "unlock":
            for msg in args:
                msg = msg.replace("FS", "\x1c")
                lane.send(msg)
                r = lane.recv(None, 3)
                time.sleep(0.5)
                lane._pump(0.3)
                extra = [m[:12] for m in lane.inbox]
                lane.inbox.clear()
                ok = upload_ok(lane)
                print(f"{msg!r:22} reply {r[:16] if r else None!r:20} extra {extra} -> upload {'OK' if ok else 'LOCKED'}",
                      flush=True)
                if ok:
                    break


if __name__ == "__main__":
    main()
