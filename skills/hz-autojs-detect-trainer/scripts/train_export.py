#!/usr/bin/env python
r"""训练与导出 —— yolo11n 训练 + ONNX(opset17) 导出, 供 yolodet 插件端上使用

用法:
  <venv>\python.exe train_export.py --data <数据集>\data.yaml --name dupo_ui_v1 [--work-root D:\hz-yolo]
默认: yolo11n / 200 epochs / imgsz 640 / batch 8 / device 0 / plots False
产物: <work-root>/runs/<name>/weights/{best.pt,best.onnx}; 打印最终指标与耗时
"""
import argparse, csv, os, time

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True); ap.add_argument("--name", required=True)
    ap.add_argument("--work-root", default=os.getcwd())
    ap.add_argument("--model", default=None, help="默认 <work-root>/models/yolo11n.pt, 不存在时回退 'yolo11n.pt'")
    ap.add_argument("--epochs", type=int, default=200); ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=8); ap.add_argument("--device", default="0")
    ap.add_argument("--opset", type=int, default=17)
    a = ap.parse_args()
    model = a.model
    if not model:
        p = os.path.join(a.work_root, "models", "yolo11n.pt")
        model = p if os.path.isfile(p) else "yolo11n.pt"
    os.environ.setdefault("YOLO_CONFIG_DIR", os.path.join(a.work_root, "ultralytics-cfg"))
    from ultralytics import YOLO
    t0 = time.time()
    m = YOLO(model)
    m.train(data=a.data, epochs=a.epochs, imgsz=a.imgsz, batch=a.batch, device=a.device,
            project=os.path.join(a.work_root, "runs"), name=a.name, exist_ok=True, plots=False)
    best = os.path.join(a.work_root, "runs", a.name, "weights", "best.pt")
    print(f"训练完成 {time.time() - t0:.0f}s -> {best}")
    res = os.path.join(a.work_root, "runs", a.name, "results.csv")
    if os.path.isfile(res):
        last = list(csv.reader(open(res)))[-1]
        print(f"末轮指标: P={float(last[5]):.3f} R={float(last[6]):.3f} mAP50={float(last[7]):.3f} mAP50-95={float(last[8]):.3f}")
    print("导出 ONNX...")
    YOLO(best).export(format="onnx", imgsz=a.imgsz, opset=a.opset, simplify=True, half=False, dynamic=False)
    onnx = best.replace(".pt", ".onnx")
    print(f"导出完成: {onnx} ({os.path.getsize(onnx) / 1e6:.1f} MB)")
    print("下一步: 推送到设备 /sdcard/appSync/yolo/ + classes.json, 用 assets/verify-on-device.js 验收")

if __name__ == "__main__":
    main()
