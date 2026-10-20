"""Draw the Dirth icon: a dash and three corners stepping up on lime green.

Writes, under src/renderer/assets:
  icon.png        512 px tile: window icon on Windows, README
  brand-mark.png  64 px tile drawn for the 25 px title-bar mark
  icon.ico        Windows sizes 16-256
  icon.icns       Mac sizes 16-1024 on Apple's icon grid (824 px body in a
                  1024 px canvas, with its drop shadow)

The mark is flat geometry, so each size is drawn at several times its size
and reduced, which keeps every edge smooth. Below 32 px the mark is drawn a
little larger in its tile so the gaps between the steps stay open.

Requires Python 3 with Pillow:
  python3 -m pip install pillow
  python3 scripts/make-icon.py
"""
import io
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

DEST = Path(__file__).resolve().parents[1] / 'src' / 'renderer' / 'assets'

LIME = (0xd4, 0xeb, 0x89)  # the Tokyo edition's --lime
INK = (0x22, 0x27, 0x23)

# The mark on a 1024 tile. Every step is a corner of the same size, moved
# STEP up and to the right of the one before; the dash is a corner without
# its downstroke. The whole mark is centred on the tile.
STROKE, SIZE, STEP = 96, 320, 148
EDGE, OUTER, INNER = 16, 28, 14  # corner radii: ends, the bend's outside and inside


def mark_shapes():
    """Each shape as a list of (x, y, corner radius) on the 1024 tile, clockwise."""
    left = (1024 - (3 * STEP + SIZE)) / 2  # dash to the top corner's right edge
    top = (1024 - (2 * STEP + SIZE)) / 2   # top corner down to the first corner's foot
    shapes = []
    for i in range(4):
        x, y = left + i * STEP, top + (3 - i) * STEP
        right, bottom = x + SIZE, y + SIZE
        if i == 0:
            shapes.append([(x, y, EDGE), (right, y, EDGE), (right, y + STROKE, EDGE), (x, y + STROKE, EDGE)])
        else:
            shapes.append([(x, y, EDGE), (right, y, OUTER), (right, bottom, EDGE), (right - STROKE, bottom, EDGE),
                           (right - STROKE, y + STROKE, INNER), (x, y + STROKE, EDGE)])
    return shapes


def rounded(points, steps=24):
    """Polygon points with each right-angled corner replaced by an arc of its radius."""
    out = []
    for i, (px, py, r) in enumerate(points):
        ax, ay, _ = points[i - 1]
        bx, by, _ = points[(i + 1) % len(points)]
        ux, uy = (ax - px) / math.hypot(ax - px, ay - py), (ay - py) / math.hypot(ax - px, ay - py)
        vx, vy = (bx - px) / math.hypot(bx - px, by - py), (by - py) / math.hypot(bx - px, by - py)
        cx, cy = px + r * (ux + vx), py + r * (uy + vy)
        for k in range(steps + 1):
            t = math.pi / 2 * k / steps
            out.append((cx - r * (vx * math.cos(t) + ux * math.sin(t)), cy - r * (vy * math.cos(t) + uy * math.sin(t))))
    return out


SHAPES = [rounded(shape) for shape in mark_shapes()]
# The tile: a unit square with corners rounded to 21% of its width.
TILE = rounded([(0, 0, 0.21), (1, 0, 0.21), (1, 1, 0.21), (0, 1, 0.21)], steps=120)


def tile(pixels, margin, shadow=False):
    """The tile, `margin` (a fraction) in from each edge, drawn large and reduced to `pixels`."""
    scale = max(4, 1024 // pixels)
    canvas_px = pixels * scale
    body = canvas_px * (1 - 2 * margin)
    offset = canvas_px * margin
    zoom = 1.12 if body / scale < 32 else 1  # small sizes: a larger mark keeps its gaps open
    outline = [(offset + x * body, offset + y * body) for x, y in TILE]
    place = lambda pt: (offset + body * (0.5 + (pt[0] / 1024 - 0.5) * zoom), offset + body * (0.5 + (pt[1] / 1024 - 0.5) * zoom))
    out = Image.new('RGBA', (canvas_px, canvas_px), (0, 0, 0, 0))
    if shadow:
        alpha = Image.new('L', (canvas_px, canvas_px), 0)
        drop = canvas_px * 0.012
        ImageDraw.Draw(alpha).polygon([(x, y + drop) for x, y in outline], fill=255)
        alpha = alpha.filter(ImageFilter.GaussianBlur(canvas_px * 0.014)).point(lambda v: v // 2)
        out.putalpha(alpha)
    draw = ImageDraw.Draw(out)
    draw.polygon(outline, fill=LIME + (255,))
    for shape in SHAPES:
        draw.polygon([place(pt) for pt in shape], fill=INK + (255,))
    # Averaged with premultiplied alpha, so the tile's edge does not darken.
    return out.convert('RGBa').reduce(scale).convert('RGBA')


def icns(images):
    """Every size iconutil writes, as PNG entries (Pillow's writer skips 16 and 32 px)."""
    types = [(b'icp4', 16), (b'icp5', 32), (b'icp6', 64), (b'ic07', 128), (b'ic08', 256), (b'ic09', 512),
             (b'ic10', 1024), (b'ic11', 32), (b'ic12', 64), (b'ic13', 256), (b'ic14', 512)]
    entries = []
    for kind, px in types:
        data = io.BytesIO()
        images[px].save(data, 'PNG', optimize=True)
        entries.append(kind + (8 + len(data.getvalue())).to_bytes(4, 'big') + data.getvalue())
    toc = b''.join(entry[:8] for entry in entries)
    toc = b'TOC ' + (8 + len(toc)).to_bytes(4, 'big') + toc
    body = toc + b''.join(entries)
    return b'icns' + (8 + len(body)).to_bytes(4, 'big') + body


def main():
    tile(512, margin=0.02).save(DEST / 'icon.png', optimize=True)
    tile(64, margin=0.02).save(DEST / 'brand-mark.png', optimize=True)

    windows = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
    frames = [tile(px, margin=0.02) for px in windows]
    frames[-1].save(DEST / 'icon.ico', sizes=[(px, px) for px in windows], append_images=frames[:-1])

    # Apple's grid: an 824 px body centred in 1024 px, with a soft shadow.
    mac = {px: tile(px, margin=100 / 1024, shadow=True) for px in (16, 32, 64, 128, 256, 512, 1024)}
    (DEST / 'icon.icns').write_bytes(icns(mac))
    for name in ('icon.png', 'brand-mark.png', 'icon.ico', 'icon.icns'):
        print(DEST / name)


if __name__ == '__main__':
    main()
