# -*- coding: utf-8 -*-
"""随包语音引擎：Kokoro-82M（ONNX / CPU）。

为什么换：现役 qwen3tts 是"音色克隆"，模型在 GPT-SoVITS 目录里几 GB，装不到软件包里，
而且它的推理参数写死在 server 里（xvec_only=True + 每句 seed=42），外面怎么调都不生效 ——
听感永远偏冷。Kokoro 是纯 CPU 的 82M 小模型，模型本身就能塞进 resources/app，装完即用、
不联网、不下模型，声音换机器也不变。

接口与 stt/qwen3tts_fast_server.py 逐字对齐（POST /tts → audio/wav PCM16），
所以前端、tts-server.js 的调用方一行都不用改，只是启动另一个脚本。

用法：
  python kokoro_tts_server.py -p 9880 --model-dir <dir> --sid 46 --speed 0.94
"""
import argparse
import asyncio
import io
import os
import sys
import time
import uuid

import numpy as np

# 句间停顿：标点决定呼吸的长短（照 r170b 的分档，机器味就是从"每句都停一样久"来的）
PAUSE_BY_TAG = {"。": 0.30, "！": 0.28, "？": 0.32, "；": 0.26, "，": 0.18, "、": 0.12}
PAUSE_DEFAULT = 0.16
SENT_END = "。！？!?…"

_warm_done = False


def log(msg):
    print("[kokoro] " + msg, flush=True)


def _split_sentences(text):
    """按句末标点切句，保留标点，避免把一句话切碎。"""
    parts, buf = [], ""
    for ch in text:
        buf += ch
        if ch in SENT_END:
            parts.append(buf)
            buf = ""
    if buf.strip():
        parts.append(buf)
    return [p for p in parts if p.strip()]


def _pause_for(prev):
    tag = prev.rstrip()[-1:] if prev.rstrip() else ""
    return PAUSE_BY_TAG.get(tag, PAUSE_DEFAULT)


def _fade_out(audio, sr, ms=120):
    n = int(sr * ms / 1000.0)
    if audio.size > n > 0:
        audio[-n:] = audio[-n:] * np.linspace(1.0, 0.0, n, dtype=np.float32)
    return audio


def _peak_guard(audio, peak=0.99):
    m = float(np.max(np.abs(audio))) if audio.size else 0.0
    if m > peak:
        audio = audio * (peak / m)
    return audio.astype(np.float32)


def _tail_silence(sr, sec=0.25):
    return np.zeros(int(sr * sec), dtype=np.float32)


class KokoroEngine:
    def __init__(self, model_dir, sid, speed, num_threads=2, model_name="model.onnx"):
        import sherpa_onnx

        def need(name):
            p = os.path.join(model_dir, name)
            if not os.path.isfile(p):
                raise RuntimeError("缺少模型文件: " + p)
            return p

        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=need(model_name),
                    voices=need("voices.bin"),
                    tokens=need("tokens.txt"),
                    data_dir=os.path.join(model_dir, "espeak-ng-data"),
                    lexicon=need("lexicon-us-en.txt") + "," + need("lexicon-zh.txt"),
                    dict_dir=os.path.join(model_dir, "dict"),
                ),
                num_threads=num_threads,
                provider="cpu",
            ),
            rule_fsts=",".join([
                need("date-zh.fst"),
                need("number-zh.fst"),
                need("phone-zh.fst"),
            ]),
            max_num_sentences=1,
        )
        if not cfg.validate():
            raise RuntimeError("sherpa-onnx 配置校验失败（模型/词典路径不对？）")
        self.tts = sherpa_onnx.OfflineTts(cfg)
        self.sid = int(sid)
        self.speed = float(speed)
        log("模型就绪: %s  speakers=%d  sid=%d  speed=%.2f" % (
            model_dir, self.tts.num_speakers, self.sid, self.speed))

    def synth(self, text, should_abort=None):
        chunks = _split_sentences(text)
        if not chunks:
            return None, 24000
        sr = self.tts.sample_rate
        out = []
        t0 = time.time()
        for i, sent in enumerate(chunks):
            if should_abort is not None and should_abort():
                log("取消: 已合成 %d/%d 句, 提前收手" % (i, len(chunks)))
                return None, sr
            audio = self.tts.generate(sent, sid=self.sid, speed=self.speed)
            w = np.asarray(audio.samples, dtype=np.float32)
            if w.size == 0:
                continue
            if out:
                out.append(np.zeros(int(sr * _pause_for(chunks[i - 1])), dtype=np.float32))
            out.append(w)
        if not out:
            return None, sr
        audio = np.concatenate(out)
        audio = _fade_out(audio, sr)
        audio = np.concatenate([audio, _tail_silence(sr)])   # 句尾留一口气
        audio = _peak_guard(audio)
        log("合成 %d字 %.2fs → 音频 %.2fs" % (len(text), time.time() - t0, audio.size / sr))
        return audio, sr


