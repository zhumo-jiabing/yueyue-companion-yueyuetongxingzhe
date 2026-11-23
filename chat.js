// 聊天窗口逻辑(与主窗口同步同一段对话)
(function () {
    const chatMessages = document.getElementById('chatMessages');
    const userInput = document.getElementById('userInput');
    // W4 2026-11-19: 自适应 textarea（1–3 行），Enter 发送 / Shift+Enter 换行
    const INPUT_MIN_H = 38, INPUT_MAX_H = 104;
    function autoGrowInput() {
        if (!userInput || userInput.tagName !== 'TEXTAREA') return;
        if (!userInput.value) { resetInputHeight(); return; }
        userInput.style.height = 'auto';
        const h = Math.max(INPUT_MIN_H, Math.min(userInput.scrollHeight + 2, INPUT_MAX_H));
        userInput.style.height = h + 'px';
        userInput.style.overflowY = userInput.scrollHeight > INPUT_MAX_H ? 'auto' : 'hidden';
    }
    function resetInputHeight() {
        if (!userInput || userInput.tagName !== 'TEXTAREA') return;
        userInput.style.height = INPUT_MIN_H + 'px';
        userInput.style.overflowY = 'hidden';
    }
    if (userInput) {
        userInput.addEventListener('input', autoGrowInput);
        resetInputHeight();
    }
    const sendBtn = document.getElementById('sendBtn');
    const voiceToggle = document.getElementById('voiceToggle');
    const ttsStatus = document.getElementById('ttsStatus');
    let sending = false;
    // t5 方案3: 本窗活跃流引用(跨窗打断时 kill, 防 onDone 补读复活旧流)
    let activeStreamTTS = null;
    let activeStreamStartedAt = 0;

    const DEEP_WAITING_LINES = [
        '她正逐字逐句地读你的话…',
        '她在心里反复琢磨你的每一句话…',
        '她托着下巴，认真想该怎么回应你…',
        '她正在组织最想对你说的真心话…',
        '她不想敷衍你，每个字都要仔细想…',
        '再等一下，她想把最好的回答留给你…',
    ];

    function scrollBottom() { chatMessages.scrollTop = chatMessages.scrollHeight; }

    function refreshVoiceToggle() {
        const on = VoiceTTS.isOn();
        voiceToggle.textContent = on ? '🔊' : '🔇';
        voiceToggle.classList.toggle('active', on);
        voiceToggle.title = on ? '语音输出 已开启' : '语音输出 已关闭';
    }
    VoiceTTS.setStatusListener((text) => {
        if (!ttsStatus) return;
        if (text) {
            ttsStatus.classList.add('show');
            ttsStatus.innerHTML = '<span class="dot"></span>';
            ttsStatus.appendChild(document.createTextNode(text));
        } else {
            ttsStatus.classList.remove('show');
            ttsStatus.textContent = '';
        }
    });

    // ---------- 穿透锁定(弹幕助手式) + 透明档位 ----------
    const lockBtn = document.getElementById('chatLockBtn');
    const alphaBtn = document.getElementById('chatAlphaBtn');
    const unlockBar = document.getElementById('chatUnlockBar');
    const lockBadge = document.getElementById('chatLockBadge');
    let chatLocked = false;
    const ALPHAS = [0.8, 0.6, 0.42];
    let ai = 0;
    let savedAlpha = 0.8;
    function applyAlphaRaw(v) {
        document.documentElement.style.setProperty('--chat-alpha', String(v));
        alphaBtn.title = '透明度 ' + Math.round(v * 100) + '%（点击切换 80% / 60% / 42%）';
    }
    function applyAlpha() {
        savedAlpha = ALPHAS[ai];
        applyAlphaRaw(chatLocked ? ALPHAS[ALPHAS.length - 1] : savedAlpha);
        try { localStorage.setItem('yueyue_chat_alpha', String(savedAlpha)); } catch (e) { /* 忽略 */ }
    }
    function setLocked(v) {
        chatLocked = !!v;
        if (lockBtn) lockBtn.textContent = chatLocked ? '🔒' : '🔓';
        if (lockBtn) lockBtn.title = chatLocked ? '已穿透锁定: 点击穿过窗口不挡游戏; 按 Ctrl+Alt+L 解锁' : '点击开启穿透锁定(不挡游戏画面, 像直播助手弹幕窗)';
        if (unlockBar) unlockBar.style.display = chatLocked ? 'flex' : 'none';
        if (lockBadge) lockBadge.style.display = chatLocked ? 'block' : 'none';
        applyAlphaRaw(chatLocked ? ALPHAS[ALPHAS.length - 1] : savedAlpha);
        try { window.yueyue.chat.setLock(chatLocked); } catch (e) { /* 忽略 */ }
        lastThrough = null; // 解锁后强制重新计算智能穿透状态
    }
    if (lockBtn) lockBtn.addEventListener('click', () => setLocked(!chatLocked));
    // 复核修复: 锁定/解锁时清掉挂起的智能穿透计时器, 避免解锁后残留 __mouseThrough=true
    const clearThroughWait = () => { if (throughWait) { clearTimeout(throughWait); throughWait = null; } };
    if (lockBtn) lockBtn.addEventListener('click', clearThroughWait);
    // 主进程全局快捷键 Ctrl+Alt+L 锁定/解锁
    try { window.yueyue.chat.onLockState((v) => setLocked(v)); } catch (e) { /* 忽略 */ }
    const closeBtn = document.getElementById('chatCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', () => { try { window.yueyue.closeChatWindow(); } catch (e) { /* 忽略 */ } });
    // 宠物 🎤 触发的语音启动(主进程在窗口加载完成后转发, 避免广播消息丢失)
    try { window.yueyue.chat.onVoiceStart(() => { try { VoiceInput.toggleOnce(); } catch (e) { /* 忽略 */ } }); } catch (e) { /* 忽略 */ }
    if (alphaBtn) {
        try {
            const saved = parseFloat(localStorage.getItem('yueyue_chat_alpha') || '0.8');
            const idx = ALPHAS.indexOf(saved);
            ai = idx >= 0 ? idx : 0;
        } catch (e) { /* 忽略 */ }
        applyAlpha();
        alphaBtn.addEventListener('click', () => { ai = (ai + 1) % ALPHAS.length; applyAlpha(); });
    }

    // ---------- 智能鼠标穿透(拖动优先版): 指向任何控件/标题栏立即恢复交互; 只有停在空白区 0.8 秒以上才开启穿透 ----------
    let lastThrough = null;
    function applyThrough(through) {
        if (lastThrough === through) return;
        lastThrough = through;
        try { window.yueyue.chat.setMouseThrough(through); } catch (e) { /* 忽略 */ }
    }
    let throughWait = null;
    function onMoveThrottled(e) {
        if (chatLocked) return; // 锁定时整窗穿透由主进程统一管理, 不打架
        const t = e.target;
        const interactive = !!(t && t.closest && t.closest('.chat-head, .chat-input-area, #chatMessages .message, #chatMessages .heart-voice, #chatMessages .typing, #chatMessages .deep-badge, #chatMessages .deep-line, #chatMessages .date-sep, #ttsStatus, #micStatus'));
        if (interactive) {
            // 控件/标题栏: 立即恢复交互(拖动和点击永远可响应, 不再"容易拖不动")
            clearTimeout(throughWait);
            throughWait = null;
            applyThrough(false);
            return;
        }
        // 空白区: 停驻 0.8 秒才穿透(复核修复: 每次空白区 mousemove 都重置计时器=真"停驻"语义,
        // 原实现首次进入空白区后不再重置, 光标持续移动时穿透/解除以 0.8-1s 周期振荡, 穿透相位点击漏到下层)
        clearTimeout(throughWait);
        throughWait = setTimeout(() => { throughWait = null; applyThrough(true); }, 800);
    }
    document.addEventListener('mousemove', onMoveThrottled, { passive: true });
    // 2026-09-11 修复: 移除"出生即穿透"(setMouseThrough(true))——forward 转发的 mousemove 实测
    // 到不了渲染层, 出生即穿透会让第一次拖动永远失效(真机复现: 0 位移)。窗口从可交互起步,
    // 停在空白区 0.8s 才穿透; 主进程看门狗保证穿透后光标一动就恢复。
    try { window.yueyue.chat.onUnthrough(() => { lastThrough = null; throughWait = null; }); } catch (e) { /* 忽略 */ }

    // ---------- 2026-09-11 自绘拖动(替代 app-region:drag) ----------
    // transparent 无边框窗 + app-region:drag 在 Windows DWM 下会闪回(0,0)(宠物窗 09-10 已因此移除)。
    // 与宠物窗同款: 绝对光标锚点 + rAF 合并, 修"拖动闪到左上角/来回闪现"。
    (function setupChatDrag() {
        const head = document.querySelector('.chat-head');
        if (!head) return;
        let dragging = false, moved = false, lx = 0, ly = 0;
        let raf = null, pending = null;
        head.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button, .st')) return;
            if (e.button !== 0) return;
            dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
            pending = [e.screenX, e.screenY];
            try { head.setPointerCapture(e.pointerId); } catch (e2) { /* 忽略 */ }
            try { window.yueyue.chat.dragStart(e.screenX, e.screenY); } catch (e2) { /* 忽略 */ }
        });
        head.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - lx, dy = e.clientY - ly;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            moved = true;
            pending = [e.screenX, e.screenY];
            if (!raf) {
                raf = requestAnimationFrame(() => {
                    raf = null;
                    if (!dragging || !pending) return;
                    try { window.yueyue.chat.dragMove(pending[0], pending[1]); } catch (e2) { /* 忽略 */ }
                    pending = null;
                });
            }
        });
        const endDrag = () => {
            dragging = false;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            pending = null;
            try { window.yueyue.chat.dragEnd(); } catch (e2) { /* 忽略 */ }
            setTimeout(() => { moved = false; }, 150);
        };
        head.addEventListener('pointerup', endDrag);
        head.addEventListener('pointercancel', endDrag);
        head.addEventListener('click', (e) => {
            if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
        }, true);
    })();

    function renderYueyueBubble(el, text) {
        const parsed = Shared.extractHeartVoices(Shared.extractMood(String(text || '')).text);
        el.innerHTML = Shared.renderRich(parsed.text);
        parsed.voices.forEach((voice) => {
            const card = document.createElement('div');
            card.className = 'heart-voice';
            card.textContent = voice;
            el.insertAdjacentElement('afterend', card);
        });
        // 成就: 第一枚心声(小窗同样计数; 弹窗经同步到主窗展示)
        if (parsed.voices.length && window.Achievements) window.Achievements.checkFor('heartvoice');
    }

    function addMessageToUI(text, sender) {
        const nearBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80;
        const div = document.createElement('div');
        div.className = 'message ' + sender;
        if (sender === 'yueyue') renderYueyueBubble(div, text);
        else div.textContent = text;
        chatMessages.appendChild(div);
        const removed = Shared.trimMessageDom(chatMessages, 500);
        if (nearBottom) { scrollBottom(); }
        else if (removed > 0) { chatMessages.scrollTop = Math.max(0, chatMessages.scrollTop - removed); }
    }

    function addTypingBubble(deepChars) {
        const div = document.createElement('div');
        div.className = 'message yueyue loading';
        div.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
        chatMessages.appendChild(div);
        scrollBottom();
        if (deepChars > 0) {
            div.classList.add('deep-think');
            div.innerHTML = '<div class="deep-badge">🧠 深度共情中</div>' +
                '<div class="deep-line">她正在逐字读你的 ' + deepChars + ' 个字…</div>' +
                '<div class="typing"><span></span><span></span><span></span></div>';
            let idx = 0;
            div._deepTimer = setInterval(() => {
                idx = (idx + 1) % DEEP_WAITING_LINES.length;
                const line = div.querySelector('.deep-line');
                if (line) line.textContent = DEEP_WAITING_LINES[idx];
            }, 4000);
            div._deepCleanup = () => { clearInterval(div._deepTimer); };
        } else {
            div._thinkTimer = setTimeout(() => {
                if (div.classList.contains('loading')) {
                    div.innerHTML = '💭 正在思考中…';
                }
            }, 1500);
        }
        return div;
    }

    // 2026-09-12 合规补口(part6 §四「exit-intent 仅覆盖主窗」): 聊天小窗此前零实现——
    // 在小窗说"不要再说"不会触发退出机制。依据《人工智能拟人化互动服务管理暂行办法》:
    // 用户表达退出/停止时"立即停止交互、不得追问"。此处与主窗 index.js 同源同正则,
    // 共用同一个 sessionStorage 约束键(chat-engine.js 读取后注入"不追问"约束), 并广播主窗同步。
    // 2026-09-12 真机验证发现的口径缺口: 原正则的"不要(再)?说了"必须带句尾"了",
    // 于是最自然的祈使句「不要再说」/「别讲了」在主窗**也匹配不上**(part6 把小窗不触发只归因于 chat.js 缺失)。
    // 修法: 追加**整句锚定**的裸祈使分支(不要再说/别再说/别讲了/停/停止/退出/闭嘴/别问了, 允许尾部感叹标点),
    // 因为锚定在整句, "不要再说这个了"(换话题)依然不命中, 不会误伤。
    const EXIT_INTENT_RE = /(不要(再)?(说|讲|问|聊)了|别(再)?(说|讲|问|聊)了|先(不|别)聊了|不聊了|我不想聊了|让我(静静|一个人)|停止(互动|对话|聊天)|退出(互动|对话|聊天)|结束(对话|聊天)|你(先)?别(说话|出声)|安静(一点|会儿|一会))|^(不要(再)?(说|讲|问|聊)|别(再)?(说|讲|问|聊)|停|停止|退出|闭嘴|别问了)[\s！。~!.]*$/;
    function matchExitIntent(text) {
        const t = String(text || '').trim();
        if (!t || t.length > 40) return false; // 长句里出现这些词多半是别的话题
        return EXIT_INTENT_RE.test(t);
    }

    // 2026-09-12 用户拍板(长回复打断, 与主窗同款): 剩余朗读较长时弹二选一, 否则立即打断
    async function resolveVoiceInterrupt(ts) {
        let load = null;
        try { if (window.VoiceTTS && VoiceTTS.readingLoad) load = VoiceTTS.readingLoad(); } catch (e) { load = null; }
        let keepReading = false;
        if (load && load.long) {
            let choice = 'timeout';
            try {
                choice = await Shared.showChoice({
                    text: '她还在念上一条，大约还有 ' + load.remainMin + ' 分钟。\n要让她念完，还是现在就打断？',
                    okText: '让她念完',
                    cancelText: '现在就打断',
                    timeoutMs: 20000,
                });
            } catch (e) { choice = 'timeout'; }
            keepReading = (choice === 'ok');
            if (keepReading) addMessageToUI('（好，那让她先把这条念完。）', 'yueyue');
        }
        if (!keepReading) {
            try { if (window.VoiceTTS) VoiceTTS.interrupt(); } catch (e) { /* 忽略 */ }
            try { Shared.syncSend('voice-interrupt', { ts: ts }); } catch (e) { /* 跨窗: 主窗同步停播 */ }
        }
    }

    async function sendMessage() {
        const message = userInput.value.trim();
        if (!message || sending) return;
        sending = true;
        sendBtn.disabled = true;
        userInput.value = ''; resetInputHeight();
        // 2026-09-12 用户拍板: 长回复朗读中收到新消息 → 弹二选一(让她念完 / 现在就打断); 短回复保持立即打断
        await resolveVoiceInterrupt(Date.now());
        addMessageToUI(message, 'user');
        if (window.Achievements) window.Achievements.checkFor('chat_send', { text: message });
        try { if (window.YueyueAnalytics) YueyueAnalytics.trackChatSend(); } catch (e) { /* 埋点失败忽略 */ }

        // ---------- 2026-09-12 交互退出机制(合规, 补齐小窗缺口) ----------
        // 命中即**不再发起任何模型调用**(真正的"立即停止"), 给一条克制确认, 不追问、不挽留。
        if (matchExitIntent(message)) {
            try { sessionStorage.setItem('yueyue_exit_honored', '1'); } catch (e) { /* 忽略 */ }
            addMessageToUI('（她停下了，没有再问。）', 'yueyue');
            try { Shared.syncSend('exit-intent', { ts: Date.now() }); } catch (e) { /* 跨窗: 主窗同步停止交互 */ }
            sending = false;
            sendBtn.disabled = false;
            userInput.focus();
            return;
        }
        // 用户主动说别的事 -> 解除"刚被打断"的约束, 恢复正常
        try {
            if (sessionStorage.getItem('yueyue_exit_honored') === '1' && !matchExitIntent(message)) {
                sessionStorage.removeItem('yueyue_exit_honored');
            }
        } catch (e) { /* 忽略 */ }

        const deepChars = message.length >= (window.APP_CONFIG.DEEP_THINK ? window.APP_CONFIG.DEEP_THINK.LONG_CHARS : 40) ? message.length : 0;
        const bubble = addTypingBubble(deepChars);
        const streamTTS = VoiceTTS.makeStreamTTS();
        activeStreamTTS = streamTTS; activeStreamStartedAt = Date.now(); // t5 方案3

        await ChatEngine.send({
            text: message,
            onChunk: (delta, full) => {
                if (bubble._thinkTimer) { clearTimeout(bubble._thinkTimer); bubble._thinkTimer = null; }
                if (bubble._deepCleanup) { bubble._deepCleanup(); bubble._deepCleanup = null; }
                bubble.classList.remove('loading', 'deep-think');
                bubble.classList.add('streaming');
                bubble.textContent = full.split('[MOOD:')[0];
                if (window.Live2dBridge && !window._lv2dSpeaking) { window._lv2dSpeaking = true; window.Live2dBridge.speakStart(); }
                streamTTS.onChunk(full);
                if (chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 80) scrollBottom();
            },
            onDone: (full) => {
                if (bubble._deepCleanup) { bubble._deepCleanup(); bubble._deepCleanup = null; }
                bubble.classList.remove('loading', 'streaming', 'deep-think');
                const parsed = Shared.extractMood(full);
                renderYueyueBubble(bubble, parsed.text);
                if (window.Live2dBridge) window.Live2dBridge.setMood(parsed.mood || Shared.detectMood(parsed.text));
                if (window._lv2dSpeaking) { window._lv2dSpeaking = false; if (window.Live2dBridge) window.Live2dBridge.speakEnd(); }
                streamTTS.onDone(full);
                scrollBottom();
                if (window.Achievements) window.Achievements.checkFor('chat_done', { text: message, reply: full });
                Shared.syncSend('turns', {
                    turns: [
                        { role: 'user', content: message },
                        { role: 'assistant', content: full },
                    ],
                });
            },
            onError: (err) => {
                streamTTS.onError(err);
                if (window._lv2dSpeaking) { window._lv2dSpeaking = false; if (window.Live2dBridge) window.Live2dBridge.speakEnd(); }
                if (bubble._thinkTimer) { clearTimeout(bubble._thinkTimer); }
                if (bubble._deepCleanup) { bubble._deepCleanup(); }
                bubble.remove();
                if (String(err && err.message || '').indexOf('API Key') !== -1) {
                    addMessageToUI('🔑 你还没放一把钥匙进来——去主窗口右上角「⚙️ 设置」里填一下 API Key，放一把钥匙给她，她就能开口跟你说话了。', 'yueyue');
                } else if (/访问量过大|限流|rate.?limit|Too Many Requests/i.test(String(err && err.message || ''))) {
                    addMessageToUI('(´･ω･`) 请求异常:' + err.message + '\n💡 这是 GLM 免费档的限流（服务商侧的，不是她的错），稍等几十秒再发一次；如果频繁遇到，去「⚙️ 设置」换个模型档试试。', 'yueyue');
                } else {
                    addMessageToUI('(´･ω･`) 请求异常:' + err.message, 'yueyue');
                }
            },
        });

        sending = false;
        sendBtn.disabled = false;
        userInput.focus();
    }

    // ---------- 跨窗口同步: 接收主窗口的对话/关心/主动消息 ----------
    Shared.syncOn((d) => {
        if (d.type === 'turns') {
            (d.turns || []).forEach((t) => {
                if (t && t.content && t.content.trim()) {
                    addMessageToUI(t.content, t.role === 'user' ? 'user' : 'yueyue');
                    ChatEngine.mergeExternalTurns([{ role: t.role, content: t.content }]);
                }
            });
        } else if (d.type === 'said') {
            if (d.content && d.content.trim()) {
                addMessageToUI(d.content, 'yueyue');
                ChatEngine.mergeExternalTurns([{ role: 'assistant', content: d.content }]);
                if (window.Live2dBridge) window.Live2dBridge.setMood('concerned');
            }
        } else if (d.type === 'snapshot') {
            const turns = (d.turns || []).filter((t) => t && t.content && t.content.trim());
            if (turns.length) {
                turns.slice(-6).forEach((t) => addMessageToUI(t.content, t.role === 'user' ? 'user' : 'yueyue'));
                ChatEngine.mergeExternalTurns(turns);
            }
        } else if (d.type === 'env-state') {
            const app = String((d && d.app) || '').trim();
            const st = document.getElementById('headStatus');
            if (st) st.textContent = (app && app !== '无') ? ('👁 她在看：' + app.slice(0, 12)) : '💭 安静地陪着你';
        } else if (d.type === 'day-mode') {
            // 跟随主窗昼夜模式(true=白天, false=夜晚)
            applyDayClass(!!(d && d.day));
        } else if (d.type === 'exit-intent') {
            // 2026-09-12 合规: 主窗(或对窗)命中退出意图时, 本窗同步进入"不追问"约束并立即停声
            try { sessionStorage.setItem('yueyue_exit_honored', '1'); } catch (e) { /* 忽略 */ }
            try { if (window.VoiceTTS) VoiceTTS.interrupt(); } catch (e) { /* 忽略 */ }
        } else if (d.type === 'voice-interrupt') {
            // 跨窗语音打断(2026-09-11 政策): 主窗发新消息时, 本窗旧朗读同步停止; 活跃流一并 kill; voice-off 同步关开关
            try { if (window.VoiceTTS) VoiceTTS.interrupt(); } catch (e) { /* 忽略 */ }
            if (activeStreamTTS && (!d.ts || d.ts > activeStreamStartedAt)) { try { activeStreamTTS.kill(); } catch (e2) { /* 忽略 */ } }
            if (d.reason === 'voice-off') { try { VoiceTTS.setOn(false); } catch (e2) { /* 忽略 */ } refreshVoiceToggle(); }
        }
    });

    /* ===== 第十八轮(用户: "宠物聊天面板的背景还是需要修改白天模式") =====
       真因: chat.html 的整套白天主题变量挂在 **body.day** 上(见 chat.html 第 38-63 行),
       但这里一直在切 **body.night** —— 类名根本对不上, 所以聊天小窗永远停留在夜间配色
       (chat.html 里连一条 .night 规则都没有, 实测 grep 命中 0)。
       另外 applyTheme() 的默认值是"夜晚(true)", 主窗明明是白天, 小窗开局也还是黑的。
       现在统一: 一个 applyDayClass() 同时维护 day/night 两个类, 且优先跟随主窗的 yueyue_day_mode。 */
    function applyDayClass(isDay) {
        document.body.classList.toggle('day', !!isDay);
        document.body.classList.toggle('night', !isDay);
    }
    function applyTheme() {
        let isDay = false;
        try {
            const dm = localStorage.getItem('yueyue_day_mode');
            if (dm !== null) {
                isDay = dm === '1';                       // 优先跟随主窗昼夜设置
            } else {
                const v = localStorage.getItem('yueyue_chat_night');
                isDay = v === '0';                        // 兼容旧的独立开关
            }
        } catch (e) { /* 忽略 */ }
        applyDayClass(isDay);
    }
    applyTheme();

    (async function init() {
        await ChatEngine.init();
        const name = ChatEngine.getUserName();
        ChatEngine.start(name);
        addMessageToUI(name ? '(｡･ω･｡) 你来啦~' + name + '，今天想聊什么？' : '(｡･ω･｡) 你来啦~今天想聊什么？', 'yueyue'); // 第十二轮: 全角标点；第52轮: 没名字不硬塞称呼
        sendBtn.addEventListener('click', sendMessage);
        userInput.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || (window.Shared && window.Shared.isImeKey(e))) return;
            if (e.shiftKey) return; // W4: Shift+Enter 换行
            e.preventDefault();
            sendMessage();
        });
        voiceToggle.addEventListener('click', () => {
            const turningOff = VoiceTTS.isOn();
            VoiceTTS.setOn(!VoiceTTS.isOn());
            VoiceTTS.unlock();
            if (turningOff) { try { Shared.syncSend('voice-interrupt', { ts: Date.now(), reason: 'voice-off' }); } catch (e) { /* 跨窗: 主窗同步静音+图标(t5 方案4) */ } }
            refreshVoiceToggle();
        });
        refreshVoiceToggle();
        userInput.focus();
        Shared.syncSend('hello', {});

        // ---------- 语音输入(单次录音 + 待机感知) ----------
        try {
            // 2026-09-10 审计补充: 聊天小窗同步"停止朗读"按钮(主窗同款; 2026-09-11 起发新消息也会打断)
            const stopBtn = document.getElementById('btnStopVoice');
            if (stopBtn && window.VoiceTTS) {
                stopBtn.addEventListener('click', () => {
                    window.VoiceTTS.interrupt();
                    try { Shared.syncSend('voice-interrupt', { ts: Date.now() }); } catch (e) { /* 跨窗齐停(t5 方案4) */ }
                    stopBtn.style.display = 'none';
                });
                setInterval(() => {
                    const busy = window.VoiceTTS.isOn() && window.VoiceTTS.pendingCount() > 0;
                    stopBtn.style.display = busy ? '' : 'none';
                }, 600);
            }
            const micBtn = document.getElementById('micBtn');
            const micWaitBtn = document.getElementById('micWaitBtn');
            const micStatus = document.getElementById('micStatus');
            function setMicStatus(text, hot) {
                if (!micStatus) return;
                micStatus.textContent = text || '';
                micStatus.style.display = text ? 'block' : 'none';
                micStatus.style.color = hot ? '#ff9db8' : '#b9a5e8';
            }
            VoiceInput.onUtterance((text) => {
                const clean = String(text || '').trim();
                if (!clean) return;
                if (VoiceInput.isWaiting) {
                    userInput.value = clean; autoGrowInput();
                    sendMessage();
                } else {
                    userInput.value = clean; autoGrowInput();
                    userInput.focus();
                }
            });
            VoiceInput.onState((st) => {
                if (st.error) { setMicStatus('🎙 ' + st.error, true); setTimeout(() => setMicStatus(''), 4000); return; }
                if (st.busy) { setMicStatus('🧠 正在识别你说的话…', true); return; }
                if (st.recording) { setMicStatus('🎤 正在聆听…（再点一下结束）', true); return; }
                if (st.waiting) {
                    setMicStatus(st.listening ? '🎙 正在听你说…（自动识别）' : '🎙 语音待机感知 · 聆听中', false);
                    return;
                }
                setMicStatus('');
            });
            if (micBtn) micBtn.addEventListener('click', () => { try { VoiceInput.toggleOnce(); } catch (e) { /* 忽略 */ } });
            if (micWaitBtn) micWaitBtn.addEventListener('click', async () => {
                try {
                    const on = !VoiceInput.isWaiting;
                    const ok = await VoiceInput.setWaiting(on);
                    micWaitBtn.classList.toggle('active', ok && on);
                    if (ok && on) {
                        setMicStatus('⏳ 正在启动语音识别服务（首次约 10 秒）…', true);
                        try {
                            for (let i = 0; i < 12; i++) {
                                const r = await window.yueyue.stt.ready();
                                if (r && r.ready) break;
                                await new Promise((res) => setTimeout(res, 2000));
                            }
                        } catch (e2) { /* 忽略 */ }
                        setMicStatus('✅ 语音待机感知已开启 · 正在聆听（再点 🎙 关闭）', true);
                    }
                } catch (e) { /* 忽略 */ }
            });
            // 宠物气泡的 🎤 按钮 → 打开本窗并开始一次录音
            Shared.syncOn((d) => {
                if (d && d.type === 'voice-start') {
                    try { VoiceInput.toggleOnce(); } catch (e) { /* 忽略 */ }
                }
            });
        } catch (e) { /* 语音输入不可用时静默 */ }
    })();
})();
