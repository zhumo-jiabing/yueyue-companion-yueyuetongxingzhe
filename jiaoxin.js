// jiaoxin.js — r221 P7: 交心值（关系天气）+ 互相了解度（她懂你 / 你懂她）
// 设计裁决（图07§7.3）：交心值＝近期互动的温度，不是依赖度分数。依赖检测（边界之手）纯内部，绝不进本面板。
// 四条护栏：
//   ① 不推送：无气泡/无红点/无提醒，用户点开才渲染（pull-only，无轮询）。
//   ② 可藏：yueyue_jiaoxin_on 默认开，关掉即藏起小世界入口并关面板。
//   ③ floor=0.5 及格线：再久不聊也不掉到「不及格」，最低是温和的小雨。
//   ④ 无任务：不做签到/任务/进度逼活跃；了解度是两条温和的进度，不是排行榜。
// 数据全本地：localStorage + ChatEngine 现有 API（IndexedDB）+ WorldBook/WorldEvents 现有 IPC 读取。
// 不新增出网、不新增 preload 暴露、不写任何状态键（只写两个 UI 开关键）。
// 可复跑：compute() 是（落盘数据 + 当前时间）的纯函数，同输入同输出。
(function () {
    'use strict';

    var ON_KEY = 'yueyue_jiaoxin_on';         // '0' = 藏起；缺省 = 开
    var NUM_OFF_KEY = 'yueyue_jiaoxin_num_off'; // '1' = 藏起数字；缺省 = 显示
    var FLOOR = 0.5;                          // 及格线（护栏③）

    function clamp01(x) { var n = Number(x); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
    function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function lsNum(k) { var n = Number(lsGet(k) || 0); return isFinite(n) ? n : 0; }
    function off() { return lsGet(ON_KEY) === '0'; }
    function numOff() { return lsGet(NUM_OFF_KEY) === '1'; }
    function $(id) { return document.getElementById(id); }

    // ---------- 输入读取（全部现有本地源，锚点用前已 grep） ----------
    // 上一条用户消息时间：与 chat-engine.js lastUserMsgGapMs() 同源同序。
    function lastUserTs() {
        var t = lsNum('yueyue_prev_user_msg_at');
        if (!t) { try { t = Number((JSON.parse(lsGet('yueyue_last_user_msg') || '{}') || {}).t || 0); } catch (e) { t = 0; } }
        if (!t) t = lsNum('yueyue_last_active');
        return t;
    }

    // 关系温度底座：镜像 chat-engine.js computeState() 的 bond 公式（第180轮状态层）。
    // 注意：引擎里 gapH 先被截到 72（chat-engine.js:1394），其 `gapH>72` 分支（:1425）实际永不命中；
    // 这里只镜像真正生效的两项：轮数底座 + 24h内低落离开罚项，clamp 区间一致（0.35..0.98）。
    // 用当前时刻重算而不是读 yueyue_state_v1 的旧快照，保证面板随时打开都是新鲜且可复跑的。
    function bondNow(turns, now) {
        var bond = 0.45 + 0.35 * (1 - Math.exp(-turns / 400));
        try {
            var dep = JSON.parse(lsGet('yueyue_departure') || 'null');
            if (dep && dep.at && (now - dep.at) < 86400000 && /low|sad|angry/i.test(String(dep.mood || ''))) bond -= 0.04;
        } catch (e) { /* 忽略 */ }
        return Math.max(0.35, Math.min(0.98, bond));
    }

    // 「你问过她的心事」：从原话台账（IndexedDB rawMessages，滚动上限3000）扫描，不新增计数器。
    var HEART_ASK_RE = /心事|你在想什么|在想些什么|你(今天|最近)?(过得)?怎么样|最近怎么样|你还好吗|你开心吗|你难过吗|你的(过去|故事|以前)|说说你|聊聊你/;

    // 天气意象：只有四档温和天气，没有暴雨/严寒（floor 之下不存在）。
    function weatherOf(v) {
        if (v >= 0.85) return { icon: '☀️', label: '晴', caption: '你们最近聊得热乎，暖意正盛。' };
        if (v >= 0.70) return { icon: '⛅', label: '多云', caption: '有来有往，温度刚好。' };
        if (v >= 0.57) return { icon: '☁️', label: '阴', caption: '最近安静了些，暖意还在。' };
        return { icon: '🌦️', label: '小雨', caption: '有阵子没聊了。没关系，暖意还在，什么时候回来都行。' };
    }

    // ---------- 核心计算 ----------
    async function compute() {
        var now = Date.now();
        var turns = lsNum('yueyue_total_turns');
        var ts = lastUserTs();
        var gapH = ts ? Math.max(0, (now - ts) / 3600000) : 0;

        // 交心值 = 长期底座（bond 归一，不随久别衰减 → 余温）+ 近期互动温度（72h e-fold 衰减）。
        // 0.5 + 0.5*(加权和)：值域 [0.5, 1]，floor 即及格线（护栏③）。
        var bond = bondNow(turns, now);
        var bondNorm = (bond - 0.35) / 0.63;
        var recent = turns > 0 ? Math.exp(-gapH / 72) : 0;
        var jiaoxin = Math.max(FLOOR, Math.min(1, FLOOR + 0.5 * (0.6 * bondNorm + 0.4 * recent)));

        // 她懂你：记忆深度（核心记忆 + 全部记忆），渐近曲线，无上限压力。
        var mems = (window.ChatEngine && ChatEngine.getMemories) ? ChatEngine.getMemories() : [];
        var isCore = (window.ChatEngine && ChatEngine.isCoreMemory) ? ChatEngine.isCoreMemory
            : function (m) { return !!(m && (m.locked || (Number(m.userWeight) || 0) === 4)); };
        var total = mems.length, core = 0;
        for (var i = 0; i < mems.length; i++) if (isCore(mems[i])) core++;
        var herKnows = clamp01(0.55 * (1 - Math.exp(-core / 8)) + 0.45 * (1 - Math.exp(-total / 60)));

        // 你懂她：解锁的世界 beats 比例 + 见证过的时刻（台账 kind!=intent）+ 问过她心事的次数。
        var idx = 0, stageLabel = '', days = 0;
        try { var rs = ChatEngine.relationshipState(); idx = rs.idx; stageLabel = rs.label || ''; days = rs.days || 0; } catch (e) { /* 忽略 */ }
        var beatsTotal = 0, beatsUnlocked = 0;
        try {
            if (window.WorldBook) {
                var data = await window.WorldBook.ready;
                beatsTotal = ((data && data.beats) || []).length;
                var ctx = window.WorldBook.getWorldContext(idx);
                beatsUnlocked = (ctx.pastBeats || []).length + (ctx.currentBeat ? 1 : 0);
            }
        } catch (e) { /* 忽略 */ }
        var evs = (window.WorldEvents && WorldEvents.list) ? WorldEvents.list() : [];
        var shared = 0;
        for (var j = 0; j < evs.length; j++) if (evs[j] && (evs[j].kind === 'confirmed' || evs[j].kind === 'observed')) shared++;
        var asked = 0;
        try {
            if (window.ChatEngine && ChatEngine.getRawMessages) {
                var raw = await ChatEngine.getRawMessages(3000);
                for (var k = 0; k < raw.length; k++) {
                    var r = raw[k];
                    if (r && r.role === 'user' && HEART_ASK_RE.test(String(r.content || ''))) asked++;
                }
            }
        } catch (e) { /* 忽略 */ }
        var beatRatio = beatsTotal > 0 ? beatsUnlocked / beatsTotal : 0;
        var youKnow = clamp01(0.45 * beatRatio + 0.30 * (1 - Math.exp(-shared / 10)) + 0.25 * (1 - Math.exp(-asked / 6)));

        return {
            jiaoxin: +jiaoxin.toFixed(3), weather: weatherOf(jiaoxin),
            herKnows: +herKnows.toFixed(3), youKnow: +youKnow.toFixed(3),
            bond: +bond.toFixed(3), gapH: +gapH.toFixed(1), turns: turns,
            memTotal: total, memCore: core,
            beatsUnlocked: beatsUnlocked, beatsTotal: beatsTotal, shared: shared, asked: asked,
            stageIdx: idx, stageLabel: stageLabel, days: days,
        };
    }

    // ---------- 面板渲染（pull-only：点开才算，不推送不轮询） ----------
    function setBar(barId, pctId, txtId, v, txt) {
        var bar = $(barId); if (bar) bar.style.width = (clamp01(v) * 100).toFixed(1) + '%';
        var pct = $(pctId); if (pct) pct.textContent = Math.round(clamp01(v) * 100) + '%';
        var t = $(txtId); if (t) t.textContent = txt;
    }
    async function render() {
        var d = await compute();
        var icon = $('jiaoxinWeatherIcon'); if (icon) icon.textContent = d.weather.icon;
        var lab = $('jiaoxinWeatherLabel'); if (lab) lab.textContent = d.weather.label;
        var cap = $('jiaoxinCaption'); if (cap) cap.textContent = d.weather.caption;
        var num = $('jiaoxinNum'); if (num) { num.textContent = d.jiaoxin.toFixed(2); num.style.display = numOff() ? 'none' : ''; }
        var nt = $('jiaoxinNumToggle'); if (nt) nt.textContent = numOff() ? '显示数字' : '藏起数字';
        var st = $('jiaoxinStage'); if (st) st.textContent = '当前关系：' + (d.stageLabel || '第一境·初识') + ' · 相识第 ' + d.days + ' 天 · 共 ' + d.turns + ' 轮';
        setBar('jiaoxinHerBar', 'jiaoxinHerPct', 'jiaoxinHerTxt', d.herKnows,
            '她记着你的 ' + d.memTotal + ' 件事，其中 ' + d.memCore + ' 件是她格外珍惜的。');
        setBar('jiaoxinYouBar', 'jiaoxinYouPct', 'jiaoxinYouTxt', d.youKnow,
            '你走过她世界的 ' + d.beatsUnlocked + '/' + d.beatsTotal + ' 段风景，见证过她 ' + d.shared + ' 个时刻，问过她 ' + d.asked + ' 次心事。');
        return d;
    }
    function open() {
        if (off()) return;
        var ov = $('jiaoxin-overlay'); if (!ov) return;
        ov.style.display = 'flex';
        render();
    }
    function close() { var ov = $('jiaoxin-overlay'); if (ov) ov.style.display = 'none'; }

    // ---------- 开关与可见性（参考 index.js moreCostBadge 的写法） ----------
    function syncSwitch() {
        var sw = $('moreJiaoxin'); if (!sw) return;
        sw.classList.toggle('active', !off());
        var label = sw.querySelector('.switch-label');
        if (label) label.textContent = off() ? '🌤️ 我们的天气 · 关' : '🌤️ 我们的天气';
    }
    function applyVisibility() {
        var item = $('btnJiaoxin'); if (item) item.style.display = off() ? 'none' : '';
        if (off()) close();
        syncSwitch();
    }

    function init() {
        var item = $('btnJiaoxin');
        if (item && !item.__jiaoxinWired) {
            item.__jiaoxinWired = true;
            item.addEventListener('click', function () {
                var menu = $('more-menu'); if (menu) menu.style.display = 'none';
                open();
            });
        }
        var cb = $('jiaoxinCloseBtn'); if (cb) cb.addEventListener('click', close);
        var ov = $('jiaoxin-overlay');
        if (ov) ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        var nt = $('jiaoxinNumToggle');
        if (nt) nt.addEventListener('click', function () {
            try { localStorage.setItem(NUM_OFF_KEY, numOff() ? '0' : '1'); } catch (e) { /* 忽略 */ }
            render();
        });
        var sw = $('moreJiaoxin');
        if (sw && !sw.__jiaoxinWired) {
            sw.__jiaoxinWired = true;
            sw.addEventListener('click', function () {
                try { localStorage.setItem(ON_KEY, off() ? '1' : '0'); } catch (e) { /* 忽略 */ }
                applyVisibility();
            });
        }
        // 跨窗同步（与 chat-engine 的 storage 监听同一模式）
        try {
            window.addEventListener('storage', function (e) {
                if (!e) return;
                if (e.key === ON_KEY) applyVisibility();
                else if (e.key === NUM_OFF_KEY && $('jiaoxin-overlay') && $('jiaoxin-overlay').style.display !== 'none') render();
            });
        } catch (e) { /* 忽略 */ }
        applyVisibility();
    }

    try {
        window.Jiaoxin = { compute: compute, render: render, open: open, close: close, off: off, FLOOR: FLOOR };
    } catch (e) { /* 忽略 */ }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
