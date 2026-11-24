"""Beep jingle + a slow, captioned light test for the Lane/3000.

    python3 light_test.py --jingle   # four-tone jingle with the 51.x beep command
    python3 light_test.py --lights  # one 92.x light command every few seconds, captioned on screen

The terminal never replies to 92.x on our unit, so the only way to know if a light works is to
watch it; the screen says what each step should do.
"""

import sys
import time

from game_screen import GameScreen, Lane, text_screen

# 51.x tones, lowest to highest: 3 = 3800 Hz, 0 = 4200 Hz, 1 = 6000 Hz, 2 = 9000 Hz
# lengths: 0 = 150 ms, 1 = 500 ms, 2 = 1000 ms
JINGLE = [("3", "0", 0.0), ("0", "0", 0.0), ("1", "0", 0.0), ("2", "0", 0.15), ("1", "0", 0.0), ("2", "1", 0.0)]


def jingle(lane):
    for tone, length, pause in JINGLE:
        lane.request(f"51.{tone}{length}", "51.", 2)   # reply arrives as the beep starts
        time.sleep({"0": 0.15, "1": 0.5, "2": 1.0}[length] + pause)


STEPS = [
    ("SCREEN: getting DIM", ["Display:ON,10"]),
    ("SCREEN: back to BRIGHT", ["Display:ON,100"]),
    ("KEYPAD light: OFF", ["Keyboard:Off"]),
    ("KEYPAD light: ON", ["Keyboard:ON,100"]),
    ("TAP LIGHTS: all four ON", ["Cless1:Green", "Cless2:Yellow", "Cless3:Green", "Cless4:Red"]),
    ("TAP LIGHTS: OFF", ["Cless1:Off", "Cless2:Off", "Cless3:Off", "Cless4:Off"]),
    ("CHIP SLOT light: RED", ["SMC:Red"]),
    ("CHIP SLOT light: GREEN", ["SMC:Green"]),
    ("SWIPE SLOT light: blinking", ["SMC:Off", "MSR:Green,l2r"]),
    ("all lights back to normal", ["MSR:Off", "Keyboard:ON", "Display:ON"]),
]


def lights(lane, hold=4.0):
    gs = GameScreen(lane)
    for i, (caption, specs) in enumerate(STEPS, 1):
        gs.push(text_screen([f"LIGHT TEST {i}/{len(STEPS)}", caption, "watch the terminal"]))
        time.sleep(0.4)
        lane.send("92." + "\x1c".join(specs))
        reply = lane.recv("92.", 0.5)
        print(f"{i:2}. {caption:30} reply: {reply!r}", flush=True)
        time.sleep(hold)
    lane.soft_reset()


if __name__ == "__main__":
    with Lane() as lane:
        lane.soft_reset()
        if "--jingle" in sys.argv:
            jingle(lane)
        if "--lights" in sys.argv:
            lights(lane)
