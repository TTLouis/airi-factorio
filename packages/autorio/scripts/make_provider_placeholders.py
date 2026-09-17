#!/usr/bin/env python3
"""Write the placeholder provider avatars.

These are not artwork. Each file is a flat plate in the vendor's brand color, so
that the console button is visibly per-vendor before anyone has dropped the real
icons in, and so the data stage - which has no file-exists test and treats a
missing sprite file as a hard load failure - always finds a file to load.

Replace any of them with that vendor's own 64x64 PNG and nothing else has to
change; see graphics/icons/provider/README.md.

Usage: python packages/autorio/scripts/make_provider_placeholders.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw

SIZE = 64
SS = 8
N = SIZE * SS
OUT_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "graphics", "icons", "provider"),
)

PLACEHOLDERS = {
    "claude": (217, 119, 87),
    "openai": (16, 163, 127),
    "deepseek": (77, 107, 254),
}


def darken(color, amount):
    return tuple(round(channel * (1 - amount)) for channel in color)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, color in PLACEHOLDERS.items():
        image = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle([0, 0, N - 1, N - 1], radius=SS * 14, fill=darken(color, 0.62) + (255,))
        draw.rounded_rectangle(
            [SS * 5, SS * 5, N - 1 - SS * 5, N - 1 - SS * 5],
            radius=SS * 10,
            fill=color + (255,),
        )
        path = os.path.join(OUT_DIR, name + ".png")
        image.resize((SIZE, SIZE), Image.LANCZOS).save(path)
        print("wrote " + path)


if __name__ == "__main__":
    main()
