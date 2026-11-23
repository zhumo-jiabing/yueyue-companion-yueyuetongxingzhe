#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
train_emotion.py —— 玥玥情绪分类头 训练/导出脚本(阶段3a · 仅新建文件)

已拍板方案(14-integration-guide.md §0 拍板4 / 12-emotion.md):
  BAAI/bge-small-zh-v1.5 冻结作编码器 + 自训 MLP 8 类分类头
  权威 8 标签: 开心 / 难过 / 生气 / 焦虑 / 思念 / 期待 / 平静 / 疲惫

数据格式(jsonl, 每行一条, UTF-8 无 BOM):
  {"text": "今天发工资啦！晚上请你吃火锅！", "label": "开心"}
  text: 2-30 字口语短句(语气词/emoji 允许); label: 必须属于 8 标签
  以 # 开头的行是注释, 自动跳过。标注规则见同目录 dataset_skeleton.md。

用法:
  python train_emotion.py --data emotion\data\samples.jsonl --out emotion\models
  python train_emotion.py --data emotion\data\samples.jsonl --out emotion\models --eval-lines emotion\data\testcases_a.jsonl
  python train_emotion.py --data emotion\data\samples.jsonl --out emotion\models --export-encoder

输出(--out 目录, 由 emotion-classifier.js 消费):
  emotion_head.onnx   MLP 分类头(512→256→8, 约 1-2MB, onnxruntime-node 加载)
  label_map.json      {"labels":[...], "mood_map":{...}}(与 emotion-classifier.js 内置词表互相校验)
  head_meta.json      训练记录(样本数/类分布/验证集 acc/macro-F1/混淆矩阵/参数/时间)
  emb_cache_*.npz     嵌入缓存(重训免重复编码, 可删)

500 条最小集的预期精度目标(训练完成后脚本会按此给结论):
  macro-F1 >= 0.65 且 acc >= 0.70  -> 可接线(模型放进 app\emotion\models)
  0.55 <= macro-F1 < 0.65         -> 建议扩数据: 每类补到 >=100 条, 优先补低频混淆对
  macro-F1 < 0.55                  -> 必须扩数据: 2000+ 条(每类 >=250), 先不接线

继续扩数据的路径(按性价比排序):
  1. 难例挖掘: 把 --eval-lines 与真实使用中错判的样本人工复核后入集
  2. 同义改写: 换句式/语气词/emoji 改写现有样本(每条最多 2-3 个变体, 防句式过拟合)
  3. 补齐低频类: 思念/期待/疲惫 最易混, 每类 60-65 起步
  4. 仍卡住: 换 bge-base-zh-v1.5(1024 维)重训, 或按 12-emotion 备选2 上 Qwen3-0.6B 微调

依赖(仅训练机):
  pip install sentence-transformers torch onnx
  --export-encoder 另需: pip install "optimum[onnxruntime]"
  提示: 可复用 G:\YueyueAI\venv-asr 已装的 CPU 版 torch(省 2-3GB 磁盘)
