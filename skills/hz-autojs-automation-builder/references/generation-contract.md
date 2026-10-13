# 生成契约（探索运行目录 → 独立项目）

生成器只读三类文件，不读截图、不重跑探索、不联网。任何生成所需的字段缺失时，正确处置是**回到探索运行目录补证据**，不是生成期猜一个默认值。

## 一、输入文件

| 文件 | 作用 | 必需 |
| --- | --- | --- |
| `project-request.json` | 目标应用、项目模板、脚本清单、坐标契约引用、运行约束、验收标记、缺口列表 | 是 |
| `state-model.json` | 状态、锚点、动作、转移、恢复与置信度；含 `evidenceStateAliases` 时用于把证据挂回状态 | 是 |
| 坐标契约（`project-request.coordinateSpec.file`） | `anchor` / `edge` / `ratio` 元素定义、守卫清单、容差与已验证分组 | 是 |
| `evidence-index.json` | 每条证据的 seq、状态标签、sha256、锚点摘要 | 建议 |
| `findings.md` | 已证实事实、失败模式、下一步 | 建议 |

生成器读的是**契约快照**：生成时会把输入文件原样复制进 `config/`，并在 `config/generated.json` 里记录来源路径、生成时间和输入文件 sha256。后续复跑出现分歧时先比对快照，再决定是改契约还是改项目。

## 二、字段契约

### project-request.json

- `sourceTaskId` / `sourceRun`：溯源头。生成器必须把两者写进 `config/generated.json`。
- `target.packageName` / `target.deviceId` / `target.baseline`：目标应用与基准分辨率；基准分辨率写进坐标契约校验。
- `requestedScripts[]`：任务卡清单，每项必须带 `name` + `duty` + `readiness`：
  - `readiness: "ready" | "partial" | "blocked"`；`ready` 必须同时带 `spec` 任务卡，否则 `--check` 报 error。
  - `spec`（任务卡，仅 ready 需要）：`startStates[]` / `steps[]` / `readings[]` / `verify[]` / `markers[]`，可选 `preSteps` / `loop` / `verifyOnStep`。
    - `steps[]`：`{ op: "tap"|"longPress"|"swipe"|"wait"|"read", element?, toElement?, ms?, guard?, readFirst?, settleMs?, guardAction? }`；`guard:false` 只用于导航步骤。
    - `preSteps[]`：与 `steps[]` 同结构，在循环之前只执行一次（例：一关一条龙里的「进入关卡→挑战→出战」；循环体只放可重复的战斗内快进）。
    - `readings[]`：`{ key, pattern, when: "before"|"after"|"both" }`；`pattern` 必须带第 1 个捕获组。
    - `verify[]`：`{ type:"anchor", text, expect? }` / `{ type:"number", key, op, value }` / `{ type:"changed", key, direction? }` / `{ type:"unchanged", key }`。
    - `markers[]`：业务成功标记，必须属于 `verification.successMarkers`；marker 只在 verify 全部通过后发出。
    - `loop`：`{ maxIterations, stopWhenAnchor?, verifyOnStop?, stopWhenState? }`，只用于可中断的限次巡检。`stopWhenAnchor` 命中即停；`verifyOnStop:true` 用命中锚点的那一帧复核（结算页等瞬时页面）；`stopWhenState[]` 命中终止态（如战败）立即停手，避免按旧坐标空转。
    - `verifyOnStep`：1..N 的整数（按 `preSteps` → `steps` 顺序计），判据用第 N 步之后留档的那一帧复核；用于「点完就被收尾步骤关掉」的领奖弹窗。
  - `missingEvidence[]`：partial / blocked 必填，写清缺哪些脚本级证据。
  - 生成器只编译 ready 任务卡；partial / blocked 生成 not-ready 占位（运行返回 `NOT_READY` + missingEvidence），状态分别记为 `partial-implementation` / `not-implemented`。
- `coordinateSpec.file` / `verifiedBuckets` / `unverifiedBuckets`：坐标契约位置与已/未验证分组。未验证分组不得写成支持。
- `runtimeConstraints`：`deviceActionApi`、`stateDetectionApi`、`forbiddenTexts`、`guardedActions`、`maxUnknownStateEscalations`、`aiInStableLoop`。
- `verification.successMarkers[]`：业务级成功标记名，任务模块必须至少发出其中一个。
- `openGaps[]`：已知缺口。生成器原样写进项目 README 的「未完成」段。

### state-model.json

