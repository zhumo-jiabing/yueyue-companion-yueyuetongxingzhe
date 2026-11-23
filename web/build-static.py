# -*- coding: utf-8 -*-
"""
第115轮：把「展台」网页打成一个可直接上传的静态包（web/dist-static/）。

为什么要有这一步：
  web/ 里的 landing.html / support.html 是给本机 proxy.cjs 用的——里面全是绝对路径
  （/web/…、/policy.html）、按钮指向 /m（手机体验版，依赖本机代理 + API 钥匙）。
  原样传到任何静态托管上，图片 404、按钮点空、体验版必挂。
  这个脚本生成一份「相对路径 + 无 /m + 无 Service Worker」的自洽副本，原文件不动。

用法：
  K:/yueyueneiceban/win-unpacked/.../runtime/python.exe web/build-static.py
输出：
  web/dist-static/          ← 整个目录拖到 Vercel / Netlify / GitHub Pages / 任意静态服务器即可
"""
import os, re, shutil, hashlib, sys, io

WEB = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(WEB)
APP = os.path.join(ROOT, 'win-unpacked', 'resources', 'app')
DIST = os.path.join(WEB, 'dist-static')
ASSETS = os.path.join(DIST, 'assets')

# 定稿形象（老板 2026-10-28 指定：换成 v23 的 F1）
HERO_SRC = os.path.join(ROOT, '_r112-art', 'v23-recv-2026-10-28', 'F1-白外套藏青裙-20261028.png')


