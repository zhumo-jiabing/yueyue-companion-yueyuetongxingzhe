// =============================================================
// 内置语音识别服务管理器(9890 端口):
// 双引擎(阶段1 ASR 替换, 2026-09 · 集成方案 14 §2.2):
//   - whisper    : 默认引擎(未设环境变量时行为与现状完全一致, 一键回滚路径)
//                  python 来自 GPT-SoVITS 目录 runtime, 脚本 stt_server.py
//   - sensevoice : YUEYUE_STT_ENGINE=sensevoice 时启用(SenseVoice-Small, FunASR, CPU)
//                  python 来自独立 venv(STT_SENSEVOICE_DIR 或候选目录, 不依赖 GPT-SoVITS 目录)
//                  脚本 app/stt/stt_server_sensevoice.py, 懒加载模型 + 后台静音预热
// 按需拉起(首次语音输入时), 空闲 15 分钟服务自停, 应用退出时清理
// =============================================================
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ttsServer = require('./tts-server');

const STT_PORT = 9890;
const STT_URL = 'http://127.0.0.1:' + STT_PORT;
// 引擎开关: whisper(默认, 原路径不变) / sensevoice(独立部署)
const ENGINE = String(process.env.YUEYUE_STT_ENGINE || 'whisper').toLowerCase();

let sttProcess = null;
let sttStarting = null;
let watchdogProcess = null;
let idleTimer = null;
let lastUseAt = 0;

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

function killTree(pid) {
    if (!pid) return;
    try { execSync('taskkill /PID ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* 忽略 */ }
}

// 2026-10-19 第42轮 S1: 异步杀进程树, 供退出路径使用(同步版会阻塞主进程)
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

// 命令行兜底过滤条件: 同时覆盖两种引擎(无论当前是哪个, shutdown/看门狗都清干净)
function pythonCmdlineFilter() {
    return "($_.CommandLine -like '*stt_server.py*') -or ($_.CommandLine -like '*stt_server_sensevoice.py*')";
}

// 空闲 15 分钟自停(释放模型内存; 再次使用时按需自动拉起)
function stopServer() {
    if (sttProcess) { try { killTree(sttProcess.pid); } catch (e) { /* 忽略 */ } sttProcess = null; }
    const owner = portOwnerPid(STT_PORT);
    if (owner > 0) { try { killTree(owner); } catch (e) { /* 忽略 */ } }
}
function armIdleStop() {
    lastUseAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        try { if (Date.now() - lastUseAt >= 15 * 60000) stopServer(); } catch (e) { /* 忽略 */ }
    }, 16 * 60000);
}

function isSttUp() {
    return new Promise((resolve) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2500);
        fetch(STT_URL + '/docs', { signal: controller.signal })
            .then(() => { clearTimeout(timer); resolve(true); })
            .catch(() => { clearTimeout(timer); resolve(false); });
    });
}

// 父进程死亡看门狗: 应用退出/崩溃后清掉 stt python(两种引擎都覆盖)
function startWatchdog() {
    try {
        if (watchdogProcess) return;
        const appPid = process.pid;
        const script = [
            "$ErrorActionPreference='SilentlyContinue'",
            "$p=Get-Process -Id " + appPid + " -ErrorAction SilentlyContinue",
            "while($p){ Start-Sleep -Seconds 2; $p=Get-Process -Id " + appPid + " -ErrorAction SilentlyContinue }",
            "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { " + pythonCmdlineFilter() + " } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }",
            "exit"
        ].join('; ');
        watchdogProcess = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
            windowsHide: true, detached: false, stdio: 'ignore',
        });
        if (watchdogProcess.unref) watchdogProcess.unref();
    } catch (e) { /* 忽略 */ }
}

