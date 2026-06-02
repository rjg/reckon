#!/usr/bin/env python3
"""Generate Reckon's PWA icons — the "Zen" identity (needs Pillow).

The four math operators (+ - x /) in a 2x2 grid, painted in deep ink-green on a
warm washi-paper field, with a small ume "seal" dot at the lower right like a
sumi-e hanko stamp. Full-bleed so it's safe for both the iOS squircle and
Android "maskable" masking — the operator cluster + seal sit inside the central
safe zone (radius < 40%). Rendered at 4x and downsampled for clean anti-aliasing.

Matches the in-app Zen theme (washi paper + matcha accent). Regenerate with:
    python3 gen_icons.py            # pip install Pillow, if needed

Layout (reading order):   +  -
                          x  /
"""
import math, os
from PIL import Image, ImageDraw

SS = 4                          # supersample factor → anti-aliasing on downscale

WASHI_EDGE   = (233, 224, 206)  # paper at the corners (== manifest background_color)
WASHI_CENTER = (248, 243, 233)  # paper, a touch brighter in the middle
INK_GREEN    = (47, 74, 42)     # operators — deep ink-green, high contrast on paper
UME          = (181, 101, 135)  # the seal dot


def _lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _radial_paper(d, N):
    """A soft radial wash: brighter centre, even paper colour to every edge."""
    d.rectangle([0, 0, N, N], fill=WASHI_EDGE)
    cx = cy = N / 2.0
    maxR = N * 0.74
    steps = 280
    for i in range(steps):
        t = i / (steps - 1)
        r = (1 - t) * maxR
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=_lerp(WASHI_EDGE, WASHI_CENTER, t))


def _operators(d, N, color, scale=0.52):
    C = N * scale
    c0 = (N - C) / 2.0
    cell = C / 2.0
    r = cell * 0.34          # glyph half-extent within its cell
    th = cell * 0.105        # bar half-thickness
    dotr = cell * 0.12       # divide-dot radius
    doff = r * 0.60          # divide-dot offset above/below the bar
    left = c0 + cell * 0.5
    right = c0 + cell * 1.5
    top = c0 + cell * 0.5
    bot = c0 + cell * 1.5
    # +  (top-left)
    d.rectangle([left - r, top - th, left + r, top + th], fill=color)
    d.rectangle([left - th, top - r, left + th, top + r], fill=color)
    # -  (top-right)
    d.rectangle([right - r, top - th, right + r, top + th], fill=color)
    # x  (bottom-left): two diagonal bars
    for ax, ay, bx, by in [(-r, -r, r, r), (-r, r, r, -r)]:
        A = (left + ax, bot + ay)
        B = (left + bx, bot + by)
        dx, dy = B[0] - A[0], B[1] - A[1]
        L = math.hypot(dx, dy)
        nx, ny = -dy / L * th, dx / L * th
        d.polygon([(A[0] + nx, A[1] + ny), (B[0] + nx, B[1] + ny),
                   (B[0] - nx, B[1] - ny), (A[0] - nx, A[1] - ny)], fill=color)
    # /  (bottom-right): bar plus a dot above and below
    d.rectangle([right - r, bot - th, right + r, bot + th], fill=color)
    d.ellipse([right - dotr, bot - doff - dotr, right + dotr, bot - doff + dotr], fill=color)
    d.ellipse([right - dotr, bot + doff - dotr, right + dotr, bot + doff + dotr], fill=color)


def _seal(d, N):
    rr = N * 0.034
    px, py = N * 0.735, N * 0.735
    d.ellipse([px - rr, py - rr, px + rr, py + rr], fill=UME)


def make_png(path, size):
    N = size * SS
    img = Image.new('RGB', (N, N))
    d = ImageDraw.Draw(img)
    _radial_paper(d, N)
    _operators(d, N, INK_GREEN)
    _seal(d, N)
    img.resize((size, size), Image.LANCZOS).save(path)
    print('wrote %s (%dx%d)' % (path, size, size))


if __name__ == '__main__':
    os.makedirs('icons', exist_ok=True)
    make_png('icons/icon-512.png', 512)
    make_png('icons/icon-192.png', 192)
    make_png('icons/apple-touch-icon.png', 180)
