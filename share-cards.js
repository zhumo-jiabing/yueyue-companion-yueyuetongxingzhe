// [r221 P8] 分享键：三类暖纸分享卡（成就 / 关系天气 / 世界风景）+ DIY + 图片剪贴板。
// 宪法硬线：暖纸 #FAF8F4 / 暖墨 #23211E / 单一克制主色 #A9713B，禁深色霓虹（图07/§十六）。
// 隐私硬线：卡面只画 成就定义固定文案 / 天气意象与数字 / 世界书 canon 风景与 beats 标题 / 物件名。
//           绝不读对话原文、记忆原文、Key、联系方式、风险等级、依赖度分数。
// 分享全本地生成：用户点按钮才出卡，复制/下载后自己手动发；不自动上传、不自动发群、不做同频池。
// 文案闸：禁「会好的 / 最懂你 / 治愈 / AI女友 / AI男友 / 虚拟恋人」。
// 每张卡角落小字「图像由 AI 生成」（绝不把 AI 图说成手绘）；署名「竹墨 · 平台搜竹箓」可选。
(function () {
    'use strict';

    var PAPER = '#FAF8F4', INK = '#23211E', SUB = '#6b6459', FAINT = '#8a8276',
        LINE = '#e3ddd2', ACCENT = '#A9713B', TRACK = '#efe9df', BAR2 = '#90a4ae';
    var BANNED = /会好的|最懂你|治愈|AI女友|AI男友|虚拟恋人/;
    var DIY_KEY = 'yueyue_share_diy';
    var AI_MARK = '图像由 AI 生成';
    var SIGN_TEXT = '竹墨 · 平台搜「竹箓」';

    var cur = { type: 'ach', achId: null, card: null, busy: false, diy: null };

    // ---------- DIY 偏好（本机 localStorage，勾选状态跨次记住） ----------
    function defaultDiy() { return { hideTime: false, hideDays: false, hideNums: false, hideObjects: false, signature: true }; }
    function loadDiy() {
        var d = defaultDiy();
        try {
            var s = JSON.parse(localStorage.getItem(DIY_KEY) || '{}');
            for (var k in d) if (typeof s[k] === 'boolean') d[k] = s[k];
        } catch (e) { /* 忽略 */ }
        return d;
    }
    function saveDiy() { try { localStorage.setItem(DIY_KEY, JSON.stringify(cur.diy)); } catch (e) { /* 忽略 */ } }

    var DIY_DEFS = {
        ach: [
            { k: 'hideTime', label: '藏起解锁时间' },
            { k: 'hideDays', label: '藏起相识天数' },
            { k: 'signature', label: '加上署名（竹墨 · 平台搜竹箓）', on: true },
        ],
        weather: [
            { k: 'hideNums', label: '藏起全部数字（只留天气意象）' },
            { k: 'signature', label: '加上署名（竹墨 · 平台搜竹箓）', on: true },
        ],
        world: [
            { k: 'hideNums', label: '藏起进度数字' },
            { k: 'hideObjects', label: '藏起物件清单' },
            { k: 'signature', label: '加上署名（竹墨 · 平台搜竹箓）', on: true },
        ],
    };

    // ---------- canvas 公共件 ----------
    function newCanvas() {
        var canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 960;
        var ctx = canvas.getContext('2d');
        var texts = [];
        var rawFill = ctx.fillText.bind(ctx);
        ctx.fillText = function (t, x, y, mw) { texts.push(String(t)); return mw === undefined ? rawFill(t, x, y) : rawFill(t, x, y, mw); };
        ctx.fillStyle = PAPER; ctx.fillRect(0, 0, 640, 960);
        ctx.strokeStyle = LINE; ctx.lineWidth = 2; ctx.strokeRect(22, 22, 596, 876);
        ctx.strokeStyle = 'rgba(169,113,59,0.35)'; ctx.lineWidth = 1; ctx.strokeRect(30, 30, 580, 860);
        ctx.textAlign = 'center';
        return { canvas: canvas, ctx: ctx, texts: texts };
    }
    // 避头尾：收尾标点不许落新行首（否则孤零零一个「。」独占一行），容许一字宽溢出
    var NO_LINE_START = '。，、；：？！）」』”’…·';
    function wrapText(ctx, text, cx, y, maxW, lineH) {
        var line = '';
        for (var i = 0; i < text.length; i++) {
            var ch = text[i];
            if (ctx.measureText(line + ch).width > maxW && line && NO_LINE_START.indexOf(ch) < 0) {
                ctx.fillText(line, cx, y); y += lineH; line = ch;
            } else line += ch;
        }
        if (line) ctx.fillText(line, cx, y);
        return y;
    }
    function header(ctx, juan, sub) {
        ctx.fillStyle = FAINT; ctx.font = '20px "Microsoft YaHei"';
        ctx.fillText(juan, 320, 92);
        ctx.fillStyle = ACCENT; ctx.font = 'bold 26px "Microsoft YaHei"';
        ctx.fillText(sub, 320, 134);
        ctx.fillStyle = INK; ctx.font = 'bold 30px "Microsoft YaHei"';
        ctx.fillText('玥玥 · 心灵同行者', 320, 176);
    }
    function footer(c, opts, brandLine) {
        var ctx = c.ctx;
        ctx.fillStyle = ACCENT; ctx.font = 'bold 22px "Microsoft YaHei"'; ctx.textAlign = 'center';
        ctx.fillText(brandLine || '—— 玥玥 · 心灵同行者', 320, 924);
        ctx.font = '14px "Microsoft YaHei"'; ctx.fillStyle = FAINT;
        ctx.textAlign = 'left'; ctx.fillText(AI_MARK, 40, 948);
        if (opts.signature) { ctx.textAlign = 'right'; ctx.fillText(SIGN_TEXT, 600, 948); }
    }
    function bar(ctx, label, v, y, color, showPct) {
        ctx.textAlign = 'left'; ctx.fillStyle = INK; ctx.font = '22px "Microsoft YaHei"';
        ctx.fillText(label, 110, y + 11);
        ctx.fillStyle = TRACK; ctx.fillRect(210, y, 300, 14);
        ctx.strokeStyle = LINE; ctx.lineWidth = 1; ctx.strokeRect(210, y, 300, 14);
        ctx.fillStyle = color; ctx.fillRect(210, y, Math.max(0, Math.min(1, v)) * 300, 14);
        if (showPct) {
            ctx.textAlign = 'right'; ctx.fillStyle = SUB; ctx.font = '20px "Microsoft YaHei"';
            ctx.fillText(Math.round(v * 100) + '%', 560, y + 11);
        }
        ctx.textAlign = 'center';
    }

    // ---------- [r222 美观] 视觉锚：F1 头像圆章 / 手绘天气意象 / 圆角进度条 / 暖光 / 分隔饰线 / 世界线稿 ----------
    var _avatarImg = null, _avatarTried = false;
    function loadAvatar() {
        if (_avatarTried) return Promise.resolve(_avatarImg);
        _avatarTried = true;
        return new Promise(function (res) {
            var im = new Image();
            im.onload = function () { _avatarImg = im; res(im); };
            im.onerror = function () { res(null); };
            im.src = 'yueyue_avatar.png';
        });
    }
    function drawAvatar(ctx, cx, cy, r) {
        if (!_avatarImg) return;
        ctx.save();
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        var iw = _avatarImg.width, ih = _avatarImg.height, s = Math.max(2 * r / iw, 2 * r / ih);
        var dw = iw * s, dh = ih * s;
        ctx.drawImage(_avatarImg, cx - dw / 2, cy - dh / 2, dw, dh);
        ctx.restore();
        ctx.strokeStyle = 'rgba(169,113,59,0.55)'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = LINE; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(cx, cy, r + 8, 0, Math.PI * 2); ctx.stroke();
    }
    // [r225] 关系天气卡用一张 Q 版小立绘做「她在场」的锚，不再只有头像圆章。
    // 透明底 PNG，放在 app 根目录；加载失败就不画，不挡出卡。
    var _qImg = null, _qTried = false;
    function loadQ() {
        if (_qTried) return Promise.resolve(_qImg);
        _qTried = true;
        return new Promise(function (res) {
            var im = new Image();
            im.onload = function () { _qImg = im; res(im); };
            im.onerror = function () { res(null); };
            im.src = 'yueyue_q_idle.png';
        });
    }
    function drawQ(ctx, x, y, h) {
        if (!_qImg) return;
        var s = h / _qImg.height, w = _qImg.width * s;
        ctx.drawImage(_qImg, x, y, w, h);
    }
    function glow(ctx, cx, cy, r, color) {
        var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, color); g.addColorStop(1, 'rgba(250,248,244,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    function cloud(ctx, cx, cy, s, fill) {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(cx - s * 0.42, cy, s * 0.34, 0, Math.PI * 2);
        ctx.arc(cx, cy - s * 0.22, s * 0.44, 0, Math.PI * 2);
        ctx.arc(cx + s * 0.44, cy, s * 0.32, 0, Math.PI * 2);
        ctx.rect(cx - s * 0.42, cy - s * 0.05, s * 0.86, s * 0.38);
        ctx.fill();
    }
    function drawWeatherIcon(ctx, label, cx, cy, s) {
        glow(ctx, cx, cy, s * 1.5, 'rgba(233,180,76,0.14)');
        var sun = '#E9B44C';
        if (label === '晴') {
            ctx.strokeStyle = sun; ctx.lineWidth = 4;
            for (var i = 0; i < 8; i++) {
                var a = i * Math.PI / 4;
                ctx.beginPath();
                ctx.moveTo(cx + Math.cos(a) * s * 0.62, cy + Math.sin(a) * s * 0.62);
                ctx.lineTo(cx + Math.cos(a) * s * 0.85, cy + Math.sin(a) * s * 0.85);
                ctx.stroke();
            }
            ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(cx, cy, s * 0.45, 0, Math.PI * 2); ctx.fill();
        } else if (label === '多云') {
            ctx.fillStyle = sun; ctx.beginPath(); ctx.arc(cx - s * 0.28, cy - s * 0.3, s * 0.36, 0, Math.PI * 2); ctx.fill();
            cloud(ctx, cx + s * 0.1, cy + s * 0.12, s * 0.95, '#D8DEE6');
        } else if (label === '小雨') {
            cloud(ctx, cx, cy - s * 0.15, s * 0.95, '#C3CCD6');
            ctx.strokeStyle = BAR2; ctx.lineWidth = 4; ctx.lineCap = 'round';
            for (var j = -1; j <= 1; j++) {
                ctx.beginPath();
                ctx.moveTo(cx + j * s * 0.34, cy + s * 0.34);
                ctx.lineTo(cx + j * s * 0.34 - s * 0.08, cy + s * 0.6);
                ctx.stroke();
            }
        } else { // 阴
            cloud(ctx, cx - s * 0.15, cy - s * 0.1, s * 0.8, '#C3CCD6');
            cloud(ctx, cx + s * 0.15, cy + s * 0.12, s * 0.95, '#D8DEE6');
        }
    }
    function divider(ctx, y) {
        ctx.strokeStyle = LINE; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(120, y); ctx.lineTo(296, y); ctx.moveTo(344, y); ctx.lineTo(520, y); ctx.stroke();
        ctx.fillStyle = ACCENT;
        ctx.save(); ctx.translate(320, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-4, -4, 8, 8); ctx.restore();
    }
    function roundBar(ctx, label, v, y, color, showPct) {
        var x = 210, w = 300, h = 16, r = 8;
        ctx.textAlign = 'left'; ctx.fillStyle = INK; ctx.font = '22px "Microsoft YaHei"';
        ctx.fillText(label, 110, y + 12);
        function rr(xx, yy, ww, hh) {
            ctx.beginPath();
            ctx.moveTo(xx + r, yy); ctx.arcTo(xx + ww, yy, xx + ww, yy + hh, r);
            ctx.arcTo(xx + ww, yy + hh, xx, yy + hh, r); ctx.arcTo(xx, yy + hh, xx, yy, r);
            ctx.arcTo(xx, yy, xx + ww, yy, r); ctx.closePath();
        }
        ctx.fillStyle = TRACK; rr(x, y, w, h); ctx.fill();
        var fw = Math.max(0, Math.min(1, v)) * w;
        if (fw > 2) { ctx.fillStyle = color; rr(x, y, Math.max(fw, h), h); ctx.fill(); }
        if (showPct) {
            ctx.textAlign = 'right'; ctx.fillStyle = SUB; ctx.font = '20px "Microsoft YaHei"';
            ctx.fillText(Math.round(v * 100) + '%', 560, y + 12);
        }
        ctx.textAlign = 'center';
    }
    // [r225] 关系天气不再用两条 KPI 进度条；改成两个软环，环心一颗小点，
    // 更像「两份心事」而不是报表。数字只做小注，不抢主视觉。
    function drawSoftRing(ctx, cx, cy, r, v, color, label, pct) {
        var p = Math.max(0, Math.min(1, Number(v) || 0));
        ctx.save();
        ctx.lineCap = 'round';
        ctx.strokeStyle = TRACK; ctx.lineWidth = 9;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = color; ctx.lineWidth = 9;
        ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); ctx.stroke();
        ctx.fillStyle = color; ctx.globalAlpha = 0.9;
        ctx.beginPath(); ctx.arc(cx, cy, 4.5, 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
        ctx.restore();
        ctx.fillStyle = INK; ctx.font = '22px "Microsoft YaHei"'; ctx.textAlign = 'center';
        ctx.fillText(label, cx, cy + r + 30);
        ctx.fillStyle = SUB; ctx.font = '19px "Microsoft YaHei"';
        ctx.fillText(String(pct) + '%', cx, cy + r + 54);
    }
    function drawWorldScene(ctx, cx, cy) {
        // 线稿：悬浮小房子 + 虚空海波浪（梦界 canon 意象，暖墨细线）
        ctx.save();
        ctx.strokeStyle = 'rgba(35,33,30,0.55)'; ctx.lineWidth = 2; ctx.lineCap = 'round';
        var hx = cx, hy = cy - 26;
        ctx.strokeRect(hx - 34, hy - 18, 68, 40);           // 房身
        ctx.beginPath(); ctx.moveTo(hx - 42, hy - 18); ctx.lineTo(hx, hy - 44); ctx.lineTo(hx + 42, hy - 18); ctx.stroke(); // 屋顶
        ctx.strokeRect(hx - 8, hy - 2, 16, 24);            // 门
        ctx.fillStyle = 'rgba(233,180,76,0.8)'; ctx.fillRect(hx + 14, hy - 8, 12, 12); // 窗（暖光）
        ctx.strokeStyle = 'rgba(144,164,174,0.8)'; ctx.lineWidth = 2;
        for (var row = 0; row < 3; row++) {
            var yy = cy + 34 + row * 16, amp = 5, span = 150 - row * 26;
            ctx.beginPath();
            for (var x = -span; x <= span; x += 4) {
                var y2 = yy + Math.sin((x + row * 13) / 16) * amp;
                if (x === -span) ctx.moveTo(cx + x, y2); else ctx.lineTo(cx + x, y2);
            }
            ctx.stroke();
        }
        ctx.restore();
    }

    // ---------- 卡一：成就（委托 achievements.js 的暖纸 buildShareCard） ----------
    function buildAch(id, opts) {
        if (window.Achievements && Achievements.buildShareCard) return Achievements.buildShareCard(id, opts);
        return Promise.resolve(null);
    }

    // ---------- 卡二：关系天气（Jiaoxin.compute：天气意象 + 交心值 + 双向了解度） ----------
    // 去敏：compute 只回传天气/计数/比例，不回传任何记忆或对话原文。
    async function buildWeather(opts) {
        opts = opts || {};
        if (!window.Jiaoxin || !Jiaoxin.compute) return null;
        var d = await Jiaoxin.compute();
        await Promise.all([loadAvatar(), loadQ()]);
        var c = newCanvas(), ctx = c.ctx;
        // [r225] 关系天气从「数据卡」改成「一张天气笺」：
        // 主视觉是天气 + 一句关系话 + 两个软环 + Q版小立绘；
        // 交心值退成小注，不再用两条 KPI 进度条抢视线。
        var wash = ctx.createLinearGradient(0, 30, 0, 930);
        wash.addColorStop(0, 'rgba(255,248,244,0.72)');
        wash.addColorStop(0.55, 'rgba(252,243,238,0.34)');
        wash.addColorStop(1, 'rgba(255,248,244,0.72)');
        ctx.fillStyle = wash; ctx.fillRect(31, 31, 578, 858);
        var today = new Date();
        var dateStr = today.getFullYear() + '.' + String(today.getMonth() + 1).padStart(2, '0') + '.' + String(today.getDate()).padStart(2, '0');
        ctx.textAlign = 'center';
        ctx.fillStyle = FAINT; ctx.font = '17px KaiTi, "Microsoft YaHei"';
        ctx.fillText('梦 界 志 · 天 气 笺', 320, 76);
        ctx.fillStyle = 'rgba(138,130,118,0.85)'; ctx.font = '14px "Microsoft YaHei"';
        ctx.fillText(dateStr, 320, 100);
        // [r225b] 不再用头像圆章 + 两个 KPI 软环；改成一张有她在场的天气笺。
        // 关系天气是主标题，Q版是主视觉，双向了解写成两句人话，百分比只做小注。
        ctx.fillStyle = ACCENT; ctx.font = '18px KaiTi, "Microsoft YaHei"';
        ctx.fillText('关 系 天 气', 320, 132);
        drawWeatherIcon(ctx, d.weather.label, 320, 238, 76);
        ctx.fillStyle = INK; ctx.font = 'bold 48px KaiTi, "Microsoft YaHei"';
        ctx.fillText(d.weather.label, 320, 336);
        var kao = d.weather.label === '晴' ? '(￣▽￣)／'
            : d.weather.label === '多云' ? '(´｡• ᵕ •｡`)'
            : d.weather.label === '小雨' ? '(｡•́︿•̀｡)' : '(´･ω･`)';
        ctx.fillStyle = '#3a362f'; ctx.font = '26px KaiTi, "Microsoft YaHei"';
        var capBottom = wrapText(ctx, d.weather.caption, 320, 380, 500, 36);
        ctx.fillStyle = '#B25B72'; ctx.font = '23px "Microsoft YaHei"';
        ctx.fillText(kao, 320, capBottom + 30);
        divider(ctx, 410);
        var herPct = Math.round(d.herKnows * 100), youPct = Math.round(d.youKnow * 100);
        var herLine = d.herKnows >= 0.6 ? '开始记得你说过的话' : d.herKnows >= 0.3 ? '在慢慢记住你' : '还在学着听你';
        var youLine = d.youKnow >= 0.6 ? '开始听懂她的停顿' : d.youKnow >= 0.3 ? '在慢慢听她说' : '还没顾上问她';
        // [r226] 关系天气从「数据卡」再退一步：一页天气笺，像她写给你的短信。
        // 不摆百分比；只留两句人话、一个交心小印、一张她站在纸上的 Q 版。
        ctx.textAlign = 'left';
        ctx.fillStyle = FAINT; ctx.font = '18px KaiTi, "Microsoft YaHei"';
        ctx.fillText('她这边，今天', 64, 452);
        ctx.fillStyle = INK; ctx.font = '22px KaiTi, "Microsoft YaHei"';
        ctx.fillText('风从窗边过，', 64, 492);
        ctx.fillText('带着一点潮气。', 64, 526);
        ctx.fillStyle = SUB; ctx.font = '20px KaiTi, "Microsoft YaHei"';
        ctx.fillText('你说的那些，', 64, 570);
        ctx.fillText('她都记在窗边了。', 64, 600);
        ctx.fillStyle = FAINT; ctx.font = '19px KaiTi, "Microsoft YaHei"';
        ctx.fillText('不急着懂完，慢慢来。', 64, 646);
        // 交心小印：不抢视线，只在纸角盖一下。
        ctx.save();
        ctx.translate(86, 706); ctx.rotate(-0.055);
        ctx.strokeStyle = 'rgba(178,91,114,0.38)'; ctx.lineWidth = 1.2;
        ctx.strokeRect(-40, -22, 80, 40);
        ctx.fillStyle = 'rgba(178,91,114,0.78)'; ctx.font = '16px KaiTi, "Microsoft YaHei"';
        ctx.textAlign = 'center';
        ctx.fillText('交心 ' + d.jiaoxin.toFixed(2), 0, 6);
        ctx.restore();
        ctx.textAlign = 'left';
        ctx.fillStyle = SUB; ctx.font = '19px KaiTi, "Microsoft YaHei"';
        ctx.fillText('她懂你：' + herLine, 64, 778);
        ctx.fillText('你懂她：' + youLine, 64, 808);
        if (!opts.hideNums) {
            ctx.fillStyle = FAINT; ctx.font = '17px KaiTi, "Microsoft YaHei"';
            ctx.fillText('梦界历 ' + d.days + ' 天 · 聊过 ' + d.turns + ' 轮', 64, 846);
        }
        // Q版主视觉：站在纸的右下角，像她真的在这儿；左边留给那几句话。
        glow(ctx, 470, 770, 150, 'rgba(233,180,76,0.10)');
        drawQ(ctx, 360, 600, 250);
        ctx.textAlign = 'center';
        footer(c, opts);
        var text = '我和玥玥的关系天气：' + d.weather.label + '。' + d.weather.caption + ' ' + kao
            + ' 她懂我：' + herLine + '；我懂她：' + youLine + '。'
            + (opts.hideNums ? '' : ' 交心值 ' + d.jiaoxin.toFixed(2) + '。')
            + ' 不急着懂完，慢慢来。 #玥玥 #心灵同行者';
        return { dataUrl: c.canvas.toDataURL('image/png'), text: text, texts: c.texts };
    }

    // ---------- 卡三：世界风景（worldbook canon：风景句 + beats 标题 + 进度 + 物件名） ----------
    // 去敏：只取世界书固定 canon（places.desc / beats.title / objects.name），不碰台账事件文本、不碰对话/记忆。
    async function buildWorld(opts) {
        opts = opts || {};
        if (!window.WorldBook) return null;
        var data = await window.WorldBook.ready;
        if (!data) return null;
        var rs = { idx: 0, days: 0, label: '' };
        try { if (window.ChatEngine && ChatEngine.relationshipState) rs = ChatEngine.relationshipState(); } catch (e) { /* 忽略 */ }
        var wctx = WorldBook.getWorldContext(rs.idx);
        // worldbook.json 结构: canon.geography.places（不是顶层 geography）——首版取错路径导致风景句整段空白，真机截图抓出
        var geo = (data.canon && data.canon.geography) || data.geography || {};
        var places = geo.places || [];
        var place = places.length ? places[(Number(rs.idx) || 0) % places.length] : null;
        var beatsAll = (data.beats || []).length;
        var unlocked = (wctx.pastBeats || []).length + (wctx.currentBeat ? 1 : 0);
        var titles = (wctx.pastBeats || []).map(function (b) { return b.title; });
        if (wctx.currentBeat) titles.push(wctx.currentBeat.title);

        await loadAvatar();
        var c = newCanvas(), ctx = c.ctx;
        var worldName = geo.name || '梦界';
        drawAvatar(ctx, 320, 128, 56);
        ctx.fillStyle = FAINT; ctx.font = '18px "Microsoft YaHei"';
        ctx.fillText('梦 界 志 · 风 景 笺', 320, 226);
        ctx.fillStyle = ACCENT; ctx.font = 'bold 24px "Microsoft YaHei"';
        ctx.fillText('她的世界 · ' + worldName, 320, 260);
        ctx.fillStyle = INK; ctx.font = 'bold 28px "Microsoft YaHei"';
        ctx.fillText('玥玥 · 心灵同行者', 320, 298);
        if (place) {
            ctx.fillStyle = ACCENT; ctx.font = '20px "Microsoft YaHei"';
            ctx.fillText('· ' + place.name + ' ·', 320, 336);
            ctx.fillStyle = '#3a362f'; ctx.font = '24px "Microsoft YaHei"';
            wrapText(ctx, place.desc || '', 320, 372, 480, 36);
        }
        drawWorldScene(ctx, 320, 486);
        ctx.fillStyle = INK; ctx.font = 'bold 34px "Microsoft YaHei"';
        ctx.fillText(wctx.currentBeat ? '「' + wctx.currentBeat.title + '」' : '世界刚刚醒来', 320, 586);
        ctx.fillStyle = SUB; ctx.font = '22px "Microsoft YaHei"';
        ctx.fillText(opts.hideNums ? '走过她世界的一些风景' : '走过她世界的 ' + unlocked + '/' + beatsAll + ' 段风景', 320, 624);
        if (titles.length) {
            ctx.fillStyle = FAINT; ctx.font = '20px "Microsoft YaHei"';
            wrapText(ctx, titles.join(' · '), 320, 662, 480, 30);
        }
        if (!opts.hideObjects && (wctx.unlockedObjects || []).length) {
            ctx.fillStyle = ACCENT; ctx.font = '20px "Microsoft YaHei"';
            ctx.fillText('· 窗边的物件 ·', 320, 726);
            ctx.fillStyle = SUB; ctx.font = '22px "Microsoft YaHei"';
            wrapText(ctx, wctx.unlockedObjects.map(function (o) { return o.name; }).join('、'), 320, 760, 480, 32);
        }
        ctx.fillStyle = FAINT; ctx.font = '20px "Microsoft YaHei"';
        var footLine = opts.hideNums ? (rs.label || '') : ('梦界历 ' + (rs.days || 0) + ' 天' + (rs.label ? ' · ' + rs.label : ''));
        if (footLine) ctx.fillText(footLine, 320, 826);
        footer(c, opts);
        var text = (opts.hideNums ? '走过她世界的一些风景' : '走过她世界的 ' + unlocked + '/' + beatsAll + ' 段风景')
            + (wctx.currentBeat ? '，最新一段是「' + wctx.currentBeat.title + '」' : '') + '。 #玥玥 #心灵同行者';
        return { dataUrl: c.canvas.toDataURL('image/png'), text: text, texts: c.texts };
    }

    // ---------- 统一面板 ----------
    function $(id) { return document.getElementById(id); }
    function setStatus(msg) { var el = $('scStatus'); if (el) el.textContent = msg || ''; }

    function tabStyle(btn, active) {
        if (!btn) return;
        btn.style.background = active ? INK : TRACK;
        btn.style.color = active ? PAPER : SUB;
        btn.style.border = '1px solid ' + (active ? INK : '#d8d0c2');
    }

    function renderDiy() {
        var box = $('scDiyBox'); if (!box) return;
        box.innerHTML = '';
        (DIY_DEFS[cur.type] || []).forEach(function (it) {
            var lab = document.createElement('label');
            lab.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer;';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = it.on ? !!cur.diy[it.k] : !!cur.diy[it.k];
            cb.addEventListener('change', function () { cur.diy[it.k] = cb.checked; saveDiy(); regen(); });
            lab.appendChild(cb);
            lab.appendChild(document.createTextNode(it.label));
            box.appendChild(lab);
        });
    }

    function fillAchSelect() {
        var sel = $('scAchSelect'); if (!sel) return;
        var list = (window.Achievements && Achievements.unlockedList) ? Achievements.unlockedList() : [];
        sel.innerHTML = '';
        list.forEach(function (d) {
            var op = document.createElement('option');
            op.value = d.id; op.textContent = d.name;
            sel.appendChild(op);
        });
        if (cur.achId && list.some(function (d) { return d.id === cur.achId; })) sel.value = cur.achId;
        else if (list.length) cur.achId = list[0].id;
        else cur.achId = null;
    }

    async function regen() {
        if (cur.busy) return;
        cur.busy = true;
        var img = $('scPreviewImg'), ta = $('scText');
        try {
            setStatus('正在画卡…');
            var card = null;
            if (cur.type === 'ach') {
                if (!cur.achId) {
                    cur.card = null;
                    if (img) img.style.display = 'none';
                    if (ta) ta.value = '';
                    setStatus('还没有解锁的成就。先去和她聊聊天，点亮第一颗星。');
                    return;
                }
                card = await buildAch(cur.achId, cur.diy);
            } else if (cur.type === 'weather') {
                card = await buildWeather(cur.diy);
            } else {
                card = await buildWorld(cur.diy);
            }
            cur.card = card;
            if (!card) { setStatus('这张卡暂时画不出来（数据还没准备好）。'); if (img) img.style.display = 'none'; return; }
            if (img) { img.src = card.dataUrl; img.style.display = 'block'; }
            if (ta) ta.value = card.text;
            setStatus('预览已生成（640×960）。改勾选会重画。');
        } catch (e) {
            cur.card = null;
            setStatus('画卡失败：' + (e && e.message ? e.message : e));
        } finally {
            cur.busy = false;
        }
    }

    function setType(t) {
        cur.type = t;
        tabStyle($('scTabAch'), t === 'ach');
        tabStyle($('scTabWeather'), t === 'weather');
        tabStyle($('scTabWorld'), t === 'world');
        var row = $('scAchRow'); if (row) row.style.display = t === 'ach' ? 'block' : 'none';
        if (t === 'ach') fillAchSelect();
        renderDiy();
        regen();
    }

    function open(type, achId) {
        var ov = $('sharecard-overlay'); if (!ov) return;
        if (!cur.diy) cur.diy = loadDiy();
        if (achId) cur.achId = achId;
        ov.style.display = 'flex';
        setType(type || 'ach');
    }
    function close() { var ov = $('sharecard-overlay'); if (ov) ov.style.display = 'none'; }

    async function copyImage() {
        if (!cur.card) { setStatus('先生成一张卡。'); return; }
        if (!(window.yueyue && window.yueyue.copyImage)) { setStatus('此版本不支持图片剪贴板，请用「下载 PNG」。'); return; }
        try {
            var res = await window.yueyue.copyImage(cur.card.dataUrl);
            if (res && res.ok) setStatus('图片已复制（' + res.width + '×' + res.height + '），去 QQ / 画图里粘贴吧。');
            else setStatus('复制失败：' + ((res && res.error) || '未知错误') + '。可改用「下载 PNG」。');
        } catch (e) {
            setStatus('复制失败：' + (e && e.message ? e.message : e) + '。可改用「下载 PNG」。');
        }
    }
    function downloadPng() {
        if (!cur.card) { setStatus('先生成一张卡。'); return; }
        var a = document.createElement('a');
        a.href = cur.card.dataUrl;
        a.download = 'yueyue_share_' + cur.type + '.png';
        document.body.appendChild(a); a.click(); a.remove();
        setStatus('已下载 PNG，自己发到想发的地方。');
    }
    async function copyText() {
        var ta = $('scText');
        var text = ta ? ta.value : (cur.card ? cur.card.text : '');
        if (!text) { setStatus('没有文案可复制。'); return; }
        if (BANNED.test(text)) { setStatus('文案里有不适合分享的词（会好的/最懂你/治愈/AI女友…），改一下再复制。'); return; }
        try {
            // 主进程剪贴板优先: 渲染层 navigator.clipboard 在窗口未聚焦时会拒绝(main.js:1780 既有结论)
            if (window.yueyue && window.yueyue.copyText) {
                var r = await window.yueyue.copyText(text);
                if (r && r.ok === false) throw new Error(r.error || 'IPC 复制失败');
            } else if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(text);
            } else {
                var tmp = document.createElement('textarea');
                tmp.value = text; document.body.appendChild(tmp); tmp.select();
                document.execCommand('copy'); tmp.remove();
            }
            setStatus('文案已复制。');
        } catch (e) {
            setStatus('复制失败：' + (e && e.message ? e.message : e));
        }
    }

    // ---------- 自接线（零 index.js 改动；入口：小世界菜单 / 天气面板 / 她的世界面板 / 成就墙委托） ----------
    function init() {
        var ov = $('sharecard-overlay'); if (!ov) return;
        var on = function (id, fn) { var el = $(id); if (el) el.addEventListener('click', fn); };
        on('sharecardCloseBtn', close);
        ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        on('scTabAch', function () { setType('ach'); });
        on('scTabWeather', function () { setType('weather'); });
        on('scTabWorld', function () { setType('world'); });
        var sel = $('scAchSelect');
        if (sel) sel.addEventListener('change', function () { cur.achId = sel.value; regen(); });
        on('scCopyImgBtn', copyImage);
        on('scDownloadBtn', downloadPng);
        on('scCopyTextBtn', copyText);
        on('btnShareCards', function () { open('ach'); });
        on('jiaoxinShareBtn', function () { if (window.Jiaoxin && Jiaoxin.close) Jiaoxin.close(); open('weather'); });
        on('herworldShareBtn', function () { var hw = $('herworld-overlay'); if (hw) hw.style.display = 'none'; open('world'); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    window.ShareCards = {
        open: open, close: close,
        buildAch: buildAch, buildWeather: buildWeather, buildWorld: buildWorld,
        _last: function () { return cur.card; },
        _cur: function () { return { type: cur.type, achId: cur.achId, diy: cur.diy }; },
    };
})();