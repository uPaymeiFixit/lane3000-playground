"""Full-screen real-time Snake for an Ingenico Lane/3000 (needs `python3 game_screen.py --install` once).

Keys:  F1 left   F2 (up arrow) up   F3 (down arrow) down   F4 right
       GREEN start / restart   YELLOW pause   RED quit

    python3 snake.py              # play on the terminal
    python3 snake.py --preview    # save a sample frame to preview.png, no terminal needed
"""

import random
import sys
import time

from PIL import Image, ImageDraw

from game_screen import GameScreen, Lane, font, text_screen

CELL = 20
COLS, ROWS = 16, 11            # 320 x 220 board under a 20 px score bar
TOP = 20
TICK = 0.22                    # seconds per step (the terminal manages ~5 frames/s)
DIRS = {"L": (-1, 0), "U": (0, -1), "D": (0, 1), "R": (1, 0)}

BG, GRID = (12, 16, 28), (22, 28, 44)
BODY, HEAD, FOOD = (60, 200, 90), (150, 255, 120), (240, 60, 60)


class Snake:
    def __init__(self):
        y = ROWS // 2
        self.body = [(5, y), (4, y), (3, y)]
        self.dir = (1, 0)
        self.pending = []
        self.score = 0
        self.dead = False
        self.place_food()

    def place_food(self):
        free = [(x, y) for x in range(COLS) for y in range(ROWS) if (x, y) not in self.body]
        self.food = random.choice(free)

    def turn(self, key):
        d = DIRS.get(key)
        last = self.pending[-1] if self.pending else self.dir
        if d and d != last and d != (-last[0], -last[1]):
            self.pending.append(d)   # queue turns so quick double-taps both count

    def step(self):
        if self.pending:
            self.dir = self.pending.pop(0)
        hx, hy = self.body[0]
        head = (hx + self.dir[0], hy + self.dir[1])
        grow = head == self.food
        body = self.body if grow else self.body[:-1]
        if not (0 <= head[0] < COLS and 0 <= head[1] < ROWS) or head in body:
            self.dead = True
            return
        self.body = [head] + body
        if grow:
            self.score += 1
            if len(self.body) == COLS * ROWS:
                self.dead = True
            else:
                self.place_food()

    def render(self, best, paused=False):
        img = Image.new("RGB", (320, 240), BG)
        d = ImageDraw.Draw(img)
        d.rectangle([0, 0, 319, TOP - 1], fill=(0, 0, 0))
        d.text((6, 2), f"SCORE {self.score}", font=font(15), fill=(255, 220, 0))
        d.text((314, 2), f"BEST {best}", font=font(15), fill=(180, 180, 180), anchor="ra")
        for x in range(COLS):
            for y in range(ROWS):
                if (x + y) % 2:
                    d.rectangle(self.cell(x, y), fill=GRID)
        fx, fy = self.food
        x0, y0, x1, y1 = self.cell(fx, fy)
        d.ellipse([x0 + 3, y0 + 3, x1 - 3, y1 - 3], fill=FOOD)
        d.line([(x0 + 10, y0 + 1), (x0 + 12, y0 + 5)], fill=(90, 200, 90), width=2)
        for i, (x, y) in enumerate(reversed(self.body)):
            x0, y0, x1, y1 = self.cell(x, y)
            d.rounded_rectangle([x0 + 1, y0 + 1, x1 - 1, y1 - 1], radius=5, fill=BODY)
        hx, hy = self.body[0]
        x0, y0, x1, y1 = self.cell(hx, hy)
        d.rounded_rectangle([x0, y0, x1, y1], radius=6, fill=HEAD)
        dx, dy = self.dir
        cx, cy = (x0 + x1) // 2 + dx * 4, (y0 + y1) // 2 + dy * 4
        for s in (-1, 1):  # eyes, placed sideways relative to the direction of travel
            ex, ey = cx + s * 4 * dy, cy + s * 4 * dx
            d.ellipse([ex - 2, ey - 2, ex + 2, ey + 2], fill=(0, 0, 0))
        if paused:
            d.rectangle([90, 100, 230, 140], fill=(0, 0, 0))
            d.text((160, 120), "PAUSED", font=font(24), fill="white", anchor="mm")
        return img

    @staticmethod
    def cell(x, y):
        return [x * CELL, TOP + y * CELL, x * CELL + CELL - 1, TOP + y * CELL + CELL - 1]


def wait_key(gs, accept):
    while True:
        for k in gs.keys(wait=3600):
            if k in accept:
                return k


def play():
    best = 0
    with Lane() as lane:
        gs = GameScreen(lane)
        try:
            gs.push(text_screen(["SNAKE", "arrows / F1 F4 to steer", "GREEN start   RED quit"]))
            if wait_key(gs, "\r\x1b") == "\x1b":
                return
            while True:
                s = Snake()
                paused = False
                while not s.dead:
                    t = time.time()
                    for k in gs.keys():
                        if k == "\x1b":
                            return
                        if k == "\x08":
                            paused = not paused
                        else:
                            s.turn(k)
                    if not paused:
                        s.step()
                    if s.dead:
                        break
                    gs.push(s.render(best, paused))
                    time.sleep(max(0.0, TICK - (time.time() - t)))
                best = max(best, s.score)
                print(f"score {s.score}  best {best}", flush=True)
                gs.push(text_screen(["GAME OVER", f"score {s.score}   best {best}",
                                     "GREEN again   RED quit"], bg=(60, 0, 0)))
                if wait_key(gs, "\r\x1b") == "\x1b":
                    return
        finally:
            lane.soft_reset()


if __name__ == "__main__":
    if "--preview" in sys.argv:
        s = Snake()
        for k in "RRDDDLL":
            s.turn(k)
            s.step()
        s.render(7).save("preview.png")
        print("wrote preview.png")
    else:
        play()
