# -*- coding: utf-8 -*-
"""
玥玥语音识别服务 · SenseVoice-Small (FunASR, CPU 模式, 9890 端口)
========================================================================
阶段1 双引擎 ASR 替换(2026-09 · agent-teams yueyue-integration · 任务 t4):
- 本文件与 whisper 版 stt_server.py 契约完全对齐(见文件末尾"与 whisper 版对齐点"),
  由 stt-server.js 的 sensevoice 分支拉起(YUEYUE_STT_ENGINE=sensevoice)。
- 独立部署: 运行在独立 venv(G:\YueyueAI\venv-asr 或 STT_SENSEVOICE_DIR 指定),
  **不依赖 GPT-SoVITS 目录**(拍板决策 2; 集成方案 14 §2.2 / 部署文档 15 §3)。

部署前置(用户在真机执行一次, 详见 15-deployment §3):
  python -m venv G:\YueyueAI\venv-asr
  G:\YueyueAI\venv-asr\Scripts\python.exe -m pip install -U pip
  G:\YueyueAI\venv-asr\Scripts\pip install funasr modelscope torch torchaudio

模型下载(首次转写时自动下载, SenseVoice-Small 约 900MB):
- 默认走 ModelScope: model="iic/SenseVoiceSmall"(国内直连)
- 走 HuggingFace 镜像: 设环境变量 YUEYUE_STT_MODEL="FunAudioLLM/SenseVoiceSmall"
  并设 HF_ENDPOINT=https://hf-mirror.com (stt-server.js 已自动注入该变量, huggingface_hub 原生读取)

架构要点:
- 懒加载: 服务秒级起(供 /docs 探活), funasr import + 权重加载推迟到首次 /transcribe;
  stt-server.js 在服务就绪后会用一段静音 WAV 后台预热一次, 避免用户首句等模型加载。
- CPU 推理: 强制 CUDA_VISIBLE_DEVICES=""(与 whisper 版同铁律, 不与 TTS 争 GPU);
  SenseVoice 非自回归, CPU 数十倍实时, 稳态句级延迟 <1s。
- 空闲 15 分钟自动退出(idle_watchdog), 与 JS 侧 15 分钟自停双保险; 应用按需重启。
- 输出清洗: SenseVoice 原文本带 <|zh|><|HAPPY|><|Speech|><|withitn|> 前缀 token
  与行内事件 token(<|laughter|> 等), 统一清洗为可读文本 + 可选 emotion 字段。

错误码对齐(与 whisper 版 stt_server.py 一致, JS 侧 stt-server.js 解析):
- 空音频 -> HTTP 400 {"message": "empty audio"}
- 推理/加载异常 -> HTTP 500 {"message": str(e)}
- 服务完全起不来/端口不通 -> JS 侧 ensure() 失败 -> {ok:false, error:'STT_SERVICE_MISSING'}
"""
import os
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")  # 强制 CPU, 不与 TTS 争 GPU(与 whisper 版同铁律)

import argparse
import asyncio
import io
import re
import sys
import tempfile
import threading
import time
import traceback
import wave

# Windows 控制台 GBK 防炸(emoji/特殊字符), 与 JS 侧 PYTHONIOENCODING/PYTHONUTF8 双保险
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

# 模型 id: 默认 ModelScope 版; 设 YUEYUE_STT_MODEL 可切 HF 版(配合 HF_ENDPOINT 镜像)
MODEL_ID = os.environ.get("YUEYUE_STT_MODEL", "iic/SenseVoiceSmall")
# 识别语言: 默认 auto(SenseVoice 自动检测); 中文为主可设 YUEYUE_STT_LANG=zh
# (合成音/特殊声线偶发误判为其他语言, 真机如遇此问题再设)
LANG = os.environ.get("YUEYUE_STT_LANG", "auto")

APP = FastAPI()
LAST_ACTIVE = time.time()
IDLE_LIMIT = 300  # 5 分钟空闲自退(2026-09-10 内存优化: 语音服务常驻挤占内存, 与 qwen3tts 对齐)

# ---- 懒加载状态 ----
_model = None                 # funasr AutoModel 实例
_model_lock = threading.Lock()  # 防止并发首请求重复加载
_model_ready = False          # /health 就绪状态

