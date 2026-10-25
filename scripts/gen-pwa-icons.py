#!/usr/bin/env python3
"""Generate the PWA icons from the same bolt geometry as app/icon.svg.

No design tool, no binary source: the icon is a deterministic render of the SVG
path the browser already serves as a favicon, so the installed app cannot drift
from the tab icon.

Run: python scripts/gen-pwa-icons.py
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "apps" / "web" / "public" / "icons"
BG = (11, 14, 17, 255)  # #0B0E11
BOLT = (198, 242, 78, 255)  # #C6F24E
# Path from apps/web/src/app/icon.svg, in the 64x64 viewBox.
BOLT_PATH = [(36, 8), (16, 36), (28, 36), (26, 56), (46, 28), (34, 28)]
SS = 4  # supersample, then downsample for clean edges


def render(size: int, *, maskable: bool = False, radius_ratio: float = 0.1875) -> Image.Image:
    canvas = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    s = size * SS
    if maskable:
        # A maskable icon must fill the square; the OS applies the mask.
        draw.rectangle((0, 0, s, s), fill=BG)
        inset = s * 0.14
        scale = (s - inset * 2) / s
        ox = oy = inset
    else:
        draw.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * radius_ratio), fill=BG)
        scale = 1.0
        ox = oy = 0.0
    pts = [((x / 64) * s * scale + ox, (y / 64) * s * scale + oy) for x, y in BOLT_PATH]
    draw.polygon(pts, fill=BOLT)
    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    render(192).save(OUT / "icon-192.png", optimize=True)
    render(512).save(OUT / "icon-512.png", optimize=True)
    render(512, maskable=True).save(OUT / "icon-maskable-512.png", optimize=True)
    render(180).save(OUT / "apple-touch-icon.png", optimize=True)
    print(f"wrote 4 icons to {OUT}")


if __name__ == "__main__":
    main()
