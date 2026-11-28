// 共享工具:安全渲染、情绪解析、系统时间
(function () {
    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // 词典修正: 模型偶发把梦界专有名词写成英文混排(如 vacuum海), 显示前统一纠正
    function fixDict(text) {
        return String(text)
            .replace(/vacuum海/gi, '虚空海')
            .replace(/虚空海海/g, '虚空海');
    }

    // 去掉 markdown 强调星号(**词** / *词* / __词__): 心声卡(textContent)与 TTS 不该念出星号
    function stripEmphasis(text) {
        return String(text)
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/(?<![\w*])\*([^*\n]+)\*(?![\w*])/g, '$1')
            .replace(/__(.+?)__/g, '$1');
    }

    // 安全富文本:先转义再套用极简标记(**加粗** 与换行),杜绝 HTML 注入
    // 加粗颜色由 CSS 的 .message strong 规则控制
    function renderRich(text) {
        return escapeHtml(fixDict(text))
            .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            // 第71轮: *动作*旁白: 模型偶尔用 *低头* 这种单星号写动作，旧渲染会原样露出星号。
            // 与 stripEmphasis 同一边界（前后不紧邻词字符/星号），且只转换含中文的片段。
            .replace(/(?<![\w*])\*([^*\n]{1,40})\*(?![\w*])/g, (m, inner) => /[\u4e00-\u9fa5]/.test(inner) ? '（' + inner + '）' : m)
            // [r225] 颜文字/抱抱标签不能被行宽拆开：套一层 nowrap，避免把 (´-ω-`) 拆成两行。
            // 先处理「【抱抱你】+脸」这一组，让标签和脸一起换行，而不是标签留在上一行。
            .replace(/(【[^】\n]{1,40}】)(\s*)(\([^()\n]{1,40}\))/g, (m, tag, sp, face) => /[^\x00-\x7F]/.test(face.slice(1, -1)) ? '<span class="kao">' + tag + sp + face + '</span>' : m)
            .replace(/【[^】\n]{1,40}】/g, (m) => '<span class="kao">' + m + '</span>')
            .replace(/\(([^()\n]{1,40})\)/g, (m, inner) => /[^\x00-\x7F]/.test(inner) ? '<span class="kao">' + m + '</span>' : m)
            .replace(/\n/g, '<br>');
    }

    // 提取回复中的【心声：xxx】,返回去掉心声后的正文与心声数组
    // 2026-09-14 修复(用户反馈 C1「回复没有心声」):
    //   原正则只认全角冒号「：」。实测模型常写半角冒号「:」——此时**零提取**,
    //   原始标签【心声:…】会原样留在气泡里(既不显示为心声卡, 也不被清理), 用户看到的就是"没有心声"。
    //   本函数是共用渲染入口(主窗 index.js / 聊天窗 chat.js / TTS tts-voice.js / 游戏 game.js 共 6 处调用),
    //   故在此统一归一化冒号与括号变体, 不改各处调用方。
    //   刻意**不**放宽"心声"二字本身(不加空格容错), 避免误吞正常文本。
    /**
     * 第78轮: 流式展示用 —— 去掉内部标记, 含"还没闭合"的半截标签。
     * 背景: 聊天与游戏的逐字流式把 delta 直接塞进 textContent,
     * 模型先吐台词再吐 【心声:…】/[MOOD:…], 于是用户会先看到
     * "【心声:这句话不该被你看见" 停 0.3~1.3 秒, 收尾才被清掉。
     * 这里只做展示层裁剪, 不改动落库/记忆/情绪解析用的原文。
     */
    function stripMarkersForStream(s) {
        let t = String(s == null ? '' : s);
        t = t.split('[MOOD:')[0].split('[mood:')[0];
        // 完整块: 【心声:…】/【进度:…】/【场景:…】
        // 第142轮: 行首无冒号写法 `【心声】…`（整行都是心声，流式期间先整行不显示）—— 必须先于通用规则，
        // 否则 `【心声】` 标签先被吃掉、后面那半句心声反而留在气泡里（单测抓到过）。
        t = t.replace(/^[ \t]*【(心声|进度|场景|情绪)】[^\n]*/gm, '');
        t = t.replace(/【(心声|进度|场景|情绪)[：:]?[^】\n]*】/g, '');
        // 未闭合尾巴
        t = t.replace(/【(心声|进度|场景|情绪)[：:]?[^】\n]*$/, '');
        t = t.replace(/【(心声|进度|场景|情绪)$/, '');
        // 第90轮真机反馈「发完消息后气小 BUG」: 流式阶段把 **加粗** 的星号直接塞进 textContent,
        // onDone 再由 renderRich 吞成 <strong> —— 用户看到的是「**懒得动**」闪一下又变短。
        // 这里让流式展示与最终渲染共用同一套文本清洗(字典修正/加粗/斜体/下划线), 尾部的半截标记先不显示。
        t = fixDict(t);
        t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1');
        t = t.replace(/(?<![\w*])\*([^*\n]{1,40})\*(?![\w*])/g, (m, inner) => (/[\u4e00-\u9fa5]/.test(inner) ? '（' + inner + '）' : m));
        // 流式中途尚未闭合的强调符: 先不显示 (等闭合后由上面的规则转换)
        if (((t.match(/\*\*/g) || []).length) % 2 === 1) t = t.replace(/\*\*(?![^]*\*\*)/, '');
        if (((t.match(/__/g) || []).length) % 2 === 1) t = t.replace(/__(?![^]*__)/, '');
        if (((t.match(/\*(?![*])/g) || []).length) % 2 === 1) t = t.replace(/\*(?!\*)(?![^]*\*)/, '');
        return t;
    }

    function extractHeartVoices(text) {
        const voices = [];
        // 第142轮: 统一容错 —— 冒号可省、内容可空、行首无冒号写法也认。
        // 现场（第141轮 g2e R9）模型写过 `【心声】心跳快了半拍…`（无冒号），旧正则零提取 → 原文内联漏在气泡里。
        // [r224d] 心声不是元评论/调试口：模型偶尔会写「现在玥玥好像脑袋空空，
        // 读不出来心声啊喂！」这类自称第三人称、讨论"心声"本身的句子；展示层直接丢掉。
        // 只拦明显的元评论，不拦「他叫我玥玥」这种真的在说用户怎么称呼她、且没有元词的心声。
        const HEART_META_RE = /读不出来|脑袋空空|心声啊喂|^(?:现在)?玥玥(?:好像|觉得|心里|的)?|玥玥.*(?:读不出来|脑袋空空|心声啊喂)|(?:读不出来|脑袋空空|心声啊喂).*玥玥/;
        const pushVoice = (voice) => {
            const v = stripEmphasis(fixDict(String(voice == null ? '' : voice).trim()));
            if (v && !HEART_META_RE.test(v)) voices.push(v);
        };
        let cleaned = String(text);
        // 1) 冒号版（全/半角），允许空内容
        cleaned = cleaned.replace(/【心声[：:]([^】]*)】/g, (match, voice) => { pushVoice(voice); return ''; });
        // 2) 无冒号版：行首 `【心声】后面的句子` —— 心声到行尾为止（不吞下一行台词）
        cleaned = cleaned.replace(/^[ \t]*【心声】[ \t]*([^\n]*)$/gm, (match, voice) => { pushVoice(voice); return ''; });
        // 3) 方括号变体 [心声：xxx] / [心声:xxx] / 行首 [心声]xxx
        cleaned = cleaned.replace(/\[心声[：:]([^\]]*)\]/g, (match, voice) => { pushVoice(voice); return ''; });
        cleaned = cleaned.replace(/^[ \t]*\[心声\][ \t]*([^\n]*)$/gm, (match, voice) => { pushVoice(voice); return ''; });
        // 4) 流式输出被截断时可能留下未闭合的【心声…（冒号可有可无）,一并清理,避免显示原始标签/TTS 误读
        cleaned = cleaned.replace(/【心声[：:]?[^】\n]*$/, '').replace(/\[心声[：:]?[^\]]*$/, '');
        return { text: cleaned, voices };
    }

    // 提取回复末尾的 [MOOD: xxx] 标签
    function extractMood(text) {
        const match = String(text).match(/\[MOOD:\s*(\w+)\]/);
        return {
            mood: match ? match[1] : null,
            text: String(text).replace(/\[MOOD:\s*\w+\]\s*/g, '').trim(),
        };
    }

    // 无标签时的情绪兜底识别
    function detectMood(reply) {
        const t = String(reply);
        if (/安啦|我在|陪着|轻轻|累了就|休息|睡/.test(t)) return 'gentle';
        if (/心疼|眉头|担心|难受/.test(t)) return 'concerned';
        if (/真的假的|不会吧|居然|什么！/.test(t)) return 'surprised';
        if (/开心|好多了|棒|喜欢|嘿嘿/.test(t)) return 'happy';
        if (/算了|没办法|唉|失落|难过/.test(t)) return 'sad';
        if (/哲学|分析|我觉得|思考/.test(t)) return 'serious';
        if (/😘|🔥|❤️|转圈|打滚|撒娇/.test(t)) return 'playful';
        return 'talking';
    }

    function systemTime() {
        const now = new Date();
        const h = now.getHours();
        // 时段语义(2026-09-10): 让模型明确"今天走到哪了"——修用户反馈"上午10点被说'早上不见人影/今天过得怎么样'"
        let phase = '上午', hint = '今天才刚开始不久';
        if (h < 5) { phase = '深夜'; hint = '大多数人在睡觉,今天快结束了'; }
        else if (h < 7) { phase = '凌晨'; hint = '天还没亮'; }
        else if (h < 9) { phase = '早上'; hint = '一天刚开始'; }
        else if (h < 11) { phase = '上午'; hint = '今天才刚开始不久'; }
        else if (h < 13) { phase = '中午'; hint = '上午刚过'; }
        else if (h < 17) { phase = '下午'; hint = '今天过半'; }
        else if (h < 19) { phase = '傍晚'; hint = '天快黑了'; }
        else if (h < 23) { phase = '晚上'; hint = '今天已过大半'; }
        else { phase = '深夜'; hint = '今天快结束了'; }
        return '[系统时间:' + now.getFullYear() + '年' + (now.getMonth() + 1) + '月' +
            now.getDate() + '日,周' + '日一二三四五六'[now.getDay()] + ',' +
            h + '时' + now.getMinutes() + '分·' + phase + '(' + hint + ')]';
    }

    // ---------- 跨窗口同步(主窗口 ↔ 聊天小窗/气泡宠物/游戏窗):同一段对话,几个窗口都记得 ----------
    // 第58轮: 补上 game.html 的 source —— 否则游戏窗会被当成 main, 收不到主窗发的 day-mode
    // (syncOn 会按 source 过滤掉"自己发的"), 昼夜模式就跟不过去。
    function syncChannel() {
        if (!window.__yueyueSync) {
            window.__yueyueSync = {
                ch: new BroadcastChannel('yueyue-sync'),
                own: location.pathname.indexOf('chat.html') !== -1 ? 'chat'
                    : (location.pathname.indexOf('pet.html') !== -1 ? 'pet'
                        : (location.pathname.indexOf('game.html') !== -1 ? 'game' : 'main')),
            };
        }
        return window.__yueyueSync;
    }
    function syncSend(type, payload) {
        try {
            syncChannel().ch.postMessage(Object.assign({ type, source: syncChannel().own }, payload || {}));
        } catch (e) { /* 忽略 */ }
    }
    // 注册接收回调(自动过滤自己发的消息; 支持多个监听器, 后注册不覆盖先注册)
    function syncOn(cb) {
        try {
            const ch = syncChannel().ch;
            if (!ch.__yueyueListeners) {
                ch.__yueyueListeners = [];
                ch.onmessage = (ev) => {
                    const d = ev.data || {};
                    if (d.source !== syncChannel().own) {
                        ch.__yueyueListeners.slice().forEach((fn) => { try { fn(d); } catch (e) { /* 单个监听器出错不影响其他 */ } });
                    }
                };
            }
            ch.__yueyueListeners.push(cb);
        } catch (e) { /* 忽略 */ }
    }

    // 2026-09-12 用户拍板: 通用二选一浮层(主窗/聊天小窗共用)。内联样式, 不改 HTML/CSS,
    // 因此两个窗口零成本一致; 超时按"默认动作"结算(调用方决定默认语义)。
    // 用法: Shared.showChoice({ text, okText, cancelText, timeoutMs }) -> Promise<'ok'|'cancel'|'timeout'>
    function showChoice(opts) {
        const o = opts || {};
        return new Promise((resolve) => {
            let settled = false;
            const timer = setTimeout(() => done('timeout'), o.timeoutMs || 20000);
            function done(val) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                try { wrap.remove(); } catch (e) { /* 已移除 */ }
                resolve(val);
            }
            const wrap = document.createElement('div');
            // 第36轮修复(用户反馈"弹窗不关闭导致卡顿"): 原实现是全屏半透明遮罩(z-index 99999),
            // 20 秒内挡住整个界面 → 用户/自动化点不到任何控件。改为非阻塞悬浮:
            // 容器 pointer-events:none(不拦截点击) + 去掉暗色背景; 仅卡片自身 pointer-events:auto。
            wrap.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:99999;display:flex;' +
                'align-items:center;justify-content:center;pointer-events:none;';
            const card = document.createElement('div');
            card.style.cssText = 'max-width:330px;margin:16px;padding:14px 16px;border-radius:14px;' +
                'background:#2b2440;color:#f4eeff;font-size:13px;line-height:1.65;pointer-events:auto;' +
                'box-shadow:0 12px 34px rgba(0,0,0,0.5);border:1px solid rgba(190,160,255,0.38);';
            const msg = document.createElement('div');
            msg.textContent = o.text || '';
            msg.style.cssText = 'white-space:pre-wrap;margin-bottom:12px;';
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;';
            function mk(label, primary, val) {
                const b = document.createElement('button');
                b.textContent = label;
                b.style.cssText = 'padding:6px 12px;border-radius:10px;font-size:12.5px;cursor:pointer;color:#f8f2ff;' +
                    'border:1px solid ' + (primary ? 'rgba(255,150,190,0.62)' : 'rgba(190,160,255,0.36)') + ';' +
                    'background:' + (primary ? 'rgba(255,140,185,0.24)' : 'rgba(255,255,255,0.07)') + ';';
                b.addEventListener('click', () => done(val));
                return b;
            }
            row.appendChild(mk(o.okText || '好', true, 'ok'));
            row.appendChild(mk(o.cancelText || '取消', false, 'cancel'));
            card.appendChild(msg);
            card.appendChild(row);
            wrap.appendChild(card);
            document.body.appendChild(wrap);
        });
    }

    // 消息列表 DOM 窗口化: 只保留最近 max 个节点, 超出部分从顶部移除; 返回移除总高度(调用方用于滚动锚定)
    function trimMessageDom(container, max) {
        if (!container) return 0;
        const kids = container.children;
        const excess = kids.length - max;
        if (excess <= 0) return 0;
        let removed = 0;
        for (let i = 0; i < excess; i++) {
            const el = kids[i];
            if (!el) break;
            try {
                const cs = getComputedStyle(el);
                removed += el.offsetHeight + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
            } catch (e) { /* 忽略 */ }
            el.remove();
        }
        return removed;
    }

    // =============================================================
    // 第44轮·模块A: 每轮上下文预算(纯函数, 无 DOM, 可单测)
    // 背景: 历史此前只按条数裁(chat-engine trimHistory, MAX_HISTORY=20 条),
    //       但 20 条里只要夹着一条几万字的粘贴, 单轮就会把上下文预算撑爆。
    // 两条硬规则: ①system(身份提示词)永不裁; ②最新一条 user(用户此刻说的话)保留原文 = 绝对权重。
    // 分层降级: L1 丢最旧整条(至少留 keepMin 条) → L2 超长旧消息压成头尾 → L3 只留 system + 最新 user 并留省略标记。
    // 回归闸门: budgetTokens <= 0 → 原样返回(全关 == 现版本行为)。
    // =============================================================
    const CTX_BUDGET_DEFAULT = 8000;

    // 保守 token 估算: 非 ASCII 记 1 token/字, ASCII 记 0.3 token/字(宁多算, 不低估)
    function estTokens(text) {
        const s = String(text == null ? '' : text);
        if (!s) return 0;
        let cjk = 0;
        for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) > 127) cjk++; }
        return Math.ceil(cjk + (s.length - cjk) * 0.3);
    }

    // 把一条超长文本压成"头 70% + 尾 30%", 中段留可辨识标记(不静默删字)
    function squeezeText(text, keepTokens) {
        const s = String(text == null ? '' : text);
        const est = estTokens(s);
        if (est <= keepTokens) return s;
        const ratio = keepTokens / est;
        const headLen = Math.max(20, Math.floor(s.length * 0.7 * ratio));
        const tailLen = Math.max(8, Math.floor(s.length * 0.3 * ratio));
        return s.slice(0, headLen) + '…（原话过长，中段已省略）…' + s.slice(Math.max(headLen, s.length - tailLen));
    }

    function budgetTrim(messages, opts) {
        const list = Array.isArray(messages) ? messages.slice() : [];
        const o = opts || {};
        const budget = Number(o.budgetTokens);
        if (!isFinite(budget) || budget <= 0) return list; // 全关: 一个字都不动
        if (!list.length) return list;
        const keepMin = Math.max(2, Number(o.keepMinMessages) || 4);
        const maxPerMsg = Math.max(80, Number(o.maxPerMsgTokens) || 300);
        // 最新一条 user 用对象引用锁定: splice 之后下标会漂, 引用不会
        let newestUser = null;
        for (let i = list.length - 1; i >= 0; i--) { if (list[i] && list[i].role === 'user') { newestUser = list[i]; break; } }
        const sysTokens = list.reduce((n, m) => n + (m && m.role === 'system' ? estTokens(m.content) : 0), 0);
        const total = () => list.reduce((n, m) => n + estTokens(m && m.content), 0) - sysTokens;
        // 预算只算对话历史: system(身份提示词)是固定成本, 不能算进预算 ——
        // 否则人设一长(实测 soul + 全局铁律 + 格式 + 锚点 ≈ 9K token)就会每轮触发 L3 把历史清空。
        if (total() <= budget) return list; // 常态: 没越线就一个字都不动

        // L1: 从最旧的可丢消息开始整条丢(跳过 system 与最新 user), 至少保留 keepMin 条
        let guard = 0;
        while (total() > budget && list.length > keepMin && guard++ < 500) {
            let dropAt = -1;
            for (let i = 0; i < list.length; i++) {
                if (!list[i] || list[i].role === 'system' || list[i] === newestUser) continue;
                dropAt = i; break;
            }
            if (dropAt < 0) break;
            list.splice(dropAt, 1);
        }
        if (total() <= budget) return list;

        // L2: 仍超 → 把剩下的旧消息(非 system、非最新 user)压成头尾
        for (let i = 0; i < list.length && total() > budget; i++) {
            if (!list[i] || list[i].role === 'system' || list[i] === newestUser) continue;
            if (estTokens(list[i].content) > maxPerMsg) list[i] = { role: list[i].role, content: squeezeText(list[i].content, maxPerMsg) };
        }
        if (total() <= budget) return list;

        // L3: 仍超(说明 system 或最新 user 本身就很长) → 只留 system + 最新 user, 并留省略标记
        const out = list.filter((m) => m && m.role === 'system');
        if (newestUser) out.push(newestUser);
        out.push({ role: 'system', content: '（本轮前面的对话因超出上下文预算已被省略，只保留用户最新这一句；不要假装记得被省略掉的内容。）' });
        return out;
    }

    // =============================================================
    // 第44轮·模块D: 用户主导的白盒记忆(纯函数, 无 DOM, 可单测)
    // 原则: 记忆属于用户 —— 可看/可改/可删/可降权/可带走; AI 只建议, 用户确认;
    //       用户标注(权重/标签)优先于自动压缩, 标注过的记忆不得被摘要改写或被 prune 清掉。
    // 权重: 0 未标注(=普通行为) / 1 低(只留关键词) / 2 普通 / 3 高(高保真摘要) / 4 绝对核心(原话, 可每轮注入)
    // =============================================================
    const MEMORY_WEIGHTS = { none: 0, low: 1, normal: 2, high: 3, absolute: 4 };
    const MEMORY_WEIGHT_LABELS = { 0: '未标注', 1: '低', 2: '普通', 3: '高', 4: '绝对核心' };
    // 点星循环: 未标注 → 高 → 绝对核心 → 低 → 未标注(一次点击走一格, 不填表)
    // 历史遗留的 2(普通) 按未标注处理, 再点一下就是「高」
    const MEMORY_WEIGHT_CYCLE = [0, 3, 4, 1];
    function nextMemoryWeight(w) {
        const idx = MEMORY_WEIGHT_CYCLE.indexOf(Number(w) || 0);
        const i = idx < 0 ? 0 : idx;
        return MEMORY_WEIGHT_CYCLE[(i + 1) % MEMORY_WEIGHT_CYCLE.length];
    }
    // 关键词提取(给「低」权重用): 没有分词器, 用边界字把句子切成 2 字以上的短段。
    // 例: "用户的妈妈住在杭州, 每周日都给我打电话。" → 妈妈 / 杭州 / 每周日 / 打电话
    const KW_BOUNDARY = '的了着过在是和与及就都也还很太最更不没别要想会能可去来上下里外前后边给对从向把被让使说做打住吃喝睡玩学问找买卖爱恨等帮叫认记忘喜怕累忙遇开关换用通看到这那我你他她它您吗呢吧啊哦嗯呀之其所而则于为将已经再又才只每却并且如果因所以';
    const KEYWORD_STOP = { '用户': 1, '我们': 1, '你们': 1, '他们': 1, '她们': 1, '这个': 1, '那个': 1, '什么': 1, '怎么': 1, '因为': 1, '所以': 1, '但是': 1, '如果': 1, '已经': 1, '可以': 1, '一个': 1, '没有': 1, '自己': 1, '时候': 1, '东西': 1, '事情': 1, '今天': 1, '昨天': 1, '现在': 1, '还是': 1, '就是': 1, '不是': 1, '这样': 1, '那样': 1, '一下': 1, '有点': 1, '知道': 1, '觉得': 1, '感觉': 1, '真的': 1, '其实': 1 };
    function keywordsOf(text, n) {
        const s = String(text == null ? '' : text);
        const out = [];
        const seen = {};
        const push = (raw) => {
            let t = String(raw || '').trim();
            if (t.length > 10) t = t.slice(0, 10);      // 切不开的长句只留开头, 免得「低」变成整句
            if (t.length < 2 || KEYWORD_STOP[t] || seen[t]) return;
            seen[t] = 1;
            out.push(t);
        };
        let buf = '';
        for (let i = 0; i < s.length; i++) {
            const ch = s.charAt(i);
            if (/[\u4e00-\u9fa5]/.test(ch)) {
                if (KW_BOUNDARY.indexOf(ch) >= 0) { push(buf); buf = ''; }
                else buf += ch;
            } else { push(buf); buf = ''; }
        }
        push(buf);
        (s.match(/[A-Za-z]{3,}/g) || []).forEach(push);
        return out.slice(0, n || 8);
    }
    // 第79轮: 输入法(中文/日文)组词过程中按回车 = "选候选词", 不是"发送"。
    // Chromium 的组词期 keydown 带 isComposing=true(旧路径是 keyCode 229); 两个都认。
    function isImeKey(e) {
        if (!e) return false;
        return e.isComposing === true || e.keyCode === 229 || e.which === 229;
    }
    // 按用户权重把一条记忆渲染成提示词里的一行(纯函数: 同样的输入永远同样的输出)
    function renderMemoryLine(m, opt) {
        const o = opt || {};
        const w = Number(m && m.userWeight) || 0;
        const content = String((m && m.content) || '');
        const raw = m && m.raw_user_text ? String(m.raw_user_text) : '';
        if (w === MEMORY_WEIGHTS.absolute) return '- ' + (raw || content).slice(0, o.absoluteMax || 300);
        if (w === MEMORY_WEIGHTS.high) {
            const head = content.slice(0, o.highMax || 240);
            return '- ' + head + (raw ? '（原话：' + raw.slice(0, 90) + '）' : '');
        }
        if (w === MEMORY_WEIGHTS.low) {
            const k = keywordsOf(content, o.keywordMax || 8);
            return '- ' + (k.length ? k.join('、') : content.slice(0, 24));
        }
        return '- ' + content;
    }

    window.Shared = { escapeHtml, renderRich, extractMood, extractHeartVoices, stripMarkersForStream, detectMood, systemTime, syncSend, syncOn, syncOwn: () => syncChannel().own, trimMessageDom, fixDict, stripEmphasis, showChoice, estTokens, squeezeText, budgetTrim, CTX_BUDGET_DEFAULT, MEMORY_WEIGHTS, MEMORY_WEIGHT_LABELS, MEMORY_WEIGHT_CYCLE, nextMemoryWeight, keywordsOf, renderMemoryLine, isImeKey };
})();
