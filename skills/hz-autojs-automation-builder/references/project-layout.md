# 生成项目结构

生成项目是**设备侧 AutoJs 项目**：含 `project.json`，可用 `project_sync_push` 同步、`project_run` 运行。目录按职责分层：`config/`、`core/`、`main.js`、`tasks/` 全部由生成器从任务卡契约编译，禁止手改；业务细节只改任务卡。

本地项目根（`--out`）默认取当前工作目录的 `hz-autojs-projects`，完整生成路径为 `<本地项目根>/projects/<项目名>/`；参考实现见 `references/examples/dupo-cangqiong/`（示例生成项目，属生成物，禁止手改）。

## 一、目录

```text
projects/<项目名>/
  project.json           AutoJs 项目声明：name / main / versionName / versionCode / packageName / abis / features
  main.js                入口：解析参数 → 读任务 readOnly → dryRun/allowWrite 门禁 → 执行 → 判据
  core/
    bootstrap.js         环境自检：分辨率、模式、契约加载、锚点残差
    coordinates.js       坐标契约解析（anchor / edge / ratio → 像素）
    observe.js           设备侧观察：截图 + OCR，返回锚点与文本
    detect.js            端上目标检测（可选；yolodet 插件，失败即返回失败不降级）
    actions.js           动作封装：__toolboxTap / LongPress / Swipe / Scroll / Text / Action + 守卫
    guards.js            forbiddenTexts / guardedActions 判定
    states.js            状态表与锚点匹配
    machine.js           状态机：单步推进、限次、未知状态升级
    recorder.js          运行记录（JSONL，写设备工作目录）
  tasks/
    <script-name>.js     每项 requestedScripts 一个模块：match / run / verify
    detect-targets.js    只读检测冒烟（启用目标检测时自动注入的框架任务）
  config/
    request.json         契约快照
    states.json          状态表快照
    coordinates.json     坐标契约快照
    detection.json       目标检测开关/模型/类别/阈值快照（仅启用时生成）
    generated.json       来源、生成时间、输入 sha256、未实现清单
  README.md              项目说明：已实现、未实现、守卫、运行方式、缺口
  runs/                  本地运行记录（不同步进版本库）
```

## 二、模块职责

### `core/bootstrap.js`

1. 读 `device.width` / `device.height`，与坐标契约 `baseline` 比对，得到缩放模式（`stretch` / `fit`）。
2. 打印 `BOOTSTRAP:` marker，含分辨率、契约 baseline、已验证分组。
3. 分辨率一致性 + 检测健康度：`device.width/height` 与 baseline 的横向 / 纵向缩放比差异超过 2% 记为不一致；截图与 OCR 必须各成功一次，且能命中至少一个 `verified` 状态的锚点（anchor coverage）。
   `maxResidualRatioOfShortSide` 的**几何残差**需要真机标定才有基准，首版只做「锚点覆盖 + 缩放一致性」；要开启几何残差，必须先跑一次标定并把实测坐标写回契约。
4. **分辨率分组门禁**：设备宽高比落在 `verification.verifiedBuckets` 之外（且不是 baseline 精确匹配）时停机；契约缺文件、状态表为空、守卫清单缺失同样停机。
5. `report.ok` 要求所有 check 通过；任何一项失败都不得继续业务任务。

### `core/coordinates.js`

- 输入元素 id，输出 `{ x, y }` 像素。
- `anchor`：先 OCR 定位文本，取 bounds 中心 + `offset.dx/dy`；命中失败走 `fallback`，再失败抛错。
- `edge`：按 `edge` 值（`bottom-center` / `bottom-left` / `top-right` …）与分轴 `xMode` / `yMode` 计算。
- `ratio`：`baseline` 空间比例 × 当前渲染区尺寸。
- 所有解析结果进日志（元素 id、来源模式、坐标），便于事后复核。

### `core/observe.js`

