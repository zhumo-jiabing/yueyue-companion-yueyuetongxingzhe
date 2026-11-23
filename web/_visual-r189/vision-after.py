# -*- coding: utf-8 -*-
import base64, io, json, os, urllib.request
from PIL import Image
OUT = r'H:\这个是新工作区\night_work\visual-r189\local-vision-after.jsonl'
SHOT = r'H:\这个是新工作区\night_work\visual-r189'
def b64(im, maxw=1024):
    if im.width > maxw: im = im.resize((maxw,int(im.height*maxw/im.width)), Image.LANCZOS)
    buf=io.BytesIO(); im.convert('RGB').save(buf,'JPEG',quality=90); return base64.b64encode(buf.getvalue()).decode()
def ask(tag, imgs, prompt):
    body=json.dumps({'model':'qwen3.5:9b','stream':False,'think':False,'options':{'temperature':0.1,'num_predict':1200},
        'messages':[{'role':'user','content':prompt,'images':imgs}]}).encode()
    req=urllib.request.Request('http://127.0.0.1:11434/api/chat',data=body,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=300) as r: ans=json.loads(r.read()).get('message',{}).get('content','')
    except Exception as e: ans='ERROR %r'%e
    open(OUT,'a',encoding='utf-8').write(json.dumps({'tag':tag,'answer':ans},ensure_ascii=False)+'\n'); print(tag,len(ans))

# 1) hero figure full (from after 780 shot, figure y529..1633)
im=Image.open(os.path.join(SHOT,'landing-780-after.png'))
fig=im.crop((22,529,758,1633))
ask('hero-figure',[b64(fig,760)],
 '这是网页首屏的立绘卡片。逐条回答：1) 白上衣与白背景交界处有没有深色线条勾轮廓？'
 '2) 腰部有没有圆形太极/阴阳鱼牌子？3) 颈部有没有细链月牙吊坠？4) 马尾根有没有葫芦饰物？'
 '5) 卡片右下角有没有一行小字「图像由 AI 生成」？清晰可读吗？6) 有无崩坏？')
# 2) og after
ask('og-after',[b64(Image.open(os.path.join(SHOT,'og-after.png')),1200)],
 '这是1200x630分享卡。逐条：1) 左文右图是否重叠？2) 人物头到脚完整吗？'
 '3) 右下角有没有小字「图像由 AI 生成」？4) 浅色纸感还是深色霓虹？5) 文字有无被裁切？')
# 3) support button after
sp=Image.open(os.path.join(SHOT,'support-780-after.png')).crop((0,500,780,1750))
ask('support-button-after',[b64(sp,780)],
 '这是打赏页中部。逐条：1) 提交按钮现在是平色还是渐变？什么颜色？白字清晰吗？'
 '2) 有没有文字溢出/重叠？3) 整体浅色纸感吗？')
print('DONE')