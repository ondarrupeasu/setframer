"""Composite a SetFrameR / vMix virtual-set folder the way vMix does, without vMix.

Reads config.xml, stacks the layers bottom → top and, for every dynamic layer with a UV map, samples
an input image at (u, v) = (R, G) / 65536 with coverage = A / 65535 (× the input's own alpha).
Inputs default to generated test cards (a letter + an "up" arrow) and, for "Talent", a keyed-out
silhouette — so a glance at the result tells whether orientation, occlusion and placement are right.

    uv run --with numpy --with pillow --with pypng tools/simulate_vmix.py <set-folder> [out.png]
        [--input "Screen A=clip.png" ...]
"""
import argparse
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import png
from PIL import Image, ImageDraw, ImageFont


def read_uvmap(path):
    """→ float array (h, w, 4): u, v in [0,1) (value / 65536), coverage in [0,1] (value / 65535)."""
    w, h, rows, info = png.Reader(filename=str(path)).read()
    if info["bitdepth"] != 16 or info["planes"] != 4:
        raise SystemExit(f"{path}: expected 16-bit RGBA, got {info['bitdepth']}-bit × {info['planes']}")
    a = np.vstack([np.asarray(r, dtype=np.float64) for r in rows]).reshape(h, w, 4)
    a[..., :3] /= 65536
    a[..., 3] /= 65535
    return a


def test_card(label, size=(1920, 1080)):
    img = Image.new("RGBA", size, (20, 24, 34, 255))
    d = ImageDraw.Draw(img)
    w, h = size
    for i in range(0, w, 120):
        d.line([(i, 0), (i, h)], fill=(50, 60, 80, 255), width=2)
    for j in range(0, h, 120):
        d.line([(0, j), (w, j)], fill=(50, 60, 80, 255), width=2)
    d.rectangle([8, 8, w - 9, h - 9], outline=(255, 90, 77, 255), width=16)
    d.polygon([(w / 2, 40), (w / 2 - 90, 200), (w / 2 + 90, 200)], fill=(255, 255, 255, 255))   # ▲ top
    d.rectangle([40, h - 160, 160, h - 40], fill=(74, 158, 255, 255))                           # ■ bottom-left
    try:
        font = ImageFont.truetype("Arial.ttf", 420)
    except OSError:
        font = ImageFont.load_default()
    d.text((w / 2, h / 2 + 60), label, fill=(242, 242, 244, 255), anchor="mm", font=font)
    return img


def talent_card(size=(1920, 1080)):
    """Keyed presenter stand-in: transparent frame with a person-ish silhouette standing on the bottom."""
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    w, h = size
    cx = w / 2
    d.ellipse([cx - 70, 170, cx + 70, 330], fill=(230, 190, 160, 255))           # head
    d.rounded_rectangle([cx - 170, 340, cx + 170, 760], 60, fill=(200, 60, 60, 255))  # torso
    d.rectangle([cx - 140, 760, cx - 20, h], fill=(40, 40, 60, 255))             # legs
    d.rectangle([cx + 20, 760, cx + 140, h], fill=(40, 40, 60, 255))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--input", action="append", default=[], help='"Layer name=image.png"')
    args = ap.parse_args()
    folder = Path(args.folder)
    inputs = dict(s.split("=", 1) for s in args.input)

    root = ET.parse(folder / "config.xml").getroot()
    canvas = None
    for el in root.findall("input"):
        name = el.get("name")
        if el.get("dynamic") == "true" and el.get("uvmap"):
            uv = read_uvmap(folder / el.get("uvmap"))
            src = Image.open(inputs[name]).convert("RGBA") if name in inputs else (
                talent_card() if name.lower().startswith("talent") else test_card(name.split()[-1]))
            s = np.asarray(src, dtype=np.float64) / 255
            sh, sw = s.shape[:2]
            x = np.clip((uv[..., 0] * sw).astype(int), 0, sw - 1)
            y = np.clip((uv[..., 1] * sh).astype(int), 0, sh - 1)
            px = s[y, x]
            a = (uv[..., 3] * px[..., 3])[..., None]
            if canvas is None:
                canvas = np.zeros(uv.shape[:2] + (3,))
            canvas = canvas * (1 - a) + px[..., :3] * a
            print(f"{name:12s} uvmap {el.get('uvmap')}: covers {100 * (uv[..., 3] > 0).mean():.1f}% of the frame")
        else:
            img = np.asarray(Image.open(folder / el.text).convert("RGBA"), dtype=np.float64) / 255
            canvas = img[..., :3] if canvas is None else canvas * (1 - img[..., 3:]) + img[..., :3] * img[..., 3:]
            print(f"{name:12s} image {el.text}")
    out = Path(args.out) if args.out else folder / "_simulated.png"
    Image.fromarray((np.clip(canvas, 0, 1) * 255).astype(np.uint8)).save(out)
    print("→", out)


if __name__ == "__main__":
    sys.exit(main())
