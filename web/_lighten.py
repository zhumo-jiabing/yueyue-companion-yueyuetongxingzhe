# -*- coding: utf-8 -*-
"""第115轮：把推广页从深色改成浅色纸感（老板 m00998）。
只改颜色与图标相关 meta，不改任何文案；每处替换都断言命中次数。
用法：python _lighten.py
"""
import io
import os

ROOT = os.path.dirname(os.path.abspath(__file__))

OLD_ROOT = """:root{
  --bg:#0b0916; --bg2:#12101f; --line:rgba(169,157,214,.18);
  --ink:#ece8f7; --ink2:#a79ec4; --pink:#d9779f; --gold:#e3b25c; --violet:#8a5aad;
}"""

NEW_ROOT = """:root{
  /* 第115轮：深色改浅色纸感（老板 m00998——深色像"普遍的 AI 网页/诈骗网页"，要让人放心） */
  --bg:#FAF8F4; --bg2:#FFFFFF; --line:rgba(38,34,28,.13);
  --ink:#23211E; --ink2:#5C5850; --pink:#A8436A; --gold:#8A6A22; --violet:#5C4E86;
}"""

# (old, new, 期望命中次数 or None=至少1, 标签)
COMMON = [
    ('<meta name="theme-color" content="#0b0916">',
     '<meta name="theme-color" content="#FAF8F4">', 1, 'theme-color'),
    ('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
     '<meta name="apple-mobile-web-app-status-bar-style" content="default">', 1, 'status-bar'),
    ('border-top:1px solid rgba(255,255,255,.05)', 'border-top:1px solid var(--line)', None, 'section/footer 分隔线'),
    ('color:#6f6788', 'color:var(--ink2)', None, '弱文字 6f6788'),
    ('color:#4d4767', 'color:#8A8578', None, '最弱文字 4d4767'),
    ('color:#7f7598', 'color:var(--ink)', None, '页脚链接 7f7598'),
    ('rgba(127,117,152,.35)', 'rgba(35,33,30,.28)', None, '页脚链接下划线'),
    ('color:#5b5476', 'color:#8A8578', None, '二维码占位文字'),
    ('background:#0f0c1c', 'background:#FFFFFF', None, '二维码占位底'),
    ('rgba(169,157,214,.35)', 'var(--line)', None, '虚线边框 .35'),
]

LANDING = [
    ('.btn-main{background:linear-gradient(135deg,#c4436f,#8a5aad);color:#fff}',
     '.btn-main{background:linear-gradient(135deg,#A8436A,#5C4E86);color:#fff;box-shadow:0 6px 18px rgba(168,67,106,.22)}',
     1, '主按钮渐变'),
    ('border:1px solid rgba(227,178,92,.35);border-radius:99px;padding:4px 12px;margin-bottom:20px;',
     'border:1px solid rgba(138,106,34,.32);border-radius:99px;padding:4px 12px;margin-bottom:20px;',
     1, '首屏 tag 边框'),
    ('border:1px solid rgba(227,178,92,.3);border-radius:99px;padding:3px 10px;margin-bottom:14px;',
     'border:1px solid rgba(138,106,34,.32);border-radius:99px;padding:3px 10px;margin-bottom:14px;',
     1, '18+ 徽章边框'),
    ('border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px 18px;',
     'border:1px solid var(--line);border-radius:14px;padding:16px 18px;background:var(--bg2);',
     1, '她不是什么 卡片'),
    ('.legal strong{color:#9a91b8;font-weight:600}', '.legal strong{color:var(--ink);font-weight:600}', 1, '合规段加粗'),
    ('.figure{aspect-ratio:2/3;background:#FBFAF8;box-shadow:0 26px 64px rgba(0,0,0,.5),0 0 0 1px rgba(255,255,255,.07)}',
     '.figure{aspect-ratio:2/3;background:#FFFFFF;box-shadow:0 18px 44px rgba(35,33,30,.12),0 0 0 1px rgba(35,33,30,.07)}',
     1, '立绘卡片阴影'),
    ('  background:\n    radial-gradient(120% 80% at 50% 0%,rgba(138,90,173,.35),transparent 60%),\n    linear-gradient(180deg,#1a1630,#0e0b1a);\n',
     '  background:#FFFFFF;\n', 1, '立绘深色渐变底'),
]

SUPPORT = [
    ('a{color:#c9a0e0}', 'a{color:var(--violet)}', 1, '正文链接色'),
    ('.no-list li{list-style:none;padding-left:22px;position:relative;color:#8d84a8;',
     '.no-list li{list-style:none;padding-left:22px;position:relative;color:var(--ink2);',
     1, '不做清单文字'),
    ('color:#7d5b6b;font-weight:700;font-size:12px}', 'color:#9C6A78;font-weight:700;font-size:12px}', 1, '不做清单叉号'),
    ('border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:14px 16px;',
     'border:1px solid var(--line);border-radius:14px;padding:14px 16px;background:var(--bg2);',
     1, '感谢名单卡片'),
    ('.t-stars{border-color:rgba(227,178,92,.32);background:rgba(227,178,92,.05)}',
     '.t-stars{border-color:rgba(138,106,34,.34);background:rgba(138,106,34,.07)}',
     1, '重要赞助人高亮'),
    ('rgba(169,157,214,.3)', 'var(--line)', None, '虚线边框 .3'),
]


def patch(name, extra):
    path = os.path.join(ROOT, name)
    with io.open(path, 'r', encoding='utf-8', newline='') as f:
        s = f.read()
    before = len(s)
    if OLD_ROOT not in s:
        raise SystemExit('[FAIL] %s 找不到原 :root 块' % name)
    s = s.replace(OLD_ROOT, NEW_ROOT, 1)
    for old, new, want, label in COMMON + extra:
        n = s.count(old)
        if n == 0:
            raise SystemExit('[FAIL] %s 未命中：%s' % (name, label))
        if want is not None and n != want:
            raise SystemExit('[FAIL] %s 命中次数不对：%s 期望 %d 实际 %d' % (name, label, want, n))
        s = s.replace(old, new)
        print('  [ok] %-16s ×%d' % (label, n))
    # 深色残留自检
    for bad in ('#0b0916', '#12101f', '#ece8f7', 'rgba(255,255,255,.0'):
        if bad in s:
            raise SystemExit('[FAIL] %s 仍有深色残留：%s' % (name, bad))
    with io.open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(s)
    import hashlib
    b = s.encode('utf-8')
    print('[OK] %s %d → %d 字节  sha16 %s' % (name, before, len(b),
          hashlib.sha256(b).hexdigest()[:16].upper()))


if __name__ == '__main__':
    print('== landing.html ==')
    patch('landing.html', LANDING)
    print('== support.html ==')
    patch('support.html', SUPPORT)
    print('全部通过')
