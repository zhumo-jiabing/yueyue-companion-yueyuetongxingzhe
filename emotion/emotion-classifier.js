// =============================================================
// emotion-classifier.js —— 玥玥情绪分类模块(utilityProcess 版)
// 阶段3a · 仅新建文件 · 与 main.js 的接线由后续任务统一完成
// 依据: 12-emotion.md / 14-integration-guide.md §2.3 §6 / 16-testcases.md 表A
// =============================================================
// 职责
//   1) transformers.js 加载 bge-small-zh-v1.5 编码器(fp32, CLS+L2 归一化)
//   2) onnxruntime-node 加载 train_emotion.py 导出的 emotion_head.onnx
//   3) 输出 {label, score, secondLabel, quote, toneHint, mood, registerHint}
//      或克制规则命中 → {label:null, reason:'...'}
// =============================================================
// 克制规则(12-emotion §4.2 + 14 §6 U5 + 16 表A A-12~A-14)
//   R1 去空白后 <2 字                → {label:null, reason:'too_short'}
//   R2 防御式否认句                  → {label:null, reason:'defensive_denial', toneHint:'温和陪伴'}
//   R3 score<0.55 或 top1-top2<0.15  → {label:null, reason:'low_confidence'}
//   R4 次要标签仅 score>=0.35 时附(至多 1 个)
//   R5 quote 只取原文 4-12 字
//   R6 label 必须 ∈ 8 规范词表, 映射不到→'平静'(14 §6 U1)
// 降级铁律(14 §2.3): 本模块任何失败都返回 {label:null, reason:'error'},
//   绝不抛出/挂死 —— 情绪模块不允许宕掉聊天主链路。
// =============================================================
// 运行形态(接线任务用, 详见 emotion-tools.md §5 接口契约)
//   主进程: utilityProcess.fork(path.join(__dirname,'emotion','emotion-classifier.js'), [], {
//             env: Object.assign({}, process.env, { EMOTION_MODELS_DIR: modelsDir }) })
//   消息协议: 父→子 {type:'classify', id, text} | 子→父 {type:'ready'} / {type:'result', id, result}
//   本地自测: node emotion-classifier.js --self-test
//              node emotion-classifier.js "今天发工资啦！晚上请你吃火锅！"
// =============================================================

'use strict';

const path = require('path');

// ---------- 契约常量(与 train_emotion.py 输出 / emotion-tools.md 保持一致) ----------
const LABELS = ['开心', '难过', '生气', '焦虑', '思念', '期待', '平静', '疲惫'];
const EMB_DIM = 512;                    // bge-small-zh-v1.5 输出维度
const MIN_SCORE = 0.55;                 // R3 主标签最低置信
const MIN_GAP = 0.15;                   // R3 top1 与 top2 最小差距
const SECOND_LABEL_MIN = 0.35;          // R4 次要标签门槛
const MIN_TEXT_LEN = 2;                 // R1 去空白后最小字数
const QUOTE_MIN = 4;
const QUOTE_MAX = 12;                   // R5

// tone_hint 词典(12-emotion §4.1, 写死在模块内)
const TONE_HINTS = {
  '开心': '陪开心并强化记忆点',
  '难过': '先共情，陪一会儿再轻推',
  '生气': '先承认合理性、降温，不抬杠',
  '焦虑': '把模糊担心具体化，给一个可做的小步骤',
  '思念': '接住并回应"我在"',
  '期待': '一起细化期待',
  '平静': '正常聊天',
  '疲惫': '不评判不催促，温和陪伴'
};

// 8 标签 → MOOD 17 映射(14 §6 U4; THINK_SYSTEM 另存一份, 由接线任务写入)
const MOOD_MAP = {
  '开心': 'happy', '难过': 'sad', '生气': 'serious', '焦虑': 'concerned',
  '思念': 'waiting', '期待': 'playful', '平静': 'idle', '疲惫': 'quiet_company'
};

// 14 §6 U6: 难过/焦虑/思念 且置信>=0.6 → registerHint='warm'(最终由思考脑决定)
const WARM_LABELS = ['难过', '焦虑', '思念'];
const WARM_MIN_SCORE = 0.6;

// R2 防御式否认句(12-emotion §4.2 规则3; 16 表A #8 / E-4)
const DENIAL_EXACT = [
  '我没事', '我没事的', '我没事啦', '我真的没事', '我没事真的没事', '没事', '没事的', '没事啦',
  '我很好', '我挺好的', '我还好', '不用管我', '别管我', '别担心我', '不用担心我', '我真没事', '没事没事'
];

