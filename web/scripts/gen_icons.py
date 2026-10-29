"""Gera ícones PNG simples (192, 512, maskable, apple-touch) em public/icons."""
from PIL import Image, ImageDraw, ImageFont
import os
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icons')
BG, FG = (14, 17, 22), (52, 211, 153)
def make(size, pad, name):
    im = Image.new('RGB', (size, size), BG); d = ImageDraw.Draw(im)
    r = size * (0.5 - pad)
    c = size / 2
    d.ellipse([c - r, c - r, c + r, c + r], fill=FG)
    try: f = ImageFont.truetype('DejaVuSans-Bold.ttf', int(r * 1.2))
    except Exception: f = ImageFont.load_default()
    d.text((c, c), 'B', fill=BG, font=f, anchor='mm')
    im.save(os.path.join(OUT, name))
os.makedirs(OUT, exist_ok=True)
make(192, 0.08, 'icon-192.png'); make(512, 0.08, 'icon-512.png')
make(512, 0.22, 'icon-maskable-512.png'); make(180, 0.08, 'apple-touch-icon.png')
