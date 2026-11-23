// =============================================================
// 语音输入模块(主窗与聊天窗共用):
// 1. 单次录音转写: 点🎤开始, 再点/静音 2.5s 结束 → 文本填入输入框
// 2. 语音待机感知: 开启后持续聆听, 检测到说话自动识别(像微信语音消息)
// 转写走本地 whisper 服务(主进程代理, 9890)
// =============================================================
(function () {
    if (window.VoiceInput) return;
    const S = {
        audioCtx: null, stream: null, analyser: null, source: null, processor: null,
        recording: false, waiting: false, collecting: false, busy: false,
        chunks: [], utterance: [], recStart: 0, lastSpeech: 0, noiseFloor: 0.010,
        speechMs: 0, blockSec: 0.0,
        onUtterance: null, onState: null,
    };
    const SILENCE_END_UTT = 1400;   // 停顿 1.4s 结束一句(待机感知)
    const SILENCE_END_ONCE = 2500;  // 单次录音静音 2.5s 自动结束
    const MIN_MS = 600;             // 最短有效语音(防环境噪声幻听)
    const MAX_MS = 15000;           // 单句上限
    const MIN_SPEECH_MS = 320;      // 有效语音帧累计下限: 低于此判定为"没说话", 不送转写(whisper 对纯噪声会脑补)

    function notify(extra) { try { if (S.onState) S.onState(Object.assign({ recording: S.recording, waiting: S.waiting, listening: S.collecting, busy: S.busy }, extra || {})); } catch (e) { /* 忽略 */ } }

    async function ensureMic() {
        if (S.stream) return true;
        try {
            S.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            S.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
            S.source = S.audioCtx.createMediaStreamSource(S.stream);
            S.analyser = S.audioCtx.createAnalyser();
            S.analyser.fftSize = 2048;
            S.source.connect(S.analyser);
            S.processor = S.audioCtx.createScriptProcessor(4096, 1, 1);
            S.source.connect(S.processor);
            // 静音连接(不把麦克风回放出去)
            const zero = S.audioCtx.createGain();
            zero.gain.value = 0;
            S.processor.connect(zero);
            zero.connect(S.audioCtx.destination);
            S.processor.onaudioprocess = onAudio;
            return true;
        } catch (e) {
            notify({ error: '无法访问麦克风: ' + (e && e.message || e) });
            return false;
        }
    }

    function rmsOf(chunk) {
        let s = 0;
        for (let i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i];
        return Math.sqrt(s / chunk.length);
    }

    function onAudio(ev) {
        const data = ev.inputBuffer.getChannelData(0);
        if (!S.recording && !S.waiting) return;
        const now = performance.now();
        const rms = rmsOf(data);
        // 底噪缓慢跟踪
        S.noiseFloor = S.noiseFloor * 0.995 + Math.min(rms, S.noiseFloor * 3) * 0.005;
        const th = Math.max(S.noiseFloor * 4.2, 0.012);
        const blockMs = data.length / 48000 * 1000;
        if (rms > th) S.speechMs += blockMs;
        if (S.recording) {
            S.chunks.push(new Float32Array(data));
            if (rms > th) S.lastSpeech = now;
            if (S.lastSpeech && now - S.lastSpeech > SILENCE_END_ONCE) finishOnce();
            return;
        }
        // 待机感知 VAD
        if (rms > th) {
            S.lastSpeech = now;
            if (!S.collecting) { S.collecting = true; S.utterance = []; notify(); }
            S.utterance.push(new Float32Array(data));
            if (now - S.recStart > MAX_MS) finishUtterance();
        } else if (S.collecting && now - S.lastSpeech > SILENCE_END_UTT) {
            finishUtterance();
        }
    }

    function mergeChunks(chunks) {
        const total = chunks.reduce((a, c) => a + c.length, 0);
        const out = new Float32Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    }

    // 线性重采样到 16kHz → WAV 字节
    function toWav16k(samples, sr) {
        const outLen = Math.round(samples.length * 16000 / sr);
        const out = new Float32Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const pos = i * sr / 16000;
            const i0 = Math.floor(pos);
            const i1 = Math.min(i0 + 1, samples.length - 1);
            const frac = pos - i0;
            out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
        }
        const pcm = new Int16Array(outLen);
        for (let i = 0; i < outLen; i++) {
            const v = Math.max(-1, Math.min(1, out[i]));
            pcm[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
        }
        const buf = new ArrayBuffer(44 + pcm.length * 2);
        const dv = new DataView(buf);
        const wstr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
        wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
        wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
        wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
        new Int16Array(buf, 44).set(pcm);
        return buf;
    }

    async function transcribe(chunks) {
        if (!chunks || !chunks.length) return '';
        const sr = S.audioCtx ? S.audioCtx.sampleRate : 48000;
        const wav = toWav16k(mergeChunks(chunks), sr);
        try {
            const r = await window.yueyue.stt.transcribe(wav);
            try { if (window.YueyueAnalytics) YueyueAnalytics.track('voice_input', (r && r.ok && r.text) ? 'ok' : 'fail'); } catch (e2) { /* 埋点失败忽略 */ }
            if (r && r.ok && r.text) return String(r.text).trim();
            if (r && r.error) notify({ error: '识别失败: ' + r.error });
            return '';
        } catch (e) {
            try { if (window.YueyueAnalytics) YueyueAnalytics.track('voice_input', 'fail'); } catch (e2) { /* 埋点失败忽略 */ }
            notify({ error: '识别失败: ' + (e && e.message || e) });
            return '';
        }
    }

    async function finishOnce() {
        if (!S.recording) return;
        S.recording = false;
        const chunks = S.chunks;
        S.chunks = [];
        notify();
        const lenMs = chunks.reduce((a, c) => a + c.length, 0) / (S.audioCtx ? S.audioCtx.sampleRate : 48000) * 1000;
        if (lenMs < MIN_MS) return;
        // 有效语音门控: 几乎全是底噪则判定"没说话", 不送 whisper(避免幻觉乱生成)
        if (S.speechMs < MIN_SPEECH_MS) {
            S.speechMs = 0;
            notify({ error: '没有听到说话声，再试一次吧', quiet: true });
            return;
        }
        S.speechMs = 0;
        S.busy = true; notify();
        const text = await transcribe(chunks);
        S.busy = false; notify();
        if (text && S.onUtterance) S.onUtterance(text);
    }

    async function finishUtterance() {
        if (S.busy || !S.collecting) return;
        const utt = S.utterance;
        S.collecting = false;
        S.utterance = [];
        S.recStart = performance.now();
        notify();
        const sr = S.audioCtx ? S.audioCtx.sampleRate : 48000;
        const lenMs = utt.reduce((a, c) => a + c.length, 0) / sr * 1000;
        if (lenMs < MIN_MS) return;
        // 有效语音门控: 静音/仅环境噪不送转写
        if (S.speechMs < MIN_SPEECH_MS) { S.speechMs = 0; return; }
        S.speechMs = 0;
        S.busy = true; notify();
        const text = await transcribe(utt);
        S.busy = false; notify();
        if (text && S.onUtterance) S.onUtterance(text);
    }

    window.VoiceInput = {
        onUtterance(fn) { S.onUtterance = fn; },
        onState(fn) { S.onState = fn; },
        get isWaiting() { return S.waiting; },
        get isRecording() { return S.recording; },
        async toggleOnce() {
            if (S.recording) { await finishOnce(); return; }
            if (!(await ensureMic())) return;
            if (S.waiting) await this.setWaiting(false);
            S.chunks = [];
            S.recording = true;
            S.lastSpeech = performance.now();
            S.recStart = performance.now();
            S.speechMs = 0;
            notify();
        },
        async setWaiting(on) {
            if (on) {
                if (!(await ensureMic())) return false;
                if (S.recording) { S.recording = false; S.chunks = []; }
                S.waiting = true;
                S.recStart = performance.now();
                S.speechMs = 0;
            } else {
                S.waiting = false;
                S.collecting = false;
                S.utterance = [];
            }
            notify();
            return true;
        },
        async stopAll() {
            S.recording = false; S.waiting = false; S.collecting = false;
            try { if (S.stream) S.stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* 忽略 */ }
            S.stream = null; S.source = null; S.processor = null;
            notify();
        },
    };
})();
