# -*- coding: utf-8 -*-
"""
玥玥语音合成服务 · IndexTTS-2.5(种子抽卡模式, 9880 端口)
========================================================================
阶段2 TTS 双引擎替换(2026-09 · agent-teams yueyue-integration · 任务 t5):
- 由 tts-server.js 的 indextts 分支拉起(YUEYUE_TTS_ENGINE=indextts; 默认仍走 GPT-SoVITS)。
- 请求/响应契约与 GPT-SoVITS api_v2.py 逐字段兼容(main.js tts:speak 的 POST /tts
  请求体 + WAV 字节响应 + 音质质检 checkWav), tts-voice.js / voice-input.js 零改动。
- 独立部署: 运行在 index-tts 仓库自带 .venv(或 INDEX_TTS_PY 指定 python),
  **不依赖 GPT-SoVITS 目录**(拍板决策 1; 集成方案 14 §3 / 部署文档 15 §2)。

已锁定决策: 只走种子抽卡(seed 定音色), 参考音克隆/文字捏音不在本服务范围。

环境变量(tts-server.js indextts 分支会透传, 也可手动设置):
- INDEX_TTS_MODEL_DIR : checkpoints 目录(默认 <cwd>/checkpoints)
- INDEX_TTS_CFG       : config.yaml 路径(默认 <model_dir>/config.yaml)
- YUEYUE_TTS_SEED     : 种子号(优先级最高; 其次服务目录 seed.txt; 最后默认 8861 占位)
- YUEYUE_TTS_DEVICE   : cuda/cpu/auto(默认 auto=有 CUDA 用 CUDA; AMD 走 ZLUDA/ROCm 时 torch.cuda.is_available() 为 True)
- HF_ENDPOINT         : HuggingFace 镜像(tts-server.js 已自动注入 https://hf-mirror.com)

种子占位说明: 8861 只是社区参考号, **必须按 10a/16-testcases 表 C 在最终部署的
RX 7800 XT + 固定库版本上抽卡后替换**(社区种子跨机不稳定, 不可直接搬用)。
替换方式: 设 YUEYUE_TTS_SEED 环境变量, 或在本文件同目录写 seed.txt(内容为纯数字)。

参数映射(GPT-SoVITS 形状 -> IndexTTS-2.5, 详见 14 §3.2; Node 层 tts-server.js
的 buildIndexTtsRequest 会先换算一遍, 本服务对"已换算"与"原始形状"都兼容):
- params.speed_factor  -> duration_factor = clamp(1/speed_factor, 0.5, 2.0)(取倒数: 值越小越慢 -> 值越大越慢)
- temperature          -> temperature 直通
- repetition_penalty   -> repetition_penalty 直通(默认 1.2)
- params.fragment_interval -> 句间静音(秒), 合成后按句末标点切分、逐句同 seed 合成并插入静音
- params.sample_steps  -> infer_mode/sampling_steps 档位(<=8 fast / <=16 medium / 其余 slow 25 步)
- ref_audio_path       -> spk_audio_prompt(种子模式仅作附加音色锚, 2.5 支持时透传, 不支持自动降级)
- top_k/top_p/text_split_method/batch_size -> IndexTTS 2.5 无对应参数, 静默忽略
- 请求体 seed 字段       -> 忽略(音色稳定性: 种子固定由配置决定, 不进随机重试)

错误码对齐(GPT-SoVITS api_v2 风格, main.js 解析 d.error||d.message||d.Exception):
- 空文本 -> HTTP 400 {"ok":false,"error":"EMPTY_TEXT"}
- 合成/加载异常 -> HTTP 500 {"ok":false,"error":str(e),"message":str(e)}
- 服务起不来/端口不通 -> JS 侧 ensure() 失败 -> {ok:false,error:'TTS_SERVICE_MISSING'}

架构要点:
- 懒加载: /docs 秒级就绪(供 JS isTtsUp 探活), IndexTTS 权重加载推迟到首次 /tts
  (main.js 启动预热 warmUpTts 会触发, 消除用户首句冷启动);
- 空闲 15 分钟自动退出(与 ASR 一致, JS 侧无空闲自停——TTS 常驻预热);
- 推理串行锁: ROCm/ZLUDA 单进程串行推理, 防并发打爆显存(14 §7.6 建议);
- AMD 全精度铁律: use_fp16=False / use_bf16=False(与 is_half:false 同源, 防电音)。
"""
import argparse
import asyncio
import io
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import wave

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response
import uvicorn

APP = FastAPI()
LAST_ACTIVE = time.time()
IDLE_LIMIT = 900  # 15 分钟空闲自退

