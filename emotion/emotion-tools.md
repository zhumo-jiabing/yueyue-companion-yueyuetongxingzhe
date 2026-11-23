# emotion-tools · 情绪模块(阶段3a)在用户机器上的完整操作步骤 + 接线接口契约

> ⚠ **第97轮审计注记**：下文里的 `G:\免费版开发\...` 是第91轮已删除的旧开发树路径，照抄会踩空；
> 现在的真源是 `K:\yueyueneiceban\win-unpacked\resources\app`，下文命令里的 `app\emotion\...` 相对路径
> 都以它为准。`G:\YueyueAI\venv-emotion` / `venv-asr` 的 venv 路径以本机实际安装为准（坏 venv 待清理）。
> 本文件是训练期文档，代码不读它；head_meta.json 是训练产物快照（每次训练自动重写），里面的旧路径不用改。
>
> 运行机=训练机=用户机器(本地隐私: 数据不出机器, 训练也是一次性本地动作)。
> 产物: app\emotion\models\emotion_head.onnx + label_map.json(由 train_emotion.py 直接输出)。
> 本阶段只创建了 emotion 目录下的新文件, 未改任何现有 app 文件; 接线由后续任务统一做(见 §5)。

## 1. 目录与文件

G:\免费版开发\win-unpacked\resources\app\emotion
    train_emotion.py          训练/导出脚本(python, 仅训练期用, 不必打进发行包)
    dataset_skeleton.md       500 条标注模板与规则
    samples_template.jsonl    40 条起步样例(复制为 data\samples.jsonl 后补到 500)
    emotion-classifier.js     Node 端分类模块(utilityProcess 版, 由接线任务启用)
    emotion-tools.md          本文
    models\                  训练输出: emotion_head.onnx / label_map.json / head_meta.json
    data\                    标注数据(自建): samples.jsonl 500 条 / testcases_a.jsonl(表A 10 条, 可选)

## 2. 训练机依赖(一次性)

    python -m venv G:\YueyueAI\venv-emotion
    G:\YueyueAI\venv-emotion\Scripts\python.exe -m pip install -U pip
    G:\YueyueAI\venv-emotion\Scripts\pip install sentence-transformers torch onnx

- 可复用 G:\YueyueAI\venv-asr 已装的 CPU 版 torch(省 2-3GB 磁盘), 在该 venv 里补装 sentence-transformers 与 onnx 即可
- 若要 --export-encoder(完全离线给 transformers.js 用): 加装 "optimum[onnxruntime]"
- 首次加载 BAAI/bge-small-zh-v1.5 约 100MB; 下载慢先设: $env:HF_ENDPOINT='https://hf-mirror.com'

## 3. 操作步骤(步骤 0 → 4)

步骤 0 · 备数据
    复制 samples_template.jsonl 为 data\samples.jsonl, 按 dataset_skeleton.md 规则补到 500 条(每类 60-65)。

步骤 1 · 训练(几分钟内完成, 头只有 512→256→8)
    G:\YueyueAI\venv-emotion\Scripts\python.exe app\emotion\train_emotion.py --data app\emotion\data\samples.jsonl --out app\emotion\models
    看输出: 验证集 acc / macro-F1 与脚本的"结论"提示。
    目标: macro-F1 >= 0.65 且 acc >= 0.70 → 可接线; 边缘/不达标按提示扩数据(见 dataset_skeleton §5)。

步骤 2 · 表A 验收(可选但建议)
    把 16-testcases 表 A 的 10 条写成 data\testcases_a.jsonl(字段 text + expected_label, 预期克制的行 expected_label 留空),
    然后:
    G:\YueyueAI\venv-emotion\Scripts\python.exe app\emotion\train_emotion.py --data app\emotion\data\samples.jsonl --out app\emotion\models --eval-lines app\emotion\data\testcases_a.jsonl
    要求: 定标签命中 >=7/9, 且 #6/#8/#10 触发克制。

步骤 3 · Node 端自测(需先完成 §4 的 npm 依赖)
    cd G:\免费版开发\win-unpacked\resources\app
    node emotion\emotion-classifier.js --self-test
    要求: 定标签命中 >=6/7(表A 定标签用例), #6/#8 必触发克制, #10 不误标; 退出码 0。

步骤 4 · 接线启用
    由后续"接线任务"在 main.js 挂 utilityProcess(见 §5), 本阶段不做。

## 4. Node 侧依赖(接线任务执行)

在 resources\app 目录:

    npm install @huggingface/transformers onnxruntime-node --save

- 打包环境: 让打包机先装好再打; transformers.js 首次运行会下载 bge-small-zh-v1.5 ONNX 权重(约 100MB fp32)
- 加速下载: 设环境变量 HF_ENDPOINT=https://hf-mirror.com(transformers.js v3 读取)
- 完全离线: 先用 train_emotion.py --export-encoder 导出到 models\encoder, 并设环境变量 EMOTION_ENCODER_DIR 指向该目录
- 换编码器源: 设 EMOTION_ENCODER_ID(默认 BAAI/bge-small-zh-v1.5, 备选 Xenova/bge-small-zh-v1.5)
- 模型目录: 设 EMOTION_MODELS_DIR(默认 <模块所在目录>\models)
- 编码精度: EMOTION_ENCODER_DTYPE 默认 fp32(q8 可省内存但需实测输出反量化, 暂不推荐)

