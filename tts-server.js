// =============================================================
// 内置语音服务管理器(主进程模块):
// 软件启动时后台拉起 TTS API(无窗口),退出时自动关闭
// 自动探测 exe 旁 / app 目录旁 / 开发机路径 的引擎目录
// =============================================================
// 阶段2 TTS 双引擎(2026-09 · 集成方案 14 §3/§4):
//   - sovits    : 默认引擎(未设环境变量时行为与现状完全一致, 一键回滚路径)
//                 GPT-SoVITS 目录 runtime python + api_v2.py(原路径完全不动)
//   - indextts  : YUEYUE_TTS_ENGINE=indextts 时启用(IndexTTS-2.5 种子抽卡)
//                 index-tts 仓库 .venv(INDEX_TTS_PY/INDEX_TTS_DIR 或候选目录)拉起 stt/index_tts_server.py
//                 请求体由 buildIndexTtsRequest 按 14 §3.2 映射表换算(main.js tts:speak 调用), tts-voice.js 零改动
// =============================================================
const { spawn, spawnSync, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const TTS_PORT = 9880;
const API_URL = 'http://127.0.0.1:' + TTS_PORT;
// 引擎开关(第89轮起: 多方案适配):
//   - YUEYUE_TTS_ENGINE 显式设置时, 行为与旧版完全一致(键在即用, 不做探测, 一键回滚);
//   - 未设置时按 sovits → indextts → qwen3tts 的顺序自动挑**先探到安装**的那个,
//     而不是旧版不问青红皂白按 sovits 起(结果没装 GPT-SoVITS 的机器上静默失败, 且 UI 文案指向"没装语音包")。
//   已探到的结果缓存在 engineResolved 里, 同一进程内不会反复扫盘。
const ENGINE_ENV = String(process.env.YUEYUE_TTS_ENGINE || '').trim().toLowerCase();
let ENGINE = ENGINE_ENV || 'sovits';
let engineResolved = !!ENGINE_ENV;

let ttsDir = null;
let ttsProcess = null;
let ttsStarting = null;
let restarting = null; // 在途异步重启的共享 promise(并发 restart 幂等复用同一次)
let managedPid = null; // 无论"自己拉起"还是"复用端口上的", 都记录最终要清理的 PID
let watchdogProcess = null; // 父进程死亡看门狗(应用崩溃/强杀时也能杀掉 python)

// 收集候选目录:exe 同级与 app 同级的 GPT-SoVITS* 文件夹(含一层嵌套),最后是开发机路径
function collectCandidates() {
    const bases = [path.dirname(process.execPath), __dirname, path.resolve(__dirname, '..', '..')];
    if (process.env.TTS_OVERRIDE_DIR) bases.unshift(process.env.TTS_OVERRIDE_DIR);
    const out = [];
    for (const b of bases) {
        let entries = [];
        try { entries = fs.readdirSync(b, { withFileTypes: true }); } catch (e) { continue; }
        for (const e of entries) {
            if (!e.isDirectory() || e.name.indexOf('GPT-SoVITS') !== 0) continue;
            const p = path.join(b, e.name);
            out.push(p);
            try {
                for (const sub of fs.readdirSync(p, { withFileTypes: true })) {
                    if (sub.isDirectory() && sub.name.indexOf('GPT-SoVITS') === 0) {
                        out.push(path.join(p, sub.name));
                    }
                }
            } catch (err) { /* 忽略 */ }
        }
    }
    out.push('G:\\成功啦哈哈哈哈\\GPT等1个文件\\GPT\\GPT-SoVITS-0927-AMD\\GPT-SoVITS-0927-zluda');
    return out;
}

function detectTtsDir() {
    if (ttsDir) return ttsDir;
    for (const dir of collectCandidates()) {
        try {
            if (fs.existsSync(path.join(dir, 'runtime', 'python.exe')) &&
                fs.existsSync(path.join(dir, 'api_v2.py'))) {
                ttsDir = dir;
                return dir;
            }
        } catch (e) { /* 忽略无效路径 */ }
    }
    return null;
}

// ---------- 显卡自动侦测(第90轮) ----------
// 目标: 同一份打包在 N 卡 / A 卡 / 纯 CPU+核显 三种机器上都能自动适配。
// NVIDIA: 本机 runtime 已是 cu128(boot 层选 cuda); A 卡: 走 sovits 自带的 zluda runtime;
// 都没有: 落 CPU。这里只做"是哪家的卡"的探测与日志, 真正的设备选择在 sovits_boot.py / qwen3tts_server.py。
let gpuInfo = null;
function detectGpu() {
    if (gpuInfo) return gpuInfo;
    gpuInfo = { vendor: 'unknown', name: '' };
    try {
        const out = execSync('nvidia-smi --query-gpu=name --format=csv,noheader', { timeout: 4000, encoding: 'utf8', windowsHide: true });
        const name = String(out || '').trim().split(/\r?\n/)[0] || '';
        if (name) { gpuInfo = { vendor: 'nvidia', name }; return gpuInfo; }
    } catch (e) { /* 没有 NVIDIA 驱动 */ }
    try {
        const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name -join \';\'"', { timeout: 8000, encoding: 'utf8', windowsHide: true });
        const s = String(out || '').trim();
        if (/amd|radeon/i.test(s)) gpuInfo = { vendor: 'amd', name: s };
        else if (/intel/i.test(s)) gpuInfo = { vendor: 'intel', name: s };
        else if (s) gpuInfo = { vendor: 'other', name: s };
    } catch (e) { /* 探测失败按 unknown 处理 */ }
    return gpuInfo;
}

