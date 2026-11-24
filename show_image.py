"""Show a full-screen image on an Ingenico Lane/3000 running RBA.

How it works: RBA ships 13 ad screens (AD1.K3Z ... AD13.K3Z), each a single full-screen
320x240 image named AD<n>.JPG. We overwrite AD13.JPG with our own picture (62.x File Write,
no reboot needed for images) and show the AD13.K3Z screen (24.x Form Entry).

    python3 show_image.py --test-card        # generated test card
    python3 show_image.py photo.png          # any image, resized/cropped to 320x240
    python3 show_image.py --bounce 20        # frame-rate test: 20 frames of a bouncing ball
    python3 show_image.py --restore          # put the original AD13.JPG back (backups/AD13.JPG)

Needs Pillow (pip install pillow).
"""

import io
import math
import os
import sys
import time

from PIL import Image, ImageDraw, ImageFont, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from lane import Lane  # noqa: E402

W, H = 320, 240
SLOT = "AD13"
BACKUP = os.path.join(HERE, "backups", SLOT + ".JPG")
FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"


def font(size):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def to_jpeg(img, quality=80):
    """Baseline (non-progressive) 320x240 RGB JPEG bytes, which the terminal's decoder accepts."""
    img = ImageOps.fit(img.convert("RGB"), (W, H))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=quality, progressive=False, optimize=True)
    return buf.getvalue()


def test_card():
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):  # vertical gradient
        d.line([(0, y), (W, y)], fill=(20, 20 + y // 3, 60 + y // 2))
    bars = [(255, 255, 255), (255, 255, 0), (0, 255, 255), (0, 255, 0),
            (255, 0, 255), (255, 0, 0), (0, 0, 255), (0, 0, 0)]
    bw = W // len(bars)
    for i, c in enumerate(bars):
        d.rectangle([i * bw, 170, (i + 1) * bw - 1, 210], fill=c)
    for x in range(0, W, 2):  # 1-pixel stripes to check sharpness
        d.line([(x, 214), (x, 239)], fill=(255, 255, 255))
    d.text((W // 2, 50), "IT WORKS!", font=font(46), fill=(255, 220, 0), anchor="mm")
    d.text((W // 2, 100), "Full-screen image from a Mac", font=font(16), fill="white", anchor="mm")
    d.text((W // 2, 124), "RBA 62.x upload + AD13.K3Z", font=font(14), fill=(180, 220, 255), anchor="mm")
    d.text((W // 2, 148), time.strftime("%H:%M:%S"), font=font(14), fill=(180, 255, 180), anchor="mm")
    d.rectangle([0, 0, W - 1, H - 1], outline=(255, 0, 0))  # 1px border: shows any cropping
    return img


def bounce_frame(i, n):
    img = Image.new("RGB", (W, H), (10, 10, 40))
    d = ImageDraw.Draw(img)
    t = i / max(1, n - 1)
    x = int(30 + (W - 60) * t)
    y = int(H - 30 - (H - 80) * abs(math.sin(i * 0.45)))
    d.ellipse([x - 22, y - 22, x + 22, y + 22], fill=(255, 80, 60))
    d.text((8, 8), f"frame {i + 1}/{n}", font=font(18), fill="white")
    return img


def show(lane, jpeg):
    """Upload the JPEG into the ad slot and display it. Returns seconds spent uploading."""
    t = time.time()
    lane.write_file(SLOT + ".JPG", jpeg)
    up = time.time() - t
    lane.soft_reset()             # leave any screen we left up before
    lane.send(f"24.{SLOT}.K3Z")   # ad screens have no exit keys, so no reply comes back
    return up


def main():
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    with Lane() as lane:
        if args[0] == "--restore":
            data = open(BACKUP, "rb").read()
            lane.write_file(SLOT + ".JPG", data)
            lane.soft_reset()
            print(f"Restored original {SLOT}.JPG ({len(data)} bytes) and returned to the idle screen.")
            return
        if not os.path.exists(BACKUP):
            os.makedirs(os.path.dirname(BACKUP), exist_ok=True)
            original = lane.read_binary(f"/HOST/{SLOT}.JPG")
            if original:
                open(BACKUP, "wb").write(original)
                print("Backed up original to", BACKUP)
        if args[0] == "--bounce":
            n = int(args[1]) if len(args) > 1 else 20
            frames = [to_jpeg(bounce_frame(i, n), quality=60) for i in range(n)]
            t0 = time.time()
            for f in frames:
                show(lane, f)
            dt = time.time() - t0
            avg = sum(map(len, frames)) / n
            print(f"{n} frames, avg {avg / 1024:.1f} KB, {dt:.1f}s total -> {n / dt:.2f} fps")
            return
        img = test_card() if args[0] == "--test-card" else Image.open(args[0])
        jpeg = to_jpeg(img)
        up = show(lane, jpeg)
        print(f"Uploaded {len(jpeg) / 1024:.1f} KB in {up:.2f}s and showed it full-screen.")


if __name__ == "__main__":
    main()
