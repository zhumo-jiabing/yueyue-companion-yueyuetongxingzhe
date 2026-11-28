// [r221 P6] 游戏陪伴感知 L0 —— 纯逻辑模块(无 DOM/无网络/无存储)
// 只做「前台窗口标题 / 进程名」级识别: 她注意到你在玩什么, 像同行者一样随口搭一句。
// 裁决D: 不假装看得懂战局/输赢/操作 —— 拿不准只说「你先忙」类, 绝不编造游戏名。
// 隐私: 输入只有窗口标题与进程名, 只在本机用; 本模块不落盘、不出网、不写记忆。
// 识别表可扩展: 往 TABLE 里加 { id, name, proc:[进程名小写前缀], title:[标题关键词小写] } 即可。
(function () {
    'use strict';

    // 具名游戏表: proc 按「去掉 .exe 的进程名小写」前缀匹配; title 按小写包含匹配。
    // needTitle:true = 进程名太泛(如 javaw), 必须标题也命中才算, 防误报。
    var TABLE = [
        { id: 'deltaforce', name: '三角洲行动', proc: ['deltaforce'], title: ['三角洲行动', 'delta force'] },
        { id: 'lol', name: '英雄联盟', proc: ['leagueclient', 'league of legends'], title: ['英雄联盟', 'league of legends'] },
        { id: 'valorant', name: '无畏契约', proc: ['valorant'], title: ['无畏契约', 'valorant'] },
        { id: 'cs2', name: 'CS2', proc: ['cs2', 'csgo'], title: ['counter-strike', '反恐精英'] },
        { id: 'genshin', name: '原神', proc: ['genshinimpact', 'yuanshen'], title: ['原神', 'genshin impact'] },
        { id: 'starrail', name: '崩坏：星穹铁道', proc: ['starrail'], title: ['崩坏：星穹铁道', 'honkai: star rail'] },
        { id: 'zzz', name: '绝区零', proc: ['zenlesszonezero'], title: ['绝区零', 'zenless zone zero'] },
        { id: 'naraka', name: '永劫无间', proc: ['naraka'], title: ['永劫无间', 'naraka'] },
        { id: 'pubg', name: '绝地求生', proc: ['tslgame'], title: ['绝地求生', 'pubg'] },
        { id: 'apex', name: 'Apex 英雄', proc: ['r5apex'], title: ['apex legends'] },
        { id: 'dota2', name: 'DOTA2', proc: ['dota2'], title: ['dota 2'] },
        { id: 'wow', name: '魔兽世界', proc: ['wow'], title: ['魔兽世界', 'world of warcraft'] },
        { id: 'hearthstone', name: '炉石传说', proc: ['hearthstone'], title: ['炉石传说', 'hearthstone'] },
        { id: 'wuthering', name: '鸣潮', proc: ['wuthering'], title: ['鸣潮', 'wuthering waves'] },
        { id: 'minecraft', name: '我的世界', proc: ['javaw', 'minecraft'], title: ['minecraft', '我的世界'], needTitle: true },
        { id: 'palworld', name: '幻兽帕鲁', proc: ['palworld'], title: ['幻兽帕鲁', 'palworld'] },
        { id: 'wukong', name: '黑神话：悟空', proc: ['b1-win64-shipping'], title: ['黑神话', 'black myth'] }
    ];

    // 泛游戏平台(启动器): 命中只说明「游戏相关平台开着」, 拿不准具体游戏 → kind:'generic'。
    // 精确匹配进程名(去 .exe 小写), 不做前缀, 防 steamwebhelper 之类误报。
    var GENERIC_PROCS = ['steam', 'wegame', 'epicgameslauncher', 'battle.net', 'riotclient', 'hoyoplay', 'ubisoftconnect', 'eadesktop'];

    // 搭话模板: 暖、短、反傲慢。禁「加油/会好的/你应该」; 不评价水平、不催玩、不判战局。
    // [r224] 老板点名「你玩三角洲行动，我在这儿」几乎没用：不再宣告在场，改成具体的照顾/邀请。
    var NAMED_LINES = [
        '{name}开了。你先忙，我把自己的声音收小一点。',
        '这局好好打，打完要是想说话，跟我说说。',
        '你打你的，我不吵你；肩要是酸了，记得活动一下。'
    ];
    // 拿不准(泛平台/未知游戏): 不宣告在场，也不声称用户在玩什么(裁决D)。
    var GENERIC_LINES = [
        '你先忙，我不吵你。',
        '忙完了跟我说说。'
    ];
    var SAFE_LINES = ['你先忙，我不吵你。', '忙完了跟我说说。'];
    // [r224f] 按「局内时长 / 局末」说具体的话：不假装看见战局，只用她确实知道的时长与「打完/切出去」。
    var MID_LINES = [
        '{name}这局打了{min}了，肩不酸吗？',
        '打了{min}了，喝口水再打。',
        '这局挺久了（{min}），眼睛歇一下。'
    ];
    var END_LINES = [
        '打完了？赢了输了都行，跟我说说。',
        '不打了？那过来歇会儿。',
        '这局打了{min}，先缓缓。'
    ];
    var BACKGROUND_END_LINES = [
        '先不打了？那歇会儿，想说话叫我。',
        '切出来了？我在这儿，不催你回去。'
    ];

    // 出口禁词闸(双保险): 反傲慢铁律词 + 战局断言/评价词。命中即回落 SAFE。
    var BANNED = ['加油', '会好的', '你应该', '别想太多', '多喝热水', '早点睡', '早点休息', '睡一觉就好了',
        '明天会更好', '想开点', '你要相信自己', '这没什么大不了的', '会好起来的',
        '稳赢', '肯定赢', '必胜', '这局稳', '带飞', '躺赢', '你太菜', '坑货', '玩得菜'];

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function guard(line) {
        var s = String(line || '');
        for (var i = 0; i < BANNED.length; i++) { if (s.indexOf(BANNED[i]) !== -1) return pick(SAFE_LINES); }
        if (!s || s.length > 60) return pick(SAFE_LINES);
        return s;
    }

    // 时长说人话：25–35 分钟说「半小时」，60 分钟说「1 小时」，其余按分钟。
    function humanMinutes(minutes) {
        var m = Math.max(1, Math.round(Number(minutes) || 1));
        if (m >= 25 && m <= 35) return '半小时';
        if (m >= 60) {
            var h = Math.round(m / 6) / 10;
            return (h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)) + '小时';
        }
        return m + '分钟';
    }

    // 局内中段：只在同一局持续到 30 分钟后说一次；不评价水平。
    function makeMidLine(det, minutes) {
        var name = (det && det.name) ? String(det.name) : '你';
        var min = humanMinutes(minutes);
        var line = pick(MID_LINES).replace(/\{name\}/g, name).replace(/\{min\}/g, min);
        return guard(line) + '\n[MOOD: quiet_company]';
    }

    // 局末：reason='closed' 表示游戏窗口/进程没了；'background' 表示只是切出去/还在后台。
    // 不声称知道输赢，只问/接住；用 she 确实知道的时长。
    function makeEndLine(det, minutes, reason) {
        var min = humanMinutes(minutes);
        var arr = (reason === 'background') ? BACKGROUND_END_LINES : END_LINES;
        var line = pick(arr).replace(/\{min\}/g, min);
        return guard(line) + '\n[MOOD: quiet_company]';
    }

    // 生成一句搭话(内部必过禁词闸)。det 来自 detect(); 拿不准一律 GENERIC/SAFE。
    function makeLine(det) {
        var line;
        if (det && det.kind === 'named' && det.name) line = pick(NAMED_LINES).replace(/\{name\}/g, String(det.name));
        else line = pick(GENERIC_LINES);
        return guard(line) + '\n[MOOD: quiet_company]';
    }

    // "proc | title" 行 → { proc(小写,去.exe), title(原文), tl(小写标题) }
    function parseLine(line) {
        var s = String(line || '');
        var idx = s.indexOf(' | ');
        var proc = idx >= 0 ? s.slice(0, idx).trim() : '';
        var title = idx >= 0 ? s.slice(idx + 3).trim() : s.trim();
        proc = proc.toLowerCase().replace(/\.exe$/, '');
        return { proc: proc, title: title, tl: title.toLowerCase() };
    }

    function matchProc(entry, proc) {
        if (!proc) return false;
        for (var i = 0; i < entry.proc.length; i++) { if (proc === entry.proc[i] || proc.indexOf(entry.proc[i]) === 0) return true; }
        return false;
    }
    function matchTitle(entry, titleLower) {
        if (!titleLower) return false;
        for (var i = 0; i < entry.title.length; i++) { if (titleLower.indexOf(entry.title[i]) !== -1) return true; }
        return false;
    }
    // 前台标题与某窗口标题互相包含 → 视为「用户正在这个窗口里」(与 refreshEnvSnapshot 的 watching 同口径)
    function fgMatches(fg, tl) {
        return !!fg && fg.length >= 2 && tl.length >= 2 && (fg === tl || fg.indexOf(tl) !== -1 || tl.indexOf(fg) !== -1);
    }

    // 主入口: windows = env:list-windows 的 "proc | title" 数组; fgTitle = env:snapshot 的前台标题。
    // 返回 null(无游戏迹象) 或 { kind:'named'|'generic', id, name, foreground, via, proc, title }。
    // foreground=true 才允许搭话(用户真的在游戏窗口里); 只开着没在玩 → 不打扰。
    function detect(windows, fgTitle) {
        var fg = String(fgTitle || '').trim().toLowerCase();
        if (/玥玥|数字伴侣|electron/.test(fg)) fg = '';   // 不把她自己/开发窗当游戏
        var list = Array.isArray(windows) ? windows : [];
        var parsed = [];
        for (var i = 0; i < list.length; i++) { var w = parseLine(list[i]); if (w.title || w.proc) parsed.push(w); }

        var namedFg = null, namedRun = null;
        for (var e = 0; e < TABLE.length; e++) {
            var entry = TABLE[e];
            // 前台标题直接命中(游戏窗口可能不在枚举列表里, 如独占全屏)
            if (!namedFg && matchTitle(entry, fg)) {
                namedFg = { kind: 'named', id: entry.id, name: entry.name, foreground: true, via: 'fg-title', proc: '', title: String(fgTitle || '') };
            }
            for (var k = 0; k < parsed.length; k++) {
                var pw = parsed[k];
                var hitProc = matchProc(entry, pw.proc);
                var hitTitle = matchTitle(entry, pw.tl);
                var hit = entry.needTitle ? hitTitle : (hitProc || hitTitle);
                if (!hit) continue;
                var cand = { kind: 'named', id: entry.id, name: entry.name, foreground: fgMatches(fg, pw.tl), via: hitProc ? 'proc' : 'title', proc: pw.proc, title: pw.title };
                if (cand.foreground) { if (!namedFg) namedFg = cand; }
                else if (!namedRun) namedRun = cand;
            }
        }
        if (namedFg) return namedFg;
        if (namedRun) return namedRun;

        // 泛游戏平台: 精确进程名命中; 前台是该平台窗口才算 foreground
        for (var g = 0; g < parsed.length; g++) {
            var gw = parsed[g];
            if (GENERIC_PROCS.indexOf(gw.proc) === -1) continue;
            return { kind: 'generic', id: '', name: '', foreground: fgMatches(fg, gw.tl), via: 'proc', proc: gw.proc, title: gw.title };
        }
        return null;
    }

    var api = { TABLE: TABLE, GENERIC_PROCS: GENERIC_PROCS, BANNED: BANNED, detect: detect, makeLine: makeLine, makeMidLine: makeMidLine, makeEndLine: makeEndLine, humanMinutes: humanMinutes, guard: guard, parseLine: parseLine };
    if (typeof window !== 'undefined') window.GameSense = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();