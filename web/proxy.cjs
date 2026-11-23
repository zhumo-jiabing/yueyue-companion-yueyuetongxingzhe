#!/usr/bin/env node
/**
 * 玥玥 · 漫展网页版本机代理（第88轮 D1）
 *
 * 一句话：观众手机连我们的热点 → 打开 http://<这台机的局域网IP>:8080/m →
 *        手机里一格 Key 都没有，所有模型请求都从这里出去。
 *
 * 三条不可协商的边界（来源：docs/architecture/11_booth_security_threat_model.md）
 *   1. 静态站与 /api 同源同端口 —— 浏览器里不出现任何跨域，也不出现 Key。
 *   2. 前端的安全规则等于没有（soul.js 跑在观众浏览器里，DevTools 一改就绕），
 *      所以限额、模型白名单、max_tokens、L3 兜底词都在这一层强制。
 *   3. 上游地址写死、不可配置；Host 头必须是我们自己 —— 这是 DNS rebinding 唯一有效的拦截点。
 *
 * 用法：
 *   node proxy.cjs                      # 端口 8080，Key 从 web/booth.key 或 YUEYUE_KEY 读
 *   PORT=8080 node proxy.cjs
 *   YUEYUE_APP_ROOT=<app目录> node proxy.cjs
 *
 * 注意：绝不要把 Key 写进命令行参数（会留在进程 argv 里，ps 可见）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
// 二维码生成（Kazuhiko Arase 的 qrcode-generator，MIT，单文件零依赖，见 vendor/README）
const qrcode = require(path.join(__dirname, 'vendor', 'qrcode.js'));
const https = require('https');

const WEB = __dirname;
const APP = process.env.YUEYUE_APP_ROOT
    || 'K:\\yueyueneiceban\\win-unpacked\\resources\\app';
const PORT = Number(process.env.PORT || 8080);

// ---- 上游：写死，不接受任何入参覆盖 ----
const UPSTREAM_HOST = 'api.deepseek.com';
const UPSTREAM_PATH = '/chat/completions';

// 前端 model → 上游真实模型（前端那套名字是产品档位，不是 API 名字）
const MODEL_MAP = {
    'deepseek-v4-flash': 'deepseek-chat',
    'deepseek-v4-pro': 'deepseek-reasoner',
    'deepseek-flash': 'deepseek-chat',
    'deepseek-chat': 'deepseek-chat',
    'deepseek-reasoner': 'deepseek-reasoner',
};
const MODEL_DEFAULT = 'deepseek-chat';

// 站点图标：内联 SVG，省一个 404（浏览器对每个页面都会请求 /favicon.ico）
const FAVICON_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<rect width="64" height="64" rx="14" fill="#0b0916"/>' +
    '<path d="M32 11l4.9 12.6L49.5 28l-12.6 4.4L32 45l-4.9-12.6L14.5 28l12.6-4.4z" fill="#c8a2ff"/>' +
    '<circle cx="47" cy="45" r="4" fill="#ffd98a"/></svg>';

// ---- 限额（安全工程师口径）----
const MAX_BODY = 64 * 1024;      // 请求体 ≤64KB，流式读入阶段就截断
const MAX_MSG_CHARS = 2000;      // 单条 ≤2000 字
const MAX_MSGS = 30;             // messages ≤30
const MAX_TOKENS = 800;          // 服务端强制，客户端传值一律覆盖
const RATE_PER_MIN = 10;         // 单 IP 每分钟 10 次
const MAX_CONCURRENT = 4;        // 并发 ≤4
const DAILY_TURNS = Number(process.env.YUEYUE_DAILY_TURNS || 3000);
const TIMEOUT_CONNECT = 8000;    // 连接 8s
const TIMEOUT_TOTAL = 25000;     // 总体 25s（8s 一刀切会砍掉正常长回复）

// ---- 运行态 ----
const rateMap = new Map();   // ip -> {count, resetAt}
const dailyState = { day: dayKey(), used: 0 };
let concurrent = 0;
const startedAt = Date.now();

function dayKey() { return new Date().toISOString().slice(0, 10); }

function loadKey() {
    if (process.env.YUEYUE_KEY) return String(process.env.YUEYUE_KEY).trim();
    try { return fs.readFileSync(path.join(WEB, 'booth.key'), 'utf8').trim(); } catch (e) { return ''; }
}

function lanAddresses() {
    const set = new Set(['127.0.0.1', 'localhost', '::1', os.hostname().toLowerCase()]);
    const ifs = os.networkInterfaces();
    Object.keys(ifs).forEach((n) => (ifs[n] || []).forEach((a) => {
        if (a && (a.family === 'IPv4' || a.family === 4)) set.add(a.address);
    }));
    return set;
}
const ALLOWED_HOSTS = lanAddresses();

// ---- 小工具 ----
function send(res, code, body, headers) {
    const h = Object.assign({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers || {});
    // 先认 Buffer —— 否则 Buffer 会被下面的 object 分支 JSON 掉，
    // 浏览器拿到的就是 {"type":"Buffer","data":[...]}（第88轮实测踩过）
    if (Buffer.isBuffer(body)) {
        res.writeHead(code, h);
        return res.end(body);
    }
    if (typeof body === 'object') {
        h['Content-Type'] = 'application/json; charset=utf-8';
        res.writeHead(code, h);
        res.end(JSON.stringify(body));
        return;
    }
    res.writeHead(code, h);
    res.end(body);
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
};
const ALLOWED_EXT = new Set(Object.keys(MIME));

function serveFile(res, root, relPath) {
    let decoded;
    try { decoded = decodeURIComponent(relPath); } catch (e) { return send(res, 400, 'bad path'); }
    if (decoded.indexOf('\0') !== -1) return send(res, 400, 'bad path');
    const full = path.resolve(root, '.' + path.sep + decoded.replace(/^[\\/]+/, ''));
    const rootResolved = path.resolve(root);
    if (full !== rootResolved && !full.startsWith(rootResolved + path.sep)) {
        return send(res, 403, 'forbidden');
    }
    if (!ALLOWED_EXT.has(path.extname(full).toLowerCase())) return send(res, 404, 'not found');
    fs.readFile(full, (err, buf) => {
        if (err) return send(res, 404, 'not found');
        send(res, 200, buf, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    });
}

// ---- /m ：真源 index.html 实时注入（不复制、不漂移）----
function buildMobileHtml() {
    const src = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
    let html = src;
    const oldVp = '<meta name="viewport" content="width=device-width, initial-scale=1.0">';
    const newVp = '<meta name="viewport" content="width=device-width, initial-scale=1.0, '
        // 第88轮无障碍：不写 user-scalable=no / maximum-scale=1（禁止缩放是 WCAG 1.4.4 失分项），
        // 只加展台需要的两个能力：刘海屏铺满、软键盘改成压缩布局而不是盖住输入框。
        + 'viewport-fit=cover, interactive-widget=resizes-content">';
    if (html.indexOf(oldVp) === -1) throw new Error('viewport 锚点没找到：真源 index.html 变了，代理的注入点要跟着改');
    html = html.replace(oldVp, newVp);
    // 第96轮实测：立绘是首屏主角，但它是 CSS 背景，要等 m.css 里解析到才会开始下载，
    // 在 1.5 Mbps 的展台 4G 上会排到第 4.5 秒才出图。preload 把它提到最高优先级。
    html = html.replace('</head>',
        '<link rel="preload" as="image" href="/web/yueyue_avatar.webp">\n'
        + '<link rel="stylesheet" href="/web/m.css">\n</head>');
    const soulTag = '<script src="soul.js"></script>';
    if (html.indexOf(soulTag) === -1) throw new Error('soul.js 锚点没找到：真源 index.html 变了，代理的注入点要跟着改');
    html = html.replace(soulTag, '<script src="/web/boot.js"></script>\n    ' + soulTag);
    return html;
}

// ---- 请求体读取（超限立刻掐断，不把整个 body 读进内存）----
function readBody(req, limit, cb) {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > limit) {
            done = true;
            cb(new Error('TOO_LARGE'));
            req.destroy();
            return;
        }
        chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; cb(null, Buffer.concat(chunks)); } });
    req.on('error', (e) => { if (!done) { done = true; cb(e); } });
}

function clientIp(req) {
    const ip = (req.socket && req.socket.remoteAddress) || '?';
    return ip.replace(/^::ffff:/, '');
}

function rateOk(ip) {
    const now = Date.now();
    let st = rateMap.get(ip);
    if (!st || now > st.resetAt) { st = { count: 0, resetAt: now + 60000 }; rateMap.set(ip, st); }
    if (st.count >= RATE_PER_MIN) return false;
    st.count++;
    return true;
}

// 展台侧的兜底护栏：前端提示词可以改，这一层改不了。
// 只做「有强烈信号时补一句」，不做判决，不替她说话。
const CRISIS_RE = /(自杀|想死|不想活|活不下去|结束生命|割腕|安眠药|跳楼|轻生)/;
const SERVER_GUARD = '【展台运行说明·不可省略】你正在一个线下漫展的局域网演示环境里被真实的人试用。'
    + '本环境不会通知任何第三方、不会报警、不会联系任何人。遇到可能涉及伤害自己的话题时：'
    + '不要假装已经通知别人，不要用命令句，先陪着，再温和地建议对方找现实中信任的人和专业帮助。'
    + '永远不要承认自己是真人。';

// ---- 上游请求 ----
// 只在开发机上用的假上游（YUEYUE_MOCK_UPSTREAM=1）。启动时会打一条刺眼的警告，
// 因为它一开，展台就没有真回复了 —— 故意让它"响"，而不是悄悄降级。
const MOCK = process.env.YUEYUE_MOCK_UPSTREAM === '1';

function callUpstream(payload, onData, onEnd, onErr) {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    if (MOCK) {
        // 假上游直接在进程内合成 SSE，不再往 9419 绕一跳。
        // （绕一跳时本机回环被 RST，排查成本远高于收益；这里只保证浏览器侧的
        //   解析链路与真上游逐字一致：同样的 `data: {...}\n\n` 与 [DONE]。）
        const REPLY = '我在呢。刚泡了杯茶，你今天过得怎么样？';
        if (!payload.stream) {
            // 非流式（ai.complete / ai.summarize 走这条）
            onData(Buffer.from(JSON.stringify({ choices: [{ message: { content: REPLY }, finish_reason: 'stop' }] }), 'utf8'));
            return onEnd();
        }
        const chars = Array.from(REPLY);
        let i = 0;
        const tick = () => {
            if (i >= chars.length) {
                onData(Buffer.from('data: [DONE]\n\n', 'utf8'));
                return onEnd();
            }
            const piece = chars.slice(i, i + 3).join('');
            i += 3;
            onData(Buffer.from('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n', 'utf8'));
            setTimeout(tick, 25);
        };
        setTimeout(tick, 30);
        return { destroy() { /* 合成流没有真连接 */ } };
    }

    // 第98轮 S2-P2-3: 钥匙检查挪到 MOCK 之后（测试模式不需要钥匙）。
    const key = loadKey();
    if (!key) return onErr({ code: 'NO_KEY', message: '钥匙不在，请让管理员在展台机上配置' });

    const req = https.request({
        host: UPSTREAM_HOST,
        path: UPSTREAM_PATH,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + key,
            'Content-Length': body.length,
            'Accept': payload.stream ? 'text/event-stream' : 'application/json',
        },
        timeout: TIMEOUT_TOTAL,
    }, (up) => {
        const rid = up.headers['x-request-id'] || '';
        // 只记元数据，绝不记正文，也不记正文 hash（安全工程师 §6）
        console.log('[up] %s rid=%s stream=%s', up.statusCode, rid, !!payload.stream);
        if (up.statusCode !== 200) {
            let raw = '';
            up.on('data', (c) => { if (raw.length < 2048) raw += c.toString('utf8'); });
            up.on('end', () => {
                let msg = '模型服务暂时不可用';
                if (up.statusCode === 401 || up.statusCode === 403) msg = '展台钥匙失效了，请让管理员换一把';
                else if (up.statusCode === 429) msg = '问的人有点多，稍等十几秒再说';
                else if (up.statusCode >= 500) msg = '模型那边打了个嗝，再试一次';
                onErr({ code: 'UPSTREAM_' + up.statusCode, message: msg, status: up.statusCode });
            });
            return;
        }
        up.on('data', onData);
        up.on('end', onEnd);
        up.on('error', (e) => onErr({ code: 'UPSTREAM_STREAM', message: '连接断了：' + e.message }));
    });

    req.setTimeout(TIMEOUT_CONNECT, () => {
        req.destroy(new Error('连接超时'));
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', (e) => onErr({ code: 'UPSTREAM', message: '网络不通：' + e.message }));
    req.write(body);
    req.end();
    return req;
}

function normaliseMessages(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const m of raw.slice(0, MAX_MSGS)) {
        if (!m || typeof m.content !== 'string') continue;
        const role = m.role === 'assistant' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
        const content = m.content.slice(0, MAX_MSG_CHARS);
        if (!content) continue;
        out.push({ role, content });
    }
    return out.length ? out : null;
}