# SenseVoice 行内事件 token -> 可读文本(11-asr §6.4 落地技巧)
_EVENT_MAP = {
    "laughter": "（笑）",
    "applause": "（鼓掌）",
    "cough": "（咳嗽）",
    "music": "（音乐）",
    "sneeze": "（喷嚏）",
    "breath": "（呼吸）",
}
_TAG_RE = re.compile(r"<\|([^|]*)\|>")
# SenseVoice 前缀第 2 个 token 是情绪标签
_EMOTION_TAGS = ("HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARFUL", "DISGUSTED", "SURPRISED")


def clean_sensevoice_text(raw):
    """<|zh|><|HAPPY|><|Speech|><|withitn|>今天天气不错<|laughter|> -> 今天天气不错（笑） + emotion"""
    if not raw:
        return "", None
    tags = _TAG_RE.findall(raw)
    emotion = None
    if len(tags) >= 2 and tags[1].upper() in _EMOTION_TAGS:
        emotion = tags[1].upper()
    # 前缀元信息 token(语言/情绪/任务/解码模式)全部剔除; 行内事件 token 映射为可读文本
    text = _TAG_RE.sub(
        lambda m: _EVENT_MAP.get(m.group(1).lower(), ""),
        raw,
    )
    text = re.sub(r"\s+", " ", text).strip()
    return text, emotion


def get_model():
    """懒加载: 首次转写才 import funasr + 下载/加载权重(服务秒级启动, 慢加载留给后台预热)"""
    global _model, _model_ready
    if _model is not None:
        return _model
    with _model_lock:
        if _model is not None:
            return _model
        from funasr import AutoModel  # 延迟 import: 依赖缺失只影响首次转写, 不阻塞服务启动
        print("加载 SenseVoice 模型:", MODEL_ID, flush=True)
        _model = AutoModel(
            model=MODEL_ID,
            device="cpu",
            disable_update=True,
            disable_pbar=True,
        )
        _model_ready = True
        print("SenseVoice 就绪", flush=True)
        return _model


def _do_transcribe(data: bytes):
    """线程内执行: 懒加载 + 临时文件转写 + 清洗(坏数据抛错 -> 500, 与 whisper 版 decode_wav 同职责)"""
    # 校验 WAV 可读(RIFF/WAVE 头), 坏数据在此抛 wave.Error
    with wave.open(io.BytesIO(data), "rb") as wf:
        wf.getframerate()
        wf.getnframes()
    model = get_model()
    # funasr 走文件路径输入最稳(内部按需重采样)
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".wav")
    try:
        tmp.write(data)
        tmp.close()
        res = model.generate(input=tmp.name, cache={}, language=LANG, use_itn=True)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
    raw = ""
    if isinstance(res, list) and res and isinstance(res[0], dict):
        raw = res[0].get("text", "") or ""
    text, emotion = clean_sensevoice_text(raw)
    return {"text": text, "emotion": emotion or "NEUTRAL"}


@APP.get("/health")
def health():
    """健康检查(供 JS 侧/人工探活; FastAPI 自带 /docs 亦可)"""
    return {"status": "ok", "engine": "sensevoice", "model": MODEL_ID, "ready": _model_ready}


@APP.post("/transcribe")
async def transcribe(request: Request):
    """POST application/octet-stream WAV 字节 -> {"text", "emotion"}(契约与 whisper 版一致)"""
    global LAST_ACTIVE
    LAST_ACTIVE = time.time()
    data = await request.body()
    if not data or len(data) < 100:
        return JSONResponse(status_code=400, content={"message": "empty audio"})
    try:
        result = await asyncio.to_thread(_do_transcribe, data)
        return JSONResponse(status_code=200, content=result)
    except Exception as e:
        # 排障友好: 全量 traceback 进 stderr(JS 侧忽略, 手动运行/日志可见), 响应只回简短 message
        traceback.print_exc()
        return JSONResponse(status_code=500, content={"message": str(e)})


def idle_watchdog():
    """空闲 15 分钟自动退出(与 whisper 版一致; 应用按需再拉起)"""
    while True:
        time.sleep(30)
        if time.time() - LAST_ACTIVE > IDLE_LIMIT:
            print("空闲超时, STT 服务退出", flush=True)
            os._exit(0)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", "--port", type=int, default=9890)
    args = parser.parse_args()
    import threading as _t
    _t.Thread(target=idle_watchdog, daemon=True).start()
    uvicorn.run(APP, host="127.0.0.1", port=args.port, log_level="warning")
