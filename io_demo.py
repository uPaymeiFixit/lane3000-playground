"""Other inputs and outputs on the Lane/3000: beeps, lights, music and card readers.

    python3 io_demo.py --beeps    # 51.x: the four built-in tones                       WORKS
    python3 io_demo.py --lights   # 92.x: LEDs, keypad light, backlight        no reply on our unit
    python3 io_demo.py --music    # synthesize a chiptune, upload as OGG, play (72.x)  72.9 on our unit
    python3 io_demo.py --cards    # 23.x: report swipe / insert events for 60 s  see card_test.py

Results on our Lane/3000 (Unified Payment Platform 6.80.09):
- 51.x beeps work: 4200, 6000, 9000, 3800 Hz; 150/500/1000 ms. Too few tones for music.
- 92.x light control is ACKed, never answered, and changes nothing visible (watched).
- 72.x audio answers 72.9 to every play request, even for a missing file (72.0 stop answers
  72.5 "nothing playing"), so this model can't play audio files - no chiptunes.
- 23.x card read: swipe and chip insert are enabled; contactless is disabled in configuration.
  28.100004121 (variable 412 = 1) enables contactless until reboot. An Apple Pay tap then
  returns 23.1 (bad read) - a usable tap event - but any contactless read, finished or
  cancelled, makes every 62.x upload fail with 62.7 until a reboot.

Card reads: the terminal returns track data, which contains the card number. This script keeps
only the exit type and which reader fired, and throws the rest away without printing or saving it.
"""

import array
import math
import os
import subprocess
import sys
import tempfile
import time
import wave

from game_screen import GameScreen, Lane, text_screen

# ---------------------------------------------------------------- beeps (51.x)
def beeps(lane):
    for tone in "0123":            # 4200, 6000, 9000, 3800 Hz
        print("51." + tone + "0 ->", lane.request(f"51.{tone}0", "51.", 3))
        time.sleep(0.3)


# ---------------------------------------------------------------- lights (92.x)
def light(lane, *specs):
    return lane.request("92." + "\x1c".join(specs), "92.", 3)


def lights(lane):
    cless = ["Cless1:Green", "Cless2:Yellow", "Cless3:Green", "Cless4:Red"]
    print("all off:", light(lane, "Cless1:Off", "Cless2:Off", "Cless3:Off", "Cless4:Off", "SMC:Off", "MSR:Off"))
    for _ in range(3):                           # chase across the four contactless LEDs
        for i, spec in enumerate(cless):
            light(lane, spec, *[f"Cless{j + 1}:Off" for j in range(4) if j != i])
            time.sleep(0.15)
    print("all four:", light(lane, *cless))
    time.sleep(0.6)
    print("card slot red:", light(lane, "SMC:Red"))
    time.sleep(0.6)
    print("card slot green:", light(lane, "SMC:Green"))
    time.sleep(0.6)
    print("swipe blink l2r:", light(lane, "MSR:Green,l2r"))
    time.sleep(1.5)
    print("keypad off:", light(lane, "Keyboard:Off"))
    time.sleep(0.8)
    print("keypad on:", light(lane, "Keyboard:ON"))
    for level in (10, 40, 70, 100, 30, 100):     # screen backlight
        light(lane, f"Display:ON,{level}")
        time.sleep(0.35)
    print("restore:", light(lane, "Cless1:Off", "Cless2:Off", "Cless3:Off", "Cless4:Off", "SMC:Off", "MSR:Off",
                            "Keyboard:ON", "Display:ON"))


# ---------------------------------------------------------------- music (72.x)
RATE = 22050
BPM = 140
STEP = 60 / BPM / 2                       # one eighth note
# Original tune: A minor / F / C / G, eight eighth-notes per bar (MIDI note numbers, None = rest)
LEAD = [76, None, 72, 74, 76, 79, 76, 74,   72, None, 69, 72, 77, 76, 74, 72,
        72, 76, 79, None, 79, 77, 76, 72,   74, None, 71, 74, 79, 77, 74, 71,
        76, None, 72, 74, 76, 79, 81, 79,   77, None, 72, 77, 81, 79, 77, 76,
        79, 76, 72, 76, 79, 84, 79, 76,     74, 76, 79, 83, 81, None, None, None]
CHORDS = [(57, 60, 64), (53, 57, 60), (48, 52, 55), (55, 59, 62)] * 2   # one per bar


def freq(n):
    return 440 * 2 ** ((n - 69) / 12)


