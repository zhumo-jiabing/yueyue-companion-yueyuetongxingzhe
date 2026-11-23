# 第三方组件与许可声明（THIRD-PARTY NOTICES）

本文件列出「玥玥」开源外围仓库（AGPL-3.0，见 `LICENSE`）所**随包包含**或**运行时依赖**的第三方组件、
各自许可与来源指针。区分两类：

- **【随包】**：组件的代码 / 数据文件实际包含在本导出包内。
- **【外部】**：本仓库只含玥玥自写的**启动包装层 / 代理**（AGPL-3.0），组件本体（模型权重、运行时、SDK）
  **未随包**，由用户本机在运行时另行提供；用户须自行遵守其上游许可。

> 许可核对说明：Qwen3-TTS / Kokoro / GPT-SoVITS / IndexTTS-2.5 的许可类型于本次导出前经公开来源核对；
> Apache-2.0 全文随包（`LICENSE-APACHE-2.0`，11,358 B，sha256 前16 `cfc7749b96f63bd3`，与 Apache 官方规范文本一致）。
> 下方各组件的**完整许可条款以其上游仓库 / 模型页为准**，本文件仅为指针与摘要，不构成法律意见。

---

## 1. Qwen3-TTS（TTS 引擎）【外部】

- **许可**：Apache-2.0（全文见随包 `LICENSE-APACHE-2.0`）。
- **权利方 / 来源**：Alibaba Qwen 团队，https://github.com/QwenLM/Qwen3-TTS
  （模型集 https://huggingface.co/collections/Qwen/qwen3-tts）。
- **本仓库关系**：`stt/qwen3tts_server.py`、`stt/qwen3tts_fast_server.py` 为玥玥自写启动包装层（AGPL-3.0）；
  Qwen3-TTS 模型权重与推理库**未随包**，运行时从外部模型目录加载。
- **核对来源**：Qwen3-TTS 开源公告（Apache-2.0），https://gigazine.net/gsc_news/en/20260123-qwen3-tts-family-opensource 。

## 2. Kokoro-82M（随包 CPU TTS 引擎）【部分随包 + 外部】

- **许可**：Apache-2.0（模型权重，hexgrad/Kokoro-82M）。
- **来源**：https://huggingface.co/hexgrad/Kokoro-82M ；https://github.com/hexgrad/kokoro 。
- **【随包】数据**：`stt/kokoro/` 下的发音词典与文本规整数据
  （`lexicon-zh.txt`、`lexicon-us-en.txt`、`date-zh.fst`、`number-zh.fst`、`phone-zh.fst`、`tokens.txt`），
  属 Kokoro / sherpa-onnx CPU 分发的一部分。
- **【外部】**：Kokoro ONNX 模型权重（`model.onnx`）、`espeak-ng-data`、`dict` **未随包**，运行时由 `--model-dir` 提供。
- **运行时依赖**：sherpa-onnx（Apache-2.0，https://github.com/k2-fsa/sherpa-onnx ）；
  其 kokoro 音素化依赖 espeak-ng（GPL-3.0，**外部、未随包**），部署者须自行遵守 espeak-ng 许可。
- **本仓库关系**：`stt/kokoro_tts_server.py` 为玥玥自写包装层（AGPL-3.0）。
- **核对来源**：Kokoro-82M Apache-2.0，https://huggingface.co/nvidia/kokoro-82M-onnx-opt （`license: apache-2.0`）。

## 3. GPT-SoVITS（TTS 引擎）【外部】

- **许可**：MIT（`Copyright (c) 2024 RVC-Boss`）。
- **来源**：https://github.com/RVC-Boss/GPT-SoVITS 。
- **本仓库关系**：`stt/sovits_boot.py` 为玥玥自写启动包装层（AGPL-3.0，做硬件 / 依赖适配）；
  GPT-SoVITS 仓库本体、推理运行时与训练音色权重**未随包**，运行时从外部目录加载。
- **核对来源**：GPT-SoVITS LICENSE（MIT），https://huggingface.co/spaces/XXXXRT/GPT-SoVITS/blame/main/LICENSE 。

## 4. IndexTTS-2.5（TTS 引擎）【外部】

