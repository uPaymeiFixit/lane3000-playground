"""SKIMMER HUNT - a turn-based ASCII first-person maze shooter for an Ingenico Lane/3000.

The Mac does all the work: it raycasts the maze into an 8 x 38 character frame and pushes
each row to the terminal's monospace line display (RBA variables 111-118). The terminal shows
the frame on the BAMTV.K3Z form, whose F1-F4 keys are linked to buttons, and reports which
key was pressed. Every key press is one game turn.

Keys:  F1 turn left   F2 forward   F3 back   F4 turn right   GREEN fire   RED quit

Run:   python3 skimmer_hunt.py            (plays on the terminal)
       python3 skimmer_hunt.py --preview  (prints a few frames here; no terminal needed)
"""

import math
import random
import sys

W, H = 36, 8          # 3D view size; each row gets a '|' border on both sides -> 38 columns
FOV = math.radians(66)
TURN = math.radians(45)
STEP = 0.7

MAP = [
    "################",
    "#P....#........#",
    "#.##..#..##.##.#",
    "#.#...S..#...#.#",
    "#.#.####.#.S.#.#",
    "#...#a...#...#.#",
    "###.#.####.###.#",
    "#...#....+.#...#",
    "#.S.####.#.#.S.#",
    "#........#...#.#",
    "#.####.#.###.#.#",
    "#.#..+.#..a..#S#",
    "#...##.....#...#",
    "################",
]
# P = player start, S = skimmer, + = med kit, a = ammo


