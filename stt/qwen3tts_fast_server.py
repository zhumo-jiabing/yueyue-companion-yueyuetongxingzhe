# -*- coding: utf-8 -*-
"""
玥玥 TTS 服务 —— Qwen3-TTS-1.7B + faster-qwen3-tts(CUDA graph) 快速后端

设计目标（第136轮，老板 m02237）：
  - 与 qwen3tts_server.py 保持同一 /tts 契约，客户端无需改协议。
  - 默认 1.7B + 锚定音 xvec-only；不碰 ICL（faster wrapper 的 ICL 目前会失控长音频）。
  - /warm 不仅加载模型，还做一次最短合成，把 CUDA graph capture 提前到用户开口之前。
  - 显存约 4.6-4.7GB；无 CUDA 时明确失败，由 tts-server.js 回退文本/旧引擎。

契约：
  GET  /docs
  POST /tts    {"text":"...", "mood":"...", "job_id":"..."} -> audio/wav PCM16
  POST /warm   {} -> {"ok":true,"warm":true,"sec":...}
  POST /cancel {"all":true} 或 {"job_id":"..."} -> {"cancelled":[...],"epoch":n}
"""
import argparse
import asyncio
import io
import json
import os
import re
import threading
import time
import uuid

# 线程数必须在 numpy/torch 之前落进环境
THREADS = max(1, min(int(os.environ.get("QWEN3TTS_TORCH_THREADS", "6") or 6), 12))
for _n in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_n, str(THREADS))

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import Response

try:
    torch.set_num_threads(THREADS)
except Exception:
    pass

DEFAULT_PORT = 9880
MODEL_DIR = os.environ.get("QWEN3TTS_MODEL_DIR_BASE") or os.environ.get("QWEN3TTS_MODEL_DIR") or ""
ANCHOR_WAV = os.environ.get("QWEN3TTS_ANCHOR_WAV") or ""
ANCHOR_TEXT = ""
for _cand in (
    os.environ.get("QWEN3TTS_ANCHOR_TEXT") or "",
    os.path.splitext(ANCHOR_WAV)[0] + ".txt" if ANCHOR_WAV else "",
    os.path.join(os.path.dirname(ANCHOR_WAV), "anchor-yueyue-sovits.txt") if ANCHOR_WAV else "",
):
    if _cand and os.path.isfile(_cand):
        try:
            with open(_cand, "r", encoding="utf-8") as _f:
                ANCHOR_TEXT = _f.read().strip()
            break
        except Exception:
            pass

if not ANCHOR_TEXT:
    # faster wrapper 的 ICL 路径当前不可用；没有 ref_text 时仍可走 xvec_only，
    # 但有些模型版本要求非空，给一个稳定的占位（不会当 ICL 用）。
    ANCHOR_TEXT = "今天也想安静地陪你待一会儿。"

QUOTE_CHARS = str.maketrans({'\u201c': '', '\u201d': '', '\u2018': '', '\u2019': '', '"': '', "'": ''})
CLAUSE_RE = re.compile(r"[^，。！？…；：\n]+[，。！？…；：\n]?")
IDLE_STOP_SEC = max(60, int(os.environ.get("YUEYUE_TTS_IDLE_STOP_SEC", "1800") or 1800))

app = FastAPI(title="yueyue-qwen3tts-fast")
_model = None
_model_lock = threading.Lock()
_synth_lock = threading.Lock()
_last_use = time.time()
_idle_timer = None

_jobs_lock = threading.Lock()
_cancel_epoch = 0
_cancelled_jobs = set()
_active_jobs = {}


def _err(status, message):
    return Response(
        content=json.dumps({"error": message}, ensure_ascii=False).encode("utf-8"),
        status_code=status,
        media_type="application/json",
    )


def _arm_idle_stop():
    global _idle_timer
    if _idle_timer:
        _idle_timer.cancel()

    def stop():
        if time.time() - _last_use >= IDLE_STOP_SEC:
            print("[qwen3tts-fast] 空闲自动退出", flush=True)
            os._exit(0)
        _arm_idle_stop()

    _idle_timer = threading.Timer(IDLE_STOP_SEC + 30, stop)
    _idle_timer.daemon = True
    _idle_timer.start()


def _pick_device():
    forced = (os.environ.get("YUEYUE_TTS_DEVICE") or "").strip().lower()
    if forced in ("cpu", "cuda", "cuda:0"):
        # faster_qwen3_tts 的 from_pretrained 只认字面量 "cuda"（见 model.py:74）
        return "cpu" if forced == "cpu" else "cuda"
    return "cuda" if torch.cuda.is_available() else "cpu"


