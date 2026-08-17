#!/usr/bin/env python3
"""Regenerates the Windows icon assets from the geometry in src/icons/AppIcon.svg.

macOS gets its icons from the Affinity Designer files next to this script's
output (AppIcon.icns, the *.Template.png tray icons). Windows needs two things
those don't provide:

  * AppIcon.ico  - electron-packager stamps this onto Frost.exe and Squirrel
                   uses it for the installer and the Add/Remove Programs entry.
  * TrayIcon*.png - the macOS tray icons are *template* images (black shape +
                   alpha, inverted by the OS). Windows draws tray images
                   as-is, so a black snowflake disappears into the default
                   dark taskbar. These are the same snowflakes drawn in white
                   on the blue app badge, which reads on light and dark alike.

Both derive from the same vector data as AppIcon.svg so the three platforms
stay in sync. Run with Pillow installed:

    pip install Pillow && python3 tools/generate-windows-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

ICONS = Path(__file__).resolve().parent.parent / "src" / "icons"

# Anti-aliasing factor. Everything is drawn this many times larger and then
# downsampled, which is how we get smooth edges out of ImageDraw.
SS = 16

# Badge gradient, straight off the `_Linear1` stop list in AppIcon.svg.
GRADIENT_START = (2, 23, 187)
GRADIENT_END = (46, 46, 244)

# The snowflake outline from AppIcon.svg, in the local units of the path data.
# It is placed by two nested transforms in the SVG; we only care about the
# shape, so it gets normalised into the target box below.
SNOWFLAKE = [
    (0.293, -0.570), (0.424, -0.613), (0.454, -0.518), (0.323, -0.476),
    (0.406, -0.362), (0.323, -0.301), (0.239, -0.416), (0.158, -0.306),
    (0.077, -0.367), (0.161, -0.476), (0.028, -0.522), (0.060, -0.617),
    (0.191, -0.570), (0.191, -0.708), (0.293, -0.708),
]


def normalized_snowflake(size, coverage):
    """Scales the snowflake to `coverage` of a `size`-wide square, centred.

    The SVG's own transform matrices assume an 18pt canvas; normalising from
    the shape's own bounding box instead keeps the flake centred at any size.
    """
    xs = [p[0] for p in SNOWFLAKE]
    ys = [p[1] for p in SNOWFLAKE]
    width, height = max(xs) - min(xs), max(ys) - min(ys)
    scale = size * coverage / max(width, height)
    offset_x = (size - width * scale) / 2 - min(xs) * scale
    offset_y = (size - height * scale) / 2 - min(ys) * scale
    return [(x * scale + offset_x, y * scale + offset_y) for x, y in SNOWFLAKE]


def badge(size, padding, radius_ratio):
    """The blue rounded square, as an RGBA image with a transparent surround."""
    box = size * SS
    inset = padding * SS
    radius = (box - 2 * inset) * radius_ratio

    gradient = Image.new("RGB", (box, 1))
    for x in range(box):
        t = x / max(box - 1, 1)
        gradient.putpixel(
            (x, 0),
            tuple(
                round(start + (end - start) * t)
                for start, end in zip(GRADIENT_START, GRADIENT_END)
            ),
        )
    gradient = gradient.resize((box, box))

    mask = Image.new("L", (box, box), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (inset, inset, box - inset - 1, box - inset - 1), radius=radius, fill=255
    )

    image = Image.new("RGBA", (box, box), (0, 0, 0, 0))
    image.paste(gradient, (0, 0), mask)
    return image


def draw_snowflake(image, size, coverage, filled, stroke_ratio):
    points = normalized_snowflake(size * SS, coverage)
    draw = ImageDraw.Draw(image)
    if filled:
        draw.polygon(points, fill=(255, 255, 255, 255))
    else:
        width = max(round(size * SS * stroke_ratio), 1)
        draw.line(
            points + [points[0]],
            fill=(255, 255, 255, 255),
            width=width,
            joint="curve",
        )


def render(size, *, filled, padding=0.5, coverage=0.62, radius_ratio=0.235,
           stroke_ratio=0.055):
    image = badge(size, padding, radius_ratio)
    draw_snowflake(image, size, coverage, filled, stroke_ratio)
    return image.resize((size, size), Image.LANCZOS)


def main():
    # App icon: matches the macOS artwork's proportions (a badge inset from the
    # canvas edge), which is also what Windows expects for a .ico.
    app_icon_sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [
        render(size, filled=True, padding=size * 0.07, coverage=0.52)
        for size in app_icon_sizes
    ]
    frames[-1].save(
        ICONS / "AppIcon.ico",
        format="ICO",
        sizes=[(size, size) for size in app_icon_sizes],
        append_images=frames[:-1],
    )

    # Tray icons: nearly full-bleed, because 16px of taskbar is all we get.
    # `Full` is the idle state, `Empty` shows while a refresh is running -
    # same solid/outline pairing as the macOS template icons.
    for name, filled in (("TrayIconFull", True), ("TrayIconEmpty", False)):
        for suffix, size in (("", 16), ("@2x", 32)):
            render(size, filled=filled, padding=0.5, coverage=0.66).save(
                ICONS / f"{name}{suffix}.png"
            )

    print(f"Wrote AppIcon.ico and TrayIcon*.png to {ICONS}")


if __name__ == "__main__":
    main()
