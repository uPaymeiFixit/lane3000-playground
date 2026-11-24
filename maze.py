"""Maze for an Ingenico Lane/3000, drawn as full-screen images from the Mac.

Needs the full-screen layout once: `python3 game_screen.py --install`.
Every game is a freshly generated maze. Steer the yellow ball to the green exit.

Keys:  F1 left   F2 (up arrow) up   F3 (down arrow) down   F4 right
       GREEN new maze   RED quit

    python3 maze.py              # play on the terminal
    python3 maze.py --preview    # save a sample frame to preview.png
"""

import random
import sys
import time

from PIL import Image, ImageDraw

from game_screen import GameScreen, Lane, font

CW, CH = 12, 8                 # maze cells -> (2*CW+1) x (2*CH+1) = 25 x 17 tiles
TILE = 12                      # 25*12 = 300 px wide, 17*12 = 204 px tall
TOP = 30                       # status bar height
OX = (320 - (2 * CW + 1) * TILE) // 2
OY = TOP + (240 - TOP - (2 * CH + 1) * TILE) // 2
MOVES = {"L": (-1, 0), "U": (0, -1), "D": (0, 1), "R": (1, 0)}

BG, WALL, WALL_EDGE = (14, 18, 32), (60, 90, 170), (100, 140, 230)
TRAIL, PLAYER, EXIT = (70, 70, 40), (255, 210, 40), (60, 220, 110)


def generate(rng=random):
    """Perfect maze via randomized depth-first search: grid[y][x] is True for walls."""
    w, h = 2 * CW + 1, 2 * CH + 1
    grid = [[True] * w for _ in range(h)]
    stack, seen = [(0, 0)], {(0, 0)}
    grid[1][1] = False
    while stack:
        cx, cy = stack[-1]
        options = [(cx + dx, cy + dy, dx, dy) for dx, dy in MOVES.values()
                   if 0 <= cx + dx < CW and 0 <= cy + dy < CH and (cx + dx, cy + dy) not in seen]
        if not options:
            stack.pop()
            continue
        nx, ny, dx, dy = rng.choice(options)
        grid[2 * cy + 1 + dy][2 * cx + 1 + dx] = False
        grid[2 * ny + 1][2 * nx + 1] = False
        seen.add((nx, ny))
        stack.append((nx, ny))
    return grid


class Maze:
    def __init__(self, rng=random):
        self.walls = generate(rng)
        self.pos = (1, 1)
        self.exit = (2 * CW - 1, 2 * CH - 1)
        self.trail = {self.pos}
        self.moves = 0
        self.start = time.time()
        self.won = False

    def press(self, key):
        dx, dy = MOVES[key]
        x, y = self.pos[0] + dx, self.pos[1] + dy
        if not self.walls[y][x]:
            self.pos = (x, y)
            self.trail.add(self.pos)
            self.moves += 1
            self.won = self.pos == self.exit

    @staticmethod
    def box(x, y, inset=0):
        x0, y0 = OX + x * TILE, OY + y * TILE
        return [x0 + inset, y0 + inset, x0 + TILE - 1 - inset, y0 + TILE - 1 - inset]

    def render(self):
        img = Image.new("RGB", (320, 240), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, 319, TOP - 1], fill=(0, 0, 0))
        if self.won:
            secs = int(time.time() - self.start)
            d.text((160, TOP // 2), f"ESCAPED in {self.moves} moves, {secs}s", font=font(16),
                   fill=EXIT, anchor="mm")
        else:
            d.text((8, TOP // 2), f"MOVES {self.moves}", font=font(15), fill=(255, 220, 0), anchor="lm")
            d.text((312, TOP // 2), "GREEN new  RED quit", font=font(12), fill=(150, 150, 170), anchor="rm")
        for y, row in enumerate(self.walls):
            for x, wall in enumerate(row):
                if wall:
                    x0, y0, x1, y1 = self.box(x, y)
                    d.rectangle([x0, y0, x1, y1], fill=WALL)
                    d.line([x0, y0, x1, y0], fill=WALL_EDGE)
                elif (x, y) in self.trail:
                    d.ellipse(self.box(x, y, 4), fill=TRAIL)
        d.rectangle(self.box(*self.exit, 1), fill=EXIT)
        d.ellipse(self.box(*self.pos, 1), fill=PLAYER)
        return img


def play():
    with Lane() as lane:
        gs = GameScreen(lane)
        try:
            m = Maze()
            while True:
                gs.push(m.render())
                if m.won:
                    print(f"escaped in {m.moves} moves", flush=True)
                for k in gs.keys(wait=3600):
                    if k == "\x1b":
                        return
                    if k == "\r":
                        m = Maze()
                    elif k in MOVES and not m.won:
                        m.press(k)
        finally:
            lane.soft_reset()


if __name__ == "__main__":
    if "--preview" in sys.argv:
        m = Maze(random.Random(3))
        for k in "RRDDRRRR":
            m.press(k)
        m.render().save("preview.png")
        print("wrote preview.png")
    else:
        play()