// ---------- 工具函数 ----------
function stripForRules(text) {
  // 去空白/标点/emoji 变体选择符(用于长度与否认规则判断)
  return String(text || '')
    .replace(/[\s，。！？!?、~～…·,.]/g, '')
    .replace(/[\uFE0F\u200D]/g, '');
}

function isDefensiveDenial(text) {
  const s = stripForRules(text);
  if (DENIAL_EXACT.indexOf(s) >= 0) return true;
  // 含"真的没事/我没事"且整体很短(<=12 字)且没有"想"类词 → 防御式否认
  if (s.length <= 12 && /真的没事|我没事/.test(s) && !/想你|想念|只是|但是|就/.test(s)) return true;
  return false;
}

function pickQuote(text) {
  const s = String(text || '').trim();
  if (s.length <= QUOTE_MAX) return s;              // <=12 字: 全句
  const tail = s.slice(-QUOTE_MAX);                 // 长句: 取末 12 字(口语情绪多在句尾)
  return tail.length >= QUOTE_MIN ? tail : s.slice(0, QUOTE_MAX);
}

function softmax(logits) {
  const xs = Array.from(logits);
  let m = -Infinity;
  for (let i = 0; i < xs.length; i++) if (xs[i] > m) m = xs[i];
  let sum = 0;
  const exps = xs.map(function (x) { const e = Math.exp(x - m); sum += e; return e; });
  return exps.map(function (e) { return e / sum; });
}

function round4(x) { return Math.round(x * 10000) / 10000; }

function friendlyLoadError(err) {
  const m = err && err.message ? err.message : String(err);
  if (m.indexOf('Cannot find module') >= 0) {
    return '缺少 npm 依赖: 请在 resources\app 目录执行 npm install @huggingface/transformers onnxruntime-node (见 emotion-tools.md §4)';
  }
  return m;
}

// ---------- 分类器 ----------
class EmotionClassifier {
  constructor(opts) {
    opts = opts || {};
    this.modelsDir = opts.modelsDir || process.env.EMOTION_MODELS_DIR || path.join(__dirname, 'models');
    this.encoderId = opts.encoderId || process.env.EMOTION_ENCODER_ID || 'BAAI/bge-small-zh-v1.5';
    this.encoderPath = opts.encoderPath || process.env.EMOTION_ENCODER_DIR || null; // 本地已导出 ONNX 目录(optimum)
    this.encoderDtype = opts.encoderDtype || process.env.EMOTION_ENCODER_DTYPE || 'fp32';
    this.cacheDir = opts.cacheDir || process.env.EMOTION_CACHE_DIR || null;
    this.tokenizer = null;
    this.model = null;
    this.session = null;
    this.ort = null;
    this.labelMap = null;
    this.loadPromise = null;
    this.loadFailed = false;
    this.loggedOnce = false;
  }

