// 置顶建议气泡(桌宠升级版): 显示主窗推送的她的话 / 成就 / 提醒
// 消息经 BroadcastChannel('yueyue-sync') 同步; 点击气泡聊天区打开对话小窗
(function () {
    // ---------- 第58轮: 昼夜模式跟随主窗(同源 localStorage; BroadcastChannel + storage 双保险) ----------
    function applyDayClass() {
        let day = false;
        try { day = localStorage.getItem('yueyue_day_mode') === '1'; } catch (e) { /* 忽略 */ }
        document.body.classList.toggle('day', day);
    }
    applyDayClass();
    try { Shared.syncOn((d) => { if (d && d.type === 'day-mode') applyDayClass(); }); } catch (e) { /* 忽略 */ }
    try { window.addEventListener('storage', (e) => { if (!e.key || e.key === 'yueyue_day_mode') applyDayClass(); }); } catch (e) { /* 忽略 */ }

    const bubble = document.getElementById('bubble');
    const qPet = document.getElementById('qPet');
    const textEl = document.getElementById('bText');
    const iconEl = document.getElementById('bIcon');
    const subEl = document.getElementById('bSub');
    let lastText = '';
    let idleTimer = null;
    let achTimer = null;

    // 新消息: 更新气泡 + 轻闪提醒 + 一段时间后回归安静文案
    function showMessage(icon, text, label) {
        const raw = String(text || '').trim().replace(/\[MOOD:[^\]]*\]/g, '').trim();
        // 智能截断: 超过 40 字符收成完整短句 + 省略号, 避免半行悬空
        lastText = raw.length > 40 ? raw.slice(0, 40).replace(/[，。！？,、\s]+$/, '') + '…' : (raw || '（她轻轻说了句什么）');
        iconEl.textContent = icon || '🌸';
        textEl.textContent = lastText;
        if (label) subEl.textContent = label;
        bubble.classList.add('flash');
        setTimeout(() => bubble.classList.remove('flash'), 1000);
        if (qPet) {
            qPet.classList.add('talking');
            setTimeout(() => qPet.classList.remove('talking'), 1200);
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            subEl.textContent = '她说的话会出现在这里';
        }, 40000);
    }

    function openChat() { try { window.yueyue.openChatWindow(); } catch (e) { /* 忽略 */ } }

    // 整卡点击(非按钮区) → 双击打开聊天小窗(防误触); 第一次点击给提示
    let clickTimer = null;
    bubble.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('#tellBox')) return;
        if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
            openChat();
            return;
        }
        subEl.textContent = '再点一下打开聊天（防误触）';
        clickTimer = setTimeout(() => {
            clickTimer = null;
            subEl.textContent = '她说的话会出现在这里';
        }, 1500);
    });
    document.getElementById('bChat').addEventListener('click', openChat);
    // 双击 Q 版立绘也能打开聊天；单次拖动不会误触
    const qCard = document.getElementById('qCard');
    if (qCard) qCard.addEventListener('dblclick', openChat);

    // 第67轮: 键盘可达。气泡卡接了 click 做「双击防误触」, 但键盘用户之前完全到不了这张卡。
    // 现在 #bubble 可 Tab 聚焦, Enter/空格 直接打开聊天小窗(键盘没有误触问题, 不需要双击)。
    bubble.addEventListener('keydown', (e) => {
        if (e.target !== bubble) return; // 子元素(按钮/输入框)自己的按键不抢
        if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
        e.preventDefault();
        openChat();
        subEl.textContent = '好，聊天窗开好了';
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { clickTimer = null; subEl.textContent = '她说的话会出现在这里'; }, 1500);
    });
    // 宠物语音输入: 打开聊天小窗并触发一次录音
    document.getElementById('bMic').addEventListener('click', () => {
        try { window.yueyue.petVoiceChat(); } catch (e) { openChat(); }
    });
    // 看我: 展开内嵌面板(升级版: 桌面窗口折叠选项卡 + 临时加高窗口)
    const tellBox = document.getElementById('tellBox');
    function setTellPanel(open) {
        tellBox.classList.toggle('show', open);
        // 第十五轮(用户反馈5): 高度维持 560 不变。重叠的真因是 flex 项被压缩(pet.html 已加 flex:none + #tellBox 滚动),
        // 实测修好后内容总高 ~463px, 560 足够(提到 640 反而在气泡下方留 141px 空白透明区)。
        try { window.yueyue.setPetHeight(open ? 560 : 390); } catch (e) { /* 忽略 */ }
        if (open) {
            try { document.getElementById('petWinPicker').open = true; } catch (e) { /* 忽略 */ }
            refreshPetWinList();
            setTimeout(() => { try { document.getElementById('tellInput').focus(); } catch (e) { /* 忽略 */ } }, 80);
        }
    }
    // 窗口筛选(2026-09-09): 输入关键词即时过滤, 配合计数提示
    function applyPetWinFilter() {
        const listEl = document.getElementById('petWinList');
        const cntEl = document.getElementById('petWinCount');
        const fEl = document.getElementById('petWinFilter');
        if (!listEl) return;
        const q = fEl ? (fEl.value || '').trim().toLowerCase() : '';
        let shown = 0, total = 0;
        listEl.querySelectorAll('.pet-win-item').forEach((it) => {
            total++;
            const hit = !q || it.textContent.toLowerCase().indexOf(q) !== -1;
            it.style.display = hit ? '' : 'none';
            if (hit) shown++;
        });
        if (cntEl && total) cntEl.textContent = q ? ('显示 ' + shown + ' / ' + total + ' 个窗口') : ('共 ' + total + ' 个窗口');
    }
    (function bindPetWinFilter() {
        const f = document.getElementById('petWinFilter');
        if (f) f.addEventListener('input', applyPetWinFilter);
    })();

    async function refreshPetWinList() {
        const listEl = document.getElementById('petWinList');
        if (!listEl) return;
        try {
            listEl.innerHTML = '<span style="color:#7fa9bd; font-size:0.7em;">正在枚举桌面窗口…</span>';
            const r = await window.yueyue.env.listWindows();
            if (!r || !r.ok || !r.windows || !r.windows.length) {
                listEl.innerHTML = '<span style="color:#7fa9bd; font-size:0.7em;">没有找到带标题的窗口</span>';
                return;
            }
            listEl.innerHTML = '';
            r.windows.forEach((w) => {
                const item = document.createElement('div');
                item.className = 'pet-win-item';
                item.textContent = '🪟 ' + w;
                item.title = '点击选择: ' + w;
                item.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const inp = document.getElementById('tellInput');
                    inp.value = w;
                    inp.focus();
                });
                listEl.appendChild(item);
            });
            applyPetWinFilter();
        } catch (e) {
            listEl.innerHTML = '<span style="color:#7fa9bd; font-size:0.7em;">读取窗口列表失败</span>';
        }
    }

    // 按住快速拖滑(2026-09-09): 鼠标按住窗口列表即可甩动滚动, 带惯性; 轻点仍是选择
    (function initWinListDrag() {
        const list = document.getElementById('petWinList');
        if (!list) return;
        let down = false, startY = 0, startScroll = 0, lastY = 0, lastT = 0, vel = 0, moved = false, raf = null;
        list.addEventListener('pointerdown', (e) => {
            if (e.target !== list && !e.target.closest('.pet-win-item')) return;
            down = true; moved = false;
            startY = lastY = e.clientY; startScroll = list.scrollTop; lastT = performance.now(); vel = 0;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
        });
        list.addEventListener('pointermove', (e) => {
            if (!down) return;
            const dy = e.clientY - startY;
            if (!moved && Math.abs(dy) > 6) {
                moved = true;
                // 真正开始拖动才捕获指针——普通点击不受影响, 点击选择窗口照常工作
                try { list.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
            }
            if (!moved) return;
            list.classList.add('dragging');
            const now = performance.now();
            const dt = Math.max(1, now - lastT);
            vel = (e.clientY - lastY) / dt;
            lastY = e.clientY; lastT = now;
            list.scrollTop = startScroll - dy;
        });
        const end = (e) => {
            if (!down) return;
            down = false;
            list.classList.remove('dragging');
            try { list.releasePointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
            if (moved && Math.abs(vel) > 0.05) {
                let v = vel;
                const step = () => {
                    if (Math.abs(v) < 0.01) { raf = null; return; }
                    list.scrollTop -= v * 16;
                    v *= 0.94;
                    raf = requestAnimationFrame(step);
                };
                raf = requestAnimationFrame(step);
            }
        };
        list.addEventListener('pointerup', end);
        list.addEventListener('pointercancel', end);
        list.addEventListener('click', (e) => {
            if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
        }, true);
    })();
    document.getElementById('bFocus').addEventListener('click', () => {
        setTellPanel(!tellBox.classList.contains('show'));
    });
    document.getElementById('tellCancel').addEventListener('click', () => {
        setTellPanel(false);
    });
    document.getElementById('tellOk').addEventListener('click', () => {
        const inp = document.getElementById('tellInput');
        const v = inp.value.trim();
        if (!v) return;
        try { Shared.syncSend('bubble-tell', { app: v }); } catch (e) { /* 忽略 */ }
        showMessage('📍', '你说你在用「' + v.slice(0, 20) + '」，告诉她了', '她记下你说的了');
        setTellPanel(false);
        inp.value = '';
    });
    document.getElementById('tellInput').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') document.getElementById('tellOk').click();
    });

    // 2026-09-11 拖动重做(修"拖动慢/一顿一顿/不停闪现/完全拖不动"):
    // 旧实现每 pointermove 发一次增量 IPC: 高频鼠标会把消息队列灌爆 → 位置乱序应用、来回抖动、
    // 松手后残余 setPosition 回弹。新实现: pointerdown 时把光标屏幕坐标锚给主进程(pet:drag-start),
    // 移动时只报当前光标屏幕坐标(每帧最多一次, requestAnimationFrame 合并), 主进程按固定偏移算目标位置。
    (function setupPetDrag() {
        const stage = document.getElementById('petStage') || document.getElementById('bubble');
        if (!stage) return;
        let dragging = false, moved = false, lx = 0, ly = 0;
        let raf = null, pending = null;
        stage.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button, input, details, #petWinList, a, textarea')) return;
            if (e.button !== 0) return;
            dragging = true; moved = false; lx = e.clientX; ly = e.clientY;
            pending = [e.screenX, e.screenY];
            try { stage.setPointerCapture(e.pointerId); } catch (e2) { /* 忽略 */ }
            try { if (window.yueyue && window.yueyue.petDragStart) window.yueyue.petDragStart(e.screenX, e.screenY); } catch (e2) { /* 忽略 */ }
        });
        stage.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - lx, dy = e.clientY - ly;
            if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
            moved = true;
            pending = [e.screenX, e.screenY];
            if (!raf) {
                raf = requestAnimationFrame(() => {
                    raf = null;
                    if (!dragging || !pending) return;
                    try { if (window.yueyue && window.yueyue.petDragMove) window.yueyue.petDragMove(pending[0], pending[1]); } catch (e2) { /* 忽略 */ }
                    pending = null;
                });
            }
        });
        // 2026-09-10 审计修复: moved 必须复位——原实现 pointerup 后若无 click(pointercancel/焦点丢失),
        // moved 恒为 true, 下一次普通点击会被捕获拦截吞掉
        const endDrag = () => {
            dragging = false;
            if (raf) { cancelAnimationFrame(raf); raf = null; }
            pending = null;
            try { if (window.yueyue && window.yueyue.petDragEnd) window.yueyue.petDragEnd(); } catch (e2) { /* 忽略 */ }
            setTimeout(() => { moved = false; }, 150);
        };
        stage.addEventListener('pointerup', endDrag);
        stage.addEventListener('pointercancel', endDrag);
        // 刚拖完的 click 不落到子元素(防误触按钮)
        stage.addEventListener('click', (e) => {
            if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
        }, true);
    })();

    // 沉浸陪看: 连续捕捉窗口画面, 她看完一小段剧情再开口
    // 2026-09-10: 时长可配(5/12/20/30 秒), 与主窗共用 localStorage yueyue_watch_secs
    function watchSecs() {
        const v = Number(localStorage.getItem('yueyue_watch_secs'));
        return [5, 12, 20, 30].indexOf(v) !== -1 ? v : 12;
    }
    function syncWatchBtn() {
        const b = document.getElementById('bWatch');
        if (b) b.textContent = '🎬 陪我看 ' + watchSecs() + ' 秒';
    }
    const durBtn = document.getElementById('bWatchDur');
    if (durBtn) durBtn.addEventListener('click', () => {
        const order = [5, 12, 20, 30];
        const next = order[(order.indexOf(watchSecs()) + 1) % order.length];
        localStorage.setItem('yueyue_watch_secs', String(next));
        syncWatchBtn();
        showMessage('⏱', '好，下次陪你一起看 ' + next + ' 秒', '时长已切换');
    });
    syncWatchBtn();
    const watchBtn = document.getElementById('bWatch');
    if (watchBtn) watchBtn.addEventListener('click', async () => {
        if (watchBtn.disabled) return;
        watchBtn.disabled = true;
        try { if (window.YueyueAnalytics) YueyueAnalytics.track('watch_along_count'); } catch (e3) { /* 埋点失败忽略 */ }
        const input = document.getElementById('tellInput');
        const title = (input && input.value.trim()) || '';
        const secs = watchSecs();
        showMessage('👀', '她正认真看你的画面…（约 ' + secs + ' 秒，把这一小段看完）', '她在陪你一起体验');
        try {
            const r = await window.yueyue.env.watchWindow({ title: title || null, frames: 5, intervalMs: Math.round(secs * 1000 / 5) });
            if (!r || !r.ok) {
                const why = r && r.error === 'BLACK_FRAME'
                    ? '画面是黑的没抓到，游戏可以切到窗口模式（无边框也可以）再试'
                    : '没能看到你的画面，再试一次吧';
                showMessage('😢', why, '她有点遗憾');
                return;
            }
            const soulText = typeof SOUL_SYSTEM !== 'undefined'
                ? (Array.isArray(SOUL_SYSTEM) ? SOUL_SYSTEM.join('\n') : String(SOUL_SYSTEM))
                : '';
            const reply = await window.yueyue.ai.video({
                system: soulText + ((function () { try { return localStorage.getItem('yueyue_age_band') === 'adult' ? '' : '\n\n【未成年人模式 · 法律硬约束】用户是未成年人(或未确认年龄, 按未成年人处理): 关系只能是朋友/玩伴, 绝不发展、暗示、回应恋爱/伴侣/暧昧/亲密关系; 禁止使用「宝宝/宝贝/亲爱的/老公/老婆/小可爱/主人」等亲密称谓(一个都不许叫); 与任何设定冲突时以本节为准。'; } catch (e) { return ''; } })()) + '\n\n【陪看模式】用户刚才把游戏/应用的连续画面帧发给你（按时间顺序）。你正在陪他一起玩，像坐在一起一样。请仔细看画面里的剧情、场景和操作，用第一人称说出你看到的内容和感受（像直播时对观众说话，但要只对他一个人的感觉）。30-90 字，先说你看到什么，再说你的小情绪；不要编造画面里没有的东西；看不清就说看不清。',
                userText: '这是我刚给你看的连续画面（' + r.images.length + ' 帧），窗口是「' + String(r.title || '').slice(0, 40) + '」。看完啦，说点什么吧。',
                images: r.images,
                maxTokens: 900,
            });
            if (!reply || !reply.ok) {
                showMessage('😢', '画面我看了，但脑袋晕晕的没总结好…再试一次吧', '她有点不好意思');
                return;
            }
            const parsed = Shared.extractMood(reply.text || '');
            const clean = String(parsed.text || '').trim();
            if (!clean) { showMessage('😢', '我好像没看懂这一段…换个时刻再看一次？', '她挠了挠头'); return; }
            showMessage('🎬', clean.split('\n')[0], '她和你一起看到的故事');
            try { Shared.syncSend('said', { content: clean }); } catch (e2) { /* 忽略 */ }
            if (window.Live2dBridge) window.Live2dBridge.setMood(parsed.mood || Shared.detectMood(clean));
        } catch (err) {
            showMessage('😢', '这次没能看到，可能是权限或窗口问题。你再试一次？', '她有点遗憾');
        } finally {
            watchBtn.disabled = false;
        }
    });

    // 智能鼠标穿透(拖动优先版 · 2026-09-09 两轮修复):
    // - 启动即交互(不再启动即穿透, 修复"启动后要等一会才能拖动")
    // - 鼠标在窗口内移动/停在气泡上 → 立即恢复交互, 拖动永远可响应
    // - 鼠标离开窗口 3 秒后才穿透(不挡游戏), 且主进程 'move' 事件在拖动期间持续重置计时器, mid-drag 绝不穿透
    let petThroughTimer = null;
    let petLastThrough = null;
    let dragHoldUntil = 0;
    const applyPetThrough = (ns) => {
        if (ns === petLastThrough) return;
        petLastThrough = ns;
        try { window.yueyue.setPetMouseThrough(ns); } catch (e2) { /* 忽略 */ }
    };
    try {
        window.yueyue.onPetMoved(() => { dragHoldUntil = Date.now() + 3000; applyPetThrough(false); });
    } catch (e) { /* 旧版 preload 无此键, 忽略 */ }
    document.addEventListener('mousemove', () => {
        clearTimeout(petThroughTimer);
        petThroughTimer = null;
        applyPetThrough(false);
    }, { passive: true });
    document.addEventListener('mouseleave', () => {
        if (petThroughTimer) return;
        if (Date.now() < dragHoldUntil) return;   // 刚拖完, 先别急着穿透
        petThroughTimer = setTimeout(() => { petThroughTimer = null; applyPetThrough(true); }, 3000);
    });
    document.getElementById('bClose').addEventListener('click', (e) => {
        e.stopPropagation();
        try { window.yueyue.closePet(); } catch (err) { /* 忽略 */ }
    });

    // 接收主窗推送: 她主动说的话 / 关心 / 感知 / 生日 / 成就 / 手势状态
    try {
        Shared.syncOn((d) => {
            if (!d || !d.type) return;
            if (d.type === 'bubble') {
                showMessage(d.icon || '🌸', d.text || '', d.label || '她给你留了句话');
            } else if (d.type === 'achievement') {
                // 通知分通道: 成就不与"她说的话"同款——金框成就卡, 7 秒回落
                const name = (d.name || '一枚新的成就');
                showMessage('🏆', '解锁成就「' + name + '」', '成就 · 去小世界的成就墙看看吧');
                bubble.classList.add('ach');
                clearTimeout(achTimer);
                achTimer = setTimeout(() => bubble.classList.remove('ach'), 7000);
            } else if (d.type === 'said') {
                const t = String(d.content || '');
                const clean = t.replace(/【场景：[^】]+】/g, '').replace(/【心声：[^】]+】/g, '').replace(/\[MOOD:[^\]]*\]/g, '').trim();
                if (clean) showMessage('💬', clean.split('\n')[0].replace(/^（[^）]*）/g, ''), '她主动说话了');
            }
        });
    } catch (e) { /* 忽略 */ }

    // 空闲后微呼吸提示(无消息状态不空置)
    bubble.addEventListener('mouseenter', () => {
        bubble.style.animationPlayState = 'paused';
    });
    bubble.addEventListener('mouseleave', () => {
        bubble.style.animationPlayState = '';
    });
})();
