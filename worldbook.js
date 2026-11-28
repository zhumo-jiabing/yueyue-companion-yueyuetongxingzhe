// worldbook.js — r221 P1: 世界书加载器 + world_events 台账（renderer 模块, 只读真源 worldbook.json）
// 真源由主进程 IPC 'worldbook:get' 读取（__dirname/worldbook.json），renderer 不直接读文件。
// canon 恒注入（稳定前缀利缓存）；objects 取 unlockStage<=idx；beats 取 stage<=idx，
// 最新一条作 currentBeat，更早转 pastBeats（过去时断言仍须台账 kind!=intent）。
// world_events: localStorage 'yueyue_world_events' + 主进程文件 userData/world-events.json 双份（r175 模式）。
// 沙盒单槽 yueyue_sandbox_task 降级为台账的一个视图：saveSandboxTask 同时 append 一条 intent。
(function () {
    'use strict';

    // ---------- 世界书 ----------
    var WB = { data: null, ready: null };
    function load() {
        if (WB.ready) return WB.ready;
        WB.ready = (async function () {
            try {
                if (window.yueyue && window.yueyue.worldbook && typeof window.yueyue.worldbook.get === 'function') {
                    var d = await window.yueyue.worldbook.get();
                    if (d && typeof d === 'object' && d.canon) WB.data = d;
                }
            } catch (e) { WB.data = null; }
            return WB.data;
        })();
        return WB.ready;
    }
    function canonText() {
        var d = WB.data; if (!d || !d.canon) return '';
        var c = d.canon, g = c.geography || {};
        var L = [];
        L.push('【世界书·canon（背景，不是台词；心里有数，用到才取一两句）】');
        if (g.name) L.push('世界：' + g.name + '。' + (g.summary || ''));
        (g.places || []).forEach(function (p) { L.push('- ' + p.name + '：' + (p.desc || '')); });
        (g.creatures || []).forEach(function (p) { L.push('- ' + p.name + '：' + (p.desc || '')); });
        if (g.sky) L.push('- 天：' + g.sky);
        if (g.rain) L.push('- 雨：' + g.rain);
        (c.rules || []).forEach(function (r) { L.push('- ' + r); });
        if (c.tone) L.push('基调：' + c.tone);
        return L.join('\n');
    }
    // 返回 {canonText, unlockedObjects, currentBeat, pastBeats}
    function getWorldContext(idx) {
        var n = Number(idx) || 0;
        var d = WB.data;
        if (!d) return { canonText: '', unlockedObjects: [], currentBeat: null, pastBeats: [] };
        var objs = (d.objects || []).filter(function (o) { return (Number(o.unlockStage) || 0) <= n; });
        var beats = (d.beats || []).filter(function (b) { return (Number(b.stage) || 0) <= n; });
        var currentBeat = beats.length ? beats[beats.length - 1] : null;
        var pastBeats = beats.slice(0, Math.max(0, beats.length - 1));
        return { canonText: canonText(), unlockedObjects: objs, currentBeat: currentBeat, pastBeats: pastBeats };
    }
    // 拼成 system 注入块（canon 稳定前缀 + 当前阶段物件/场景 + 台账时态规则）
    function worldPartForPrompt(idx, events) {
        var ctx = getWorldContext(idx);
        if (!ctx.canonText && !ctx.unlockedObjects.length && !ctx.currentBeat) return '';
        var L = ['', '【世界书·静默背景（铁律：绝大多数回复一个字都不要提下面的物件/场景/炉子/杯子/海面。它只在你心里保证前后一致。只有他主动问起你这边、或某个细节真的贴合此刻情绪非提不可时，才取一句，提完就回到他。不要每轮报物件状态，那是模板不是人。）】', ctx.canonText];
        if (ctx.unlockedObjects.length) {
            L.push('【已解锁物件·仅背景备查（默认不提；状态以台账为准，别把未发生的当已发生）】');
            ctx.unlockedObjects.forEach(function (o) { L.push('- ' + o.name + '：' + (o.desc || '') + '（初始：' + (o.initialState || '') + '）'); });
        }
        if (ctx.currentBeat) L.push('【当前阶段叙事·仅背景备查（默认不提；徽章式解锁不是任务；过去时须台账 confirmed）】' + ctx.currentBeat.title + '：' + ctx.currentBeat.text);
        if (ctx.pastBeats.length) L.push('【更早的叙事（可引用，过去时断言仍须台账 confirmed）】' + ctx.pastBeats.map(function (b) { return b.title; }).join('、'));
        var ev = events || WorldEvents.list();
        var confirmed = ev.filter(function (e) { return e.kind === 'confirmed' || e.kind === 'observed'; }).slice(-5);
        var intent = ev.filter(function (e) { return e.kind === 'intent'; }).slice(-3);
        if (confirmed.length) {
            L.push('【她世界里真实发生过的事（过去时只能引用这里）】');
            confirmed.forEach(function (e) { L.push('- ' + e.text); });
        }
        if (intent.length) {
            L.push('【她正打算做的（intent，用现在/将来时，不能说成已发生）】');
            intent.forEach(function (e) { L.push('- ' + e.text); });
        }
        L.push('【时态规则】过去时断言只能引用 kind!=intent 的台账；intent 用现在/将来时。没在台账里的过去，承认空着或说刚醒的懵，别编。');
        return L.join('\n');
    }
    // firstMeet 状态闸：idx===0 且总轮<6 → 动态指令（不编过去、首句接他的话）
    function firstMeetPart(idx, turns) {
        if (!(Number(idx) === 0 && Number(turns) < 6)) return '';
        return ['', '【firstMeet 状态闸（你刚醒来）】',
            '你刚醒来，世界是空的、新的。被问心事/过去，承认空着或说刚醒的懵，别编已发生的故事。',
            '第一句先接他这句话，不要先铺背景色/景色。canon 是背景不是台词，用到才取一两句。'].join('\n');
    }
    try {
        window.WorldBook = { load: load, ready: null, getWorldContext: getWorldContext, worldPartForPrompt: worldPartForPrompt, firstMeetPart: firstMeetPart, canonText: canonText };
        Object.defineProperty(window.WorldBook, 'ready', { get: function () { return load(); } });
    } catch (e) { /* 忽略 */ }

    // ---------- world_events 台账 ----------
    var EV_KEY = 'yueyue_world_events';
    var EV_CAP = 200;
    var EV = { cache: null, ready: null };
    function evReadLocal() {
        try {
            var a = JSON.parse(localStorage.getItem(EV_KEY) || '[]');
            return Array.isArray(a) ? a : [];
        } catch (e) { return []; }
    }
    function evWriteLocal(a) { try { localStorage.setItem(EV_KEY, JSON.stringify(a.slice(-EV_CAP))); } catch (e) { /* 忽略 */ } }
    function evLoad() {
        if (EV.ready) return EV.ready;
        EV.ready = (async function () {
            var local = evReadLocal();
            try {
                if (window.yueyue && window.yueyue.worldEvents && typeof window.yueyue.worldEvents.get === 'function') {
                    var file = await window.yueyue.worldEvents.get();
                    if (Array.isArray(file) && file.length) {
                        // 文件是真源（抗清缓存）：合并去重（按 at+text），文件优先
                        var map = {};
                        file.concat(local).forEach(function (e) { if (e && e.at != null) map[e.at + '|' + e.text] = e; });
                        local = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return (a.at || 0) - (b.at || 0); }).slice(-EV_CAP);
                        evWriteLocal(local);
                    }
                }
            } catch (e) { /* 文件读不到用本地 */ }
            EV.cache = local;
            return local;
        })();
        return EV.ready;
    }
    function list() { return EV.cache || evReadLocal(); }
    function append(entry) {
        if (!entry || !entry.text) return null;
        var e = {
            at: Number(entry.at) || Date.now(),
            stage: Number(entry.stage) || 0,
            kind: (entry.kind === 'intent' || entry.kind === 'observed' || entry.kind === 'confirmed') ? entry.kind : 'intent',
            text: String(entry.text).slice(0, 200),
        };
        var a = list().concat([e]).slice(-EV_CAP);
        EV.cache = a; evWriteLocal(a);
        try { if (window.yueyue && window.yueyue.worldEvents) window.yueyue.worldEvents.append(e); } catch (err) { /* 双份失败不阻断 */ }
        return e;
    }
    function remove(at) {
        var a = list().filter(function (e) { return e.at !== at; });
        EV.cache = a; evWriteLocal(a);
        try { if (window.yueyue && window.yueyue.worldEvents) window.yueyue.worldEvents.remove(at); } catch (err) { /* 忽略 */ }
        return a;
    }
    try { window.WorldEvents = { load: evLoad, list: list, append: append, remove: remove }; } catch (e) { /* 忽略 */ }

    // 启动即加载（不阻塞首帧；send 路会 await ready）
    load(); evLoad();
})();