// ---------- 引擎 A: whisper(原路径, 未改动) ----------
async function startWhisper() {
    const dir = ttsServer.getDir();
    if (!dir) return false;
    const py = path.join(dir, 'runtime', 'python.exe');
    try {
        sttProcess = spawn(py, ['stt_server.py', '-p', String(STT_PORT)], {
            cwd: dir,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: Object.assign({}, process.env, {
                PATH: path.join(dir, 'runtime') + ';' + (process.env.PATH || ''),
                HF_ENDPOINT: 'https://hf-mirror.com',
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            }),
        });
        sttProcess.on('exit', () => { sttProcess = null; });
        startWatchdog();
    } catch (err) {
        sttProcess = null;
        return false;
    }
    for (let i = 0; i < 75; i++) {
        if (await isSttUp()) { armIdleStop(); return true; }
        await new Promise((r) => setTimeout(r, 2000));
    }
    const up = await isSttUp();
    if (up) armIdleStop();
    return up;
}

// ---------- 引擎 B: sensevoice(独立 venv, 不依赖 GPT-SoVITS 目录) ----------
const SENSEVOICE_SCRIPT = path.join(__dirname, 'stt', 'stt_server_sensevoice.py');

// 探测独立 venv: STT_SENSEVOICE_DIR 优先, 之后 app 同级 stt-sensevoice、部署文档默认路径、开发机常见路径
function detectSenseVoiceDir() {
    const bases = [];
    if (process.env.STT_SENSEVOICE_DIR) bases.push(process.env.STT_SENSEVOICE_DIR);
    bases.push(path.join(path.dirname(process.execPath), 'stt-sensevoice'));      // 应用 exe 同级
    bases.push(path.join(__dirname, '..', '..', 'stt-sensevoice'));              // win-unpacked 同级
    bases.push('G:\\YueyueAI\\venv-asr');                                         // 部署文档 15 §3 默认路径
    bases.push('G:\\yueyueneiceban\\stt-sensevoice');                                 // 开发机常见路径(2026-09-12 迁移更新)
    for (const dir of bases) {
        if (!dir) continue;
        for (const rel of ['Scripts\\python.exe', 'python.exe']) {
            const py = path.join(dir, rel);
            try {
                if (fs.existsSync(py)) return { dir, py };
            } catch (e) { /* 忽略无效路径 */ }
        }
    }
    return null;
}

// 生成一段 0.2s 16k 单声道静音 WAV(后台预热用: 触发 SenseVoice 懒加载, 用户首句不用等模型)
function silentWavBytes() {
    const sr = 16000, secs = 0.2;
    const n = Math.floor(sr * secs);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    return buf;
}

// 服务就绪后后台静音预热: SenseVoice 懒加载被触发, 失败静默(首次真实转写仍可正常加载)
function warmupSenseVoice() {
    setTimeout(() => {
        fetch(STT_URL + '/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: silentWavBytes(),
        }).catch(() => { /* 预热失败静默 */ });
    }, 1500);
}

async function startSenseVoice() {
    const loc = detectSenseVoiceDir();
    if (!loc) {
        console.error('[语音识别] 未找到 SenseVoice 独立环境(请设置 STT_SENSEVOICE_DIR 或按 15-deployment §3 部署 venv-asr), 语音识别不可用');
        return false;
    }
    console.log('[语音识别] 使用 SenseVoice 环境:', loc.dir);
    try {
        sttProcess = spawn(loc.py, [SENSEVOICE_SCRIPT, '-p', String(STT_PORT)], {
            cwd: loc.dir,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'ignore'],
            env: Object.assign({}, process.env, {
                PATH: path.join(loc.dir, 'Scripts') + ';' + (process.env.PATH || ''),
                HF_ENDPOINT: 'https://hf-mirror.com',
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1',
            }),
        });
        sttProcess.on('exit', () => { sttProcess = null; });
        startWatchdog();
    } catch (err) {
        sttProcess = null;
        return false;
    }
    // SenseVoice 服务秒级就绪(FastAPI 先起, 模型懒加载), 40×2s 上限足够
    for (let i = 0; i < 40; i++) {
        if (await isSttUp()) { armIdleStop(); warmupSenseVoice(); return true; }
        await new Promise((r) => setTimeout(r, 2000));
    }
    const up = await isSttUp();
    if (up) { armIdleStop(); warmupSenseVoice(); }
    return up;
}

