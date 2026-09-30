"""Generate the synthetic photos the UI smoke tests run against:
a noisy landscape (sky, ridge line, a dark subject) and a 6-frame burst with a
red "walker" crossing the frame (for stacking), plus a photo whose file name
and EXIF carry markup (for the XSS check). Usage: python fixtures.py DIR"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def main(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1)
    W, H = 1800, 1200
    y = np.linspace(0, 1, H)[:, None]
    sky = np.stack([90 + 100 * y, 150 + 70 * y, 230 - 20 * y], -1) * np.ones((1, W, 1))
    img = Image.fromarray(sky.clip(0, 255).astype("uint8"))
    d = ImageDraw.Draw(img)
    pts = [(0, 800)] + [(x, 500 + int(180 * np.sin(x / 180) + 80 * np.cos(x / 57))) for x in range(0, W + 1, 30)] + [(W, H), (0, H)]
    d.polygon(pts, fill=(70, 80, 60))
    d.ellipse((800, 700, 1000, 820), fill=(40, 30, 25))
    d.ellipse((950, 660, 1030, 730), fill=(50, 40, 30))
    noisy = lambda: np.asarray(img).astype(float) + rng.normal(0, 14, (H, W, 3))
    Image.fromarray(noisy().clip(0, 255).astype("uint8")).save(out / "landscape.jpg", quality=92)
    for i in range(6):
        frame = Image.fromarray(noisy().clip(0, 255).astype("uint8"))
        x = 150 + i * 250
        ImageDraw.Draw(frame).rectangle((x, 850, x + 60, 1050), fill=(200, 30, 30))
        frame.save(out / f"burst_{i}.jpg", quality=92)

    # Hostile photo: anything read from a file must reach the page as text.
    exif = Image.Exif()
    exif[0x010F] = "<img src=x onerror=window.__xss='make'>"    # Make
    exif[0x0110] = "<img src=x onerror=window.__xss='model'>"   # Model
    img.resize((600, 400)).save(out / "evil<img src=x onerror=window.__xss='name'>.jpg", quality=85, exif=exif)


if __name__ == "__main__":
    main(Path(sys.argv[1]))