// ---------- 引擎选择(第89轮自动探测, 第90轮按显卡自动调整) ----------
// 返回最终引擎名, 并把结果缓存在 ENGINE/engineResolved。
// 探测只做"目录/解释器在不在", 与 ensure() 的冷启动无关(3ms 级, 不拉起 python)。
// 第90轮老板指令: 默认引擎按显卡类型自动调整 —— NVIDIA→qwen3tts(N卡引擎),
// AMD/核显/无卡→sovits(A卡引擎, 训练音色), 都不可用再退 indextts/qwen3; 显式 env 永远最优先。
function resolveEngine() {
    if (engineResolved) return ENGINE;
    if (ENGINE_ENV) { ENGINE = ENGINE_ENV; engineResolved = true; return ENGINE; }
    const gpu = detectGpu();
    const sovits = !!detectTtsDir();
    const indextts = !!detectIndexTts();
    const qwen = !!detectQwen3Tts();
    // r178: 随包引擎(Kokoro, CPU)优先。它跟安装包走、不挑显卡、不依赖外挂大模型目录，
    // 用户装完即有声。找不到解释器/模型文件时自动退回下面原来的显卡分派逻辑。
    const kokoro = !!(detectKokoroPython() && fs.existsSync(path.join(KOKORO_MODEL_DIR, 'model.onnx')));
    let picked;
    // [r178b] 只有显式要求才用 Kokoro —— 实测它的中文声调有口音（听起来像方言），不能当默认
    if (kokoro && String(process.env.YUEYUE_TTS_ENGINE || '').toLowerCase() === 'kokoro') picked = 'kokoro';                             // 随包首选
    else if (gpu.vendor === 'nvidia' && qwen) picked = 'qwen3tts'; // N 卡 → N 卡引擎
    else if (sovits) picked = 'sovits';                        // A 卡/核显/无卡 → 训练音色
    else if (qwen) picked = 'qwen3tts';
    else if (indextts) picked = 'indextts';
    else picked = 'sovits';
    ENGINE = picked;
    engineResolved = true;
    console.log('[语音服务] 自动选择引擎: ' + ENGINE + '(显卡: ' + gpu.vendor +
        (gpu.name ? ' ' + gpu.name.split(';')[0] : '') + '; 可用性: kokoro=' + kokoro +
        ' sovits=' + sovits + ' indextts=' + indextts + ' qwen3tts=' + qwen + ')');
    return ENGINE;
}

// 按当前引擎返回安装目录(旧版恒返回 GPT-SoVITS 目录, 导致 indextts/qwen3tts 机器上 tts:available 恒 false)
function engineDir() {
    const engine = resolveEngine();
    if (engine === 'indextts') {
        const loc = detectIndexTts();
        return (loc && loc.dir) || null;
    }
    if (engine === 'qwen3tts') {
        const loc = detectQwen3Tts();
        return (loc && loc.dir) || null;
    }
    if (engine === 'kokoro') return KOKORO_MODEL_DIR;
    return detectTtsDir();
}

// ---------- IndexTTS 引擎探测(独立 venv, 不依赖 GPT-SoVITS 目录) ----------
const INDEXTTS_SCRIPT = path.join(__dirname, 'stt', 'index_tts_server.py');

// ---------- Qwen3-TTS 引擎探测(独立 venv) ----------
const QWEN3TTS_SCRIPT = path.join(__dirname, 'stt', 'qwen3tts_server.py');
// 第136轮：faster-qwen3-tts(CUDA graph) 快速后端。仅在 venv 里确实装了包时启用，
// 没装的机器继续走旧 qwen3tts_server.py，一键回滚 = 设 YUEYUE_TTS_FAST=0。
const QWEN3TTS_FAST_SCRIPT = path.join(__dirname, 'stt', 'qwen3tts_fast_server.py');
// [r173] 随包语音引擎：Kokoro-82M(ONNX/CPU)。模型在 stt/kokoro 里，跟着安装包走。
const KOKORO_SCRIPT = path.join(__dirname, 'stt', 'kokoro_tts_server.py');
const KOKORO_MODEL_DIR = path.join(__dirname, 'stt', 'kokoro');

// 第89轮: venv 的 python.exe 存在 ≠ 这个 venv 能用。
// 实测本机 G: 盘两个 venv(G:\YueyueAI\index-tts\.venv、G:\YueyueAI\venv-qwen3-tts)的 pyvenv.cfg
// 写着 `home = C:\Users\...\uv\python\cpython-3.11.13-...`, 而那个基础解释器早就被删了 ——
// python.exe 在, 但一跑就报 "No Python at ..."(os error 2), 自动探测却把它当"可用",
// 于是永远选一个起不来的引擎。所以带 venv 布局时顺手校验 home 是否还在。
function isUsablePy(pyPath) {
    try {
        if (!pyPath || !fs.existsSync(pyPath)) return false;
        const venvRoot = path.dirname(path.dirname(pyPath));
        const cfg = path.join(venvRoot, 'pyvenv.cfg');
        if (fs.existsSync(cfg)) {
            let txt = '';
            try { txt = fs.readFileSync(cfg, 'utf8'); } catch (e) { txt = ''; }
            const m = /^\s*home\s*=\s*(.+)$/m.exec(txt || '');
            const home = m ? m[1].trim() : '';
            if (home && !fs.existsSync(home)) {
                console.warn('[语音服务] 跳过失效 venv(基础解释器不存在): ' + pyPath + ' → home=' + home);
                return false;
            }
        }
        return true;
    } catch (e) {
        return false;
    }
}

function detectQwen3Tts() {
    const bases = [];
    if (process.env.QWEN3TTS_PY) bases.push({ py: process.env.QWEN3TTS_PY, dir: path.dirname(path.dirname(process.env.QWEN3TTS_PY)) });
    bases.push({ dir: path.join(path.dirname(process.execPath), 'venv-qwen3-tts') });
    bases.push({ dir: path.join(path.dirname(process.execPath), 'venv-qwen3-tts-r90') });
    bases.push({ dir: path.join(__dirname, '..', '..', 'venv-qwen3-tts') });
    bases.push({ dir: path.join(__dirname, '..', '..', 'venv-qwen3-tts-r90') });
    // 第90轮: 重建的 r90 venv 优先于旧的失效 venv(旧 venv 基础解释器已被删, isUsablePy 会跳过)
    // 第136轮: 安装包自带的 GPU 语音包(<安装目录>\voice-pack\venv-qwen3-tts-r90)
    // 必须优先于开发机的 G 盘环境；否则装了 1.7B 语音包的用户仍会用到开发机路径。
    // 旧的 CPU 语音包(voice-pack\venv)仍放在 G 盘之后，避免它把开发机的 1.7B 顶成 0.6B。
    bases.push({ dir: path.join(path.dirname(process.execPath), 'voice-pack', 'venv-qwen3-tts-r90') });
    bases.push({ dir: path.join(__dirname, '..', '..', 'voice-pack', 'venv-qwen3-tts-r90') });
    bases.push({ dir: 'G:\\YueyueAI\\venv-qwen3-tts-r90' });
    bases.push({ dir: 'G:\\YueyueAI\\venv-qwen3-tts' });
    // 第108轮: 旧 CPU 语音包目录名用短的 voice-pack\venv(CPU torch + 0.6B 模型)
    bases.push({ dir: path.join(path.dirname(process.execPath), 'voice-pack', 'venv') });
    bases.push({ dir: path.join(__dirname, '..', '..', 'voice-pack', 'venv') });
    for (const b of bases) {
        if (!b.dir) continue;
        if (b.py) {
            try { if (isUsablePy(b.py)) return { dir: b.dir, py: b.py }; } catch (e) { /* ignore */ }
            continue;
        }
        for (const rel of ['Scripts\\python.exe', 'python.exe']) {
            const py = path.join(b.dir, rel);
            try { if (isUsablePy(py)) return { dir: b.dir, py }; } catch (e) { /* ignore */ }
        }
    }
    return null;
}

