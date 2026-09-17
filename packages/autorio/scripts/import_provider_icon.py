#!/usr/bin/env python3
"""Import a provider avatar from source artwork.

Turns artwork of any size into the square, transparent, 128x128 PNG the mod's
sprite prototype expects.

A white-background source is keyed to transparent first. That is a flood fill
from the border rather than a global "white is transparent" test, so white
inside the drawing - a maid headdress, an eye highlight - survives.

Framing is the part worth getting right, because every avatar sits in the same
button and an inconsistent one reads as a mistake:

  --slice X0:X1   take one figure out of a multi-figure sheet by pixel column.
  --frame SIDE    crop a SIDE x SIDE box out of the SOURCE, centred on the
                  widest row of the head. This is what keeps a set consistent:
                  one SIDE across every figure of a sheet lands every head at
                  the same size, however tall or short that figure's own
                  artwork happens to be. Squaring each figure by its own
                  bounding box does not - a short drawing is scaled up more
                  than a tall one, and the heads come out different sizes.
  --anchor F      where the widest row sits in that box, top to bottom.
  --keep-top F    for single portrait art with no sheet to match: drop the
                  bottom of the drawing before squaring by bounding box, so
                  the costume does not eat the frame.

Usage:
  python packages/autorio/scripts/import_provider_icon.py <source> <id> [options]
  ... <source> <id> --slice 878:1300 --frame 500
  ... <source> <id> --keep-top 0.72
  ... <source> <id> --check
"""

from __future__ import annotations

import os
import sys
from collections import deque

from PIL import Image

# 128 source pixels drawn at 32 GUI units, so the icon stays crisp at the 200%
# UI scale Factorio allows instead of being upscaled from a 1:1 source.
TARGET = 128
# Share of the square the artwork fills, so it does not touch the button border.
INSET = 0.94
# How far a border pixel may differ from white and still be treated as backdrop.
WHITE_TOLERANCE = 18
# Only the upper part of a figure is searched for the widest row; below that a
# costume or a held prop is often wider than the head.
HEAD_BAND = 0.62
DEFAULT_ANCHOR = 0.55

OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "graphics", "icons", "provider"),
)


def key_white_background(image):
    """Flood-fill transparency in from the border, so interior white is kept."""
    width, height = image.size
    pixels = image.load()

    def is_backdrop(x, y):
        r, g, b, a = pixels[x, y]
        return a == 0 or min(r, g, b) >= 255 - WHITE_TOLERANCE

    seen = bytearray(width * height)
    queue = deque()
    border = [(x, y) for x in range(width) for y in (0, height - 1)]
    border += [(x, y) for y in range(height) for x in (0, width - 1)]
    for x, y in border:
        if is_backdrop(x, y) and not seen[y * width + x]:
            seen[y * width + x] = 1
            queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        pixels[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < width and 0 <= ny < height and not seen[ny * width + nx] and is_backdrop(nx, ny):
                seen[ny * width + nx] = 1
                queue.append((nx, ny))
    return image


def widest_head_row(art):
    """(y, centre_x) of the widest opaque row in the head band."""
    pixels = art.getchannel("A").load()
    best_width, best_y, best_centre = 0, 0, art.width / 2
    for y in range(max(1, int(art.height * HEAD_BAND))):
        row = [x for x in range(art.width) if pixels[x, y] > 8]
        if not row:
            continue
        width = row[-1] - row[0] + 1
        if width > best_width:
            best_width, best_y, best_centre = width, y, (row[0] + row[-1]) / 2
    return best_y, best_centre


def to_icon(source_path, slice_x=None, frame=None, anchor=DEFAULT_ANCHOR, keep_top=1.0):
    image = Image.open(source_path).convert("RGBA")
    if image.getchannel("A").getextrema()[0] == 255:
        image = key_white_background(image)
    if slice_x is not None:
        image = image.crop((slice_x[0], 0, slice_x[1] + 1, image.height))

    box = image.getchannel("A").getbbox()
    if box is None:
        raise SystemExit(f"{source_path}: nothing left after keying the background")
    art = image.crop(box)

    if frame is not None:
        y, centre = widest_head_row(art)
        square = Image.new("RGBA", (frame, frame), (0, 0, 0, 0))
        square.paste(art, (-round(centre - frame / 2), -round(y - anchor * frame)))
    else:
        if keep_top < 1.0:
            art = art.crop((0, 0, art.width, max(1, round(art.height * keep_top))))
            trimmed = art.getchannel("A").getbbox()
            if trimmed is None:
                raise SystemExit(f"{source_path}: --keep-top {keep_top} cropped everything away")
            art = art.crop(trimmed)
        side = max(art.size)
        square = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        square.paste(art, ((side - art.width) // 2, (side - art.height) // 2))

    inner = max(1, round(TARGET * INSET))
    icon = Image.new("RGBA", (TARGET, TARGET), (0, 0, 0, 0))
    icon.paste(square.resize((inner, inner), Image.LANCZOS), ((TARGET - inner) // 2, (TARGET - inner) // 2))
    return icon


def take(argv, flag, convert, default):
    if flag not in argv:
        return default
    at = argv.index(flag)
    try:
        value = convert(argv[at + 1])
    except (IndexError, ValueError):
        raise SystemExit(f"{flag} needs a value")
    del argv[at:at + 2]
    return value


def head_width(icon):
    """Rough head width in the finished icon, for the consistency report."""
    pixels = icon.getchannel("A").load()
    row = [x for y in range(40, 80) for x in range(icon.width) if pixels[x, y] > 8]
    return max(row) - min(row) + 1 if row else 0


def main():
    argv = sys.argv[1:]
    check_only = "--check" in argv
    slice_x = take(argv, "--slice", lambda v: tuple(int(part) for part in v.split(":")), None)
    frame = take(argv, "--frame", int, None)
    anchor = take(argv, "--anchor", float, DEFAULT_ANCHOR)
    keep_top = take(argv, "--keep-top", float, 1.0)
    if slice_x is not None and len(slice_x) != 2:
        raise SystemExit("--slice takes X0:X1")
    if not 0 < keep_top <= 1 or not 0 < anchor < 1:
        raise SystemExit("--keep-top and --anchor are fractions")

    args = [arg for arg in argv if not arg.startswith("--")]
    if len(args) != 2:
        raise SystemExit(__doc__)
    source, provider = args

    icon = to_icon(source, slice_x, frame, anchor, keep_top)
    # Printed so a set imported with one --frame can be eyeballed for drift.
    report = f"{provider}: {icon.size[0]}x{icon.size[1]}, head {head_width(icon)}px"
    if check_only:
        print(f"{report} (not written)")
        return

    os.makedirs(OUT_DIR, exist_ok=True)
    out = os.path.join(OUT_DIR, provider + ".png")
    icon.save(out)
    print(f"wrote {out} - {report}")


if __name__ == "__main__":
    main()
