# -*- coding: utf-8 -*-
"""第116轮：用 F1 定稿立绘重出网页图标（favicon / apple-touch / PWA 192+512）

真源：_r112-art/v23-recv-2026-10-28/修/F1-白外套藏青裙-20261028-精修-2x.png（2048×3072）
裁切（2x 像素）：(400, 30) - (1380, 1010)，即 980×980 的正方形，框住头+肩，脸居中偏上。
再贴到白底上留 12% 边距 —— manifest 里 512 同时当 maskable 用，安全圈内不切到脸。

生成：web/icon-192.png、web/icon-512.png
（favicon.ico 由 web/build-static.py 从 icon-192 自动生成 16/32/48，不在这里做）
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.join(ROOT, '..')
SRC = os.path.join(BASE, '_r112-art', 'v23-recv-2026-10-28', '修', 'F1-白外套藏青裙-20261028-精修-2x.png')
BOX = (400, 30, 1380, 1010)
PAD = 0.12

def build(size):
    im = Image.open(SRC).convert('RGB').crop(BOX)
    inner = round(size * (1 - 2 * PAD))
    face = im.resize((inner, inner), Image.LANCZOS)
    canvas = Image.new('RGB', (size, size), (255, 255, 255))
    off = (size - inner) // 2
    canvas.paste(face, (off, off))
    return canvas

if __name__ == '__main__':
    if not os.path.exists(SRC):
        raise SystemExit('[FAIL] 找不到真源立绘：%s' % SRC)
    for size, name in [(512, 'icon-512.png'), (192, 'icon-192.png')]:
        out = os.path.join(ROOT, name)
        build(size).save(out, 'PNG', optimize=True)
        data = open(out, 'rb').read()
        import hashlib
        print('[OK] %s %d×%d %d B sha256=%s' % (name, size, size, len(data), hashlib.sha256(data).hexdigest()[:16].upper()))