# ---------- 路径与种子配置 ----------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("INDEX_TTS_MODEL_DIR") or os.path.join(os.getcwd(), "checkpoints")
CFG_PATH = os.environ.get("INDEX_TTS_CFG") or os.path.join(MODEL_DIR, "config.yaml")
DEVICE_ENV = os.environ.get("YUEYUE_TTS_DEVICE", "auto").lower()

# 种子读取: YUEYUE_TTS_SEED > 脚本目录 seed.txt > 工作目录 seed.txt > 8861 占位
def _read_seed():
    env = os.environ.get("YUEYUE_TTS_SEED")
    if env:
        try:
            return int(str(env).strip())
        except ValueError:
            pass
    for base in (SCRIPT_DIR, os.getcwd()):
        p = os.path.join(base, "seed.txt")
        try:
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as f:
                    v = f.read().strip()
                if v:
                    return int(v)
        except Exception:
            pass
    return 8861  # 占位: 等用户按 16 表 C 抽卡后替换

SEED = _read_seed()

# ---------- 懒加载状态 ----------
_tts = None
_tts_lock = threading.Lock()
_infer_lock = threading.Lock()  # 推理串行: 防并发打爆显存/内核
_tts_ready = False
_DEVICE = None

# 句末切分(带标点), 用于 fragment_interval 句间静音
_SENT_SPLIT = re.compile(r"[^。！？!?…~；;\n]+[。！？!?…~；;\n]*")


def get_tts():
    """懒加载 IndexTTS2: 首次 /tts 才 import torch/indextts + 加载权重(秒级服务启动)"""
    global _tts, _tts_ready, _DEVICE
    if _tts is not None:
        return _tts
    with _tts_lock:
        if _tts is not None:
            return _tts
        import torch
        import importlib
        if DEVICE_ENV == "cuda":
            _DEVICE = "cuda"
        elif DEVICE_ENV == "cpu":
            _DEVICE = "cpu"
        else:
            _DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
        print("加载 IndexTTS-2.5 模型: model_dir=" + MODEL_DIR + " cfg=" + CFG_PATH + " device=" + _DEVICE + " seed=" + str(SEED), flush=True)
        # 2.5 官方导入路径 indextts.infer_v2_5; 兼容回退(16-testcases 表 C-0 核验项)
        IndexTTS2 = None
        for mod in ("indextts.infer_v2_5", "indextts", "indextts.infer_v2"):
            try:
                IndexTTS2 = getattr(importlib.import_module(mod), "IndexTTS2", None)
                if IndexTTS2 is not None:
                    break
            except ImportError:
                continue
        if IndexTTS2 is None:
            raise RuntimeError("IndexTTS 未安装或导入路径不兼容(需在 index-tts 仓库 venv 内运行; 参见 15-deployment §2)")
        # AMD 全精度铁律: 依次尝试 use_bf16(2.5)/use_fp16(2)/无参
        _tts = None
        for kwargs in ({"use_bf16": False}, {"use_fp16": False}, {}):
            try:
                _tts = IndexTTS2(cfg_path=CFG_PATH, model_dir=MODEL_DIR, **kwargs)
                break
            except TypeError:
                continue
        if _tts is None:
            raise RuntimeError("IndexTTS2 初始化失败(cfg_path/model_dir 检查: " + CFG_PATH + ")")
        _tts_ready = True
        print("IndexTTS 就绪 (device=" + _DEVICE + " seed=" + str(SEED) + ")", flush=True)
        return _tts


def _infer_segment(tts, text, spk_audio_path, duration_factor, temperature, repetition_penalty, infer_mode, sampling_steps):
    """单句推理: 先按完整参数调用, TypeError 时自动降级(兼容 IndexTTS 2 / 2.5 签名差异)"""
    base = dict(
        text=text,
        seed=SEED,
        infer_mode=infer_mode,
        sampling_steps=sampling_steps,
        temperature=temperature,
        repetition_penalty=repetition_penalty,
    )
    attempts = []
    kw1 = dict(base)
    kw1["cfg_scale"] = 2
    kw1["stop_repetition"] = True
    kw1["duration_factor"] = duration_factor
    if spk_audio_path:
        kw1["spk_audio_prompt"] = spk_audio_path
    attempts.append(kw1)
    kw2 = dict(base)
    kw2["duration_factor"] = duration_factor
    attempts.append(kw2)
    attempts.append(base)  # 最小集兜底
    last_err = None
    for kw in attempts:
        try:
            return tts.infer(**kw)
        except TypeError as e:
            last_err = e
            continue
    raise last_err if last_err else RuntimeError("infer 调用失败")


