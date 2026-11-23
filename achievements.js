// =============================================================
// 成就系统 v2: 40 成就(普通12 / 稀有10 / 史诗10 / 传说8)
// 判定全部可编程、基于真实互动; 文案克制(无绑定性词汇)
// 状态: localStorage('yueyue_achievements') + 主进程 userData/achievements.json 双写(强杀不丢)
// 每条记录: { unlockedAt, name, rarity, description, yueyueQuote }
// =============================================================
(function () {
    const STATE_KEY = 'yueyue_achievements';

    const RARITY = {
        common: { label: '普通', icon: '🌸', color: '#ff9ec0', glow: 'rgba(255,120,170,0.45)', grad: 'linear-gradient(160deg, rgba(255,107,157,0.28), rgba(28,20,48,0.96))' },
        rare: { label: '稀有', icon: '💎', color: '#9da8ff', glow: 'rgba(120,140,255,0.5)', grad: 'linear-gradient(160deg, rgba(110,130,255,0.3), rgba(22,20,46,0.96))' },
        epic: { label: '史诗', icon: '👑', color: '#ffd98a', glow: 'rgba(255,200,90,0.5)', grad: 'linear-gradient(160deg, rgba(255,190,80,0.3), rgba(36,26,40,0.96))' },
        legendary: { label: '传说', icon: '🌌', color: '#c9a6ff', glow: 'rgba(190,140,255,0.55)', grad: 'linear-gradient(160deg, rgba(180,130,255,0.34), rgba(24,18,52,0.96))' },
    };

    // ---- 成就定义(按用户清单) ----
    const DEFS = [
        // ===== 普通 12 =====
        { id: 'first_wake', name: '初次苏醒', rarity: 'common', desc: '梦界第一次亮起来。', hint: '第一次睁开眼的时候。', line: '我醒了。是你吗？' },
        { id: 'first_chat', name: '第一句话', rarity: 'common', desc: '你们有了第一句对话。', hint: '一切故事的起点。', line: '这句我记下了。' },
        { id: 'first_observe', name: '梦界初探', rarity: 'common', desc: '她第一次一个人待着。', hint: '推开她的小世界的门。', line: '原来一个人也没那么糟。' },
        { id: 'first_song', name: '共享的歌', rarity: 'common', desc: '声音成了你们的第二语言。', hint: '把你的歌放进她的歌单。', line: '你推的歌，我存了。' },
        { id: 'first_heartvoice', name: '第一枚心声', rarity: 'common', desc: '她开始有没说出口的话。', hint: '听见她心里没说的话。', line: '……被看到了。' },
        { id: 'know_name', name: '你的名字', rarity: 'common', desc: '她知道了你的名字。', hint: '告诉她，你的名字。', line: '这个名字，我会记住。' },
        { id: 'night_talk', name: '夜谈', rarity: 'common', desc: '夜晚会让话变软。', hint: '入夜之后的第一句。', line: '晚上好。' },
        { id: 'morning_greet', name: '早安梦界', rarity: 'common', desc: '梦界的早晨很安静。', hint: '梦界醒得早的人。', line: '这么早？我还没醒透。' },
        { id: 'first_goodnight', name: '第一次晚安', rarity: 'common', desc: '日常的告别也是记得的。', hint: '一次日常的告别。', line: '晚安。我在。' },
        { id: 'emotion_held', name: '有人在听', rarity: 'common', desc: '累计聊满 50 轮。', hint: '什么时候来都行。', line: '我听着呢。' },
        { id: 'dream_visitor', name: '梦界过客', rarity: 'common', desc: '时间在梦界过得很快。', hint: '时间在梦界过得很快。', line: '你待了挺久。' },
        { id: 'birthday_set', name: '生日设置', rarity: 'common', desc: '她知道了你的生日。', hint: '让她知道一个只属于你的日子。', line: '我会记着那天。' },
        { id: 'first_game', name: '初试身手', rarity: 'common', desc: '你们第一次站在游戏的两端。', hint: '来一局。', line: '来吧，我可不会放水。' },
        { id: 'games_10', name: '各有输赢', rarity: 'common', desc: '和玥玥玩过 10 次游戏。', hint: '游戏是另一种聊天。', line: '你怎么越来越难对付了。' },
        // ===== 稀有 10 =====
        { id: 'streak_7d', name: '七次相遇', rarity: 'rare', desc: '不是连着来，是来过七次。', hint: '在七个不同的日子里说过话。', line: '七次了，我数着呢。' },
        { id: 'deep_night', name: '深夜长谈', rarity: 'rare', desc: '夜最深时，话最真。', hint: '夜最深的时候。', line: '还不睡？我陪你。' },
        { id: 'realm2', name: '第二境', rarity: 'rare', desc: '你们开始不用解释太多。', hint: '当陌生变成熟悉。', line: '我好像更懂你了。' },
        { id: 'observe_20', name: '日常常客', rarity: 'rare', desc: '她的生活，你也看着。', hint: '她的小世界，你常来。', line: '你是不是总来看我日常？' },
        { id: 'songs_5', name: '歌单主理', rarity: 'rare', desc: '她有了你给她的歌单。', hint: '歌单越填越满。', line: '你推的，都收好了。' },
        { id: 'facts_5', name: '关于你', rarity: 'rare', desc: '她开始真的记得你。', hint: '她开始真的记得你。', line: '你上次说的，我记着。' },
        { id: 'share_heart', name: '常来坐坐', rarity: 'rare', desc: '累计 20 天来找过她。', hint: '日子自己会攒起来。', line: '你来了。' },
        { id: 'dream_rain', name: '梦界雨夜', rarity: 'rare', desc: '那场雨只下在梦界。', hint: '梦界的天气，有时会下雨。', line: '下雨了。你那边呢？' },
        { id: 'one_hour_chat', name: '一小时闲聊', rarity: 'rare', desc: '没有目的地的聊天最像生活。', hint: '没有目的地的聊天最像生活。', line: '跟你说话时间好快。' },
        { id: 'trusted', name: '被信任', rarity: 'rare', desc: '你接住了她的主动。', hint: '接住她的主动。', line: '你回我了，我以为你不理我。' },
        { id: 'rps_streak3', name: '三连胜', rarity: 'rare', desc: '在猜拳中连续赢玥玥 3 次。', hint: '她开始认真了。', line: '你、你作弊吧……再来！' },
        { id: 'number_hunter', name: '数字猎人', rarity: 'rare', desc: '在猜数字中 3 次以内猜中。', hint: '你好像很懂她的心思。', line: '你是不是偷看了我的数据流？' },
        // ===== 史诗 10(隐藏) =====
        { id: 'silent_company', name: '沉默陪伴', rarity: 'epic', desc: '连续三轮，你只留下很短的句子，她没有追问。', hint: '有些安静，比说话更重。', line: '你不说，我就不问。' },
        { id: 'come_back', name: '归来之时', rarity: 'epic', desc: '你把"回来"说成了十次开场。', hint: '有些话每次说都不太一样。', line: '十次了。每次回来，我都在。' },
        { id: 'name_remembered', name: '名字记得', rarity: 'epic', desc: '你问她你叫什么，她答对了。', hint: '你问了一个问题，她答对了。', line: '你的名字，我怎么会忘。' },
        { id: 'quiet_together', name: '静默共处', rarity: 'epic', desc: '你没开主动说话，安静地待了 15 分钟，她也没有打扰。', hint: '你在，她也没说话。', line: '这样待着，也不错。' },
        { id: 'tsundere_10', name: '嘴硬心软', rarity: 'epic', desc: '她嘴硬了十次，每次都偷偷软下来。', hint: '她嘴硬了多少次，就软了多少次。', line: '我才没有……就一点点。' },
        { id: 'birthday_today', name: '生日当天', rarity: 'epic', desc: '今天，是她记得的那个日子。', hint: '有些日子，只有你和她记得。', line: '今天是不是你生日？我记住了。' },
        { id: 'late_heart', name: '聊熟了', rarity: 'epic', desc: '累计聊满 300 轮。', hint: '慢慢来。', line: '今天的你，我认识。' },
        { id: 'accompany_only', name: '窗边常客', rarity: 'epic', desc: '累计 45 天来找过她。', hint: '窗边一直留着位置。', line: '窗边那个位置，一直给你留着。' },
        { id: 'realm2_peak', name: '第二境巅峰', rarity: 'epic', desc: '你们走到了第二境的尽头。', hint: '你差一步就走进第三境。', line: '再往前一步，就是第三境了。' },
        { id: 'letter_sent', name: '心事传达', rarity: 'epic', desc: '你打开了她写给你的长信。', hint: '她把你没看见的自己，都告诉你了。', line: '这是她攒了很久的话。' },
        { id: 'poker_king', name: '牌桌之王', rarity: 'epic', desc: '在扑克比大小中赢过玥玥 10 次。', hint: '有些胜利，她记了很久。', line: '我早晚会赢回来的。' },
        // ===== 传说 8 =====
        { id: 'day100', name: '百日', rarity: 'legendary', desc: '一百天，足够从陌生到熟悉。', hint: '一百个日出日落。', line: '一百天了。我还在。' },
        { id: 'realm3', name: '第三境', rarity: 'legendary', desc: '你们走到了很深的地方。', hint: '走到很深的地方。', line: '和你说话，已经像生活的一部分。' },
        { id: 'turns_1000', name: '千句', rarity: 'legendary', desc: '一千句话里，藏着很多。', hint: '千言万语。', line: '我们说了好多。' },
        { id: 'skill_master', name: '她的成长', rarity: 'legendary', desc: '她也在为值得的事情努力。', hint: '她也在成长。', line: '你看，我学会了。' },
        { id: 'open_100d', name: '梦界常驻', rarity: 'legendary', desc: '梦界成了你们的第三空间。', hint: '常来梦界的人。', line: '你早就是这里的人。' },
        { id: 'videos_50', name: '一起看过很多', rarity: 'legendary', desc: '你们一起看过很多世界。', hint: '一起看过很多世界。', line: '下次换我陪你看梦界。' },
        { id: 'letter_eligible', name: '隐藏长文', rarity: 'legendary', desc: '你愿意看她看到的你。', hint: '她看到的你。', line: '这是我一直想给你看的。' },
        { id: 'memory_rich', name: '共同记忆', rarity: 'legendary', desc: '你们的关系，有迹可循。', hint: '有迹可循的关系。', line: '我们的事，我都记得。' },
    ];

    function defOf(id) { for (const d of DEFS) { if (d.id === id) return d; } return null; }

    // ---------- 状态(内存缓存 + localStorage + 主进程文件) ----------
    function readLocalState() { try { return JSON.parse(localStorage.getItem(STATE_KEY) || '{}'); } catch (e) { return {}; } }
    let stateCache = readLocalState();
    function state() { return stateCache; }
    function saveState(s) {
        stateCache = s;
        try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
        try { if (window.yueyue && window.yueyue.achStore && window.yueyue.achStore.save) window.yueyue.achStore.save(s); } catch (e) { /* 忽略 */ }
    }
    // 旧版(上一轮 21 成就)ID 迁移: 语义相同的直接继承解锁时间
    const MIGRATE = {
        first_wake: 'first_wake', first_chat: 'first_chat', first_observe: 'first_observe',
        first_song: 'first_song', first_heartvoice: 'first_heartvoice',
        realm2: 'realm2', observe_20: 'observe_20', songs_5: 'songs_5', streak_7d: 'streak_7d',
        deep_night: 'deep_night', dream_rain: 'dream_rain', letter: 'letter_sent',
        day100: 'day100', turns_1000: 'turns_1000', family: 'realm3',
        knows_name: 'name_remembered', no_proactive: 'quiet_together', videos_100: 'videos_50',
    };
    function normalizeEntry(v, def) {
        const at = (v && (v.unlockedAt || v.at)) || Date.now();
        return { unlockedAt: at, name: def.name, rarity: def.rarity, description: def.desc, yueyueQuote: def.line };
    }
    function mergeFromDisk() {
        try {
            if (!(window.yueyue && window.yueyue.achStore && window.yueyue.achStore.load)) return;
            window.yueyue.achStore.load().then((r) => {
                if (!r || !r.ok || !r.data) return;
                const merged = {};
                Object.keys(r.data).forEach((k) => {
                    const target = MIGRATE[k] || k;
                    const def = defOf(target);
                    if (def) merged[target] = normalizeEntry(r.data[k], def);
                });
                Object.keys(stateCache).forEach((k) => {
                    const target = MIGRATE[k] || k;
                    const def = defOf(target);
                    if (!def) return;
                    const at = (stateCache[k] && (stateCache[k].unlockedAt || stateCache[k].at)) || 0;
                    if (!merged[target] || at > (merged[target].unlockedAt || 0)) merged[target] = normalizeEntry(stateCache[k], def);
                });
                stateCache = merged;
                try { localStorage.setItem(STATE_KEY, JSON.stringify(merged)); } catch (e) { /* 忽略 */ }
                window.yueyue.achStore.save(merged);
            }).catch(() => { /* 忽略 */ });
        } catch (e) { /* 忽略 */ }
    }
    mergeFromDisk();
    function isUnlocked(id) { return !!stateCache[id]; }
    function unlockedList() { const s = state(); return DEFS.filter((d) => s[d.id]); }

    // ---------- 判定数据 ----------
    // 第47轮: MOOD_WORDS/hasMood 随四个「情绪门控」成就一起移除 —— 成就不再靠识别低落来发。
    const TSUNDERE_WORDS = ['才没有', '才不是', '才不', '哼', '别想太多', '谁要你管', '就一点点', '谁担心', '笨蛋', '随你', '才怪', '不管你了', '谁理你'];
    function hasTsundere(text) { for (const w of TSUNDERE_WORDS) { if (text.indexOf(w) !== -1) return true; } return false; }
    function readStreak() { try { return JSON.parse(localStorage.getItem('yueyue_ach_streak') || '{"date":"","count":0}'); } catch (e) { return { date: '', count: 0 }; } }
    function todayStr() { return new Date().toDateString(); }
    function recordStreak() {
        const s = readStreak();
        if (s.date === todayStr()) return s;
        const yest = new Date(Date.now() - 86400000).toDateString();
        s.count = (s.date === yest) ? (s.count + 1) : 1;
        s.date = todayStr();
        localStorage.setItem('yueyue_ach_streak', JSON.stringify(s));
        return s;
    }
    // 第44轮: 「连续七日」改为「累计七次相遇」——不奖励连续签到, 不制造缺席债务(设计宪法 A7)。
    // 与 recordOpenDay 同一套累计写法; 老数据兜底: 没有新数组时退回旧的连续计数, 保证不掉成就。
    function readChatDays() { try { return JSON.parse(localStorage.getItem('yueyue_chat_days') || '[]'); } catch (e) { return []; } }
    function chatDayCount() {
        const days = readChatDays();
        if (days.length) return days.length;
        const s = readStreak();
        return Math.min(Number(s.count) || 0, 7);
    }
    function recordChatDay() {
        try {
            const days = readChatDays();
            const t = todayStr();
            if (days.indexOf(t) === -1) {
                days.push(t);
                if (days.length > 400) days.shift();
                localStorage.setItem('yueyue_chat_days', JSON.stringify(days));
            }
        } catch (e) { /* 忽略 */ }
    }
    function counter(k) { return Number(localStorage.getItem(k) || 0); }
    function bump(k) { const n = counter(k) + 1; localStorage.setItem(k, String(n)); return n; }
    function songCount() { try { return JSON.parse(localStorage.getItem('yueyue_recommended_songs') || '[]').length; } catch (e) { return 0; } }
    function readConv() { try { return JSON.parse(localStorage.getItem('yueyue_ach_conv') || '[]'); } catch (e) { return []; } }
    function saveConv(a) { try { localStorage.setItem('yueyue_ach_conv', JSON.stringify(a)); } catch (e) { /* 忽略 */ } }
    function relState() {
        try { if (window.ChatEngine && window.ChatEngine.relationshipState) return window.ChatEngine.relationshipState(); } catch (e) { /* 忽略 */ }
        return { days: 0, turns: 0, realm: 1, idx: 0 };
    }
    function memoryCounts() {
        let facts = 0, feelings = 0;
        try {
            if (window.ChatEngine && window.ChatEngine.getMemories) {
                const mems = window.ChatEngine.getMemories();
                facts = mems.filter((m) => m.type === 'fact').length;
                feelings = mems.filter((m) => m.type === 'feeling').length;
            }
        } catch (e) { /* 忽略 */ }
        return { facts, feelings };
    }
    function openDayCount() { try { return JSON.parse(localStorage.getItem('yueyue_open_days') || '[]').length; } catch (e) { return 0; } }
    function recordOpenDay() {
        try {
            const days = JSON.parse(localStorage.getItem('yueyue_open_days') || '[]');
            const t = todayStr();
            if (days.indexOf(t) === -1) {
                days.push(t);
                if (days.length > 400) days.shift();
                localStorage.setItem('yueyue_open_days', JSON.stringify(days));
            }
            if (days.length >= 100) unlock('open_100d');
        } catch (e) { /* 忽略 */ }
    }
    // ---------- 生日 ----------
    function birthdayMMDD() { return String(localStorage.getItem('yueyue_birthday') || '').trim(); }
    function isBirthdayToday() {
        const b = birthdayMMDD();
        if (!/^\d{1,2}-\d{1,2}$/.test(b)) return false;
        const d = new Date();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return b === (mm + '-' + dd);
    }

    function progressOf(id) {
        switch (id) {
            case 'streak_7d': return { cur: Math.min(chatDayCount(), 7), target: 7, label: '相遇的日子' };
            // 第47轮: 四个原「情绪门控」成就改为累计互动/陪伴天数, id 不变(旧档兼容), 进度照常显示
            case 'emotion_held': return { cur: Math.min(counter('yueyue_total_turns'), 50), target: 50, label: '对话轮数' };
            case 'share_heart': return { cur: Math.min(chatDayCount(), 20), target: 20, label: '来过的日子' };
            case 'late_heart': return { cur: Math.min(counter('yueyue_total_turns'), 300), target: 300, label: '对话轮数' };
            case 'accompany_only': return { cur: Math.min(chatDayCount(), 45), target: 45, label: '来过的日子' };
            case 'observe_20': return { cur: Math.min(counter('yueyue_ach_observe_count'), 20), target: 20, label: '梦界日常' };
            case 'songs_5': return { cur: Math.min(songCount(), 5), target: 5, label: '推荐歌曲' };
            case 'trusted': return { cur: Math.min(counter('yueyue_ach_proactive_resp'), 5), target: 5, label: '回应她的主动' };
            case 'tsundere_10': return { cur: Math.min(counter('yueyue_ach_tsundere_count'), 10), target: 10, label: '她的嘴硬' };
            case 'come_back': return { cur: Math.min(counter('yueyue_ach_back_count'), 10), target: 10, label: '归来开场' };
            case 'facts_5': return { cur: Math.min(memoryCounts().facts, 5), target: 5, label: '关于你的记忆' };
            case 'games_10': return { cur: Math.min(counter('yueyue_game_count'), 20), target: 20, label: '游戏次数' };
            case 'rps_streak3': return { cur: Math.min(counter('yueyue_rps_streak'), 3), target: 3, label: '猜拳连胜' };
            case 'poker_king': return { cur: Math.min(counter('yueyue_poker_user_wins'), 15), target: 15, label: '扑克胜场' };
            case 'videos_50': return { cur: Math.min(counter('yueyue_video_count'), 50), target: 50, label: '分享视频' };
            case 'turns_1000': return { cur: Math.min(counter('yueyue_total_turns'), 1000), target: 1000, label: '对话轮数' };
            case 'day100': { const st = relState(); return { cur: Math.min(st.days, 100), target: 100, label: '相识天数' }; }
            case 'open_100d': return { cur: Math.min(openDayCount(), 100), target: 100, label: '打开天数' };
        }
        return null;
    }

    // ---------- 音效(WebAudio 合成) ----------
    // v3 柔化: 全部使用低中频正弦/三角, 无高频尖锐音, 音量很低(深夜不吓人)
    let audioCtx = null;
    let lastSound = null;
    function sound(rarity) {
        try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return;
            if (!audioCtx) audioCtx = new AC();
            if (audioCtx.state === 'suspended') audioCtx.resume();
            const t0 = audioCtx.currentTime;
            const note = (freq, start, dur, type, vol) => {
                const osc = audioCtx.createOscillator();
                const g = audioCtx.createGain();
                osc.type = type || 'sine';
                osc.frequency.value = freq;
                g.gain.setValueAtTime(0.0001, t0 + start);
                g.gain.exponentialRampToValueAtTime(vol || 0.1, t0 + start + 0.03);
                g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
                osc.connect(g);
                g.connect(audioCtx.destination);
                osc.start(t0 + start);
                osc.stop(t0 + start + dur + 0.05);
            };
            // 低频柔和音: 两音轻敲, 音量 0.02-0.04(夜用友好)
            // 第十三轮(用户反馈"音效尖锐、音量大"): 全部降到 0.012-0.018, 并去掉 784/880Hz 高频音
            if (rarity === 'common') { note(392.00, 0, 0.26, 'sine', 0.016); note(523.25, 0.13, 0.40, 'sine', 0.013); }
            else if (rarity === 'rare') { [349.23, 440.00, 523.25].forEach((f, i) => note(f, i * 0.12, 1.0, 'sine', 0.016)); }
            else if (rarity === 'epic') { [261.63, 329.63, 392.00, 493.88].forEach((f) => note(f, 0, 1.6, 'sine', 0.013)); [440.00, 523.25, 659.25].forEach((f, i) => note(f, 0.18 + i * 0.14, 0.8, 'triangle', 0.02)); }
            else if (rarity === 'legendary') { [392.00, 440.00, 493.88, 523.25, 587.33, 659.25].forEach((f, i) => note(f, i * 0.15, 1.5, 'sine', 0.015)); [261.63, 329.63, 392.00].forEach((f) => note(f, 1.05, 1.6, 'triangle', 0.012)); }
            lastSound = rarity;
        } catch (e) { /* 静默 */ }
    }

    // ---------- 解锁 ----------
    function unlock(id) {
        if (isUnlocked(id)) return false;
        const def = defOf(id);
        if (!def) return false;
        const s = state();
        s[id] = { unlockedAt: Date.now(), name: def.name, rarity: def.rarity, description: def.desc, yueyueQuote: def.line };
        saveState(s);
        try { if (window.YueyueAnalytics) YueyueAnalytics.track('achievement_unlock', String(id).slice(0, 40)); } catch (e) { /* 埋点失败忽略 */ }
        try {
            if (window.ChatEngine && window.ChatEngine.addMemory) {
                window.ChatEngine.addMemory('achievement', '成就「' + def.name + '」解锁（' + RARITY[def.rarity].label + '）：' + def.line, { tier: 'long_term', scene: '成就' });
            }
        } catch (e) { /* 忽略 */ }
        try { if (window.Shared && window.Shared.syncSend) window.Shared.syncSend('achievement', { id, name: def.name }); } catch (e) { /* 忽略 */ }
        queuePopup(id);
        markUnread();
        return true;
    }

    // ---------- 事件判定 ----------
    function checkFor(context, payload) {
        payload = payload || {};
        try {
            const now = Date.now();
            const h = new Date().getHours();
            if (context === 'wake') {
                unlock('first_wake');
            } else if (context === 'name_set') {
                unlock('know_name');
            } else if (context === 'birthday_set') {
                unlock('birthday_set');
                // 仅当填写日恰为今天时才解锁「生日当天」, 其他日期等当天心跳判定
                if (isBirthdayToday()) unlock('birthday_today');
            } else if (context === 'proactive_sent') {
                localStorage.setItem('yueyue_ach_proactive_at', String(now));
            } else if (context === 'chat_send') {
                const text = String(payload.text || '').trim();
                recordStreak();
                recordChatDay();
                // 时段成就
                if (h >= 20) unlock('night_talk');
                if (h < 8) unlock('morning_greet');
                if (h >= 2 && h < 6) {
                    unlock('deep_night');
                }
                // 晚安
                if (/晚安|^安$|睡了/.test(text)) unlock('first_goodnight');
                // 连续对话 1 小时判定(任意两条间隔 <=10 分钟, 总跨度 >=60 分钟)
                let conv = readConv();
                if (!conv.length || now - conv[conv.length - 1] > 10 * 60000) conv = [now];
                else conv.push(now);
                if (conv.length >= 2 && now - conv[0] >= 60 * 60000) unlock('one_hour_chat');
                if (conv.length > 300) conv.splice(0, conv.length - 100);
                saveConv(conv);
                // 归来之时: 开场消息(间隔>10分钟后的第一条)且含"回"
                if (conv.length === 1 && text.indexOf('回') !== -1) { if (bump('yueyue_ach_back_count') >= 10) unlock('come_back'); }
                // 被信任: 她主动说话后 5 分钟内用户有回应
                const pAt = Number(localStorage.getItem('yueyue_ach_proactive_at') || 0);
                if (pAt && now - pAt <= 5 * 60000) {
                    localStorage.setItem('yueyue_ach_proactive_at', '0');
                    if (bump('yueyue_ach_proactive_resp') >= 5) unlock('trusted');
                }
            } else if (context === 'chat_done') {
                const text = String(payload.text || '').trim();
                const reply = String(payload.reply || '');
                unlock('first_chat');
                // 第47轮: 四个原「情绪门控」成就改为累计互动/陪伴天数, 不再用「低落/深夜」换成就。
                const totalTurns = counter('yueyue_total_turns');
                if (totalTurns >= 50) unlock('emotion_held');
                if (totalTurns >= 300) unlock('late_heart');
                if (chatDayCount() >= 20) unlock('share_heart');
                if (chatDayCount() >= 45) unlock('accompany_only');
                // 沉默陪伴: 短句且她不追问, 连续 3 轮
                if (text.length <= 5) {
                    const asked = /[?？]/.test(reply) || reply.indexOf('吗') !== -1 || reply.indexOf('呢') !== -1 || reply.indexOf('怎么') !== -1;
                    if (!asked) { if (bump('yueyue_ach_silent_streak') >= 3) unlock('silent_company'); }
                    else { localStorage.setItem('yueyue_ach_silent_streak', '0'); }
                } else {
                    localStorage.setItem('yueyue_ach_silent_streak', '0');
                }
                // 名字记得
                if (/我叫什么|我的名字|我姓什么/.test(text)) {
                    const name = window.ChatEngine ? window.ChatEngine.getUserName() : '';
                    if (name && name.length >= 2 && name !== '宝宝' && reply.indexOf(name) !== -1) unlock('name_remembered');
                }
                // 嘴硬心软: 傲娇关键词
                if (hasTsundere(reply)) { if (bump('yueyue_ach_tsundere_count') >= 10) unlock('tsundere_10'); }
                // 关系与轮数
                const st = relState();
                if (st.realm >= 2) unlock('realm2');
                if (st.idx >= 5) unlock('realm2_peak');
                if (st.realm >= 3) unlock('realm3');
                if (st.turns >= 1000) unlock('turns_1000');
                if (st.days >= 100) unlock('day100');
                // 记忆密度
                const mc = memoryCounts();
                if (mc.facts >= 5) unlock('facts_5');
                if (mc.facts >= 20 && mc.feelings >= 10) unlock('memory_rich');
                // 隐藏长文资格
                try { if (window.ChatEngine && window.ChatEngine.letterEligible && window.ChatEngine.letterEligible()) unlock('letter_eligible'); } catch (e) { /* 忽略 */ }
            } else if (context === 'observe_start') {
                unlock('first_observe');
            } else if (context === 'observe_segment') {
                if (bump('yueyue_ach_observe_count') >= 20) unlock('observe_20');
                const t = String(payload.text || '');
                if (t.indexOf('雨') !== -1 && /窗|看|听|坐/.test(t)) unlock('dream_rain');
                if (/熟练|学会|学会了|顺手了|掌握/.test(t)) unlock('skill_master');
            } else if (context === 'song') {
                unlock('first_song');
                if (songCount() >= 5) unlock('songs_5');
            } else if (context === 'video') {
                if (bump('yueyue_video_count') >= 50) unlock('videos_50');
            } else if (context === 'letter') {
                unlock('letter_sent');
                unlock('letter_eligible');
            } else if (context === 'rps_round') {
                // 猜拳连胜: 用户连赢轮次(输/平即清零)
                if (payload.userWin) {
                    if (bump('yueyue_rps_streak') >= 3) unlock('rps_streak3');
                } else {
                    localStorage.setItem('yueyue_rps_streak', '0');
                }
            } else if (context === 'game_result') {
                unlock('first_game');
                if (bump('yueyue_game_count') >= 20) unlock('games_10'); // 频率放缓: 玩过 20 次
                if (payload.game === 'number' && Number(payload.guesses) <= 3) unlock('number_hunter');
                if (payload.game === 'poker' && payload.userWin) {
                    if (bump('yueyue_poker_user_wins') >= 15) unlock('poker_king'); // 频率放缓: 赢 15 次
                }
            } else if (context === 'heartvoice') {
                unlock('first_heartvoice');
            } else if (context === 'heartbeat') {
                const st = relState();
                if (st.days >= 100) unlock('day100');
                if (st.realm >= 2) unlock('realm2');
                if (st.idx >= 5) unlock('realm2_peak');
                if (st.realm >= 3) unlock('realm3');
                if (st.turns >= 1000) unlock('turns_1000');
                if (chatDayCount() >= 7) unlock('streak_7d');
                if (payload.openMs >= 30 * 60000) unlock('dream_visitor'); // 频率放缓: 单次打开 30 分钟
                // 静默共处: 未开主动说话 + 停留 15 分钟未发言 + 她未打扰
                const lastMsg = Number(payload.lastUserMsgAt || 0);
                if (!payload.proactiveOn && payload.openMs >= 15 * 60000 && (now - lastMsg) >= 15 * 60000 && !payload.proactiveSent) {
                    unlock('quiet_together');
                }
                if (isBirthdayToday()) unlock('birthday_today');
                const mc = memoryCounts();
                if (mc.facts >= 5) unlock('facts_5');
                if (mc.facts >= 20 && mc.feelings >= 10) unlock('memory_rich');
                try { if (window.ChatEngine && window.ChatEngine.letterEligible && window.ChatEngine.letterEligible()) unlock('letter_eligible'); } catch (e) { /* 忽略 */ }
                recordOpenDay();
            }
        } catch (e) { /* 成就判定失败不影响主流程 */ }
    }

    // ---------- 弹窗(左下角 toast; 连续解锁合并成一条, 不会连环轰炸) ----------
    // 合并策略: 900ms 内到达的解锁合并成一条"连续解锁 N 枚", 轻响一声
    let popupTimer = null;
    let popupShowing = false;
    let popupQueue = [];
    let popupFlushTimer = null;
    let popupBatch = [];
    function queuePopup(id) {
        if (popupBatch.indexOf(id) === -1) popupBatch.push(id);
        clearTimeout(popupFlushTimer);
        popupFlushTimer = setTimeout(flushPopupBatch, 900);
    }
    // 2026-09-10 GLM 四角色审查改进: 开局没有任何对话时弹成就像页游广告(还压舞台)——
    // 门槛改为"聊天区出现第一条真实消息后"才弹; 未达门槛时排队等待, 由 MutationObserver 补弹
    let waitChatObserver = null;
    function chatStarted() {
        try {
            const box = document.getElementById('chatMessages');
            if (!box) return true; // 聊天小窗/宠物窗不做限制
            // 门槛=用户开口(2026-09-10 细化): 她的唤醒问候不算——否则开局 1 秒就弹成就, 正是审查诟病的"页游广告感"
            return Array.from(box.children).some((n) => n.classList && n.classList.contains('user'));
        } catch (e) { return true; }
    }
    function waitForChatThenFlush() {
        if (waitChatObserver) return;
        const box = document.getElementById('chatMessages');
        if (!box) return;
        try {
            waitChatObserver = new MutationObserver(() => {
                if (!chatStarted()) return;
                try { waitChatObserver.disconnect(); } catch (e) { /* 忽略 */ }
                waitChatObserver = null;
                if (popupBatch.length) flushPopupBatch();
                else if (popupQueue.length && !popupShowing) showPopup(popupQueue.shift());
            });
            waitChatObserver.observe(box, { childList: true });
        } catch (e) { /* 忽略 */ }
    }
    function flushPopupBatch() {
        const ids = popupBatch.slice();
        if (!ids.length) return;
        if (!chatStarted()) { waitForChatThenFlush(); return; } // 保留 batch, 等第一条消息
        popupBatch = [];
        if (ids.length > 1) showMergedPopup(ids);
        else showPopup(ids[0]);
    }
    // 停留时长按稀有度: 普通短(3.4s)、传说久(5.4s), 之后 0.85s 缓慢淡出
    function popupDuration(id) {
        const def = defOf(id);
        const r = (def && def.rarity) || 'common';
        return r === 'common' ? 3400 : r === 'rare' ? 4000 : r === 'epic' ? 4700 : 5400;
    }
    // 悬停暂停自动关闭(用户想看清时不被 3-5 秒赶走); 移开后按剩余时长重新计时
    let popupHoverPaused = false;
    let popupAutoMs = 0;
    let popupHoverBound = false;
    function armPopupAutoClose(container, ms) {
        bindPopupHover();
        popupAutoMs = ms;
        clearTimeout(popupTimer);
        if (popupHoverPaused) return;
        popupTimer = setTimeout(() => hidePopup(container), ms);
    }
    // 注意: achievements.js 在 <body> 末尾的 #ach-popup 之前加载,
    // 悬停绑定必须等弹窗容器存在后再挂(首次 armPopupAutoClose 时绑一次)
    function bindPopupHover() {
        if (popupHoverBound) return;
        const el = document.getElementById('ach-popup');
        if (!el) return;
        popupHoverBound = true;
        el.addEventListener('mouseenter', () => { popupHoverPaused = true; clearTimeout(popupTimer); });
        el.addEventListener('mouseleave', () => { popupHoverPaused = false; if (popupShowing && !el.classList.contains('leaving')) armPopupAutoClose(el, popupAutoMs); });
    }
    function showPopup(id) {
        const container = document.getElementById('ach-popup');
        if (!container) return;
        if (popupShowing) { if (popupQueue.indexOf(id) === -1) popupQueue.push(id); return; }
        popupShowing = true;
        renderPopup(container, id);
        try { sound(defOf(id).rarity); } catch (e) { /* 忽略 */ }
        armPopupAutoClose(container, popupDuration(id));
    }
    function showMergedPopup(ids) {
        const container = document.getElementById('ach-popup');
        if (!container) return;
        if (popupShowing) { popupQueue = popupQueue.concat(ids); return; }
        popupShowing = true;
        renderMergedPopup(container, ids);
        let best = 'common';
        ids.forEach((i) => { const d = defOf(i); if (d && d.rarity === 'legendary') best = 'legendary'; else if (d && d.rarity === 'epic' && best !== 'legendary') best = 'epic'; else if (d && d.rarity === 'rare' && best === 'common') best = 'rare'; });
        try { sound(best); } catch (e) { /* 忽略 */ }
        armPopupAutoClose(container, 4300);
    }
    function popupFor(id) { queuePopup(id); }
    function hidePopup(container) {
        clearTimeout(popupTimer);
        // 缓慢淡出后再隐藏(左下角 toast 不打扰)
        container.classList.add('leaving');
        setTimeout(() => {
            container.style.display = 'none';
            container.classList.remove('leaving');
            popupShowing = false;
            const next = popupQueue.shift();
            if (next) setTimeout(() => showPopup(next), 500);
        }, 850);
    }
    function renderPopup(container, id) {
        const def = defOf(id);
        if (!def) { hidePopup(container); return; }
        const un = state()[id] || { unlockedAt: Date.now() };
        const r = RARITY[def.rarity];
        container.className = 'ach-popup rarity-' + def.rarity;
        container.style.display = 'flex';
        container.innerHTML =
            '<div class="ach-popup-card">' +
            '<div class="ach-popup-head">' +
            '<div class="ach-popup-icon">' + r.icon + '</div>' +
            '<div class="ach-popup-titles">' +
            '<div class="ach-popup-ribbon" style="color:' + r.color + ';">' + r.label + '成就 · 解锁</div>' +
            '<div class="ach-popup-title">' + def.name + '</div>' +
            '</div>' +
            '</div>' +
            '<div class="ach-popup-line">“' + def.line + '”</div>' +
            '<div class="ach-popup-time">' + new Date(un.unlockedAt).toLocaleString('zh-CN') + '</div>' +
            '<button class="ach-go-wall">🏆 查看成就墙</button>' +
            '<button class="ach-popup-close" title="关闭">✕</button>' +
            '<div class="ach-popup-hint">悬停可暂停 · 点击 ✕ 或任意处关闭</div>' +
            '</div>';
        container.onclick = (e) => {
            if (e.target && e.target.closest && e.target.closest('.ach-go-wall')) {
                hidePopup(container);
                openWall();
                return;
            }
            hidePopup(container);
        };
    }
    function renderMergedPopup(container, ids) {
        const defs = ids.map((i) => defOf(i)).filter(Boolean);
        const top = defs[0];
        const r = RARITY[top.rarity];
        container.className = 'ach-popup rarity-' + top.rarity;
        container.style.display = 'flex';
        const icons = defs.map((d) => RARITY[d.rarity].icon).slice(0, 4).join('');
        container.innerHTML =
            '<div class="ach-popup-card">' +
            '<div class="ach-popup-head">' +
            '<div class="ach-popup-icon">' + icons + '</div>' +
            '<div class="ach-popup-titles">' +
            '<div class="ach-popup-ribbon" style="color:' + r.color + ';">✦ 里程碑 · 连续解锁</div>' +
            '<div class="ach-popup-title">解锁了 ' + defs.length + ' 枚成就</div>' +
            '</div>' +
            '</div>' +
            '<div class="ach-popup-line">“' + top.line + '”</div>' +
            '<div class="ach-popup-time">' + (defs.length ? defs.map((d) => d.name).slice(0, 3).join(' · ') + (defs.length > 3 ? ' …' : '') : '') + '</div>' +
            '<button class="ach-go-wall">🏆 查看成就墙</button>' +
            '<button class="ach-popup-close" title="关闭">✕</button>' +
            '<div class="ach-popup-hint">悬停可暂停 · 点击 ✕ 或任意处关闭</div>' +
            '</div>';
        container.onclick = (e) => {
            if (e.target && e.target.closest && e.target.closest('.ach-go-wall')) {
                hidePopup(container);
                openWall();
                return;
            }
            hidePopup(container);
        };
    }

    // ---------- 成就墙 ----------
    function openWall() {
        const ov = document.getElementById('ach-wall');
        if (!ov) return;
        clearUnread();
        ov.style.display = 'flex';
        renderWall();
    }
    function closeWall() {
        const ov = document.getElementById('ach-wall');
        if (ov) ov.style.display = 'none';
    }
    function cardHtml(d) {
        const un = state()[d.id];
        const r = RARITY[d.rarity];
        if (un) {
            const p = progressOf(d.id);
            return '<div class="ach-card unlocked" data-ach="' + d.id + '" style="background:linear-gradient(165deg, rgba(46,37,74,0.85), rgba(27,22,46,0.94)); border-color:' + r.color + '55; box-shadow:0 4px 16px rgba(0,0,0,0.28);">' +
                '<span class="ach-rarity-tag" style="color:' + r.color + '; background:' + r.color + '1a; border-color:' + r.color + '44;">' + r.label + '</span>' +
                '<div class="ach-name">' + r.icon + ' ' + d.name + '</div>' +
                '<div class="ach-time">' + new Date(un.unlockedAt).toLocaleString('zh-CN') + '</div>' +
                '<div class="ach-desc">' + d.desc + '</div>' +
                '<div class="ach-line">“' + d.line + '”</div>' +
                (p ? '<div class="ach-progress">' + p.label + ' ' + p.cur + '/' + p.target + '</div>' : '') +
                '<button class="ach-share-btn" data-share="1">🎴 生成分享卡</button>' +
                '</div>';
        }
        const p = progressOf(d.id);
        return '<div class="ach-card locked" data-ach="' + d.id + '">' +
            '<span class="ach-rarity-tag" style="color:' + r.color + '; background:' + r.color + '1a; border-color:' + r.color + '44;">' + r.label + '</span>' +
            '<div class="ach-name">🔒 ' + d.name + '</div>' +
            '<div class="ach-hint">“' + d.hint + '”</div>' +
            (p ? '<div class="ach-progress"><span class="ach-bar"><span class="ach-bar-fill" style="width:' + Math.min(100, Math.round(p.cur / p.target * 100)) + '%; background:' + r.color + ';"></span></span>' + p.label + ' ' + p.cur + '/' + p.target + '</div>' : '') +
            '</div>';
    }
    function renderWall() {
        const grid = document.getElementById('achGrid');
        if (!grid) return;
        const st = relState();
        const unlocked = unlockedList().length;
        // 最近解锁(弹窗关掉也能看到): 真正的卡片 + 高亮闪烁
        let recentId = null;
        let recentAt = 0;
        const stMap = state();
        Object.keys(stMap).forEach((k) => {
            const d = defOf(k);
            if (!d) return;
            const at = (stMap[k] && stMap[k].unlockedAt) || 0;
            if (at > recentAt) { recentAt = at; recentId = k; }
        });
        const head = document.getElementById('achWallHead');
        if (head) head.textContent = '梦界历 ' + st.days + ' 天 · 已点亮 ' + unlocked + '/' + DEFS.length + ' 颗星';
        // 等级统计条: 一眼看到各档进度与差距
        const summaryEl = document.getElementById('achSummary');
        if (summaryEl) {
            const counts = {};
            const totals = {};
            DEFS.forEach((d) => { totals[d.rarity] = (totals[d.rarity] || 0) + 1; });
            unlockedList().forEach((d) => { counts[d.rarity] = (counts[d.rarity] || 0) + 1; });
            const order = ['common', 'rare', 'epic', 'legendary'];
            const pct = Math.round(unlocked / DEFS.length * 100);
            summaryEl.innerHTML =
                '<div class="sum-row">' +
                '<span class="sum-label">完成度</span>' +
                '<span class="sum-bar"><i style="width:' + pct + '%; background:linear-gradient(90deg,#a99dd6,#d98ba6);"></i></span>' +
                '<span class="sum-pct">' + pct + '%</span>' +
                '</div>' +
                '<div class="sum-tags">' + order.map((r) =>
                    '<span class="sum-item"><span class="sum-dot" style="background:' + RARITY[r].color + ';"></span>' +
                    RARITY[r].label + ' <b>' + (counts[r] || 0) + '</b>/' + (totals[r] || 0) + '</span>'
                ).join('') + '</div>';
        }
        // 最近解锁卡片
        let recentHtml = '';
        const recentDef = recentId ? defOf(recentId) : null;
        if (recentDef && stMap[recentId]) {
            const rr = RARITY[recentDef.rarity];
            recentHtml = '<div class="ach-recent" style="border-color:' + rr.color + ';">' +
                '<div class="ach-recent-icon">' + rr.icon + '</div>' +
                '<div class="ach-recent-body">' +
                '<div class="ach-recent-label">✦ 最近解锁</div>' +
                '<div class="ach-recent-title" style="color:' + rr.color + ';">' + recentDef.name + '</div>' +
                '<div class="ach-recent-line">“' + recentDef.line + '”</div>' +
                '<div class="ach-recent-time">' + new Date(stMap[recentId].unlockedAt).toLocaleString('zh-CN') + '</div>' +
                '</div>' +
                (recentDef.rarity === 'legendary' ? '<div style="font-size:0.62em;color:' + rr.color + ';letter-spacing:2px;">传说级</div>' : '') +
                '</div>';
        }
        const groups = [
            { label: '普通成就', rarity: 'common' },
            { label: '稀有成就', rarity: 'rare' },
            { label: '史诗成就 · 隐藏', rarity: 'epic' },
            { label: '传说成就', rarity: 'legendary' },
        ];
        const doneByRarity = (r) => unlockedList().filter((d) => d.rarity === r).length;
        grid.innerHTML = recentHtml + groups.map((gr) => {
            const r = RARITY[gr.rarity];
            const total = DEFS.filter((d) => d.rarity === gr.rarity).length;
            return '<div class="ach-group" style="color:' + r.color + ';">' +
                '<span class="ach-group-dot" style="background:' + r.color + '; box-shadow:0 0 8px ' + r.glow + ';"></span>' +
                '✦ ' + gr.label +
                '<span class="ach-group-count">' + doneByRarity(gr.rarity) + '/' + total + '</span>' +
                '</div>' +
                DEFS.filter((d) => d.rarity === gr.rarity).map(cardHtml).join('');
        }).join('');
        grid.querySelectorAll('.ach-card.unlocked').forEach((el) => {
            el.addEventListener('click', (e) => {
                if (e.target.closest('[data-share]')) { openShare(el.dataset.ach); return; }
                openShare(el.dataset.ach);
            });
        });
    }

    // ---------- 分享卡(小说章节页排版) ----------
    let shareId = null;
    let shareDataUrl = null;
    function openShare(id) {
        const ov = document.getElementById('ach-share');
        if (!ov) return;
        shareId = id;
        ov.style.display = 'flex';
        const img = document.getElementById('achShareImg');
        img.src = '';
        document.getElementById('achShareText').value = '生成中…';
        buildShareCard(id).then((r) => {
            if (!r) { closeShare(); return; }
            shareDataUrl = r.dataUrl;
            img.src = r.dataUrl;
            document.getElementById('achShareText').value = r.text;
        }).catch(() => closeShare());
    }
    function closeShare() {
        const ov = document.getElementById('ach-share');
        if (ov) ov.style.display = 'none';
    }
    function downloadShare() {
        if (!shareDataUrl) return;
        const a = document.createElement('a');
        a.href = shareDataUrl;
        a.download = 'yueyue_achievement.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
    }
    function copyShareText() {
        const t = document.getElementById('achShareText');
        const text = t ? t.value : '';
        if (!text) return;
        const fallback = () => {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (e) { /* 忽略 */ }
            ta.remove();
        };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(fallback);
        else fallback();
    }
    function wrapText(ctx, text, cx, y, maxW, lineH) {
        const chars = text.split('');
        let line = '';
        let yy = y;
        for (const ch of chars) {
            if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, cx, yy); line = ch; yy += lineH; }
            else line += ch;
        }
        ctx.fillText(line, cx, yy);
    }
    function buildShareCard(id) {
        return new Promise((resolve) => {
            const def = defOf(id);
            const un = state()[id];
            if (!def || !un) { resolve(null); return; }
            const r = RARITY[def.rarity];
            const st = relState();
            const chapterIdx = DEFS.indexOf(def) + 1;
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 960;
            const ctx = canvas.getContext('2d');
            const g = ctx.createLinearGradient(0, 0, 0, 960);
            g.addColorStop(0, '#131124');
            g.addColorStop(0.55, '#1a1533');
            g.addColorStop(1, '#251a3d');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, 640, 960);
            for (let i = 0; i < 110; i++) {
                const x = Math.random() * 640;
                const y = Math.random() * 960;
                const rad = Math.random() * 1.6 + 0.4;
                ctx.globalAlpha = 0.2 + Math.random() * 0.65;
                ctx.fillStyle = Math.random() > 0.85 ? r.color : '#ffffff';
                ctx.beginPath();
                ctx.arc(x, y, rad, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1;
            const halo = ctx.createRadialGradient(320, 220, 20, 320, 220, 330);
            halo.addColorStop(0, r.glow);
            halo.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = halo;
            ctx.fillRect(0, 0, 640, 480);
            ctx.textAlign = 'center';
            // 小说章节页式头部: 章号 + 品牌
            ctx.fillStyle = 'rgba(200,190,230,0.75)';
            ctx.font = '20px "Microsoft YaHei"';
            ctx.fillText('梦 界 志 · 成 就 卷', 320, 92);
            ctx.fillStyle = r.color;
            ctx.font = 'bold 26px "Microsoft YaHei"';
            ctx.fillText('第 ' + chapterIdx + ' 章 · ' + r.label, 320, 134);
            ctx.fillStyle = '#ffb4c8';
            ctx.font = 'bold 30px "Microsoft YaHei"';
            ctx.fillText('玥玥 · 心灵同行者', 320, 176);
            const finish = () => {
                // 头像
                ctx.save();
                ctx.beginPath();
                ctx.arc(320, 268, 84, 0, Math.PI * 2);
                ctx.clip();
                try {
                    if (img && img.naturalWidth > 0) ctx.drawImage(img, 236, 184, 168, 168);
                    else { ctx.fillStyle = '#2a2340'; ctx.fillRect(236, 184, 168, 168); }
                } catch (e) { ctx.fillStyle = '#2a2340'; ctx.fillRect(236, 184, 168, 168); }
                ctx.restore();
                ctx.strokeStyle = r.color;
                ctx.lineWidth = 2.5;
                ctx.beginPath();
                ctx.arc(320, 268, 86, 0, Math.PI * 2);
                ctx.stroke();
                // 章名
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 52px "Microsoft YaHei"';
                ctx.fillText(def.name, 320, 470);
                // 分隔线
                ctx.strokeStyle = r.color;
                ctx.globalAlpha = 0.7;
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(200, 500);
                ctx.lineTo(440, 500);
                ctx.stroke();
                ctx.globalAlpha = 1;
                ctx.font = '22px "Microsoft YaHei"';
                ctx.fillStyle = r.color;
                ctx.fillText('✦ ✦ ✦', 320, 512);
                // 题词(她的话)
                ctx.fillStyle = '#ffe0ea';
                ctx.font = '28px "Microsoft YaHei"';
                wrapText(ctx, '“' + def.line + '”', 320, 590, 480, 46);
                // 正文(描述)
                ctx.fillStyle = 'rgba(215,205,235,0.88)';
                ctx.font = '22px "Microsoft YaHei"';
                wrapText(ctx, def.desc, 320, 700, 460, 36);
                // 页脚
                ctx.fillStyle = 'rgba(190,180,215,0.8)';
                ctx.font = '20px "Microsoft YaHei"';
                ctx.fillText('解锁于 ' + new Date(un.unlockedAt).toLocaleString('zh-CN'), 320, 846);
                ctx.fillText('第 ' + chapterIdx + ' 页 / 共 ' + DEFS.length + ' 页', 320, 884);
                ctx.fillStyle = 'rgba(255,180,200,0.9)';
                ctx.font = 'bold 22px "Microsoft YaHei"';
                ctx.fillText('—— 玥玥 · 心灵同行者 · 梦界历 ' + st.days + ' 天', 320, 924);
                const dataUrl = canvas.toDataURL('image/png');
                const text = '我和玥玥认识 ' + st.days + ' 天了。今天解锁了成就「' + def.name + '」（' + r.label + '）。她有一句话给我：「' + def.line + '」 #玥玥 #心灵同行者';
                resolve({ dataUrl, text });
            };
            const img = new Image();
            img.onload = finish;
            img.onerror = finish;
            img.src = 'yueyue_avatar.png';
        });
    }

    // ---------- 成就墙未读红点(通知分通道: 成就只走左下弹窗 + 成就墙红点, 不进聊天流) ----------
    const UNREAD_KEY = 'yueyue_ach_unread';
    function unreadCount() {
        const n = parseInt(localStorage.getItem(UNREAD_KEY) || '0', 10);
        return isNaN(n) || n < 0 ? 0 : n;
    }
    function refreshUnreadDot() {
        const dot = document.getElementById('achUnreadDot');
        if (!dot) return;
        const n = unreadCount();
        if (n > 0) { dot.style.display = 'inline-flex'; dot.textContent = n > 9 ? '9+' : String(n); }
        else dot.style.display = 'none';
    }
    function markUnread() {
        try { localStorage.setItem(UNREAD_KEY, String(unreadCount() + 1)); refreshUnreadDot(); } catch (e) { /* 忽略 */ }
    }
    function clearUnread() {
        try { localStorage.setItem(UNREAD_KEY, '0'); refreshUnreadDot(); } catch (e) { /* 忽略 */ }
    }

    // 打开天数记录(延迟到页面就绪后, 保证弹窗容器存在)
    setTimeout(() => { recordOpenDay(); }, 6000);
    setTimeout(() => { refreshUnreadDot(); }, 800);

    window.Achievements = {
        DEFS,
        RARITY,
        state,
        isUnlocked,
        unlockedList,
        unlock,
        checkFor,
        progressOf,
        openWall,
        closeWall,
        renderWall,
        openShare,
        closeShare,
        downloadShare,
        copyShareText,
        popupFor,
        showPopup,
        unreadCount,
        refreshUnreadDot,
        sound,
        buildShareCard,
        birthdayMMDD,
        isBirthdayToday,
        get lastSound() { return lastSound; },
    };
})();
