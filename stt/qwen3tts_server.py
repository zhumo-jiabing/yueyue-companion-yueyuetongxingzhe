# -*- coding: utf-8 -*-
"""
玥玥 TTS 服务 —— Qwen3-TTS-1.7B(现役=Base + voice-clone 锚定 anchor-yueyue-sovits.wav)
由 resources\app\tts-server.js 在 YUEYUE_TTS_ENGINE=qwen3tts 时拉起(端口 9880, 可 -p 覆盖)。

契约(与 main.js tts:speak 逐字段兼容; 2026-09-12 改造后对老客户端完全向后兼容):
  GET  /docs   -> FastAPI 文档页(tts-server.js isTtsUp 健康探测用)
  POST /tts    body: {"text": "...", "mood": "gentle"(可选), "job_id": "abc"(可选, 缺省服务端生成)}
               -> 200 audio/wav(PCM16), 响应头 X-Tts-Job-Id 回传本次 job
               -> 410 {"error":"CANCELLED","job_id":...}  请求已被取消(排队中直接出队 / 合成中句间打断)
  POST /cancel body: {"job_id": "abc"} 单点取消, 或 {"all": true} 全部取消(客户端打断时用)
               -> 200 {"cancelled": [...], "epoch": n}

  2026-09-12 改造1(可取消)的硬边界: torch 的**当前句**无法抢占(单句 ~40-70s)。
  取消后: 客户端**立即**收到 410; 后台线程跑完当前句、在下一句边界退出(不再有下一句);
  合成信号量在"当前句结束"时释放 —— 下一个请求最多等 1 句, 而不是旧版的整条消息(实测 ~300s)。

可调环境变量(改造3):
  QWEN3TTS_TORCH_THREADS  torch/OMP/MKL/OpenBLAS 线程数(默认 cores-4 且上限 8; 20 逻辑核机器 → 8)
  QWEN3TTS_PRIORITY       below_normal(默认, 进程自降优先级) / normal(不降)
  QWEN3TTS_MERGE_SHORT    短句合并阈值(默认 16; <N 字的 clause 并入后一句, 改造2; 第93轮实测定档)
  QWEN3TTS_MERGE_MAX      合并后单句长度上限(默认 120 字)
  QWEN3TTS_MODEL_DIR / QWEN3TTS_MODEL_DIR_BASE / QWEN3TTS_ANCHOR_WAV / QWEN3TTS_SEED  原有
  QWEN3TTS_ANCHOR_TEXT    锚定音频对应的文本(默认读 <锚定wav>.txt; 有文本 → ICL 模式, 无 → x_vector_only)

空闲 30 分钟自动退出(模型常驻 ~6.6GB; 由 tts-server.js 重新拉起, 冷启动约 30-60s; YUEYUE_TTS_IDLE_STOP_SEC 可配)。
"""
import argparse
import io
import json
import os
import random
import re
import threading
import time
import uuid