def read(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()


def write(p, s):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(s)


def sub1(s, old, new, label):
    """断言式替换：必须且只能命中一次，否则直接报错（防止改了没生效、或改错地方）。"""
    n = s.count(old)
    if n != 1:
        raise SystemExit('[FAIL] %s：期望命中 1 次，实际 %d 次 —— 文件已经变过，先人工核对' % (label, n))
    return s.replace(old, new)


def sha(p):
    return hashlib.sha256(open(p, 'rb').read()).hexdigest()[:16].upper()


def build_landing():
    s = read(os.path.join(WEB, 'landing.html'))

    # ---- 1. 资源与页面：绝对路径 → 相对路径 ----
    s = sub1(s, 'href="/web/manifest.webmanifest"', 'href="assets/manifest.webmanifest"', 'landing manifest')
    _n = s.count('href="/web/icon-192.png"')
    assert _n == 2, f'icon 引用应为 2 次，实际 {_n}'
    s = s.replace('href="/web/icon-192.png"', 'href="assets/icon-192.png"')

    # ---- 2. 首屏两个按钮：公网没有 /m，只能加群 ----
    s = sub1(s,
             '<a class="btn btn-main" href="#join">加群，看她还在做什么 →</a>\n'
             '        <a class="btn btn-ghost" href="#nots">她不是什么</a>',
             '<a class="btn btn-main" href="#join">加群，看她还在做什么 →</a>\n'
             '        <a class="btn btn-ghost" href="#nots">她不是什么</a>',
             'landing hero CTA')
    s = sub1(s,
             '<p class="hint">这一页在手机和电脑上都能打开。她现在还在内测，进度都写在群里。</p>',
             '<p class="hint">这一页在手机和电脑上都能打开。她现在还在内测，进度都写在群里。</p>',
             'landing hint')

    # ---- 3. 立绘：换成定稿形象 F1 ----
    s = sub1(s,
             '<img src="/web/yueyue_avatar.webp" alt="玥玥" onerror="this.src=\'/yueyue_avatar.png\'">',
             '<img src="assets/yueyue.webp" alt="玥玥">',
             'landing 立绘 img')

    # ---- 4. 「她不是什么」加锚点，给首屏第二个按钮用 ----
    s = sub1(s,
             '<section>\n    <h2><span class="kicker">她不是什么</span>',
             '<section id="nots">\n    <h2><span class="kicker">她不是什么</span>',
             'landing nots 锚点')

    # ---- 5. 入群区：把「局域网展台」这种公网上没人看得懂的话改掉 ----
    s = sub1(s,
             '<h2><span class="kicker">想继续</span>加群，或者自己装一个</h2>',
             '<h2><span class="kicker">想继续</span>进群，看她的进度</h2>',
             'landing join 标题')
    s = sub1(s,
             '<li>电脑版是完整体：会动的立绘、语音、长期记忆、沙盒日常都在里面。</li>',
             '<li>她在电脑桌面上：会动、能说话、记得你说过的事。</li>',
             'landing join 第一条')
    s = sub1(s,
             '<li>手机版目前只在展台局域网里开放体验，暂时不对外发布。</li>',
             '<li>现在还是内测，功能和形象都在改，群里能看到每次改动。</li>',
             'landing join 第三条')

    # ---- 6. 页面内链接全部改成相对路径 ----
    s = sub1(s, '<a href="/web/support.html">可以打赏</a>', '<a href="support.html">可以打赏</a>', 'landing 打赏链接')
    s = sub1(s, '写在<a href="/policy.html">隐私政策</a>第四节', '写在<a href="policy.html">隐私政策</a>第四节', 'landing 政策链接')
    # r156: footer 加了「为什么做她 / 如果你现在很难」两个锚点，这里只做 href 归一，不整段比对
    s = sub1(s,
             '<a href="#why">为什么做她</a> · <a href="#join">加群</a> · <a href="#help">如果你现在很难</a> · <a href="support.html">打赏与感谢名单</a>',
             '<a href="#why">为什么做她</a> · <a href="#join">加群</a> · <a href="#help">如果你现在很难</a> · <a href="support.html">打赏与感谢名单</a>',
             'landing footer 链接')

    # ---- 7. 群码探测：改成相对路径 ----
    s = s.replace("'/web/qr-group.png'", "'assets/qr-group.png'")
    if 'assets/qr-group.png' not in s:
        raise SystemExit('[FAIL] 群码探测路径没替换成功')

    # ---- 8. 去掉 Service Worker（静态托管在子路径下 scope 会错，且会缓存旧页面）----
    s = re.sub(r"<script>\s*/\* 第108轮：注册 service worker.*?</script>\s*", "", s, flags=re.S)
    if 'serviceWorker' in s and 'register' in s:
        raise SystemExit('[FAIL] Service Worker 注册没删干净')

    # ---- 9. 立绘的米白照片卡样式已写进 web/landing.html 本体，这里不再重复注入 ----
    if '.figure{aspect-ratio:2/3' not in s:
        raise SystemExit('[FAIL] web/landing.html 里缺少米白照片卡样式')

    write(os.path.join(DIST, 'index.html'), s)


def build_support():
    s = read(os.path.join(WEB, 'support.html'))
    s = sub1(s, 'href="/web/manifest.webmanifest"', 'href="assets/manifest.webmanifest"', 'support manifest')
    _n = s.count('href="/web/icon-192.png"')
    assert _n == 2, f'icon 引用应为 2 次，实际 {_n}'
    s = s.replace('href="/web/icon-192.png"', 'href="assets/icon-192.png"')
    s = sub1(s,
             '<a class="back" href="/">← 回首页</a>',
             '<a class="back" href="index.html">← 回首页</a>',
             'support 顶部返回')
    s = sub1(s,
             '<a href="/">首页</a> · <a href="/policy.html">隐私政策与用户协议</a>',
             '<a href="index.html">首页</a> · <a href="policy.html">隐私政策与用户协议</a>',
             'support footer')
    s = sub1(s,
             "fetch('/web/thanks.json', { cache: 'no-store' })",
             "fetch('assets/thanks.json', { cache: 'no-store' })",
             'support 感谢名单 fetch')
    s = s.replace("'/web/qr-", "'assets/qr-")
    s = re.sub(r"<script>\s*/\* 第108轮：注册 service worker.*?</script>\s*", "", s, flags=re.S)
    if "'/web/" in s or 'href="/' in s:
        raise SystemExit('[FAIL] support.html 还有绝对路径')
    write(os.path.join(DIST, 'support.html'), s)


def build_assets():
    from PIL import Image
    os.makedirs(ASSETS, exist_ok=True)

    # 立绘：F1 → webp（2:3，1024×1536 原尺寸，不放大）
    im = Image.open(HERO_SRC).convert('RGB')
    if im.size != (1024, 1536):
        raise SystemExit('[FAIL] F1 尺寸变了：%s' % (im.size,))
    im.save(os.path.join(ASSETS, 'yueyue.webp'), 'WEBP', quality=90, method=6)

    for src, dst in [('qr-group.png', 'qr-group.png'),
                     ('qr-pay-alipay.png', 'qr-pay-alipay.png'),
                     ('qr-pay-wechat.png', 'qr-pay-wechat.png'),
                     ('icon-192.png', 'icon-192.png'),
                     ('icon-512.png', 'icon-512.png'),
                     ('og-1200x630.png', 'og-1200x630.png'),  # 第119轮：og:image 分享卡（web/make_og.py 生成）
                     ('thanks.json', 'thanks.json')]:
        shutil.copy2(os.path.join(WEB, src), os.path.join(ASSETS, dst))
        os.chmod(os.path.join(ASSETS, dst), 0o666)  # 源文件是只读的，不改属性下次 rmtree 会拒绝访问

    # r184c：Netlify _headers——软件内心意墙要跨域读 assets/thanks.json（CORS + 不缓存）
    write(os.path.join(DIST, '_headers'),
          "/assets/thanks.json\n  Access-Control-Allow-Origin: *\n  Cache-Control: no-cache\n")

    # favicon.ico：policy.html 没有 <link rel="icon">，浏览器会自己去请求它；
    # 放一个在根目录，静态包里就不再出现 /favicon.ico 404。
    _ic = Image.open(os.path.join(ASSETS, 'icon-192.png')).convert('RGBA')
    _ic.save(os.path.join(DIST, 'favicon.ico'), sizes=[(16,16),(32,32),(48,48)])

    # policy.html 要读 config.js 才填得上 CONTACT，一起带走。
    # 2026-11-23：站点其它页都是纸色，政策页默认是应用里的深色 —— 只在生成的副本上
    # 给 body 加 day 类（源文件是受保护的 app/policy.html，不动它）。
    _pol = io.open(os.path.join(APP, 'policy.html'), encoding='utf-8').read()
    if '<body>' in _pol:
        _pol = _pol.replace('<body>', '<body class="day">', 1)
    # 政策页自己的脚本会按 localStorage 重新决定昼夜，站点访客没有这个键 → 固定日间
    _dm = ('function dayModeOn() { try { return localStorage.getItem("yueyue_day_mode") === "1"; }'
           ' catch (e) { return false; } }')
    if _dm in _pol:
        _pol = _pol.replace(_dm, 'function dayModeOn() { return true; } /* 站点版固定日间 */', 1)
    else:
        print('  [warn] policy 的 dayModeOn 没匹配上，政策页可能仍是深色')
    io.open(os.path.join(DIST, 'policy.html'), 'w', encoding='utf-8').write(_pol)
    shutil.copy2(os.path.join(APP, 'config.js'), os.path.join(DIST, 'config.js'))

    manifest = """{
  "name": "玥玥 · 心灵同行者",
  "short_name": "玥玥",
  "description": "AI 心灵同行者——她不是真人，也永远不会假装是真人。",
  "lang": "zh-CN",
  "start_url": "./index.html",
  "scope": "./",
  "display": "standalone",
  "background_color": "#FAF8F4",
  "theme_color": "#FAF8F4",
  "icons": [
    { "src": "icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ]
}
"""
    write(os.path.join(ASSETS, 'manifest.webmanifest'), manifest)
    write(os.path.join(DIST, 'robots.txt'), "User-agent: *\nAllow: /\n")

    # 打赏页里还有一张老路径 qr-pay.png（兼容用），不存在就让探测静默失败
    return


def verify():
    """构建后自检：相对路径齐全、没有残留绝对路径、文件都在。"""
    problems = []
    for name in ('index.html', 'support.html', 'policy.html', 'config.js', 'robots.txt', '_headers'):
        p = os.path.join(DIST, name)
        if not os.path.exists(p):
            problems.append('缺文件 %s' % name)
    if 'Access-Control-Allow-Origin' not in read(os.path.join(DIST, '_headers')):
        problems.append('_headers 缺 CORS 条目')
    for name in ('index.html', 'support.html'):
        s = read(os.path.join(DIST, name))
        for pat in ('href="/', "src='/", 'src="/', "'/web/", '"/web/', 'href="/m"'):
            if pat in s:
                problems.append('%s 残留绝对路径 %s' % (name, pat))
        # 引用的本地资源必须真的存在
        for m in re.finditer(r'(?:src|href)="(assets/[^"]+)"', s):
            if not os.path.exists(os.path.join(DIST, m.group(1))):
                problems.append('%s 引用了不存在的 %s' % (name, m.group(1)))
    if problems:
        raise SystemExit('[FAIL] 自检不通过：\n  ' + '\n  '.join(problems))
    print('[OK] 自检通过：无绝对路径、引用资源齐全')


if __name__ == '__main__':
    if os.path.isdir(DIST):
        def _on_rm_error(func, path, exc):
            os.chmod(path, 0o666)
            func(path)
        shutil.rmtree(DIST, onerror=_on_rm_error)
    os.makedirs(DIST)
    build_assets()
    build_landing()
    build_support()
    verify()
    print('\n=== web/dist-static/ ===')
    total = 0
    for dirpath, _, files in os.walk(DIST):
        for f in sorted(files):
            p = os.path.join(dirpath, f)
            sz = os.path.getsize(p)
            total += sz
            rel = os.path.relpath(p, DIST).replace('\\', '/')
            print('%-32s %8d B  %s' % (rel, sz, sha(p)))
    print('合计 %d 个文件 / %.2f MB' % (sum(len(f) for _, _, f in os.walk(DIST)), total / 1048576))
