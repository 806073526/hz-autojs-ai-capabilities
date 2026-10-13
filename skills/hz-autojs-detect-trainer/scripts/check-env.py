#!/usr/bin/env python
r"""环境检测 —— 训练机依赖 / CUDA / 显存 / 磁盘 / 权重

用法:
  <venv>\python.exe check-env.py --work-root D:\hz-yolo [--weights D:\hz-yolo\models\yolo11n.pt]
判定: 任意 FAIL -> 退出码 1; 只有 WARN -> 退出码 0
"""
import argparse, importlib, os, shutil, sys

REQUIRED = [("cv2", "opencv", "opencv-python"), ("numpy", "numpy", "numpy"),
            ("torch", "torch", "torch(CUDA)"), ("ultralytics", "ultralytics", "ultralytics"),
            ("onnx", "onnx", "onnx"), ("onnxruntime", "onnxruntime", "onnxruntime")]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work-root", default=os.getcwd())
    ap.add_argument("--weights", default=None, help="可选: 检查预训练权重文件存在")
    ap.add_argument("--min-free-vram-gb", type=float, default=2.0)
    ap.add_argument("--min-free-disk-gb", type=float, default=10.0)
    a = ap.parse_args()
    rows, fails, warns = [], 0, 0

    def add(item, level, detail):
        nonlocal fails, warns
        if level == "FAIL": fails += 1
        if level == "WARN": warns += 1
        rows.append((item, level, detail))

    v = sys.version_info
    add("python", "OK" if v >= (3, 10) else "FAIL", sys.version.split()[0] + " (需要 >=3.10)")
    for mod, key, pipname in REQUIRED:
        try:
            m = importlib.import_module(mod)
            ver = getattr(m, "__version__", getattr(m, "version", "?"))
            add(key, "OK", str(ver))
        except Exception as e:
            add(key, "FAIL", f"导入失败: {e} (pip install {pipname})")
    try:
        import torch
        if torch.cuda.is_available():
            name = torch.cuda.get_device_name(0)
            cap = torch.cuda.get_device_capability(0)
            add("cuda", "OK", f"{name} / 算力 {cap}")
            free, total = torch.cuda.mem_get_info(0)
            fg, tg = free / 2**30, total / 2**30
            add("free-vram", "OK" if fg >= a.min_free_vram_gb else "WARN",
                f"{fg:.1f}GB 空闲 / {tg:.1f}GB 总量" + ("" if fg >= a.min_free_vram_gb else " (低于阈值, 常见占用: 本地大模型服务)"))
        else:
            add("cuda", "FAIL", "torch.cuda.is_available()=False (训练需要 NVIDIA GPU)")
    except Exception:
        pass
    root = a.work_root
    try:
        os.makedirs(root, exist_ok=True)
        du = shutil.disk_usage(root)
        fg = du.free / 2**30
        add("disk", "OK" if fg >= a.min_free_disk_gb else "WARN", f"{root} 剩余 {fg:.1f}GB")
    except Exception as e:
        add("disk", "WARN", f"无法检查 {root}: {e}")
    if a.weights:
        add("weights", "OK" if os.path.isfile(a.weights) else "WARN",
            a.weights + ("" if os.path.isfile(a.weights) else " 不存在 (联网下载或按 pitfalls 预置)"))

    w = max(len(r[0]) for r in rows)
    print(f"环境检测 @ {root}")
    for item, level, detail in rows:
        print(f"  [{level:4s}] {item:<{w}}  {detail}")
    print(f"结果: {'OK' if fails == 0 else 'FAIL'} (fail={fails}, warn={warns})")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