def load_model():
    global _model
    with _model_lock:
        if _model is not None:
            return _model
        if not MODEL_DIR or not os.path.isdir(MODEL_DIR):
            raise RuntimeError("MODEL_DIR_MISSING: " + str(MODEL_DIR))
        if not ANCHOR_WAV or not os.path.isfile(ANCHOR_WAV):
            raise RuntimeError("ANCHOR_MISSING: " + str(ANCHOR_WAV))
        device = _pick_device()
        if device == "cpu":
            # 这个后端是为 CUDA graph 设计的；CPU 会非常慢，明确失败，让宿主回退旧引擎/文本。
            raise RuntimeError("CUDA_NOT_AVAILABLE: faster-qwen3-tts 快速后端需要 NVIDIA CUDA")
        from faster_qwen3_tts import FasterQwen3TTS
        print("[qwen3tts-fast] 加载 %s (device=%s)…" % (os.path.basename(MODEL_DIR), device), flush=True)
        t0 = time.time()
        _model = FasterQwen3TTS.from_pretrained(
            MODEL_DIR, device=device, dtype=torch.bfloat16, attn_implementation="eager", max_seq_len=2048
        )
        print("[qwen3tts-fast] 模型就绪 %.1fs" % (time.time() - t0), flush=True)
        return _model


def _clean(text):
    text = str(text or "").strip().translate(QUOTE_CHARS)
    text = re.sub(r'[\(（][^)）]{0,200}[\)）]', '', text).strip()
    return text


def _clauses(text, single_max=90):
    text = text.strip()
    if len(text) <= single_max:
        return [text]
    parts = [c.strip() for c in CLAUSE_RE.findall(text) if len(c.strip()) >= 2]
    if not parts:
        parts = [text]
    out, buf = [], ""
    for p in parts:
        if len(buf) + len(p) <= single_max:
            buf += p
        else:
            if buf:
                out.append(buf)
            buf = p
    if buf:
        out.append(buf)
    return out


def _gen_one(model, text):
    # xvec_only=True 是当前更快、更稳的路径；ICL 在 faster wrapper 里会失控长音频，不启用。
    wavs, sr = model.generate_voice_clone(
        text=text,
        language="Chinese",
        ref_audio=ANCHOR_WAV,
        ref_text=ANCHOR_TEXT,
        max_new_tokens=min(2048, max(200, len(text) * 8)),
        temperature=0.9,
        top_k=50,
        do_sample=True,
        repetition_penalty=1.05,
        xvec_only=True,
    )
    w = wavs[0] if isinstance(wavs, list) else wavs
    return np.asarray(w, dtype=np.float32), int(sr)


def _is_cancelled(snap):
    with _jobs_lock:
        return snap[0] < _cancel_epoch or snap[1] in _cancelled_jobs


def _synthesize(text, job_id):
    with _synth_lock:
        model = load_model()
        chunks = _clauses(text)
        parts, sr = [], 24000
        for idx, c in enumerate(chunks):
            if _is_cancelled((_cancel_epoch, job_id)):
                return None, 410
            t0 = time.time()
            with torch.inference_mode():
                torch.manual_seed(42)
                np.random.seed(42)
                w, sr = _gen_one(model, c)
            parts.append(w)
            print("[qwen3tts-fast] job=%s clause %d/%d %.2fs (%.1f字)" % (
                job_id, idx + 1, len(chunks), time.time() - t0, len(c)), flush=True)
        if not parts:
            return None, 400
        # r170b: 句间停顿按标点分档，不用一刀切的 0.15s。
        # 一句话里"逗号顿一下、句号松一口气"，起伏就是这么来的——引擎不给我们，我们自己给。
        audio = parts[0]
        for i, w in enumerate(parts[1:], start=1):
            prev = parts[i - 1].rstrip()
            tag = prev[-1:] if prev else ''
            sec = {'。': 0.30, '！': 0.28, '？': 0.32, '；': 0.26, '，': 0.18, '、': 0.12}.get(tag, 0.16)
            audio = np.concatenate([audio, np.zeros(int(sr * sec), dtype=np.float32), w])
        return _warm(audio, sr), sr


# ---- r170 暖化后处理 ----
# 为什么改在这里：本机实际跑的是 qwen3tts 引擎，它在 _gen_one 里把
# temperature/top_k/seed(42) 全写死，请求体里的 temperature/speed_factor/fragment_interval
# 一律不读（实测：换任何参数，返回字节的 md5 完全一致）。所以改 tts-config.js 的参数
# 在这台机器上是空转——"太清冷"的真因不在参数，在输出音频本身。
# 这里做的是确定性的后处理：
#   1) 放慢 6%（音高随之略降 6%：实测 F0 中位 308Hz -> 289Hz，同一句话少了"尖")
#   2) 句尾补 0.25s 的呼吸留白（说完不马上掐断，是"暖"最直接的来源）
#   3) 最后 120ms 淡出，避免爆音
WARM_SPEED = 0.94
WARM_TAIL = 0.25
WARM_FADE = 0.12


