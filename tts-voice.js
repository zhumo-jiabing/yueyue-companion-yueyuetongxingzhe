// =============================================================
// 语音输出模块(主窗口与聊天窗口共用):
// 开关状态 / 流式联动 / 顺序播放 / 状态提示
// 播放采用 Web Audio API,不依赖 CSP 媒体源,可随时打断
//
// 2026-09-09 体验批次修复(用户真机反馈):
// - 流式逐句朗读恢复: 攒满一句(≥10字, 且不带未闭合标签/括号)就开读,
//   长回复不必等全文结束才出声(修"等一分钟才听到声音")
// - 2026-09-11 用户拍板(反转 09-09 规则): 新消息立即打断已排队/在途的朗读——长回复多段语音
//   不再拖着排到新回复后面(20 分钟无声音的排队侧成因); 发送路径 sendMessage 调 interrupt()
// - 多句在途合成按句序播放(提前返回的晚句会排队, 不乱序)
// - 拟声词"嗯"最多补 1 次且已含语气词/just_woke 不补(修"嗯拖音 4 秒")
// - speak 入口统一 cleanText: 剥括号动作/心声/MOOD/星号(修"主动说话把括号内容读了")
// =============================================================
(function () {
    const C = window.TTS_CONFIG || {
        API_URL: 'http://127.0.0.1:9880',
        PARAMS: {},
        EMOTIONS: {},
        MOOD_MAP: {},
        DEFAULT_EMOTION: '日常',
    };
    let enabled = localStorage.getItem('yueyue_voice_on') === '1';
    let statusListener = null;
    let audioCtx = null;
    let currentSource = null;
    let errorTimer = null;
    let interruptGen = 0; // 打断代际:真正的打断(关语音)时+1,在途请求完成后比对,过期结果直接丢弃
    let inFlight = 0; // 正在合成中的请求数(用于显示"送给你"等待文案)
    let inFlightSince = 0; // 2026-09-11: 最早在途请求的起始时刻(实时生成秒数提示)
    let statusTicker = null;
    const queue = [];
    // 有序播放: 流式逐句开读后, 多句合成可能乱序返回, 用序号+暂存保证按句序播出
    let speakSeq = 0;
    let nextPlaySeq = 1;
    const speakHold = new Map();
    // 2026-09-12 可测性: 段落级统计。真机验证脚本据此做客观断言——
    // total === played + skipped + interrupted 且 skipped === 0 (skipped>0 就是用户听到的"省略")。
    let segTotal = 0, segPlayed = 0, segSkipped = 0, segInterrupted = 0;
    let lastSegs = []; // 第92轮: 最近一次 speak() 的切段结果(只读诊断, 供真机时间线核对首声/间隔)
    // 语气词音效:回复只有标点/动作没台词时,放一个她用自己声音合成的轻叹
    const SIGH_FILES = ['sigh-1.wav', 'sigh-2.wav', 'sigh-3.wav', 'sigh-4.wav'];
    let sighAudio = null;

    // ---------- 显卡自适应:主进程校准完成后下发推荐采样步数 ----------
    function applyTtsConfig(cfg) {
        if (cfg && typeof cfg.sampleSteps === 'number' && cfg.sampleSteps > 0) {
            C.PARAMS = Object.assign({}, C.PARAMS, { sample_steps: cfg.sampleSteps });
            console.log('[语音] 显卡自适应档位:', cfg.sampleSteps, '步');
        }
    }
    try {
        window.yueyue.tts.onConfig(applyTtsConfig);
        // 事件可能错过,15 秒后兜底拉取一次
        setTimeout(() => {
            window.yueyue.tts.getConfig().then(applyTtsConfig).catch(() => { /* 忽略 */ });
        }, 15000);
    } catch (e) { /* 旧版 preload 无此接口时忽略 */ }

    function playSigh() {
        // 有语音正在播/排队时不叠加叹息,避免声音打架
        if (currentSource || queue.length > 0) return;
        try {
            if (!sighAudio) sighAudio = new Audio();
            sighAudio.src = SIGH_FILES[Math.floor(Math.random() * SIGH_FILES.length)];
            sighAudio.play().catch(() => { /* 忽略自动播放限制 */ });
        } catch (e) { /* 忽略 */ }
    }

    function stopSigh() {
        if (sighAudio) {
            try { sighAudio.pause(); } catch (e) { /* 忽略 */ }
            sighAudio = null;
        }
    }

    // 2026-10-24 第85轮: 错误提示要活得住——refreshStatus 会在合成结束时立刻把状态清空,
    // 旧实现里用户根本看不到「语音没起来」, 只看到「生成中…N秒」然后没了。
    let statusLockUntil = 0;
    function emitStatus(text) {
        if (statusListener) statusListener(text);
    }

    function clearErrorSoon() {
        clearTimeout(errorTimer);
        errorTimer = setTimeout(() => {
            // 只有没有正在播/排队/合成中的内容时才清掉提示
            if (!currentSource && queue.length === 0 && inFlight === 0) emitStatus(null);
        }, 4000);
    }

    // 状态优先级:播放中 > 合成中 > 无
    // 2026-09-11: 合成中显示实时已等待秒数(用户拍板"生成可以慢, 但要提示生成慢+实时时间")
    function refreshStatus() {
        if (Date.now() < statusLockUntil) return; // 第85轮: 提示还在有效期内, 不要覆盖
        if (currentSource || queue.length > 0) { stopTicker(); emitStatus('正在读文本…'); return; }
        if (inFlight > 0) {
            const sec = inFlightSince ? Math.round((Date.now() - inFlightSince) / 1000) : 0;
            emitStatus('她的声音生成中…' + sec + 's（长句要 1-2 分钟，可以先看文字）');
            if (!statusTicker) statusTicker = setInterval(() => {
                if (inFlight > 0 && !currentSource && queue.length === 0) {
                    const s2 = inFlightSince ? Math.round((Date.now() - inFlightSince) / 1000) : 0;
                    emitStatus('她的声音生成中…' + s2 + 's（长句要 1-2 分钟，可以先看文字）');
                } else { stopTicker(); }
            }, 1000);
            return;
        }
        stopTicker();
        emitStatus(null);
    }
    function stopTicker() { if (statusTicker) { clearInterval(statusTicker); statusTicker = null; } }

    // 去掉【心声】/[MOOD:xxx] 标签和成行的动作描写（xxx）,只留要朗读的台词
    // v5: 同时剥 markdown 星号与词典错词(如 vacuum海), 与显示文本同源
    function cleanText(raw) {
        const a = Shared.extractHeartVoices(raw);
        let t = Shared.extractMood(a.text).text;
        if (Shared.stripEmphasis) t = Shared.stripEmphasis(t);
        if (Shared.fixDict) t = Shared.fixDict(t);
        const NL = String.fromCharCode(10);
        const lines = t.split(NL);
        const kept = [];
        lines.forEach((line) => {
            const s = line.trim();
            if (!s) return;
            // v4: 剥掉行内所有括号动作(全角/半角)与【】标记, 只读台词本身
            const cleaned = s.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/【[^】]*】/g, '').trim();
            if (!cleaned) return;
            kept.push(cleaned);
        });
        return kept.join(NL).trim();
    }

    // 在最后一个句末标点处截断,保证提前开读时读到的是完整句子
    function cutAtSentence(text) {
        const marks = ['。', '！', '？', '…', '!', '?', '~', '\n'];
        let best = -1;
        marks.forEach((m) => {
            const i = text.lastIndexOf(m);
            if (i > best) best = i;
        });
        if (best >= 0) return text.slice(0, best + 1);
        return text;
    }

    // 按情绪微调语音(语速/温度)
    // r164: 上一版「温度再降一档、语气平稳不跌宕起伏」= 冷淡。温度整体抬 0.12~0.14，
    // 温柔系再加句间停顿(0.5s)；语速基本不动，慢本身不是问题，平才是问题。
    const MOOD_VOICE = {
        gentle: { speed_factor: 0.76, temperature: 0.92, fragment_interval: 0.5 },
        night_watch: { speed_factor: 0.73, temperature: 0.9, fragment_interval: 0.52 },
        quiet_company: { speed_factor: 0.74, temperature: 0.9, fragment_interval: 0.52 },
        sad: { speed_factor: 0.78, temperature: 0.92, fragment_interval: 0.5 },
        concerned: { speed_factor: 0.79, temperature: 0.9, fragment_interval: 0.5 },
        serious: { speed_factor: 0.84, temperature: 0.88 },
        thinking: { speed_factor: 0.82, temperature: 0.9 },
        waiting: { speed_factor: 0.77, temperature: 0.9, fragment_interval: 0.5 },
        // 刚醒首句: 更慢更困, 但不再压温度
        just_woke: { speed_factor: 0.68, temperature: 0.86, fragment_interval: 0.62 },
        shy: { speed_factor: 0.82, temperature: 0.94 },
        morning_greet: { speed_factor: 0.86, temperature: 0.92 },
        tea_time: { speed_factor: 0.82, temperature: 0.92, fragment_interval: 0.5 },
        talking: { speed_factor: 0.88, temperature: 0.92 },
        happy: { speed_factor: 0.98, temperature: 0.98 },
        playful: { speed_factor: 1.0, temperature: 0.98 },
        smug: { speed_factor: 0.96, temperature: 0.96 },
        surprised: { speed_factor: 0.94, temperature: 0.96 },
    };
    // 场景锚点感知: 正在做安静的事(窗边/歌单/夜色/发呆...), 即使标了活泼情绪也放慢放轻
    const QUIET_SCENE = /窗边|靠窗|窗前|窗户|窗外|歌单|翻来覆去|静静|安静|慢慢|发呆|歇|困|晚风|夜色|月光|雨|夜深|躺|窝在|角落|闭眼|晚安|一人|坐着|茶杯|茶吧|听歌|灯光|暗|发呆|转圈看|轻轻|[（(][^）)]{0,10}看窗/;
    function sceneMoodFor(raw) {
        if (!raw) return null;
        if (QUIET_SCENE.test(String(raw))) return 'quiet_company';
        return null;
    }

    function emotionFor(mood) {
        // 刚醒首句: 固定走"关心"参考音频(语速慢、音调低、带气流感), 与 just_woke 参数配合
        if (mood === 'just_woke') return '关心';
        return (C.MOOD_MAP && C.MOOD_MAP[mood]) || C.DEFAULT_EMOTION;
    }

    function refFor(emotion) {
        return (C.EMOTIONS && C.EMOTIONS[emotion]) || null;
    }

    // 第93轮（用户反馈「前后生成的短句音色和身份都不一致」）：同一条回复内锁死一份音色档案。
    // 实测依据 `_r93-audit/voiceid*.log`：
    //   - qwen3-1.7B 逐句独立合成时，3-8 字短句的 F0 中位在 240-427 Hz 之间跳（极差 148-187 Hz ≈ 一个八度）；
    //   - 同样的文字合并到 18-34 字一段后，F0 中位极差降到 32-63 Hz，MFCC 余弦 ≥0.991。
    // 叠加问题：旧 speak() 每次都用「截至当前」的整条回复重算 sceneMood —— 回复后段一旦出现
    // 「窗边/听歌」这类场景词，effMood 会从原情绪翻成 quiet_company，A 卡引擎的参考音频随即换人。
    // 所以此处把 effMood/ref 一次定档：首段用当时的上下文算，整条回复（含 onDone 尾段）复用。
    function voiceProfileFor(mood, rawForScene) {
        const sceneMood = sceneMoodFor(rawForScene);
        const effMood = sceneMood || mood || C.DEFAULT_EMOTION;
        return { effMood: effMood, ref: refFor(emotionFor(effMood)) };
    }

    function ensureCtx() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    // IPC 返回的 Uint8Array -> 纯 ArrayBuffer(decodeAudioData 要求)
    function toArrayBuffer(chunk) {
        if (chunk instanceof ArrayBuffer) return chunk;
        if (chunk && chunk.buffer) {
            return chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        }
        return null;
    }

    async function playNext() {
        const item = queue.shift();
        if (!item) {
            currentSource = null;
            refreshStatus();
            return;
        }
        if (item.wav) segPlayed++;
        refreshStatus();
        const ctx = ensureCtx();
        // H1: AudioContext 若仍 suspended(自动播放限制/音频服务崩溃后重建), src.start() 不会真正出声
        // 且 onended 永不触发 → 播放队列永久卡死 = 用户听到的"永久静音"。先异步 resume 再放。
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* 忽略 */ } }
        const isWake = !!(item && item.wake);
        const ab = toArrayBuffer(item && item.wav ? item.wav : item);
        if (!ab) { playNext(); return; }
        const myGen2 = interruptGen; // t3 低危: decode 异步窗口内若发生打断, 回调丢弃旧段(队列已被清空)
        ctx.decodeAudioData(ab, (decoded) => {
            if (myGen2 !== interruptGen) return;
            const src = ctx.createBufferSource();
            src.buffer = decoded;
            const gain = ctx.createGain();
            if (isWake) {
                // 刚醒首句: 更轻(0.72) + 低通 3600Hz 去掉亮刺 + 0.5s 开口停顿(像先缓了口气再开口)
                gain.gain.value = 0.72;
                const lp = ctx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.value = 3600;
                lp.Q.value = 0.5;
                src.connect(lp);
                lp.connect(gain);
            } else {
                // v3: 统一低音量输出(0.86), 深夜也不刺耳
                gain.gain.value = 0.86;
                src.connect(gain);
            }
            gain.connect(ctx.destination);
            let ended = false;
            let watchdog = null;
            const advance = () => {
                if (ended) return;
                ended = true;
                clearTimeout(watchdog);
                currentSource = null;
                playNext();
            };
            // H1 卡死自愈: 音频服务崩溃/设备丢失/上下文被挂起时 onended 永不触发, 队列会永久停在这条上。
            // 按音频实际时长 + 3s 兜底跳到下一条, 把"永久静音"降级为"最多丢一段"。
            watchdog = setTimeout(advance, Math.max(4000, decoded.duration * 1000 + 3000));
            src.onended = advance;
            currentSource = src;
            src.start(isWake ? ctx.currentTime + 0.5 : 0);
        }, () => {
            // 解码失败(罕见):跳过继续播下一条
            playNext();
        });
    }

    // ---------- 有序播放(流式逐句开读后, 合成完成顺序不保证) ----------
    function seqAdvance() {
        while (speakHold.has(nextPlaySeq)) {
            const it = speakHold.get(nextPlaySeq);
            speakHold.delete(nextPlaySeq);
            nextPlaySeq++;
            if (it) queue.push(it);
        }
        if (!currentSource && queue.length) playNext();
    }
    function enqueueOrdered(seq, item) {
        speakHold.set(seq, item);
        seqAdvance();
    }
    // 某序号合成失败: 占位跳过, 别让后面的句子永远等它
    function skipOrdered(seq) {
        segSkipped++; // 客观指标: 本次会话被跳过的段落数(>0 = 漏读)
        if (seq >= nextPlaySeq && !speakHold.has(seq)) speakHold.set(seq, null);
        seqAdvance();
    }

    // 拟声词填充: 句中省略号处补"嗯", 让停顿有真实思考感(默认开, localStorage yueyue_fillers='0' 关闭)
    // v5(修"嗯拖音4秒"): 每条消息最多补 1 次; 已带 嗯/呃 的不补(刚醒首句自带"……嗯"就不会再补第二个)
    // v8(2026-09-12 用户反馈「拟声词后面必须跟上长句子」): 旧规则只排除"省略号后面紧跟句末标点/语气词",
    // 于是「……好。」这类**短尾巴**也会被补成「……嗯，好。」——"嗯"孤零零立在那里(听感=一个语气词+停顿)。
    // 现在要求省略号后面**至少还有 6 个连续字符**才补; 且服务端会把短 clause 与后一句合并
    // (stt/qwen3tts_server.py 的短句合并), 双保险确保"嗯"总附着在一段完整的话前面。
    function addFillers(text, mood) {
        if (localStorage.getItem('yueyue_fillers') === '0') return text;
        const t = String(text);
        if (/[嗯呃唉]/.test(t)) return t;
        let used = false;
        // 2026-09-12 第九轮修正: 阈值 6 → 4。原 6 会把「我醒了……等很久了吗？」这类**省略号后只有 5 个字**
        // 的口语句判成"短尾巴"而不补语气词(实测该串：等/很/久/了/吗 = 5 个字，？ 终止)，与 V3 的设计意图相反；
        // 阈值 4 既保住 v8 要修的「……好。」(1 个字, 不补), 又让正常口语句拿得到停顿感。
        return t.replace(/(……|\.{3,})(?=\s*[^。！？.!?~\n]{4,})/g, (m0) => {
            if (used) return m0;
            used = true;
            return m0 + '嗯，';
        });
    }

    // 是否包含可朗读的字符(汉字/字母/数字);纯标点或纯符号直接跳过,避免 API 400
    function hasSpeakableText(t) {
        for (let i = 0; i < t.length; i++) {
            const c = t.charCodeAt(i);
            if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 48 && c <= 57) ||
                (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
                return true;
            }
        }
        return false;
    }

    // =============================================================
    // 2026-09-12 长回复「省略 / 几句混在一起」根因修复(用户真机反馈: 150s 看门狗修复后仍存在):
    // 旧实现 onChunk 每攒够 36 字就**并发**发一个合成请求 → 一条长回复十几段请求几乎同时打到服务端,
    // 而服务端是 Semaphore(1) 串行合成 → 靠后的请求要在队列里干等数分钟 → 撞上 main.js 的单请求
    // 240s 超时 → 触发 restart() 把 python 整个杀掉(正在合成的那段 + 其它所有排队请求一起作废)
    // → 重试风暴 → 三次都失败的段被 skipOrdered 静默跳过(= 用户听到的「省略」), 同一段又被反复
    // 重新合成再播(= 听到的「几句话混在一起 / 同样输出」)。
    // 修复: 客户端改成有界并发(2)的 FIFO 合成队列 —— 在途最多 2 个, 队首之外的等待 ≤ 1 段合成,
    // 240s 预算只覆盖「排队 + 单段」, 从根上不再触发杀服务连锁; 同时保留 1 段预读, 不拖慢开声。
    // =============================================================
    const SYNTH_CONCURRENCY = 2;
    const MAX_SYNTH_CHARS = 90; // main.js 注释: 合法长文本(≤140字) CPU 合成可达 ~170s, 单请求必须切短
    let synthActive = 0;
    const synthQueue = [];

    // 第92轮(交接「首声太慢 / 说着说着卡住」): 真机实测 qwen3-1.7B/cuda/bf16 的**吞吐是硬约束**
    //   - 单小句(9-14 字)合成 4.9-5.9 s, 音频 2.1-2.6 s → RTF≈2(合成永远慢于播放一倍);
    //   - 并发度 2 实测**反而更慢**(两句各 14.1 s, 串行才是 5.3 s)—— GPU 已吃满, 不加并发;
    //   - 换 0.6B 实测 4.9 s / 2.08 s 音频, RTF 更差(2.36 vs 2.0) —— 与模型大小无关, 是每帧多码本解码的固定成本。
    // 结论: 总量降不下来, 能做的是**别让用户等整段**。旧实现把首句之后的文字按 ≤90 字打包成一段
    // (2-4 小句 = 10-22 s 才回 WAV), 播放完上一段就出现 10 s 以上的死寂。
    // 现改为「逐小句切段」: 每凑够 CLAUSE_MIN_CHARS 就在标点处切一刀, 合成了就播,
    // 把 10-22 s 的一段静音摊成每句 2-3 s 的均匀间隔, 首声不变(仍只等 1 句)。
    const FIRST_SYNTH_CHARS = 24;
    // 第93轮: 首段也要"够长"。旧实现第一个逗号就切，实测首段常只有 4-9 字，而 3-8 字独立合成的
    // F0 中位会飘出 148-187 Hz（≈一个八度）—— 用户听到的第一句就像另一个人。现在至少等到 14 字
    // 的停顿再切；24 字内找不到够长停顿就整段送（宁可首声慢一点，也不再让第一句换人）。
    const FIRST_MIN_CHARS = 14;
    // 第93轮: 8 → 14。实测 qwen3-1.7B 在 3-8 字短片上逐句独立合成时 F0 中位极差 148-187 Hz
    // （≈一个八度，听感就是「换人」）；18-34 字一段时极差 32-63 Hz。服务端 merge_short_clauses
    // 同步把 MERGE_SHORT 提到 16，这条是渲染层自己的下限：两条一起抬高，才不会在服务端被重新切碎。
    const CLAUSE_MIN_CHARS = 14; // 与服务端 merge_short_clauses(MERGE_SHORT=16) 同口径
    // 首段 = **第一小句**: 服务端是逐 clause 串行合成(实测每个 clause 5.3 s 左右, 与其字数几乎无关),
    // 所以首声快慢只取决于「第一个 request 里有几个 clause」。旧实现取 24 字内**最靠后的句末标点**,
    // 「在窗边听歌，懒得动。…」首段 = 2 个 clause = 10.6 s 才出声(实测)。
    // 改成在**第一个停顿处**就切(逗号也算): 首段 = 1 个 clause → ~5.3 s 出声。
    // 逗号是自然停顿, 不算把句子劈开; 没有停顿标点时仍不切(宁可慢)。
    function cutHeadForFirstSound(t) {
        const lim = Math.min(t.length, FIRST_SYNTH_CHARS);
        // 第92轮: 括号内的逗号不算"停顿" —— 旧版会把「（趴在窗边，指尖搭在玻璃上）」从中间切开，
        // 前一段只剩半句动作，听感像被掐断。深度为 0 的标点才是可切点。
        let depth = 0;
        for (let i = 0; i < lim; i++) {
            const ch = t[i];
            if ('（(【['.indexOf(ch) !== -1) { depth++; continue; }
            if ('）)】]'.indexOf(ch) !== -1) { if (depth > 0) depth--; continue; }
            if (depth === 0 && i >= 3) {
                // 第93轮: 首段必须 ≥FIRST_MIN_CHARS 字，否则继续等下一个停顿（首声略慢，音色不换人）。
                if (i + 1 < FIRST_MIN_CHARS) continue;
                // 第92轮: 省略号是「……」(两个 …) 组成的停顿, 不能在中间切 ——
                // 否则「我醒了……嗯，」会被劈成「我醒了…」+「…嗯，」，首个 request 只剩半截省略号。
                if (ch === '…') {
                    let j = i;
                    while (j < t.length && t[j] === '…') j++;
                    return t.slice(0, j);
                }
                if ('，、,。！？…；\n'.indexOf(ch) !== -1) return t.slice(0, i + 1);
            }
        }
        return '';
    }

    // 分段不影响音色: clone 模式音色由锚定 embedding 锁定, 每句独立合成仍是同一个人
    // 第93轮: ≤MAX_SYNTH_CHARS 的整段**不再切**。实测(voiceid_test5): 同一条回复切成 3 段时
    // 段间 F0 中位极差 60 Hz, 切成 2 段(24+20 字)只有 16.3 Hz —— 边界越少, 越听不出换人。
    // 切段彻底交给流式攒段(首个 16 字 + 之后整段), 这里只对超长文本兜底硬切。
    function splitForSynth(text) {
        const t = String(text);
        if (t.length <= MAX_SYNTH_CHARS) return [t];
        // 第92轮: 首个停顿时就切（即使整段只有 12-24 字）—— 旧实现 t≤24 直接整段返回，
        // 于是流式每次攒够 12 字送来的两小句仍是一个请求（2 个 clause ≈10.6 s 才出声）。
        const head = cutHeadForFirstSound(t);
        if (!head && t.length <= FIRST_SYNTH_CHARS) return [t];
        const rest = head ? t.slice(head.length) : t;
        const out = head ? [head] : [];
        let acc = '';
        for (const ch of rest) {
            acc += ch;
            const isPause = '，。！？…；：\n'.indexOf(ch) !== -1;
            if (isPause && acc.length >= CLAUSE_MIN_CHARS) { out.push(acc); acc = ''; }
            else if (acc.length >= MAX_SYNTH_CHARS) { out.push(acc); acc = ''; } // 无标点长句兜底硬切(原有行为)
        }
        if (acc) {
            // 末尾残句太短就并回上一段: 否则最后 2 个字也要单开一次 ~5 s 的合成。
            // 第92轮修正: 但不能并回"首段" —— 首段是 cutHeadForFirstSound 特意切出来的 1 个 clause,
            // 并回去又变成 2 个 clause(实测首声 10.6 s), 首声提速等于没做。
            const canMerge = head ? out.length >= 2 : out.length >= 1;
            const last = out.length ? out[out.length - 1] : '';
            if (canMerge && last && (last.length + acc.length) <= MAX_SYNTH_CHARS) out[out.length - 1] = last + acc;
            else out.push(acc);
        }
        return out.length ? out : [t];
    }

    function pumpSynth() {
        while (synthActive < SYNTH_CONCURRENCY && synthQueue.length) {
            const job = synthQueue.shift();
            synthActive++;
            synthOne(job).then(
                () => { synthActive--; endSynth(); pumpSynth(); },
                () => { synthActive--; endSynth(); pumpSynth(); }
            );
        }
    }

    // 2026-09-12: 只在"真的有合成在跑"这段时间关掉后台节流 —— 既保住 09-11 修的"切后台不省略句子",
    // 又不让三窗在空闲时全速跑(用户实测切页面等语音时生成时间翻几倍)。
    // 2026-09-12 第九轮(审计 B2): 旧实现只发"全速/恢复"两种状态, 多窗并发时互相覆盖 ——
    // A 窗还在合成, B 窗合成结束就把全局节流又打开了(A 窗被节流 -> 生成变慢, 正是用户抱怨的现象)。
    // 改成**会话计数器**: 每个窗口各自维护一个合成会话, 有任一窗口在合成 = 全速; 全部结束才恢复节流。
    let bgFullSpeed = false;
    let synthSessionOpen = false;
    function setBgFullSpeed(on) {
        if (bgFullSpeed === on) return;
        bgFullSpeed = on;
        try {
            if (window.yueyue && window.yueyue.perf && window.yueyue.perf.setBgThrottling) {
                window.yueyue.perf.setBgThrottling(on).catch(function () { /* 忽略 */ });
            }
        } catch (e) { /* 忽略 */ }
    }
    function openSynthSession() {
        if (synthSessionOpen) return;
        synthSessionOpen = true;
        setBgFullSpeed(true);
        try {
            if (window.yueyue && window.yueyue.perf && window.yueyue.perf.beginBgFullSpeed) {
                window.yueyue.perf.beginBgFullSpeed();
            }
        } catch (e) { /* 忽略 */ }
    }
    function closeSynthSession() {
        if (!synthSessionOpen) return;
        synthSessionOpen = false;
        try {
            if (window.yueyue && window.yueyue.perf && window.yueyue.perf.endBgFullSpeed) {
                window.yueyue.perf.endBgFullSpeed();
            }
        } catch (e) { /* 忽略 */ }
        setBgFullSpeed(false);
    }

    function endSynth() {
        inFlight = Math.max(0, inFlight - 1);
        if (inFlight === 0) { inFlightSince = 0; closeSynthSession(); } // 全部合成结束 → 关会话(计数归零才恢复节流)
        refreshStatus();
    }

    let refReady = false;
    async function speak(text, mood, rawForScene, profile) {
        if (!enabled || !text) return;
        // v5: 入口统一清洗(剥括号动作/心声/MOOD/星号/错词)——所有调用方(流式/主动/关心)都不再念括号
        text = cleanText(text);
        if (!text) return;
        if (!hasSpeakableText(text)) { playSigh(); return; }
        // 第93轮: 同一回复内由调用方传入定档的 profile；未传（主动/关心等单句）则就地算一份。
        const prof = profile || voiceProfileFor(mood, rawForScene || text);
        const effMood = prof.effMood;
        const ref = prof.ref;
        if (!ref) {
            // v7: 旧实现在拿不到参考音频时直接 return —— 整段静默不读, 用户完全不知道少了一句
            console.warn('[语音] 缺少参考音频, 跳过朗读:', effMood);
            return;
        }
        // 2026-10-24 第85轮: 新装机器没装语音包时, 不要「生成中…」10 秒后静默。
        // 先花 ~3ms 问主进程要目录（不拉起 python），缺就当场给一句白话提示并返回。
        if (!refReady) {
            let av = null;
            try { av = await window.yueyue.tts.available(); } catch (e) { av = null; }
            if (av && av.ok === false) {
                emitStatus('这台电脑还没装语音包，先只显示文字；装好后在设置里把语音打开就行。');
                clearErrorSoon();
                return;
            }
            if (av && av.ok === true) refReady = true;
        }
        const moodParams = MOOD_VOICE[effMood] || {};
        const voiceParams = Object.assign({}, C.PARAMS, moodParams);
        const beforeFillers = text;
        text = addFillers(text, effMood);
        // 第98轮 S2-P2-5: 补语气词发生在长度判定之前，「嗯，」这 2 字会把 89-90 字的回复顶到 91-92 字 →
        // 客户端切 2 段、服务端再合成两次 → 段间音色漂移。音色一致性优先于语气词：
        // 原文本来不超长时不补词（宁可少一个「嗯」，也不让同一句回复换人）。
        if (String(text).length > MAX_SYNTH_CHARS && String(beforeFillers).length <= MAX_SYNTH_CHARS) text = beforeFillers;
        const myGen = interruptGen;
        openSynthSession(); // 2026-09-12: 本窗进入合成会话(多窗用计数器, 任一窗在合成就不节流)
        const segs = splitForSynth(text);
        // 第93轮: 一行诊断（不含正文，只字数/情绪/参考文件名）——真机核对「一条回复内是否锁同一音色」
        try {
            console.log('[语音] 合成段 ' + segs.length + ' 段 | 情绪=' + effMood + ' | 参考=' +
                (ref.ref_audio_path ? String(ref.ref_audio_path).split(/[\\/]/).pop() : 'none') +
                ' | 字数=' + segs.map((s) => String(s).length).join(','));
        } catch (e) { /* 诊断日志失败不影响合成 */ }
        segTotal += segs.length; // 统计口径: 入队段数(与 played/skipped/interrupted 对账)
        lastSegs = segs.slice();
        segs.forEach((seg) => {
            const mySeq = ++speakSeq;
            inFlight++;
            if (!inFlightSince) inFlightSince = Date.now();
            synthQueue.push({ text: seg, voiceParams: voiceParams, effMood: effMood, ref: ref, myGen: myGen, mySeq: mySeq });
        });
        setBgFullSpeed(true); // 有句子进入合成队列 → 朗读期间允许全速(关闭后台节流)
        refreshStatus();
        pumpSynth();
    }

    async function synthOne(job) {
        if (job.myGen !== interruptGen) return; // 已被打断(关语音/新消息/跨窗): 不再浪费一次合成
        try {
            const res = await window.yueyue.tts.speak({
                text: job.text,
                apiUrl: C.API_URL,
                ref_audio_path: job.ref.ref_audio_path,
                prompt_text: job.ref.prompt_text,
                params: job.voiceParams,
                mood: job.effMood, // qwen3tts 引擎用(情绪→说话方式映射); sovits/indextts 忽略此字段
            });
            if (job.myGen !== interruptGen) return; // 真正的打断(如关语音),丢弃过期结果
            if (res && res.ok) {
                try { if (window.YueyueAnalytics) YueyueAnalytics.track('tts_play'); } catch (e2) { /* 埋点失败忽略 */ }
                enqueueOrdered(job.mySeq, { wav: res.wav, wake: job.effMood === 'just_woke' });
            } else {
                skipOrdered(job.mySeq);
                const errMap = {
                    // 第85轮: 原句是开发者的口吻（GPT-SoVITS 目录），用户看不懂也帮不上忙。
                    TTS_SERVICE_MISSING: '语音没启动成功，先用文字陪你；稍后在设置里重新打开语音试试。',
                    NO_REF: '这段没找到合适的音色，先用文字陪你。',
                };
                const code = res && res.error;
                statusLockUntil = Date.now() + 6000;
                emitStatus(errMap[code] || '语音没起来，先用文字陪你；稍后再打开语音试试。');
                clearErrorSoon();
            }
        } catch (err) {
            if (job.myGen !== interruptGen) return;
            skipOrdered(job.mySeq);
            statusLockUntil = Date.now() + 6000;
            emitStatus('语音没起来，先用文字陪你；稍后再打开语音试试。');
            clearErrorSoon();
        }
    }

    // 真正的打断: "关闭语音开关"、⏹ 停止按钮、以及"用户发新消息"(2026-09-11 拍板, 两窗 sendMessage
    // 调用并经 BroadcastChannel 'voice-interrupt' 跨窗同步)——清队列+停当前+在途合成按代际丢弃。
    function interrupt() {
        interruptGen++;
        // 2026-09-12 用户实测"中断后还要等 ~300s 才生成完": 旧实现只清客户端队列, 服务端**排队中/
        // 未开工**的合成任务会继续烧 CPU(用户机器因此明显卡顿)。这里顺带通知主进程 POST /cancel,
        // 让引擎丢弃尚未开始的句子; 引擎不支持该端点时静默忽略(旧 python 不会因此报错)。
        try { if (window.yueyue && window.yueyue.tts && window.yueyue.tts.cancel) window.yueyue.tts.cancel().catch(function () {}); } catch (e) { /* 忽略 */ }
        // 被打断而没播完的段落单独计数(与 skipOrdered 的"合成失败漏读"区分开)
        for (const it of queue) { if (it) segInterrupted++; }
        for (const it of speakHold.values()) { if (it) segInterrupted++; }
        queue.length = 0;
        speakHold.clear();
        // v7: 还没开工的合成任务直接丢弃(它们的 myGen 已过期, 留着只会空跑一轮把队列堵住)
        let droppedJobs = 0;
        while (synthQueue.length) { synthQueue.shift(); droppedJobs++; endSynth(); }
        segInterrupted += droppedJobs; // 口径修正(真机验证发现): 被丢弃的待合成任务同样属于"未播完的段"
        speakSeq = 0;
        nextPlaySeq = 1;
        stopSigh();
        if (currentSource) {
            try { currentSource.stop(); } catch (e) { /* 已停止 */ }
            currentSource = null;
        }
        clearTimeout(errorTimer);
        inFlightSince = 0;
        stopTicker();
        refreshStatus();
    }

    // 流式联动控制器:每个发送请求创建一个
    // v6 朗读策略(2026-09-10 用户反馈: 人格一致性大幅下降+句间隔太长):
    // - 攒段开读: 攒满 ~56 字(约 2-4 句)才合成一次, 服务端把段内切成小句拼接成一个完整音频——
    //   段内声线绝对一致, 句间由服务端 250ms 静音衔接, 消除逐句独立请求造成的长空隙。
    //   (v5 逐句开读: 每句独立请求, CPU 合成 2-4s/句, 播放完一句下一句还在路上=句句卡顿)
    // - 整条消息统一 mood: 首段检测一次, 后续段全部复用——不同 mood 会映射成不同的
    //   qwen3tts 说话方式 instruct, 每句变一个声线就是"每句话都是不同人"的根因。
    // - 用户拍板: 质量优先于速度。首段等待比逐句略长, 但换来连贯一致的听感。
    function makeStreamTTS() {
        const state = { spoken: '', spokenClean: '', doneFired: false, mood: null, profile: null, spokeFirst: false };
        // 第93轮: 12 → 16。实测短于 ~12 字的独立请求 F0 中位极差可达 148-187 Hz，16-24 字一段降到 32-63 Hz；
        // 代价是首声多等一两秒（首段仍由 cutHeadForFirstSound 控制在 24 字内），换来整条回复同一音域。
        // 第104轮: 把原来的 MIN_NEW_CHARS 改名为 FIRST_STREAM_CHARS（只是改名+注释，行为与第93轮一致）。
        // 曾试过降到 10 字（假设能提前首声），理由充分: 单次合成耗时 ≈ 字数×0.4 s（45 字整段 17.9 s、
        // 10 字 3.9 s），音色代价也小（同句整段 F0 中位 307.7 Hz vs 前 10 字 315.8 Hz，仅差 8 Hz，
        // 远小于 3-8 字短片的 148-187 Hz）。但真机 3 组对照跑不出来（10 字组首声 21.9/17.9/19.4 s，
        // 16 字组 21.7/33.3/…，噪声比效果大——本机同时跑着开发工具，端到端首声被环境吃掉）。
        // 没有证据的更快就是慢，故**回退到 16**；要再试必须先给探针加 CPU/GPU 遥测并在空闲机器上测。
        const FIRST_STREAM_CHARS = 16;
        // 第93轮: 首段出声后，剩余文字攒到这么多字（或 onDone）才再合成 —— 少一个段边界，
        // 就少一次「音域跳档」。40 字 ≈ 单次合成 18 s / 音频 9 s（RTF≈2），是「等得起」与
        // 「边界少」的折中；超长回复仍会多几段，但每段都 ≥40 字，实测段间 F0 极差 <30 Hz。
        const HOLD_NEXT_CHARS = 40;
        // 从累积文本取"可安全朗读"的完整句前缀: 先截掉未闭合 ( （ 【 [MOOD: 的尾部, 再截到最后一个句末标点
        function safeSentencePrefix(acc) {
            let s = String(acc);
            const openers = [
                { open: '（', close: '）' },
                { open: '(', close: ')' },
                { open: '【', close: '】' },
                { open: '[MOOD:', close: ']' },
            ];
            let safeEnd = s.length;
            openers.forEach((o) => {
                let idx = s.lastIndexOf(o.open);
                while (idx !== -1) {
                    if (s.indexOf(o.close, idx + o.open.length) === -1) safeEnd = Math.min(safeEnd, idx);
                    // 修死循环: lastIndexOf 负起点按 0 处理, 开括号恰在第 0 位时 idx 永远回 0 →
                    // 渲染进程卡死(回复以（动作）开头 + 语音开时, 流式第一个字符就冻结窗口)
                    idx = idx > 0 ? s.lastIndexOf(o.open, idx - 1) : -1;
                }
            });
            s = s.slice(0, safeEnd);
            return cutAtSentence(s);
        }
        return {
            onChunk: (full) => {
                if (!enabled || state.doneFired) return;
                try {
                    const prefix = safeSentencePrefix(full);
                    // 第93轮: 门限按**清洗后**的字数算。旧实现按原始前缀算，括号动作（「（趴在窗边，指尖搭在玻璃上）」）
                    // 会把 16 字的门槛提前撑满，真正可朗读的只剩「就瘫着，」4 个字 —— 首段照样换人。
                    const cleanedAll = cleanText(prefix);
                    const deltaClean = cleanedAll.length - state.spokenClean.length;
                    // 第93轮: 首段之后不再每 16 字合成一次 —— 段边界就是音色漂移的源头。
                    // 实测 3 段(14/20/10 字)段间 F0 极差 60 Hz; 2 段(24+20 字)只有 16.3 Hz。
                    // 所以首段出声后，剩余文字攒到 HOLD_NEXT_CHARS(40) 或 onDone 时再整段合成。
                    if (!state.spokeFirst) {
                        // 首段门槛见 FIRST_STREAM_CHARS(16)。第104轮试过降到 10 字以提前首声,
                        // 真机对照被环境噪声淹没、看不出收益, 已回退 —— 理由写在常量上方注释里。
                        if (deltaClean < FIRST_STREAM_CHARS) return;
                    } else if (deltaClean < HOLD_NEXT_CHARS) {
                        return;
                    }
                    const chunk = cleanedAll.slice(state.spokenClean.length);
                    const cleaned = chunk.trim();
                    state.spoken = prefix;
                    state.spokenClean = cleanedAll;
                    if (cleaned) {
                        // v6: 整条消息只用首段检测的 mood, 后续段复用(声线一致)
                        if (!state.mood) state.mood = Shared.detectMood(cleaned);
                        // 第93轮: 首段定档音色档案（含 sceneMood），后续段与 onDone 尾段全部复用，
                        // 避免「后段才出现场景词 → effMood 翻转 → 参考音频换人」。
                        if (!state.profile) state.profile = voiceProfileFor(state.mood, full);
                        state.spokeFirst = true;
                        speak(cleaned, state.mood, full, state.profile);
                    }
                } catch (e) { /* 流式朗读失败不影响文字 */ }
            },
            onDone: (fullRaw) => {
                if (!enabled || state.doneFired) return;
                state.doneFired = true;
                const text = cleanText(fullRaw);
                if (!text) { if (!state.spoken) playSigh(); return; }
                if (!state.spoken) {
                    speak(text, Shared.extractMood(fullRaw).mood || Shared.detectMood(text), fullRaw);
                    return;
                }
                // 流式已读过前缀: 只补读剩余。
                // 2026-09-12 修复: 旧实现「前缀对不上就整段不补(宁可少读不重复)」实测会整段丢失——
                // 当前缀被 cleanText 清洗成空串(整段是括号动作/心声)或流式累计与最终文本清洗结果不一致时,
                // 条件为假 → 剩余正文一个字都不读(用户听到的就是「省略」)。
                // 改为按「最长可对齐前缀」回退: 保证剩余文本一定被读出(最坏情况重读半句, 不再漏整段)。
                // 第93轮: 用流式阶段已算好的清洗前缀对齐（比重新 cleanText 更准，动作/心声不会重复计入）
                const prefixClean = state.spokenClean || cleanText(state.spoken);
                let readLen = 0;
                if (prefixClean) {
                    if (text.startsWith(prefixClean)) {
                        readLen = prefixClean.length;
                    } else {
                        let k = prefixClean.length;
                        while (k > 0 && !text.startsWith(prefixClean.slice(0, k))) k--;
                        readLen = k;
                    }
                }
                const rest = text.slice(readLen).trim();
                if (rest) speak(rest, state.mood || Shared.detectMood(rest), fullRaw, state.profile);
            },
            onError: () => { state.doneFired = true; },
            // t5 方案3: 跨窗打断/⏹ 时由 handler 调用 — 短路本流后续 onChunk/onDone(防 onDone 补读把旧流整条复活)
            kill: () => { state.doneFired = true; },
        };
    }

    // 第136轮（老板 m02237）：1.7B + CUDA graph 的首次预热约 11–20 秒，必须发生在用户开口前。
    // 小字只说明“正常”，不挡界面；预热完成或 25 秒后自动消失。
    let prewarmNoticeTimer = null;
    function prewarmWithNotice() {
        try {
            if (!window.yueyue || !window.yueyue.tts || !window.yueyue.tts.prewarm) return;
            statusLockUntil = Date.now() + 15000; // 预热小字不被 refreshStatus 立刻清掉
            emitStatus('语音引擎在后台预热，首次约 20 秒，属正常。');
            clearTimeout(prewarmNoticeTimer);
            prewarmNoticeTimer = setTimeout(() => {
                statusLockUntil = 0;
                if (!currentSource && queue.length === 0 && inFlight === 0) emitStatus(null);
            }, 15000);
            window.yueyue.tts.prewarm();
        } catch (e) { /* 预热失败不影响说话 */ }
    }

    window.VoiceTTS = {
        isOn: () => enabled,
        setOn: (v) => {
            enabled = !!v;
            localStorage.setItem('yueyue_voice_on', enabled ? '1' : '0');
            if (!enabled) { interrupt(); return; }
            // 第101轮: 开语音的当下就请主进程预热(拉起服务 + /warm), 别等第一句话才加载模型。
            prewarmWithNotice();
        },
        setStatusListener: (fn) => { statusListener = fn; },
        unlock: () => { try { ensureCtx(); } catch (e) { /* 忽略 */ } },
        makeStreamTTS,
        speak,
        interrupt,
        // 待播队列长度(关心/主动等非紧急语音在积压多时跳过朗读,避免旧话连篇)
        // 2026-09-12: 计入在途合成(inFlight)。旧实现只数播放队列, 长回复「正在生成还没出声」的
        // 几十秒里 pendingCount=0 → 主动/关心语音会挤进来插播(= 听到两段话混在一起); 它也是
        // 判断「她还在说」的正确依据(铁律: pendingCount=0 不等于完成, 必须看 inFlight)。
        pendingCount: () => queue.length + speakHold.size + inFlight + (currentSource ? 1 : 0),
        // 2026-09-12 真机验证用: total=入队段数, played=已播段数, skipped=合成失败被跳过的段数(漏读指标),
        // interrupted=被新消息/关语音打断而未播完的段数。
        stats: () => ({ total: segTotal, played: segPlayed, skipped: segSkipped, interrupted: segInterrupted, queue: queue.length, hold: speakHold.size, playing: currentSource ? 1 : 0, inFlight: inFlight, lastSegs: lastSegs }),
        // 2026-09-12 用户拍板(长回复打断选择弹窗的判据): 当前还有多少朗读量没放完。
        // 每段 36-90 字、clone 端到端实测 ~0.9-1.4 字/秒 → 单段平均按 40s 估; remainSec>=120(约 2 分钟)算"长回复"。
        readingLoad: () => {
            const pending = queue.length + speakHold.size + inFlight + (currentSource ? 1 : 0);
            // 2026-09-12 实测校准: 真机端到端听感测试里每段平均 ~70s(6 段用了 360s), 原先按 40s 估算会
            // 明显低估剩余时长(15 段实际 ~15 分钟, 弹窗却说 ~10 分钟)。取 65s 作为段均值, 宁可略高估。
            const remainSec = pending * 65;
            return { pending: pending, remainSec: remainSec, remainMin: Math.max(1, Math.round(remainSec / 60)), long: remainSec >= 120 };
        },
        resetStats: () => { segTotal = 0; segPlayed = 0; segSkipped = 0; segInterrupted = 0; },
    };

    // 第102轮: 语音开着的用户, 启动 8 s 后自动预热(服务 + 模型 + 内核合成)。
    // 开机就抢 CPU/显存会拖慢界面首屏, 所以让主界面先画完再热身。
    if (enabled) {
        try {
            setTimeout(prewarmWithNotice, 8000);
        } catch (e) { /* 忽略 */ }
    }
})();