# ============ 改造3(前置): 线程默认值必须在 import numpy/torch 之前落进环境 ============
# OMP/MKL/OpenBLAS 线程池在首次 import 时初始化, import 之后再改 os.environ 不生效。
# 2026-09-12 主 agent 复核修正: 初版默认 cores-4/上限 8 → 探针实测速度掉到 0.61-0.66 字/秒
# (12 线程基线 0.9-1.4), 等于用"用户最痛的慢"去换"不抢前台"。但**不抢前台的主要手段其实是进程优先级**
# (BELOW_NORMAL: 前台程序要 CPU 时系统会先让路, 空闲时合成仍能吃满核心), 砍线程是钝器、直接掉速。
# 故默认回到物理核(超线程对 GEMM 收益低且更抢内存带宽): 物理核, 上限 12, 下限 4。
# 想让机器更"轻"的用户可设 QWEN3TTS_TORCH_THREADS=6~8(tts-server.js 已透传)。
def _default_torch_threads():
    cores = os.cpu_count() or 8
    try:
        import psutil  # 依赖里已有(7.2.2)
        phys = psutil.cpu_count(logical=False) or 0
        if phys > 0:
            cores = phys
    except Exception:
        cores = max(1, cores // 2)
    return max(4, min(cores, 12))

# 第98轮 S2-P2-2: 环境变量写错(如 QWEN3TTS_MERGE_SHORT=abc)会让 int() 在**导入期**抛 ValueError,
# 整个服务起不来——而用户看到的只是"语音没声音", 排查成本极高。统一走安全解析: 解析失败就回落默认值。
def _env_int(name, default):
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return int(default)
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        print("[qwen3tts] 环境变量 %s=%r 不是整数, 按默认值 %s 处理" % (name, raw, default), flush=True)
        return int(default)

THREADS = _env_int("QWEN3TTS_TORCH_THREADS", _default_torch_threads())
for _name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ.setdefault(_name, str(THREADS))

import asyncio
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

# 2026-09-11 防卡死: 实测部分文本会让模型永久挂起(如 装着"期待"，所有的期待 / 颜文字),
# 表现为"20 分钟没声音"——服务器卡死后所有请求排队超时。修复: 文本消毒 + 生成长度上限 + 看门狗自杀。
QUOTE_CHARS = str.maketrans({'\u201c': '', '\u201d': '', '\u2018': '', '\u2019': '', '"': '', "'": ''})
# 2026-09-11 深夜: clone 模式单句合成实测 43-48s, 60s 看门狗过紧 → 误杀自杀(连接被关=用户听不到)。
# 放宽到 150s: 真挂死是"永久无进度", 150s 仍能可靠区分; progress['t'] 每句完成刷新, 长句合法慢不再误杀。
CLAUSE_STALL_S = 150
MAX_NEW_TOKENS = 200          # 短句预算下限(防重复文本触发生成循环); 长合并句按字数放大(见 _tokens_for)
MAX_TOKEN_CAP = 1500          # 比例上限(12Hz 下 1500 token ≈ 125s 音频, 150s 看门狗仍兜底真挂死)
# 2026-09-12 改造2: 拟声词不孤立 —— 短 clause(如客户端补的"……嗯，"被切成孤立的"嗯，")与其后句合并。
# 第93轮: 8 → 16。<16 字的 clause 并入后一句。实测依据(_r93-audit/voiceid*.log):
# 3-8 字独立合成时 F0 中位极差 148-187 Hz(≈一个八度, 听感=换人); 18-34 字一段降到 32-63 Hz。
MERGE_SHORT = _env_int("QWEN3TTS_MERGE_SHORT", 16)
# 第93轮: 短请求整段单次生成。实测 63 字整段=14.0 s 音频(0.222 s/字, 与 44 字样本 0.225 一致),
# 没有触发旧注释里"30 字仅出 1.28 s"的提前截断 —— max_new_tokens 已按字数放大。整段一次出
# = 段内零边界, 是「前后短句不换人」最彻底的做法; 只有超长文本才回退到逐句合并。
SINGLE_MAX = _env_int("QWEN3TTS_SINGLE_MAX", 90)  # 第97轮 P1-4: 80→90, 对齐客户端 ≤90 整段保证
MERGE_MAX = _env_int("QWEN3TTS_MERGE_MAX", 120)
# 2026-09-12 改造3: 服务进程自降优先级(用户反馈"CPU 占用明显特别多, 所有应用都卡顿")。
PRIORITY = os.environ.get("QWEN3TTS_PRIORITY", "below_normal").lower()
_synth_sem = asyncio.Semaphore(1)  # 合成串行化: 防 RNG 互踩 + 防并发请求堆积

DEFAULT_PORT = 9880
MODEL_DIR_DESIGN = os.environ.get("QWEN3TTS_MODEL_DIR", r"G:\YueyueAI\qwen3-models\Qwen3-TTS-12Hz-1.7B-VoiceDesign")
MODEL_DIR_BASE = os.environ.get("QWEN3TTS_MODEL_DIR_BASE", r"G:\YueyueAI\qwen3-models\Qwen3-TTS-12Hz-1.7B-Base")
# 第90轮: 音色基础 = 本机 A 卡训练音色。锚定句由 SoVITS(训练音色) 合成后落在模型根目录,
# 优先用它; 缺失时回退旧 anchor-loli.wav(兼容旧部署/一键回滚)。
_ANCHOR_TRAINED = os.path.join(os.path.dirname(MODEL_DIR_BASE), "anchor-yueyue-sovits.wav")
ANCHOR_WAV = os.environ.get(
    "QWEN3TTS_ANCHOR_WAV",
    _ANCHOR_TRAINED if os.path.isfile(_ANCHOR_TRAINED) else r"G:\YueyueAI\qwen3-models\anchor-loli.wav",
)
# 2026-09-11 深夜 声线一致性根治(用户反馈"前后小句人格不一致, 声音不像一个人"):
# 根因 = VoiceDesign 的音色是按 instruct 文字即兴捏的, 跨句/跨请求必然漂移(seed 只固定采样随机性, 锁不住音色特征)。
# 根治 = 换 Base 模型 + 锚定样本 voice-clone(x_vector_only): 所有句子 clone 同一段锚定音频的 speaker embedding,
# 音色跨句跨进程永久锁定。锚定样本 anchor-loli.wav 由 VoiceDesign+cool-loli-natural+seed42 一次性生成(gen-anchor.py)。
# 锚定 wav 或 Base 模型缺失时自动回退 VoiceDesign 老路径(回滚兼容: 清掉 anchor-loli.wav 即回退)。
USE_CLONE = os.path.isfile(ANCHOR_WAV) and os.path.isdir(MODEL_DIR_BASE)
MODEL_DIR = MODEL_DIR_BASE if USE_CLONE else MODEL_DIR_DESIGN
SEED = int(os.environ.get("QWEN3TTS_SEED", "42"))


# 第93轮（用户反馈「前后短句音色和身份都不一致」）：
#   x_vector_only 只喂 speaker embedding；ICL 模式额外把参考音频的离散声学 token 也喂进去，
#   实测同一条回复 18-34 字分段时 MFCC 余弦最低值 0.994→0.995、F0 中位极差 42→46 Hz（相当），
#   但跨句"身份感"更稳定。锚定 wav 是第90轮由训练音色 SoVITS 合成的句子：
#   「今天也想安静地陪你待一会儿。」—— 把原文写进 sidecar .txt，服务端自动升级为 ICL。
def _read_anchor_text():
    explicit = (os.environ.get("QWEN3TTS_ANCHOR_TEXT") or "").strip()
    if explicit:
        return explicit
    base = os.path.splitext(ANCHOR_WAV)[0]
    for cand in (base + ".txt", os.path.join(os.path.dirname(ANCHOR_WAV), "anchor-yueyue-sovits.txt")):
        if os.path.isfile(cand):
            try:
                with open(cand, "r", encoding="utf-8") as f:
                    return f.read().strip()
            except Exception:
                return ""
    return ""


ANCHOR_TEXT = _read_anchor_text()

# 已定稿音色描述(用户盲听打分 A4/B4.5/C4/D4.5/E>=4/F>=4)
BASE_VOICE = (
    "一个十四五岁的少女，音调清亮偏冷，说话有点别扭、口是心非，语气淡淡的但偶尔露出着急。"
    "声音要自然流畅，像真人少女在说话，不要机械棒读，不要生硬停顿。"
)

# mood -> 说话方式(渲染层 mood 标签; 与 tts-voice.js MOOD_VOICE 的 key 对应)
# 2026-09-11 声线一致性修复(用户真机反馈: "每一小句都像不同的人在说话, 前一秒萝莉后一句御姐, 有恐惧感"):
# 根因 = 每个合成请求只带一种 mood, 按 mood 追加不同的"说话方式" instruct → 不同句=不同请求=不同声线。
# 修复 = 全部 mood 统一为同一条交付描述: 音色/年龄/性格完全一致, 情绪只由台词文字本身表达。
_FLAT_DELIVERY = (
    "音色必须始终是同一个十四五岁的少女——和上一句完全相同的嗓音、年龄感、清亮度，"
    "绝不能变成别的声线或别的年龄。语气自然平和，像平常跟人聊天一样，不要机械棒读，"
    "不要刻意抑扬顿挫。"
)
MOOD_DELIVERY = {
    "just_woke": _FLAT_DELIVERY,
    "morning_greet": _FLAT_DELIVERY,
    "gentle": _FLAT_DELIVERY,
    "quiet_company": _FLAT_DELIVERY,
    "night_watch": _FLAT_DELIVERY,
    "sad": _FLAT_DELIVERY,
    "concerned": _FLAT_DELIVERY,
    "surprised": _FLAT_DELIVERY,
    "happy": _FLAT_DELIVERY,
    "playful": _FLAT_DELIVERY,
    "tea_time": _FLAT_DELIVERY,
    "smug": _FLAT_DELIVERY,
    "serious": _FLAT_DELIVERY,
    "thinking": _FLAT_DELIVERY,
    "shy": _FLAT_DELIVERY,
    "waiting": _FLAT_DELIVERY,
    # 2026-09-11 补齐: idle(最高频默认心情) 与 talking 此前不在表内, 只会走 BASE_VOICE 拿不到语气指令
    "idle": _FLAT_DELIVERY,
    "talking": _FLAT_DELIVERY,
}

# 按标点切短句(保留句尾标点作韵律提示); 长句提前终止的修复依赖它
CLAUSE_RE = re.compile(r"[^，。！？…；：\n]+[，。！？…；：\n]?")

app = FastAPI(title="yueyue-qwen3tts")
_model = None
_lock = threading.Lock()
_last_use = time.time()
_idle_timer = None

_anchor_prompt_items = None

# ============ 改造1: 取消记账(线程安全: 合成跑在 executor 线程, 请求跑在事件循环) ============
_jobs_lock = threading.Lock()
_cancel_epoch = 0            # cancel-all 时 +1: 所有更早 epoch 的 job 全部视为已取消
_cancelled_jobs = set()      # 单点取消的 job_id 集合(容量守恒, 见 /cancel 内清理)
_active_jobs = {}            # job_id -> {"state": "queued"|"running", "started": ts}
_bg_tasks = set()            # 后台排水任务引用(防被 GC)


def _register_job(job_id):
    with _jobs_lock:
        _active_jobs[job_id] = {"state": "queued", "started": time.time()}
        return (_cancel_epoch, job_id)   # 取消快照: 请求进入时刻的 epoch


def _is_cancelled(snap):
    with _jobs_lock:
        return snap[0] < _cancel_epoch or snap[1] in _cancelled_jobs


def get_anchor_prompt(model):
    global _anchor_prompt_items
    if _anchor_prompt_items is None:
        mode = "ICL(参考文本)" if ANCHOR_TEXT else "x_vector_only"
        print("[qwen3tts] 构建音色锚定(" + mode + ", 源=" + os.path.basename(ANCHOR_WAV) + ")…", flush=True)
        try:
            if ANCHOR_TEXT:
                _anchor_prompt_items = model.create_voice_clone_prompt(
                    ref_audio=ANCHOR_WAV, ref_text=ANCHOR_TEXT, x_vector_only_mode=False)
            else:
                _anchor_prompt_items = model.create_voice_clone_prompt(ref_audio=ANCHOR_WAV, x_vector_only_mode=True)
        except Exception as e:
            print("[qwen3tts] ICL 锚定失败(" + str(e)[:160] + "), 回退 x_vector_only", flush=True)
            _anchor_prompt_items = model.create_voice_clone_prompt(ref_audio=ANCHOR_WAV, x_vector_only_mode=True)
        print("[qwen3tts] 音色锚定就绪(" + mode + ")", flush=True)
    return _anchor_prompt_items


def _pick_device():
    """第90轮: 按本机显卡自动适配。
    NVIDIA(本机 5070 Ti) → cuda:0 + bf16; 没有可用 CUDA(纯 CPU/核显/A 卡旧驱动) → cpu(fp32)。
    可用 YUEYUE_TTS_DEVICE=cpu|cuda|cuda:0 强制, YUEYUE_TTS_DTYPE=fp32|fp16|bf16 覆盖精度。"""
    forced = (os.environ.get("YUEYUE_TTS_DEVICE") or "").strip().lower()
    if forced in ("cpu", "cuda", "cuda:0"):
        dev = "cuda:0" if forced == "cuda" else forced
        return dev
    try:
        import torch  # noqa: F401 (torch 在文件上方已 import, 这里兜底)
        if torch.cuda.is_available():
            return "cuda:0"
    except Exception:
        pass
    return "cpu"


def load_model():
    global _model
    with _lock:
        if _model is None:
            from qwen_tts import Qwen3TTSModel
            device = _pick_device()
            kw = {"device_map": device}
            dt = (os.environ.get("YUEYUE_TTS_DTYPE") or "").strip().lower()
            if device.startswith("cuda") and dt != "fp32":
                try:
                    import torch
                    kw["dtype"] = torch.float16 if dt == "fp16" else torch.bfloat16
                except Exception:
                    pass
            # 第91轮: 注意力实现显式指定。实测同一句(1.7B/cuda/bf16):
            #   不传(默认) RTF 3.65 / eager 2.47 / sdpa 2.06 —— 默认路径不是 sdpa, 慢近一倍。
            # 本机没装 flash-attn(Windows 无官方轮子, 装了反而 import 失败), 故默认 sdpa;
            # 想回滚老行为设 YUEYUE_TTS_ATTN=default(不传该参数)。
            atn = (os.environ.get("YUEYUE_TTS_ATTN") or "sdpa").strip().lower()
            if atn in ("sdpa", "eager"):
                kw["attn_implementation"] = atn
            else:
                print("[qwen3tts] 注意力: 默认实现(未指定 attn_implementation)", flush=True)
            print("[qwen3tts] 加载 " + os.path.basename(MODEL_DIR) + " (" + ("voice-clone 锚定模式" if USE_CLONE else "voice-design 老模式") + ", device=" + device + ", dtype=" + str(kw.get("dtype", "fp32")) + ")...", flush=True)
            _model = Qwen3TTSModel.from_pretrained(MODEL_DIR, **kw)
            print("[qwen3tts] 模型就绪(device=" + device + ")", flush=True)
        return _model


# 第91轮: 空闲自杀阈值从写死的 5 分钟改成可配(默认 30 分钟)。
# 起因: 漫展现场两次演示之间常有 5 分钟以上的空档, 一自杀下一位就要再等一次模型加载(实测冷 31.2 s / 热 6 s)。
# 代价是空闲时继续占着 ~6.6GB WS 内存 + 5.7GB 显存; 内存吃紧的机器可用 YUEYUE_TTS_IDLE_STOP_SEC=330 还原旧行为。
IDLE_STOP_SEC = max(60, _env_int("YUEYUE_TTS_IDLE_STOP_SEC", 30 * 60))


def arm_idle_stop():
    global _idle_timer
    if _idle_timer:
        _idle_timer.cancel()
    def stop():
        # 2026-09-10 内存优化: 15→5 分钟(模型常驻 ~6.6GB WS/13.3GB Private, 用户反馈内存 55%+)
        if time.time() - _last_use >= IDLE_STOP_SEC:
            print("[qwen3tts] 空闲 %d 分钟, 自动退出(释放模型内存; YUEYUE_TTS_IDLE_STOP_SEC 可调)" % (IDLE_STOP_SEC // 60), flush=True)
            os._exit(0)
        arm_idle_stop()  # 未到空闲线, 重新挂表
    _idle_timer = threading.Timer(IDLE_STOP_SEC + 30, stop)
    _idle_timer.daemon = True
    _idle_timer.start()


def err_response(status, message):
    return Response(content=json.dumps({"error": message}, ensure_ascii=False).encode("utf-8"),
                    status_code=status, media_type="application/json")


def lower_process_priority():
    """改造3: 服务进程自降为 BELOW_NORMAL —— 前台应用(游戏/浏览器)优先调度, TTS 慢一点可接受。"""
    if PRIORITY == "normal":
        print("[qwen3tts] 进程优先级: 保持 normal(QWEN3TTS_PRIORITY=normal)", flush=True)
        return
    try:
        import psutil
        psutil.Process(os.getpid()).nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        print("[qwen3tts] 进程优先级: BELOW_NORMAL(psutil)", flush=True)
        return
    except Exception:
        pass
    try:
        import ctypes
        BELOW_NORMAL = 0x00004000
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), BELOW_NORMAL)
        print("[qwen3tts] 进程优先级: BELOW_NORMAL(ctypes)", flush=True)
    except Exception:
        print("[qwen3tts] 进程优先级: 降级失败(不影响运行)", flush=True)


# 2026-09-12 主 agent 复核补充: 短句合并只解决了一半问题 —— 若合并后的 chunk **以语气词收尾**
# (如 "她说完了。……嗯，"), 它长度已达阈值会被收口, 于是"嗯"仍落在音频段尾, 听感还是孤立语气词+停顿。
# 所以再加一条: 只要 chunk 尾巴还是语气词, 就继续往后并, 直到后面接上真正的话。
FILLER_TAIL_RE = re.compile(r"(?:嗯|呃|唉|哦|唔|额|啊)[，,。、…~～!！?？\s]*$")


def merge_short_clauses(clauses):
    """改造2: 拟声词不孤立(用户原话"拟声词后面必须跟上长句子")。
    客户端 addFillers 把"……"补成"……嗯，", 而 CLAUSE_RE 按标点切开后"嗯，"会变成
    独立 clause 被单独合成(听感 = 孤零零一个嗯 + 停顿)。修法: 长度 < MERGE_SHORT 的
    clause 并入**后一句**; 末尾孤立的短句并入**前一句**; 合并结果超过 MERGE_MAX 则放弃
    合并(长度保护, 避免触发 12Hz 长句提前终止)。"""
    if len(clauses) <= 1:
        return clauses
    out = []
    pending = ""
    for c in clauses:
        if pending:
            if len(pending) + len(c) <= MERGE_MAX:
                c = pending + c          # 短句向前合并到本句开头
            else:
                out.append(pending)      # 保护: 合并会超长, 短句保持独立(极端场景)
            pending = ""
        # 短句 → 继续后并; 或者虽然够长但**以语气词收尾** → 也必须继续后并(否则嗯还在段尾)
        if len(c) < MERGE_SHORT or FILLER_TAIL_RE.search(c):
            pending = c
        else:
            out.append(c)
    if pending:
        if out and len(out[-1]) + len(pending) <= MERGE_MAX:
            out[-1] = out[-1] + pending  # 末尾孤立短句并入前一句
        else:
            out.append(pending)
    return out


def _tokens_for(clause):
    """改造2 配套: 单句 token 预算按字数放大。
    MAX_NEW_TOKENS=200 只够 ~60 字的音频(12 token/s, ~4 字/s), 短句合并后单句可达 120 字,
    若不放大预算会在 ~16s 处提前终止 —— 重新引入"文字被省略"缺陷(第七轮刚修好的 bug)。
    比例: 3 token/字 × 2.5 冗余; 上限 MAX_TOKEN_CAP(防重复文本死循环的性质保留, 150s 看门狗仍兜底)。"""
    if len(clause) <= 66:
        return MAX_NEW_TOKENS
    return min(MAX_TOKEN_CAP, MAX_NEW_TOKENS + int((len(clause) - 66) * 7.5))


def synthesize_clauses(model, clauses, progress, clone_items, instruct, cancel_snap):
    parts = []
    sr_out = None
    try:
        with torch.inference_mode():  # 改造3: 推理模式(等价 no_grad 且省掉簿记开销)
            for idx, c in enumerate(clauses):
                # 改造1: 每句开始前查取消 —— 命中即 break, 不再合成任何后续句
                if _is_cancelled(cancel_snap):
                    progress['cancelled'] = True
                    print("[qwen3tts] job=%s 已取消, 停止后续 clause(%d/%d 句已完成, 不再占用队列)" % (
                        cancel_snap[1], len(parts), len(clauses)), flush=True)
                    return
                # F 一致性: 每句生成前固定种子(与定稿试听完全一致); 信号量保证同一时刻只有一个合成在跑
                torch.manual_seed(SEED)
                np.random.seed(SEED)
                random.seed(SEED)
                tok = _tokens_for(c)
                t_start = time.time()
                if clone_items is not None:
                    # 2026-09-11 音色锚定模式: 每句 clone 锚定样本的 speaker embedding → 音色跨句一致
                    wavs, sr = model.generate_voice_clone(text=c, voice_clone_prompt=clone_items, max_new_tokens=tok)
                else:
                    wavs, sr = model.generate_voice_design(text=c, language="Chinese", instruct=instruct, max_new_tokens=tok)
                sr_out = sr
                w = wavs[0] if isinstance(wavs, list) else wavs
                parts.append(w)
                progress['t'] = time.time()  # 每完成一句刷新进度(看门狗依据)
                print("[qwen3tts] job=%s clause %d/%d 完成, %.1fs" % (cancel_snap[1], idx + 1, len(clauses), progress['t'] - t_start), flush=True)
        progress['parts'] = parts
        progress['sr'] = sr_out
        progress['done'] = True
    except Exception as e:
        progress['error'] = str(e)[:200]
        raise


async def _drain(task, job_id):
    """改造1: 取消后的排水 —— torch 当前句不可抢占, 等 executor 线程跑完当前句
    (它会在此句结束后的下一边界 break), 然后释放合成信号量。期间信号量仍被占用:
    防止下一个请求与残局线程互踩 RNG。排水超过看门狗阈值 = 真挂死, 自杀重启。"""
    try:
        done, _ = await asyncio.wait([task], timeout=CLAUSE_STALL_S)
        if not done:
            print("[qwen3tts] job=%s 取消后排水 %ds 未结束, 自杀重启(宿主看门狗拉起新进程)" % (job_id, CLAUSE_STALL_S), flush=True)
            os._exit(1)
        try:
            await task
        except Exception:
            pass
    finally:
        with _jobs_lock:
            _cancelled_jobs.discard(job_id)
        _synth_sem.release()
        print("[qwen3tts] job=%s 排水完成, 合成信号量已释放" % job_id, flush=True)


def _spawn_bg(coro):
    t = asyncio.get_running_loop().create_task(coro)
    _bg_tasks.add(t)
    t.add_done_callback(_bg_tasks.discard)
    return t


@app.post("/tts")
async def tts(request: Request):
    global _last_use
    _last_use = time.time()
    arm_idle_stop()
    try:
        body = await request.json()
    except Exception:
        return err_response(400, "BAD_JSON")
    text = str(body.get("text") or "").strip()
    if not text:
        return err_response(400, "EMPTY_TEXT")
    # 防卡死消毒: 去全/半角引号(含单引号), 去残留括号内容(客户端 cleanText 已剥全部括号, 残留即异常)
    text = text.translate(QUOTE_CHARS)
    text = re.sub(r'[\(（][^)）]{0,200}[\)）]', '', text).strip()
    if not text:
        return err_response(400, "EMPTY_TEXT")
    mood = str(body.get("mood") or "日常").strip()
    delivery = MOOD_DELIVERY.get(mood, "")
    instruct = BASE_VOICE + ("。说话方式：" + delivery if delivery else "")

    # ---- 改造1: job 记账(老客户端不带 job_id 照常工作, 服务端生成并通过响应头回传) ----
    job_id = str(body.get("job_id") or "").strip() or uuid.uuid4().hex[:12]
    cancel_snap = _register_job(job_id)

    def cancelled_response(discard_marker):
        if discard_marker:
            # 合成线程已退出(或从未启动): 单点取消标记可以安全清掉(防集合无界增长)
            with _jobs_lock:
                _cancelled_jobs.discard(job_id)
        with _jobs_lock:
            _active_jobs.pop(job_id, None)
        return Response(
            content=json.dumps({"error": "CANCELLED", "job_id": job_id}, ensure_ascii=False).encode("utf-8"),
            status_code=410, media_type="application/json",
            headers={"X-Tts-Job-Id": job_id})

    if _is_cancelled(cancel_snap):
        return cancelled_response(True)

    sem_owned = False
    try:
        # ---- 改造1: 排队可取消。asyncio.Semaphore 无超时版 acquire, 用 wait_for 轮询:
        #      每 2s 醒来查一次取消标记, 命中直接出队返回 410(旧版会在队列里干等到超时)。----
        while True:
            if _is_cancelled(cancel_snap):
                return cancelled_response(True)
            try:
                await asyncio.wait_for(_synth_sem.acquire(), timeout=2.0)
                sem_owned = True
                break
            except asyncio.TimeoutError:
                continue
        with _jobs_lock:
            if job_id in _active_jobs:
                _active_jobs[job_id]["state"] = "running"
        if _is_cancelled(cancel_snap):  # 拿到信号量才发现已被取消: 立即让位
            return cancelled_response(True)

        model = load_model()
        # 逐句合成(2026-09-09 真机冒烟修复): Qwen3-TTS 12Hz 对长句/多分句文本会提前终止
        # (实测 30 字仅出 1.28s), 按标点切短句逐句生成再拼接 250ms 静音, 保证整段完整播出。
        # 第93轮: 短请求(≤SINGLE_MAX)改为**整段一次生成** —— 边界为零, 音色不会在段间跳档;
        # 实测 63 字整段时长/字数与 44 字样本一致, 确认不截断(原因: max_new_tokens 已按字数放大)。
        if len(text) <= SINGLE_MAX:
            clauses = [text]
            print("[qwen3tts] job=%s 整段单次生成(%.0f 字)" % (job_id, len(text)), flush=True)
        else:
            raw_clauses = [c.strip() for c in CLAUSE_RE.findall(text) if len(c.strip()) >= 2]
            if not raw_clauses:
                raw_clauses = [text]
            clauses = merge_short_clauses(raw_clauses)
            # 第98轮 S2-P2-1: 没有任何标点的长文本(例如一长串字母/数字/无标点口语)在 CLAUSE_RE 下
            # 只有 1 个 clause, 合并后整段送进模型 —— 超过 MERGE_MAX(120) 会吃掉 token 预算、
            # 逼近 150s 看门狗, 最坏表现为"语音卡住不说话"。超过 MERGE_MAX 的段落按长度硬切。
            if any(len(c) > MERGE_MAX for c in clauses):
                _hard = []
                for _c in clauses:
                    if len(_c) <= MERGE_MAX:
                        _hard.append(_c)
                    else:
                        for _i in range(0, len(_c), MERGE_MAX):
                            _hard.append(_c[_i:_i + MERGE_MAX])
                clauses = _hard
            print("[qwen3tts] job=%s clauses=%d(合并前 %d): %s" % (
                job_id, len(clauses), len(raw_clauses),
                " | ".join((c[:24] + ("…" if len(c) > 24 else "")) for c in clauses[:12])), flush=True)

        loop = asyncio.get_running_loop()
        progress = {'t': time.time(), 'done': False, 'parts': None, 'sr': None, 'cancelled': False}
        clone_items = get_anchor_prompt(model) if USE_CLONE else None
        task = loop.run_in_executor(None, synthesize_clauses, model, clauses, progress, clone_items, instruct, cancel_snap)
        # 进度看门狗(每 5s 醒一次; 缩短间隔是为了让"合成中取消"的 410 反馈足够快) +
        # 取消检测: torch 当前句不可抢占, 但客户端可以立即收到 410, 当前句跑完后线程退出。
        while True:
            done, _ = await asyncio.wait([task], timeout=5)
            if not done and _is_cancelled(cancel_snap):
                print("[qwen3tts] job=%s 取消(客户端), 当前句跑完后停止, 客户端立即收到 410" % job_id, flush=True)
                _spawn_bg(_drain(task, job_id))
                sem_owned = False   # 信号量所有权移交给 _drain, 本请求不再释放
                return cancelled_response(False)   # 不能清单点标记: 排水线程还要靠它退出
            if done:
                if progress.get('cancelled'):
                    return cancelled_response(True)
                if not progress['done']:
                    task.result()  # 抛出发送线程中的异常(如有)
                    raise RuntimeError('synthesis thread ended without result')
                parts = progress['parts']
                sr_out = progress['sr']
                break
            if time.time() - progress['t'] > CLAUSE_STALL_S:
                print("[qwen3tts] 单句合成 %d 秒无进度, 自杀重启(宿主看门狗拉起新进程)" % CLAUSE_STALL_S, flush=True)
                os._exit(1)
        gap = np.zeros(int(sr_out * 0.25), dtype=parts[0].dtype)
        audio = parts[0]
        for w in parts[1:]:
            audio = np.concatenate([audio, gap, w])
        print("[qwen3tts] job=%s clauses=%d total_dur=%.2fs" % (job_id, len(parts), audio.size / sr_out), flush=True)
        buf = io.BytesIO()
        sf.write(buf, audio, sr_out, format="WAV", subtype="PCM_16")
        return Response(content=buf.getvalue(), media_type="audio/wav", headers={"X-Tts-Job-Id": job_id})
    except Exception as e:
        return err_response(500, str(e)[:200])
    finally:
        with _jobs_lock:
            _active_jobs.pop(job_id, None)
        if sem_owned:
            _synth_sem.release()


@app.post("/warm")
async def warm():
    """第91轮: 只加载模型、不合成。给启动预热用, 让用户看界面的时间把模型搬进显存。
    与 /tts 共用 load_model() 的锁: 真请求若撞上预热只会等这一次加载, 不会重复加载两份。
    不碰合成信号量 —— 预热不该让用户的第一句话排队。"""
    global _last_use
    _last_use = time.time()
    arm_idle_stop()
    t0 = time.time()
    loop = asyncio.get_running_loop()
    try:
        await loop.run_in_executor(None, load_model)
        sec = round(time.time() - t0, 1)
        print("[qwen3tts] 预热完成(模型已驻留, %.1fs)" % (time.time() - t0), flush=True)
        return Response(content=json.dumps({"ok": True, "warm": True, "sec": sec}, ensure_ascii=False).encode("utf-8"),
                        media_type="application/json")
    except Exception as e:
        print("[qwen3tts] 预热失败: %s" % str(e)[:200], flush=True)
        return err_response(500, str(e)[:200])


@app.post("/cancel")
async def cancel(request: Request):
    """改造1: 取消端点。{"job_id": "..."} 单点取消; {"all": true} 全部取消(客户端打断时用)。
    返回本次实际取消的 job 列表(排队中+合成中)。"""
    global _cancel_epoch
    try:
        body = await request.json()
    except Exception:
        body = {}
    job_id = str(body.get("job_id") or "").strip()
    do_all = bool(body.get("all") or body.get("cancel_all") or body.get("cancelAll"))
    with _jobs_lock:
        if len(_cancelled_jobs) > 4096:   # 容量守恒(单点标记正常由 _drain/响应路径清理, 此为兜底)
            _cancelled_jobs.clear()
        if do_all:
            _cancel_epoch += 1            # 更早 epoch 的所有 job 一并取消
            cancelled = sorted(_active_jobs.keys())
            _cancelled_jobs.update(cancelled)
        elif job_id and job_id in _active_jobs:
            _cancelled_jobs.add(job_id)
            cancelled = [job_id]
        else:
            cancelled = []
    print("[qwen3tts] /cancel %s -> %s (epoch=%d)" % ("all" if do_all else (job_id or "(空)"), cancelled, _cancel_epoch), flush=True)
    return Response(content=json.dumps({"cancelled": cancelled, "epoch": _cancel_epoch}, ensure_ascii=False).encode("utf-8"),
                    status_code=200, media_type="application/json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-p", "--port", type=int, default=DEFAULT_PORT)
    args = ap.parse_args()
    lower_process_priority()  # 改造3: 启动即降优先级(失败不影响运行)
    print("[qwen3tts] 线程: torch=%d OMP=%s MKL=%s (cpu_count=%d, QWEN3TTS_TORCH_THREADS 可覆盖)" % (
        torch.get_num_threads(), os.environ.get("OMP_NUM_THREADS"), os.environ.get("MKL_NUM_THREADS"), os.cpu_count()), flush=True)
    print("[qwen3tts] 切句合并: <%d 字并入后句, 合并上限 %d 字 (QWEN3TTS_MERGE_SHORT / QWEN3TTS_MERGE_MAX 可调)" % (MERGE_SHORT, MERGE_MAX), flush=True)
    arm_idle_stop()  # 2026-09-10: 启动即挂表(拉起后 IDLE_STOP_SEC 内无请求也自动退, 不再只在收到请求后才计时；第91轮起默认 30 分钟, 第98轮注释同步)
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
