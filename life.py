"""Conway's Game of Life on an Ingenico Lane/3000, with the card readers as controls.

Four-colour Life ("Quad-Life"): a cell is born from exactly 3 neighbours and takes the colour
most of those parents share; if all three differ it takes the fourth colour. Colours compete.

    swipe a card   -> a Gosper glider gun (orange) starts firing from the left edge
    tap a card     -> a random splash of life (green) lands somewhere
    insert a chip  -> a mirror-symmetric kaleidoscope burst (magenta) in the middle
                      (chip insert is unreliable on this terminal: see README)

Card actions work while PAUSED (GREEN): the board freezes, the readers arm, and a swipe, tap
or insert applies its effect and resumes the game. While running, only the keys are live:
cancelling an armed card read costs ~0.5 s per frame and flashes the contactless LEDs.

Keys: GREEN pause/resume   YELLOW clear   UP reseed   DOWN single step (while paused)
      F1 slower   F4 faster   RED quit

Card data is discarded: only the exit type and reader letter of each 23.x reply are used.

    python3 life.py              # play on the terminal (needs `game_screen.py --install` once)
    python3 life.py --preview    # save a sample frame to preview.png
"""

import random
import sys
import time

from PIL import Image, ImageDraw

from game_screen import GameScreen, Lane, font, frame_png

COLS, ROWS, CELL, TOP = 40, 27, 8, 24          # 40*8 = 320 wide, 24 + 27*8 = 240 tall
SPEEDS = [1.2, 0.8, 0.5, 0.35]                 # seconds per generation
KEYS = set("LUDR\r\x08\x1b")

CYAN, ORANGE, GREEN, MAGENTA = 0, 1, 2, 3
COLORS = [(80, 220, 255), (255, 150, 40), (140, 255, 90), (255, 80, 220)]
BG, GRIDLINE = (8, 10, 22), (16, 20, 36)

GOSPER_GUN = [(0, 4), (0, 5), (1, 4), (1, 5), (10, 4), (10, 5), (10, 6), (11, 3), (11, 7), (12, 2),
              (12, 8), (13, 2), (13, 8), (14, 5), (15, 3), (15, 7), (16, 4), (16, 5), (16, 6), (17, 5),
              (20, 2), (20, 3), (20, 4), (21, 2), (21, 3), (21, 4), (22, 1), (22, 5), (24, 0), (24, 1),
              (24, 5), (24, 6), (34, 2), (34, 3), (35, 2), (35, 3)]


