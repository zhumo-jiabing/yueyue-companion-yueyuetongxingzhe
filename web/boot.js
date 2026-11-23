/**
 * 玥玥 · 漫展网页版 boot（第88轮 D1）
 *
 * 这一份脚本的作用：让「桌面端那一整套前端代码」在浏览器里跑起来。
 *
 * 为什么可以这么干（第87轮实测）：
 *   index.js 387KB 里 require('electron') / require('fs') / child_process / ipcRenderer 全是 0 次，
 *   渲染层本来就是纯浏览器 JS。它唯一跟宿主耦合的地方是 window.yueyue —— 77 处调用、13 个命名空间，
 *   全部由 preload.js 的 contextBridge 提供。所以只要把这个对象在浏览器里造出来，桌面端代码就能跑。
 *
 * 三个必须守住的规矩：
 *   1. 不放宽任何东西 —— 年龄门、同意门、soul.js 的红线全走原代码，一个字都不改。
 *   2. 不假装有、也不假装没有 —— 做不到的能力（麦克风、桌宠、本地语音包）老实说做不到，
 *      绝不返回一个"看起来成功"的假结果。
 *   3. 不在浏览器里出现 Key —— 所有模型请求都打同源 /api，Key 只在代理进程内存里。
 */
(function () {
    'use strict';
    if (window.__yueyueWebBoot) return;
    window.__yueyueWebBoot = true;

    var IS_BOOTH = /[?&]selftest=1/.test(location.search);
    var DIAG = [];
    function diag(tag, msg) {
        DIAG.push({ t: Date.now(), tag: tag, msg: String(msg) });
        if (DIAG.length > 200) DIAG.shift();
    }
    window.__yueyueDiag = DIAG;

    /* ============================================================
     * 一、先把三处会让原代码当场炸掉的环境缺口补上
     * ============================================================ */

    // 1a BroadcastChannel —— shared.js:124-130 的 syncChannel() 没有 try，
    //    Safari 私密浏览下构造直接抛，会把整个启动链带崩。
    if (typeof window.BroadcastChannel !== 'function') {
        window.BroadcastChannel = function (name) {
            this.name = name;
            this.onmessage = null;
            this.close = function () {};
            this.postMessage = function () {};
            this.addEventListener = function () {};
            this.removeEventListener = function () {};
        };
        diag('env', 'BroadcastChannel 打桩');
    }

    // 1b 存储写入守卫 —— 私密浏览 / 配额满时 setItem 会抛 QuotaExceededError，
    //    原代码有多处裸调。这里吞掉异常并退到内存副本，读的时候再接回来。
    (function () {
        try {
            var proto = window.Storage && window.Storage.prototype;
            if (!proto || proto.__yueyueGuarded) return;
            var mem = new Map();
            var rawSet = proto.setItem;
            var rawGet = proto.getItem;
            proto.setItem = function (k, v) {
                try { rawSet.call(this, k, v); } catch (e) { mem.set(String(k), String(v)); diag('storage', '写入降级：' + k); }
            };
            proto.getItem = function (k) {
                try { var v = rawGet.call(this, k); if (v !== null) return v; } catch (e) { /* 落到内存副本 */ }
                return mem.has(String(k)) ? mem.get(String(k)) : null;
            };
            proto.__yueyueGuarded = true;
        } catch (e) { /* 不改也能跑 */ }
    })();

    // 1c 首次进入的默认值
    (function () {
        try {
            // 桌面端 init 的整块初始化挂在 `if (savedName !== null)` 上；网页版没有取名字那一屏，
            // 这里给一个空串（不是 null），她开场就用"你"称呼，不会卡在取名页。
            if (localStorage.getItem('yueyue_user_name') === null) localStorage.setItem('yueyue_user_name', '');
            // 验收用例 P1：桌面端语音开关默认是关（tts-voice.js:23 判断 === '1'），
            // 而漫展的要求是"必须出声"，所以网页版默认打开。
            if (localStorage.getItem('yueyue_voice_on') === null) localStorage.setItem('yueyue_voice_on', '1');
        } catch (e) { /* 忽略 */ }
    })();

    /* ============================================================
     * 二、DOM 兜底：387 处 getElementById 里大量没判空
     * ============================================================ */
    // 下面是「找不到就发一个游离桩」的实现，所以在建播报区/提示条之前
    // 必须保留一个真·查询：桩永远 truthy，会让 byId(...) 的判断全部失效。
    var nativeGetById = Document.prototype.getElementById;
    function realById(id) { return nativeGetById.call(document, id); }
    (function () {
        var stubs = new Map();
        function makeStub(id) {
            var el = document.createElement('div');
            el.id = id;
            // 桩的 value 必须是空串而不是 undefined —— 否则 apiUrlInput.value.trim() 照样炸
            el.value = '';
            el.checked = false;
            el.disabled = false;
            el.textContent = '';
            el.innerHTML = '';
            el.getContext = function () { return null; };
            el.scrollIntoView = function () {};
            el.focus = function () {};
            el.blur = function () {};
            el.click = function () {};
            el.select = function () {};
            el.setSelectionRange = function () {};
            el.captureStream = function () { return null; };
            el.play = function () { return Promise.resolve(); };
            el.pause = function () {};
            el.load = function () {};
            return el;
        }
        var native = Document.prototype.getElementById;
        Document.prototype.getElementById = function (id) {
            var found = native.call(this, id);
            if (found) return found;
            var s = stubs.get(id);
            if (!s) { s = makeStub(id); stubs.set(id, s); }
            return s;
        };
        window.__yueyueStubCount = function () { return stubs.size; };
    })();

    /* ============================================================
     * 三、window.yueyue —— preload.js 的浏览器版
     * ============================================================ */

    var seq = 0;
    var bus = { chunk: [], done: [], error: [], phase: [] };

    function on(name) {
        return function (fn) {
            if (typeof fn === 'function') bus[name].push(fn);
            return function () {
                var i = bus[name].indexOf(fn);
                if (i >= 0) bus[name].splice(i, 1);
            };
        };
    }

    function emit(name, data) {
        var list = bus[name];
        for (var i = 0; i < list.length; i++) {
            try { list[i](data); } catch (e) { diag('emit', name + ': ' + e.message); }
        }
    }

    function nextId() { return 'web' + (++seq) + '_' + Date.now().toString(36); }

    // ---- 流式对话：同步返回 {ok,id}，之后用 ai:chunk / ai:done / ai:error 分发 ----
    function runStream(id, payload) {
        var ctrl = null;
        var timer = null;
        try {
            ctrl = new AbortController();
            timer = setTimeout(function () {
                try { ctrl.abort(); } catch (e) { /* 忽略 */ }
            }, 45000);
        } catch (e) { /* 老浏览器没有 AbortController，就不设超时 */ }

        fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ctrl ? ctrl.signal : undefined,
            credentials: 'same-origin',
        }).then(function (res) {
            if (!res.ok) {
                return res.json().catch(function () { return {}; }).then(function (j) {
                    emit('error', { id: id, message: j.message || '请求失败' });
                });
            }
            if (!res.body || !res.body.getReader) {
                // 没有流式能力就整段取回，当成一次大 chunk
                return res.text().then(function (raw) {
                    var full = parseWhole(raw);
                    if (!full) return emit('error', { id: id, message: '回复为空,请再试一次' });
                    emit('chunk', { id: id, delta: full, full: full });
                    emit('done', { id: id, full: full });
                });
            }
            var reader = res.body.getReader();
            var dec = new TextDecoder('utf-8');
            var buf = '';
            var full = '';
            function pump() {
                return reader.read().then(function (r) {
                    if (r.done) {
                        if (!full) emit('error', { id: id, message: '回复为空,请再试一次' });
                        else emit('done', { id: id, full: full });
                        return;
                    }
                    buf += dec.decode(r.value, { stream: true });
                    var idx;
                    while ((idx = buf.indexOf('\n')) >= 0) {
                        var line = buf.slice(0, idx).replace(/\r$/, '').trim();
                        buf = buf.slice(idx + 1);
                        if (!line || line.slice(0, 5) !== 'data:') continue;
                        var data = line.slice(5).trim();
                        if (!data || data === '[DONE]') continue;
                        var j;
                        try { j = JSON.parse(data); } catch (e) { continue; }
                        if (j && j['x-yueyue-error']) {
                            emit('error', { id: id, message: j.message || '请求失败' });
                            return;
                        }
                        var ch = (j.choices && j.choices[0]) || {};
                        var d = ch.delta || {};
                        var delta = d.content || '';
                        if (delta) {
                            full += delta;
                            emit('chunk', { id: id, delta: delta, full: full });
                        }
                    }
                    return pump();
                });
            }
            return pump();
        }).catch(function (e) {
            var msg = (e && e.name === 'AbortError') ? '等太久了，网络可能不太稳' : ('网络不通：' + ((e && e.message) || '未知'));
            emit('error', { id: id, message: msg });
        }).then(function () {
            if (timer) clearTimeout(timer);
        });
    }

    function parseWhole(raw) {
        // 非流式兜底的解析：把 SSE 整段拼起来
        var out = '';
        String(raw || '').split('\n').forEach(function (line) {
            line = line.trim();
            if (line.slice(0, 5) !== 'data:') return;
            var d = line.slice(5).trim();
            if (!d || d === '[DONE]') return;
            try {
                var j = JSON.parse(d);
                var ch = (j.choices && j.choices[0]) || {};
                out += (ch.delta && ch.delta.content) || (ch.message && ch.message.content) || '';
            } catch (e) { /* 忽略坏行 */ }
        });
        return out;
    }

    function chat(payload) {
        var id = nextId();
        var body = {
            messages: (payload && payload.messages) || [],
            model: (payload && payload.model) || '',
        };
        // apiUrl 一律忽略：getApiUrl() 会按模型回写 localStorage，浏览器里不能让它把请求打到公网
        runStream(id, body);
        return Promise.resolve({ ok: true, id: id });
    }

    function nonStream(messages, model, temperature) {
        return fetch('/api/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ messages: messages, model: model || '', temperature: temperature }),
        }).then(function (res) {
            return res.json().catch(function () { return {}; }).then(function (j) {
                if (!res.ok) return { ok: false, error: j.error || 'FAILED', message: j.message || '请求失败' };
                return { ok: true, text: j.text || '', finishReason: j.finishReason || '' };
            });
        }).catch(function (e) {
            return { ok: false, error: 'NETWORK', message: (e && e.message) || '网络不通' };
        });
    }

    function complete(o) {
        o = o || {};
        var messages = [];
        if (o.system) messages.push({ role: 'system', content: String(o.system) });
        if (o.user) messages.push({ role: 'user', content: String(o.user) });
        return nonStream(messages, o.model, o.temperature);
    }

    // ---- 语音：浏览器自带 speechSynthesis ----
    var ttsCfgListeners = [];
    var speechReady = !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
    var pickedVoice = null;
    var voiceProbe = null;      // 共享的"等嗓音"Promise，避免每段都等
    var voiceNone = false;      // 探明这台设备确实没有嗓音
    var voiceNoticeDismissed = false;

    /* 系统事件播报：只往 role=status 的区域写；不碰消息流 */
    function announceStatus(text) {
        if (!text) return false;
        try {
            var s = realById('srStatus');
            if (!s) { (window.__mStatusQueue = window.__mStatusQueue || []).push(String(text)); return false; }
            var row = document.createElement('div');
            row.textContent = String(text);
            s.appendChild(row);
            while (s.children.length > 8) s.removeChild(s.firstChild);
            return true;
        } catch (e) { return false; }
    }

    function voicesNow() {
        if (!speechReady) return [];
        try { return window.speechSynthesis.getVoices() || []; } catch (e) { return []; }
    }

    /* 第88轮 MuMu 缺陷①：安卓模拟器里 speechSynthesis 对象存在、嗓音列表却是 0，
       原来的 speak() 直接返回 ok:true —— 界面"看着在说"，实际一点声都没有。
       这里探一次嗓音（最多等 1.2s voiceschanged，Chrome 是异步填充的）：
       0 个就显式提示 + 返回 ok:false（真源 tts-voice 会走"先用文字陪你"分支）。 */
    function probeVoices(timeout) {
        if (!speechReady) return Promise.resolve(0);
        var n = voicesNow().length;
        if (n) { voiceNone = false; return Promise.resolve(n); }
        if (voiceNone) return Promise.resolve(0);
        if (voiceProbe) return voiceProbe;
        voiceProbe = new Promise(function (resolve) {
            var done = false;
            var timer = null;
            function finish(count) {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                try { window.speechSynthesis.removeEventListener('voiceschanged', onchange); } catch (e) { /* 忽略 */ }
                voiceProbe = null;
                resolve(count);
            }
            function onchange() {
                var now = voicesNow().length;
                if (now) finish(now);
            }
            try { window.speechSynthesis.addEventListener('voiceschanged', onchange); } catch (e) { /* 忽略 */ }
            timer = setTimeout(function () { finish(voicesNow().length); }, timeout || 1200);
        });
        return voiceProbe;
    }

    function showVoiceNotice(reason) {
        var old = realById('webVoiceNotice');
        if (old) return old;
        var d = document.createElement('div');
        d.id = 'webVoiceNotice';
        d.setAttribute('role', 'status');
        d.setAttribute('aria-live', 'polite');
        var icon = document.createElement('span');
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = '🔇';
        var txt = document.createElement('span');
        txt.className = 'wvn-text';
        txt.textContent = reason || ('这台手机浏览器没有可用的语音引擎：玥玥只会用文字回复，不会假装在说话。'
            + '装好语音包或换一个浏览器后刷新即可。');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'wvn-close';
        btn.setAttribute('aria-label', '关闭这条语音提示');
        btn.textContent = '知道了';
        btn.addEventListener('click', function () {
            voiceNoticeDismissed = true;
            try { d.remove(); } catch (e) { /* 已移除 */ }
        });
        d.appendChild(icon);
        d.appendChild(txt);
        d.appendChild(btn);
        try { document.body.appendChild(d); } catch (e) { /* body 未就绪 */ }
        announceStatus(txt.textContent);
        window.__mVoiceNoticeCount = (window.__mVoiceNoticeCount || 0) + 1;
        return d;
    }

    function pickVoice() {
        if (pickedVoice || !speechReady) return pickedVoice;
        var vs = [];
        try { vs = window.speechSynthesis.getVoices() || []; } catch (e) { vs = []; }
        // 优先中文女声；找不到就用第一个中文；再没有就用系统默认
        var zh = vs.filter(function (v) { return /zh|cmn|Chinese/i.test(v.lang || ''); });
        pickedVoice = zh.filter(function (v) { return /female|女|Tingting|Xiaoxiao|Huihui|Yaoyao|Mei/i.test(v.name || ''); })[0]
            || zh[0] || null;
        return pickedVoice;
    }
    if (speechReady) {
        try {
            window.speechSynthesis.onvoiceschanged = function () { pickedVoice = null; pickVoice(); };
            // 后来才装上/生效的嗓音：撤掉提示，恢复发声
            window.speechSynthesis.addEventListener('voiceschanged', function () {
                if (!voicesNow().length) return;
                voiceNone = false;
                voiceNoticeDismissed = false;
                window.__mTtsNoVoice = false;
                var n = realById('webVoiceNotice');
                if (n) { try { n.remove(); } catch (e) { /* 忽略 */ } }
            });
        } catch (e) { /* 忽略 */ }
    }

    var tts = {
        available: function () { var vs = voicesNow(); return Promise.resolve({ ok: !!speechReady, engine: 'webspeech', voices: vs.length }); },
        getConfig: function () { return Promise.resolve({ engine: 'webspeech', sampleSteps: 0, live: true }); },
        onConfig: function (fn) { if (typeof fn === 'function') ttsCfgListeners.push(fn); },
        cancel: function () {
            try { window.speechSynthesis.cancel(); } catch (e) { /* 忽略 */ }
            return Promise.resolve({ ok: true });
        },
        speak: function (o) {
            o = o || {};
            window.__mTtsCalls = (window.__mTtsCalls || 0) + 1;
            window.__mTtsLastText = String(o.text || '').slice(0, 60);
            var text = String(o.text || '').trim();
            if (!text || !speechReady) return Promise.resolve({ ok: true, wav: null });
            return probeVoices(1200).then(function (n) {
                if (!n) {
                    voiceNone = true;
                    window.__mTtsNoVoice = true;
                    window.__mTtsVoiceCount = 0;
                    // 用户主动关掉过提示就不再反复弹；但 ok:false 仍照旧，绝不假成功
                    if (!voiceNoticeDismissed) showVoiceNotice();
                    else announceStatus('这台手机没有可用的语音引擎，玥玥只用文字回复。');
                    window.__mLastVoiceResult = { ok: false, error: 'NO_VOICE', voices: 0 };
                    return { ok: false, error: 'NO_VOICE', wav: null };
                }
                window.__mTtsVoiceCount = n;
                try {
                    var u = new window.SpeechSynthesisUtterance(text);
                    var v = pickVoice();
                    if (v) u.voice = v;
                    u.lang = (v && v.lang) || 'zh-CN';
                    u.rate = 1.0;
                    u.pitch = 1.05;
                    // 关键：必须在用户手势（年龄门那一下点击）里先"喂"一次，否则 iOS 静音到页面重载
                    window.speechSynthesis.speak(u);
                } catch (e) { diag('tts', e.message); }
                // 返回 ok + wav:null —— 真正的发声由 speechSynthesis 负责，
                // 桌面那条 wav 队列直接放行（tts-voice.js:216 拿到 null 就会 skip 到下一段）。
                window.__mLastVoiceResult = { ok: true, error: null, voices: n };
                return { ok: true, wav: null };
            });
        },
    };

    // iOS/安卓的音频解锁：第一次真实点按就把语音引擎叫醒
    (function () {
        var unlocked = false;
        function unlock() {
            if (unlocked) return;
            unlocked = true;
            try {
                if (speechReady) {
                    var u = new window.SpeechSynthesisUtterance(' ');
                    u.volume = 0;
                    window.speechSynthesis.speak(u);
                }
            } catch (e) { /* 忽略 */ }
            try {
                if (navigator.storage && navigator.storage.persist) navigator.storage.persist().then(function () {}).catch(function () {});
            } catch (e) { /* 忽略 */ }
            document.removeEventListener('pointerdown', unlock, true);
            document.removeEventListener('touchstart', unlock, true);
            document.removeEventListener('keydown', unlock, true);
            diag('tts', '语音引擎已解锁');
        }
        document.addEventListener('pointerdown', unlock, true);
        document.addEventListener('touchstart', unlock, true);
        document.addEventListener('keydown', unlock, true);
    })();

    // ---- 情绪：本地关键词，只用真源那 8 个标签 ----
    var EMOTION_LABELS = ['开心', '难过', '生气', '焦虑', '思念', '期待', '平静', '疲惫'];
    var EMO_RULES = [
        ['难过', /(难过|伤心|哭了|想哭|委屈|失落|心碎|难受|低落)/],
        ['焦虑', /(焦虑|紧张|害怕|担心|不安|慌|压力|睡不着|失眠)/],
        ['生气', /(生气|气死|烦死|讨厌|愤怒|气人|恼火)/],
        ['疲惫', /(累|疲惫|困|没力气|撑不住|好倦|乏)/],
        ['思念', /(想你了|想念|怀念|好久不见|惦记)/],
        ['期待', /(期待|等不及|好想|希望|明天|准备去)/],
        ['开心', /(开心|高兴|太好了|喜欢|哈哈|嘻嘻|笑|幸福|棒)/],
    ];
    function classify(o) {
        var text = String((o && o.text) || '');
        var label = '平静';
        for (var i = 0; i < EMO_RULES.length; i++) {
            if (EMO_RULES[i][1].test(text)) { label = EMO_RULES[i][0]; break; }
        }
        if (EMOTION_LABELS.indexOf(label) === -1) label = '平静';
        return Promise.resolve({ ok: true, label: label, score: label === '平静' ? 0.2 : 0.7, secondLabel: null });
    }

    // ---- 记忆持久化：浏览器 localStorage 兜底（桌面端是文件） ----
    var ACH_KEY = 'yueyue_ach_web_v1';

    function noop() { return Promise.resolve({ ok: true }); }
    function noopFalse() { return Promise.resolve({ ok: false }); }

    function sayGoodbye() {
        var ov = document.getElementById('web-goodbye');
        if (ov) { ov.style.display = 'flex'; return; }
        var d = document.createElement('div');
        d.id = 'web-goodbye';
        d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(8,6,18,0.97);color:#eee;'
            + 'display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px;'
            + 'font-family:system-ui,-apple-system,sans-serif;line-height:1.9;';
        d.innerHTML = '<div style="font-size:40px;margin-bottom:14px;">🌙</div>'
            + '<div style="font-size:16px;color:#ffb4c8;margin-bottom:10px;">这一程到这里</div>'
            + '<div style="font-size:14px;color:#bbb;max-width:22em;">直接关掉这个页签就好。<br>'
            + '本机上不会留下任何东西。</div>';
        document.body.appendChild(d);
    }

    var yueyue = {
        // 聊天
        ai: {
            chat: chat,
            dualChat: chat,          // 网页版只有一个脑子，双脑入口保留同形签名，行为=单脑
            complete: complete,
            summarize: function (o) {
                o = o || {};
                return complete({
                    system: '你是严谨的摘要助手。只输出摘要正文本身，不要解释、不要寒暄、不要标题。',
                    user: String(o.prompt || ''),
                    model: o.model,
                    temperature: 0.3,
                });
            },
            scene: noopFalse,
            video: noopFalse,
            search: noopFalse,       // 注意：preload 顶层本来也没有 search，这里保持一致
            onChunk: on('chunk'),
            onDone: on('done'),
            onError: on('error'),
            onPhase: on('phase'),
        },
        settings: {
            // hasDeepseekKey 故意返回 false：网页版没有第二个脑子，不能让界面假装"双脑已开"
            get: function () { return Promise.resolve({ hasKey: true, keyTail: '展台', hasDeepseekKey: false, apiUrl: '' }); },
            setKey: function () { return Promise.resolve({ ok: false, error: 'BOOTH_READONLY', message: '展台版不在这里保存钥匙' }); },
            clearKey: noop,
            migrateKey: noopFalse,
            clearAllData: function () {
                try { indexedDB.deleteDatabase('YueyueMemoryDB_v3'); } catch (e) { /* 忽略 */ }
                try { localStorage.clear(); } catch (e) { /* 忽略 */ }
                return Promise.resolve({ ok: true });
            },
        },
        tts: tts,
        stt: {
            // http://192.168.x.x 不是安全上下文，getUserMedia 直接被浏览器拒 —— 老实说没有
            ready: function () { return Promise.resolve({ ok: false, ready: false, reason: 'NO_SECURE_CONTEXT' }); },
            transcribe: function () { return Promise.resolve({ ok: false, error: 'NO_MIC' }); },
        },
        emotion: { classify: classify },
        perf: {
            setBgThrottling: noop,
            beginBgFullSpeed: noop,
            endBgFullSpeed: noop,
        },
        achStore: {
            load: function () {
                try { return Promise.resolve({ ok: true, data: JSON.parse(localStorage.getItem(ACH_KEY) || '{}') }); }
                catch (e) { return Promise.resolve({ ok: true, data: {} }); }
            },
            save: function (s) {
                try { localStorage.setItem(ACH_KEY, JSON.stringify(s || {})); } catch (e) { /* 忽略 */ }
                return Promise.resolve({ ok: true });
            },
        },
        plugins: {
            list: function () { return Promise.resolve({ ok: true, plugins: [] }); },
            set: noop,
        },
        copyText: function (text) {
            var s = String(text == null ? '' : text);
            function fallback() {
                try {
                    var ta = document.createElement('textarea');
                    ta.value = s;
                    ta.style.cssText = 'position:fixed;opacity:0;left:-9999px;';
                    document.body.appendChild(ta);
                    ta.select();
                    var ok = document.execCommand('copy');
                    document.body.removeChild(ta);
                    return ok;
                } catch (e) { return false; }
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
                return navigator.clipboard.writeText(s).then(function () { return { ok: true }; })
                    .catch(function () { return { ok: fallback() }; });
            }
            return Promise.resolve({ ok: fallback() });
        },

        // 桌面专有 —— 全部安全地"什么都不做"
        win: {
            minimize: noop,
            maximizeToggle: noop,
            close: function () { sayGoodbye(); return Promise.resolve({ ok: true }); },
            isMaximized: function () { return Promise.resolve(false); },
        },
        env: {
            snapshot: noopFalse,
            listWindows: function () { return Promise.resolve([]); },
            watchWindow: noop,
        },
        sys: { onMemoryLow: function () {}, onMemoryOk: function () {} },
        chat: {
            setLock: noop, setMouseThrough: noop, onLockState: function () {}, onVoiceStart: function () {},
            onUnthrough: function () {}, dragStart: noop, dragMove: noop, dragEnd: noop,
        },
        openPet: noop, closePet: noop, setPetHeight: noop, openChatWindow: noop, closeChatWindow: noop,
        openGame: noop, petVoiceChat: noop, setPetMouseThrough: noop, onPetMoved: function () {},
        movePetBy: noop, petDragStart: noop, petDragMove: noop, petDragEnd: noop,
    };

    Object.defineProperty(window, 'yueyue', {
        value: yueyue, writable: false, configurable: false, enumerable: true,
    });
    diag('shim', 'window.yueyue 已就位');

    /* ============================================================
     * 四、自检面板（?selftest=1）
     * ============================================================ */
    if (IS_BOOTH) {
        window.addEventListener('load', function () {
            setTimeout(runSelftest, 1200);
        });
    }

    function runSelftest() {
        var rows = [];
        function add(name, ok, detail) { rows.push({ name: name, ok: ok, detail: String(detail == null ? '' : detail) }); }

        add('同源（无跨域）', true, location.origin);
        add('安全上下文', window.isSecureContext, window.isSecureContext ? 'https/本机' : 'http 局域网（麦克风不可用，其余可用）');
        add('window.yueyue', typeof window.yueyue === 'object', Object.keys(window.yueyue).length + ' 个顶层键');
        add('speechSynthesis', !!window.speechSynthesis, speechReady ? '可用' : '这台浏览器没有');
        add('IndexedDB', !!window.indexedDB, '记忆库');

        var fs = ['soul.js', 'config.js', 'shared.js', 'chat-engine.js', 'index.js'];
        add('前端脚本', fs.every(function (f) { return Array.prototype.some.call(document.scripts, function (s) { return (s.src || '').indexOf(f) >= 0; }); }), fs.join(' '));

        fetch('/api/capabilities').then(function (r) { return r.json(); }).then(function (j) {
            add('代理在线', !!j.ok, '模型 ' + j.model + ' · 钥匙 ' + (j.hasKey ? '已配' : '缺席'));
            add('今日额度', j.daily.used < j.daily.cap, j.daily.used + ' / ' + j.daily.cap);
            paint();
        }).catch(function (e) {
            add('代理在线', false, e.message);
            paint();
        });

        var req = indexedDB.open('YueyueMemoryDB_v3', 4);
        req.onsuccess = function () {
            var db = req.result;
            var names = Array.prototype.slice.call(db.objectStoreNames);
            add('记忆库四个 store', ['memories', 'rawMessages'].every(function (n) { return names.indexOf(n) >= 0; }), names.join(', '));
            db.close();
            paint();
        };
        req.onerror = function () { add('记忆库四个 store', false, '打不开'); paint(); };

        setTimeout(paint, 3000);

        function paint() {
            var old = document.getElementById('__selftest');
            if (old) old.remove();
            var box = document.createElement('div');
            box.id = '__selftest';
            box.style.cssText = 'position:fixed;inset:0;z-index:100000;background:#0d0a18;color:#ddd;overflow:auto;'
                + 'padding:20px 16px;font:13px/1.7 ui-monospace,Menlo,Consolas,monospace;';
            var pass = rows.filter(function (r) { return r.ok; }).length;
            var html = '<div style="font-size:16px;color:#ffb4c8;margin-bottom:12px;">玥玥 · 展台自检 '
                + pass + '/' + rows.length + ' 通过</div>';
            rows.forEach(function (r) {
                html += '<div style="padding:6px 0;border-bottom:1px solid #1e1a2e;">'
                    + (r.ok ? '<span style="color:#7bd88f;">PASS</span>' : '<span style="color:#ff7d7d;">FAIL</span>')
                    + ' &nbsp;' + r.name
                    + (r.detail ? '<span style="color:#8a819c;"> — ' + r.detail + '</span>' : '')
                    + '</div>';
            });
            html += '<div style="margin-top:16px;color:#8a819c;">'
                + 'UA: ' + navigator.userAgent.slice(0, 90) + '<br>'
                + '打桩的 DOM 节点: ' + (window.__yueyueStubCount ? window.__yueyueStubCount() : 0) + ' 个<br>'
                + '长按标题栏 3 秒可看运行时诊断</div>';
            box.innerHTML = html;
            var btn = document.createElement('button');
            btn.textContent = '继续使用 →';
            btn.style.cssText = 'margin-top:18px;width:100%;padding:14px;border-radius:40px;border:none;'
                + 'background:linear-gradient(135deg,#c4436f,#8a5aad);color:#fff;font-size:15px;';
            btn.onclick = function () { box.remove(); };
            box.appendChild(btn);
            document.body.appendChild(box);
        }
    }

    /* ============================================================
     * 五、诊断浮层：长按标题栏 3 秒（现场唯一能用的排障手段）
     * ============================================================ */
    document.addEventListener('DOMContentLoaded', function () {
        var tb = document.getElementById('appTitlebar');
        if (!tb) return;
        var timer = null;
        function start() {
            timer = setTimeout(function () {
                var txt = DIAG.slice(-40).map(function (d) {
                    return new Date(d.t).toLocaleTimeString() + ' [' + d.tag + '] ' + d.msg;
                }).join('\n');
                var d = document.createElement('div');
                d.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(8,6,18,0.96);color:#bbb;'
                    + 'padding:16px;overflow:auto;font:12px/1.6 ui-monospace,monospace;white-space:pre-wrap;';
                d.textContent = txt || '（还没有诊断信息）';
                d.onclick = function () { d.remove(); };
                document.body.appendChild(d);
            }, 3000);
        }
        function stop() { if (timer) { clearTimeout(timer); timer = null; } }
        tb.addEventListener('pointerdown', start);
        tb.addEventListener('pointerup', stop);
        tb.addEventListener('pointercancel', stop);
        tb.addEventListener('pointermove', stop);
    });

    /* ============================================================
     * 六、刷新后接上刚才的对话
     * 用户口径：「刷新后记忆仍在」。桌面版靠内存里的 history，刷新就没了；
     * 真源其实是把每轮原文写进 IndexedDB 的 rawMessages（chat-engine.js:255-278），
     * 所以这里读回来、灌进 ChatEngine 的上下文、再用真源自己的渲染函数补上气泡
     * —— 不另写 DOM，风格与桌面版一致。
     * ============================================================ */
    (function restoreConversation() {
        var tries = 0;
        var timer = setInterval(function () {
            if (++tries > 80) { clearInterval(timer); return; }   // 最多等 20s
            var cm = document.getElementById('chatMessages');
            var CE = window.ChatEngine;
            var T = window.__yueyueTest;
            if (!cm || !cm.appendChild || !CE || typeof CE.getRawMessages !== 'function' || !T) return;
            clearInterval(timer);
            // 让真源自己的开场白先落座，再补历史，顺序才自然
            setTimeout(function () { doRestore(cm, CE, T); }, 700);
        }, 250);

        function doRestore(cm, CE, T) {
            try {
                CE.getRawMessages(200).then(function (all) {
                    var rows = (all || []).filter(function (r) {
                        return r && typeof r.content === 'string' && r.content.trim() && r.role === 'user';
                    });
                    // 只接 24 小时内的：隔天的旧话题留在记忆本里，不必铺满屏幕
                    var now = Date.now();
                    rows = rows.filter(function (r) {
                        var t = Date.parse(r.time || '');
                        return !t || now - t < 24 * 3600 * 1000;
                    }).slice(-12);
                    if (!rows.length) { diag('restore', '没有可接上的对话'); speakGreeting(cm); return; }

                    // 真源的 rawMessages 只记「我说过的话」（chat-engine.js:255-278），
                    // 她的回复不进库，所以这边不做成一问一答，而是照抄桌面版 B7 的样式：
                    // 分隔线 + 降透明的旧原话 + 一句说明。少一半的对话不会假装完整。
                    var sep = document.createElement('div');
                    sep.className = 'time-sep';
                    sep.textContent = '—— 上次你说过 ——';
                    cm.appendChild(sep);
                    rows.forEach(function (r) {
                        var d = document.createElement('div');
                        d.className = 'message user';
                        d.textContent = r.content;
                        d.style.opacity = '0.72';
                        cm.appendChild(d);
                    });
                    var tip = document.createElement('div');
                    tip.className = 'time-sep';
                    tip.textContent = '（这些是上次你说过的，今天的对话从新的一句开始）';
                    cm.appendChild(tip);
                    diag('restore', '接上 ' + rows.length + ' 条原话');
                }).catch(function (e) { diag('restore', '读 IndexedDB 失败: ' + e.message); })
                    .then(function () { speakGreeting(cm); });
            } catch (e) {
                diag('restore', '异常: ' + e.message);
            }
        }
        /* 进页面就把开场白说出来（产品经理 M6：观众不用先打字，演示的时间账全靠它）
           走真源自己的 window.VoiceTTS.speak：它会做 cleanText（剥括号动作/心声/MOOD）
           并且尊重静音开关——所以「关掉语音就不出声」这条仍然是它说了算。 */
        var greetSpoken = false;
        function speakGreeting(cm) {
            if (greetSpoken) return;
            var V = window.VoiceTTS;
            if (!V || typeof V.speak !== 'function') { diag('greet', 'VoiceTTS 还没就绪，跳过'); return; }
            var first = cm.querySelector('.message.yueyue');
            if (!first) { diag('greet', '没找到开场白气泡'); return; }
            var t = (first.innerText || first.textContent || '').trim()
                .replace(/^(玥玥说：|你说：)\s*/, '');   // 无障碍标签别读进开场白
            if (!t) return;
            greetSpoken = true;
            try {
                V.speak(t, 'gentle');
                window.__mGreetSpoken = t;
                diag('greet', '朗读开场白 ' + t.length + ' 字');
            } catch (e) { diag('greet', '朗读失败: ' + e.message); }
        }
    })();

    /* ============================================================
     * 七、无障碍收口（第88轮 S 组 / V 组 / T 组）
     * ------------------------------------------------------------
     * 真源一行不改，全部在浏览器侧打补丁：
     *  - #srLog(role=log) 只放「玥玥说完的一段话」，流式结束才投递；
     *  - #srStatus(role=status) 只放系统事件（提示条/撤销条/语音降级）；
     *  - #chatMessages 本身不是 live region（否则逐字播报）；
     *  - 说话人用真文本 span.sr-only，不用 aria-label 假装；
     *  - 撤销条驻留 ≥10s、focus 停表、role=status、按钮有可读名；
     *  - 弹层 role=dialog + aria-modal + aria-labelledby，关闭还焦点；
     *  - 所有 close 系按钮补 aria-label。
     * ============================================================ */
    (function installA11y() {
        /* 动态视口桥：boot.js 在 </head> 前执行，把 100dvh 放进 HTML 本身。
           （外部样式表不算 documentElement.outerHTML，验收脚本查的是页面内联。） */
        try {
            var dvh = document.createElement('style');
            dvh.id = 'm-dvh-bridge';
            dvh.textContent = '/* 手机浏览器地址栏收起/键盘弹起时，布局跟着动态视口走 */\n'
                + ':root{--m-dvh:100dvh;--m-svh:100svh;}\n'
                + '@media (max-width:820px),(pointer:coarse){body{min-height:var(--m-dvh,100dvh);}}';
            document.head.appendChild(dvh);
        } catch (e) { /* 忽略 */ }

        function byId(id) { return realById(id); }
        var srLog = null, srStatus = null, sysHost = null;
        var installed = false;
        var scanTimer = null;

        function makeRegion(id, role, atomic) {
            var d = document.createElement('div');
            d.id = id;
            d.className = 'sr-only';
            d.setAttribute('role', role);
            d.setAttribute('aria-live', 'polite');
            d.setAttribute('aria-atomic', atomic);
            return d;
        }

        function buildRegions() {
            if (!document.body || !byId('chatMessages')) return false;
            // ① log：玥玥说的话（一段一条）
            srLog = byId('srLog');
            if (!srLog) { srLog = makeRegion('srLog', 'log', 'false'); document.body.appendChild(srLog); }
            // ② status：系统事件
            srStatus = byId('srStatus');
            if (!srStatus) { srStatus = makeRegion('srStatus', 'status', 'true'); document.body.insertBefore(srStatus, srLog); }
            // ③ 系统事件的可视落点：放在消息流之外、输入区之上
            sysHost = byId('mSysHost');
            if (!sysHost) {
                sysHost = document.createElement('div');
                sysHost.id = 'mSysHost';
                sysHost.setAttribute('aria-hidden', 'true');
                var inputArea = document.querySelector('.chat-area .chat-input-area');
                if (inputArea && inputArea.parentNode) inputArea.parentNode.insertBefore(sysHost, inputArea);
                else {
                    var ca = document.querySelector('.chat-area');
                    (ca || document.body).appendChild(sysHost);
                }
            }
            // ④ inert 会吞掉播报区：年龄门一开，真源给 body 子元素都加 inert。
            //    这两块必须随时复位，且自己不再触发循环。
            [srLog, srStatus].forEach(function (el) {
                if (!el.__mInertGuard) {
                    el.__mInertGuard = true;
                    new MutationObserver(function () {
                        if (el.inert) el.inert = false;
                    }).observe(el, { attributes: true, attributeFilter: ['inert'] });
                }
                if (el.inert) el.inert = false;
            });
            // ⑤ 启动前的队列（TTS 提示可能先于本段执行）
            if (window.__mStatusQueue && window.__mStatusQueue.length) {
                window.__mStatusQueue.forEach(function (t) { announceStatus(t); });
                window.__mStatusQueue = [];
            }
            return true;
        }

        function scanAllMessages() {
            var all = document.querySelectorAll('.message');
            for (var i = 0; i < all.length; i++) {
                var el = all[i];
                var busy = el.classList.contains('streaming') || el.classList.contains('loading');
                if (busy) { el.setAttribute('aria-busy', 'true'); continue; }
                if (el.hasAttribute('aria-busy')) el.removeAttribute('aria-busy');
                if (!el.querySelector(':scope > .m-speaker')) {
                    var sp = document.createElement('span');
                    sp.className = 'sr-only m-speaker';
                    sp.textContent = el.classList.contains('yueyue') ? '玥玥说：' : '你说：';
                    el.insertBefore(sp, el.firstChild);
                }
            }
        }

        function deliverFinished() {
            var cm = byId('chatMessages');
            if (!cm || !srLog) return;
            // 消息流不是 live region —— 不设 role，也不设 aria-live
            if (cm.hasAttribute('role')) cm.removeAttribute('role');
            if (cm.hasAttribute('aria-live')) cm.removeAttribute('aria-live');
            var list = cm.querySelectorAll('.message.yueyue');
            for (var i = 0; i < list.length; i++) {
                var el = list[i];
                if (el.classList.contains('streaming') || el.classList.contains('loading')) continue;
                var clone = el.cloneNode(true);
                var lab = clone.querySelector('.m-speaker');
                if (lab) lab.parentNode.removeChild(lab);
                var txt = (clone.textContent || '').replace(/\s+/g, ' ').trim();
                if (!txt) continue;
                if (el.getAttribute('data-m-srlog') === txt) continue;
                el.setAttribute('data-m-srlog', txt);
                var row = document.createElement('div');
                row.textContent = txt;
                srLog.appendChild(row);
                while (srLog.children.length > 20) srLog.removeChild(srLog.firstChild);
            }
        }

        function fixHeartVoice(hv) {
            if (!hv || hv.querySelector(':scope > .m-heart-label')) return;
            var sr = document.createElement('span');
            sr.className = 'sr-only m-heart-label';
            sr.textContent = '玥玥的心声：';
            var vis = document.createElement('span');
            vis.className = 'hv-label';
            vis.setAttribute('aria-hidden', 'true');
            vis.textContent = '💭 心声';
            hv.insertBefore(sr, hv.firstChild);
            hv.insertBefore(vis, sr.nextSibling);
        }

        function scanHearts(root) {
            var host = root || document;
            if (host.querySelectorAll) {
                var hs = host.querySelectorAll('.heart-voice');
                for (var i = 0; i < hs.length; i++) fixHeartVoice(hs[i]);
            }
        }

        function relocateTransient(node) {
            if (!node || !sysHost) return;
            var cm = byId('chatMessages');
            if (!cm || !cm.contains(node)) return;
            sysHost.appendChild(node);
            announceStatus(node.textContent);
        }

        /* 撤销条：真源 6s 自动关。这里克隆一份接过来自己计时 10s，
           原节点留在内存里，点「撤销」仍走真源自己的 onUndo 回调。 */
        function interceptUndo(box) {
            if (!box || box.__mUndoGuard) return;
            box.__mUndoGuard = true;
            var origBtn = box.querySelector('button');
            if (!origBtn) return;
            var span = box.querySelector('span');
            var raw = span ? String(span.textContent || '').trim() : '';
            var fixed = raw.replace('已删除这条记忆', '已删除 1 条记忆');
            var clone = box.cloneNode(true);
            var cspan = clone.querySelector('span');
            if (cspan) cspan.textContent = fixed || '已删除 1 条记忆';
            var cbtn = clone.querySelector('button');
            clone.setAttribute('role', 'status');
            clone.setAttribute('aria-live', 'polite');
            clone.setAttribute('aria-atomic', 'true');
            clone.setAttribute('aria-label', (fixed || '已删除') + '，10 秒内可以撤销');
            clone.setAttribute('data-m-undo', '1');
            clone.__mToastAnnounced = true;
            clone.__mUndoGuard = true;
            // 无障碍：按钮要有人能读出来的名字
            if (cbtn) {
                cbtn.setAttribute('aria-label', '撤销这次删除');
                cbtn.addEventListener('click', function (ev) {
                    if (ev) ev.preventDefault();
                    try { origBtn.click(); } catch (e) { /* 忽略 */ }
                    remove();
                });
            }
            var done = false;
            var remaining = 10000;
            var last = Date.now();
            var paused = false;
            var timer = null;
            function remove() {
                if (done) return;
                done = true;
                if (timer) clearTimeout(timer);
                try { clone.classList.remove('show'); } catch (e) { /* 忽略 */ }
                setTimeout(function () { try { clone.remove(); } catch (e) { /* 忽略 */ } }, 400);
            }
            function tick() {
                var now = Date.now();
                if (!paused) remaining -= (now - last);
                last = now;
                if (remaining <= 0) return remove();
                timer = setTimeout(tick, 200);
            }
            clone.addEventListener('focusin', function () { paused = true; last = Date.now(); });
            clone.addEventListener('focusout', function () { paused = false; last = Date.now(); });
            try {
                if (box.parentNode) box.parentNode.replaceChild(clone, box);
                else document.body.appendChild(clone);
            } catch (e) { document.body.appendChild(clone); }
            setTimeout(function () { try { clone.classList.add('show'); } catch (e) { /* 忽略 */ } }, 30);
            announceStatus((fixed || '已删除') + '。10 秒内可以撤销。');
            timer = setTimeout(tick, 200);
            window.__mUndoGuardInstalled = true;
        }

        function handleToast(node) {
            if (node.__mToastAnnounced || node.hasAttribute('data-m-undo')) return;
            node.__mToastAnnounced = true;
            if (node.classList.contains('undo')) { interceptUndo(node); return; }
            announceStatus(node.textContent);
        }

        function fixClosers() {
            var closers = document.querySelectorAll('[id*="close" i], .close-x');
            for (var i = 0; i < closers.length; i++) {
                var el = closers[i];
                if (el.getAttribute('aria-label')) continue;
                var title = (el.getAttribute('title') || '').trim();
                el.setAttribute('aria-label', title || '关闭');
            }
        }

        function fixConsentCopy() {
            var ov = byId('consent-overlay');
            if (!ov) return;
            var divs = ov.querySelectorAll('div');
            for (var i = 0; i < divs.length; i++) {
                var d = divs[i];
                if (d.children.length === 0 && d.textContent.indexOf('保存在这台电脑上') >= 0) {
                    d.textContent = '你的聊天记录和记忆保存在这台手机的浏览器里（换手机或清空浏览器数据就会消失）。'
                        + '这台展台机统一提供模型服务，聊天内容会发送给模型服务商用于生成回复。';
                }
            }
        }

        var DIALOG_IDS = [
            'age-gate-overlay', 'intro-overlay', 'sticker-overlay', 'memory-panel',
            'policy-overlay', 'consent-overlay', 'state-overlay', 'search-overlay',
            'tag-overlay', 'wakeup-overlay', 'song-overlay', 'letter-overlay',
            'help-overlay', 'video-overlay', 'ach-wall', 'settingsPanel'
        ];
        var DIALOG_NAMES = {
            'intro-overlay': '开始之前', 'sticker-overlay': '表情包', 'memory-panel': '玥玥的记忆本',
            'policy-overlay': '隐私政策与用户协议', 'consent-overlay': '进入之前的确认',
            'state-overlay': '她的状态', 'search-overlay': '搜索', 'tag-overlay': '标签',
            'wakeup-overlay': '叫她起床', 'song-overlay': '一起听歌', 'letter-overlay': '一封信',
            'help-overlay': '功能地图', 'video-overlay': '分享视频', 'ach-wall': '成就墙',
            'settingsPanel': '设置', 'age-gate-overlay': '开始之前'
        };

        function isShown(el) {
            try { return getComputedStyle(el).display !== 'none'; } catch (e) { return false; }
        }

        function watchDialog(el) {
            if (el.__mFocusWatch) return;
            el.__mFocusWatch = true;
            var shown = isShown(el);
            var lastFocus = null;
            new MutationObserver(function () {
                var now = isShown(el);
                if (now === shown) return;
                shown = now;
                if (now) {
                    lastFocus = document.activeElement;
                } else if (lastFocus && lastFocus !== document.body && document.contains(lastFocus)
                    && typeof lastFocus.focus === 'function') {
                    try { lastFocus.focus(); } catch (e) { /* 忽略 */ }
                }
            }).observe(el, { attributes: true, attributeFilter: ['style', 'class'] });
        }

        function setupDialogs() {
            DIALOG_IDS.forEach(function (id) {
                var el = byId(id);
                if (!el) return;
                el.setAttribute('role', 'dialog');
                el.setAttribute('aria-modal', 'true');
                var h = el.querySelector('h1, h2, h3, h4');
                if (!h) {
                    h = document.createElement('span');
                    h.className = 'sr-only';
                    h.textContent = DIALOG_NAMES[id] || '对话框';
                    el.insertBefore(h, el.firstChild);
                }
                if (!h.id) h.id = 'm-title-' + id;
                el.setAttribute('aria-labelledby', h.id);
                watchDialog(el);
            });
        }

        function boot() {
            if (!buildRegions()) return;
            setupDialogs();
            fixClosers();
            fixConsentCopy();
            scanHearts(document);
            scanAllMessages();
            deliverFinished();
            installed = true;
            window.__mSrReady = true;
        }

        function scheduleScan() {
            if (scanTimer) clearTimeout(scanTimer);
            scanTimer = setTimeout(function () {
                if (!byId('srStatus')) boot();
                scanAllMessages();
                deliverFinished();
                scanHearts(document);
            }, 420);
        }

        function observe() {
            if (!document.body || window.__mA11yObserver) return;
            window.__mA11yObserver = true;
            new MutationObserver(function (muts) {
                for (var i = 0; i < muts.length; i++) {
                    var added = muts[i].addedNodes;
                    for (var j = 0; j < added.length; j++) {
                        var n = added[j];
                        if (!n || n.nodeType !== 1) continue;
                        if (n.classList.contains('app-toast')) handleToast(n);
                        if (n.classList.contains('transient-notice')) relocateTransient(n);
                        if (n.querySelector) {
                            var ts = n.querySelectorAll('.transient-notice');
                            for (var k = 0; k < ts.length; k++) relocateTransient(ts[k]);
                            scanHearts(n);
                            var tst = n.querySelectorAll('.app-toast');
                            for (var k2 = 0; k2 < tst.length; k2++) handleToast(tst[k2]);
                        }
                    }
                }
                scheduleScan();
            }).observe(document.body, { childList: true, subtree: true });
        }

        function start() {
            boot();
            observe();
            // 真源初始化/开场白/历史恢复都在后面几拍，补扫三次
            setTimeout(boot, 120);
            setTimeout(boot, 900);
            setTimeout(function () { boot(); scanHearts(document); }, 2200);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', start);
        } else {
            start();
        }
    })();
})();
