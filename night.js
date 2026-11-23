// =============================================================
// 守夜 (Night Watch): canvas 塔防 · game-studio · 2026-11-24 · r196 门槛+意思+因果(S1/S2/S3), 承 r193(F1-F4/R1-R3)
// 自包含 IIFE, 只暴露 window.NightGame = { start(opts), stop(), state }
// - 不调 ai.complete / 不依赖 window.yueyue (台词全本地陈述句池)
// - 结果经 BroadcastChannel('yueyue-sync') 回主窗: game-result tie:true (守夜无输赢)
// - 灯灭不黑屏不弹"失败": 灰蓝→天边亮→她走过来重新点灯, 结算只写事实, 无惩罚
// - RAF 锁 30fps; 暂停/退出/关窗完全 cancelAnimationFrame; stop() 清全部监听器
// - 调试参数(仅测试用, 正常加载不带): ?nightSpeed=1..20 &nightLight=1..100
// 回滚: 删本文件 + 还原 game.html/game.js 的 .守夜pre-*.bak
// =============================================================
(function () {
    'use strict';
    const W = 400, H = 420;
    const LAMP = { x: 200, y: H - 58 };
    // r196 S2: 两种「照亮散雾」的灯, 取舍清晰 —— 暖灯范围大但慢/贵, 烛灯便宜快但范围小(贴路)
    // 雾不是被「打死」, 是被光照得慢慢散开(守灵魂: 减缓和照亮, 不是消灭); 停一下仍由 Her Word 提供
    const TOWERS = {
        warm: { name: '暖灯', ico: '🏮', cost: 12, radius: 78, dps: 1.7, key: '1', near: false, desc: '范围大 · 散雾慢 · 12芯' },
        candle: { name: '烛灯', ico: '🕯', cost: 5, radius: 30, dps: 4.2, key: '2', near: true, desc: '贴路 · 散雾快 · 5芯' },
    };
    const WAVES = [4, 6, 9, 11, 13, 15]; // r196 S1: 前2波雾少(4/6), 让因果可见; 后4波递进
    const PREP = 8;            // 波前准备(Look Ahead 提前8s报方位)
    const SPAWN_WINDOW = 30;   // 出雾窗口30s + 路程~15s ≈ 每波45s
    const DENSE_HP = 8;        // 浓雾密度
    const NORMAL_HP = 4;       // r196 S3: 普通雾也有可见血量, 被灯照会持续变淡(因果可读)
    const LEAK = { normal: 5, dense: 8 };
    const DENSE_RATIO = 0.85;  // 第3波起浓雾比例(MVP调参: 6波普通雾总漏光105≤130)
    const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八']; // r193: R3 clamp 上限18
    const LANE_NAMES = ['左边', '中间', '右边'];
    const LINES = {
        start: ['天黑了。灯点上。', '入夜了。雾在路上。', '今晚也有雾。灯芯够。'],
        clear: ['这拨过去了。', '又静下来了。', '过去了。灯还亮着。'],
        praise: ['守得稳。', '这拨让你挡下了。', '灯还亮着。好。', '过去了。你守得不错。', '嗯。又静下来了。'],
        low: ['灯有点暗了。', '光剩得不多了。'],
        word: ['急什么。先站会儿。', '站会儿。雾跑不了。'],
        relight: '灭就灭了。我还在这儿。',
        dawn: ['天亮了。雾自己散了。', '亮了。这一夜过去了。'],
        noWick: '灯芯不够。',
        noPlace: '这儿放不下。',
        needNear: '烛灯要贴着路放。',
        pickFirst: '先选一种灯，再点路边放下。',
        // r196 S1: 首次进入一句引导(0阅读成本学会); S2: 波间花钱抉择(软, 无焦虑)
        guide: '选下面的灯，点路旁放下。雾走近灯，就慢慢散了。',
        choiceWick: '补灯芯 +8',
        choiceGuard: '加固主灯',
        wickDone: '灯芯补上了。够再摆几盏。',
        guardDone: '主灯加固了。漏过的雾，带走的光少一点。',
        removed: '拆了。灯芯收回一半。',
        noFog: '雾还没来。',
        crash: '守夜出了点状况，已停下。控制台有记录。',
    };
    const MOODS = {
        calm: { mult: 1.15, warm: [255, 214, 150], leakScale: 1 },      // 暖黄 半径+15%
        tired: { mult: 0.90, warm: [235, 205, 185], leakScale: 0.8 },   // 半径-10% 但扣光少
        curious: { mult: 1.00, warm: [255, 224, 170], leakScale: 1, sweep: true }, // 光斑扫动
    };

    // ---------- 调试参数(浏览器 harness 用; Electron 正常加载不带参数) ----------
    const dbg = (() => { try { return new URLSearchParams(location.search); } catch (e) { return new URLSearchParams(); } })();
    const dbgSpeed = Math.min(20, Math.max(1, parseFloat(dbg.get('nightSpeed')) || 1));
    const dbgLight = dbg.get('nightLight') != null ? Math.max(1, Math.min(100, parseInt(dbg.get('nightLight'), 10) || 100)) : null;

    // ---------- r193 R1: 每日种子 (mulberry32 确定性; 同一天两局布局一致, 跨天不同; 界面不显示) ----------
    function mulberry32(a) {
        return function () {
            a |= 0; a = a + 0x6D2B79F5 | 0;
            let t = Math.imul(a ^ a >>> 15, 1 | a);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };
    }
    function readSeed() {
        // 测试钩子 window.NightGame.__seedOverride(数字)优先; 正常 = 本地日期 YYYYMMDD
        try {
            const ov = window.NightGame && window.NightGame.__seedOverride;
            if (ov != null && isFinite(Number(ov))) return Number(ov) >>> 0;
        } catch (e) { /* 忽略 */ }
        const d = new Date();
        return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    }
    // ---------- r193 R3: 隐性自适应 (上夜守到波次→今夜每波雾量系数; 界面不显示不提示) ----------
    function adaptFactor(lastWave) {
        if (lastWave == null || !isFinite(lastWave)) return 1;
        if (lastWave <= 2) return 0.8;   // 守到≤2波 -20%
        if (lastWave >= 6) return 1.1;   // 守到6波 +10%
        return 0.8 + (lastWave - 2) * 0.075; // 中间线性过渡
    }
    function readLastWave() {
        try { const v = parseInt(localStorage.getItem('yueyue_night_last_wave'), 10); return isFinite(v) ? v : null; } catch (e) { return null; }
    }

    // ---------- 三条来路: 二次贝塞尔采样折线 + 累积弧长 ----------
    const PATHS = [
        { x0: 62, cx: 58 }, { x0: 200, cx: 200 }, { x0: 338, cx: 342 },
    ].map((d) => {
        const pts = [];
        for (let i = 0; i <= 48; i++) {
            const t = i / 48, u = 1 - t;
            pts.push({
                x: u * u * d.x0 + 2 * u * t * d.cx + t * t * LAMP.x,
                y: u * u * -16 + 2 * u * t * (H * 0.5) + t * t * LAMP.y,
            });
        }
        const cum = [0];
        for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
        return { pts, cum, len: cum[cum.length - 1] };
    });
    function posAt(path, dist) {
        if (dist <= 0) return path.pts[0];
        if (dist >= path.len) return path.pts[path.pts.length - 1];
        let i = 1;
        while (path.cum[i] < dist) i++;
        const f = (dist - path.cum[i - 1]) / (path.cum[i] - path.cum[i - 1]);
        return {
            x: path.pts[i - 1].x + (path.pts[i].x - path.pts[i - 1].x) * f,
            y: path.pts[i - 1].y + (path.pts[i].y - path.pts[i - 1].y) * f,
        };
    }
    function distToPaths(x, y) {
        let m = 1e9;
        for (const p of PATHS) for (let i = 0; i < p.pts.length; i += 2) {
            const d = Math.hypot(p.pts[i].x - x, p.pts[i].y - y);
            if (d < m) m = d;
        }
        return m;
    }

    // ---------- 运行时状态 ----------
    let S = null, els = null, ctx = null;
    let raf = 0, running = false, lastT = 0, acc = 0;
    let listeners = []; // [target, type, fn, opt] — stop() 全部移除
    let btnT = {}, btnWord = null, btnBack = null, btnChoice = {};

    function readMood() {
        // MVP: 进夜读一次; 没有现成 mood 键就 calm (实时 mood 延后, 见报告)
        try {
            for (const k of ['yueyue_mood', 'yueyue_last_mood', 'yueyue_current_mood']) {
                let v = localStorage.getItem(k);
                if (!v) continue;
                try { const j = JSON.parse(v); if (j && typeof j === 'object') v = j.mood || j.current || ''; } catch (e) { /*  plain string */ }
                v = String(v).toLowerCase();
                if (/calm|平静/.test(v)) return 'calm';
                if (/tired|疲惫|累/.test(v)) return 'tired';
                if (/curious|好奇/.test(v)) return 'curious';
            }
        } catch (e) { /* 忽略 */ }
        return 'calm';
    }
    function makePlan(seed, waveIdx, counts) {
        // r193 R1: 每波独立种子流(seed+波序), 布局只由种子与雾量决定, 与玩家操作无关
        const rng = mulberry32((seed ^ Math.imul(waveIdx + 1, 0x9E3779B9)) >>> 0);
        const count = counts[waveIdx];
        const dense = waveIdx >= 2 ? Math.round(count * DENSE_RATIO) : 0;
        const types = [];
        for (let i = 0; i < count; i++) types.push(i < dense ? 'dense' : 'normal');
        for (let i = types.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = types[i]; types[i] = types[j]; types[j] = tmp; }
        const early = waveIdx <= 1 ? 0.7 : 1; // r196 S1: 前2波放慢30%, 因果可见(仍由种子确定, 不破坏R1)
        return types.map((t) => ({
            type: t, lane: Math.floor(rng() * 3),
            speed: (t === 'dense' ? 20 + rng() * 5 : 27 + rng() * 6) * early,
        }));
    }
    function lookAheadLine(plan, waveIdx) {
        const c = [0, 0, 0];
        plan.forEach((p) => c[p.lane]++);
        const parts = [];
        for (let i = 0; i < 3; i++) if (c[i]) parts.push(LANE_NAMES[i] + CN[c[i]] + '个');
        const dense = plan.some((p) => p.type === 'dense');
        const tail = dense ? ['雾浓。蜡烛管用。', '这拨雾厚。', '浓的来了。'][waveIdx % 3] : ['走得慢。', '不急。', '慢慢飘。'][waveIdx % 3];
        return parts.join('，') + '。' + tail;
    }
    function newState() {
        // r193 R2: 真实夜数 = 已结算夜数(yueyue_night_count)+1; 只在 settle 落盘, 关窗不算夜
        let count = 0;
        try {
            const raw = localStorage.getItem('yueyue_night_count');
            if (raw != null) count = parseInt(raw, 10) || 0;
            else count = parseInt(localStorage.getItem('yueyue_night_n'), 10) || 0; // 旧键一次性迁移
        } catch (e) { /* 忽略 */ }
        const n = count + 1;
        const mood = readMood();
        // r193 R1: 种子只按日期(不连夜数), 同一天两局布局一致; 台词独立流不干扰布局
        const seed = readSeed();
        const lineRng = mulberry32((seed ^ 0x51ED27) >>> 0);
        // r193 R3: 按上夜守到波次微调每波雾量, round 后 clamp 4..18
        const lastWave = readLastWave();
        const factor = adaptFactor(lastWave);
        const waveCounts = WAVES.map((c) => Math.max(4, Math.min(18, Math.round(c * factor))));
        const plan = makePlan(seed, 0, waveCounts);
        // r196 S1: 第一盏灯的推荐落点(每条路 y≈200 的路点), 没放灯时柔和高亮, 0阅读成本知道往哪放
        const suggest = PATHS.map((p) => {
            let best = p.pts[0];
            for (const pt of p.pts) if (Math.abs(pt.y - 200) < Math.abs(best.y - 200)) best = pt;
            return { x: best.x, y: best.y };
        });
        return {
            n, mood, mm: MOODS[mood],
            seed, lineRng, waveCounts, lastWave, suggest,
            light: dbgLight != null ? dbgLight : 100, wick: 60,
            wave: 0, cleared: 0, phase: 'prep', prepT: PREP,
            plan, spawned: 0, spawnT: 0.3,
            fogs: [], towers: [], parts: [],
            sel: null, ghost: null,
            wordLeft: 2, wordCd: 0, wordFlash: null,
            paused: false, over: false,
            relightT: 0, dawnT: 0, lampFlicker: 0, leakFx: 0,
            lowSaid: false, time: 0, emberT: 0, barT: 0,
            shake: 0, placeFx: null,
            guard: 0, choiceAvail: false, choicePicked: null, // r196 S2: 加固层数 / 波间抉择
            ch: null,
        };
    }
    function pickLine(pool) { return pool[Math.floor(S.lineRng() * pool.length)]; }
    function setSay(t) { if (els && els.say) els.say.textContent = t; }
    function fogPos(f) {
        const p = posAt(PATHS[f.lane], f.dist);
        return { x: p.x + Math.sin(S.time * 1.4 + f.wob) * 2.5, y: p.y };
    }

    // ---------- r193 F4: WebAudio 合成音 (master gain 0.15, 懒创建+首次pointerdown resume; Her Word 无声) ----------
    const AudioSys = {
        ctx: null, master: null, muted: false,
        load() { try { this.muted = localStorage.getItem('yueyue_night_muted') === '1'; } catch (e) { /* 忽略 */ } },
        ensure() {
            if (this.muted) return;
            if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); return; }
            try {
                const AC = window.AudioContext || window.webkitAudioContext;
                if (!AC) return;
                this.ctx = new AC();
                this.master = this.ctx.createGain();
                this.master.gain.value = 0.15;
                this.master.connect(this.ctx.destination);
                if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
            } catch (e) { /* 无声降级, 不影响游戏 */ }
        },
        tone(freq, dur, vol, delay, slideTo) {
            if (this.muted) return;
            this.ensure();
            if (!this.ctx || !this.master) return;
            try {
                const t0 = this.ctx.currentTime + (delay || 0);
                const o = this.ctx.createOscillator(), g = this.ctx.createGain();
                o.type = 'sine';
                o.frequency.setValueAtTime(freq, t0);
                if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t0 + dur);
                g.gain.setValueAtTime(0.0001, t0);
                g.gain.exponentialRampToValueAtTime(Math.max(0.001, vol), t0 + 0.008);
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
                o.connect(g); g.connect(this.master);
                o.start(t0); o.stop(t0 + dur + 0.05);
            } catch (e) { /* 忽略 */ }
        },
        place() { this.tone(660, 0.07, 0.5); this.tone(990, 0.05, 0.22, 0.012); },   // 轻「嗒」
        deny() { this.tone(130, 0.13, 0.5, 0, 90); },                               // 闷音
        clear() { this.tone(880, 0.4, 0.35); this.tone(1318.5, 0.5, 0.26, 0.1); },  // 柔和 chime
        leak() { this.tone(85, 0.16, 0.55, 0, 55); },                               // 软低 thud
        unmute() { this.tone(660, 0.06, 0.3); },
    };

    // ---------- 粒子(上限120) ----------
    function addPart(x, y, kind, text) {
        if (S.parts.length >= 120) S.parts.shift();
        const life = kind === 'text' ? 1.6 : kind === 'ember' ? 1.4 : kind === 'mote' ? 1.1 : kind === 'ring' ? 0.38 : kind === 'spark' ? 0.5 : 0.9;
        S.parts.push({
            x, y, kind, text, t: 0, life,
            vx: kind === 'ring' || kind === 'mote' ? 0 : (Math.random() - 0.5) * 10,
            vy: kind === 'ring' || kind === 'mote' ? 0 : kind === 'ember' ? -18 : kind === 'spark' ? -22 : (kind === 'text' ? -14 : -6),
            r: kind === 'puff' ? 5 : kind === 'ring' ? 6 : kind === 'spark' ? 1.5 : 2,
        });
    }
    function updateParts(dt) {
        for (let i = S.parts.length - 1; i >= 0; i--) {
            const p = S.parts[i];
            p.t += dt;
            if (p.t >= p.life) { S.parts.splice(i, 1); continue; }
            if (p.kind === 'mote') { // r193 F2: 光点飘向主灯
                const k = Math.min(1, 2.4 * dt);
                p.x += (LAMP.x - p.x) * k; p.y += (LAMP.y - 10 - p.y) * k;
                continue;
            }
            p.x += p.vx * dt; p.y += p.vy * dt;
            if (p.kind === 'puff') p.r += 14 * dt;
            if (p.kind === 'ring') p.r += 68 * dt;
        }
    }

    // ---------- 塔 / 放置 ----------
    function validPlace(x, y, kind) {
        if (y < 26 || y > H - 30 || x < 14 || x > W - 14) return { ok: false, why: LINES.noPlace };
        if (Math.hypot(x - LAMP.x, y - LAMP.y) < 46) return { ok: false, why: LINES.noPlace };
        const d = distToPaths(x, y);
        if (TOWERS[kind].near && d > 30) return { ok: false, why: LINES.needNear };
        if (d > 120) return { ok: false, why: LINES.noPlace };
        for (const t of S.towers) if (Math.hypot(t.x - x, t.y - y) < 26) return { ok: false, why: LINES.noPlace };
        return { ok: true };
    }
    function tryPlace(x, y) {
        if (!S || S.over) return;
        if (!S.sel) { setSay(LINES.pickFirst); return; }
        const def = TOWERS[S.sel];
        if (S.wick < def.cost) { // r193 F1: 芯不足 = 轻微shake+闷音, 不红闪不弹窗
            S.shake = 0.2; AudioSys.deny(); setSay(LINES.noWick);
            if (!running) draw();
            return;
        }
        const v = validPlace(x, y, S.sel);
        if (!v.ok) { setSay(v.why); return; }
        S.wick -= def.cost;
        S.towers.push({ kind: S.sel, x, y, cd: 0, pulse: 0, pop: 0.12 }); // r193 F1: scale pop 1.15→1 / 120ms
        addPart(x, y, 'ring');                                           // 一圈柔和光环
        for (let k = 0; k < 4; k++) addPart(x + (Math.random() - 0.5) * 14, y + (Math.random() - 0.5) * 10, 'spark');
        S.placeFx = { x, y, t: 0.5 };
        AudioSys.place();
        updateBar();
        if (!running) draw();
    }
    function tryRemove(x, y) {
        if (!S || S.over) return;
        for (let i = 0; i < S.towers.length; i++) {
            const t = S.towers[i];
            if (Math.hypot(t.x - x, t.y - y) < 18) {
                S.wick += Math.floor(TOWERS[t.kind].cost / 2);
                S.towers.splice(i, 1);
                setSay(LINES.removed);
                updateBar();
                if (!running) draw();
                return;
            }
        }
    }
    function selectTower(k) {
        if (!S || S.over) return;
        S.sel = (S.sel === k ? null : k);
        updateBar();
        if (!running) draw();
    }
    function herWord() {
        if (!S || S.over || S.paused) return;
        if (S.wordLeft <= 0 || S.wordCd > 0) return;
        if (S.phase !== 'wave' || !S.fogs.length) { setSay(LINES.noFog); return; }
        const c = [0, 0, 0];
        S.fogs.forEach((f) => c[f.lane]++);
        let lane = 0;
        if (c[1] > c[lane]) lane = 1;
        if (c[2] > c[lane]) lane = 2;
        S.fogs.forEach((f) => { if (f.lane === lane) f.frozen = Math.max(f.frozen, 2); });
        S.wordLeft--; S.wordCd = 45;
        S.wordFlash = { lane, t: 0.8 };
        setSay(LINES.word[1 - S.wordLeft]);
        console.log('[守夜] Her Word: 停' + LANE_NAMES[lane] + ' 2s, 剩' + S.wordLeft + '次');
        updateBar();
    }

    // ---------- r196 S2: 波间花钱抉择 (补灯芯=进攻预算 / 加固主灯=防守, 影响下一波数值; 软, 可选, 无焦虑) ----------
    function pickChoice(kind) {
        if (!S || S.over || S.phase !== 'prep' || !S.choiceAvail || S.choicePicked) return;
        S.choicePicked = kind;
        if (kind === 'wick') { S.wick += 8; setSay(LINES.wickDone); }
        else { S.guard += 1; setSay(LINES.guardDone); } // 每层加固: 每次漏光少带走1点(下限1)
        AudioSys.place();
        console.log('[守夜] 波间抉择: ' + kind + ' (芯' + S.wick + ' 加固' + S.guard + ')');
        updateChoice(); updateBar();
        if (!running) draw();
    }
    function buildChoice() {
        if (!els.choice) return;
        els.choice.innerHTML = '';
        btnChoice = {};
        const mk = (k, text, title) => {
            const b = document.createElement('button');
            b.className = 'choice'; b.textContent = text; b.title = title;
            b.addEventListener('click', () => pickChoice(k));
            els.choice.appendChild(b); btnChoice[k] = b;
        };
        mk('wick', LINES.choiceWick, '多8芯, 下一波能多摆几盏灯');
        mk('guard', LINES.choiceGuard, '主灯更耐漏, 之后每次漏光少带走1点');
    }
    function updateChoice() {
        if (!els.choice) return;
        const show = !!(S && S.choiceAvail && S.phase === 'prep' && !S.over);
        els.choice.style.display = show ? 'flex' : 'none';
        if (show) for (const k in btnChoice) {
            btnChoice[k].disabled = !!S.choicePicked;
            btnChoice[k].classList.toggle('sel', S.choicePicked === k);
        }
    }

    // ---------- 波次流程 ----------
    function beginWave() {
        S.phase = 'wave';
        S.spawned = 0;
        S.spawnT = 0.3;
        S.choiceAvail = false; updateChoice(); // r196 S2: 波开始收起抉择
        console.log('[守夜] 第' + (S.wave + 1) + '波开始 (' + S.plan.length + '雾, 浓' + S.plan.filter((p) => p.type === 'dense').length + ')');
        updateBar();
    }
    function waveCleared() {
        S.cleared++;
        S.light = Math.min(100, S.light + 6);
        S.wick += 10;
        addPart(LAMP.x, LAMP.y - 44, 'text', '+6光 +10芯');
        // r193 F2: 光点飘向主灯 + 柔和chime + 本地池夸奖(seed选, 不调AI)
        for (let k = 0; k < 10; k++) addPart(40 + Math.random() * (W - 80), 60 + Math.random() * (H - 160), 'mote');
        AudioSys.clear();
        console.log('[守夜] 第' + S.cleared + '波守完 光' + S.light + ' 芯' + S.wick);
        if (S.cleared >= WAVES.length) { startDawn(); return; }
        S.wave = S.cleared;
        S.plan = makePlan(S.seed, S.wave, S.waveCounts);
        S.phase = 'prep';
        S.prepT = PREP;
        S.choiceAvail = true; S.choicePicked = null; // r196 S2: 波间给一次花钱抉择
        setSay(pickLine(LINES.praise) + lookAheadLine(S.plan, S.wave));
        updateChoice(); updateBar();
    }
    function startRelight() {
        S.phase = 'relight'; S.relightT = 0; S.over = true;
        S.fogs = [];
        setSay(LINES.relight);
        console.log('[守夜] 灯灭 → 重新点灯动画 (不弹失败, 无惩罚)');
        updateBar();
    }
    function startDawn() {
        S.phase = 'dawn'; S.dawnT = 0; S.over = true;
        S.fogs = [];
        setSay(pickLine(LINES.dawn));
        console.log('[守夜] 天亮, 6波守完');
        updateBar();
    }
    function settle() {
        S.phase = 'settle';
        stopLoop(); // 结算后完全停 RAF
        draw();
        // r193 R2/R3: 真实夜数+1 与上夜波次只在结算落盘 (关窗不结算不算夜)
        try {
            localStorage.setItem('yueyue_night_count', String(S.n));
            localStorage.setItem('yueyue_night_last_wave', String(S.cleared));
        } catch (e) { /* 忽略 */ }
        const summary = '第' + S.n + '夜·守到第' + S.cleared + '波·灯芯剩' + S.wick;
        try {
            S.ch.postMessage({ type: 'game-result', source: 'game', game: 'night', gameName: '守夜', tie: true, summary: summary, card: summary });
            console.log('[守夜] 结算回传: ' + summary);
        } catch (e) { console.error('[守夜] 回传失败', e); }
        const ov = document.createElement('div');
        ov.id = 'nightSettle';
        const fact = document.createElement('div');
        fact.className = 'fact';
        fact.textContent = summary;
        const btn = document.createElement('button');
        btn.textContent = '回去坐着';
        btn.addEventListener('click', () => { if (els && els.onExit) els.onExit(); });
        ov.appendChild(fact); ov.appendChild(btn);
        els.wrap.appendChild(ov);
    }

    // ---------- 主更新 ----------
    function tick(dt) {
        S.time += dt;
        updateParts(dt);
        if (S.phase === 'prep') {
            S.prepT -= dt;
            if (S.prepT <= 0) beginWave();
        } else if (S.phase === 'wave') {
            if (S.spawned < S.plan.length) {
                S.spawnT -= dt;
                if (S.spawnT <= 0) {
                    const p = S.plan[S.spawned++];
                    const hp0 = p.type === 'dense' ? DENSE_HP : NORMAL_HP; // r196 S3: 两种雾都有可见血量
                    S.fogs.push({ lane: p.lane, type: p.type, speed: p.speed, dist: 0, hp: hp0, maxhp: hp0, frozen: 0, lit: false, wob: Math.random() * 6.28 });
                    S.spawnT = SPAWN_WINDOW / S.plan.length;
                }
            }
            for (const t of S.towers) { if (t.pulse > 0) t.pulse -= dt; t.clearing = false; }
            for (let i = S.fogs.length - 1; i >= 0; i--) {
                const f = S.fogs[i];
                const fp = fogPos(f);
                // r196 S2/S3: 两种灯都「照亮散雾」(普通+浓), 持续掉血可见; 暖灯范围大慢, 烛灯贴路快
                f.lit = false;
                for (const t of S.towers) {
                    const def = TOWERS[t.kind];
                    const r = def.radius * S.mm.mult;
                    if (Math.hypot(fp.x - t.x, fp.y - t.y) > r) continue;
                    f.hp -= def.dps * dt; t.pulse = 0.3; t.clearing = true; f.lit = true;
                }
                if (f.hp <= 0) { // 雾被光照散(不是打死): 柔 puff + 飘向主灯的小光点
                    for (let k = 0; k < 6; k++) addPart(fp.x + (Math.random() - 0.5) * 12, fp.y + (Math.random() - 0.5) * 12, 'puff');
                    for (let k = 0; k < 3; k++) addPart(fp.x + (Math.random() - 0.5) * 8, fp.y + (Math.random() - 0.5) * 8, 'mote');
                    S.fogs.splice(i, 1);
                    continue;
                }
                if (f.frozen > 0) f.frozen -= dt;
                else f.dist += f.speed * dt;
                if (f.dist >= PATHS[f.lane].len) {
                    // r196 S3: 漏过=走过去了, 主灯芯掉一格(软): 加固层每层少带走1点(下限1), 柔puff+ notch, 不红闪
                    const dmg = Math.max(1, Math.round(LEAK[f.type] * S.mm.leakScale) - S.guard);
                    S.light -= dmg;
                    S.lampFlicker = 0.5; S.leakFx = 0.6;
                    addPart(LAMP.x + (Math.random() - 0.5) * 8, LAMP.y - 14, 'puff');
                    AudioSys.leak(); // r193 F3: 软低thud, 保留flicker, 不加惩罚性闪屏
                    S.fogs.splice(i, 1);
                    if (S.light <= 0) { S.light = 0; startRelight(); return; }
                    if (S.light <= 30 && !S.lowSaid) { S.lowSaid = true; setSay(pickLine(LINES.low)); }
                }
            }
            if (S.spawned >= S.plan.length && S.fogs.length === 0) waveCleared();
        } else if (S.phase === 'relight') {
            S.relightT += dt;
            if (S.relightT >= 2.6) settle();
        } else if (S.phase === 'dawn') {
            S.dawnT += dt;
            if (S.dawnT >= 2.6) settle();
        }
        if (S.wordCd > 0) { S.wordCd -= dt; if (S.wordCd < 0) S.wordCd = 0; }
        if (S.wordFlash) { S.wordFlash.t -= dt; if (S.wordFlash.t <= 0) S.wordFlash = null; }
        if (S.lampFlicker > 0) S.lampFlicker -= dt;
        if (S.leakFx > 0) S.leakFx -= dt; // r196 S3: 掉格柔和衰减
        if (S.shake > 0) S.shake -= dt; // r193 F1
        if (S.placeFx) { S.placeFx.t -= dt; if (S.placeFx.t <= 0) S.placeFx = null; }
        for (const t of S.towers) if (t.pop > 0) t.pop -= dt; // prep 阶段也衰减
        S.emberT -= dt;
        if (S.emberT <= 0 && S.light > 0 && !S.over) { S.emberT = 0.5; addPart(LAMP.x + (Math.random() * 16 - 8), LAMP.y - 12, 'ember'); }
        S.barT -= dt;
        if (S.barT <= 0) { S.barT = 0.5; updateBar(); }
    }

    // ---------- 绘制 ----------
    function hx(c) {
        if (c[0] === '#') return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
        const m = c.match(/(\d+),\s*(\d+),\s*(\d+)/); // mix() 产物 rgb(r,g,b) 也要能再混
        return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
    }
    function mix(a, b, f) { const A = hx(a), B = hx(b); return 'rgb(' + A.map((v, i) => Math.round(v + (B[i] - v) * f)).join(',') + ')'; }
    function skyColors() {
        const day = document.body.classList.contains('day');
        let c0 = day ? '#F8F2E7' : '#0e0c20';
        let c1 = day ? '#EFE5D4' : '#221543';
        let dawnF = 0;
        if (S.phase === 'relight') {
            const u = S.relightT / 2.6;
            const gray = Math.min(1, u / 0.45);
            dawnF = Math.max(0, (u - 0.5) / 0.5);
            c0 = mix(c0, '#46536e', gray * (1 - dawnF * 0.6));
            c1 = mix(c1, '#6a7896', gray * (1 - dawnF * 0.6));
        } else if (S.phase === 'dawn' || S.phase === 'settle') {
            dawnF = S.phase === 'settle' ? 1 : Math.min(1, S.dawnT / 1.8);
        }
        if (dawnF > 0) {
            c0 = mix(c0, day ? '#FDEBD2' : '#8a93b5', dawnF);
            c1 = mix(c1, day ? '#F6D9B0' : '#e8b98a', dawnF);
        }
        return { c0, c1, dawnF, day };
    }
    function drawFigure(x, y) {
        ctx.save();
        ctx.translate(x, y);
        ctx.strokeStyle = '#3a3350'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(2, -26); ctx.quadraticCurveTo(13, -18, 8, -6); ctx.stroke(); // 马尾
        ctx.fillStyle = '#f0d6c4'; ctx.beginPath(); ctx.arc(0, -24, 6, 0, 6.29); ctx.fill();      // 脸
        ctx.fillStyle = '#3a3350'; ctx.beginPath(); ctx.arc(0, -26, 6, Math.PI, 0); ctx.fill();   // 发
        ctx.fillStyle = '#f5f1e8';                                                                 // 白外套
        ctx.beginPath(); ctx.moveTo(-5, -18); ctx.lineTo(5, -18); ctx.lineTo(8, -2); ctx.lineTo(-8, -2); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#2e3a5c'; ctx.fillRect(-8, -4, 16, 5);                                    // 藏青裙
        ctx.strokeStyle = '#f0d6c4'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-3, 1); ctx.lineTo(-3, 8); ctx.moveTo(3, 1); ctx.lineTo(3, 8); ctx.stroke();
        ctx.restore();
    }
    function draw() {
        if (!ctx || !S) return;
        ctx.save(); // r193 F1: 芯不足轻微shake(整幅平移, 不红闪)
        if (S.shake > 0) ctx.translate(Math.sin(S.shake * 90) * 2.2 * (S.shake / 0.2), 0);
        const pal = skyColors();
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, pal.c0); g.addColorStop(1, pal.c1);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        if (pal.dawnF > 0) { // 天边亮
            const dg = ctx.createRadialGradient(200, -30, 10, 200, -30, 320);
            dg.addColorStop(0, 'rgba(255,205,140,' + (0.55 * pal.dawnF).toFixed(3) + ')');
            dg.addColorStop(1, 'rgba(255,205,140,0)');
            ctx.fillStyle = dg; ctx.fillRect(0, 0, W, H * 0.7);
        }
        // 路
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const p of PATHS) {
            ctx.strokeStyle = pal.day ? 'rgba(92,74,52,0.10)' : 'rgba(190,175,235,0.08)';
            ctx.lineWidth = 18;
            ctx.beginPath(); ctx.moveTo(p.pts[0].x, p.pts[0].y);
            for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i].x, p.pts[i].y);
            ctx.stroke();
            ctx.strokeStyle = pal.day ? 'rgba(92,74,52,0.30)' : 'rgba(190,175,235,0.28)';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([1, 9]);
            ctx.stroke();
            ctx.setLineDash([]);
        }
        // Her Word 路闪
        if (S.wordFlash) {
            const p = PATHS[S.wordFlash.lane];
            ctx.strokeStyle = 'rgba(255,180,200,' + (0.5 * S.wordFlash.t / 0.8).toFixed(3) + ')';
            ctx.lineWidth = 12;
            ctx.beginPath(); ctx.moveTo(p.pts[0].x, p.pts[0].y);
            for (let i = 1; i < p.pts.length; i++) ctx.lineTo(p.pts[i].x, p.pts[i].y);
            ctx.stroke();
        }
        // r196 S1: 还没放灯时, 柔和高亮推荐落点(0阅读成本知道往哪放); 放了第一盏就收起
        if (S.towers.length === 0 && !S.over && S.phase !== 'settle') {
            const pulse = 0.5 + 0.5 * Math.sin(S.time * 2.4);
            for (const sp of S.suggest) {
                ctx.strokeStyle = 'rgba(255,200,140,' + (0.25 + 0.3 * pulse).toFixed(3) + ')';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(sp.x, sp.y, 13 + 3 * pulse, 0, 6.29); ctx.stroke();
                ctx.fillStyle = 'rgba(255,214,150,' + (0.3 + 0.3 * pulse).toFixed(3) + ')';
                ctx.beginPath(); ctx.arc(sp.x, sp.y, 3, 0, 6.29); ctx.fill();
            }
        }
        // 塔 (两种灯: 暖灯=大灯笼, 烛灯=小蜡烛)
        for (const t of S.towers) {
            const def = TOWERS[t.kind];
            const r = def.radius * S.mm.mult;
            const pop = t.pop > 0 ? 1 + 0.15 * (t.pop / 0.12) : 1; // r193 F1: 1.15→1
            ctx.save();
            if (pop !== 1) { ctx.translate(t.x, t.y); ctx.scale(pop, pop); ctx.translate(-t.x, -t.y); }
            ctx.strokeStyle = pal.day ? 'rgba(150,86,109,0.16)' : 'rgba(255,200,140,0.12)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 6.29); ctx.stroke();
            if (t.kind === 'candle') {
                const cg = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, r);
                cg.addColorStop(0, 'rgba(255,190,110,0.16)'); cg.addColorStop(1, 'rgba(255,190,110,0)');
                ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 6.29); ctx.fill();
                ctx.fillStyle = '#e8dcc8'; ctx.fillRect(t.x - 2.5, t.y - 4, 5, 11);
                ctx.fillStyle = t.pulse > 0 ? '#ffd27a' : '#ffb347';
                ctx.beginPath(); ctx.ellipse(t.x, t.y - 8, 3, 5.5, 0, 0, 6.29); ctx.fill();
            } else { // warm 暖灯: 范围大, 光晕更宽
                const lg = ctx.createRadialGradient(t.x, t.y, 0, t.x, t.y, r);
                lg.addColorStop(0, 'rgba(255,190,110,' + (t.clearing ? 0.26 : 0.18) + ')'); lg.addColorStop(1, 'rgba(255,190,110,0)');
                ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 6.29); ctx.fill();
                ctx.strokeStyle = pal.day ? '#6E6355' : '#8f89a8'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(t.x, t.y + 14); ctx.lineTo(t.x, t.y - 10); ctx.stroke();
                ctx.fillStyle = '#ff9d5c';
                ctx.beginPath(); ctx.ellipse(t.x, t.y - 2, 7, 9, 0, 0, 6.29); ctx.fill();
                ctx.fillStyle = '#ffe0a8';
                ctx.beginPath(); ctx.ellipse(t.x, t.y - 2, 3.5, 5, 0, 0, 6.29); ctx.fill();
            }
            ctx.restore();
        }
        // r196 S3: 灯正在照雾 → 持续柔和暖光束(非瞬间), 让「灯清雾」因果一直可见
        for (const t of S.towers) {
            if (!t.clearing) continue;
            const r = TOWERS[t.kind].radius * S.mm.mult;
            for (const f of S.fogs) {
                const fp = fogPos(f);
                if (Math.hypot(fp.x - t.x, fp.y - t.y) > r) continue;
                ctx.strokeStyle = 'rgba(255,200,140,0.16)'; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(t.x, t.y - 4); ctx.lineTo(fp.x, fp.y); ctx.stroke();
            }
        }
        // 雾
        for (const f of S.fogs) {
            const fp = fogPos(f);
            const dense = f.type === 'dense';
            const hf = Math.max(0, f.hp / f.maxhp); // r196 S3: 被灯照 → 雾持续变小变淡(因果可读, 两种雾都可见)
            const r = (dense ? 17 : 13) * (0.55 + 0.45 * hf);
            const col = dense ? (pal.day ? '80,70,95' : '126,108,168') : (pal.day ? '125,115,105' : '202,196,224');
            const a = (dense ? 0.72 : 0.46) * (0.5 + 0.5 * hf);
            const fg = ctx.createRadialGradient(fp.x, fp.y, 0, fp.x, fp.y, r);
            fg.addColorStop(0, 'rgba(' + col + ',' + a.toFixed(3) + ')');
            fg.addColorStop(1, 'rgba(' + col + ',0)');
            ctx.fillStyle = fg;
            ctx.beginPath(); ctx.arc(fp.x, fp.y, r, 0, 6.29); ctx.fill();
            ctx.fillStyle = 'rgba(' + col + ',' + (0.5 * hf + 0.2).toFixed(3) + ')';
            ctx.beginPath(); ctx.arc(fp.x, fp.y, (dense ? 4 : 3) + 4 * hf, 0, 6.29); ctx.fill();
            if (f.frozen > 0) {
                ctx.strokeStyle = 'rgba(150,200,255,0.85)'; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(fp.x, fp.y, r + 2, 0, 6.29); ctx.stroke();
            }
        }
        // 主灯
        let vLight = S.light;
        if (S.phase === 'relight') { const u = S.relightT / 2.6; vLight = u > 0.78 ? 34 * (u - 0.78) / 0.22 : 0; }
        else if (S.phase === 'dawn' || S.phase === 'settle') vLight = 60;
        const warm = S.mm.warm;
        let ox = 0;
        if (S.mm.sweep) ox = Math.sin(S.time * 0.7) * 14; // curious 光斑扫动
        if (vLight > 0) {
            const gr = (30 + 55 * vLight / 100) * S.mm.mult;
            let alpha = 0.5;
            if (S.lampFlicker > 0) alpha *= 0.6 + 0.4 * Math.abs(Math.sin(S.time * 30));
            const lg = ctx.createRadialGradient(LAMP.x + ox, LAMP.y, 0, LAMP.x + ox, LAMP.y, gr);
            lg.addColorStop(0, 'rgba(' + warm.join(',') + ',' + alpha.toFixed(3) + ')');
            lg.addColorStop(1, 'rgba(' + warm.join(',') + ',0)');
            ctx.fillStyle = lg;
            ctx.beginPath(); ctx.arc(LAMP.x + ox, LAMP.y, gr, 0, 6.29); ctx.fill();
        }
        ctx.fillStyle = pal.day ? '#84485E' : '#b1456f';
        ctx.fillRect(LAMP.x - 9, LAMP.y - 12, 18, 24);
        ctx.fillStyle = vLight > 0 ? '#ffe0a8' : (pal.day ? '#c9bba8' : '#4a4460');
        ctx.beginPath(); ctx.ellipse(LAMP.x, LAMP.y, 5, 8, 0, 0, 6.29); ctx.fill();
        ctx.strokeStyle = pal.day ? '#6E6355' : '#8f89a8'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(LAMP.x, LAMP.y - 12); ctx.lineTo(LAMP.x, LAMP.y - 18); ctx.stroke();
        // r196 S3: 主灯芯「格」—— 5格随光持续消长, 漏过时最上面亮格柔和一闪(掉一格的可见后果, 不红闪)
        if (S.phase !== 'relight') {
            const gx = LAMP.x + 15, segs = 5;
            for (let i = 0; i < segs; i++) {
                const on = vLight > i * 20;
                const top = on && vLight <= (i + 1) * 20;
                let al = on ? 0.7 : 0.14;
                if (top && S.leakFx > 0) al = 0.7 * (0.4 + 0.6 * Math.abs(Math.sin(S.time * 26)));
                ctx.fillStyle = on ? 'rgba(255,200,140,' + al.toFixed(3) + ')' : (pal.day ? 'rgba(92,74,52,0.18)' : 'rgba(233,228,242,0.14)');
                ctx.fillRect(gx, LAMP.y + 8 - i * 5, 5, 3);
            }
        }
        // 她走过来点灯 / 天亮后站在灯旁
        if (S.phase === 'relight') {
            const u = S.relightT / 2.6;
            if (u > 0.1) {
                const walk = Math.min(1, (u - 0.1) / 0.62);
                const fx = 36 + (LAMP.x - 26 - 36) * walk;
                const fy = LAMP.y + 8 + (walk < 1 ? Math.sin(u * 42) * 1.5 : 0);
                drawFigure(fx, fy);
            }
        } else if (S.phase === 'dawn' || S.phase === 'settle') {
            drawFigure(LAMP.x - 26, LAMP.y + 8);
        }
        // 粒子
        for (const p of S.parts) {
            const f = 1 - p.t / p.life;
            if (p.kind === 'text') {
                ctx.fillStyle = 'rgba(255,220,160,' + f.toFixed(3) + ')';
                ctx.font = '12px "Microsoft YaHei", sans-serif';
                ctx.textAlign = 'center';
                ctx.fillText(p.text, p.x, p.y);
            } else if (p.kind === 'ring') { // r193 F1: 放置光环
                ctx.strokeStyle = 'rgba(255,214,150,' + (0.5 * f).toFixed(3) + ')';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.stroke();
            } else if (p.kind === 'mote') { // r193 F2: 飘向主灯的光点
                ctx.fillStyle = 'rgba(255,214,150,' + (0.85 * f).toFixed(3) + ')';
                ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 6.29); ctx.fill();
                ctx.fillStyle = 'rgba(255,214,150,' + (0.25 * f).toFixed(3) + ')';
                ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, 6.29); ctx.fill();
            } else {
                ctx.fillStyle = p.kind === 'ember' || p.kind === 'spark' ? 'rgba(255,200,120,' + (0.7 * f).toFixed(3) + ')' : 'rgba(185,180,205,' + (0.45 * f).toFixed(3) + ')';
                ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.29); ctx.fill();
            }
        }
        // 放置预览
        if (S.sel && S.ghost && !S.over) {
            const def = TOWERS[S.sel];
            const v = validPlace(S.ghost.x, S.ghost.y, S.sel);
            const r = def.radius * S.mm.mult;
            // r196 S1: 放灯幽灵预览(范围圈+灯影); 放不下用柔灰不用红(守灵魂: 不红闪)
            ctx.fillStyle = v.ok ? 'rgba(255,200,140,0.10)' : 'rgba(150,140,160,0.08)';
            ctx.beginPath(); ctx.arc(S.ghost.x, S.ghost.y, r, 0, 6.29); ctx.fill();
            ctx.strokeStyle = v.ok ? 'rgba(255,200,140,0.5)' : 'rgba(150,140,160,0.5)';
            ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.arc(S.ghost.x, S.ghost.y, r, 0, 6.29); ctx.stroke();
            ctx.fillStyle = v.ok ? 'rgba(255,214,150,0.6)' : 'rgba(150,140,160,0.5)';
            ctx.beginPath(); ctx.ellipse(S.ghost.x, S.ghost.y - 2, 4, 6, 0, 0, 6.29); ctx.fill();
        }
        // HUD
        ctx.textAlign = 'left';
        ctx.font = '12px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = pal.day ? '#2B2620' : '#e9e4f2';
        ctx.fillText('光', 12, 18);
        ctx.fillStyle = pal.day ? 'rgba(92,74,52,0.18)' : 'rgba(255,255,255,0.12)';
        ctx.fillRect(30, 10, 84, 8);
        ctx.fillStyle = S.light <= 30 ? '#e88a6a' : '#ffc978';
        ctx.fillRect(30, 10, 84 * Math.max(0, S.light) / 100, 8);
        ctx.fillStyle = pal.day ? '#2B2620' : '#e9e4f2';
        ctx.fillText(String(Math.max(0, Math.round(S.light))), 120, 18);
        ctx.textAlign = 'center';
        let mid = '第' + S.n + '夜 · 第' + (S.wave + 1) + '/6波';
        if (S.phase === 'prep') mid += ' 将至 ' + Math.ceil(S.prepT) + 's';
        if (S.phase === 'dawn' || S.phase === 'settle') mid = '第' + S.n + '夜 · 完';
        ctx.fillText(mid, 218, 18);
        ctx.textAlign = 'right';
        ctx.fillText('芯 ' + S.wick, W - 12, 18);
        ctx.textAlign = 'left';
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = pal.day ? 'rgba(92,74,52,0.45)' : 'rgba(233,228,242,0.35)';
        ctx.fillText('空格=暂停 · 右键拆灯', 12, H - 8);
        // 暂停罩
        if (S.paused) {
            ctx.fillStyle = pal.day ? 'rgba(248,242,231,0.55)' : 'rgba(10,8,22,0.5)';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = pal.day ? '#2B2620' : '#e9e4f2';
            ctx.font = '15px "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('停着。空格继续。', W / 2, H / 2);
            ctx.textAlign = 'left';
        }
        ctx.restore();
    }

    // ---------- RAF 锁 30fps ----------
    function loop(ts) {
        raf = requestAnimationFrame(loop);
        if (!lastT) { lastT = ts; return; }
        let elapsed = (ts - lastT) / 1000;
        lastT = ts;
        if (elapsed > 0.25) elapsed = 0.25; // 切后台钳制
        acc += elapsed * dbgSpeed;
        const step = 1 / 30;
        if (acc < step) return;
        let n = 0;
        while (acc >= step && n < 10) {
            try { tick(step); } catch (e) { crash(e); return; }
            acc -= step; n++;
            if (!S || S.phase === 'settle') { acc = 0; break; }
        }
        if (acc > step * 10) acc = 0;
        try { draw(); } catch (e) { crash(e); }
    }
    function startLoop() {
        if (running) return;
        running = true; lastT = 0; acc = 0;
        raf = requestAnimationFrame(loop);
    }
    function stopLoop() {
        if (raf) cancelAnimationFrame(raf);
        raf = 0; running = false; lastT = 0; acc = 0;
    }
    function crash(e) {
        console.error('[守夜] 帧异常, 已停(不影响其它游戏)', e);
        stopLoop();
        if (S) { S.over = true; setSay(LINES.crash); updateBar(); }
    }
    function togglePause() {
        if (!S || S.phase === 'settle') return;
        S.paused = !S.paused;
        if (S.paused) { stopLoop(); draw(); } else startLoop();
        console.log('[守夜] ' + (S.paused ? '暂停(RAF已取消)' : '继续'));
        updateBar();
    }

    // ---------- UI ----------
    function buildBar() {
        els.bar.innerHTML = '';
        const mk = (cls, text, title, fn) => {
            const b = document.createElement('button');
            b.className = cls; b.textContent = text; b.title = title;
            b.addEventListener('click', fn);
            els.bar.appendChild(b);
            return b;
        };
        btnBack = mk('back', '↩', '回菜单(不结算, 不算失败)', () => { if (els && els.onExit) els.onExit(); });
        btnT = {};
        for (const k of ['warm', 'candle']) { // r196 S2: 两种灯, 取舍清晰
            const d = TOWERS[k];
            btnT[k] = mk('tower', d.ico + d.name + ' ' + d.cost, d.desc + ' · 快捷键' + d.key + ' · 右键拆返还一半', () => selectTower(k));
        }
        btnWord = mk('word', '玥玥 · 2次', '让一段路停2秒 · 每夜2次 · 冷却45秒', herWord);
    }
    function updateBar() {
        if (!S || !btnWord) return;
        for (const k in btnT) {
            btnT[k].classList.toggle('sel', S.sel === k);
            btnT[k].disabled = S.over || S.wick < TOWERS[k].cost;
        }
        btnWord.disabled = S.over || S.paused || S.wordLeft <= 0 || S.wordCd > 0 || S.phase !== 'wave';
        btnWord.textContent = S.wordCd > 0 ? '玥玥 ' + Math.ceil(S.wordCd) + 's' : '玥玥 · ' + S.wordLeft + '次';
        updateChoice(); // r196 S2: 抉择行随阶段显隐
    }
    function canvasXY(e) {
        const r = els.canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (W / r.width), y: (e.clientY - r.top) * (H / r.height) };
    }
    function on(t, ev, fn) { t.addEventListener(ev, fn); listeners.push([t, ev, fn]); }
    function toggleMute() {
        AudioSys.muted = !AudioSys.muted;
        try { localStorage.setItem('yueyue_night_muted', AudioSys.muted ? '1' : '0'); } catch (e) { /* 忽略 */ }
        if (els && els.mute) els.mute.textContent = AudioSys.muted ? '🔇' : '🔊';
        if (!AudioSys.muted) { AudioSys.ensure(); AudioSys.unmute(); }
        console.log('[守夜] 声音 ' + (AudioSys.muted ? '关' : '开'));
    }
    function bind() {
        // r193 F4: autoplay 政策 — 首次 pointerdown 懒创建/resume AudioContext
        on(document, 'pointerdown', () => AudioSys.ensure());
        if (els.mute) on(els.mute, 'click', toggleMute);
        on(window, 'keydown', (e) => {
            if (!S) return;
            if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePause(); }
            else if (e.key === '1') selectTower('warm');
            else if (e.key === '2') selectTower('candle');
            else if (e.key === 'Escape') { S.sel = null; S.ghost = null; updateBar(); if (!running) draw(); }
        });
        on(els.canvas, 'click', (e) => { const p = canvasXY(e); tryPlace(p.x, p.y); });
        on(els.canvas, 'contextmenu', (e) => { e.preventDefault(); const p = canvasXY(e); tryRemove(p.x, p.y); });
        on(els.canvas, 'mousemove', (e) => { if (!S) return; S.ghost = canvasXY(e); if (!running) draw(); });
        on(els.canvas, 'mouseleave', () => { if (!S) return; S.ghost = null; if (!running) draw(); });
    }

    // ---------- 生命周期 ----------
    function start(opts) {
        try {
            stop(); // 幂等清场
            els = opts;
            AudioSys.load();
            if (els.mute) els.mute.textContent = AudioSys.muted ? '🔇' : '🔊';
            S = newState();
            S.ch = new BroadcastChannel('yueyue-sync');
            els.canvas.width = W; els.canvas.height = H;
            ctx = els.canvas.getContext('2d');
            buildBar();
            buildChoice(); // r196 S2
            bind();
            // r196 S1: 首次进入(第1夜)给一句引导, 之后用陈述池
            setSay((S.n === 1 ? LINES.guide : pickLine(LINES.start)) + lookAheadLine(S.plan, 0));
            updateBar();
            startLoop();
            console.log('[守夜] 第' + S.n + '夜开始 mood=' + S.mood + ' seed=' + S.seed + ' 雾量=' + S.waveCounts.join('/') + ' speed=' + dbgSpeed + (dbgLight != null ? ' light=' + dbgLight : ''));
            return true;
        } catch (e) {
            console.error('[守夜] 初始化失败(回退菜单, 不影响其它游戏)', e);
            try { stop(); } catch (e2) { /* 忽略 */ }
            return false;
        }
    }
    function stop() {
        stopLoop();
        try { if (AudioSys.ctx && AudioSys.ctx.state === 'running') AudioSys.ctx.suspend(); } catch (e) { /* 忽略 */ }
        for (const l of listeners) { try { l[0].removeEventListener(l[1], l[2]); } catch (e) { /* 忽略 */ } }
        listeners = [];
        if (S && S.ch) { try { S.ch.close(); } catch (e) { /* 忽略 */ } }
        S = null;
        if (els) {
            try { els.bar.innerHTML = ''; } catch (e) { /* 忽略 */ }
            try { if (els.choice) { els.choice.innerHTML = ''; els.choice.style.display = 'none'; } } catch (e) { /* 忽略 */ }
            try { els.say.textContent = ''; } catch (e) { /* 忽略 */ }
            const ov = document.getElementById('nightSettle');
            if (ov) ov.remove();
        }
        els = null; ctx = null;
        btnT = {}; btnWord = null; btnBack = null; btnChoice = {};
    }
    window.NightGame = {
        version: 'mvp3-r196-20261124',
        start, stop,
        __seedOverride: null, // 测试钩子: 数字种子覆盖日期种子(正常玩为null); API 形状不变
        get state() {
            return S ? {
                n: S.n, mood: S.mood, light: S.light, wick: S.wick, wave: S.wave + 1, cleared: S.cleared, phase: S.phase,
                fogs: S.fogs.length, towers: S.towers.length, paused: S.paused, wordLeft: S.wordLeft,
                seed: S.seed, waves: S.waveCounts.slice(), lastWave: S.lastWave,
                plan: S.plan.map((p) => ({ type: p.type, lane: p.lane, speed: Math.round(p.speed * 1000) / 1000 })),
                parts: S.parts.length, placeFx: S.placeFx ? { x: S.placeFx.x, y: S.placeFx.y } : null,
                pop: S.towers.length ? S.towers[S.towers.length - 1].pop : 0,
                muted: AudioSys.muted, audio: !!AudioSys.ctx, shake: S.shake > 0,
                // r196 探针可读: 两灯定义/抉择/推荐落点/持续清雾/掉格/雾血量
                towerDefs: { warm: { cost: TOWERS.warm.cost, radius: TOWERS.warm.radius, dps: TOWERS.warm.dps }, candle: { cost: TOWERS.candle.cost, radius: TOWERS.candle.radius, dps: TOWERS.candle.dps } },
                towerKinds: S.towers.map((t) => t.kind),
                guard: S.guard, choiceAvail: S.choiceAvail, choicePicked: S.choicePicked,
                sel: S.sel, ghost: S.ghost ? { x: Math.round(S.ghost.x), y: Math.round(S.ghost.y) } : null,
                suggest: S.suggest.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
                clearing: S.towers.filter((t) => t.clearing).length, leakFx: S.leakFx > 0,
                fogHp: S.fogs.map((f) => Math.round(f.hp * 100) / 100),
            } : null;
        },
    };
})();