- `states[].id`：状态 ID，全项目唯一。
- `states[].anchors[]`：状态判据，字符串或对象 `{ text, kind: "text"|"visual"|"node", weight, required, exclusive }`。只有 `kind:"text"` 参与 OCR 打分（字符串默认 text）；`required` 全命中才考虑该状态；声明了 `exclusive` 的状态必须命中至少一个独占锚点；`negativeAnchors[]` 命中即排除；`priority` 只用于同分打破平局；`minScore` 默认 0（得分 > 0 才参评）。纯数值锚点（如 `1/15`）优先。
- **锚点必须是该页面独有文案**：禁用会出现在公告、提示语或其他页面的通用词。2026-10-02 斗破实测：主城锚点 `斗者` 出现在布阵说明「斗者出手顺序由位置决定」，布阵页被误判为主城；战斗界面渲染 `城市 / 冒险 / 纳戒 / 势力 / 历练` 五个主城词，BATTLE 页会被误判为 MAIN_CITY。锚点以真机 OCR 全文复核，注意繁体（`數`）与形近误读（`一键上阵`→`一键止阵`）：优先短且稳定的子串（如 `上阵`），保留变体作冗余锚点。非 OCR 词（血条 / 技能图标 / 手指图标 等）必须标 `kind: "visual"`，不得当作 text 锚点充数；通用词要么删除、要么显式降权。
- `states[].actions[]`：动作名，必须能在任务清单或动作层找到对应实现。
- `states[].next[]`：允许的转移目标；生成器据此检查转移闭环。
- `states[].confidence`：`verified` / `partial` / `assumption`。**`assumption` 状态不得进入自动执行路径**，只能作为识别与记录分支。
- `evidenceStateAliases.map`：证据索引标签 → 标准状态 ID；`UNMAPPED` 表示不参与建模。

### 坐标契约

- 每个元素：`id`、`desc`、`mode`，以及对应模式的字段（`anchor` / `edge`+`dx`/`dy` / `rx`+`ry`）。
- 分轴优先：`xMode` / `yMode` 可分别声明 `anchor` / `edge` / `ratio`。
- 退路规则：`ratio` / `edge` 元素必须带 `fallback`；`anchor` 元素要么带 `fallback`，要么显式声明 `noFallbackReason`（接受 OCR 未命中即停机）。两者都没有时 `--check` 出 warning。
- `visibleInStates[]`（建议）：该元素在哪些状态可见可点；生成器用它校验任务卡 `startStates × 步骤元素` 的可达性，未声明时出 warning。
- `guards`：`forbiddenTexts` 与 `guardedActions`（带数值规则的必须带 `readingKey`）。
- `verification`：`maxResidualRatioOfShortSide`（默认 `0.015`）与 `verifiedBuckets` / `unverifiedBuckets`；`bootstrap` 在未验证分辨率分组上直接失败停机。

## 三、校验规则（`--check` 必过）

1. 三个输入文件均可解析，`schemaVersion` 为 1（未知版本拒绝生成）。
2. 状态 id 唯一、`next[]` 目标存在、每个状态有锚点；`verified` 状态没有 OCR 可用文本锚点时出 warning 并记入报告。
3. 坐标元素 id 唯一、`mode` 合法、`target.baseline` 与坐标契约 `baseline` 一致；守卫清单存在。
4. `requestedScripts[]` 每项是对象且带合法 `readiness`；`ready` 必须带 `spec`，且 `startStates` / `steps` / `readings` / `verify` / `markers` 完整、引用存在。
5. 每个步骤引用的坐标元素存在；声明了 `visibleInStates` 的元素必须与 `startStates` 有交集（未声明时出 warning，提示可达性未校验）。
6. 每个任务发出的 marker 必须属于 `verification.successMarkers`（框架 marker 除外）；没有就绪任务实现的 successMarker 出 warning 并写入 `uncoveredMarkers`。
7. 每个带 `readingKey` 的 `guardedAction` 必须有就绪任务消费：消费步骤 `readFirst: true` 且任务产出该 `readingKey`，否则报 error；没有消费者的守卫出 warning 并写入 `uncoveredGuards`。
8. `verify` 引用的 `readingKey` 必须有声明；用于动作后判据的读数 `when` 不能是 `before`；`pattern` 必须是合法正则。
9. `evidenceStateAliases` 覆盖证据索引里出现的全部标签；未覆盖即失败（防止证据挂不回状态）。
10. 任务名必须匹配 `^[A-Za-z0-9._-]+\.js$`；任务是否只读由任务模块 `readOnly` 决定，生成器不维护第二份白名单。
11. 目标检测是**生成期开关**（默认关闭，探索契约不新增字段）：`--detect-model` 启用时必须带合法 `--detect-classes`，模型为设备端 `.onnx` 绝对路径，阈值在 0~1；`--no-detect` 与 `--detect-model` 互斥；已启用检测的项目重新生成必须带检测参数或 `--no-detect`。详见「六、目标检测」。
11. 目标检测是**生成期开关**（默认关闭，探索契约不新增字段）：`--detect-model` 启用时必须带合法 `--detect-classes`，模型为设备端 `.onnx` 绝对路径，阈值在 0~1；`--no-detect` 与 `--detect-model` 互斥；已启用检测的项目重新生成必须带检测参数或 `--no-detect`。详见「六、目标检测」。