def chiptune():
    """Square-wave lead, 16th-note arpeggio, pulsing bass and noise hats, mixed to 16-bit mono."""
    total = int(len(LEAD) * STEP * RATE)
    mix = [0.0] * total

    def add(start_s, dur_s, f, vol, duty=0.5, kind="square"):
        s0, n = int(start_s * RATE), int(dur_s * RATE)
        phase = 0.0
        for i in range(n):
            if s0 + i >= total:
                break
            env = min(1.0, (n - i) / (0.02 * RATE)) * min(1.0, i / (0.003 * RATE))
            if kind == "noise":
                v = (hash((s0 + i) * 2654435761) & 0xFFFF) / 32768 - 1
                env *= 1 - i / n
            else:
                phase = (phase + f / RATE) % 1.0
                v = 1.0 if phase < duty else -1.0
            mix[s0 + i] += v * vol * env

    for i, note in enumerate(LEAD):
        if note:
            add(i * STEP, STEP * 0.9, freq(note), 0.22, duty=0.5)
    for bar, chord in enumerate(CHORDS):
        t0 = bar * 8 * STEP
        for k in range(16):                              # 16th-note arpeggio, octave up, thin pulse
            add(t0 + k * STEP / 2, STEP / 2 * 0.8, freq(chord[k % 3] + 12), 0.08, duty=0.125)
        for k in range(8):                               # bass: root, octave-jumping eighths
            add(t0 + k * STEP, STEP * 0.7, freq(chord[0] - 12 + (12 if k % 2 else 0)), 0.18, duty=0.5)
        for k in range(8):                               # hats on every eighth, accent off-beats
            add(t0 + k * STEP, 0.03, 0, 0.05 if k % 2 == 0 else 0.09, kind="noise")
    peak = max(abs(v) for v in mix) or 1
    return array.array("h", (int(v / peak * 26000) for v in mix))


def make_ogg(path):
    with tempfile.TemporaryDirectory() as tmp:
        wav = os.path.join(tmp, "tune.wav")
        with wave.open(wav, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(chiptune().tobytes())
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", wav,
                        "-c:a", "libvorbis", "-q:a", "3", path], check=True)


def music(lane):
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chiptune.ogg")
    make_ogg(path)
    data = open(path, "rb").read()
    print(f"chiptune.ogg: {len(data) / 1024:.1f} KB, {len(LEAD) * STEP:.1f} s")
    lane.write_file("CHIPTUNE.OGG", data)
    t = time.time()
    lane.send("72.1CHIPTUNE.OGG")
    r = lane.recv("72.", 60)
    status = {"0": "play complete", "1": "file not on terminal", "2": "empty list", "3": "interrupted",
              "4": "already playing", "5": "invalid request"}
    print(f"72 -> {r!r} ({status.get(r[3], '?') if r else 'no reply'}) after {time.time() - t:.1f}s")


# ---------------------------------------------------------------- cards (23.x)
SOURCES = {"C": "tap (contactless)", "E": "tap (EMV contactless)", "M": "swipe", "S": "chip insert",
           "Q": "chip insert (quick chip)", "c": "key/coupon card", "m": "phone tap", "H": "manual entry"}
EXITS = {"0": "good read", "1": "bad read", "2": "cancelled", "3": "key pressed", "6": "invalid prompt",
         "7": "encryption failed", "9": "rejected (busy)", "A": "contactless needs an amount",
         "R": "a requested reader is disabled"}


def card_event(lane, devices="", timeout=60):
    """Arm the readers over the GAME.K3Z screen; return (exit, source) only - track data is discarded.

    devices "" = every reader enabled in the terminal's configuration. On our unit that is swipe
    and chip insert; contactless is disabled ("C" alone returns 23.R).
    """
    lane.soft_reset()
    lane.send(f"23.\x1cGAME.K3Z\x1c\x1c{devices}")
    r = lane.recv("23.", timeout)
    if not r:
        return None, None
    exit_type = r[3:4]
    source = r[4:5] if exit_type == "0" else ""
    if exit_type == "3":
        source = r[5:6]      # for "key pressed", the key id follows
    del r                    # drop the card data
    return exit_type, source


def cards(lane, seconds=60):
    gs = GameScreen(lane)
    lane.soft_reset()                 # make sure no earlier on-demand screen is still open
    end = time.time() + seconds
    last = "swipe, insert or tap a card"
    while time.time() < end:
        lane.write_file("GAME.PNG", __import__("game_screen").frame_png(
            text_screen(["CARD TEST", last, f"{int(end - time.time())}s left - RED quits"])))
        exit_type, source = card_event(lane, timeout=end - time.time())
        if exit_type is None:
            break
        what = SOURCES.get(source, source) if exit_type == "0" else EXITS.get(exit_type, exit_type)
        print(f"exit {exit_type!r} source {source!r}: {what}", flush=True)
        if exit_type == "3" and source == "\x1b":
            break
        if exit_type in ("6", "9", "A", "R"):
            last = what
            if exit_type in ("9", "R"):
                time.sleep(1)
            continue
        last = "got: " + what
    lane.soft_reset()
    del gs


if __name__ == "__main__":
    actions = {"--beeps": beeps, "--lights": lights, "--music": music, "--cards": cards}
    chosen = [a for a in sys.argv[1:] if a in actions]
    if not chosen:
        sys.exit(__doc__)
    with Lane() as lane:
        lane.soft_reset()
        for a in chosen:
            print("==", a)
            actions[a](lane)
