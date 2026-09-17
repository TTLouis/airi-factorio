#!/usr/bin/env python3
"""Draw the console's provider avatars.

The mod GUI button in the top-left corner shows which model AIRI is currently
talking to. The avatars are original chibi/anime-style drawings generated here
rather than downloaded artwork, so the mod ships no third-party image and no
vendor logo: a provider is identified by its accent color, hair color, and a
plain geometric charm, all of which are our own.

Everything is drawn at 4x and downsampled once, which is cheaper than an
anti-aliasing pass per shape and keeps the 32px in-game rendering readable.

Usage: python packages/autorio/scripts/generate_provider_icons.py
"""

from __future__ import annotations

import math
import os

from PIL import Image, ImageDraw, ImageFilter

SIZE = 64
SS = 8
N = SIZE * SS

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "graphics", "icons", "provider")

PLATE = (34, 36, 42, 255)
PLATE_SHADE = (22, 24, 29, 255)
SKIN = (255, 226, 205, 255)
SKIN_SHADE = (232, 190, 170, 255)
EYE = (44, 38, 52, 255)
EYE_LIGHT = (255, 255, 255, 255)
MOUTH = (150, 84, 84, 255)

# Pillow's draw calls overwrite pixels instead of blending them, so every tone
# that wants to look translucent is pre-mixed against the surface it sits on.
BLUSH = (255, 176, 176, 255)
EYE_GLINT = (196, 192, 210, 255)


def px(value: float) -> float:
    """Icon-space unit to supersampled canvas space."""
    return value * SS


def mix(color, other, amount):
    return tuple(round(a + (b - a) * amount) for a, b in zip(color, other))


def lighten(color, amount=0.35):
    return mix(color, (255, 255, 255, color[3]), amount)


def darken(color, amount=0.35):
    return mix(color, (0, 0, 0, color[3]), amount)


def plate(draw: ImageDraw.ImageDraw, accent):
    """Dark rounded plate with an accent ring, so the button reads on Factorio's dark GUI."""
    draw.rounded_rectangle([px(1), px(1), px(63), px(63)], radius=px(16), fill=PLATE_SHADE)
    draw.rounded_rectangle([px(2), px(2), px(62), px(60)], radius=px(15), fill=PLATE)
    draw.rounded_rectangle(
        [px(2), px(2), px(62), px(62)],
        radius=px(15),
        outline=accent,
        width=int(px(2.5)),
    )
    # A soft accent glow behind the head separates the character from the plate.
    draw.ellipse([px(13), px(22), px(51), px(61)], fill=mix(PLATE, accent, 0.16))


def hair_back(draw: ImageDraw.ImageDraw, color):
    """The silhouette behind the head. Drawn before the face so it never covers it."""
    draw.ellipse([px(11), px(10), px(53), px(52)], fill=darken(color, 0.34))
    draw.polygon(
        [(px(12), px(30)), (px(12), px(48)), (px(18), px(45)), (px(20), px(30))],
        fill=darken(color, 0.34),
    )
    draw.polygon(
        [(px(52), px(30)), (px(52), px(48)), (px(46), px(45)), (px(44), px(30))],
        fill=darken(color, 0.34),
    )


def head(draw: ImageDraw.ImageDraw):
    draw.ellipse([px(15), px(14), px(49), px(52)], fill=SKIN_SHADE)
    draw.ellipse([px(15), px(13), px(49), px(50)], fill=SKIN)


def face(draw: ImageDraw.ImageDraw, wink=False):
    for index, cx in enumerate((px(24), px(40))):
        if wink and index == 1:
            draw.arc([cx - px(4.6), px(32), cx + px(4.6), px(41)], start=200, end=340, fill=EYE, width=int(px(1.8)))
            continue
        draw.ellipse([cx - px(4.6), px(31), cx + px(4.6), px(42)], fill=EYE)
        draw.ellipse([cx - px(3), px(32.4), cx + px(0.8), px(36.6)], fill=EYE_LIGHT)
        draw.ellipse([cx + px(0.6), px(37.6), cx + px(3), px(40)], fill=EYE_GLINT)
    draw.ellipse([px(18), px(40.5), px(23.5), px(44)], fill=BLUSH)
    draw.ellipse([px(40.5), px(40.5), px(46), px(44)], fill=BLUSH)
    draw.arc([px(29.5), px(42), px(34.5), px(47)], start=20, end=160, fill=MOUTH, width=int(px(1.4)))


