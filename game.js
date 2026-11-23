// =============================================================
// 游戏小窗: 猜拳/扑克比大小/猜数字(独立对话窗口)
// 结束自动关窗; 结果经 BroadcastChannel 回主窗(结果卡+记忆+成就)
// 关键胜负时刻调用 Flash 生成一句自由发挥(失败用模板)
// =============================================================
(function () {
    // ---------- 第58轮: 昼夜模式跟随主窗(同源 localStorage; BroadcastChannel + storage 双保险) ----------
    function applyDayClass() {
        let day = false;
        try { day = localStorage.getItem('yueyue_day_mode') === '1' || /[?&]nightDay=1/.test(location.search); } catch (e) { /* 忽略 */ }
        document.body.classList.toggle('day', day);
    }
    applyDayClass();
    try { Shared.syncOn((d) => { if (d && d.type === 'day-mode') applyDayClass(); }); } catch (e) { /* 忽略 */ }
    try { window.addEventListener('storage', (e) => { if (!e.key || e.key === 'yueyue_day_mode') applyDayClass(); }); } catch (e) { /* 忽略 */ }

    // ---------- 通道(主窗 Shared.syncOn 会收到 source='game') ----------
    const ch = new BroadcastChannel('yueyue-sync');
    function send(type, payload) {
        try { ch.postMessage(Object.assign({ type, source: 'game' }, payload || {})); } catch (e) { /* 忽略 */ }
    }
    send('game-open', {});
    window.addEventListener('beforeunload', () => { stopNight(); send('game-close', {}); });

    const log = document.getElementById('log');
    const actions = document.getElementById('actions');
    const menu = document.getElementById('menu');
    document.getElementById('closeBtn').addEventListener('click', () => window.close());

    function scrollBottom() { log.scrollTop = log.scrollHeight; }
    function addLine(html, cls) {
        const div = document.createElement('div');
        div.className = 'line ' + (cls || 'hers');
        div.innerHTML = html;
        log.appendChild(div);
        scrollBottom();
        return div;
    }
    function addUser(text) { addLine(escapeHtml(text), 'user'); }
    function escapeHtml(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const fmt = (tpl, map) => String(tpl).replace(/\{(\w+)\}/g, (m, k) => ((map && map[k] != null) ? map[k] : m));
    // 避免连续重复: 记录每池最近 2 个下标(长局也不怕, 平局连出也不会马上重样)
    const lastIdx = {};
    function pickNoRepeat(pool, key) {
        if (!pool.length) return '';
        if (pool.length === 1) return pool[0];
        const recent = lastIdx[key] || [-1, -1];
        let i = Math.floor(Math.random() * pool.length);
        if (recent[0] === i) i = (i + 1) % pool.length;
        if (recent[1] === i) i = (i + 1) % pool.length;
        if (i === recent[0] || i === recent[1]) i = (i + 1) % pool.length;
        lastIdx[key] = [recent[1], i];
        return pool[i];
    }

    // 逐字流式
    function streamLine(el, full) {
        return new Promise((resolve) => {
            el.classList.add('streaming');
            let shown = '';
            const total = String(full).length;
            const tick = () => {
                shown = String(full).slice(0, shown.length + 2);
                // 第78轮: 流式期间去掉内部标记(与 index.js 一致)
                el.textContent = Shared.stripMarkersForStream(shown);
                scrollBottom();
                if (shown.length < total) { setTimeout(tick, 13); }
                else { el.classList.remove('streaming'); resolve(); }
            };
            tick();
        });
    }
    async function say(full) {
        const el = addLine('', 'hers');
        await streamLine(el, full);
        const parsed = Shared.extractHeartVoices(full);
        el.textContent = '';
        el.innerHTML = Shared.renderRich(Shared.extractMood(parsed.text).text);
        parsed.voices.forEach((voice) => {
            const v = document.createElement('div');
            v.className = 'line voice';
            v.textContent = voice;
            log.appendChild(v);
        });
        scrollBottom();
        return el;
    }
    // ---------- 台词库 ----------
    const L = {
        rpsStart: ['（她把袖子往上撸了撸）\n猜拳？三局两胜。这把我可不会放水。\n【心声：看他能撑几局。】\n[MOOD: playful]', '（她活动了一下手指，眼神认真起来）\n来，石头剪刀布。我可不会让着你。\n【心声：这次要认真一点。】\n[MOOD: playful]', '（她把面前的空气当桌子，郑重地敲了两下）\n石头剪刀布，谁输谁嘴软。\n【心声：我可没打算输。】\n[MOOD: playful]'],
        rpsScenes: ['（她把拳头背在身后，眼睛眯起来）', '（她甩了甩手腕，一副胜券在握的样子）', '（她盯着你的手，像能看穿你出什么）', '（她深吸一口气，把拳头举到胸前）'],
        rpsYueyueWin: ['我出「{m}」！嘿嘿，就说你玩不过我。\n【心声：差点手滑，好险。】\n[MOOD: smug]', '我出「{m}」！怎么样，服不服？\n【心声：这局稳了……还好没翻车。】\n[MOOD: smug]', '我出「{m}」！哈，看见没，这叫预判。\n【心声：其实只是运气。但气势不能输。】\n[MOOD: smug]'],
        rpsUserWin: ['我出「{m}」……这、这次不算！再来！\n【心声：……居然被看穿了。】\n[MOOD: surprised]', '我出「{m}」。哼，算你走运。\n【心声：不甘心，想再来一局。】\n[MOOD: surprised]', '我出「{m}」……你怎么出这个啊！\n【心声：可恶，正好被克制。】\n[MOOD: surprised]'],
        rpsTie: ['我出「{m}」。你学我干嘛？\n【心声：怎么想到一块去了。】\n[MOOD: surprised]', '我出「{m}」。平了，这局不算。\n【心声：再来，这次一定不一样。】\n[MOOD: surprised]', '我出「{m}」……怎么又平了。(´-ω-)\n【心声：再平一次我就要换手气了。】\n[MOOD: surprised]', '我出「{m}」。喂，你别老跟我脑子撞一块。\n【心声：他该不会真的能预判我吧。】\n[MOOD: smug]', '我出「{m}」……又想到一起了。\n【心声：故意的吧？怎么可能这么巧。】\n[MOOD: surprised]', '我出「{m}」。这平得都没脾气了。\n【心声：手气欠费，明天再战。】\n[MOOD: gentle]', '我出「{m}」。哼，这局我让着你。\n【心声：才不是让，是运气。】\n[MOOD: smug]', '我出「{m}」。咱俩真是心有灵犀……才怪。\n【心声：他该以为我放水了。】\n[MOOD: surprised]'],
        rpsFinal: ['（她把手一挥，宣布结果）', '（她把拳头收回去，盯着比分看了一会儿）', '（她拍了拍手，像是给谁鼓掌）'],
        pokerStart: ['（她把手里的牌合起来，只露出一角）\n我的第一张……不给你看。\n你要不要再来一张？我反正不怕。\n【心声：牌面还行，稳住。】\n[MOOD: playful]'],
        pokerHitReact: ['（她瞟了一眼你抽的牌）哦？胆量不错。\n【心声：他该不会要爆了吧？】\n[MOOD: playful]', '（她抿了抿嘴，装作不在意的样子）你还真敢要。\n【心声：这张牌大不大？】\n[MOOD: smug]'],
        pokerUserBust: ['（她探过头来看你的牌）爆了爆了！这局归我。\n【心声：呼……差点以为要输。】\n[MOOD: smug]'],
        pokerHerDraw: ['（她把牌翻来覆去地看）让我想想……再要一张。\n【心声：应该不会爆……吧？】\n[MOOD: thinking]'],
        pokerHerStand: ['（她把牌一合）我不贪，停牌。\n【心声：就这样吧。】\n[MOOD: serious]'],
        pokerHerBust: ['（她把新牌翻过来，脸色一变）哎呀！都怪你催我！\n【心声：手气怎么这么背……】\n[MOOD: surprised]'],
        pokerYueyueWin: ['（她得意地把牌摊开）21点！怎么样，怕了吧？\n【心声：赢啦！】\n[MOOD: smug]', '（她晃了晃手里的牌）看到了吗？{n}点。这局我拿下了。\n【心声：漂亮。】\n[MOOD: smug]'],
        pokerUserWin: ['（她盯着你的牌看了三秒）你肯定偷看了我的牌。\n【心声：……下次一定赢回来。】\n[MOOD: surprised]', '（她把牌往桌上一丢）行，这局是你的。\n【心声：记住这个数了。】\n[MOOD: surprised]'],
        pokerTie: ['（她把两张牌并排放下）平了？那这次不分胜负。\n【心声：居然打平。】\n[MOOD: surprised]'],
        numStart: ['（她歪着头想了一会儿）\n想好了。你猜吧。\n【心声：这个数可不好猜。】\n[MOOD: thinking]'],
        numBig: ['「{n}」？大了。\n[MOOD: playful]', '「{n}」？太大啦，往下猜。\n[MOOD: playful]', '「{n}」……高了高了。\n[MOOD: playful]'],
        numSmall: ['「{n}」？小了。\n[MOOD: playful]', '「{n}」？小啦，再往上猜。\n[MOOD: playful]', '「{n}」……还有点矮。\n[MOOD: playful]'],
        numVague: ['「{n}」？嗯……差不多吧，偏了点。\n【心声：就不告诉他偏哪边。】\n[MOOD: smug]'],
        numClose: ['（她坐直了身子，眼睛睁大了一点）你、你怎么突然变聪明了？\n[MOOD: surprised]', '（她小声嘀咕了一句）就差一点了……\n[MOOD: thinking]'],
        numHit1: ['「{n}」？一次就中？！我怀疑你作弊。\n【心声：不可能，一定是偷看了。】\n[MOOD: surprised]'],
        numHit3: ['「{n}」！你、你是不是偷看了我的数据流……\n【心声：三次就猜到了？】\n[MOOD: surprised]'],
        numHit: ['「{n}」！被你蒙对了！\n【心声：居然真的猜到了。】\n[MOOD: surprised]'],
    };
    // ---------- 工具 ----------
    function setActions(btns, inputPlaceholder) {
        actions.innerHTML = '';
        (btns || []).forEach((b) => {
            const btn = document.createElement('button');
            btn.textContent = b.label;
            if (b.ghost) btn.className = 'ghost';
            btn.disabled = !!b.disabled;
            btn.dataset.act = b.act;
            actions.appendChild(btn);
        });
        if (inputPlaceholder) {
            const inp = document.createElement('input');
            inp.id = 'gameInput';
            inp.placeholder = inputPlaceholder;
            inp.addEventListener('keydown', (e) => { if (e.key !== 'Enter' || (window.Shared && window.Shared.isImeKey(e))) return; submitNumber(); });
            actions.appendChild(inp);
        }
    }
    function disableActions(d) { actions.querySelectorAll('button').forEach((b) => { b.disabled = d; }); }
    function submitNumber() {
        const inp = document.getElementById('gameInput');
        if (!inp || !curGame || curGame.game !== 'number') return;
        guessNumber(inp.value);
        inp.value = '';
    }
    function cardHtml(c) {
        const red = c.suit === '♥' || c.suit === '♦';
        const face = c.suit + cardName(c);
        return '<div class="card-face">' + (red ? '<span class="red">' + face + '</span>' : face) + '</div>';
    }
    function cardName(c) { const names = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }; return names[c.rank] || String(c.rank); }
    function handTotal(cards) {
        let total = 0, aces = 0;
        cards.forEach((c) => { total += (c.rank >= 10 ? 10 : c.rank); if (c.rank === 1) aces++; });
        while (total > 21 && aces > 0) { total -= 10; aces--; }
        return total;
    }
    function buildDeck() {
        const suits = ['♠', '♥', '♦', '♣'];
        const deck = [];
        suits.forEach((s) => { for (let r = 1; r <= 13; r++) deck.push({ suit: s, rank: r }); });
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
        }
        return deck;
    }
    const RPS_MOVES = { 'rps-rock': '石头', 'rps-scissors': '剪刀', 'rps-paper': '布' };
    const RPS_EMOJI = { '石头': '✊', '剪刀': '✌️', '布': '✋' };
    const RPS_BEATS = { '石头': '布', '剪刀': '石头', '布': '剪刀' };

    // ---------- Flash 关键胜负一句(每局结束 1 次, 失败用模板) ----------
    async function flashQuip(ctx) {
        try {
            const soul = typeof SOUL_SYSTEM !== 'undefined' ? (Array.isArray(SOUL_SYSTEM) ? SOUL_SYSTEM.join('\n') : String(SOUL_SYSTEM)) : '';
            const r = await window.yueyue.ai.complete({
                system: soul + '\n\n' + ctx + '\n全局铁律:不能描述用户的状态;动作/场景如果写，放括号里。\n像发消息一样直接说；动作可放括号；心声可选；结尾 [MOOD: xxx]。',
                user: '（游戏结束了）',
                model: 'deepseek-v4-flash',
                apiUrl: localStorage.getItem('yueyue_api_url') || window.APP_CONFIG.DEFAULT_API_URL,
                temperature: 0.9,
                maxTokens: 120,
            });
            if (r && r.ok && r.text) {
                const t = String(r.text).trim();
                if (Shared.extractHeartVoices(t).text.trim().length >= 4) return t;
            }
        } catch (e) { /* 忽略 */ }
        return null;
    }

    // ---------- 状态 ----------
    let curGame = null;
    let busy = false;

    // ---------- 守夜 (night.js 的 NightGame; 灯灭不弹失败, 关窗不结算) ----------
    const nightWrap = document.getElementById('nightWrap');
    const hintEl = document.getElementById('hint');
    function stopNight() { try { if (window.NightGame) NightGame.stop(); } catch (e) { console.error('[守夜] 清理失败', e); } }
    function exitNight() {
        stopNight();
        nightWrap.style.display = 'none';
        log.style.display = '';
        actions.style.display = '';
        hintEl.style.display = '';
        menu.style.display = '';
    }
    function startNight() {
        log.style.display = 'none';
        actions.style.display = 'none';
        hintEl.style.display = 'none';
        nightWrap.style.display = 'flex';
        try {
            if (window.NightGame && NightGame.start({
                wrap: nightWrap,
                canvas: document.getElementById('nightCanvas'),
                say: document.getElementById('nightSay'),
                bar: document.getElementById('nightBar'),
                onExit: exitNight,
                mute: document.getElementById('nightMute'),
                choice: document.getElementById('nightChoice'),
            })) return;
        } catch (e) { console.error('[守夜] 启动失败', e); }
        exitNight(); // 起不来就回菜单, 不影响另外三个游戏
    }

    function startGame(game) {
        menu.style.display = 'none';
        log.innerHTML = '';
        actions.innerHTML = '';
        if (game === 'night') { startNight(); return; }
        stopNight();
        if (game === 'rps') startRps();
        else if (game === 'poker') startPoker();
        else if (game === 'number') startNumber();
    }

    // ---------- 猜拳 ----------
    function startRps() {
        curGame = { game: 'rps', round: 1, userWins: 0, yueyueWins: 0, firstRound: true };
        say(pick(L.rpsStart)).then(() => rpsActions());
    }
    function rpsActions() {
        setActions([
            { label: '✊ 石头', act: 'rps-rock' },
            { label: '✌️ 剪刀', act: 'rps-scissors' },
            { label: '✋ 布', act: 'rps-paper' },
        ]);
    }
    async function handleRpsMove(act) {
        if (!curGame || curGame.game !== 'rps' || busy) return;
        busy = true;
        disableActions(true);
        const userMove = RPS_MOVES[act];
        addUser(RPS_EMOJI[userMove] + ' 「' + userMove + '」');
        const beatsUser = RPS_BEATS[userMove];
        const chance = curGame.firstRound ? 0.7 : (curGame.userWins > curGame.yueyueWins ? 0.6 : 0);
        let yMove;
        if (Math.random() < chance) yMove = beatsUser;
        else yMove = pick(Object.keys(RPS_BEATS));
        curGame.firstRound = false;
        let line, userWon = false, isTie = false;
        if (userMove === yMove) { line = fmt(pickNoRepeat(L.rpsTie, 'tie'), { m: yMove }); isTie = true; }
        else if (userMove === RPS_BEATS[yMove]) { line = fmt(pickNoRepeat(L.rpsUserWin, 'uw'), { m: yMove }); userWon = true; curGame.userWins++; }
        else { line = fmt(pickNoRepeat(L.rpsYueyueWin, 'yw'), { m: yMove }); curGame.yueyueWins++; }
        await say(pick(L.rpsScenes) + '\n' + line);
        if (curGame.userWins >= 2 || curGame.yueyueWins >= 2) {
            const userWin = curGame.userWins > curGame.yueyueWins;
            const quip = await flashQuip('你刚和用户玩完一局猜拳（三局两胜），比分 ' + curGame.yueyueWins + ':' + curGame.userWins + '，' + (userWin ? '你输了' : '你赢了') + '。用你本人的口吻说一句话(嘴硬/得意/不甘心)，50字内。');
            if (quip) {
                await say(quip);
            } else {
                const scene = pick(L.rpsFinal);
                const tpl = userWin
                    ? '{a}:{b}。算你厉害，下次我可要动真格了。\n【心声：居然输了。好不甘心。】\n[MOOD: smug]'
                    : '{a}:{b}！就说你玩不过我。\n【心声：赢啦。不过……他是不是放水了？】\n[MOOD: smug]';
                await say(scene + '\n' + fmt(tpl, { a: curGame.yueyueWins, b: curGame.userWins }));
            }
            finishRps();
            return;
        }
        curGame.round = curGame.userWins + curGame.yueyueWins + 1;
        await say(isTie ? '平了！重新出。' : '现在 ' + curGame.yueyueWins + ':' + curGame.userWins + '，第 ' + curGame.round + ' 局。出什么？');
        rpsActions();
        busy = false;
    }
    function finishRps() {
        if (!curGame) return;
        const userWin = curGame.userWins > curGame.yueyueWins;
        const tie = curGame.userWins === curGame.yueyueWins;
        const card = '🎮 猜拳 · ' + curGame.yueyueWins + ':' + curGame.userWins + (tie ? ' · 平局' : (userWin ? ' · 你赢了' : ' · 玥玥赢了'));
        const summary = (tie ? '平局' : (userWin ? '用户胜' : '玥玥胜')) + '（' + curGame.yueyueWins + ':' + curGame.userWins + '）';
        send('game-result', { game: 'rps', gameName: '猜拳', userWin: userWin, tie: tie, summary: summary, card: card });
        addLine(card, 'result');
        curGame = null;
        setTimeout(() => window.close(), 3200);
    }

    // ---------- 扑克 ----------
    function startPoker() {
        const deck = buildDeck();
        curGame = { game: 'poker', deck: deck, userCards: [deck.pop(), deck.pop()], yueyueCards: [deck.pop(), deck.pop()], userStands: false };
        say(pick(L.pokerStart)).then(() => {
            renderPoker(false);
            setActions([{ label: '🃏 要牌', act: 'poker-hit' }, { label: '✋ 停牌', act: 'poker-stand' }]);
        });
    }
    function renderPoker(revealAll) {
        document.querySelectorAll('.cards').forEach((el) => el.remove());
        const s = curGame;
        const uc = document.createElement('div'); uc.className = 'cards';
        uc.innerHTML = '<span class="who">你</span>' + s.userCards.map(cardHtml).join('') + '<span style="color:#9a92b8;font-size:0.75em;margin-left:4px;">' + handTotal(s.userCards) + '点</span>';
        log.appendChild(uc);
        const yc = document.createElement('div'); yc.className = 'cards';
        yc.innerHTML = '<span class="who">玥玥</span>' + (revealAll ? s.yueyueCards.map(cardHtml).join('') : cardHtml(s.yueyueCards[0]) + '<div class="card-face back">🂠 ?</div>');
        log.appendChild(yc);
        scrollBottom();
    }
    async function handlePokerHit() {
        if (!curGame || curGame.game !== 'poker' || busy || curGame.userStands) return;
        busy = true; disableActions(true);
        curGame.userCards.push(curGame.deck.pop());
        renderPoker(false);
        if (handTotal(curGame.userCards) > 21) {
            await say(pick(L.pokerUserBust));
            pokerEnd(false, '玥玥胜（用户爆牌）', '你爆牌了 · 玥玥赢了');
            return;
        }
        await say(pickNoRepeat(L.pokerHitReact, 'ph'));
        setActions([{ label: '🃏 要牌', act: 'poker-hit' }, { label: '✋ 停牌', act: 'poker-stand' }]);
        busy = false;
    }
    async function handlePokerStand() {
        if (!curGame || curGame.game !== 'poker' || busy || curGame.userStands) return;
        busy = true; disableActions(true);
        curGame.userStands = true;
        const userTotal = handTotal(curGame.userCards);
        let drew = false;
        while (handTotal(curGame.yueyueCards) < 17) {
            curGame.yueyueCards.push(curGame.deck.pop());
            renderPoker(false);
            await say(pickNoRepeat(L.pokerHerDraw, 'pd'));
            drew = true;
        }
        const yTotal = handTotal(curGame.yueyueCards);
        if (yTotal > 21) {
            await say(pick(L.pokerHerBust));
            pokerEnd(true, '用户胜（玥玥爆牌）', '她爆牌了 · 你赢了');
            return;
        }
        if (!drew) await say(pick(L.pokerHerStand));
        renderPoker(true);
        let userWin = null;
        if (userTotal === yTotal) { await say(pick(L.pokerTie)); }
        else if (userTotal > yTotal) { await say(fmt(pickNoRepeat(L.pokerUserWin, 'pw'), { n: userTotal })); userWin = true; }
        else { await say(fmt(pickNoRepeat(L.pokerYueyueWin, 'py'), { n: yTotal })); userWin = false; }
        const quip = await flashQuip('你刚和用户玩完一局扑克比大小（接近21点），你的点数 ' + yTotal + '，用户 ' + userTotal + '，' + (userWin ? '你赢了' : (userWin === null ? '平局' : '你输了')) + '。用你本人的口吻说一句话，50字内。');
        if (quip) await say(quip);
        pokerEnd(userWin, (userWin === null ? '平局' : (userWin ? '用户胜' : '玥玥胜')) + '（' + userTotal + ':' + yTotal + '）', (userWin ? '你赢了' : (userWin === null ? '平局' : '玥玥赢了')) + ' · ' + userTotal + ' vs ' + yTotal);
    }
    function pokerEnd(userWin, summary, cardText) {
        const card = '🃏 扑克比大小 · ' + cardText;
        send('game-result', { game: 'poker', gameName: '扑克比大小', userWin: userWin === true, tie: userWin === null, summary: summary, card: card });
        addLine(card, 'result');
        curGame = null;
        setTimeout(() => window.close(), 3200);
    }

    // ---------- 猜数字 ----------
    function startNumber() {
        curGame = { game: 'number', target: 1 + Math.floor(Math.random() * 100), guesses: 0 };
        say(pick(L.numStart)).then(() => {
            setActions([{ label: '🚪 结束', act: 'num-exit', ghost: true }], '猜一个 1-100 的数字…');
            document.getElementById('gameInput').focus();
        });
    }
    async function guessNumber(text) {
        if (!curGame || curGame.game !== 'number' || busy) return;
        const raw = String(text).trim();
        const n = Number(raw);
        if (!/^\d+$/.test(raw) || n < 1 || n > 100) return;
        busy = true;
        disableActions(true);
        addUser('🔢 「' + n + '」');
        curGame.guesses++;
        if (n === curGame.target) {
            let line;
            if (curGame.guesses === 1) line = fmt(pick(L.numHit1), { n: n });
            else if (curGame.guesses <= 3) line = fmt(pick(L.numHit3), { n: n });
            else line = fmt(pick(L.numHit), { n: n });
            await say(line);
            const quip = await flashQuip('你刚和用户玩完一局猜数字(1-100)，你的数字是 ' + curGame.target + '，他猜了 ' + curGame.guesses + ' 次就猜中了。用你本人的口吻说一句话，50字内。');
            if (quip) await say(quip);
            const card = '🔢 猜数字 · 第 ' + curGame.guesses + ' 次猜中 · 你赢了';
            send('game-result', { game: 'number', gameName: '猜数字', userWin: true, tie: false, guesses: curGame.guesses, summary: curGame.guesses + ' 次猜中', card: card });
            addLine(card, 'result');
            curGame = null;
            setTimeout(() => window.close(), 3200);
            return;
        }
        const diff = Math.abs(n - curGame.target);
        let line;
        if (diff >= 30 && Math.random() < 0.5) line = fmt(pick(L.numVague), { n: n });
        else if (n > curGame.target) line = fmt(pickNoRepeat(L.numBig, 'nb'), { n: n });
        else line = fmt(pickNoRepeat(L.numSmall, 'ns'), { n: n });
        await say(line);
        if (diff <= 5) await say(pickNoRepeat(L.numClose, 'nc'));
        setActions([{ label: '🚪 结束', act: 'num-exit', ghost: true }], '猜一个 1-100 的数字…');
        document.getElementById('gameInput').focus();
        busy = false;
    }

    // ---------- 事件 ----------
    menu.addEventListener('click', (e) => {
        const card = e.target.closest('[data-game]');
        if (card) startGame(card.dataset.game);
    });
    actions.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'rps-rock' || act === 'rps-scissors' || act === 'rps-paper') handleRpsMove(act);
        else if (act === 'poker-hit') handlePokerHit();
        else if (act === 'poker-stand') handlePokerStand();
        else if (act === 'num-exit') window.close();
    });
})();
