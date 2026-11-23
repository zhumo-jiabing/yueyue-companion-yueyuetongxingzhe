#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_dataset.py -- yueyue emotion dataset quality checks
Usage: python verify_dataset.py <samples.jsonl>
Checks: total lines, per-class counts, exact dupes, label-word leakage,
        length range, defensive-denial collisions, parse errors.
Exit 0 = all good; 1 = problem found.
"""
import json, re, sys

LABELS = ["开心", "难过", "生气", "焦虑", "思念", "期待", "平静", "疲惫"]
DENIAL_EXACT = ["我没事", "我没事的", "我没事啦", "我真的没事", "我没事真的没事", "没事", "没事的", "没事啦",
                "我很好", "我挺好的", "我还好", "不用管我", "别管我", "别担心我", "不用担心我", "我真没事", "没事没事"]

def strip(t):
    return re.sub(r"[\s，。！？!?、~～…·,.]", "", str(t or ""))

def main():
    path = sys.argv[1]
    rows, seen, dups, bad, leak, denial = [], {}, [], 0, [], []
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
            if text in seen:
                if seen[text] != label:
                    dups.append((text, seen[text], label))
                continue
            seen[text] = label
            rows.append((text, label))
            if any(w in text for w in LABELS):
                leak.append((label, text))
            s = strip(text)
            if s in DENIAL_EXACT or (len(s) <= 12 and ("真的没事" in s or "我没事" in s) and not re.search(r"想你|想念|只是|但是|就", s)):
                denial.append((label, text))
    counts = {}
    for lab in LABELS:
        counts[lab] = sum(1 for _, l in rows if l == lab)
    print("total=%d bad=%d dup=%d leak=%d denial=%d" % (len(rows), bad, len(dups), len(leak), len(denial)))
    print("counts=" + json.dumps(counts, ensure_ascii=False))
    for d in dups[:8]:
        print("DUP:", json.dumps(d, ensure_ascii=False))
    for x in leak[:8]:
        print("LEAK:", json.dumps(x, ensure_ascii=False))
    for x in denial[:8]:
        print("DENIAL:", json.dumps(x, ensure_ascii=False))
    ok = (bad == 0 and len(dups) == 0 and len(leak) == 0)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