async function startServer() {
    if (sttProcess) return true;
    const owner = portOwnerPid(STT_PORT);
    if (owner > 0) { killTree(owner); await new Promise((r) => setTimeout(r, 2000)); }
    if (await isSttUp()) return true;
    if (ENGINE === 'sensevoice') return startSenseVoice();
    return startWhisper(); // 默认 whisper, 与现状完全一致
}

function ensure() {
    if (sttStarting) return sttStarting;
    sttStarting = startServer().finally(() => { sttStarting = null; });
    return sttStarting;
}

function shutdown() {
    if (sttProcess) { killTree(sttProcess.pid); sttProcess = null; }
    const owner = portOwnerPid(STT_PORT);
    if (owner > 0) killTree(owner);
    // 命令行兜底: 两种引擎的 python 全清(stt_server.py / stt_server_sensevoice.py)
    try {
        execSync('powershell -NoProfile -WindowStyle Hidden -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'python.exe\'\\" | Where-Object { ' + pythonCmdlineFilter() + ' } | ForEach-Object { $_.ProcessId }"', { windowsHide: true, timeout: 15000, encoding: 'utf8' })
            .split(/\s+/).map((s) => parseInt(s, 10)).filter((p) => p > 0)
            .forEach((p) => { try { killTree(p); } catch (e) { /* 忽略 */ } });
    } catch (e) { /* 忽略 */ }
}

// 2026-10-19 第42轮 S1: 非阻塞版 shutdown(退出/恢复出厂路径使用, 不再卡 10 秒)
function shutdownAsync() {
    const jobs = [];
    if (sttProcess) { const pid = sttProcess.pid; sttProcess = null; jobs.push(killTreeAsync(pid)); }
    try {
        const owner = portOwnerPid(STT_PORT);
        if (owner > 0) jobs.push(killTreeAsync(owner));
    } catch (e) { /* 端口查询失败不阻断退出 */ }
    jobs.push(new Promise((resolve) => {
        let done = false;
        const fin = () => { if (!done) { done = true; resolve(); } };
        try {
            const script = [
                "$ErrorActionPreference='SilentlyContinue'",
                "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { " + pythonCmdlineFilter() + " } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }",
            ].join('; ');
            const c = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, stdio: 'ignore' });
            const timer = setTimeout(() => { try { c.kill(); } catch (e) { /* 忽略 */ } fin(); }, 15000);
            c.on('error', () => { clearTimeout(timer); fin(); });
            c.on('close', () => { clearTimeout(timer); fin(); });
        } catch (e) { fin(); }
    }));
    return Promise.allSettled(jobs);
}

async function transcribe(wavBuffer) {
    const ok = await ensure();
    if (!ok) return { ok: false, error: 'STT_SERVICE_MISSING' };
    armIdleStop();
    // sensevoice: 首次转写可能包含模型懒加载(秒~分钟级), 用 60s 超时防挂死; whisper 路径保持原行为不加超时
    const controller = new AbortController();
    const timeout = ENGINE === 'sensevoice'
        ? setTimeout(() => controller.abort(), 60000)
        : null;
    try {
        const resp = await fetch(STT_URL + '/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: wavBuffer,
            signal: controller.signal,
        });
        const j = await resp.json().catch(() => ({}));
        if (resp.ok && j && j.text) return { ok: true, text: j.text };
        return { ok: false, error: (j && j.message) || ('HTTP ' + resp.status) };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

module.exports = { ensure, shutdown, shutdownAsync, transcribe, getEngine: () => ENGINE };
