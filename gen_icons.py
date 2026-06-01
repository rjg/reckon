#!/usr/bin/env python3
"""Generate Reckon PWA icons (pure stdlib — no Pillow needed).

Draws the four math operators (+ - x /) in a 2x2 grid, white on a full-bleed
blue square. Full-bleed = safe for both iOS squircle masking and Android
maskable icons; the operator cluster sits inside the central safe zone.

Layout (reading order):   +  -
                          x  /
"""
import zlib, struct, os

BG = (0, 122, 255)      # iOS blue
FG = (255, 255, 255)    # white glyphs
SQRT2 = 1.4142135623730951


def make_png(path, size):
    C = size * 0.60                 # operator cluster: centered square, 60% of icon
    c0 = (size - C) / 2.0
    cell = C / 2.0                  # each operator gets one 2x2 cell
    r = cell * 0.34                 # glyph half-extent within its cell
    th = cell * 0.105               # bar half-thickness (full stroke = 2*th)
    dotr = cell * 0.12              # divide-dot radius
    doff = r * 0.60                 # divide-dot offset above/below the bar
    left = c0 + cell * 0.5          # column centers
    right = c0 + cell * 1.5
    top = c0 + cell * 0.5           # row centers
    bot = c0 + cell * 1.5

    def on(xc, yc):
        # +  (top-left)
        dx = xc - left; dy = yc - top
        if (abs(dy) <= th and abs(dx) <= r) or (abs(dx) <= th and abs(dy) <= r):
            return True
        # -  (top-right)
        dx = xc - right
        if abs(dy) <= th and abs(dx) <= r:
            return True
        # x  (bottom-left): two diagonals, clipped to the glyph box
        dx = xc - left; dy = yc - bot
        if abs(dx) <= r and abs(dy) <= r and (
                abs(dx - dy) <= th * SQRT2 or abs(dx + dy) <= th * SQRT2):
            return True
        # /  (bottom-right): bar plus a dot above and below
        dx = xc - right
        if (abs(dy) <= th and abs(dx) <= r) or \
           (dx * dx + (dy + doff) ** 2 <= dotr * dotr) or \
           (dx * dx + (dy - doff) ** 2 <= dotr * dotr):
            return True
        return False

    white = bytes(FG)
    blue = bytes(BG)
    raw = bytearray()
    for y in range(size):
        raw.append(0)               # PNG filter byte (none)
        yc = y + 0.5
        for x in range(size):
            raw += white if on(x + 0.5, yc) else blue

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(out)
    print('wrote %s (%dx%d, %d bytes)' % (path, size, size, len(out)))


if __name__ == '__main__':
    os.makedirs('icons', exist_ok=True)
    make_png('icons/icon-512.png', 512)
    make_png('icons/icon-192.png', 192)
    make_png('icons/apple-touch-icon.png', 180)
