// =============================================================
// 显卡自适应调优模块:
// 1. 检测显卡厂商,自动切换半精度(NVIDIA=fp16, AMD/ZLUDA=fp32)
// 2. 启动时后台实测合成速度,自动选择采样步数(快卡高画质/慢卡流畅)
// 3. 校准结果持久化 14 天,避免每次启动的编译波动导致档位反复横跳
// =============================================================
const { app, BrowserWindow, ipcMain, net } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ttsServer = require('./tts-server');

let recommended = null; // { vendor, sampleSteps, calibratedAt, measuredMs }
let running = null;

function log(msg) {
    try {
        fs.appendFileSync(path.join(app.getPath('userData'), 'ai-debug.log'),
            new Date().toISOString() + ' ' + msg + '\n');
    } catch (e) { /* 忽略 */ }
}

// 2026-09-12 第九轮(审计 E2): 这个函数用 execSync(powershell) **同步阻塞主进程事件循环**, 而它在启动
// 路径上会被调用两次(精度切换 + 校准), 每次几百毫秒~数秒, 直接表现为'刚打开软件那几分钟窗口发涩'。
// 厂商在运行期不会变, 加模块级缓存后阻塞只发生一次。
let _vendorCache = null;
function detectGpuVendor() {
    if (_vendorCache) return _vendorCache;
    try {
        const out = execSync(
            'powershell -NoProfile -Command "(Get-CimInstance Win32_VideoController).Name"',
            { encoding: 'utf8', windowsHide: true, timeout: 15000 }
        );
        const t = out.toLowerCase();
        if (t.indexOf('nvidia') !== -1) _vendorCache = 'nvidia';
        else if (t.indexOf('amd') !== -1 || t.indexOf('radeon') !== -1) _vendorCache = 'amd';
        else _vendorCache = 'unknown';
        return _vendorCache;
    } catch (e) {
        return 'unknown'; // 探测失败不缓存: 下次还能再试
    }
}

// NVIDIA 用 fp16(快且稳),AMD/ZLUDA 用 fp32(防电音)
function autoTunePrecision() {
    try {
        const dir = ttsServer.getDir();
        if (!dir) return;
        const yamlPath = path.join(dir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml');
        if (!fs.existsSync(yamlPath)) return;
        const vendor = detectGpuVendor();
        const wantTrue = vendor === 'nvidia';
        const src = fs.readFileSync(yamlPath, 'utf8');
        const hasTrue = src.indexOf('is_half: true') !== -1;
        if (hasTrue === wantTrue) return; // 已匹配
        const patched = wantTrue
            ? src.replace('is_half: false', 'is_half: true')
            : src.replace('is_half: true', 'is_half: false');
        fs.writeFileSync(yamlPath, patched, 'utf8');
        log('tts: 精度自动切换为 ' + (wantTrue ? 'fp16' : 'fp32') + ' (vendor=' + vendor + ')');
    } catch (err) {
        log('tts: 精度自动切换失败 ' + (err && err.message));
    }
}

function calibPath() {
    return path.join(app.getPath('userData'), 'tts-calib.json');
}
function loadCalibration() {
    try {
        const d = JSON.parse(fs.readFileSync(calibPath(), 'utf8'));
        if (d && d.calibratedAt && (Date.now() - d.calibratedAt < 14 * 24 * 3600 * 1000)) return d;
    } catch (e) { /* 忽略 */ }
    return null;
}
function saveCalibration(d) {
    try { fs.writeFileSync(calibPath(), JSON.stringify(d), 'utf8'); } catch (e) { /* 忽略 */ }
}

function recommendSteps(vendor, ms) {
    if (vendor === 'nvidia') {
        if (ms < 4000) return 32;
        if (ms < 8000) return 16;
        if (ms < 14000) return 8;
        return 6;
    }
    // AMD/ZLUDA(全精度)或未知:保守档位
    if (ms < 8000) return 16;
    if (ms < 14000) return 8;
    return 6;
}

function broadcast() {
    if (!recommended) return;
    BrowserWindow.getAllWindows().forEach((w) => {
        try { w.webContents.send('tts:config', recommended); } catch (e) { /* 忽略 */ }
    });
}

// 固定校准文本(短句,稳定衡量单次合成速度)
function calibBody() {
    return {
        text: '嗯。',
        text_lang: 'zh',
        ref_audio_path: 'output/slicer_opt/260829024517_玥玥111.wav_0000145920_0000257280.wav',
        prompt_text: '没干嘛，就窝在沙盒厨房里煮了点东西。',
        prompt_lang: 'zh',
        top_k: 8,
        top_p: 0.9,
        temperature: 0.8,
        text_split_method: 'cut0',
        fragment_interval: 0.2,
        speed_factor: 1.0,
        sample_steps: 6,
        batch_size: 1,
        seed: 1,
        streaming_mode: false,
        media_type: 'wav',
    };
}

async function timedCall() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
        const t0 = Date.now();
        const resp = await net.fetch(ttsServer.API_URL + '/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(calibBody()),
            signal: controller.signal,
        });
        await resp.arrayBuffer();
        return resp.ok ? (Date.now() - t0) : -1;
    } catch (e) {
        return -1;
    } finally {
        clearTimeout(timer);
    }
}

async function calibrate() {
    try {
        await ttsServer.ensure();
        await timedCall(); // 第 1 次:完成 ZLUDA 内核编译(预热)
        await new Promise((r) => setTimeout(r, 2000));
        const ms = await timedCall(); // 第 2 次:实测纯合成速度
        if (ms <= 0) { log('tts: 校准失败,使用默认档位'); return; }
        const vendor = detectGpuVendor();
        const steps = recommendSteps(vendor, ms);
        recommended = { vendor, sampleSteps: steps, measuredMs: ms, calibratedAt: Date.now() };
        saveCalibration(recommended);
        log('tts: 校准完成 vendor=' + vendor + ' 实测=' + ms + 'ms 推荐步数=' + steps);
        broadcast();
    } catch (err) {
        log('tts: 校准异常 ' + (err && err.message));
    }
}

function run() {
    // 先应用持久化档位(立即生效),再后台重新校准(14 天内则跳过重校)
    const saved = loadCalibration();
    if (saved) {
        recommended = saved;
        log('tts: 使用已存校准 sampleSteps=' + saved.sampleSteps);
        broadcast();
        return;
    }
    if (running) return running;
    running = calibrate().finally(() => { running = null; });
    return running;
}

// 渲染层拉取(事件错过时的兜底)
ipcMain.handle('tts:get-config', () => recommended);

module.exports = { run, autoTunePrecision, getRecommended: () => recommended };