class Game:
    def __init__(self):
        self.walls = set()
        self.enemies, self.items = [], []
        for y, row in enumerate(MAP):
            for x, c in enumerate(row):
                if c == "#":
                    self.walls.add((x, y))
                elif c == "P":
                    self.px, self.py = x + 0.5, y + 0.5
                elif c == "S":
                    self.enemies.append({"x": x + 0.5, "y": y + 0.5, "hp": 2})
                elif c in "+a":
                    self.items.append({"x": x + 0.5, "y": y + 0.5, "kind": c})
        self.angle = 0.0
        self.hp, self.ammo, self.turns = 100, 16, 0
        self.msg = "Find and zap every skimmer"
        self.total = len(self.enemies)

    # ---- world helpers ----------------------------------------------------
    def wall(self, x, y):
        return (int(math.floor(x)), int(math.floor(y))) in self.walls

    def line_of_sight(self, x0, y0, x1, y1):
        d = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(d * 8))
        return all(not self.wall(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(1, n))

    def cast(self, ang):
        """DDA raycast. Returns (perpendicular-ish distance, side hit)."""
        dx, dy = math.cos(ang), math.sin(ang)
        mx, my = int(self.px), int(self.py)
        ddx = abs(1 / dx) if dx else 1e9
        ddy = abs(1 / dy) if dy else 1e9
        sx, sdx = (-1, (self.px - mx) * ddx) if dx < 0 else (1, (mx + 1 - self.px) * ddx)
        sy, sdy = (-1, (self.py - my) * ddy) if dy < 0 else (1, (my + 1 - self.py) * ddy)
        for _ in range(64):
            if sdx < sdy:
                sdx += ddx; mx += sx; side = 0
                if (mx, my) in self.walls:
                    return sdx - ddx, side
            else:
                sdy += ddy; my += sy; side = 1
                if (mx, my) in self.walls:
                    return sdy - ddy, side
        return 20.0, 0

    def rel(self, obj):
        """Distance and bearing (radians, -pi..pi, 0 = straight ahead) of an object."""
        dx, dy = obj["x"] - self.px, obj["y"] - self.py
        a = math.atan2(dy, dx) - self.angle
        a = (a + math.pi) % (2 * math.pi) - math.pi
        return math.hypot(dx, dy), a

    # ---- rendering --------------------------------------------------------
    def render(self):
        grid = [[" "] * W for _ in range(H)]
        for r in range(H // 2 + 2, H):
            for c in range(W):
                grid[r][c] = "." if r == H - 1 else " "
        zbuf = [0.0] * W
        for c in range(W):
            off = (c / (W - 1) - 0.5) * FOV
            d, side = self.cast(self.angle + off)
            d = max(0.05, d * math.cos(off))
            zbuf[c] = d
            h = min(H, int(H * 1.1 / d))
            top = (H - h) // 2
            shade = min(4, int(d / 1.6))
            ch = ("#%=-:" if side == 0 else "H+~-.")[shade]
            for r in range(top, top + h):
                grid[r][c] = ch

        sprites = [(o, "enemy") for o in self.enemies] + [(o, "item") for o in self.items]
        sprites.sort(key=lambda s: -self.rel(s[0])[0])
        for obj, kind in sprites:
            d, a = self.rel(obj)
            if abs(a) > FOV / 2 + 0.3 or d < 0.2:
                continue
            pd = d * math.cos(a)
            col = int((a / FOV + 0.5) * (W - 1))
            if kind == "enemy":
                h = max(1, min(H, int(H * 0.9 / pd)))
                w = max(1, int(h * 1.3))
                top = (H - h) // 2 + (1 if h < H else 0)
                rows = [("o" if h < 3 else "O")] + ["&"] * (h - 2) + (["^"] if h >= 2 else [])
            else:
                h = 1 if pd > 2.5 else 2
                w = max(1, int(3 / pd))
                top = H - h - (0 if pd < 2 else 1)
                rows = (["+"] * h) if obj["kind"] == "+" else (["="] * h)
            for c in range(col - w // 2, col - w // 2 + w):
                if 0 <= c < W and pd < zbuf[c]:
                    for i, glyph in enumerate(rows):
                        if 0 <= top + i < H:
                            grid[top + i][c] = glyph
        return ["|" + "".join(r) + "|" for r in grid]

    def hud(self):
        left = len(self.enemies)
        return f"HP {self.hp}  AMMO {self.ammo}  SKIMMERS {left}/{self.total}   {self.msg}"

    # ---- turn logic -------------------------------------------------------
    def move(self, dist):
        nx = self.px + math.cos(self.angle) * dist
        ny = self.py + math.sin(self.angle) * dist
        pad = 0.2
        if not self.wall(nx + math.copysign(pad, nx - self.px), self.py):
            self.px = nx
        if not self.wall(self.px, ny + math.copysign(pad, ny - self.py)):
            self.py = ny

    def fire(self):
        if self.ammo <= 0:
            self.msg = "Click. Out of ammo!"
            return
        self.ammo -= 1
        target, best = None, 99
        for e in self.enemies:
            d, a = self.rel(e)
            if abs(a) < math.atan2(0.45, d) + 0.05 and d < best and self.line_of_sight(self.px, self.py, e["x"], e["y"]):
                target, best = e, d
        if not target:
            self.msg = "ZAP! Missed."
            return
        target["hp"] -= 1
        if target["hp"] <= 0:
            self.enemies.remove(target)
            self.msg = "ZAP! Skimmer destroyed!" if self.enemies else ""
        else:
            self.msg = "ZAP! Hit - it's still sparking"

    def world_turn(self):
        for it in list(self.items):
            if math.hypot(it["x"] - self.px, it["y"] - self.py) < 0.8:
                self.items.remove(it)
                if it["kind"] == "+":
                    self.hp = min(100, self.hp + 30); self.msg = "Med kit: +30 HP"
                else:
                    self.ammo += 8; self.msg = "Ammo: +8"
        for e in self.enemies:
            d = math.hypot(e["x"] - self.px, e["y"] - self.py)
            if d < 1.1:
                if random.random() < 0.6:
                    dmg = random.randint(6, 14)
                    self.hp -= dmg
                    self.msg = f"A skimmer zaps you for {dmg}!"
            elif d < 7 and self.line_of_sight(e["x"], e["y"], self.px, self.py):
                sx, sy = (self.px - e["x"]) / d * 0.45, (self.py - e["y"]) / d * 0.45
                if not self.wall(e["x"] + sx, e["y"]) and not self.wall(e["x"] + sx, e["y"] + sy):
                    e["x"] += sx
                    e["y"] += sy

    def press(self, key):
        """Apply one key. Returns False when the player quits."""
        self.msg = ""
        if key == "C":
            self.angle -= TURN
        elif key == "N":
            self.angle += TURN
        elif key == "P":
            self.move(STEP)
        elif key == "Y":
            self.move(-STEP)
        elif key == "\r":
            self.fire()
        elif key == "\x1b":
            return False
        self.turns += 1
        self.world_turn()
        return True

    @property
    def over(self):
        return self.hp <= 0 or not self.enemies


TITLE = [
    "                                      ",
    "   ___ _  _____ __  __ __  __ ___ ___ ",
    "  / __| |/ /_ _|  \\/  |  \\/  | __| _ \\",
    "  \\__ \\ ' < | || |\\/| | |\\/| | _||   /",
    "  |___/_|\\_\\___|_|  |_|_|  |_|___|_|_\\",
    "            H  U  N  T                ",
    "  F1 left  F2 fwd  F3 back  F4 right  ",
    "     GREEN = zap     RED = quit       ",
]


def end_screen(g):
    won = g.hp > 0
    lines = ["", "      *** LANE CLEARED! ***" if won else "      *** LANE CLOSED ***", "",
             f"   Skimmers zapped: {g.total - len(g.enemies)}/{g.total}",
             f"   Turns taken:     {g.turns}", f"   HP left:         {max(0, g.hp)}", "",
             "   GREEN = play again   RED = quit"]
    return [l.ljust(38)[:38] for l in lines]


# ---- terminal I/O -----------------------------------------------------------
def show(lane, rows, header):
    header = header.replace(",", " ")[:120]
    lane.send("24.BAMTV.K3Z\x1cTPROMPTLINE1," + header + "\x1cBbtnc,S\x1cBbtnp,S\x1cBbtny,S\x1cBbtnn,S")
    for i, row in enumerate(rows[:8]):
        row = row.ljust(38)[:38]
        if row[0] == " ":  # the display may trim leading spaces, so frame the row instead
            row = "|" + row[1:-1] + "|"
        lane.send("28.90000%03d" % (111 + i) + row)
    while True:
        r = lane.recv("24.", 3600)
        if r is None:
            raise SystemExit("No key pressed for an hour; quitting.")
        if r[3] == "0" and len(r) > 4:
            return r[4]


def play():
    import os
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from lane import Lane
    with Lane() as lane:
        try:
            key = show(lane, TITLE, "SKIMMER HUNT - press GREEN to start")
            if key == "\x1b":
                return
            while True:
                g = Game()
                while not g.over:
                    frame = g.render()
                    print("\n".join(frame), "\n", g.hud(), sep="", flush=True)
                    if not g.press(show(lane, frame, g.hud())):
                        return
                if show(lane, end_screen(g), "GAME OVER") == "\x1b":
                    return
        finally:
            lane.soft_reset()


def preview():
    g = Game()
    for key in ["", "P", "P", "N", "N", "P", "P", "P", "\r"]:
        if key:
            g.press(key)
        print(f"--- after {key!r}:", g.hud())
        print("\n".join(g.render()))


if __name__ == "__main__":
    if "--preview" in sys.argv:
        print("\n".join(TITLE))
        preview()
    else:
        play()
