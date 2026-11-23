# -*- coding: utf-8 -*-
"""r189 视觉收尾：本地 qwen3.5:9b(vision) 独立复核截图。只问布局/元素存在性，不做 OCR 文案核对。"""
import base64, io, json, os, urllib.request
from PIL import Image

OUT = r'H:\这个是新工作区\night_work\visual-r189\local-vision-review.jsonl'
WEB = r'K:\yueyueneiceban\web'
SHOT = r'H:\这个是新工作区\night_work\visual-r189'
F1 = r'K:\yueyueneiceban\_r112-art\v23-recv-2026-10-28\F1-白外套藏青裙-20261028.png'

def b64(im, maxw=1024):
    if im.width > maxw:
        im = im.resize((maxw, int(im.height*maxw/im.width)), Image.LANCZOS)
    buf = io.BytesIO(); im.convert('RGB').save(buf, 'JPEG', quality=88)
    return base64.b64encode(buf.getvalue()).decode()

def ask(tag, imgs, prompt):
    body = json.dumps({'model':'qwen3.5:9b','stream':False,'think':False,'options':{'temperature':0.1,'num_predict':1500},
        'messages':[{'role':'user','content':prompt,'images':imgs}]}).encode()
    req = urllib.request.Request('http://127.0.0.1:11434/api/chat', data=body, headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            d = json.loads(r.read())
            ans = d.get('message',{}).get('content','')
    except Exception as e:
        ans = 'ERROR: %r' % e
    with open(OUT,'a',encoding='utf-8') as f:
        f.write(json.dumps({'tag':tag,'answer':ans},ensure_ascii=False)+'\n')
    print(tag, 'done', len(ans))

# a) F1 立绘元素存在性
f1 = Image.open(F1)
ask('f1-elements', [b64(f1, 896)],
    '这是一张动漫少女全身立绘（白背景）。请只回答以下问题，逐条编号：'
    '1) 白色上衣与白色背景交界处，是否有深色线条勾勒轮廓？'
    '2) 腰部是否挂着一个圆形太极/阴阳鱼图案的牌子？在哪一侧？'
    '3) 颈部是否有一条细项链带月牙形吊坠？'
    '4) 马尾辫根部是否有一个葫芦形饰物？'
    '5) 她的发色、瞳色、服装配色分别是什么？'
    '6) 画面有没有明显的崩坏（多手指、断肢、结构错误）？')

# b) landing 780 三段
im = Image.open(os.path.join(SHOT,'landing-780-before.png'))
crops = [im.crop((0,0,780,1750)), im.crop((0,2400,780,3350)), im.crop((0,5200,780,6200))]
ask('landing-780-layout', [b64(c,780) for c in crops],
    '这是同一个网页在 780px 宽下的三段截图（首屏/中段/页尾）。请逐条回答：'
    '1) 有没有文字溢出容器、互相重叠、被截断的地方？'
    '2) 首屏立绘卡片显示是否完整正常？'
    '3) 中段引用卡片里的小字行（左侧有竖线）排版是否正常？'
    '4) 页尾二维码和文字是否正常？'
    '5) 整体配色是浅色纸感还是深色霓虹？有没有刺眼的渐变发光按钮？')

# c) og 卡 + support 表单段
og = Image.open(os.path.join(WEB,'og-1200x630.png'))
sp = Image.open(os.path.join(SHOT,'support-780-before.png')).crop((0,500,780,1750))
ask('og-and-support', [b64(og,1200), b64(sp,780)],
    '第一张是 1200x630 社交分享卡，第二张是打赏页中部截图。请逐条回答：'
    '1) 分享卡：左侧文字与右侧人物是否重叠？人物是否完整（头到脚）？底部有没有小字标注「图像由 AI 生成」？'
    '2) 分享卡整体是浅色纸感还是深色霓虹？'
    '3) 打赏页截图里的提交按钮是什么颜色/样式？是平色还是渐变？白字在上面清晰吗？'
    '4) 打赏页有没有文字溢出或重叠？')
print('ALL DONE')