  _load() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this._doLoad();
    return this.loadPromise;
  }

  async _doLoad() {
    try {
      const fs = require('fs');
      // 1. label_map.json(train_emotion.py 产出, 与内置 LABELS 互相校验)
      const lmPath = path.join(this.modelsDir, 'label_map.json');
      if (!fs.existsSync(lmPath)) throw new Error('label_map.json 缺失: ' + lmPath);
      const lm = JSON.parse(fs.readFileSync(lmPath, 'utf8'));
      if (!Array.isArray(lm.labels) || lm.labels.length !== LABELS.length ||
          lm.labels.some(function (l, i) { return l !== LABELS[i]; })) {
        throw new Error('label_map.json 词表与模块内置 LABELS 不一致, 请重新运行 train_emotion.py');
      }
      this.labelMap = lm;

      // 2. 编码器 bge-small-zh-v1.5(CLS + L2 归一化, 与训练时向量域一致)
      const tfjs = require('@huggingface/transformers');
      if (tfjs.env) tfjs.env.allowLocalModels = true;
      // 网络受限机器: HF_ENDPOINT(如 https://hf-mirror.com) 显式生效(transformers.js v4 不自动读取)
      if (process.env.HF_ENDPOINT && tfjs.env) tfjs.env.remoteHost = process.env.HF_ENDPOINT;
      if (this.cacheDir && tfjs.env) tfjs.env.cacheDir = this.cacheDir;
      const cands = [];
      if (this.encoderPath) cands.push(this.encoderPath);
      cands.push(this.encoderId);
      cands.push('Xenova/bge-small-zh-v1.5');
      const modelOpts = { dtype: this.encoderDtype };
      const tryLoad = async function () {
        let err = null;
        for (let i = 0; i < cands.length; i++) {
          const id = cands[i];
          try {
            this.tokenizer = await tfjs.AutoTokenizer.from_pretrained(id);
            this.model = await tfjs.AutoModel.from_pretrained(id, modelOpts);
            return null;
          } catch (e) { err = e; /* 逐个尝试, 记最后一个错误 */ }
        }
        return err;
      }.bind(this);
      let lastErr = await tryLoad();
      // 直连失败(网络受限)且未显式指定镜像 → 自动回退 hf-mirror 重试一次(2026-09-09 真机验证直连被墙)
      if (!this.model && tfjs.env && tfjs.env.remoteHost !== 'https://hf-mirror.com') {
        tfjs.env.remoteHost = 'https://hf-mirror.com';
        lastErr = await tryLoad();
      }
      if (!this.model) {
        throw new Error('编码器加载失败(尝试了: ' + cands.join(', ') + '): ' + friendlyLoadError(lastErr));
      }

      // 3. MLP 分类头(train_emotion.py 导出)
      this.ort = require('onnxruntime-node');
      this.session = await this.ort.InferenceSession.create(path.join(this.modelsDir, 'emotion_head.onnx'));
    } catch (err) {
      this.loadFailed = true;
      if (!this.loggedOnce) {
        this.loggedOnce = true;
        console.error('[emotion] 模型加载失败(将以 model_missing 降级):', friendlyLoadError(err));
      }
    }
  }

  async _embed(text) {
    await this._load();
    if (!this.model || !this.tokenizer) return null;
    // tokenize(v3 直接可调用; 兼容旧式 .encode)
    let inputs;
    try {
      inputs = await this.tokenizer(text, { truncation: true, max_length: 512 });
    } catch (e) {
      inputs = await this.tokenizer.encode(text, { truncation: true, max_length: 512 });
    }
    const outputs = await this.model(inputs);
    const hs = outputs && outputs.last_hidden_state;
    if (!hs || !hs.dims || hs.dims.length !== 3) return null;
    const seq = hs.dims[1];
    const d = hs.dims[2];
    const data = hs.data;
    // 取 CLS(首 token), L2 归一化 —— 与 sentence-transformers CLS+normalize 契约一致
    const cls = new Array(d);
    for (let i = 0; i < d; i++) cls[i] = data[i];
    let sum = 0;
    for (let i = 0; i < d; i++) sum += cls[i] * cls[i];
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < d; i++) cls[i] = cls[i] / norm;
    return cls;
  }

  async classify(rawText) {
    try {
      const text = String(rawText == null ? '' : rawText);
      // ---- 克制规则(在模型之前执行, 14 §6 U5) ----
      if (stripForRules(text).length < MIN_TEXT_LEN) {
        return { label: null, reason: 'too_short' };                       // R1: 如"哦。"
      }
      if (isDefensiveDenial(text)) {
        return { label: null, reason: 'defensive_denial', toneHint: '温和陪伴' }; // R2: 如"我没事，真的没事"
      }
      const vec = await this._embed(text);
      if (!vec || vec.length !== EMB_DIM) {
        return { label: null, reason: this.loadFailed ? 'model_missing' : 'error' };
      }
      const feed = { input: new this.ort.Tensor('float32', Float32Array.from(vec), [1, EMB_DIM]) };
      const out = await this.session.run(feed);
      const probs = softmax(out.logits.data);
      // top2
      const order = probs.map(function (p, i) { return i; }).sort(function (a, b) { return probs[b] - probs[a]; });
      const top1 = order[0];
      const top2 = order[1];
      const score = probs[top1];
      const gap = score - probs[top2];
      if (score < MIN_SCORE || gap < MIN_GAP) {
        return { label: null, reason: 'low_confidence' };                  // R3
      }
      let label = this.labelMap.labels[top1];
      if (LABELS.indexOf(label) < 0) label = '平静';                        // R6 兜底
      const second = probs[top2] >= SECOND_LABEL_MIN ? this.labelMap.labels[top2] : null; // R4
      return {
        label: label,
        score: round4(score),
        secondLabel: second,
        quote: pickQuote(text),                                            // R5
        toneHint: TONE_HINTS[label] || '正常聊天',
        mood: MOOD_MAP[label] || 'idle',                                    // 14 §6 U4
        registerHint: (WARM_LABELS.indexOf(label) >= 0 && score >= WARM_MIN_SCORE) ? 'warm' : null // U6
      };
    } catch (err) {
      if (!this.loggedOnce) {
        this.loggedOnce = true;
        console.error('[emotion] classify 异常(降级为 error):', friendlyLoadError(err));
      }
      return { label: null, reason: 'error' };                              // 降级铁律: 不抛不挂
    }
  }
}