def hair_front(draw: ImageDraw.ImageDraw, color, style):
    """Fringe plus cheek locks. `style` only changes the fringe silhouette."""
    dark = darken(color, 0.22)
    shine = lighten(color, 0.5)

    if style == "spiky":
        points = [
            (px(12.5), px(31)), (px(13), px(19)), (px(18), px(26)), (px(21), px(14)),
            (px(26), px(27)), (px(31), px(12)), (px(36), px(27)), (px(41), px(14)),
            (px(45), px(26)), (px(51), px(19)), (px(51.5), px(31)), (px(47), px(24)),
            (px(32), px(20)), (px(17), px(24)),
        ]
    elif style == "curtain":
        points = [
            (px(12.5), px(32)), (px(12.5), px(20)), (px(32), px(9)), (px(51.5), px(20)),
            (px(51.5), px(32)), (px(46), px(22)), (px(37), px(29)), (px(32), px(19)),
            (px(27), px(29)), (px(18), px(22)),
        ]
    else:  # "blunt"
        points = [
            (px(12.5), px(33)), (px(12.5), px(20)), (px(32), px(9)), (px(51.5), px(20)),
            (px(51.5), px(33)), (px(46.5), px(28)), (px(41), px(32)), (px(35), px(27)),
            (px(29), px(32)), (px(23), px(27)), (px(17.5), px(32)),
        ]
    draw.polygon(points, fill=color)

    # Cheek locks frame the face and read as hair even at 32px.
    draw.polygon([(px(12.5), px(24)), (px(17), px(24)), (px(18.5), px(44)), (px(12), px(40))], fill=dark)
    draw.polygon([(px(51.5), px(24)), (px(47), px(24)), (px(45.5), px(44)), (px(52), px(40))], fill=dark)
    # A single highlight band is what makes hair read as anime hair at this size.
    draw.arc([px(18), px(13), px(46), px(33)], start=200, end=340, fill=shine, width=int(px(1.6)))


def charm_star(draw: ImageDraw.ImageDraw, cx, cy, radius, color, spokes=8):
    for index in range(spokes):
        angle = math.pi * 2 * index / spokes
        dx, dy = math.cos(angle), math.sin(angle)
        draw.line(
            [cx - dx * px(radius), cy - dy * px(radius), cx + dx * px(radius), cy + dy * px(radius)],
            fill=color,
            width=int(px(1.5)),
        )
    draw.ellipse([cx - px(1.4), cy - px(1.4), cx + px(1.4), cy + px(1.4)], fill=color)


def charm_ring(draw: ImageDraw.ImageDraw, cx, cy, radius, color, sides=6):
    points = [
        (cx + math.cos(math.pi * 2 * i / sides - math.pi / 2) * px(radius),
         cy + math.sin(math.pi * 2 * i / sides - math.pi / 2) * px(radius))
        for i in range(sides)
    ]
    draw.polygon(points, outline=color, width=int(px(1.6)))


def charm_whale(draw: ImageDraw.ImageDraw, cx, cy, scale, color):
    body = [
        (cx - px(5 * scale), cy), (cx - px(2 * scale), cy - px(3.4 * scale)),
        (cx + px(2.6 * scale), cy - px(3.2 * scale)), (cx + px(5 * scale), cy - px(0.6 * scale)),
        (cx + px(2.4 * scale), cy + px(2.8 * scale)), (cx - px(2.4 * scale), cy + px(2.8 * scale)),
    ]
    draw.polygon(body, fill=color)
    draw.polygon(
        [(cx + px(4 * scale), cy - px(0.8 * scale)), (cx + px(7.6 * scale), cy - px(4 * scale)),
         (cx + px(7.6 * scale), cy + px(2.4 * scale))],
        fill=color,
    )
    draw.line(
        [cx - px(3 * scale), cy - px(3.6 * scale), cx - px(3.6 * scale), cy - px(6.4 * scale)],
        fill=color,
        width=int(px(1.2 * scale)),
    )


def charm_sparkle(draw: ImageDraw.ImageDraw, cx, cy, radius, color):
    draw.polygon(
        [(cx, cy - px(radius)), (cx + px(radius * 0.32), cy - px(radius * 0.32)),
         (cx + px(radius), cy), (cx + px(radius * 0.32), cy + px(radius * 0.32)),
         (cx, cy + px(radius)), (cx - px(radius * 0.32), cy + px(radius * 0.32)),
         (cx - px(radius), cy), (cx - px(radius * 0.32), cy - px(radius * 0.32))],
        fill=color,
    )


def build(name, accent, hair_color, style, charm, wink=False):
    image = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    plate(draw, accent)
    hair_back(draw, hair_color)
    head(draw)
    face(draw, wink=wink)
    hair_front(draw, hair_color, style)
    charm(draw, lighten(accent, 0.25))

    # A sub-pixel bloom softens the supersampled edges without blurring the face.
    glow = image.filter(ImageFilter.GaussianBlur(px(0.25)))
    image = Image.blend(image, glow, 0.15)

    icon = image.resize((SIZE, SIZE), Image.LANCZOS)
    path = os.path.normpath(os.path.join(OUT_DIR, f"{name}.png"))
    icon.save(path)
    print(f"wrote {path}")


def main():
    os.makedirs(os.path.normpath(OUT_DIR), exist_ok=True)

    build(
        "claude",
        accent=(217, 119, 87, 255),
        hair_color=(214, 138, 96, 255),
        style="curtain",
        charm=lambda draw, color: charm_star(draw, px(46.5), px(16.5), 4.8, color),
    )
    build(
        "openai",
        accent=(16, 163, 127, 255),
        hair_color=(38, 158, 128, 255),
        style="blunt",
        charm=lambda draw, color: charm_ring(draw, px(46.5), px(16.5), 4.8, color),
    )
    build(
        "deepseek",
        accent=(77, 107, 254, 255),
        hair_color=(96, 126, 224, 255),
        style="spiky",
        charm=lambda draw, color: charm_whale(draw, px(44.5), px(17), 0.85, color),
        wink=True,
    )
    build(
        "airi",
        accent=(176, 140, 255, 255),
        hair_color=(198, 170, 245, 255),
        style="curtain",
        charm=lambda draw, color: charm_sparkle(draw, px(46.5), px(16.5), 5, color),
    )


if __name__ == "__main__":
    main()