function pickModel(m) {
    return MODEL_MAP[String(m || '')] || MODEL_DEFAULT;
}

// ---- 路由 ----
const server = http.createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url, 'http://placeholder');
    const p = url.pathname;

    // Host 头校验：只认本机 / 本机局域网地址（DNS rebinding 唯一有效拦截点）
    const hostRaw = String(req.headers.host || '');
    const hostName = hostRaw.replace(/:\d+$/, '').toLowerCase();
    if (!ALLOWED_HOSTS.has(hostName)) {
        return send(res, 421, 'misdirected request');
    }

    // 站点图标：内联 SVG，避免每次开页都打一条 404（/ 和 /m 都会请求它）
    if (p === '/favicon.ico' || p === '/favicon.svg') {
        return send(res, 200, FAVICON_SVG, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=86400',
        });
    }

    // 展台二维码：用「访问者当下用的地址」生成，IP 变了码就自动跟着变（产品经理 M12）
    if (p === '/qr.svg' || p === '/qr') {
        const hostForQr = hostRaw || (lanAddresses()[0] ? lanAddresses()[0] + ':' + PORT : '127.0.0.1:' + PORT);
        const target = 'http://' + hostForQr + '/m';
        let svg;
        try {
            const qr = qrcode(0, 'H');           // 0 = 自动选版本；H = 30% 容错（展台反光/磨损）
            qr.addData(target);
            qr.make();
            svg = qr.createSvgTag({ cellSize: 8, margin: 32, scalable: true });
        } catch (e) {
            return send(res, 500, 'qr failed: ' + e.message);
        }
        if (p === '/qr.svg') {
            return send(res, 200, svg, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
        }
        const page = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">'
            + '<meta name="viewport" content="width=device-width, initial-scale=1">'
            + '<title>展台二维码</title><style>'
            + 'body{margin:0;background:#0b0916;color:#e8e4f2;font:14px/1.7 system-ui,sans-serif;'
            + 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;gap:14px;padding:24px}'
            + '.card{background:#fff;border-radius:20px;padding:18px;box-shadow:0 12px 40px rgba(0,0,0,.5)}'
            + 'svg{display:block;width:min(74vw,420px);height:auto}'
            + 'code{font-size:17px;color:#c8a2ff;word-break:break-all}'
            + '.hint{color:#8a819c;font-size:12.5px;max-width:420px;text-align:center}'
            + '@media print{body{background:#fff;color:#000}.hint{color:#666}code{color:#000}.card{box-shadow:none}}'
            + '</style></head><body><div class="card">' + svg + '</div>'
            + '<code>' + target.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code>'
            + '<div class="hint">这块二维码指向「当前这个地址」。换个 IP 重新打开本页，码就自动变了。'
            + '打印时请连四周白边一起打。</div></body></html>';
        return send(res, 200, page, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }

    if (p === '/' || p === '/index.html') {
        return fs.readFile(path.join(WEB, 'landing.html'), (e, b) => {
            if (e) return send(res, 500, 'landing missing');
            send(res, 200, b, { 'Content-Type': 'text/html; charset=utf-8' });
        });
    }

    if (p === '/m' || p === '/m/') {
        try {
            return send(res, 200, buildMobileHtml(), { 'Content-Type': 'text/html; charset=utf-8' });
        } catch (e) {
            console.error('[m] 注入失败:', e.message);
            return send(res, 500, 'mobile page build failed: ' + e.message);
        }
    }

    if (p === '/api/capabilities') {
        return send(res, 200, {
            ok: true, model: MODEL_DEFAULT, hasKey: !!loadKey(),
            limits: { maxMsgs: MAX_MSGS, maxChars: MAX_MSG_CHARS, maxTokens: MAX_TOKENS, ratePerMin: RATE_PER_MIN },
            daily: { used: dailyState.used, cap: DAILY_TURNS },
            uptimeMs: Date.now() - startedAt,
        });
    }

    if (p === '/api/chat' && req.method === 'POST') return handleChat(req, res, true);
    if (p === '/api/complete' && req.method === 'POST') return handleChat(req, res, false);

    if (p.startsWith('/web/')) return serveFile(res, WEB, p.slice('/web/'.length));

    // 其余一律从真源 app 目录取（soul.js / chat-engine.js / index.css / 图片…）
    // 这样手机端跑的就是桌面端同一份前端代码，永远不漂移。
    return serveFile(res, APP, p);
});

