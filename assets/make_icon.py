"""Draw the Study-Buddy-1000 app icon (stacked flash cards + check) with Pillow.
Run: python3 assets/make_icon.py  -> assets/icon-512.png, icon-180.png, apple-touch-icon.png, favicon.ico, icon-1024.png"""
import os
from PIL import Image, ImageDraw, ImageFilter
HERE = os.path.dirname(os.path.abspath(__file__))
S = 2048  # supersample canvas
TEAL, TEAL_DARK, TEAL_LIGHT = (31, 85, 99), (22, 63, 74), (42, 110, 124)
AMBER, PAPER = (240, 182, 90), (250, 246, 236)

def bg():
    # opaque full-bleed square (iOS applies its own rounded mask) with a soft diagonal gradient
    im = Image.new("RGB", (S, S), TEAL)
    g = Image.linear_gradient("L").resize((S, S))  # top->bottom 0..255
    px = Image.blend(g, g.rotate(90), 0.5)  # diagonal: light top-left, dark bottom-right
    light = Image.new("RGB", (S, S), TEAL_LIGHT)
    dark = Image.new("RGB", (S, S), TEAL_DARK)
    return Image.composite(dark, light, px)

def card_layer(w, h, fill, angle, cx, cy, radius, check=False, shadow=True):
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    c = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=fill)
    if check:
        # bold teal check mark
        pts = [(w * 0.24, h * 0.53), (w * 0.43, h * 0.71), (w * 0.77, h * 0.30)]
        lw = int(w * 0.13)
        d.line(pts, fill=TEAL + (255,), width=lw, joint="curve")
        for x, y in (pts[0], pts[-1]):
            d.ellipse([x - lw / 2, y - lw / 2, x + lw / 2, y + lw / 2], fill=TEAL + (255,))
    c = c.rotate(angle, resample=Image.BICUBIC, expand=True)
    pos = (int(cx - c.width / 2), int(cy - c.height / 2))
    if shadow:
        sh = Image.new("RGBA", c.size, (0, 0, 0, 0))
        sh.putalpha(c.getchannel("A").point(lambda a: int(a * 0.35)))
        sh = sh.filter(ImageFilter.GaussianBlur(S * 0.018))
        layer.alpha_composite(sh, (pos[0], pos[1] + int(S * 0.025)))
    layer.alpha_composite(c, pos)
    return layer

im = bg().convert("RGBA")
cw, ch = int(S * 0.62), int(S * 0.45)
im.alpha_composite(card_layer(cw, ch, AMBER + (255,), 12, S * 0.43, S * 0.39, int(S * 0.06)))
im.alpha_composite(card_layer(cw, ch, PAPER + (255,), -6, S * 0.54, S * 0.60, int(S * 0.06), check=True))
im = im.convert("RGB")

big = im.resize((1024, 1024), Image.LANCZOS)
big.save(os.path.join(HERE, "icon-1024.png"), optimize=True)
for name, size in (("icon-512.png", 512), ("icon-180.png", 180), ("apple-touch-icon.png", 180), ("icon-32.png", 32)):
    big.resize((size, size), Image.LANCZOS).save(os.path.join(HERE, name), optimize=True)
big.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
# preview: home-screen style rounded masks at 180, 120 and 60 px on light and dark wallpapers
prev = Image.new("RGB", (800, 300), (238, 236, 230))
d = ImageDraw.Draw(prev)
d.rectangle([400, 0, 800, 300], fill=(28, 30, 36))
x = 20
for wall_x in (0, 400):
    x = wall_x + 20
    for size in (180, 90, 60):
        ic = big.resize((size, size), Image.LANCZOS)
        m = Image.new("L", (size, size), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.225), fill=255)
        prev.paste(ic, (x, 60), m)
        x += size + 20
prev.save(os.path.join(HERE, "icon-preview.png"))
print("ok")
