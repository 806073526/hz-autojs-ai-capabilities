#!/usr/bin/env python
r"""规则自动标注: 颜色双通道 + 尺寸/面积/长宽比/封闭白/圆形度 (+可选固定区域类)

用法:
  <venv>\python.exe autolabel.py --src <采图目录> --out <标注目录> \
      --nav-centers 125,300,470,640,810,985 --nav-y 1768,1852 --nav-half-width 82
输出:
  <out>/labels/<name>.txt    YOLO 标注 (class 0=badge, 1=nav; 用 --class-order 调整)
  <out>/decisions.json       保留/丢弃明细(供 review_grid.py 复核)
"""
import argparse, glob, json, os
import cv2, numpy as np

def iou(a, b):
    ax, ay, aw, ah = a[:4]; bx, by, bw, bh = b[:4]
    x1, y1 = max(ax, bx), max(ay, by); x2, y2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    u = aw * ah + bw * bh - inter
    return inter / u if u > 0 else 0

def raw_candidates(img, smin, smax, amin, amax):
    b, g, r = img[:, :, 0].astype(int), img[:, :, 1].astype(int), img[:, :, 2].astype(int)
    d = r - np.maximum(g, b); cands = []
    for tag, mask in (("bright", (d > 60) & (r > 170)),
                      ("dim", (d > 22) & (r > 40) & (d > 0.45 * r))):
        mm = cv2.morphologyEx(mask.astype(np.uint8) * 255, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        n, lab, st, _ = cv2.connectedComponentsWithStats(mm, 8)
        for i in range(1, n):
            x, y, w, h, a = [int(v) for v in st[i]]
            if not (smin <= w <= smax and smin <= h <= smax and amin <= a <= amax):
                continue
            cm = (lab[y:y + h, x:x + w] == i).astype(np.uint8) * 255
            cnts, _ = cv2.findContours(cm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            if not cnts: continue
            A = cv2.contourArea(cnts[0]); P = cv2.arcLength(cnts[0], True)
            circ = 4 * np.pi * A / (P * P) if P > 0 else 0
            cands.append((x, y, w, h, a, tag, round(float(circ), 3)))
    cands.sort(key=lambda c: (c[5] != "bright", -c[4]))
    keep = []
    for c in cands:
        if all(iou(c, k) < 0.4 for k in keep): keep.append(c)
    return keep

def enclosed_white(img, x, y, w, h, pad=2):
    p = img[max(0, y - pad):y + h + pad, max(0, x - pad):x + w + pad]
    hsv = cv2.cvtColor(p, cv2.COLOR_BGR2HSV)
    W = ((hsv[:, :, 2] > 140) & (hsv[:, :, 1] < 100)).astype(np.uint8)
    if W.sum() == 0: return 0
    ff = W.copy(); hh, ww = W.shape; m = np.zeros((hh + 2, ww + 2), np.uint8)
    for xx in range(ww):
        if ff[0, xx]: cv2.floodFill(ff, m, (xx, 0), 0)
        if ff[hh - 1, xx]: cv2.floodFill(ff, m, (xx, hh - 1), 0)
    for yy in range(hh):
        if ff[yy, 0]: cv2.floodFill(ff, m, (0, yy), 0)
        if ff[yy, ww - 1]: cv2.floodFill(ff, m, (ww - 1, yy), 0)
    return int(ff.sum())

def detect(img, cfg):
    kept, dropped = [], []
    for x, y, w, h, a, tag, circ in raw_candidates(img, cfg["size_min"], cfg["size_max"], cfg["area_min"], cfg["area_max"]):
        ar = w / h
        white = enclosed_white(img, x, y, w, h)
        reasons = []
        if not (cfg["aspect_min"] <= ar <= cfg["aspect_max"]): reasons.append(f"aspect={ar:.2f}")
        if white < cfg["white_min"]: reasons.append(f"white={white}")
        if circ < cfg["circ_min"]: reasons.append(f"circ={circ:.2f}")
        rec = [x, y, w, h, a, round(ar, 2), circ, white, tag]
        (kept if not reasons else dropped).append(rec if not reasons else rec + ["|".join(reasons)])
    return kept, dropped

def nav_boxes(W, H, centers, half_width, y1, y2):
    out = []
    for cx in centers:
        x1, x2 = max(0, cx - half_width), min(W, cx + half_width)
        out.append((x1, y1, x2 - x1, y2 - y1))
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--size-min", type=int, default=13); ap.add_argument("--size-max", type=int, default=33)
    ap.add_argument("--area-min", type=int, default=140); ap.add_argument("--area-max", type=int, default=700)
    ap.add_argument("--aspect-min", type=float, default=0.55); ap.add_argument("--aspect-max", type=float, default=1.8)
    ap.add_argument("--circ-min", type=float, default=0.6); ap.add_argument("--white-min", type=int, default=2)
    ap.add_argument("--nav-centers", default=""); ap.add_argument("--nav-y", default="1768,1852")
    ap.add_argument("--nav-half-width", type=int, default=82)
    ap.add_argument("--no-label", default="", help="整图留空的图名(逗号分隔, 经人工复核的负样本)")
    ap.add_argument("--no-nav", default="", help="只标目标类、不加固定区域类的图名(逗号分隔)")
    a = ap.parse_args()
    cfg = vars(a)
    os.makedirs(os.path.join(a.out, "labels"), exist_ok=True)
    no_label = {n.strip() for n in a.no_label.split(",") if n.strip()}
    no_nav = {n.strip() for n in a.no_nav.split(",") if n.strip()}
    nav_centers = [int(v) for v in a.nav_centers.split(",") if v.strip()]
    ny1, ny2 = [int(v) for v in a.nav_y.split(",")]
    decisions = {"config": cfg, "images": {}}
    files = sorted(glob.glob(os.path.join(a.src, "*.png")) + glob.glob(os.path.join(a.src, "*.jpg")))
    total_b = total_n = 0
    for p in files:
        name = os.path.splitext(os.path.basename(p))[0]
        img = cv2.imread(p); H, W = img.shape[:2]
        kept, dropped = detect(img, cfg)
        if name in no_label:
            open(os.path.join(a.out, "labels", name + ".txt"), "w").write("")
            decisions["images"][name] = {"path": p, "kept": [], "dropped": [], "labels_badge": 0, "labels_nav": 0}
            print(f"{name:24s} 显式负样本(留空)"); continue
        lines = []
        for x, y, w, h, *_ in kept:
            lines.append(f"0 {(x + w / 2) / W:.6f} {(y + h / 2) / H:.6f} {w / W:.6f} {h / H:.6f}")
        nb = len(lines)
        nn = 0
        if nav_centers and name not in no_nav:
            for x, y, w, h in nav_boxes(W, H, nav_centers, a.nav_half_width, ny1, ny2):
                lines.append(f"1 {(x + w / 2) / W:.6f} {(y + h / 2) / H:.6f} {w / W:.6f} {h / H:.6f}")
            nn = len(nav_centers)
        open(os.path.join(a.out, "labels", name + ".txt"), "w").write("\n".join(lines) + ("\n" if lines else ""))
        decisions["images"][name] = {"path": p, "kept": kept, "dropped": dropped,
                                     "labels_badge": nb, "labels_nav": nn}
        total_b += nb; total_n += nn
        print(f"{name:24s} badge={nb:3d} nav={nn:2d} 丢弃={len(dropped)}")
    json.dump(decisions, open(os.path.join(a.out, "decisions.json"), "w", encoding="utf-8"), ensure_ascii=False)
    print(f"共 {len(files)} 张, badge {total_b}, nav {total_n}")
    print("下一步(强制): review_grid.py --labeled <标注目录>  复核后再进数据集")

if __name__ == "__main__":
    main()