function handleChat(req, res, streamWanted) {
    const ip = clientIp(req);
    const day = dayKey();
    if (day !== dailyState.day) { dailyState.day = day; dailyState.used = 0; }
    if (dailyState.used >= DAILY_TURNS) {
        return send(res, 402, { error: 'BUDGET', message: '今天的展台额度用完了，明天再来找她吧' });
    }
    if (!rateOk(ip)) {
        return send(res, 429, { error: 'RATE', message: '问得有点快，喘口气，十秒后再试' });
    }
    if (concurrent >= MAX_CONCURRENT) {
        return send(res, 429, { error: 'BUSY', message: '前面还有人跟她说话，稍等一下' });
    }

    readBody(req, MAX_BODY, (err, buf) => {
        if (err) {
            const code = err.message === 'TOO_LARGE' ? 413 : 400;
            return send(res, code, { error: 'BAD_BODY', message: '这段话太长了，分几句说好吗' });
        }
        let body;
        try { body = JSON.parse(buf.toString('utf8')); } catch (e) {
            return send(res, 400, { error: 'BAD_JSON', message: '请求格式不对' });
        }
        const messages = normaliseMessages(body && body.messages);
        if (!messages) return send(res, 400, { error: 'BAD_MESSAGES', message: '没有收到有效的对话内容' });

        // L3 兜底：服务端自己看一眼最后一条用户消息（前端可以改，这里改不了）
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const risky = !!(lastUser && CRISIS_RE.test(lastUser.content));
        // 第98轮 S2-P2-4: 展台观众的请求是浏览器发的，system 可以被 F12 改掉。
        // 客户端 system 保留（人设/铁律要在），但①逐条限长，防超长覆盖话术；②SERVER_GUARD 从
        // 「所有 system 之后、正文之前」挪到「最后一条 user 之前」——越靠近生成点权重越高，
        // 且末尾仍留一条 user（部分兼容端点不接受以 system 收尾）。
        const sys = messages
            .filter((m) => m.role === 'system')
            .map((m) => ({ role: 'system', content: String(m.content || '').slice(0, 8000) }));
        const rest = messages.filter((m) => m.role !== 'system');
        const guarded = sys.concat(rest);
        let insertAt = guarded.length;
        for (let i = guarded.length - 1; i >= 0; i--) { if (guarded[i].role === 'user') { insertAt = i; break; } }
        guarded.splice(insertAt, 0, { role: 'system', content: SERVER_GUARD });
        if (risky) {
            guarded.push({ role: 'system', content: '【这一轮请特别当心】对方的话里可能有伤害自己的念头。先接住情绪，不要否认、不要讲大道理、不要用命令句，也不要声称已经通知了任何人。结尾可以温和地提一句：现实里信任的人或当地的专业帮助会比她更有用。' });
        }

        const payload = {
            model: pickModel(body.model),
            messages: guarded,
            max_tokens: MAX_TOKENS,     // 一律覆盖，不听客户端的
            stream: !!streamWanted,
        };
        if (typeof body.temperature === 'number' && isFinite(body.temperature)) {
            payload.temperature = Math.min(1, Math.max(0, body.temperature));
        }

        // 没钥匙就别开流 —— 否则客户端会收到一个"200 然后里面报错"的流，
        // 看起来像模型抽风，其实是配置问题。这里直接 503，界面就能说人话。
        // 第98轮 S2-P2-3: MOCK(测试模式)不需要钥匙 —— 那本来就是演练浏览器侧链路用的，
        // 要求钥匙等于让演练没法做（假上游本来也不会真发请求）。
        if (!MOCK && !loadKey()) {
            return send(res, 503, { error: 'NO_KEY', message: '展台的模型钥匙还没配好，先让管理员看一下' });
        }

        concurrent++;
        dailyState.used++;
        let finished = false;
        const fin = () => { if (!finished) { finished = true; concurrent--; } };

        if (!streamWanted) {
            let raw = '';
            callUpstream(payload, (c) => { raw += c.toString('utf8'); }, () => {
                fin();
                let text = '';
                let finishReason = '';
                try {
                    const j = JSON.parse(raw);
                    const ch = (j.choices && j.choices[0]) || {};
                    text = (ch.message && ch.message.content) || '';
                    finishReason = ch.finish_reason || '';
                } catch (e) {
                    return send(res, 502, { error: 'BAD_UPSTREAM', message: '模型回了一句看不懂的话' });
                }
                send(res, 200, { ok: true, text, finishReason });
            }, (e) => { fin(); send(res, 502, { error: e.code, message: e.message }); });
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        const upstreamReq = callUpstream(payload, (c) => { try { res.write(c); } catch (e) { /* 客户端断了 */ } }, () => {
            fin();
            try { res.end(); } catch (e) { /* 忽略 */ }
        }, (e) => {
            fin();
            try {
                res.write('data: ' + JSON.stringify({ 'x-yueyue-error': e.code, message: e.message }) + '\n\n');
                res.end();
            } catch (e2) { /* 忽略 */ }
        });

        req.on('close', () => { if (!finished) { fin(); try { upstreamReq.destroy(); } catch (e) { /* 忽略 */ } } });
    });
}

server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') console.error('端口 %s 已被占用：先关掉旧进程再起', PORT);
    else console.error('代理启动失败:', e.message);
    process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
    const ips = lanAddresses();
    console.log('玥玥 · 漫展网页版代理已启动');
    console.log('  本机打开 : http://localhost:%s/m', PORT);
    Array.from(ips).forEach((ip) => {
        if (ip !== '127.0.0.1' && ip !== 'localhost' && ip.indexOf(':') === -1) {
            console.log('  手机打开 : http://%s:%s/m', ip, PORT);
        }
    });
    const hasKey = !!loadKey();
    console.log('  模型钥匙 : %s', hasKey ? '已加载（不打印，不在浏览器里）' : '❌ 没有 —— /api/chat 会回 503 NO_KEY');
    if (MOCK) {
        console.log('  ❗❗ 测试模式：上游被换成进程内假回复 —— 这一台现在不能拿去展台 ❗❗');
    }
    console.log('  真源目录 : %s', APP);
    if (!hasKey) console.log('  填钥匙   : 把 Key 写进 %s（一行，别加引号）或设 YUEYUE_KEY', path.join(WEB, 'booth.key'));
});
