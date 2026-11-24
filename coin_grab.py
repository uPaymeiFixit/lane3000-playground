"""COIN GRAB - a top-down proof-of-concept game for an Ingenico Lane/3000 running RBA.

Move the @ around the box, grab every $ and don't let the skimmer & catch you.
Each key press is one turn; the skimmer steps toward you every other turn.

Keys (the four keys under the screen):
    [ - ] F1 = left    [ ^ ] F2 = up    [ v ] F3 = down    [ - ] F4 = right
    GREEN = new game   RED = quit

Run:   python3 coin_grab.py            (plays on the terminal)
       python3 coin_grab.py --preview  (prints frames here; no terminal needed)
"""

import os
import random
import sys

COLS, ROWS = 17, 8      # logical cells; each is drawn 2 characters wide -> "#" + 34 + "#" = 36 chars
N_COINS = 6
KEYS = {"C": (-1, 0), "P": (0, -1), "Y": (0, 1), "N": (1, 0)}   # F1, F2 (up), F3 (down), F4


class Game:
    def __init__(self, seed=None):
        rng = random.Random(seed)
        cells = [(x, y) for x in range(COLS) for y in range(ROWS)]
        rng.shuffle(cells)
        self.player = (1, ROWS // 2)
        cells.remove(self.player)
        self.skimmer = next(c for c in cells if abs(c[0] - self.player[0]) > 8)
        cells.remove(self.skimmer)
        self.coins = set(c for c in cells if abs(c[0] - self.player[0]) + abs(c[1] - self.player[1]) > 2)
        self.coins = set(list(self.coins)[:N_COINS])
        self.moves = 0
        self.total = len(self.coins)
        self.msg = "Grab every $"

    @property
    def won(self):
        return not self.coins

    @property
    def lost(self):
        return self.player == self.skimmer

    def press(self, key):
        if key not in KEYS:
            return
        dx, dy = KEYS[key]
        x = min(COLS - 1, max(0, self.player[0] + dx))
        y = min(ROWS - 1, max(0, self.player[1] + dy))
        self.player = (x, y)
        self.moves += 1
        self.msg = ""
        if self.player in self.coins:
            self.coins.remove(self.player)
            self.msg = "Cha-ching!"
        if self.lost or self.won:
            return
        if self.moves % 2 == 0:   # skimmer moves every other turn, toward the player
            sx, sy = self.skimmer
            px, py = self.player
            if abs(px - sx) >= abs(py - sy):
                sx += (px > sx) - (px < sx)
            else:
                sy += (py > sy) - (py < sy)
            self.skimmer = (sx, sy)

    def render(self):
        rows = []
        for y in range(ROWS):
            line = ""
            for x in range(COLS):
                c = (x, y)
                if c == self.player and c == self.skimmer:
                    ch = "X"
                elif c == self.player:
                    ch = "@"
                elif c == self.skimmer:
                    ch = "&"
                elif c in self.coins:
                    ch = "$"
                else:
                    ch = "."
                line += ch + " "
            rows.append("#" + line + "#")
        return rows

    def hud(self):
        got = self.total - len(self.coins)
        if self.lost:
            return f"CAUGHT by the skimmer!  Coins {got}/{self.total}   GREEN = again  RED = quit"
        if self.won:
            return f"YOU WIN in {self.moves} moves!   GREEN = again  RED = quit"
        return f"COINS {got}/{self.total}   MOVES {self.moves}   {self.msg}"


TITLE = [
    "#..................................#",
    "#   C O I N   G R A B              #",
    "#                                  #",
    "#   @ = you    $ = coin            #",
    "#   & = skimmer (it chases you)    #",
    "#                                  #",
    "#   arrows: [-] [^] [v] [-]        #",
    "#..................................#",
]


def show(lane, rows, header, buttons):
    """Show BAMTV.K3Z with our header, draw the 8 rows, return the key pressed."""
    msg = "24.BAMTV.K3Z\x1cTPROMPTLINE1," + header.replace(",", " ")[:120]
    if buttons:
        msg += "\x1cBbtnc,S\x1cBbtnp,S\x1cBbtny,S\x1cBbtnn,S"
    lane.send(msg)
    for i, row in enumerate(rows[:8]):
        lane.send("28.90000%03d" % (111 + i) + row)
    while True:
        r = lane.recv("24.", 3600)
        if r is None:
            raise SystemExit("No key pressed for an hour; quitting.")
        if r[3] == "0" and len(r) > 4:
            return r[4]


def play():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from lane import Lane
    with Lane() as lane:
        try:
            # Try with the payment-button labels hidden. If the F-keys don't fire that way,
            # the player presses GREEN instead and we fall back to showing the buttons.
            key = show(lane, TITLE, "COIN GRAB - press UP arrow to start  (if nothing happens press GREEN)", False)
            buttons = key not in KEYS
            print("F-keys work with buttons hidden:", not buttons, flush=True)
            if key == "\x1b":
                return
            while True:
                g = Game()
                while not (g.won or g.lost):
                    key = show(lane, g.render(), g.hud(), buttons)
                    if key == "\x1b":
                        return
                    if key == "\r":
                        break
                    g.press(key)
                    print(f"{key!r} -> {g.hud()}", flush=True)
                if g.won or g.lost:
                    if show(lane, g.render(), g.hud(), buttons) == "\x1b":
                        return
        finally:
            lane.soft_reset()


def preview():
    print("\n".join(TITLE))
    g = Game(seed=1)
    for key in ["", "N", "N", "P", "Y"]:
        if key:
            g.press(key)
        print(f"--- after {key!r}: {g.hud()}")
        print("\n".join(g.render()))
    assert all(len(r) == 36 for r in g.render() + TITLE)


if __name__ == "__main__":
    preview() if "--preview" in sys.argv else play()