- `capture()`：`__toolboxScriptRequire('toolManager.js')` → `captureScreenshot({ outputPath })`，返回 `{ ok, path, width, height }`；失败时带上 `message`。
- `ocrTexts(options)`：`recognizeText({ sourcePath, x1, y1, x2, y2 })`，返回 `{ ok, engine, text, items }`，`items[].bounds` 用于残差与点击定位。
- `findText(text)`：在最近一次 OCR 的 items 里按包含匹配，返回中心点。
- `capture()` 成功后必须把 `ctx.lastOcr` 置空：新截图后旧 OCR 立即失效，禁止用上一屏文本判状态。
- 不允许调用 `images.requestScreenCapture()`；观察一律走工具箱既有截图通道。

### `core/detect.js`（仅启用目标检测时生成）

- 懒加载插件 `com.zjh336.cn.tools.plugin.yolodet`：`setModel(model)` → `prepare()` 成功后缓存预热状态，重复调用不重复加载。
- `detect(ctx, className)`：沿用可用的最近截图（没有就先 `capture`），对截图路径调 `detectEx`，按 `config/detection.json` 的全局/分类阈值过滤，返回 `{ ok, count, items, inferMs, costMs }`。
- 插件不可用、模型加载失败、检测失败一律返回 `{ ok:false, message }`；不降级到 OCR 猜测、不盲点、不用无障碍兜底。
- 只读框架任务 `tasks/detect-targets.js` 逐类调用并输出 `TARGETS_DETECTED` marker，作为写入任务之前的首跑门禁。

### `core/actions.js`

- 只暴露 `tap(elementId, enforceGuard?)` / `longPress(elementId, ms, enforceGuard?)` / `swipe(fromId, toId, ms)` / `action(name)`。
- 每个动作三层守卫：元素文本、点击落点的 OCR 命中文本（`guards.atPoint`）、消耗类动作的数值读数。命中 `forbiddenTexts` 或读数不足都直接拒绝并记录，抛 `GUARD_REJECTED`。
- 导航步骤（打开面板、切页签）在任务卡里显式写 `guard: false`；真正的消耗步骤必须带 `readFirst: true` 并产出对应 `readingKey`。守卫读不到数值时的默认行为是拒绝执行，不是放行。
- 动作后由任务卡的 `verify` 判据复核（锚点 / 数值 / 变化 / 不变化），marker 只在全部通过后发出；不自动重试第二次以上。
- 不用裸无障碍 API，不用 `try/catch` 改道兜底。

### `core/guards.js`

- `forbidden(text)`：切片匹配 `forbiddenTexts`。
- `evaluate(ctx, text, readings)`：`guardedActions` 里带数值规则的入口必须传当前读数（如势力贡献、剩余免费次数）；读数不足返回 `{ allow:false, reason }`。
- `atPoint(ctx, pt)`：点击落点命中的 OCR 文本若含 `forbiddenTexts`，返回命中项；动作层据此拒绝（防几何兜底误点付费入口）。
- 守卫拒绝一律写入运行记录，便于统计「本可以但不该做」的动作；没有就绪任务消费的守卫会进入 `uncoveredGuards`。

### `core/states.js`

- 由 `config/states.json` 生成：`{ id, confidence, anchors, negativeAnchors, minScore, priority, actions, next }`。
- 锚点支持对象元数据：`kind`（只有 text 参与 OCR 打分）、`weight`、`required`（全命中才考虑该状态）、`exclusive`（声明了就至少命中一个独占锚点）。`negativeAnchors` 命中即排除；得分相同用 `priority` 打破平局。
- `identify(ocr)` 返回 `{ id, hits, score, confidence }`；得分不大于 0 或未过 required/exclusive 门禁的状态不参评。
- `assumption` 状态只参与识别与记录，不进入执行分支（`machine.runTask` 直接拒绝）。

### `core/machine.js`

- `detect()`：截图（旧 OCR 失效）→ 状态打分 → 记录 `{state, hits, score, confidence}`。
- `runTask(task)`：判状态 → assumption 状态直接拒绝 → 状态白名单校验 → 执行任务卡步骤 → 复核状态 → 跑任务卡 `verify` → 通过才发 marker。
- 任务卡 `loop.maxIterations` / `loop.stopWhenAnchor`（+`verifyOnStop` 用命中帧复核）/ `loop.stopWhenState`（命中终止态立即停手）提供可中断限次巡检；`preSteps` 在循环前只跑一次，`verifyOnStep` 用指定步骤后的留档帧复核瞬时弹窗；无法停止的循环禁止生成。
- 任务转移结果写 `transitionAllowed`（只做记录与审计，不代替 verify 判据）。

