# -*- coding: utf-8 -*-
"""生成社交分享图 assets/og-1200x630.png（QQ/微信/抖音/B站 链接预览用）。

第119轮：之前 <head> 里没有 og:*，别人转发链接只有一行秃标题。
这里出一张 1200x630 的纸感卡：左边文字，右边 F1 立绘（同页面的米白照片卡）。
改完跑：python make_og.py   → 重新生成 web/og-1200x630.png
（build-static.py 的 build_assets() 会把它拷进 dist-static/assets/）
"""
import os
from PIL import Image, ImageDraw, ImageFont

WEB = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(WEB)
HERO = os.path.join(ROOT, '_r112-art', 'v23-recv-2026-10-28', 'F1-白外套藏青裙-20261028.png')
OUT = os.path.join(WEB, 'og-1200x630.png')

W, H = 1200, 630
BG = (250, 248, 244)      # #FAF8F4 暖白纸
INK = (35, 33, 30)        # #23211E
INK2 = (92, 88, 80)
GOLD = (138, 106, 34)     # #8A6A22
LINE = (226, 224, 218)

FR = 'C:/Windows/Fonts/msyh.ttc'
FRB = 'C:/Windows/Fonts/msyhbd.ttc'


def F(p, s):
    return ImageFont.truetype(p, s)


im = Image.new('RGB', (W, H), BG)
d = ImageDraw.Draw(im)

# ---- 右：立绘做成「米白照片卡」——四周留白，和网页里的 .figure 一致 ----
AH = 540                      # 卡片内立绘高度（r189：560→540，给右下角 AI 标识小字让位）
art = Image.open(HERO).convert('RGB')
tw = int(art.width * AH / art.height)
art = art.resize((tw, AH), Image.LANCZOS)
x0 = W - tw - 62
y0 = (H - AH) // 2
im.paste(art, (x0, y0))
d.rectangle([x0 - 12, y0 - 12, x0 + tw + 11, y0 + AH + 11], outline=LINE, width=1)

# ---- 左：文字 ----
LX = 72
d.text((LX, 92), '同行者 · 不是恋人', font=F(FR, 24), fill=GOLD, anchor='ls')
d.rectangle([LX, 114, LX + 168, 117], fill=GOLD)

d.text((LX, 262), '玥玥', font=F(FRB, 132), fill=INK, anchor='ls')

d.text((LX, 344), '她不是真人，', font=F(FR, 38), fill=INK2, anchor='ls')
d.text((LX, 400), '也永远不会假装是真人。', font=F(FR, 38), fill=INK2, anchor='ls')

d.rectangle([LX, 448, LX + 470, 449], fill=LINE)
d.text((LX, 492), '住在你电脑桌面上的 AI 伙伴', font=F(FR, 28), fill=INK2, anchor='ls')
d.text((LX, 546), '内测中 · 群号 1002686604', font=F(FR, 26), fill=INK, anchor='ls')

# r189 视觉收尾：AI 标识是红线（§十六）——分享卡右下角小字，与网页立绘同款口径
d.text((W - 24, 618), '图像由 AI 生成', font=F(FR, 18), fill=INK2, anchor='rs')

im.save(OUT, 'PNG', optimize=True)
print('og', im.size, os.path.getsize(OUT), 'B ->', OUT)