- **许可**：**bilibili Model Use License Agreement**（非标准开源许可，含商用门槛条款）。
- **来源**：https://github.com/index-tts/index-tts ；模型与许可 https://huggingface.co/IndexTeam/IndexTTS-2.5 （`LICENSE`）。
- **关键条款摘要**（以原文为准）：
  - 允许使用与商用，但若你或关联方的产品 / 服务**上一自然月月活 > 1 亿**，
    或**上一自然年营收 > 10 亿元人民币**，须向 bilibili **另行申请单独授权**（小规模商用在此门槛之下）。
  - 不得用本模型或其衍生品**改进其它 AI 模型**（indextts2 自身、其衍生品、或非商用 AI 模型除外）。
  - 高风险场景（医疗诊断、自动驾驶、军事、关键基础设施控制、大规模生物特征监控、自动化决策等）受限。
  - 分发衍生品须在分发页 / 文档**声明所做修改**。
- **本仓库关系**：`stt/index_tts_server.py` 为玥玥自写包装层（AGPL-3.0，请求 / 响应契约对齐 GPT-SoVITS api_v2）；
  IndexTTS 模型与代码**未随包**，运行于 index-tts 仓库自带 venv（外部）。
- **核对来源**：bilibili Model Use License Agreement，https://huggingface.co/IndexTeam/IndexTTS-2.5/blob/main/LICENSE ；
  中文本 https://github.com/tabortao/index-tts2/blob/main/INDEX_MODEL_LICENSE 。

## 5. qrcode.js（QR 码生成）【随包】

- **许可**：MIT。
- **权利方 / 来源**：Copyright (c) 2009 Kazuhiko Arase，http://www.d-project.com/
  （MIT: http://www.opensource.org/licenses/mit-license.php ）。
- **本仓库关系**：`web/vendor/qrcode.js` **随包**，文件头已含 MIT 声明与商标说明（"QR Code" 为注册商标）。

## 6. npm 依赖（声明于 package.json，node_modules 未随包）【外部】

`node_modules/` 不在导出包内；以下为 `package.json` 声明的主要依赖及其许可（含传递依赖，各自许可以其包为准）：

| 组件 | 许可 | 来源 |
|---|---|---|
| `@huggingface/transformers` | Apache-2.0 | https://github.com/huggingface/transformers.js |
| `onnxruntime-node` | MIT | https://github.com/microsoft/onnxruntime |
| `electron`（dev） | MIT | https://github.com/electron/electron |
| `electron-builder`（dev） | MIT | https://github.com/electron-userland/electron-builder |

## 7. Live2D（桌宠运行时）【外部】

- 本仓库 `live2d/` 仅含 `README.md` 与 `manifest.json`（桌宠包元数据）；
  实际 Live2D 模型包（`project.json` / `runtime.html` 等）与 **Live2D Cubism SDK 未随包**。
- Live2D Cubism SDK 受 **Live2D Open Software License** 约束（外部），部署者须自行遵守，
  见 https://www.live2d.com/en/sdk/license/ 。

## 8. SenseVoice / FunASR（ASR，语音识别）【外部】

- `stt/stt_server_sensevoice.py` 为玥玥自写包装层（AGPL-3.0）；
  识别模型 `iic/SenseVoiceSmall`（ModelScope）与 FunASR 运行时**未随包**，运行时外部加载。
- 许可与条款以上游为准：FunASR https://github.com/modelscope/FunASR ；
  SenseVoice https://github.com/FunAudioLLM/SenseVoice （模型页 https://modelscope.cn/models/iic/SenseVoiceSmall ）。

---

## 随包许可证文件

- `LICENSE` —— AGPL-3.0（本仓库原创代码）。
- `LICENSE-APACHE-2.0` —— Apache-2.0 全文（供上述 Apache-2.0 组件引用）。
- `OPEN-SOURCE-BOUNDARY.md` —— 闭源 / 开源边界清单。

> 未尽事项：各外部组件的完整许可、商标与专利条款以其上游为准；本文件不授予任何超出上游许可的权利。
> 闭源核心（`main.js` / `chat-engine.js` / `index.js` / `soul.js` / `soul-pack.js` / `*.soul` / `policy.html`）
> 不在本仓库，亦不受本仓库任何开源许可授予权利。