"""

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time

try:
    import numpy as np
except ImportError:
    sys.exit("缺少 numpy: pip install numpy")
try:
    import torch
    import torch.nn as nn
except ImportError:
    sys.exit("缺少 torch: pip install torch (可复用 venv-asr 的 CPU 版)")

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

LABELS = ["开心", "难过", "生气", "焦虑", "思念", "期待", "平静", "疲惫"]
MOOD_MAP = {
    "开心": "happy", "难过": "sad", "生气": "serious", "焦虑": "concerned",
    "思念": "waiting", "期待": "playful", "平静": "idle", "疲惫": "quiet_company",
}
EMB_DIM = 512  # bge-small-zh-v1.5 输出维度(CLS + L2 归一化, 与 emotion-classifier.js 编码契约一致)
ENCODER_ID = "BAAI/bge-small-zh-v1.5"

# 与 emotion-classifier.js 的 R1/R2 克制规则保持一致的简化版(两处同步义务见文件头注释)
DENIAL_EXACT = ["我没事", "我没事的", "我没事啦", "我真的没事", "我没事真的没事", "没事", "没事的", "没事啦",
                "我很好", "我挺好的", "我还好", "不用管我", "别管我", "别担心我", "不用担心我", "我真没事", "没事没事"]


def _strip(text):
    return re.sub(r"[\s，。！？!?、~～…·,.]", "", str(text or ""))


def runtime_gate(text):
    """R1/R2 模拟(与 JS 端一致): 返回 None=通过, 否则返回克制原因"""
    s = _strip(text)
    if len(s) < 2:
        return "too_short"
    if s in DENIAL_EXACT or (len(s) <= 12 and ("真的没事" in s or "我没事" in s)
                             and not re.search(r"想你|想念|只是|但是|就", s)):
        return "defensive_denial"
    return None


def load_data(path):
    rows, dup, bad, short = [], 0, 0, 0
    seen = {}
    with open(path, "r", encoding="utf-8") as f:
        for ln, line in enumerate(f, 1):
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            try:
                item = json.loads(line)
            except Exception:
                bad += 1
                continue
            text = str(item.get("text", "")).strip()
            label = str(item.get("label", "")).strip()
            if not text or label not in LABELS:
                bad += 1
                continue
            if len(text) < 2:
                short += 1
                continue
            if text in seen:
                if seen[text] != label:
                    dup += 1
                continue
            seen[text] = label
            rows.append((text, LABELS.index(label)))
    print("数据统计: 有效 %d 条 | 重复文本冲突 %d | 非法行 %d | 过短跳过 %d" % (len(rows), dup, bad, short))
    return rows


def print_class_counts(rows):
    counts = np.bincount([lab for _, lab in rows], minlength=len(LABELS))
    print("类分布(目标每类 60-65):")
    for i, name in enumerate(LABELS):
        flag = "  <-- 偏少, 建议补到 60+" if counts[i] < 50 else ""
        print("  %s: %d%s" % (name, int(counts[i]), flag))


def stratified_split(rows, val_ratio, seed):
    rng = random.Random(seed)
    by_label = {}
    for i, (_, lab) in enumerate(rows):
        by_label.setdefault(lab, []).append(i)
    tr, va = [], []
    for lab, idxs in by_label.items():
        rng.shuffle(idxs)
        n_val = max(1, int(round(len(idxs) * val_ratio)))
        va.extend(idxs[:n_val])
        tr.extend(idxs[n_val:])
    rng.shuffle(tr)
    rng.shuffle(va)
    return tr, va


def embed_texts(texts, out_dir):
    from sentence_transformers import SentenceTransformer
    key = hashlib.sha256(("\n".join(sorted(texts))).encode("utf-8")).hexdigest()[:10]
    cache = os.path.join(out_dir, "emb_cache_%s.npz" % key)
    if os.path.exists(cache):
        print("命中嵌入缓存:", cache)
        return np.load(cache)["embeddings"].astype(np.float32)
    print("加载编码器 %s (首次会下载约 100MB; 慢请先设 HF_ENDPOINT=https://hf-mirror.com)..." % ENCODER_ID)
    model = SentenceTransformer(ENCODER_ID)
    print("开始编码 %d 条(CPU)..." % len(texts))
    embs = model.encode(texts, batch_size=64, normalize_embeddings=True, show_progress_bar=True)
    embs = embs.astype(np.float32)
    np.savez_compressed(cache, embeddings=embs)
    print("嵌入已缓存:", cache)
    return embs


class MLPHead(nn.Module):
    """512 -> hidden -> 8; 输入必须是 bge CLS 且 L2 归一化后的向量(与 JS 端契约一致)"""

    def __init__(self, dim, hidden, n_classes, dropout=0.25):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(dim, hidden), nn.ReLU(), nn.Dropout(dropout),
            nn.Linear(hidden, n_classes))

    def forward(self, x):
        return self.net(x)


def metrics(y_true, probs):
    pred = probs.argmax(1)
    acc = float((pred == y_true).mean())
    f1s = []
    for c in range(len(LABELS)):
        tp = float(((pred == c) & (y_true == c)).sum())
        fp = float(((pred == c) & (y_true != c)).sum())
        fn = float(((pred != c) & (y_true == c)).sum())
        f1s.append(2 * tp / (2 * tp + fp + fn + 1e-9))
    return acc, float(np.mean(f1s))


def confusion_matrix(y_true, pred, n_cls):
    cm = np.zeros((n_cls, n_cls), dtype=np.int64)
    for t, p in zip(y_true, pred):
        cm[t][p] += 1
    return cm


def train_head(X_tr, y_tr, X_va, y_va, args):
    torch.manual_seed(args.seed)
    n_cls = len(LABELS)
    counts = np.bincount(y_tr, minlength=n_cls).astype(np.float32)
    w = counts.sum() / (n_cls * counts + 1e-6)
    w = w / w.mean()  # 类平衡权重
    model = MLPHead(EMB_DIM, args.hidden, n_cls, args.dropout)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=1e-4)
    lossf = nn.CrossEntropyLoss(weight=torch.tensor(w, dtype=torch.float32))
    Xt = torch.tensor(X_tr)
    yt = torch.tensor(y_tr, dtype=torch.long)
    Xv = torch.tensor(X_va)
    yv = torch.tensor(y_va, dtype=torch.long)
    best_f1, best_acc, best_state, bad = 0.0, 0.0, None, 0
    for ep in range(1, args.epochs + 1):
        model.train()
        perm = torch.randperm(len(Xt))
        for i in range(0, len(Xt), args.batch):
            idx = perm[i:i + args.batch]
            opt.zero_grad()
            loss = lossf(model(Xt[idx]), yt[idx])
            loss.backward()
            opt.step()
        model.eval()
        with torch.no_grad():
            pv = torch.softmax(model(Xv), dim=1).numpy()
            acc, macro_f1 = metrics(y_va, pv)
        if macro_f1 > best_f1:
            best_f1, best_acc = macro_f1, acc
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
            bad = 0
        else:
            bad += 1
            if bad >= args.patience:
                print("早停 @ epoch %d (patience %d)" % (ep, args.patience))
                break
    model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        pv = torch.softmax(model(Xv), dim=1).numpy()
        pred = pv.argmax(1)
    return model, best_acc, best_f1, confusion_matrix(y_va, pred, n_cls)


def export_onnx(model, out_path):
    try:
        import onnx  # noqa: F401  (torch>=2.1 导出需要 onnx 包)
    except ImportError:
        sys.exit("缺少 onnx 包: pip install onnx")
    dummy = torch.zeros(1, EMB_DIM)
    model.eval()
    torch.onnx.export(
        model, dummy, out_path,
        input_names=["input"], output_names=["logits"],
        dynamic_axes={"input": {0: "batch"}, "logits": {0: "batch"}},
        opset_version=17)
    print("已导出:", out_path, "(约 %.2f MB)" % (os.path.getsize(out_path) / 1e6))


def eval_table_a(path, model):
    """16-testcases 表 A 验收(训练后自测): jsonl 每行 {"text","expected_label"(可选, 空=预期克制)}"""
    from sentence_transformers import SentenceTransformer
    print("\n===== 表A 验收(--eval-lines) =====")
    encoder = SentenceTransformer(ENCODER_ID)
    lines = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            item = json.loads(line)
            lines.append((str(item.get("text", "")).strip(), str(item.get("expected_label", "")).strip()))
    texts = [t for t, _ in lines]
    embs = encoder.encode(texts, batch_size=16, normalize_embeddings=True)
    with torch.no_grad():
        probs = torch.softmax(model(torch.tensor(embs.astype(np.float32))), dim=1).numpy()
    hits = 0
    gate_hits = 0
    for i, ((text, expected), p) in enumerate(zip(lines, probs), 1):
        gate = runtime_gate(text)
        order = np.argsort(-p)
        s1, s2 = float(p[order[0]]), float(p[order[1]])
        pred = LABELS[int(order[0])]
        if gate:
            if not expected:
                gate_hits += 1
            print("#%d %r -> 克制:%s(不贴) 预期:%s  %s" % (i, text, gate, expected or "不贴",
                                                            "PASS" if not expected else "FAIL(预期贴标签)"))
            continue
        if s1 < 0.55 or (s1 - s2) < 0.15:
            if not expected:
                gate_hits += 1
            print("#%d %r -> low_confidence(不贴, %.2f/%.2f) 预期:%s  %s" % (i, text, s1, s2, expected or "不贴",
                                                                             "PASS" if not expected else "FAIL(预期贴标签)"))
            continue
        ok = (pred == expected) if expected else False
        if ok:
            hits += 1
        print("#%d %r -> %s(%.2f, top2=%s %.2f) 预期:%s  %s" % (i, text, pred, s1, LABELS[int(order[1])], s2,
                                                                expected or "不贴", "PASS" if ok else "FAIL"))
    print("定标签命中 %d 条 | 克制触发 %d 条 | 表A 口径: 命中>=7/9 且 #6/#8/#10 触发克制" % (hits, gate_hits))


def export_encoder_onnx(out_dir):
    import subprocess
    try:
        r = subprocess.run(
            ["optimum-cli", "export", "onnx", "--model", ENCODER_ID, "--task", "feature-extraction", out_dir],
            capture_output=True, text=True, timeout=1800)
        print("optimum 返回码:", r.returncode)
        if r.returncode != 0:
            print("optimum stderr(前 500 字):", r.stderr[:500])
        else:
            print("编码器 ONNX 已导出:", out_dir, "(给 transformers.js 本地加载, 设 EMOTION_ENCODER_DIR 指向它)")
    except FileNotFoundError:
        print('未找到 optimum-cli: pip install "optimum[onnxruntime]" 后重试 --export-encoder')


def main():
    ap = argparse.ArgumentParser(description="玥玥情绪分类头训练/导出")
    ap.add_argument("--data", required=True, help="jsonl 标注数据路径")
    ap.add_argument("--out", required=True, help="输出目录(建议 app\emotion\models)")
    ap.add_argument("--eval-lines", default=None, help="可选: 表A 验收 jsonl(text+expected_label)")
    ap.add_argument("--epochs", type=int, default=120)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--hidden", type=int, default=256)
    ap.add_argument("--dropout", type=float, default=0.25)
    ap.add_argument("--val-ratio", type=float, default=0.2)
    ap.add_argument("--patience", type=int, default=20)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--export-encoder", action="store_true", help="用 optimum 导出编码器 ONNX 到 --out\encoder")
    args = ap.parse_args()

    rows = load_data(args.data)
    if len(rows) < 80:
        print("警告: 样本过少(<80), 结果仅作调试参考; 最小集目标是 500 条")
    print_class_counts(rows)
    os.makedirs(args.out, exist_ok=True)

    texts = [t for t, _ in rows]
    embs = embed_texts(texts, args.out)
    tr, va = stratified_split(rows, args.val_ratio, args.seed)
    labs = np.array([lab for _, lab in rows])
    X_tr, y_tr = embs[tr], labs[tr]
    X_va, y_va = embs[va], labs[va]
    print("划分: 训练 %d / 验证 %d" % (len(tr), len(va)))

    model, val_acc, val_f1, cm = train_head(X_tr, y_tr, X_va, y_va, args)

    export_onnx(model, os.path.join(args.out, "emotion_head.onnx"))

    lm = {"labels": LABELS, "mood_map": MOOD_MAP, "emb_dim": EMB_DIM, "encoder": ENCODER_ID}
    with open(os.path.join(args.out, "label_map.json"), "w", encoding="utf-8") as f:
        json.dump(lm, f, ensure_ascii=False, indent=2)
    print("已导出: label_map.json")

    class_counts = np.bincount(labs, minlength=len(LABELS))
    meta = {
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "n_samples": len(rows), "n_train": len(tr), "n_val": len(va),
        "val_acc": round(val_acc, 4), "val_macro_f1": round(val_f1, 4),
        "class_counts": {LABELS[i]: int(class_counts[i]) for i in range(len(LABELS))},
        "confusion": [[int(v) for v in row] for row in cm],
        "args": vars(args),
    }
    with open(os.path.join(args.out, "head_meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("已导出: head_meta.json")

    if args.export_encoder:
        export_encoder_onnx(os.path.join(args.out, "encoder"))

    if args.eval_lines:
        eval_table_a(args.eval_lines, model)

    print("")
    print("================ 结论(500 条最小集口径) ================")
    print("验证集 acc=%.4f  macro-F1=%.4f" % (val_acc, val_f1))
    if val_f1 >= 0.65 and val_acc >= 0.70:
        print("达标: 可接线(模型已写入 %s; 想提质再补难例)" % args.out)
    elif val_f1 >= 0.55:
        print("边缘: 建议扩数据(每类补到 >=100 条, 优先补低频混淆对)后重训")
    else:
        print("不达标: 必须扩数据到 2000+ 条(每类 >=250); 仍卡住 → bge-base-zh-v1.5 或 Qwen3-0.6B 路线")


if __name__ == "__main__":
    main()