## 四、失败处置

| 校验失败 | 处置 |
| --- | --- |
| 缺 `state-model.json` / 坐标契约 | 停止生成，回到探索运行目录补产物 |
| 状态无锚点、锚点无法 OCR 命中 | 回到探索运行目录补锚点证据；不得用坐标硬顶 |
| 证据标签未映射 | 在 `evidenceStateAliases` 里补映射，或在证据索引里标 `UNMAPPED` |
| `readiness=ready` 但没有任务卡 | `--check` 报 error，停止生成；先把任务卡补齐（含 verify 判据）或把 readiness 降为 partial |
| `readiness=partial/blocked` | 生成 not-ready 占位模块 + README 标缺口与 missingEvidence；不得生成可执行任务 |
| 守卫 / 读数 / marker 接线缺失 | `--check` 报 error，按提示补任务卡字段；不得用放行或默认值掩盖 |
| 元素引用不存在、pattern 非法、起点状态不存在 | `--check` 报 error，修正契约后重新生成 |

## 五、版本与兼容

- 契约 `schemaVersion` 变更属于破坏性变更：生成器必须显式拒绝未知版本，而不是尽力解析。
- 生成物与契约版本绑定；契约变化后重新生成。
- `config/`、`core/`、`main.js`、`tasks/`（含占位）与项目 `README.md` / `AGENTS.md` / `agent/manifest.json` 都是生成物，禁止手改；业务逻辑只回到任务卡（`requestedScripts[].spec`）修改，再 `--force` 重新生成。
- `readiness` 是防过期门禁：任务卡内容变化（元素、读数、判据、起点状态）后必须降级为 partial 并重新做脚本级复跑，不得沿用旧 readiness。

## 六、目标检测（可选能力，生成期开关）

生成器不假设设备上有检测插件或模型；这是**用户决策**，由生成期参数显式启用（不在探索契约里新增检测字段，避免第二套格式）：

| 参数 | 说明 |
| --- | --- |
| `--detect-model <设备路径>` | 启用目标检测；必须是设备端绝对路径且 `.onnx` |
| `--detect-classes <类1,类2>` | 启用时必填；与模型同目录 `classes.json` 一致（yolodet 按类名过滤） |
| `--detect-min-score <0~1>` | 可选，全局置信度阈值，默认 0.5 |
| `--detect-class-min <类=阈值,...>` | 可选，按类覆盖阈值；类名必须在 `--detect-classes` 中 |
| `--no-detect` | 显式关闭；已启用检测的项目重新生成时用于明确降级 |

启用后生成物新增：

- `core/detect.js`：插件懒加载 + `setModel`/`prepare` 预热 + `detectEx(shotPath)` + 按类阈值过滤；失败返回 `{ ok:false, message }`，不降级、不猜。
- `config/detection.json`：模型 / 类别 / 阈值 / 插件与来源（训练技能的 `check-env.py` 与 `verify-on-device.js`）。
- `tasks/detect-targets.js`：只读框架任务，逐类计数并发 `TARGETS_DETECTED` marker，作为首跑门禁（在写入任务之前跑）。

校验规则（不通过即 error）：

1. `--detect-model` 必须是设备端绝对路径（以 `/` 开头）且以 `.onnx` 结尾；
2. 启用时 `--detect-classes` 不能为空，类名唯一且匹配 `^[A-Za-z0-9_.-]+$`；
3. `--detect-min-score` 与 `--detect-class-min` 的值必须在 0~1；分类阈值里的类名必须在 `--detect-classes` 中；
4. `--no-detect` 与 `--detect-model` 互斥；未带 `--detect-model` 时不允许出现其它检测参数；
5. 已启用检测的项目（`config/generated.json` 的 `detection.enabled=true`）重新生成时，必须带 `--detect-model` 或显式 `--no-detect`，否则拒绝生成。

生成之前的前置（由 AI 负责，不是生成器职责）：

- 训练机侧跑 `hz-autojs-detect-trainer/scripts/check-env.py`（未就绪先 `setup-env.ps1`）；
- 设备侧确认 yolodet 插件在位、模型与 `classes.json` 已推送、端上验收结论在案；
- 模型还没有时先走训练技能六阶段（含端上验收），不在生成期假设或凭空填模型路径。