---
name: hz-autojs-detect-trainer
description: 把 APP/游戏界面上的可检测目标（红点角标、功能图标、按钮、页面导航等）训练成本地 ONNX 检测模型，并部署到 V5 设备的 yolodet 插件做端上推理与验收。用于自动化任务需要"看画面做判断"（有红点就点、按页面判态）但颜色/模板规则不稳定，或探索阶段留下证据需要固化成模型的场景；采图与导航复用 hz-autojs-device-operator，端上验收脚本复用 hz-autojs-script-author，训练在带 GPU 的工作机上完成。
---

# 目标检测模型训练技能

`hz-autojs-task-explorer` 负责**发现与留证据**，`hz-autojs-automation-builder` 负责**编译固化项目**；本技能补上中间一环：把"看得懂画面"从脆弱的颜色/模板规则升级为**本地检测模型**，并完成端上部署与验收。

涉及设备采图、部署或验收时，[手机本地操作记忆](../hz-autojs-device-memory/SKILL.md) 只在重复失败、复用同版本同页面经验或核对已知反例时按需读取；稳定执行不得依赖记忆，验证有效的绕过经验再主动写回手机。

## 定位与边界

- **训练在工作机、推理在设备**：训练需要 NVIDIA GPU + Python（ultralytics）；设备只负责采图和端上验收，不承担训练。
- **类别要克制**：1~3 类起步。典型三类：`badge`（可领取角标）、`nav`（底部导航=页面身份）、`entry`（功能入口按钮）。
- **不做标注平台，但复核是强制关卡**：规则自动标注 + `review_grid.py` 的保留/丢弃双网格人工复核，两样缺一不可。
- **不承诺任意场景自动标注**：只有具备稳定视觉特征（颜色/形状/固定区域）的目标类能用规则自动标注；其余走"预标注 + 人工修"或纯人工。
- **不绑定具体游戏/应用**：案例只放 `references/`，脚本全部参数化。
- **不绕过设备门禁**：采图与部署全部经设备 MCP；不使用未被授权的通道。

## 商业授权归类

本技能**不新增商业授权能力项**。它消费 AI 能力包既有能力（设备观察与截图、脚本下发、文件读写、项目部署），产出的模型文件属于用户自训练产物，随 V5 设备访问门禁与审计运行；不绕过商业授权、设备访问、部署来源边界或审计。

## 必需前置

1. 工作机环境就绪：`scripts/check-env.py` 返回 `OK`（Python 3.10+、opencv、numpy、torch+CUDA、ultralytics、onnx、onnxruntime）。未就绪先跑 `scripts/setup-env.ps1`（Windows）或按 `references/pitfalls.md` 的清单装。
2. 设备在线（先用 `hz-autojs-device-operator` 的 `device_status` 确认），且 `directControlMode` 按现状使用、不擅自切换。
3. 端上插件 yolodet（`com.zjh336.cn.tools.plugin.yolodet`）可用：官方 V5 APP 默认内置该插件（插件 APK 在 APP 插件目录里，`$plugins.load` 直接可用，**不需要安装到设备**）；自定义打包时在打包抽屉勾选它。x86_64 模拟器调试按 `references/device-deploy.md` 用 `-PextraAbis=x86_64` 构建插件源码。
4. 从探索接入时：探索运行目录可被 `scripts/ingest_exploration.py` 识别（新契约 `evidence/manifest.json` 或旧式 `runs/shots/` + `runs/run-*.jsonl`）。
5. 需要写 AutoJs 验收脚本时加载 `hz-autojs-script-author`，API 一律先查 `autojs_docs_search` / `autojs_docs_read`。

## 环境检测

工作机（每次训练前跑一次）：

```powershell
<venv>\Scripts\python.exe <skill>\scripts\check-env.py --work-root <工作目录>
```

检查项与判定：Python 版本；cv2/numpy/torch/ultralytics/onnx/onnxruntime 是否可导入及版本；`torch.cuda.is_available()` 与设备名/算力；**空闲显存**（<2 GB 直接警告——常见占用者是本地大模型服务，训练前先停）；工作目录磁盘余量；可选 `--weights` 检查权重文件存在性。任何 `FAIL` 都会以非 0 退出。

设备侧（每次采图/验收前）：

1. `device_status` 确认 `ONLINE` 与 `directControlMode`；
2. 截图链路可用（`device_screenshot` 返回真实图）；
3. 验收阶段额外确认插件已装：`pm list packages | grep -i yolo`（或脚本侧 `$plugins.load` 能加载）。

## 环境部署

工作机一键部署（Windows，幂等，可重复执行）：

```powershell
powershell -ExecutionPolicy Bypass -File <skill>\scripts\setup-env.ps1 -WorkRoot D:\hz-yolo
```

先预演不改环境：命令后加 `-DryRun`（只打印将要执行的安装动作；已有 venv 时会直接跑 check-env.py 复验）。

按顺序完成：定位 Python（3.10+）→ 创建/复用 venv（`<WorkRoot>\venv`）→ 升级 pip → 安装 torch（CUDA 轮子源，默认 cu128）→ 安装 ultralytics/onnx/onnxslim/onnxruntime（默认清华 PyPI 镜像，可用 `-PipIndex` 换源）→ 建议设置 `YOLO_CONFIG_DIR` → 调 `check-env.py` 复验。

已知坑（脚本已内置处理，详见 `references/pitfalls.md`）：GitHub release 下载慢/失败要换镜像（`-GithubMirror`）；ultralytics 首次运行会从 GitHub 拉 AMP 检查权重与字体，**先预置 `<WorkRoot>\models\yolo11n.pt` 可跳过**；训练显存被本地大模型占用要先释放。