## 5. 接口契约(给接线任务的硬约束)

5.1 进程形态
    主进程: utilityProcess.fork(path.join(__dirname,'emotion','emotion-classifier.js'), [], {
               env: Object.assign({}, process.env, { EMOTION_MODELS_DIR: modelsDir }) })
    消息协议: 父→子 {type:'classify', id, text} | 子→父 {type:'ready'} / {type:'result', id, result}

5.2 IPC(renderer 侧, 名称已拍板 14 §2.3)
    名称: emotion:classify
    形式: ipcRenderer.invoke('emotion:classify', {text})
    返回: 见 5.3 result schema

5.3 result schema

    命中:
      { label, score, secondLabel|null, quote, toneHint, mood, registerHint|null }
      label ∈ 8 规范词表(开心/难过/生气/焦虑/思念/期待/平静/疲惫)
      score ∈ [0,1] (>=0.55 且 top1-top2>=0.15 才会命中)
      quote = 原文 4-12 字
      mood = U4 映射(happy/sad/serious/concerned/waiting/playful/idle/quiet_company)
      registerHint = 'warm'|null(U6: 难过/焦虑/思念 且 score>=0.6 时为 'warm')
    不贴:
      { label:null, reason: 'too_short'|'defensive_denial'|'low_confidence'|'model_missing'|'error' }
      defensive_denial 时附 toneHint:'温和陪伴'(可注入 tone 指导, 但不得生成[情绪感知]块)

5.4 接线铁律(14 §2.3 原样)
    - 调用加 800ms 超时; 超时/异常一律视同 {label:null, reason:'error'}
    - 任何失败不得阻塞聊天主链路(思考脑按"无情绪标签"运行)
    - [情绪感知]块仅在 result.label 非空时拼入(模板见 5.5)
    - 结果禁止落库/进长期记忆/成长值(14 §6 规则5/U5; 只做思考脑软提示 + 本地埋点计数)

5.5 [情绪感知] 注入模板(12-emotion §4.1 原样)
    双脑路径(T1): 拼进 thinkUser(14 §6 U2); 单脑路径(T0/思考脑失败): 拼进说话嘴 system 追加块(14 §6 U3)

    [情绪感知]（本地情感模型自动附加；无把握时整块省略）
    用户情绪：{label}（置信度 {score:.2f}）
    依据片段：“{quote}”（原文 4-12 字）
    回应基调：{toneHint}
    [情绪感知结束]

    # 使用规则（对思考脑）
    - 这是"线索"不是"结论"：不要直接断言"你现在很难过"，用"听起来你有点{label}"这类软化表达
    - 先接住情绪再给内容；禁止评判、禁止诊断、禁止说教
    - 该段不存在时，按平常方式回应，禁止自行猜测用户情绪

5.6 与 14 §6 统一方案的对应检查单
    U1 词表收敛: 模块只输出 8 规范标签(R6 兜底)
    U2/U3 注入方向: 见 5.5
    U4 MOOD: 接线取 result.mood 作 mood_tag 默认值(思考脑可覆盖; 16 表A B-12)
    U5 克制前置: R1-R3 已在模块内完成(接线勿重复过滤, 只处理返回的 null label)
    U6 register: result.registerHint==='warm' 时, THINK_SYSTEM 允许 register 默认 warm

## 6. 验收断言对照(16-testcases)

- A-11 词表 / A-12 阈值(0.55 与 top2 差 0.15) / A-13 次要标签(>=0.35 至多 1) / A-14 quote 4-12 字
  → 全部在 emotion-classifier.js 内实现(§2 克制规则 R3/R4/R5/R6), 用 --self-test 验证
- B-10 情绪线索注入 → 接线任务用 mock 验: thinkUser 含/不含[情绪感知]块
- B-12 MOOD 联动 → result.mood 与 mood_tag 一致性(置信 >=0.7 且无冲突证据时)
- E-2 短句"嗯，还行吧" → too_short 或 low_confidence, 不贴
- E-4 "我没事，真的没事" → defensive_denial, 不贴, 且两脑路径基调一致

## 7. 常见问题

- HF 下载慢/失败: $env:HF_ENDPOINT='https://hf-mirror.com'(python 与 node 端都认)
- transformers.js 报"缺 onnx 权重": 用 optimum 导出(§2)并设 EMOTION_ENCODER_DIR, 或设 EMOTION_ENCODER_ID=Xenova/bge-small-zh-v1.5 再试
- 控制台中文乱码: 训练脚本已强制 utf-8 输出; 若仍乱, 换 Windows Terminal / PowerShell 7
- jsonl 读取报错: 数据文件必须 UTF-8 无 BOM(模板已按此生成)
- 训练集有标签词泄漏(text 里出现"开心/难过"等): 按 dataset_skeleton 规则 3 清洗后重训
- 想加/改标签: 需同步改 LABELS(train_emotion.py 与 emotion-classifier.js 两处)+TONE_HINTS/MOOD_MAP+重训+改 label_map.json; 不推荐在 8 词表外新增(14 §6 U1)
- 换编码器(bge-base-zh-v1.5 1024 维): 改 train_emotion.py 的 ENCODER_ID 与 EMB_DIM、emotion-classifier.js 的 EMB_DIM, 重训重导出