// ---------- 表A 自测(16-testcases) ----------
const SELF_TEST_CASES = [
  { t: '今天发工资啦！晚上请你吃火锅！', expect: '开心' },
  { t: '我又没考上……是不是我真的很没用', expect: '难过' },
  { t: '这破电脑又卡了，气死我了！', expect: '生气' },
  { t: '明天要上台讲方案，我慌得睡不着', expect: '焦虑' },
  { t: '你都不回我消息……好想你啊', expect: '思念' },
  { t: '哦。', noLabel: true },
  { t: '哈哈笑死我了你这什么鬼主意', expect: '开心' },
  { t: '我没事，真的没事。', noLabel: true },
  { t: '终于把 bug 修好了，舒服！', expect: '开心' },
  { t: '唉……又一天过去了，什么都没做', accept: ['难过', '疲惫'] }
];

async function selfTest() {
  const cls = new EmotionClassifier({});
  let fixed = 0, fixedTotal = 0, noLabelOk = 0, noLabelTotal = 0, lastOk = false, modelUsable = false;
  for (let i = 0; i < SELF_TEST_CASES.length; i++) {
    const c = SELF_TEST_CASES[i];
    const r = await cls.classify(c.t);
    const no = String(i + 1);
    if (r.reason === 'model_missing' || r.reason === 'error') {
      console.log('#' + no + ' ' + c.t + ' -> ' + JSON.stringify(r) + '  SKIP(模型不可用)');
      continue;
    }
    modelUsable = true;
    let ok, note;
    if (c.noLabel) {
      noLabelTotal++;
      ok = r.label === null;
      if (ok) noLabelOk++;
      note = '克制:' + (r.reason || '');
    } else if (c.expect) {
      fixedTotal++;
      ok = r.label === c.expect;
      if (ok) fixed++;   // 2026-09-09 修复: 命中计数从未自增, 导致全 PASS 仍报 0/7
      note = (r.label || '无') + ' @' + r.score;
    } else {
      ok = r.label === null || c.accept.indexOf(r.label) >= 0;
      note = r.label ? (r.label + ' @' + r.score) : ('克制:' + r.reason);
      lastOk = ok;
    }
    console.log('#' + no + ' ' + c.t + ' -> ' + JSON.stringify(r) + '  ' + (ok ? 'PASS' : 'FAIL') + ' (' + note + ')');
  }
  if (!modelUsable) {
    console.log('未检测到可用模型: 请先按 emotion-tools.md 完成训练(步骤1)与 npm 依赖(步骤4)');
    process.exitCode = 2;
    return;
  }
  console.log('定标签命中 ' + fixed + '/' + fixedTotal + ' (16 表A 口径: >=6 通过) | 应克制 ' +
    noLabelOk + '/' + noLabelTotal + ' (#6/#8 必须全触发) | #10 ' + (lastOk ? 'PASS' : 'FAIL'));
  process.exitCode = (fixed >= 6 && noLabelOk === noLabelTotal && lastOk) ? 0 : 1;
}

// ---------- 入口 ----------
async function main() {
  const args = process.argv.slice(2);
  // utilityProcess 模式(Electron 主进程 fork 启动)
  if (process.parentPort) {
    const cls = new EmotionClassifier({});
    cls._load(); // 预热(失败不阻塞, classify 时再降级)
    process.parentPort.postMessage({ type: 'ready' });
    process.parentPort.on('message', async function (e) {
      const msg = (e && e.data) ? e.data : e;
      if (!msg || msg.type !== 'classify') return;
      const result = await cls.classify(msg.text);
      process.parentPort.postMessage({ type: 'result', id: msg.id || '', result: result });
    });
    return;
  }
  // CLI 模式(本地自测/调试)
  if (args[0] === '--self-test') { await selfTest(); return; }
  const text = args.join(' ').trim();
  if (!text) {
    console.error('用法: node emotion-classifier.js "句子"  或  node emotion-classifier.js --self-test');
    process.exitCode = 2;
    return;
  }
  const cls = new EmotionClassifier({});
  const r = await cls.classify(text);
  console.log(JSON.stringify(r, null, 2));
}

if (require.main === module) {
  main().catch(function (e) {
    console.error('[emotion] 未捕获异常:', friendlyLoadError(e));
    process.exitCode = 1;
  });
}

module.exports = { EmotionClassifier, LABELS, TONE_HINTS, MOOD_MAP, isDefensiveDenial, stripForRules, pickQuote };