// 第136轮：判断这个 Qwen3 venv 是否装了 faster-qwen3-tts（Windows venv 是 Lib/site-packages）。
function hasFastQwen(dir) {
    if (String(process.env.YUEYUE_TTS_FAST || '').trim() === '0') return false;
    try {
        return [
            path.join(dir, 'Lib', 'site-packages', 'faster_qwen3_tts'),
            path.join(dir, 'lib', 'site-packages', 'faster_qwen3_tts'),
        ].some((p) => fs.existsSync(p));
    } catch (e) {
        return false;
    }
}

// 第136轮：快速后端优先 1.7B（老板拍板），开发机在 G 盘、安装包在 voice-pack/models。
// 找不到 1.7B 再退 0.6B；返回空串表示让服务端用它自己的默认。
function findQwen3FastModel() {
    if (process.env.QWEN3TTS_MODEL_DIR_BASE) return process.env.QWEN3TTS_MODEL_DIR_BASE;
    const bases = [path.dirname(process.execPath), path.resolve(__dirname, '..', '..')];
    const names = ['Qwen3-TTS-12Hz-1.7B-Base', 'Qwen3-TTS-12Hz-0.6B-Base'];
    const out = [];
    for (const b of bases) for (const n of names) out.push(path.join(b, 'voice-pack', 'models', n));
    for (const n of names) out.push(path.join('G:\\YueyueAI\\qwen3-models', n));
    for (const p of out) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
    return '';
}

function detectIndexTts() {
    // INDEX_TTS_DIR=index-tts 仓库目录(内有 .venv) / INDEX_TTS_PY=python 绝对路径
    const bases = [];
    if (process.env.INDEX_TTS_DIR) bases.push({ dir: process.env.INDEX_TTS_DIR, prefer: '.venv\\Scripts\\python.exe' });
    if (process.env.INDEX_TTS_PY) bases.push({ dir: path.dirname(path.dirname(process.env.INDEX_TTS_PY)), py: process.env.INDEX_TTS_PY });
    bases.push({ dir: path.join(path.dirname(process.execPath), 'index-tts'), prefer: '.venv\\Scripts\\python.exe' }); // 应用 exe 同级
    bases.push({ dir: path.join(__dirname, '..', '..', 'index-tts'), prefer: '.venv\\Scripts\\python.exe' });        // win-unpacked 同级
    bases.push({ dir: 'G:\\YueyueAI\\index-tts', prefer: '.venv\\Scripts\\python.exe' });                            // 部署文档 15 §2 默认路径
    bases.push({ dir: 'G:\\yueyueneiceban\\index-tts', prefer: '.venv\\Scripts\\python.exe' });                          // 开发机常见路径(2026-09-12 迁移更新)
    for (const b of bases) {
        if (!b.dir) continue;
        if (b.py) {
            try { if (isUsablePy(b.py)) return { dir: b.dir, py: b.py }; } catch (e) { /* 忽略 */ }
            continue;
        }
        const rels = [b.prefer, 'Scripts\\python.exe', 'python.exe'].filter(Boolean);
        for (const rel of rels) {
            const py = path.join(b.dir, rel);
            try { if (isUsablePy(py)) return { dir: b.dir, py }; } catch (e) { /* 忽略 */ }
        }
    }
    return null;
}

function isTtsUp() {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        fetch(API_URL + '/docs', { signal: controller.signal })
            .then(() => { clearTimeout(timer); resolve(true); })
            .catch(() => { clearTimeout(timer); resolve(false); });
    });
}

// /tts 探活: /docs 通了只证明 HTTP 活着, 不代表在干活(可能卡死在合成线程/线程池耗尽)。
// 空 JSON 体触发 FastAPI 参数校验(422, 不碰模型不触发合成), 任何 HTTP 状态码都算"响应正常";
// 超时/连接失败 = 疑似卡死, 复用分支拒绝接管(宁可报 TTS_SERVICE_MISSING 也不永久静默)。
function probeTtsResponsive(timeoutMs) {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs || 8000);
        fetch(API_URL + '/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: controller.signal,
        }).then(() => { clearTimeout(timer); resolve(true); })
          .catch(() => { clearTimeout(timer); resolve(false); });
    });
}

// 找出占用指定端口的进程 PID(Windows netstat)
function portOwnerPid(port) {
    try {
        const out = execSync('netstat -ano -p tcp', { encoding: 'utf8', windowsHide: true });
        const lines = out.split(/\r?\n/);
        for (const line of lines) {
            if (line.indexOf(':' + port) === -1) continue;
            if (line.toUpperCase().indexOf('LISTENING') === -1) continue;
            const parts = line.trim().split(/\s+/);
            const pid = parseInt(parts[parts.length - 1], 10);
            if (pid > 0) return pid;
        }
    } catch (e) { /* 忽略 */ }
    return 0;
}

// 杀整个进程树(含子进程),保证零残留
function killTree(pid) {
    if (!pid) return;
    try {
        execSync('taskkill /PID ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' });
    } catch (e) { /* 已退出或权限不足 */ }
}

// 异步版杀进程树: restart 专用, 不阻塞主进程事件循环。
// (shutdown 仍走同步版——应用退出路径必须保证退出前杀完, 异步来不及)
function killTreeAsync(pid) {
    return new Promise((resolve) => {
        if (!pid) return resolve();
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        try {
            const c = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            c.on('error', fin);
            c.on('close', fin);
        } catch (e) { fin(); }
    });
}

