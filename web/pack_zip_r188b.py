# 打赏闭环打包（r184c）——Netlify 拖拽件
# 产物：dist-static-上传用-20261123f.zip（含 _headers / thanks.json v2 / 心意墙 / 留称呼表单）
import os, zipfile, hashlib
DIST = r'K:\yueyueneiceban\web\dist-static'
OUT  = r'K:\yueyueneiceban\web\dist-static-上传用-20261123f.zip'
if os.path.exists(OUT):
    os.remove(OUT)
n = 0
with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, _, files in os.walk(DIST):
        for f in sorted(files):
            p = os.path.join(root, f)
            arc = os.path.relpath(p, DIST).replace(os.sep, '/')
            z.write(p, arc)
            n += 1
            print(f'  {arc}')
sz = os.path.getsize(OUT)
h = hashlib.sha256(open(OUT, 'rb').read()).hexdigest()[:16].upper()
print(f'\n{OUT}\n{n} files / {sz:,} B / sha16 {h}')
