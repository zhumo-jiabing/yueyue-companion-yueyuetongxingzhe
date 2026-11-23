// =============================================================
// analytics.js — P1-4 本地埋点(20 核心事件 · 2026-09-09 用户拍板清单)
// 原则(合规红线, pivot/04-growth): 匿名 + 纯本地(localStorage, 零云端) + 可关闭 + 可导出/清除。
// 只记事件名 + 次数 + 日期 + 有界枚举 meta; 绝不记消息内容/用户名/Key/任何文本原文。
//
// 20 事件清单:
//   养成 8(pivot/02-game-design 指定预留):
//     chat_duration          聊天时长(分钟级活跃分钟数/日, 经 trackChatSend 记录)
//     late_night_company     深夜陪伴(23:00-05:00 有互动, 每天最多记 1 次)
//     watch_along_count      陪看 12 秒次数(主窗+宠物窗)
//     game_count             游戏小窗对局次数(meta=游戏名)
//     heart_card_count       心声卡数量(带【心声】卡片的消息)
//     old_memory_recall      旧事提起(功能未上线, ID 预留勿删)
//     story_node_done        主线节点完成(功能未上线, ID 预留勿删)
//     ending_tendency_change 结局倾向变动(功能未上线, ID 预留勿删)
//   留存/产品 12:
//     first_seen         首次启动时间戳(仅一条, 留存分母)
//     app_launch         每次启动(次日/7日/30日留存分子)
//     first_message      首条消息(仅一条, meta=距首启分钟数 → 第一小时激活口径)
//     chat_send          消息发送(主窗+聊天小窗)
//     wake_interaction   唤醒互动
//     voice_input        语音输入(meta=ok/fail)
//     tts_play           TTS 播放成功
//     memory_created     记忆新增(meta=分类)
//     achievement_unlock 成就解锁(meta=成就id)
//     tag_adjusted       标签微调(meta=±标签名)
//     today_sign         今日签抽取
//     model_switched     模型档切换(meta=旧->新)
//
// 存储: yueyue_analytics(JSON); 关闭开关: yueyue_analytics_off=1
// 数据治理: byDay 保留 90 天, chatMinutes 保留 30 天, byMeta 键上限 50(超出丢弃新键)。
// 查看入口: 功能地图(帮助)「📊 本地使用统计」卡; 关闭入口: ⚙️设置「本地统计(匿名)」。
// =============================================================
window.YueyueAnalytics = (function () {
    'use strict';
    const KEY = 'yueyue_analytics';
    const OFF_KEY = 'yueyue_analytics_off';
    const BYDAY_KEEP_DAYS = 90;
    const CHAT_MINUTES_KEEP_DAYS = 30;
    const META_KEY_CAP = 50;
    const LATE_NIGHT_FROM = 23; // 23:00 起算深夜(含), 至次日 05:00(不含)
    const LATE_NIGHT_TO = 5;

    const EVENTS = [
        // 养成 8(含 3 个预留 ID)
        'chat_duration', 'late_night_company', 'watch_along_count', 'game_count',
        'heart_card_count', 'old_memory_recall', 'story_node_done', 'ending_tendency_change',
        // 留存/产品 12
        'first_seen', 'app_launch', 'first_message', 'chat_send', 'wake_interaction',
        'voice_input', 'tts_play', 'memory_created', 'achievement_unlock', 'tag_adjusted',
        'today_sign', 'model_switched',
    ];

    function pad2(n) { return (n < 10 ? '0' : '') + n; }
    function dayKey(ts) {
        const d = new Date(ts === undefined ? Date.now() : ts);
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    function dayDiff(a, b) {
        return Math.round((new Date(b + 'T00:00:00').getTime() - new Date(a + 'T00:00:00').getTime()) / 86400000);
    }

    function load() {
        try {
            const s = JSON.parse(localStorage.getItem(KEY) || '{}');
            if (s && typeof s === 'object') return s;
        } catch (e) { /* 损坏则重建 */ }
        return {};
    }
    function save(s) {
        try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* 存储异常静默 */ }
    }
    function prune(s) {
        try {
            const today = dayKey();
            if (s.events) {
                Object.keys(s.events).forEach((k) => {
                    const byDay = s.events[k] && s.events[k].byDay;
                    if (!byDay) return;
                    Object.keys(byDay).forEach((d) => { if (dayDiff(d, today) > BYDAY_KEEP_DAYS) delete byDay[d]; });
                });
            }
            if (s.chatMinutes) {
                Object.keys(s.chatMinutes).forEach((d) => { if (dayDiff(d, today) > CHAT_MINUTES_KEEP_DAYS) delete s.chatMinutes[d]; });
            }
        } catch (e) { /* 修剪失败不阻断 */ }
    }
    function isEnabled() { try { return localStorage.getItem(OFF_KEY) !== '1'; } catch (e) { return true; } }
    function setEnabled(on) {
        try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, '1'); } catch (e) { /* 忽略 */ }
    }

    /** 原始埋点: track(事件名, 可选有界枚举 meta)。关闭后为 no-op。 */
    function track(event, meta) {
        if (!isEnabled()) return;
        if (EVENTS.indexOf(event) === -1) return; // 白名单外的 ID 一律拒绝
        const s = load();
        s.events = s.events || {};
        const e = (s.events[event] = s.events[event] || { total: 0, byDay: {} });
        const day = dayKey();
        e.total = (e.total || 0) + 1;
        e.byDay[day] = (e.byDay[day] || 0) + 1;
        if (meta !== undefined && meta !== null && meta !== '') {
            const mv = String(meta).slice(0, 40); // meta 只允许短枚举值
            e.byMeta = e.byMeta || {};
            if (Object.keys(e.byMeta).length < META_KEY_CAP || e.byMeta[mv] !== undefined) {
                e.byMeta[mv] = (e.byMeta[mv] || 0) + 1;
            }
        }
        prune(s);
        save(s);
    }

    /** 启动埋点: first_seen(仅一条, 留存分母) + app_launch。 */
    function noteLaunch() {
        if (!isEnabled()) return;
        const s = load();
        if (!s.firstSeen) {
            s.firstSeen = Date.now();
            s.events = s.events || {};
            const e = (s.events.first_seen = s.events.first_seen || { total: 0, byDay: {} });
            e.total = 1;
            e.byDay[dayKey()] = 1;
            save(s);
        }
        track('app_launch');
    }

    /**
     * 聊天消息复合埋点(主窗 performChatSend / 聊天小窗 sendMessage 调用):
     * first_message(仅一条, meta=距首启分钟数) + 活跃分钟去重(chat_duration) +
     * chat_send 计数 + 深夜陪伴(每日最多 1 次)。
     */
    function trackChatSend() {
        if (!isEnabled()) return;
        const s = load();
        s.events = s.events || {};
        // first_message 仅记一条
        const fs = s.events.first_message;
        if (!fs || !fs.total) {
            const base = s.firstSeen || Date.now();
            const mins = Math.max(0, Math.round((Date.now() - base) / 60000));
            const e = (s.events.first_message = { total: 1, byDay: {} });
            e.byDay[dayKey()] = 1;
            e.byMeta = {};
            e.byMeta[String(mins).slice(0, 40)] = 1;
        }
        // 活跃分钟(分钟粒度去重) → chat_duration
        const day = dayKey();
        const now = new Date();
        const minute = now.getHours() * 60 + now.getMinutes();
        s.chatMinutes = s.chatMinutes || {};
        const arr = (s.chatMinutes[day] = s.chatMinutes[day] || []);
        if (arr.indexOf(minute) === -1) arr.push(minute);
        prune(s);
        save(s);
        track('chat_send');
        // 深夜陪伴: 23:00-05:00 互动, 每天最多记 1 次
        const h = now.getHours();
        if (h >= LATE_NIGHT_FROM || h < LATE_NIGHT_TO) {
            const ln = s.events.late_night_company;
            if (!ln || !ln.byDay || !ln.byDay[day]) track('late_night_company');
        }
    }

    /** 帮助页统计卡的聚合文本(纯本地可读, 满足"查阅权")。 */
    function summary() {
        const s = load();
        const ev = s.events || {};
        const total = (n) => (ev[n] && ev[n].total) || 0;
        const lines = [];
        if (s.firstSeen) {
            const days = Math.floor((Date.now() - s.firstSeen) / 86400000);
            lines.push('相识第 ' + (days + 1) + ' 天 · 累计启动 ' + total('app_launch') + ' 次');
            const launch = (ev.app_launch && ev.app_launch.byDay) || {};
            const dkey = (offset) => dayKey(s.firstSeen + offset * 86400000);
            const next = launch[dkey(1)] ? '✅' : '—';
            const d7 = days >= 7 ? (launch[dkey(7)] ? '✅' : '—') : '未到';
            const d30 = days >= 30 ? (launch[dkey(30)] ? '✅' : '—') : '未到';
            lines.push('次日留存 ' + next + ' · 7日留存 ' + d7 + ' · 30日留存 ' + d30);
            const fm = ev.first_message;
            if (fm && fm.total) {
                const mins = fm.byMeta ? Object.keys(fm.byMeta)[0] : '?';
                lines.push('第一小时激活 ' + (Number(mins) <= 60 ? '✅' : '—') + '(首条消息在第 ' + mins + ' 分钟)');
            } else {
                lines.push('第一小时激活 —(还没说过话)');
            }
        } else {
            lines.push('尚无数据(启动一次后开始记录)');
        }
        const cm = s.chatMinutes || {};
        let chatMin7 = 0;
        for (let i = 0; i < 7; i++) chatMin7 += (cm[dayKey(Date.now() - i * 86400000)] || []).length;
        lines.push('最近 7 天聊天活跃 ' + chatMin7 + ' 分钟 · 消息 ' + total('chat_send') + ' 条(累计)');
        const rows = [
            ['唤醒', 'wake_interaction'], ['陪看', 'watch_along_count'], ['游戏', 'game_count'],
            ['心声卡', 'heart_card_count'], ['今日签', 'today_sign'], ['语音输入', 'voice_input'],
            ['TTS', 'tts_play'], ['记忆', 'memory_created'], ['成就', 'achievement_unlock'],
            ['标签微调', 'tag_adjusted'], ['模型切换', 'model_switched'],
        ];
        lines.push('功能使用(累计): ' + rows.map((r) => r[0] + ' ' + total(r[1])).join(' · '));
        lines.push('状态: ' + (isEnabled() ? '记录中(匿名·仅本机)' : '已关闭'));
        return lines.join('\n');
    }

    /** 导出 JSON(满足"复制权"; __meta 附匿名声明)。 */
    function exportJson() {
        const s = load();
        s.__meta = {
            generatedAt: new Date().toISOString(),
            note: '匿名本地统计: 只含事件计数与日期, 不含任何对话内容',
        };
        return JSON.stringify(s, null, 2);
    }

    /** 清除全部统计(满足"删除权")。 */
    function clear() { try { localStorage.removeItem(KEY); } catch (e) { /* 忽略 */ } }

    return {
        track, noteLaunch, trackChatSend, summary, exportJson, clear,
        setEnabled, isEnabled, EVENTS,
    };
})();