def build_app(engine):
    from fastapi import FastAPI, Request, Response
    from fastapi.responses import JSONResponse
    import soundfile as sf

    app = FastAPI()

    def _err(code, msg):
        return JSONResponse({"error": msg}, status_code=code)

    @app.get("/health")
    def health():
        return {"ok": True, "engine": "kokoro", "warm": _warm_done,
                "speakers": engine.tts.num_speakers, "sid": engine.sid}

    @app.post("/warm")
    def warm():
        global _warm_done
        t0 = time.time()
        try:
            engine.synth("嗯，我在。")
            _warm_done = True
            return {"ok": True, "warm": True, "sec": round(time.time() - t0, 2)}
        except Exception as e:  # noqa: BLE001
            return _err(500, str(e)[:200])

    import threading
    _synth_lock = threading.Lock()
    _state = {"epoch": 0}

    def _synth_serial(text, epoch):
        # CPU 合成本来就该串行；但等锁放在线程里，HTTP 不再被堵住
        with _synth_lock:
            if _state["epoch"] != epoch:
                return None, 24000
            return engine.synth(text, lambda: _state["epoch"] != epoch)

    @app.post("/tts")
    async def tts(request: Request):
        try:
            body = await request.json()
        except Exception:  # noqa: BLE001
            return _err(400, "BAD_JSON")
        text = str(body.get("text") or "").strip()
        if not text:
            return _err(400, "EMPTY_TEXT")
        job_id = str(body.get("job_id") or "").strip() or uuid.uuid4().hex[:12]
        try:
            epoch = _state["epoch"]
            loop = asyncio.get_running_loop()
            audio, sr = await loop.run_in_executor(None, _synth_serial, text, epoch)
            if audio is None:
                # 被更新的一轮取消 / 或合成失败：回 499，前端会自然丢弃这一段
                return _err(499, "CANCELLED_OR_STALE")
            buf = io.BytesIO()
            sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
            return Response(content=buf.getvalue(), media_type="audio/wav",
                            headers={"X-Tts-Job-Id": job_id})
        except Exception as e:  # noqa: BLE001
            log("ERROR job=%s %s" % (job_id, str(e)[:200]))
            return _err(500, str(e)[:200])

    @app.post("/cancel")
    async def cancel(request: Request):
        # 真正取消：自增 epoch，正在合成的那一段会在下一句之前收手
        _state["epoch"] += 1
        return {"ok": True, "cancelled": True, "epoch": _state["epoch"]}

    return app


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=9880)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--model-dir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "kokoro"))
    ap.add_argument("--sid", type=int, default=int(os.environ.get("YUEYUE_KOKORO_SID", "46")))
    ap.add_argument("--speed", type=float, default=float(os.environ.get("YUEYUE_KOKORO_SPEED", "0.94")))
    ap.add_argument("--threads", type=int, default=int(os.environ.get("YUEYUE_KOKORO_THREADS", "4")))
    ap.add_argument("--model", default=os.environ.get("YUEYUE_KOKORO_MODEL", "model.onnx"),
                    help="model.onnx(fp32, RTF≈0.33) 或 model.int8.onnx(体积1/3, RTF≈0.97)")
    ap.add_argument("--selftest", action="store_true", help="只合成一句存成 wav 后退出")
    args = ap.parse_args()

    engine = KokoroEngine(args.model_dir, args.sid, args.speed, args.threads, args.model)

    if args.selftest:
        import soundfile as sf
        audio, sr = engine.synth("嘴巴干干的那种渴，身体又像被粘住了。我知道啦。")
        out = os.path.join(os.getcwd(), "kokoro-selftest.wav")
        sf.write(out, audio, sr, format="WAV", subtype="PCM_16")
        log("selftest 写出 " + out)
        return 0

    import uvicorn
    log("监听 http://%s:%d  (POST /tts)" % (args.host, args.port))
    uvicorn.run(build_app(engine), host=args.host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