### `core/recorder.js`

- 每次运行写一条 JSONL：`{ at, task, state, action, target, result, anchors, screenshot, note }`。
- 落盘路径在项目工作目录（默认 `<项目目录>/runs/`），并同时输出 `RESULT:` marker 供宿主持久化。
- 记录不覆盖历史：追加写。

## 三、任务模块契约

`tasks/` 是任务卡（`requestedScripts[].spec`）的编译产物，不是手写层：

```javascript
// 由任务卡编译（示意）
module.exports = {
  name: 'faction-donate.js',
  states: ['FACTION_HOME'],      // 来自 spec.startStates
  readOnly: false,
  readiness: 'ready',
  run: function (io) { /* 按 spec.steps 执行，支持 readFirst / guard */ },
  verify: function (io) { /* 按 spec.verify 判定，通过才返回 markers */ }
}
```

- framework 任务：`bootstrap.js`、`detect-state.js` 内建、只读。
- `readiness=ready` → 编译成可执行任务（`needs-verification`，判据已实现但必须在真机做固定回归）。
- `readiness=partial/blocked` 或缺 `spec` → 生成 not-ready 占位：`run` 返回 `{ ok:false, detail:{ reason:'NOT_READY', missingEvidence } }`，不执行任何动作；状态记为 `partial-implementation` / `not-implemented`。
- 任务不得自己解析坐标：一律通过 `ctx.coordinates`；也不得手写像素或绕过 `verify` 发 marker。

## 四、project.json 最小声明

```json
{
  "name": "<项目显示名>",
  "packageName": "<目标应用包名>",
  "main": "main.js",
  "versionName": "<生成时版本>",
  "versionCode": 1,
  "abis": ["armeabi-v7a", "arm64-v8a"],
  "features": { "builtInOCR": "with-models", "nodejs": "disabled" },
  "autoOpen": false,
  "launchConfig": { "hideLogs": false, "displaySplash": false },
  "permissionConfig": { "requestListOnStartup": ["android.permission.WRITE_EXTERNAL_STORAGE"] }
}
```

`packageName` 是**目标被自动化应用的包名**，不是生成项目的包名；生成项目本身以 AutoJs 项目运行，不打包、不安装，除非用户明确要求出包。

## 五、工程清单字段对照（外部生态 → V5）

外部 Auto.js 生态的 `project.json` 字段与 V5 打包链路的对照。V5 侧依据：`hz_autojs_toolbox_v5/mobile/project.json` 与后端 `AppPackageServiceImpl` 实际读取/规范化的键。

| 外部字段 | V5 对应 | 结论 |
| --- | --- | --- |
| `main` / `name` / `packageName` / `versionName` / `versionCode` / `icon` / `assets` / `build` / `scripts` | 同名 | V5 自身的工程清单就在使用，可写 |
| `optimization.removeOpenCv` / `unusedResources` | 同名（V5 另有 `removeAccessibilityService` / `obfuscateComponents`） | V5 使用；`removeOpenCv` 与打包开关 `openImageModule` 互为取反 |
| `launchConfig.displaySplash` / `hideLogs` / `splashIcon` / `splashText` / `stableMode` | 同名 | V5 使用 |
| `useFeatures` | `features`（如 `builtInOCR` / `nodejs`） | **名称不同，按 V5 的 `features` 写** |
| `encryptLevel` | 无对应字段；V5 用 `openObfuscator` + `obfuscatorIncludePaths` | **不要写** |
| （外部没有） | `plugins` / `abis` / `autoOpen` / `permissionConfig` / `signingConfig` / `ignore` / `packageExcludePaths` | V5 扩展字段，按需使用 |

生成项目默认只用第四节的「最小声明」；需要更多字段时按上表核对，不要照抄外部生态的字段名。