def _warm(audio, sr):
    if audio is None or len(audio) == 0:
        return audio
    try:
        n = len(audio)
        target = max(1, int(n / WARM_SPEED))
        idx = np.linspace(0, n - 1, target)
        out = np.interp(idx, np.arange(n), audio).astype(np.float32)
        out = np.concatenate([out, np.zeros(int(sr * WARM_TAIL), dtype=np.float32)])
        fade = min(len(out), int(sr * WARM_FADE))
        if fade > 1:
            out[-fade:] *= np.linspace(1.0, 0.0, fade).astype(np.float32)
        peak = float(np.abs(out).max())
        if peak > 0.99:
            out *= (0.99 / peak)
        return out
    except Exception as e:
        print("[qwen3tts-fast] 暖化后处理失败, 原样返回: %s" % str(e)[:120], flush=True)
        return audio


@app.post("/warm")
async def warm():
    """加载模型 + 做一次最短合成，提前完成 CUDA graph 捕获。
    第136轮：这 20 秒必须发生在用户开口之前；tts-voice.js 会显示小字“正常”。"""
    global _last_use
    _last_use = time.time()
    _arm_idle_stop()
    t0 = time.time()
    try:
        audio, sr = await asyncio.to_thread(_synthesize, "嗯。", "warm-" + uuid.uuid4().hex[:8])
        if audio is None:
            return _err(500, "WARM_FAILED")
        print("[qwen3tts-fast] 预热完成 %.1fs" % (time.time() - t0), flush=True)
        return Response(
            content=json.dumps({"ok": True, "warm": True, "sec": round(time.time() - t0, 1)},
                               ensure_ascii=False).encode("utf-8"),
            media_type="application/json",
        )
    except Exception as e:
        print("[qwen3tts-fast] 预热失败: %s" % str(e)[:200], flush=True)
        return _err(500, str(e)[:200])


@app.post("/tts")
async def tts(request: Request):
    global _last_use
    _last_use = time.time()
    _arm_idle_stop()
    try:
        body = await request.json()
    except Exception:
        return _err(400, "BAD_JSON")
    text = _clean(body.get("text"))
    if not text:
        return _err(400, "EMPTY_TEXT")
    job_id = str(body.get("job_id") or "").strip() or uuid.uuid4().hex[:12]
    with _jobs_lock:
        _active_jobs[job_id] = {"state": "running", "started": time.time()}
    t0 = time.time()
    try:
        audio, sr = await asyncio.to_thread(_synthesize, text, job_id)
        if audio is None:
            return Response(
                content=json.dumps({"error": "CANCELLED", "job_id": job_id}, ensure_ascii=False).encode("utf-8"),
                status_code=410, media_type="application/json", headers={"X-Tts-Job-Id": job_id},
            )
        buf = io.BytesIO()
        sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
        print("[qwen3tts-fast] job=%s %d字 %.2fs audio=%.2fs" % (
            job_id, len(text), time.time() - t0, audio.size / sr), flush=True)
        return Response(content=buf.getvalue(), media_type="audio/wav", headers={"X-Tts-Job-Id": job_id})
    except Exception as e:
        print("[qwen3tts-fast] job=%s ERROR %s" % (job_id, str(e)[:200]), flush=True)
        return _err(500, str(e)[:200])
    finally:
        with _jobs_lock:
            _active_jobs.pop(job_id, None)
            _cancelled_jobs.discard(job_id)


@app.post("/cancel")
async def cancel(request: Request):
    global _cancel_epoch
    try:
        body = await request.json()
    except Exception:
        body = {}
    job_id = str(body.get("job_id") or "").strip()
    do_all = bool(body.get("all") or body.get("cancel_all") or body.get("cancelAll"))
    with _jobs_lock:
        if do_all:
            _cancel_epoch += 1
            cancelled = sorted(_active_jobs.keys())
            _cancelled_jobs.update(cancelled)
        elif job_id and job_id in _active_jobs:
            _cancelled_jobs.add(job_id)
            cancelled = [job_id]
        else:
            cancelled = []
    return Response(
        content=json.dumps({"cancelled": cancelled, "epoch": _cancel_epoch}, ensure_ascii=False).encode("utf-8"),
        media_type="application/json",
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=DEFAULT_PORT)
    args = ap.parse_args()
    try:
        import psutil
        psutil.Process(os.getpid()).nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        print("[qwen3tts-fast] 进程优先级 BELOW_NORMAL", flush=True)
    except Exception:
        pass
    print("[qwen3tts-fast] 模型=%s 锚=%s 线程=%d" % (MODEL_DIR, ANCHOR_WAV, THREADS), flush=True)
    _arm_idle_stop()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