def _wav_bytes_for(samples, sr):
    """numpy 数组 -> PCM16 WAV 字节"""
    import numpy as np
    a = np.asarray(samples)
    if a.ndim > 1:
        a = a.squeeze()
    if a.ndim != 1:
        raise RuntimeError("IndexTTS 输出维度异常: " + str(a.shape))
    a = np.clip(a, -1.0, 1.0)
    pcm = (a * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _do_synthesize(data):
    """线程内执行: 懒加载 + 切句合成 + 句间静音 + WAV 编码"""
    import numpy as np
    text = str(data.get("text") or "").strip()
    if not text:
        return None, "EMPTY_TEXT"
    tts = get_tts()
    params = data.get("params") or {}
    # 参数解析: Node 换算后的字段优先, 否则按 GPT-SoVITS 原始形状自行换算(14 §3.2)
    speed = params.get("speed_factor")
    speed = speed if isinstance(speed, (int, float)) and speed > 0 else 0.9
    duration = data.get("duration_factor")
    if duration is None:
        duration = max(0.5, min(2.0, 1.0 / float(speed)))  # speed_factor -> duration_factor 取倒数
    temperature = data.get("temperature")
    if temperature is None:
        temperature = params.get("temperature")
    temperature = float(temperature) if isinstance(temperature, (int, float)) else 0.9
    rep_pen = data.get("repetition_penalty")
    if rep_pen is None:
        rep_pen = params.get("repetition_penalty", 1.2)
    rep_pen = float(rep_pen)
    frag = data.get("fragment_interval")
    if frag is None:
        frag = params.get("fragment_interval", 0.0)
    frag = float(frag)
    infer_mode = data.get("infer_mode") or "slow"
    steps = data.get("sampling_steps")
    if steps is None:
        s = params.get("sample_steps", 25)
        try:
            s = int(s)
        except Exception:
            s = 25
        if s <= 8:
            infer_mode, steps = "fast", 10
        elif s <= 16:
            infer_mode, steps = "medium", 16
        else:
            infer_mode, steps = "slow", 25
    spk = data.get("spk_audio_path") or data.get("ref_audio_path") or ""
    sr = 24000
    with _infer_lock:  # 推理串行(ROCm/ZLUDA 单进程)
        # 按句末标点切分(等价 text_split_method 效果), 逐句同 seed 合成保音色一致
        segments = [s for s in _SENT_SPLIT.findall(text) if s and s.strip()]
        if not segments:
            segments = [text]
        wavs = []
        for seg in segments:
            res = _infer_segment(tts, seg, spk, duration, temperature, rep_pen, infer_mode, steps)
            if isinstance(res, tuple) and len(res) == 2:
                # 个别版本 infer 返回 (wav, sr) 二元组
                w, sr = res[0], int(res[1])
            else:
                w = res
            w = np.asarray(w).squeeze()
            if w.ndim != 1:
                w = w.reshape(-1)
            wavs.append(w)
        # 句间静音(fragment_interval, 与 GPT-SoVITS 语义一致)
        if frag > 0 and len(wavs) > 1:
            gap = np.zeros(int(sr * frag), dtype=wavs[0].dtype)
            parts = []
            for i, w in enumerate(wavs):
                parts.append(w)
                if i < len(wavs) - 1:
                    parts.append(gap)
            merged = np.concatenate(parts)
        else:
            merged = wavs[0] if len(wavs) == 1 else np.concatenate(wavs)
    return _wav_bytes_for(merged, sr), None


@APP.get("/health")
def health():
    return {"status": "ok", "engine": "indextts", "model_dir": MODEL_DIR, "cfg": CFG_PATH,
            "seed": SEED, "ready": _tts_ready}


@APP.post("/tts")
async def tts_endpoint(request: Request):
    """POST JSON(GPT-SoVITS api_v2 同形) -> WAV 字节; 失败 -> {"ok":false,"error":...}"""
    global LAST_ACTIVE
    LAST_ACTIVE = time.time()
    try:
        data = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"ok": False, "error": "bad json body"})
    try:
        wav_bytes, empty_err = await asyncio.to_thread(_do_synthesize, data)
        if empty_err:
            return JSONResponse(status_code=400, content={"ok": False, "error": empty_err, "message": empty_err})
        return Response(content=wav_bytes, media_type="application/octet-stream")
    except Exception as e:
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e), "message": str(e)})


def idle_watchdog():
    """空闲 15 分钟自动退出(与 ASR 一致; 应用按需再拉起)"""
    while True:
        time.sleep(30)
        if time.time() - LAST_ACTIVE > IDLE_LIMIT:
            print("空闲超时, TTS 服务退出", flush=True)
            os._exit(0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", "--port", type=int, default=9880)
    args = parser.parse_args()
    import threading as _t
    _t.Thread(target=idle_watchdog, daemon=True).start()
    uvicorn.run(APP, host="127.0.0.1", port=args.port, log_level="warning")