// 命令行兜底过滤条件: 同时覆盖三种引擎(无论当前是哪个, shutdown/看门狗都清干净)
// 2026-09-12 第九轮(审计 D6): 只按脚本名匹配会波及**用户自己装的** GPT-SoVITS/SenseVoice 等
// 同名脚本(用户手动起的 api_v2.py 会被我们的退出清理顺带杀掉 = 我们的软件动了别人的东西)。
// 现在把匹配同时限制在"由本应用探测到的引擎目录 + 本应用自带脚本"范围内:
//   ① 脚本路径必须落在 detect*Dir() 返回的目录里, 或 ② 必须是我们随包分发的 stt/*.py。
function pythonCmdlineFilter() {
    const dirs = [];
    try { if (typeof detectTtsDir === 'function' && detectTtsDir()) dirs.push(detectTtsDir()); } catch (e) { /* 忽略 */ }
    try { if (typeof detectIndexTts === 'function' && detectIndexTts()) dirs.push(detectIndexTts()); } catch (e) { /* 忽略 */ }
    try { if (typeof detectQwen3Tts === 'function') { const l = detectQwen3Tts(); if (l && l.dir) dirs.push(l.dir); } } catch (e) { /* 忽略 */ }
    try { dirs.push(require('path').join(__dirname, 'stt')); } catch (e) { /* 忽略 */ }
    const dirCond = dirs.filter(Boolean).map((d) => "($_.CommandLine -like '*" + String(d).replace(/'/g, "''") + "*')").join(' -or ');
    const nameCond = "($_.CommandLine -like '*api_v2.py*') -or ($_.CommandLine -like '*index_tts_server.py*') -or ($_.CommandLine -like '*qwen3tts_server.py*')";
    // 没有可用的引擎目录信息时退回旧行为(避免一条也杀不掉导致孤儿进程)
    return dirCond ? ('(' + nameCond + ') -and (' + dirCond + ')') : nameCond;
}

// 兜底: 按命令行杀掉所有 api_v2.py / index_tts_server.py 的 python(无论哪个会话/哪次崩溃启动的)
function killTtsPythons() {
    try {
        const script = [
            "$ErrorActionPreference='SilentlyContinue'",
            "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { " + pythonCmdlineFilter() + " } | ForEach-Object { $_.ProcessId }"
        ].join('; ');
        const r = spawnSync('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
            windowsHide: true, timeout: 15000, encoding: 'utf8'
        });
        const pids = String((r && r.stdout) || '').split(/\s+/).map((s) => parseInt(s, 10)).filter((p) => p > 0);
        for (const p of pids) {
            try { killTree(p); } catch (e) { /* 忽略 */ }
        }
    } catch (e) { /* 忽略 */ }
}

// 异步版兜底清理: 与同步版同款过滤条件, 但在 PowerShell 内直接 taskkill(看门狗同款写法),
// 无需回传 PID, stdio ignore, 15s 超时强杀自身——绝不阻塞主进程
function killTtsPythonsAsync() {
    return new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        try {
            const script = [
                "$ErrorActionPreference='SilentlyContinue'",
                "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { " + pythonCmdlineFilter() + " } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }"
            ].join('; ');
            const c = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
                windowsHide: true, stdio: 'ignore'
            });
            const timer = setTimeout(() => { try { c.kill(); } catch (e) { /* 忽略 */ } fin(); }, 15000);
            c.on('error', () => { clearTimeout(timer); fin(); });
            c.on('close', () => { clearTimeout(timer); fin(); });
        } catch (e) { fin(); }
    });
}

// 父进程死亡看门狗: 应用无论正常退出/崩溃/被强杀, 只要主进程消失, 2 秒后杀 python 树
function startWatchdog(pyPid) {
    try {
        if (watchdogProcess) return;
        const appPid = process.pid;
        const script = [
            "$ErrorActionPreference='SilentlyContinue'",
            "$p=Get-Process -Id " + appPid + " -ErrorAction SilentlyContinue",
            "while($p){ Start-Sleep -Seconds 2; $p=Get-Process -Id " + appPid + " -ErrorAction SilentlyContinue }",
            "taskkill /PID " + pyPid + " /T /F",
            "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { " + pythonCmdlineFilter() + " } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }",
            "exit"
        ].join('; ');
        // 注意: Windows 下 detached:true 会导致 powershell -Command 静默失效(命令不执行), 必须去掉;
        // 不加 detached 的子进程在父进程退出/崩溃后仍会继续运行(这正是看门狗需要的)
        watchdogProcess = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
            windowsHide: true,
            detached: false,
            stdio: 'ignore',
        });
        if (watchdogProcess.unref) watchdogProcess.unref();
        console.log('[语音服务] 看门狗已启动 pid=' + watchdogProcess.pid + ' appPid=' + process.pid + ' pyPid=' + pyPid);
    } catch (e) { /* 看门狗失败不阻塞 */
        console.error('[语音服务] 看门狗启动失败: ' + (e && e.message));
    }
}

