#!/usr/bin/env python
r"""复核网格 —— 把"保留/丢弃"候选渲染成裁片网格, 人工一眼扫完

用法: <venv>\python.exe review_grid.py --labeled <标注目录> [--cols 14] [--cell 64]
输出: <标注目录>/review/kept_0.jpg, dropped_0.jpg (超长自动分页)
"""
import argparse, json, os
import cv2, numpy as np

def grid(items, path, keep, cols, cell):
    if not items: return None
    rows = (len(items) + cols - 1) // cols
    g = np.full((rows * cell, cols * cell, 3), 28, np.uint8)
    for i, it in enumerate(items):
        img, (x, y, w, h) = it["img"], it["box"]
        pad = 6
        crop = img[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
        ch, cw = crop.shape[:2]
        sc = max(1, min((cell - 10) // max(cw, 1), (cell - 10) // max(ch, 1), 4))
        cr = cv2.resize(crop, (cw * sc, ch * sc), interpolation=cv2.INTER_NEAREST)
        r_, c_ = divmod(i, cols)
        cl = g[r_ * cell:(r_ + 1) * cell, c_ * cell:(c_ + 1) * cell]
        cl[:] = (30, 45, 30) if keep else (45, 28, 28)
        oy, ox = max(0, (cell - cr.shape[0]) // 2), max(0, (cell - cr.shape[1]) // 2)
        cl[oy:oy + cr.shape[0], ox:ox + cr.shape[1]] = cr
        cv2.rectangle(cl, (0, 0), (cell - 1, cell - 1), (0, 200, 0) if keep else (0, 0, 220), 1)
    cv2.imwrite(path, g, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return g.shape

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labeled", required=True)
    ap.add_argument("--cols", type=int, default=14); ap.add_argument("--cell", type=int, default=64)
    a = ap.parse_args()
    d = json.load(open(os.path.join(a.labeled, "decisions.json"), encoding="utf-8"))
    cache = {}
    out = os.path.join(a.labeled, "review"); os.makedirs(out, exist_ok=True)
    for kind, key, keep in (("kept", "kept", True), ("dropped", "dropped", False)):
        items = []
        for name, rec in d["images"].items():
            if rec["path"] not in cache: cache[rec["path"]] = cv2.imread(rec["path"])
            img = cache[rec["path"]]
            for c in rec.get(key, []):
                items.append({"img": img, "box": tuple(c[:4])})
        if not items:
            print(f"{kind}: 0 个"); continue
        shape = grid(items, os.path.join(out, f"{kind}_0.jpg"), keep, a.cols, a.cell)
        print(f"{kind}: {len(items)} 个 -> {out}\\{kind}_0.jpg {shape}")
    print("复核判定: 保留集出现非目标=规则太松; 丢弃集出现真目标=规则太紧")

if __name__ == "__main__":
    main()