设备侧部署：确认 yolodet 插件可加载（官方 APP 默认内置，`$plugins.load` 直接可用；自定义打包需勾选）→ 推送模型与类别文件（`/sdcard/appSync/yolo/<run>.onnx` + 同目录 `classes.json`）→ 用 `assets/verify-on-device.js` 模板下发验收脚本。完整步骤与验收清单见 `references/device-deploy.md`。

## 训练闭环（六阶段）

1. **目标定义与规则设计**：明确类别清单与"怎么算一个正样本"；设计自动标注规则（颜色/尺寸/长宽比/封闭白/圆形度，或固定区域）。方法与适用边界见 `references/labeling.md`。
2. **采图**：
   - 新采：用 `hz-autojs-device-operator` 导航并批量截图（导航步骤建议脚本化：点击序列 + 等待 + 截屏，纯文件落盘，不把大图带回上下文）；
   - 接探索：`scripts/ingest_exploration.py <探索运行目录>` 产出 `ingest.json`（图 + 状态 + sha256），按状态核对覆盖矩阵，缺的状态进入补采清单。
3. **自动标注 + 强制复核**：
   ```powershell
   <venv>\python.exe <skill>\scripts\autolabel.py --src <采图目录> --out <标注目录> --nav-centers 125,300,470,640,810,985
   <venv>\python.exe <skill>\scripts\review_grid.py --labeled <标注目录>
   ```
   复核 `kept_*.jpg` / `dropped_*.jpg`：保留集出现非目标（红字、属性标签、装饰）或丢弃集出现真目标，都必须先调规则再继续。**没复核过的数据集不许进训练。**
4. **数据集构建**：
   ```powershell
   <venv>\python.exe <skill>\scripts\build_dataset.py --images <采图目录> --labels <标注目录>/labels --out <数据集目录> --val <图名1,图名2,...> --negative <图名a,图名b> --class badge --class nav
   ```
   规则：按**页面/状态**划分验证集（同页不同状态会泄漏）；完全重复图按 md5 去重（先分 split 再去重）；负样本（无任何目标的全负图）用 `--negative` 显式声明，且其标签必须留空。
5. **训练与导出**：
   ```powershell
   <venv>\python.exe <skill>\scripts\train_export.py --data <数据集目录>\data.yaml --name <run> [--epochs 200]
   ```
   默认 yolo11n / imgsz 640 / batch 8 / 200 epochs；导出 ONNX opset 17 + simplify（插件按 ORT 1.20 消费）。
6. **端上部署与验收**：推模型 + `classes.json` → 下发 `assets/verify-on-device.js` → 核对"端上 vs 桌面同图一致"与单帧耗时 → 按验收门禁复检弱项页面。步骤见 `references/device-deploy.md`。

## 与探索技能的契约

- **输入**：探索运行目录的截图（保留原始分辨率）、`state` 标签、sha256 与分辨率；旧式项目用 `runs/shots` + `runs/run-*.jsonl` 的 detect 记录按时间戳 join（容差 3 秒，实测毫秒级命中）。
- **回写**：补采的截图追加回探索运行目录的 `evidence/` 并登记索引；训练产出的 `model-anchor.json`（模型名、路径、类别、建议判据）交给状态机/自动化项目使用。
- 双方共享字段以探索技能产物契约为唯一约定，**不另设第二套格式**。

## 与自动化项目生成的对接

`hz-autojs-automation-builder` 生成固化项目时会询问用户是否启用目标检测；启用时它调用本技能做前置（`scripts/check-env.py` 环境检测 + 设备端 `assets/verify-on-device.js` 验收），并把模型路径与类别写进生成参数（`--detect-model` / `--detect-classes`）。交接产物沿用 model-anchor 思路：模型文件、类别清单、建议判据（含分类阈值）与端上验收结论；生成的项目据此产出 `core/detect.js` 与只读冒烟任务 `detect-targets.js`。未训练出模型时，先走本技能六阶段拿到端上验收结论，再生成项目。
## 产物契约

```text
<工作目录>/
  venv/                    Python 环境（setup-env.ps1 创建）
  models/                  预训练权重（yolo11n.pt 等）
  captures/<批次>/         采图（原始分辨率 PNG）
  labeled/                 autolabel 输出（labels/*.txt + decisions.json + 复核网格）
  datasets/<数据集>/        images/{train,val} + labels/{train,val} + data.yaml
  runs/<run>/weights/      best.pt / best.onnx（ultralytics 目录）
  exports/                 交付副本（<run>.onnx、验收图、报告）
  reports/                 指标表与验收记录（追加，不覆盖）
```

## 验收门禁

训练侧（有实测基准，新案例以持平或更好为通过）：

- `badge` 类：mAP50 ≥ 0.95 且 Recall ≥ 0.95；
- `nav`/区域类：mAP50 ≥ 0.99；
- 负样本图（登录页、异常弹窗、无目标面板）：误报数 = 0。

端上侧：

- 同一张图端上/桌面检测 IoU≥0.5 匹配率 100%，置信度差 ≤0.05；
- 记录冷加载与单帧耗时（x86_64 模拟器基准：冷载 ~30ms、单帧 ~120~150ms）；
- 弱项页面（登录/弹窗）端上复检 0 误报。

任一不通过按 `references/pitfalls.md` 排查，不带着已知缺陷交付。

## 参考文件

- `references/labeling.md`：自动标注规则设计、适用边界与复核协议。
- `references/pitfalls.md`：环境与流程坑清单（下载镜像、显存、标注污染、同帧点击等）。
- `references/device-deploy.md`：插件部署路径、验收流程与实测基准。