class Life:
    def __init__(self, rng=random):
        self.rng = rng
        self.cells = {}            # (x, y) -> colour
        self.age = {}              # (x, y) -> generations alive
        self.gen = 0
        self.seed(CYAN, 0.22)

    def put(self, x, y, color):
        if 0 <= x < COLS and 0 <= y < ROWS:
            self.cells[(x, y)] = color
            self.age[(x, y)] = 0

    def seed(self, color, density):
        for x in range(COLS):
            for y in range(ROWS):
                if self.rng.random() < density:
                    self.put(x, y, color)

    def clear(self):
        self.cells.clear()
        self.age.clear()

    # --- card actions -------------------------------------------------------------------
    def glider_gun(self):
        oy = self.rng.randint(0, ROWS - 9)
        for x, y in GOSPER_GUN:
            self.put(1 + x, oy + y, ORANGE)

    def splash(self):
        cx, cy, r = self.rng.randint(4, COLS - 5), self.rng.randint(4, ROWS - 5), 5
        for x in range(cx - r, cx + r + 1):
            for y in range(cy - r, cy + r + 1):
                if (x - cx) ** 2 + (y - cy) ** 2 <= r * r and self.rng.random() < 0.45:
                    self.put(x, y, GREEN)

    def kaleidoscope(self):
        cx, cy, half_w, half_h = COLS // 2, ROWS // 2, 7, 5
        for dx in range(half_w):
            for dy in range(half_h):
                if self.rng.random() < 0.4:
                    for sx in (-1, 1):
                        for sy in (-1, 1):
                            self.put(cx + sx * dx - (sx < 0), cy + sy * dy - (sy < 0), MAGENTA)

    # --- rules --------------------------------------------------------------------------
    def step(self):
        counts = {}
        for (x, y), c in self.cells.items():
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx or dy:
                        n = (x + dx, y + dy)
                        if 0 <= n[0] < COLS and 0 <= n[1] < ROWS:   # dead edges: gliders fly off
                            counts.setdefault(n, []).append(c)
        new, age = {}, {}
        for pos, parents in counts.items():
            if pos in self.cells and len(parents) in (2, 3):
                new[pos], age[pos] = self.cells[pos], self.age[pos] + 1
            elif pos not in self.cells and len(parents) == 3:
                new[pos], age[pos] = birth_color(parents), 0
        self.cells, self.age = new, age
        self.gen += 1

    def render(self, status, toast=""):
        img = Image.new("RGB", (320, 240), BG)
        d = ImageDraw.Draw(img)
        for (x, y), c in self.cells.items():
            fade = max(0.45, 1 - self.age.get((x, y), 0) * 0.05)
            rgb = tuple(int(v * fade) for v in COLORS[c])
            x0, y0 = x * CELL, TOP + y * CELL
            d.rectangle([x0, y0, x0 + CELL - 2, y0 + CELL - 2], fill=rgb)
        d.rectangle([0, 0, 319, TOP - 1], fill=(0, 0, 0))
        d.text((6, TOP // 2), f"GEN {self.gen}  POP {len(self.cells)}", font=font(13),
               fill=(220, 220, 230), anchor="lm")
        if toast:
            d.text((314, TOP // 2), toast, font=font(13), fill=(255, 220, 0), anchor="rm")
        elif status:
            d.text((314, TOP // 2), status, font=font(12), fill=(140, 140, 160), anchor="rm")
        return img


def birth_color(parents):
    counts = {c: parents.count(c) for c in set(parents)}
    best = max(counts.values())
    if best >= 2:
        return max(counts, key=counts.get)
    return ({0, 1, 2, 3} - set(parents)).pop()        # three different colours -> the fourth


def title_screen():
    img = Image.new("RGB", (320, 240), BG)
    d = ImageDraw.Draw(img)
    d.text((160, 26), "GAME OF LIFE", font=font(26), fill=(255, 220, 0), anchor="mm")
    lines = [("SWIPE", "glider gun", COLORS[ORANGE]), ("TAP", "life splash", COLORS[GREEN]),
             ("INSERT", "kaleidoscope", COLORS[MAGENTA])]
    for i, (what, does, col) in enumerate(lines):
        y = 66 + i * 26
        d.rectangle([40, y - 7, 54, y + 7], fill=col)
        d.text((64, y), what, font=font(15), fill=col, anchor="lm")
        d.text((150, y), does, font=font(15), fill=(220, 220, 230), anchor="lm")
    keys = ["GREEN pause   YELLOW clear   RED quit", "UP reseed   DOWN step   F1/F4 speed"]
    for i, k in enumerate(keys):
        d.text((160, 168 + i * 20), k, font=font(12), fill=(160, 160, 180), anchor="mm")
    d.text((160, 222), "GREEN start - pause to use cards", font=font(15), fill=(255, 255, 255), anchor="mm")
    return img


# --- terminal I/O ---------------------------------------------------------------------------
# Cancelling an armed card read costs ~0.5 s and re-arming lights the contactless LEDs, so the
# readers are only armed while the game is paused. Running frames use 24.x (keys only).
CARD_HINT = "swipe / tap / insert  -  GREEN resume"
REARM_EVERY = 15.0           # a chip insert can swallow the read without replying; re-arm then


def paused_frame(life):
    img = life.render("PAUSED")
    d = ImageDraw.Draw(img)
    d.rectangle([20, 104, 300, 152], fill=(0, 0, 0), outline=(255, 220, 0))
    d.text((160, 118), "PAUSED", font=font(16), fill=(255, 220, 0), anchor="mm")
    d.text((160, 138), CARD_HINT, font=font(12), fill=(220, 220, 230), anchor="mm")
    return img


def arm_cards(lane, img):
    """Show img and arm all three readers (keys still arrive, as 23.3<key>)."""
    lane.send("15.6")                                       # end any earlier read, lift upload lock
    lane.inbox = [m for m in lane.inbox if m.startswith("23.")]
    lane.write_file("GAME.PNG", frame_png(img))
    lane.send("23.\x1cGAME.K3Z\x1c\x1cMSC")


def classify(reply, last_insert):
    """Turn a 23.x reply into an event name. The card data in it is never kept."""
    exit_type = reply[3:4]
    if exit_type not in ("0", "1", "N"):                    # key/status replies carry no card data
        print("23 reply:", repr(reply), flush=True)
    if exit_type == "0":
        return {"M": "swipe", "S": "insert", "Q": "insert"}.get(reply[4:5], "tap")
    if exit_type == "3":
        key = next((ch for ch in reply[4:7] if ch in KEYS), None)
        return f"key:{key}" if key else None
    if exit_type == "2":
        return "key:\x1b"                                   # red cancels the read
    if exit_type in ("1", "N"):
        # bad read / card left before the read finished: almost always a tap, except right
        # after a chip insert, where N means the chip card was pulled out
        return None if time.time() - last_insert < 8 else "tap"
    return None                                             # 9 = busy (card in slot), others


def apply_card(life, event):
    if event == "swipe":
        life.glider_gun(); return "SWIPE: glider gun!"
    if event == "tap":
        life.splash(); return "TAP: splash!"
    if event == "insert":
        life.kaleidoscope(); return "INSERT: kaleidoscope!"
    return ""


def apply_key(life, key, running):
    """Keys shared by both modes. Returns a toast or ''."""
    if key == "\x08":
        life.clear(); return "cleared"
    if key == "U":
        life.seed(CYAN, 0.22); return "reseeded"
    if key == "D" and not running:
        life.step()
    return ""


def pause(lane, life, last_insert):
    """Freeze the board with the readers armed. Returns (action, toast, last_insert):
    action is 'resume' or 'quit'."""
    arm_cards(lane, paused_frame(life))
    armed_at = time.time()
    while True:
        r = lane.recv("23.", 1.0)
        if r is None:
            if time.time() - armed_at > REARM_EVERY:
                arm_cards(lane, paused_frame(life))
                armed_at = time.time()
            continue
        event = classify(r, last_insert)
        del r
        if event in ("swipe", "tap", "insert"):
            if event == "insert":
                last_insert = time.time()
            lane.send("15.6")
            lane.send("51.21")                              # high short beep
            print(event, flush=True)
            return "resume", apply_card(life, event), last_insert
        if event == "key:\x1b":
            return "quit", "", last_insert
        if event == "key:\r":
            lane.send("15.6")
            return "resume", "", last_insert
        if event and event.startswith("key:"):
            apply_key(life, event[4:], running=False)
        arm_cards(lane, paused_frame(life))                  # redraw (and re-arm) after a key
        armed_at = time.time()


def play():
    with Lane() as lane:
        gs = GameScreen(lane)
        lane.send("15.6")
        lane.soft_reset()
        lane.request("28.100004121", "28.", 3)              # contactless on until reboot
        life, speed, last_insert = Life(), 2, 0.0
        toast, toast_until = "", 0.0
        try:
            gs.push(title_screen())
            while True:
                keys = gs.keys(wait=3600)
                if "\x1b" in keys:
                    return
                if "\r" in keys:
                    break
            while True:
                t0 = time.time()
                status = f"GREEN pause  speed {speed + 1}/{len(SPEEDS)}"
                gs.push(life.render(status, toast if time.time() < toast_until else ""))
                keys = gs.keys(wait=max(0.05, SPEEDS[speed] - (time.time() - t0)))
                for k in keys:
                    if k == "\x1b":
                        return
                    if k == "\r":
                        action, toast, last_insert = pause(lane, life, last_insert)
                        if action == "quit":
                            return
                        toast_until = time.time() + 2.5 if toast else 0
                    elif k == "L":
                        speed = max(0, speed - 1)
                    elif k == "R":
                        speed = min(len(SPEEDS) - 1, speed + 1)
                    else:
                        t = apply_key(life, k, running=True)
                        if t:
                            toast, toast_until = t, time.time() + 1.5
                if not keys:
                    life.step()
        finally:
            lane.send("15.6")
            lane.soft_reset()


if __name__ == "__main__":
    if "--preview" in sys.argv:
        life = Life(random.Random(7))
        for _ in range(12):
            life.step()
        life.glider_gun()
        life.splash()
        life.kaleidoscope()
        for _ in range(6):
            life.step()
        life.render("speed 3/4", "SWIPE: glider gun!").save("preview.png")
        title_screen().save("preview_title.png")
        print("wrote preview.png, preview_title.png; frame", len(frame_png(life.render("x"))), "bytes")
    else:
        play()
