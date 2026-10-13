#!/usr/bin/env python
r"""数据集构建 —— YOLO 格式, 按图名划分验证集, md5 去重, 显式负样本

用法:
  <venv>\python.exe build_dataset.py --images <采图目录> --labels <标注目录>\labels \
      --out <数据集目录> --val lilian_a,maoxian_a --negative login_dialog --class badge --class nav
规则: 先按 split 分组, 再在组内按 md5 去重; 负样本标签必须为空(输出前校验)。
"""
import argparse, glob, hashlib, os, shutil, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--images", required=True); ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--val", default=""); ap.add_argument("--negative", default="")
    ap.add_argument("--class", dest="classes", action="append", default=[])
    a = ap.parse_args()
    val = {n for n in a.val.split(",") if n.strip()}
    neg = {n for n in a.negative.split(",") if n.strip()}
    classes = a.classes or ["badge"]
    if os.path.exists(a.out): shutil.rmtree(a.out)
    for sub in ["images/train", "images/val", "labels/train", "labels/val"]:
        os.makedirs(os.path.join(a.out, sub), exist_ok=True)
    seen = {"train": set(), "val": set()}
    stat = {"train": [0, 0, 0], "val": [0, 0, 0]}
    for p in sorted(glob.glob(os.path.join(a.images, "*.png")) + glob.glob(os.path.join(a.images, "*.jpg"))):
        name = os.path.splitext(os.path.basename(p))[0]
        split = "val" if name in val else "train"
        md5 = hashlib.md5(open(p, "rb").read()).hexdigest()
        if md5 in seen[split]:
            print(f"  跳过完全重复({split}): {name}"); continue
        seen[split].add(md5)
        lp = os.path.join(a.labels, name + ".txt")
        lines = [l for l in open(lp, encoding="utf-8").read().splitlines() if l.strip()] if os.path.isfile(lp) else []
        if name in neg and lines:
            print(f"  负样本带标注, 拒绝: {name}"); sys.exit(2)
        shutil.copy(p, os.path.join(a.out, "images", split, name + os.path.splitext(p)[1]))
        open(os.path.join(a.out, "labels", split, name + ".txt"), "w").write("\n".join(lines) + ("\n" if lines else ""))
        nb = sum(1 for l in lines if l.startswith("0 "))
        nn = sum(1 for l in lines if l.startswith("1 "))
        stat[split][0] += 1; stat[split][1] += nb; stat[split][2] += nn
        tag = " [负样本]" if name in neg else ""
        print(f"[{split}] {name:24s} badge={nb:3d} nav={nn:2d}{tag}")
    names = "\n".join(f"  {i}: {c}" for i, c in enumerate(classes))
    open(os.path.join(a.out, "data.yaml"), "w", encoding="ascii").write(
        f"path: {a.out.replace(chr(92), '/')}\ntrain: images/train\nval: images/val\nnames:\n{names}\n")
    print(f"\n数据集: train {stat['train']} | val {stat['val']}  (张数,badge,nav) -> {a.out}")

if __name__ == "__main__":
    main()