// ---------- 引擎 A: GPT-SoVITS(原路径, 未改动) ----------
async function startSovits() {
    const dir = detectTtsDir();
    if (!dir) {
        console.error('[语音服务] 未找到 GPT-SoVITS 目录,语音功能不可用');
        return false;
    }
    console.log('[语音服务] 使用目录:', dir);
    const py = path.join(dir, 'runtime', 'python.exe');
    // 第89轮: 优先用 stt/sovits_boot.py 包一层启动。原因(实测, 不是推测):
    //   本机装的 GPT-SoVITS 是 AMD/ZLUDA 特化包, api_v2.py 第 101 行无条件 `import zluda`;
    //   在 NVIDIA 机器上 zluda 抛 ValueError 后进程直接死(日志 exit 1), 更阴的是
    //   "试一次 import zluda" 会把卡藏起来(torch.cuda.device_count() 1→0), 于是 TTS_Config
    //   判定 CUDA 不可用自动降级 CPU —— 用户听到的是"又慢又卡", 不是报错。
    //   包装层做的事: 标准 CUDA 能看见非 AMD 卡就注入空 zluda 模块跳过它; 看不见/AMD 才走原 import。
    //   包装脚本不存在时退回原命令, 老安装零影响。
    const bootScript = path.join(__dirname, 'stt', 'sovits_boot.py');
    let useBoot = false;
    try { useBoot = fs.existsSync(bootScript); } catch (e) { useBoot = false; }
    const sovitsArgs = ['-a', '127.0.0.1', '-p', String(TTS_PORT), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'];
    try {
        ttsProcess = spawn(
            py,
            useBoot ? [bootScript].concat(sovitsArgs) : ['api_v2.py'].concat(sovitsArgs),
            {
                cwd: dir,
                windowsHide: true,
                stdio: ['ignore', 'ignore', 'ignore'],
                env: Object.assign({}, process.env, {
                    // 显式告诉包装层仓库根(它缺省会读 cwd, 这里给死更稳: 不依赖 spawn 的 cwd 行为)
                    SOVITS_DIR: dir,
                    PATH: path.join(dir, 'runtime') + ';' + (process.env.PATH || ''),
                    // 强制 UTF-8 输出:避免 Windows 默认 GBK 编码在打印特殊字符(如 emoji)时崩溃
                    PYTHONIOENCODING: 'utf-8',
                    PYTHONUTF8: '1',
                    // torch>=2.6 的 torch.load 默认 weights_only=True, 会拒载 GPT-SoVITS 的 ckpt;
                    // 这个变量是官方开关(等价每次显式传 weights_only=False), 老版本 torch 不认识会忽略。
                    TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD: '1',
                }),
            }
        );
        const proc = ttsProcess;
        // 仅在仍是本进程时清引用: 防 restart 后旧进程的迟到 exit 事件误清掉新进程句柄
        ttsProcess.on('exit', () => { if (ttsProcess === proc) ttsProcess = null; });
        managedPid = ttsProcess.pid;
        startWatchdog(ttsProcess.pid);
        console.log('[语音服务] 已后台启动,等待模型加载...');
    } catch (err) {
        console.error('[语音服务] 启动失败:', err && err.message);
        ttsProcess = null;
        return false;
    }
    for (let i = 0; i < 90; i++) {
        if (!ttsProcess) break; // 引擎中途死亡(含被 restart 杀掉): 提前退出, 不空等满轮询
        if (await isTtsUp()) return true;
        await new Promise((r) => setTimeout(r, 2000));
    }
    return isTtsUp();
}

// ---------- 引擎 C: Qwen3-TTS VoiceDesign(独立部署, 文字捏音色已定稿) ----------
// 第90轮: Qwen3 的默认音色锚 = 本机 A 卡训练音色(SoVITS 合成的一句参考)。
// 包内优先(随包分发), 其次模型目录(本机生成), 都缺失则交给服务端默认 anchor-loli.wav。
const QWEN3_ANCHOR_PACKED = path.join(__dirname, 'stt', 'anchor', 'anchor-yueyue-sovits.wav');
const QWEN3_ANCHOR_LOCAL = 'G:\\YueyueAI\\qwen3-models\\anchor-yueyue-sovits.wav';
const QWEN3_ANCHOR_VOICE_PACK = path.join(path.dirname(process.execPath), 'voice-pack', 'models', 'anchor-yueyue-sovits.wav');
const QWEN3_ANCHOR_VOICE_PACK_APP = path.join(__dirname, '..', '..', 'voice-pack', 'models', 'anchor-yueyue-sovits.wav');
function resolveQwen3Anchor() {
    if (process.env.QWEN3TTS_ANCHOR_WAV) return process.env.QWEN3TTS_ANCHOR_WAV;
    for (const p of [QWEN3_ANCHOR_PACKED, QWEN3_ANCHOR_VOICE_PACK, QWEN3_ANCHOR_VOICE_PACK_APP, QWEN3_ANCHOR_LOCAL]) {
        try { if (fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
    return '';
}

// [r173] Kokoro 需要一个带 sherpa-onnx 的 python。优先环境变量；
// 其次复用 GPT-SoVITS 自带 runtime（本机已在该 runtime 里装好 sherpa-onnx 2.0.2）；
// 最后才试探系统 python —— 但系统 python 通常没装依赖，宁可明确报错也不静默降级。
function detectKokoroPython() {
    const cands = [];
    if (process.env.YUEYUE_KOKORO_PY) cands.push(process.env.YUEYUE_KOKORO_PY);
    // GPT-SoVITS 那套在 app 的**上一层**（win-unpacked\GPT-SoVITS-0927-AMD\...\runtime），
    // 不在 resources/app 里面 —— r173 第一版只找 __dirname 下，导致明明装着却说找不到。
    const bases = [
        path.join(__dirname, 'GPT-SoVITS-0927-AMD'),
        path.join(__dirname, '..', '..', 'GPT-SoVITS-0927-AMD'),
        path.join(process.resourcesPath || '', 'GPT-SoVITS-0927-AMD'),
    ];
    for (const base of bases) {
        try {
            for (const d of fs.readdirSync(base)) {
                cands.push(path.join(base, d, 'runtime', 'python.exe'));
                cands.push(path.join(base, d, 'python.exe'));
            }
        } catch (e) { /* 这个位置没有就继续 */ }
    }
    cands.push(path.join(__dirname, '..', '..', 'runtime', 'python.exe'));
    for (const p of cands) {
        try { if (p && fs.existsSync(p)) return p; } catch (e) { /* ignore */ }
    }
    return '';
}

async function startKokoroTts() {
    const py = detectKokoroPython();
    if (!py) {
        console.error('[语音服务] Kokoro: 未找到 python(YUEYUE_KOKORO_PY)，语音不可用');
        try {
            require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'yueyue_tts_boot.log'),
                new Date().toISOString() + ' kokoro: python NOT FOUND\n');
        } catch (e) { /* ignore */ }
        return false;
    }
    try {
        require('fs').appendFileSync(require('path').join(require('os').tmpdir(), 'yueyue_tts_boot.log'),
            new Date().toISOString() + ' kokoro: spawn ' + py + '\n');
    } catch (e) { /* ignore */ }
    try {
        if (!fs.existsSync(path.join(KOKORO_MODEL_DIR, 'model.onnx'))) {
            console.error('[语音服务] Kokoro: 缺模型 ' + path.join(KOKORO_MODEL_DIR, 'model.onnx'));
            return false;
        }
    } catch (e) { /* ignore */ }
    const sid = String(process.env.YUEYUE_KOKORO_SID || '46');
    const speed = String(process.env.YUEYUE_KOKORO_SPEED || '0.94');
    const threads = String(process.env.YUEYUE_KOKORO_THREADS || '4');
    const model = String(process.env.YUEYUE_KOKORO_MODEL || 'model.onnx');
    console.log('[语音服务] 使用 Kokoro(随包) python=' + py + ' sid=' + sid + ' speed=' + speed);
    ttsProcess = spawn(py, [KOKORO_SCRIPT, '-p', String(TTS_PORT), '--model-dir', KOKORO_MODEL_DIR,
        '--sid', sid, '--speed', speed, '--threads', threads, '--model', model], {
        cwd: __dirname,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: Object.assign({}, process.env, {
            PYTHONIOENCODING: 'utf-8',
            PYTHONUTF8: '1',
        }),
    });
    managedPid = ttsProcess.pid;
    ttsProcess.stdout.on('data', (d) => process.stdout.write('[kokoro] ' + d));
    // [r178] 进程拉不起来时唯一能看的地方（Electron 主进程的 stdout 看不到）
    const KOKORO_ERR_LOG = require('path').join(require('os').tmpdir(), 'yueyue_kokoro_err.log');
    try { fs.writeFileSync(KOKORO_ERR_LOG, ''); } catch (e) { /* ignore */ }
    ttsProcess.stdout.on('data', (d) => { try { fs.appendFileSync(KOKORO_ERR_LOG, String(d)); } catch (e) { /* ignore */ } });
    ttsProcess.stderr.on('data', (d) => { try { fs.appendFileSync(KOKORO_ERR_LOG, String(d)); } catch (e) { /* ignore */ } });
    ttsProcess.on('exit', (code) => {
        console.log('[语音服务] Kokoro 进程退出 code=' + code);
        ttsProcess = null;
        managedPid = null;
    });
    // 等端口起来（与 qwen/index 两个引擎同一套轮询：最多 60 轮 × 2s）
    for (let i = 0; i < 60; i++) {
        if (!ttsProcess) break;
        if (await isTtsUp()) { startWatchdog(ttsProcess.pid); return true; }
        await new Promise((r) => setTimeout(r, 2000));
    }
    return isTtsUp();
}

async function startQwen3Tts() {
    const loc = detectQwen3Tts();
    if (!loc) {
        console.error('[语音服务] 未找到 Qwen3-TTS 环境(请设置 QWEN3TTS_PY 或按 15-deployment 部署 venv-qwen3-tts), 语音功能不可用');
        return false;
    }
    console.log('[语音服务] 使用 Qwen3-TTS 环境:', loc.dir);
    const fastModel = hasFastQwen(loc.dir) ? findQwen3FastModel() : '';
    const useFast = !!fastModel;
    const script = useFast ? QWEN3TTS_FAST_SCRIPT : QWEN3TTS_SCRIPT;
    console.log('[语音服务] Qwen3-TTS 后端: ' + (useFast ? 'faster-qwen3-tts(CUDA graph)' : '旧 qwen3tts_server') +
        (useFast ? '，模型 ' + path.basename(fastModel) : ''));
    const envPatch = {
        PATH: path.join(loc.dir, 'Scripts') + ';' + (process.env.PATH || ''),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        QWEN3TTS_FAST: useFast ? '1' : '0',
    };
    const anchor = resolveQwen3Anchor();
    if (anchor) envPatch.QWEN3TTS_ANCHOR_WAV = anchor;
    if (process.env.QWEN3TTS_MODEL_DIR) envPatch.QWEN3TTS_MODEL_DIR = process.env.QWEN3TTS_MODEL_DIR;
    // 第136轮：快速后端默认 1.7B（老板拍板），装在哪里由 findQwen3FastModel() 决定；
    // 只有真的装了 faster-qwen3-tts 才走这条，否则保留第108/110轮的 0.6B 语音包逻辑。
    if (useFast) {
        envPatch.QWEN3TTS_MODEL_DIR_BASE = fastModel;
    }
    // 第108轮: 语音包自带模型(0.6B, 给没有独显的机器用 CPU 跑得动的那档)。
    // 布局: <安装目录>\voice-pack\models\Qwen3-TTS-12Hz-0.6B-Base, 锚 wav 放 models 根(服务端按 dirname(MODEL_DIR_BASE) 找)。
    // 第110轮修正: 只有**用的是 voice-pack 里那套 venv** 时才换成包内 0.6B ——
    // 否则老板本机(G 盘 1.7B + CUDA)会因为包里带了个 0.6B 而被降级, 那是音质倒退。
    if (!useFast && !process.env.QWEN3TTS_MODEL_DIR_BASE && /voice-pack/i.test(String(loc.dir || ''))) {
        const packedModels = [
            path.join(path.dirname(process.execPath), 'voice-pack', 'models'),
            path.join(__dirname, '..', '..', 'voice-pack', 'models'),
        ];
        for (const m of packedModels) {
            const base06 = path.join(m, 'Qwen3-TTS-12Hz-0.6B-Base');
            try {
                if (fs.existsSync(base06)) { envPatch.QWEN3TTS_MODEL_DIR_BASE = base06; break; }
            } catch (e) { /* ignore */ }
        }
    }
    if (process.env.QWEN3TTS_SEED) envPatch.QWEN3TTS_SEED = process.env.QWEN3TTS_SEED;
    // 2026-09-12 服务端改造可调项透传(资源占用/切句合并/优先级, 详见 stt/qwen3tts_server.py 文档头):
    //   QWEN3TTS_TORCH_THREADS 线程数 / QWEN3TTS_PRIORITY below_normal|normal /
    //   QWEN3TTS_MERGE_SHORT 短句合并阈值(第93轮默认 16) / QWEN3TTS_MERGE_MAX 合并上限(默认 120)
    //   QWEN3TTS_SINGLE_MAX  ≤N 字的请求整段一次生成(第97轮起默认 90, 对齐客户端 ≤90; 段内零边界=音色不跳档)
    //
    // 2026-09-12 第九轮实测(用户反馈"生成语音时 CPU 跑满 100%、全机卡顿"):
    //   CPU 侧 AR 解码的线程扫描(同一段 37 字文本, 进程 CPU 秒 / 墙钟秒 / 字每秒):
    //     4 线程  62.4 / 32.6 / 1.14      6 线程  114.1 / 29.3 / 1.26
    //     8 线程 163.7 / 32.0 / 1.16     10 线程 248.4 / 33.6 / 1.10
    //    12 线程 330.4 / 35.3 / 1.05  ← 旧默认(物理核), 单次合成即把 12 核吃到 ~94%
    //   → 线程越多只会更吃 CPU, 墙钟几乎不变(内存带宽/同步受限)。**默认改为 6**: 墙钟最快,
    //     进程 CPU 只有 12 线程的 1/2.9, 前台程序不再被抢到卡顿。用户可用 QWEN3TTS_TORCH_THREADS 覆盖。
    if (!process.env.QWEN3TTS_TORCH_THREADS) envPatch.QWEN3TTS_TORCH_THREADS = '6';
    ['QWEN3TTS_TORCH_THREADS', 'QWEN3TTS_PRIORITY', 'QWEN3TTS_MERGE_SHORT', 'QWEN3TTS_MERGE_MAX', 'QWEN3TTS_SINGLE_MAX'].forEach((k) => {
        if (process.env[k]) envPatch[k] = process.env[k];
    });
    try {
        ttsProcess = spawn(loc.py, [script, '-p', String(TTS_PORT)], {
            cwd: loc.dir,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: Object.assign({}, process.env, envPatch),
        });
        const proc = ttsProcess;
        // 仅在仍是本进程时清引用: 防 restart 后旧进程的迟到 exit 事件误清掉新进程句柄
        ttsProcess.on('exit', () => { if (ttsProcess === proc) ttsProcess = null; });
        managedPid = ttsProcess.pid;
        startWatchdog(ttsProcess.pid);
        console.log('[语音服务] Qwen3-TTS 服务已后台启动(' + (useFast ? 'fast 后端, /warm 会做一次真合成预热' : '旧后端, 模型首次 /tts 懒加载') + ')');
    } catch (err) {
        console.error('[语音服务] 启动失败:', err && err.message);
        ttsProcess = null;
        return false;
    }
    for (let i = 0; i < 60; i++) {
        if (!ttsProcess) break; // 引擎中途死亡(含被 restart 杀掉): 提前退出, 不空等满轮询
        if (await isTtsUp()) return true;
        await new Promise((r) => setTimeout(r, 2000));
    }
    return isTtsUp();
}

// ---------- 引擎 B: IndexTTS-2.5(独立部署, 种子抽卡) ----------
async function startIndexTts() {
    const loc = detectIndexTts();
    if (!loc) {
        console.error('[语音服务] 未找到 IndexTTS 环境(请设置 INDEX_TTS_DIR/INDEX_TTS_PY 或按 15-deployment §2 部署 index-tts), 语音功能不可用');
        return false;
    }
    console.log('[语音服务] 使用 IndexTTS 环境:', loc.dir);
    const envPatch = {
        PATH: path.join(loc.dir, '.venv', 'Scripts') + ';' + (process.env.PATH || ''),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HF_ENDPOINT: 'https://hf-mirror.com',
    };
    // 透传部署配置(15-deployment §2): checkpoints 目录 / config.yaml / 种子
    if (process.env.INDEX_TTS_MODEL_DIR) envPatch.INDEX_TTS_MODEL_DIR = process.env.INDEX_TTS_MODEL_DIR;
    if (process.env.INDEX_TTS_CFG) envPatch.INDEX_TTS_CFG = process.env.INDEX_TTS_CFG;
    if (process.env.YUEYUE_TTS_SEED) envPatch.YUEYUE_TTS_SEED = process.env.YUEYUE_TTS_SEED;
    try {
        ttsProcess = spawn(loc.py, [INDEXTTS_SCRIPT, '-p', String(TTS_PORT)], {
            cwd: loc.dir,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: Object.assign({}, process.env, envPatch),
        });
        const proc = ttsProcess;
        // 仅在仍是本进程时清引用: 防 restart 后旧进程的迟到 exit 事件误清掉新进程句柄
        ttsProcess.on('exit', () => { if (ttsProcess === proc) ttsProcess = null; });
        managedPid = ttsProcess.pid;
        startWatchdog(ttsProcess.pid);
        console.log('[语音服务] IndexTTS 服务已后台启动(FastAPI 先起, 模型首次 /tts 懒加载, 启动预热会触发)');
    } catch (err) {
        console.error('[语音服务] 启动失败:', err && err.message);
        ttsProcess = null;
        return false;
    }
    // 懒加载设计: /docs 秒级就绪; 模型加载由 main.js warmUpTts 的首次 /tts 触发
    for (let i = 0; i < 60; i++) {
        if (!ttsProcess) break; // 引擎中途死亡(含被 restart 杀掉): 提前退出, 不空等满轮询
        if (await isTtsUp()) return true;
        await new Promise((r) => setTimeout(r, 2000));
    }
    return isTtsUp();
}

async function startServer() {
    if (ttsProcess) return true;
    // 零残留策略:端口上已有的任何服务(上次崩溃残留/手动开启)一律先清掉,由本进程独占管理
    const owner = portOwnerPid(TTS_PORT);
    if (owner > 0) {
        console.log('[语音服务] 清理端口残留进程 PID=' + owner);
        await killTreeAsync(owner); // 异步杀, 不阻塞主进程事件循环
        await new Promise((r) => setTimeout(r, 3000));
    }
    if (await isTtsUp()) {
        // 极少数清不掉的情况(如权限不足),复用现有服务——但仍要记录 PID, 退出时兜底清理
        // 2026-09-12 技术债修复: /docs 通≠能干活(可能卡死在合成线程), 加 /tts 探活;
        // 探活失败则拒绝复用(宁可 TTS_SERVICE_MISSING 快速失败, 也不接管卡死服务导致永久静默)
        if (!(await probeTtsResponsive())) {
            console.error('[语音服务] 端口现有服务疑似卡死(/tts 无响应), 拒绝复用');
            return false;
        }
        managedPid = portOwnerPid(TTS_PORT);
        console.log('[语音服务] 复用端口现有服务 PID=' + managedPid);
        return true;
    }
    const engine = resolveEngine();
    if (engine === 'kokoro') return startKokoroTts();
    if (engine === 'indextts') return startIndexTts();
    if (engine === 'qwen3tts') return startQwen3Tts();
    return startSovits(); // 默认 sovits, 与现状完全一致
}

function ensure() {
    if (restarting) return restarting.then(() => ensure()); // 等在途 restart 杀干净再启动, 避免新旧进程端口竞态
    if (ttsStarting) return ttsStarting;
    ttsStarting = startServer().finally(() => { ttsStarting = null; });
    return ttsStarting;
}

function shutdown() {
    // 1) 本次会话托管的 PID(自己拉起或复用端口上的)
    if (managedPid) { killTree(managedPid); managedPid = null; }
    if (ttsProcess) { killTree(ttsProcess.pid); ttsProcess = null; }
    // 2) 端口兜底: 9880 上不管是谁, 一律清掉
    const owner = portOwnerPid(TTS_PORT);
    if (owner > 0) killTree(owner);
    // 3) 命令行兜底: 杀掉所有 api_v2.py / index_tts_server.py 的 python 进程
    killTtsPythons();
}

// 2026-10-19 第42轮 S1: 非阻塞版 shutdown, 供退出/恢复出厂路径使用。
// 同步版里的 killTtsPythons() 要 spawnSync 一个 PowerShell(单次数秒), 旧退出路径因此卡约 10 秒。
// 这里全部换成异步(端口查询仍同步但只是一次 netstat, 毫秒级), 返回 promise 由调用方限时等待。
function shutdownAsync() {
    const jobs = [];
    if (managedPid) { jobs.push(killTreeAsync(managedPid)); managedPid = null; }
    if (ttsProcess) { const pid = ttsProcess.pid; ttsProcess = null; jobs.push(killTreeAsync(pid)); }
    try {
        const owner = portOwnerPid(TTS_PORT);
        if (owner > 0) jobs.push(killTreeAsync(owner));
    } catch (e) { /* 端口查询失败不阻断退出 */ }
    jobs.push(killTtsPythonsAsync());
    return Promise.allSettled(jobs);
}

// =============================================================
// 渲染层参数映射: GPT-SoVITS 请求体 -> IndexTTS 参数(14 §3.2)
// 由 main.js tts:speak 在 engine==='indextts' 时调用; tts-voice.js 零改动
// =============================================================
function buildIndexTtsRequest(body) {
    // body: main.js 组装的 GPT-SoVITS 形状 { text, ref_audio_path, prompt_text, top_k, top_p,
    //   temperature, text_split_method, fragment_interval, speed_factor, sample_steps, seed, ... }
    const p = (body && body.params) || body || {};
    // speed_factor(值越小越慢) -> duration_factor(值越大越慢) 取倒数, 夹到 0.5-2.0
    const speed = (typeof p.speed_factor === 'number' && p.speed_factor > 0) ? p.speed_factor : 0.9;
    const duration = Math.min(2.0, Math.max(0.5, 1 / speed));
    // sample_steps 档位映射(14 §3.2): 6-8 -> fast(10 步) / 16 -> medium(16 步) / 32 -> slow(25 步)
    const rawSteps = parseInt(p.sample_steps, 10);
    const steps = Number.isFinite(rawSteps) && rawSteps > 0 ? rawSteps : 32;
    let inferMode = 'slow';
    let samplingSteps = 25;
    if (steps <= 8) { inferMode = 'fast'; samplingSteps = 10; }
    else if (steps <= 16) { inferMode = 'medium'; samplingSteps = 16; }
    return {
        // text 原样
        // 音色锚: GPT-SoVITS 的 6 段参考音平移为 IndexTTS spk 参考(种子模式下作为附加锚, 服务端自动降级)
        spk_audio_path: body.ref_audio_path || null,
        // prompt_text 在 IndexTTS 纯音频条件克隆中不使用, 丢弃
        // 速度/温度/重复惩罚(just_woke 等 mood 参数由渲染层 MOOD_VOICE 已经换算进 speed_factor/temperature,
        // 此处统一再换算为 IndexTTS 参数; fragment_interval 保留语义为句间静音)
        duration_factor: Math.round(duration * 1000) / 1000,
        temperature: (typeof p.temperature === 'number') ? p.temperature : 0.9,
        repetition_penalty: (typeof p.repetition_penalty === 'number') ? p.repetition_penalty : 1.2,
        fragment_interval: (typeof p.fragment_interval === 'number' && p.fragment_interval >= 0) ? p.fragment_interval : 0.3,
        infer_mode: inferMode,
        sampling_steps: samplingSteps,
        // top_k/top_p/text_split_method/batch_size: IndexTTS 2.5 无对应参数, 不转发(14 §3.2)
        // seed: 不随请求走——音色由服务端 YUEYUE_TTS_SEED/seed.txt 固定(种子抽卡锁定的音色稳定性;
        //   main.js 质检失败重试会改 body.seed, 但服务端忽略之, 保持音色一致)
    };
}

// ---------- 音频质检 ----------
function checkWav(buf) {
    if (!buf || buf.length < 44) return { ok: false, why: 'short' };
    const channels = buf.readUInt16LE(22) || 1;
    const sampleRate = buf.readUInt32LE(24) || 48000;
    const bits = buf.readUInt16LE(34) || 16;
    if (bits !== 16) return { ok: false, why: 'not_pcm16' };
    const data = buf.subarray(44);
    const sw = 2;
    let maxSample = 0;
    for (let i = 0; i + sw <= data.length; i += sw) {
        const a = Math.abs(data.readInt16LE(i));
        if (a > maxSample) maxSample = a;
    }
    if (maxSample >= 32500) return { ok: false, why: 'clipping' };
    const frameBytes = Math.floor(sampleRate * 0.02) * sw * Math.max(channels, 1);
    if (frameBytes <= 0) return { ok: false, why: 'bad_header' };
    let silentRun = 0;
    let longestSilent = 0;
    let flatFrames = 0;
    let totalFrames = 0;
    for (let i = 0; i + frameBytes <= data.length; i += frameBytes) {
        const seg = data.subarray(i, i + frameBytes);
        let sumSq = 0;
        let peak = 0;
        let n = 0;
        for (let j = 0; j + sw <= seg.length; j += sw) {
            const v = seg.readInt16LE(j);
            sumSq += v * v;
            const a = Math.abs(v);
            if (a > peak) peak = a;
            n++;
        }
        const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
        totalFrames++;
        if (rms < 150) {
            silentRun++;
            const silentSec = silentRun * 0.02;
            if (silentSec > longestSilent) longestSilent = silentSec;
        } else {
            silentRun = 0;
            if (peak > 0 && peak / rms < 2.2) flatFrames++;
        }
    }
    if (longestSilent > 3.0) return { ok: false, why: 'long_gap' };
    if (totalFrames > 0 && flatFrames / totalFrames > 0.5) return { ok: false, why: 'noise' };
    return { ok: true };
}

// 2026-09-11 卡死自愈: 实测部分文本让 qwen3tts 永久卡死(装着"期待"，所有的期待 / 颜文字),
// 客户端合成超时后调用本函数杀掉引擎进程, 下一次 ensure() 冷启动新进程(恢复 ~60-90s 而非永久静默)
function restart() {
    // 2026-09-12 技术债修复(part3 §B):
    //   1) 全异步化(原 execSync/spawnSync 同步阻塞主进程, 多段并发失败时 N×3 次重试=数十秒卡顿);
    //      返回共享 promise, 并发调用幂等复用同一次; 永不 reject(main.js 未 await 调用, 防 unhandledRejection)
    //   2) 重置 ttsStarting(若 startServer 起飞中被杀, 旧健康轮询 promise 不再挡住新 ensure)
    //   3) 重置 watchdogProcess(旧看门狗只盯旧 pyPid; 置空后新进程由 startWatchdog 获得自己的父死看门狗)
    if (restarting) return restarting;
    restarting = (async () => {
        const pid = managedPid;
        managedPid = null;
        ttsStarting = null;
        watchdogProcess = null;
        await killTreeAsync(pid);
        if (ttsProcess) { const proc = ttsProcess; ttsProcess = null; await killTreeAsync(proc.pid); }
        // 2026-09-12 第九轮(审计 E3): 这里原来还有一次**全机扫描**的 killTtsPythonsAsync()。
        // 问题: 它按命令行匹配所有同名脚本进程 —— 若期间 ensure() 已经在冷启动一个新的 python,
        // 这一扫就会把新进程一起杀掉, 形成"起-杀-起"抖动(用户听感=语音长时间没反应)。
        // 现在只做"端口持有者"这一个精确目标: 谁占着 9880 就清谁(restart 的语义本来就是"端口上的服务出问题了"),
        // 真正需要全机兜底的时机只有进程退出(shutdown), 那里保留全扫。
        try {
            const owner = portOwnerPid(TTS_PORT);
            if (owner > 0) await killTreeAsync(owner);
        } catch (e) { /* 端口查询失败不阻断重启 */ }
    })().finally(() => { restarting = null; });
    return restarting;
}

module.exports = { API_URL, ensure, shutdown, shutdownAsync, restart, checkWav, getDir: () => engineDir(), getEngine: () => resolveEngine(), resolveEngine, engineDir, buildIndexTtsRequest };
