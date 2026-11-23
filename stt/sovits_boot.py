# -*- coding: utf-8 -*-
"""GPT-SoVITS 启动包装层(第89轮) —— 给 api_v2.py 前面垫一道硬件/依赖适配。

为什么需要它(全部是实测结论, 不是推测):
  本机 `K:\\yueyueneiceban\\win-unpacked\\GPT-SoVITS-0927-AMD\\GPT-SoVITS-0927-zluda`
  是 **AMD/ZLUDA 特化包**, 它的 `api_v2.py` 第 101 行无条件 `import zluda`:
    - 在 NVIDIA 机器上, zluda 在初始化时抛 `ValueError(这里不是AMD显卡…)`, 进程直接退出(exit 1);
    - 更隐蔽的是"试一次 import zluda"本身就会把卡藏起来 —— 实测同一台机器:
        C1 只塞空模块、不 import zluda : torch.cuda.is_available()=True  device_count=1
        C2 先 import zluda(失败) 再 import torch : is_available=True  **device_count=0**
        C3 纯 import torch            : is_available()=True  device_count=1
    - device_count 变 0 之后, GPT_SoVITS 的 TTS_Config 会判定 "CUDA is not available" 并
      静默降级 CPU, 还顺手把 configs/tts_infer.yaml 的 device 改写成 cpu ——
      用户听到的是"语音又慢又卡", 日志里却只有一个看不出因果的警告。

包装层的策略(硬件无关, 三档都能跑):
  1. 先 import torch, 看标准 CUDA 能不能看见一张**非 AMD** 的卡 → 能: 注入空 zluda 模块跳过它;
  2. 看不见卡 / 看见的是 AMD 卡 → 真 `import zluda`(保留 AMD 机器原有 ZLUDA 路径);
  3. zluda 也加载不了 → 注入空占位, 让 api_v2 照常走到 CPU(宁可慢, 不要死)。

环境变量:
  SOVITS_DIR  仓库根(缺省 = 当前工作目录)
  PORT/HOST   透传给 api_v2 的默认值(若命令行没给)
"""
import os
import re
import runpy
import sys
import types


def main():
    repo = os.environ.get("SOVITS_DIR") or os.getcwd()
    os.chdir(repo)
    sys.path.insert(0, repo)
    sys.path.insert(0, os.path.join(repo, "GPT_SoVITS"))

    # 延迟到 chdir 之后再 import, 保持与原启动方式一致的相对路径行为
    import torch  # noqa: E402

    try:
        visible = bool(torch.cuda.is_available()) and int(torch.cuda.device_count()) > 0
        gpu_name = torch.cuda.get_device_name(0) if visible else ""
    except Exception:  # noqa: BLE001
        visible, gpu_name = False, ""

    is_amd = bool(re.search(r"AMD|Radeon|gfx|Vega|Navi", gpu_name or "", re.I))
    if visible and not is_amd:
        sys.modules["zluda"] = types.ModuleType("zluda")
        print("[sovits-boot] 标准CUDA可用(gpu=%s), 跳过 zluda" % gpu_name, flush=True)
    else:
        try:
            import zluda  # noqa: F401

            print("[sovits-boot] zluda 已加载(AMD 原路径)", flush=True)
        except Exception as exc:  # noqa: BLE001
            sys.modules["zluda"] = types.ModuleType("zluda")
            print("[sovits-boot] zluda 不可用(%s), 注入空占位" % type(exc).__name__, flush=True)

    # 设备选择: api_v2.py 的命令行**只认 -c/-a/-p**(2026-10-23 实测 argparse 报
    # "unrecognized arguments: -d cuda"), 所以设备只能走 yaml。策略:
    #   期望设备 = TTS_DEVICE 环境变量, 否则 看得见卡→cuda / 看不见→cpu;
    #   与当前 -c 指向的 yaml 不一致时, 复制一份只改 device/is_half 的临时 yaml 传给 -c。
    # 这样 AMD 机器(原 ZLUDA 路径)与无卡机器都不会因为 yaml 里写死 cuda 而崩。
    argv = sys.argv[1:]

    def _argval(flags, default=None):
        for f in flags:
            if f in argv:
                i = argv.index(f)
                if i + 1 < len(argv):
                    return argv[i + 1]
        return default

    cfg_path = _argval(["-c", "--tts_config"], "GPT_SoVITS/configs/tts_infer.yaml")
    want_device = (os.environ.get("TTS_DEVICE") or ("cuda" if visible else "cpu")).strip().lower()
    if want_device not in ("cuda", "cpu"):
        want_device = "cuda" if visible else "cpu"
    half_env = os.environ.get("TTS_HALF")
    want_half = (half_env.strip().lower() in ("1", "true", "yes", "on")) if half_env is not None else (want_device == "cuda")

    try:
        import yaml  # GPT-SoVITS 自带依赖

        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        custom = (cfg or {}).get("custom") or {}
        cur_device = str(custom.get("device", "")).lower()
        cur_half = bool(custom.get("is_half", False))
        if cfg is not None and (cur_device != want_device or cur_half != want_half):
            custom["device"] = want_device
            custom["is_half"] = want_half
            cfg["custom"] = custom
            import tempfile

            fd, tmp = tempfile.mkstemp(prefix="tts_infer_", suffix=".yaml")
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                yaml.safe_dump(cfg, f, allow_unicode=True, sort_keys=False)
            if any(a in argv for a in ("-c", "--tts_config")):
                i = argv.index("-c") if "-c" in argv else argv.index("--tts_config")
                argv[i + 1] = tmp
            else:
                argv = argv + ["-c", tmp]
            print(
                "[sovits-boot] yaml 设备与硬件不符(%s/%s → %s/%s), 已用临时配置 %s"
                % (cur_device or "?", cur_half, want_device, want_half, tmp),
                flush=True,
            )
    except Exception as exc:  # noqa: BLE001
        print("[sovits-boot] 读取/改写 yaml 失败(%s), 按原样启动" % type(exc).__name__, flush=True)

    if "-a" not in argv and "--bind_addr" not in argv:
        argv = argv + ["-a", os.environ.get("HOST") or "127.0.0.1"]
    if "-p" not in argv and "--port" not in argv:
        argv = argv + ["-p", os.environ.get("PORT") or "9880"]

    print(
        "[sovits-boot] torch=%s cuda=%s count=%s gpu=%s device=%s"
        % (
            torch.__version__,
            torch.cuda.is_available(),
            torch.cuda.device_count(),
            gpu_name,
            want_device,
        ),
        flush=True,
    )

    sys.argv = ["api_v2.py"] + argv
    runpy.run_path(os.path.join(repo, "api_v2.py"), run_name="__main__")


if __name__ == "__main__":
    main()
