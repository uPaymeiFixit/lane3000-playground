"""Full-screen graphics + key input on an Ingenico Lane/3000 running RBA.

Installs one custom screen layout, GAME.K3Z: a full-screen image (GAME.PNG) with every key
enabled. F1-F4 are linked to 1-pixel buttons so the terminal reports them to the host.
Each frame is drawn on the Mac, uploaded as a small palette PNG, GAME.PNG (62.x), and shown
with 24.GAME.K3Z. A 32-colour PNG of flat game graphics is ~1-3 KB, versus 5-15 KB as JPEG.

    python3 game_screen.py --install     # upload GAME.K3Z + images, then reboot the terminal
    python3 game_screen.py --uninstall   # delete those files, then reboot
    python3 game_screen.py --keytest     # show pressed keys on screen for 60 s

Key codes reported:  F1 'L'  F2 'U'  F3 'D'  F4 'R'  green '\\r'  yellow '\\x08'  red '\\x1b'
"""

import glob
import io
import os
import sys
import time

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lane import Lane  # noqa: E402

W, H = 320, 240
FILES = ["GAME.K3Z", "GAME.PNG", "GAMEBTN.PNG"]
OBSOLETE = ["GAME.JPG", "MAZE.K3Z"]   # left over from earlier versions; removed on install


def _button(bid, letter):
    return (f'<BmpButton x="0" y="0" width="1" height="1" id="{bid}" key="CUSTOM" buttonid="\'{letter}\'" '
            'upimage="GAMEBTN.PNG" hostupimage=".\\GAMEBTN.PNG" downimage="GAMEBTN.PNG" '
            'hostdownimage=".\\GAMEBTN.PNG" textsource="custom" buttontext=" " textoffsetx="0" '
            'textoffsety="0" textcolor="000000" fontsize="10px" fontweight="normal" fontfamily="sans-serif" '
            'align="center" eventfireon="down" visibility="visible" tonetype="0" />')


FORM = "\n".join([
    '<Form id="Form" terminalname="Lane 3000" designerversion="1.0" x="0" y="0" width="320" height="240" '
    'template="TEMPMENU.HTM" backgroundcolor="000000" timeout="0" enterenabled="true" entertone="0" '
    'clearenabled="true" cleartone="0" cancelenabled="true" canceltone="0" tonetype="0" '
    'f1enabled="true" f2enabled="true" f3enabled="true" f4enabled="true" '
    'F1-link="btnl" F2-link="btnu" F3-link="btnd" F4-link="btnr" '
    'swledbarenabled="false" headerenabled="false" clesslogo="false" windowtype="full" />',
    '<Image x="0" y="0" width="320" height="240" id="image1" image="GAME.PNG" hostimage=".\\GAME.PNG" />',
    _button("btnl", "L"), _button("btnu", "U"), _button("btnd", "D"), _button("btnr", "R"),
]) + "\n"


def font(size):
    for path in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def frame_png(img, colors=32):
    """320x240 palette PNG without dithering: tiny for flat game graphics."""
    pal = img.convert("RGB").resize((W, H)).quantize(colors=colors, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    pal.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def text_screen(lines, bg=(0, 0, 0), fg=(255, 255, 255)):
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    y = H // 2 - 18 * len(lines)
    for i, line in enumerate(lines):
        f = font(30 if i == 0 else 18)
        d.text((W // 2, y), line, font=f, fill=fg if i else (255, 220, 0), anchor="mm")
        y += 44 if i == 0 else 28
    return img


def wait_for_terminal(timeout=180):
    """After a reboot the USB port disappears and comes back; wait until RBA answers again."""
    deadline = time.time() + timeout
    time.sleep(5)
    while time.time() < deadline:
        if glob.glob("/dev/cu.usbmodem*"):
            try:
                with Lane() as lane:
                    lane._pump(0.5)
                    info = lane.unit_data()
                    if info:
                        return info
            except (OSError, IOError, SystemExit):
                pass
        time.sleep(2)
    raise SystemExit("Terminal did not come back after reboot.")


class GameScreen:
    """Push frames to the full-screen layout and collect key presses without blocking."""

    def __init__(self, lane):
        self.lane = lane

    def push(self, img, colors=32):
        self.lane.write_file("GAME.PNG", frame_png(img, colors))
        self.lane.soft_reset()           # close the previous frame's screen (if still open)
        self.lane.send("24.GAME.K3Z")    # reply comes later, when a key closes the screen

    def keys(self, wait=0.0):
        """Return keys pressed since the last call (waits up to `wait` seconds for one)."""
        out = []
        deadline = time.time() + wait
        while True:
            m = self.lane.recv("24.", max(0.0, deadline - time.time()) if not out else 0.0)
            if m is None:
                return out
            if len(m) > 4 and m[3] == "0":
                out.append(m[4])


def install():
    btn = io.BytesIO()
    Image.new("RGB", (1, 1), (0, 0, 0)).save(btn, "PNG")
    with Lane() as lane:
        lane.soft_reset()
        lane.write_file("GAMEBTN.PNG", btn.getvalue())
        lane.write_file("GAME.PNG", frame_png(text_screen(["GAME SCREEN", "installed"])))
        lane.write_file("GAME.K3Z", FORM.encode("latin-1"))
        for f in OBSOLETE:
            lane.request(f"64./HOST/{f}", "64.", 5)
        print("Uploaded", ", ".join(FILES), "- rebooting terminal (about a minute)...")
        lane.send("97.")
    print("Back:", wait_for_terminal()[:2])
    with Lane() as lane:
        form = lane.read_file("/HOST/GAME.K3Z")
        print("GAME.K3Z on terminal:", "OK" if form and "GAME.PNG" in form else form)


def uninstall():
    with Lane() as lane:
        lane.soft_reset()
        for f in FILES:
            print(f, "->", lane.request(f"64./HOST/{f}", "64.", 5))
        lane.send("97.")
    print("Back:", wait_for_terminal()[:2])


def keytest(seconds=60):
    with Lane() as lane:
        gs = GameScreen(lane)
        end, seen = time.time() + seconds, []
        names = {"L": "F1", "U": "F2 (up)", "D": "F3 (down)", "R": "F4", "\r": "GREEN", "\x08": "YELLOW",
                 "\x1b": "RED"}
        gs.push(text_screen(["KEY TEST", "press any key", f"{seconds}s"]))
        while time.time() < end:
            ks = gs.keys(wait=end - time.time())
            for k in ks:
                seen.append(k)
                print("key", repr(k), flush=True)
            if ks:
                gs.push(text_screen(["KEY TEST", "last: " + names.get(ks[-1], repr(ks[-1])),
                                     f"{len(seen)} presses"]))
        lane.soft_reset()
    print("seen:", seen)


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""
    {"--install": install, "--uninstall": uninstall, "--keytest": keytest}.get(arg, lambda: sys.exit(__doc__))()
