# 自动化项目生成器

## generate-project.mjs

读探索产出的**任务卡契约**，生成独立自动化项目。只读契约，不联网、不访问设备。

```powershell
# 只校验契约（不写文件）
node generate-project.mjs --run <探索运行目录> --check

# 生成项目到 <out>/projects/<id>/
node generate-project.mjs --run <探索运行目录> --out <本地项目根> --id <项目名> [--force]

# 用户确认启用目标检测时（先经 hz-autojs-detect-trainer 环境检测 + 端上验收）
node generate-project.mjs --run <探索运行目录> --out <本地项目根> --id <项目名> `
  --detect-model /sdcard/appSync/yolo/<run>.onnx --detect-classes badge,nav [--detect-min-score 0.5] [--detect-class-min nav=0.6]
```

参数：

| 参数 | 说明 |
| --- | --- |
| `--run <目录>` | 探索运行目录，需含 `project-request.json` 与 `state-model.json` |
| `--out <目录>` | 本地项目根；项目落在 `<out>/projects/<id>/`。省略时默认 `<当前工作目录>/hz-autojs-projects` |
| `--id <项目名>` | 项目 id，默认取运行目录名；非 `[A-Za-z0-9._-]` 会被替换成 `-` |
| `--check` | 只校验并打印报告，不写文件 |
| `--force` | 目标已存在时覆盖重建 |
| `--detect-model <设备路径>` | 启用目标检测（必须是设备端绝对路径且 `.onnx`）；生成 `core/detect.js` + `config/detection.json` + 只读框架任务 `detect-targets.js` |
| `--detect-classes <类1,类2>` | 启用时必填；类名与模型同目录 `classes.json` 一致 |
| `--detect-min-score <0~1>` | 可选，全局置信度阈值，默认 0.5 |
| `--detect-class-min <类=阈值,...>` | 可选，按类覆盖阈值（类名必须在 `--detect-classes` 中） |
| `--no-detect` | 显式关闭目标检测；已启用检测的项目重新生成时必须带检测参数或本开关 |

编译规则：

- `bootstrap.js` / `detect-state.js`：内建框架任务，只读。
- `detect-targets.js`：启用目标检测时自动注入的框架任务（只读），逐类计数并发 `TARGETS_DETECTED` marker，作为写入任务之前的首跑门禁。
- `readiness: "ready"` 且带 `spec` 任务卡：编译成可执行任务（状态 `needs-verification`，判据已实现，待真机回归）。
- `readiness: "partial" | "blocked"` 或缺 `spec`：生成 not-ready 占位（状态 `partial-implementation` / `not-implemented`），运行返回 `NOT_READY` + `missingEvidence`，不执行任何动作。

任务卡字段与运行语义见 `../../references/generation-contract.md`。

输出（stdout，JSON）：

```json
{
  "ok": true,
  "errors": [],
  "warnings": ["successMarker 没有就绪任务实现: STAGE_CLEARED"],
  "stats": {
    "states": 27, "elements": 33, "scripts": 12,
    "ready": 2, "partial": 10, "blocked": 0,
    "compiled": 2, "placeholders": 10,
    "uncoveredMarkers": ["STAGE_CLEARED"], "uncoveredGuards": ["扫荡"],
    "evidenceLabels": 42, "guardedActions": 4
  },
  "mode": "check"
}
```

校验项（不通过即 `errors` 非空、退出码 1）：

1. 三个输入文件可解析、`schemaVersion` 为 1。
2. 状态 id 唯一、`next[]` 目标存在、每个状态有锚点、证据标签都能映射。
3. 坐标元素 id 唯一、`mode` 合法、baseline 一致、守卫清单存在。
4. `requestedScripts[]` 每项是对象且带合法 `readiness`；`ready` 必须带完整 `spec`（步骤/读数/判据/marker）。
5. 步骤引用的坐标元素与起点状态存在；声明 `visibleInStates` 的元素必须与 `startStates` 有交集。
6. 任务 marker 必须属于 `verification.successMarkers`（框架 marker 除外）。
7. 带 `readingKey` 的守卫必须有就绪任务消费：消费步骤 `readFirst: true` 且产出该读数。
8. `verify` 引用的读数必须存在；动作后判据的读数 `when` 不能是 `before`。
9. 没有就绪任务实现的 successMarker、没有消费者的守卫：warning + 写入 `uncoveredMarkers` / `uncoveredGuards`。
10. 目标检测参数：模型必须是设备端绝对路径且 `.onnx`；启用时 `--detect-classes` 不能为空、类名合法唯一；阈值必须在 0~1；`--no-detect` 与 `--detect-model` 互斥。
11. 已启用检测（`config/generated.json` 的 `detection.enabled=true`）的项目重新生成：必须带 `--detect-model` 或 `--no-detect`，否则拒绝生成（防静默丢能力）。

## self-test.mjs

```powershell
node self-test.mjs
```

用合成契约跑通「`--check` → 生成 → 全部产物 `node --check` → 任务判据/三层守卫/状态打分桩测试」，并覆盖目标检测场景（启用时生成 `core/detect.js` + `detect-targets.js`、阈值过滤与插件缺失桩测试、`--no-detect` 防静默丢能力）与 8 组负例（ready 无任务卡、守卫步骤缺 `readFirst`、marker 越界、`requestedScripts` 用字符串、检测参数四类越界）。不依赖设备与网络，改生成器后先跑它。

生成物自带 `config/generated.json`，记录来源、生成时间、输入文件 sha256、任务卡 readiness 统计与 `uncovered*` 缺口；契约变化后重新生成，不要手改生成物。启用目标检测时另生成 `config/detection.json`（模型/类别/阈值），`README.md`、`AGENTS.md` 与 `agent/manifest.json` 同步声明检测能力。