---
name: hz-autojs-automation-builder
description: 消费 hz-autojs-task-explorer 产出的 project-request.json、state-model.json、坐标契约与证据索引，生成可在 V5 设备上长期运行的固化自动化项目，并完成项目同步、运行、日志读取、性能基准与固定回归。用于探索已完成、要把一次性探索结论编译成固化脚本的场景；生成与诊断用本技能，设备操作、AutoJs API 与项目部署分别复用 hz-autojs-device-operator、hz-autojs-script-author、hz-autojs-project-developer。
---

# 自动化项目生成技能

`hz-autojs-task-explorer` 负责**发现与验证**，本技能负责**编译与固化**。本技能把探索结论编译成独立项目，稳定运行期不再依赖逐帧 AI 决策。

涉及目标设备的生成、运行和诊断时，[手机本地操作记忆](../hz-autojs-device-memory/SKILL.md) 只在重复失败、复用同版本同页面经验或核对已知反例时按需读取；稳定生成与执行不得依赖记忆，已验证的绕过经验再主动写回手机。

## 定位与边界

- **只消费契约，不重新探索**：输入是 `project-request.json`、`state-model.json`、坐标契约和证据索引。契约里没有的事实，回到 `hz-autojs-task-explorer` 补证据，不在生成期猜。
- **独立项目边界**：生成的项目是独立工程，不写进 `legacy/examples/hz_autojs_game_script`，也不从根仓库提交它的 Git 变更；不写入插件安装目录、客户端缓存或临时目录。
- **输出目录约定**：`--out` 传本地项目根，项目落在 `<本地项目根>/projects/<项目名>/`；用户未指定时，本地项目根统一取当前工作目录的 `hz-autojs-projects`。
- **AI 退出稳定循环**：AI 只在生成、诊断、修复和升级阶段介入；常规状态全部由固化脚本处理。
- **目标检测是可选能力（生成期问用户）**：生成前必问一次是否启用端上目标检测（yolodet）；确认启用要先经 `hz-autojs-detect-trainer` 的环境检测与端上验收，再把模型/类别写进生成参数；拒绝则不生成任何检测代码、不引入插件依赖。
- **不凭记忆写 AutoJs API**：任何设备侧 API 先查 `autojs_docs_search` / `autojs_docs_read`；设备动作只用 `__toolbox*` 模式感知 API。
- **证据仍然是硬要求**：每次复跑追加运行记录，不覆盖历史；失败样本和成功样本一起留。

## 商业授权归类

本技能**不新增商业授权能力项**。它只编排 V5 既有能力（设备观察与动作、项目同步与运行、可选打包），沿用既有授权键、设备访问门禁和审计；生成项目在设备上以 AutoJs 项目运行，不绕过商业授权、设备访问、部署来源边界或审计。打包（`packaging.apkBuild`）只在用户明确要求出包时才走，不作为生成流程的默认步骤。

## 必需前置

1. 探索产物齐备，且证据可校验：`node <task-explorer>/assets/tools/capture-evidence.mjs --run <运行目录> --verify` 返回 `bad: 0`。
2. 加载 `hz-autojs-script-author`（脚本规则、`__toolbox*`、顶层 `return` 禁令）与 `hz-autojs-project-developer`（同步、运行、状态与日志）。
3. 设备在线并确认 `directControlMode`；`AUTO` / `ACCESSIBILITY` / `PRIVILEGED` 按设备现状使用，不擅自切换。
4. 目标应用处于可自由操作状态；教程引导层或奖励弹层未消解时先处理，不在遮挡层上生成与调参。

## 运行期对话（用户打开生成项目跟 AI 说话时）

生成项目自带 `AGENTS.md`（AI 入口，在 Codex 里打开该项目时自动加载）与 `agent/manifest.json`（能力清单）。用户问「这个项目能做什么 / 我现在要做什么 / 怎么做 / 发指令」时：

1. 先读 `AGENTS.md` + `agent/manifest.json`，不要凭记忆答。
2. 按四段回答：**这是什么 → 现在能做什么（按「不消耗 / 只走免费次数 / 有守卫 / 禁止」分组）→ 现在在哪、建议做什么 → 你可以怎么说**。
3. 「现在在哪」必须先只读跑一次 `detect-state.js`（`project_run` 默认 dryRun 就是它），再挑前置状态满足的就绪任务；没有合适任务就直说，不硬凑。
4. 只列 `status` 为 `generated` / `needs-verification` 的能力；`partial-implementation`、`not-implemented` 和 `missingEvidence` 一律按「未实现 / 缺证据」回答，不许承诺。
5. 写入任务必须先讲清消耗与守卫，拿到用户明确指令才执行；参数必须**同时**给 `dryRun: false` 与 `allowWrite: true`，缺一项会被拒绝并判失败。禁止文本一律跳过，不降级、不试探。
6. 任务只从任务卡（`requestedScripts[].spec`）编译；`tasks/` 是生成物，禁止手改。`AGENTS.md` 与 `agent/manifest.json` 同理由生成器维护，契约变化后重新生成（`--force`）。

## 生成闭环

1. **契约校验**：`state-model.json` 有状态与锚点、坐标契约无裸像素、证据索引的 `state` 能通过 `evidenceStateAliases` 挂回标准状态、守卫清单（`forbiddenTexts` / `guardedActions`）存在；每个 `requestedScripts[]` 条目必须带合法 `readiness`，`ready` 必须带结构化任务卡（`spec`）。执行保真度问题（marker、守卫接线、起点状态、读数供给）缺任何一项即停。
2. **生成项目（先问目标检测）**：
   - **必问一次**：本项目是否启用目标检测（yolodet 端上检测，用于「看画面做判断」，替代不稳定的颜色/模板规则）。
   - 用户确认启用：先调 `hz-autojs-detect-trainer` 做前置——训练机侧跑 `scripts/check-env.py`（未就绪先 `setup-env.ps1`）；设备侧确认插件 `com.zjh336.cn.tools.plugin.yolodet` 已装、`/sdcard/appSync/yolo/<run>.onnx` 与同目录 `classes.json` 在位、端上验收结论在案（`assets/verify-on-device.js`）。模型还没有就先按训练技能六阶段训出并端上验收，再回来生成。生成命令追加 `--detect-model <设备端 .onnx> --detect-classes <类1,类2> [--detect-min-score 0.5] [--detect-class-min nav=0.6]`，生成物必含 `core/detect.js`、`config/detection.json` 与只读冒烟任务 `detect-targets.js`。
   - 用户不启用或拒绝：不带检测参数生成；项目无检测代码、无插件依赖，`config/generated.json` 记录 `detection.enabled=false`。已启用检测的项目重新生成必须显式带检测参数或 `--no-detect`，不能静默丢能力。
   - 其余照旧：`node assets/tools/generate-project.mjs --run <探索运行目录> --out <本地项目根> --id <项目名>`；`<本地项目根>` 未由用户指定时取当前工作目录的 `hz-autojs-projects`，项目落在其 `projects/<项目名>/` 下；生成器只读契约，不联网、不访问设备；只有 `readiness=ready` 的脚本编译成可执行任务，其余生成 not-ready 占位。
3. **静态自检**：`--check` 校验坐标契约、状态引用、任务卡完整性与执行保真度（marker 双向覆盖、守卫读数接线、`startStates × 步骤元素` 可达性、verify 判据与读数一致性）；error 非空就不许生成，更不许同步。生成器自检工具：`node assets/tools/self-test.mjs`。
4. **同步**：`project_sync_plan` 算差异 → `project_sync_push` 按显式清单推送（`localRoot` 指向 `<本地项目根>/projects/<项目名>/`；一次同步只提交一个设备任务）。
5. **首跑分级**：先跑只读任务（`bootstrap` / `detect-state`；启用目标检测时加 `detect-targets`）确认契约与检测通道，再跑写入型任务；每级都要有成功判据。
6. **验收**：`project_task_logs` / `project_deploy_status` 读结果；marker 只在任务 `verify` 判据通过后发出，业务成功还要对照锚点、数值增量和反向判据（如紫晶卡不减少）。`SUCCEEDED` 只代表脚本跑完。
7. **基准**：记录端到端耗时、脚本内耗时、AI 调用次数（首版目标 0）和失败恢复次数。
8. **回归**：按 `references/verification-and-benchmark.md` 的固定回归清单复跑，结果追加到 `runs/`。

## 运行时契约（已实测，别改成别的写法）

设备侧脚本可用的两条主链路：

| 用途 | 写法 | 状态 |
| --- | --- | --- |
| 观察 | `__toolboxScriptRequire('toolManager.js')` → `captureScreenshot({ outputPath })`、`recognizeText({ sourcePath, x1, y1, x2, y2 })` | 已实测（MLKIT_PLUGIN，返回带 `bounds` 的 `items`） |
| 动作 | `__toolboxTap` / `__toolboxLongPress` / `__toolboxSwipe` / `__toolboxScroll` / `__toolboxText` / `__toolboxAction` | 已实测（`AUTO` 模式） |
| 目标检测（可选） | `$plugins.load('com.zjh336.cn.tools.plugin.yolodet')` → `setModel(model)` / `prepare()` / `detectEx(shotPath)`（`core/detect.js` 封装，按类阈值过滤） | 已实测（2026-10-08，dupo_ui_v6：nav=6 badge=11，infer 111ms） |

实测记录：探针任务 `91b016e88cfd402bb8a05697de09d41e`（2026-10-01 夜，1080×1920 PNG + 顶栏 OCR）。
目标检测实测：设备任务 `0d6e222a28aa40419d1737be0351fc22`（2026-10-08，dupo_ui_v6.onnx + classes.json，只读脚本返回 nav=6 / badge=11，wall 170ms / infer 111ms）。
生成物实测：设备任务 `881edbf0d0434cf6ab2158bb31455e0b`（2026-10-08，生成器产出的 `core/detect.js` 原样下发运行，GENDETECT_CHECK badge=11 / nav=6，infer 99ms/68ms，返回真实 bounds）。

硬约束：

- **禁止** `images.requestScreenCapture()`：它会抢占工具箱的 MediaProjection 通道，让宿主截图变纯黑。
- **禁止**裸无障碍 API（`click` / `swipe` / `text` / `id` / `currentPackage` 等）：`PRIVILEGED` 模式下会抛 `ACCESSIBILITY_FORBIDDEN_BY_MODE`，也不要 `try/catch` 换成无障碍兜底。
- **禁止**顶层 `return`：Rhino 编译期报 `invalid return`，子引擎来不及上报终态。结果用日志 marker：`log('MARKER:' + JSON.stringify(payload))`。
- 坐标只用契约（`anchor` / `edge` / `ratio`），脚本运行时解析成像素；脚本里不出现裸像素词表。
- 付费与消耗入口按守卫清单处理：`forbiddenTexts` 一律跳过，`guardedActions` 先读数值再决定。
- **配置用读文件而不是 `require`**：`require` 只保证 `.js` 模块；`require('./config/x.json')` 在 `RUN_SCRIPT_FILE` 通道会把 JSON 当脚本编译（实测 `missing ; before statement`）。统一用 `files.read(files.cwd() + '/config/x.json')` + `JSON.parse`。
- **锚点元素的退路**：`ratio` / `edge` 元素必须带 `fallback`；`anchor` 元素要么补几何 `fallback`，要么显式声明 `noFallbackReason` 接受 fail-closed（OCR 未命中即停机，不盲点）。2026-10-02 真机实测：`日常修行` 四个页签只有 anchor、没有退路，OCR 读不到「金币」标签时任务直接失败关闭。缺 `fallback` 且未声明 `noFallbackReason` 会在 `--check` 里出 warning。
- **状态锚点必须页面独有**：不得用会在公告、提示语或其他页面出现的通用词。2026-10-02 真机实测：`斗者` 出现在布阵提示语，布阵页被误判为主城；战斗界面渲染 `城市/冒险/纳戒/势力/历练`，BATTLE 页会被误判为 MAIN_CITY。锚点以真机 OCR 复核：通用词降权或删除，页面独有词用 `{ text, weight, required, exclusive }` 表达，非 OCR 词（血条 / 技能图标等）标 `kind: visual`，不得进入 OCR 打分。
- **任务名统一带 `.js`**：`main.js` 会把不带后缀的任务名补成 `.js`，并只接受 `^[A-Za-z0-9._-]+\.js$`；任务是否只读由任务模块自己的 `readOnly` 标记决定，不存在第二份白名单。

## 守卫规则

生成的项目必须在动作层统一拦截，不能靠每个任务自己记得：

- `forbiddenTexts`（斗破案例：`购买` / `充值` / `战令`）三层判定：点击目标的元素文本、点击落点的 OCR 命中文本、消耗类动作的读数。命中即拒绝执行并写运行记录。
- `guardedActions`：`快速修炼`（只走每日首次免费）、`捐献`（只走 0 消耗免费次数）、`凝练`（先读贡献 ≥1700）、`扫荡`（只走每日免费次数）。消费步骤必须 `readFirst: true` 并产出对应 `readingKey`，读数不足即停在原状态并记录，不重试；`--check` 对这条接线按 error 校验。
- 没有就绪任务消费的守卫：warning + 写入 `uncoveredGuards`，相关能力一律按未实现回答。
- 未知状态：最多升级 `maxUnknownStateEscalations` 次（默认 2），超过则停机并保留截图，等 AI 诊断，不盲目连点。

## 失败与恢复

按成本从低到高：

1. 单次识别失败 → 重新截图重试一次。
2. 锚点已命中但动作后状态未变 → 判定未消费事件，停止连点；先查教程引导层与奖励弹层。
3. 弹层队列 → 按案例里的底部空白区关层，避开中间道具图标。
4. 资源不足 → 停在原状态记录，不降级到替代路径。
5. 应用卡死 → 结束目标应用重开；恢复后重新判状态，不假设卡死前的画面仍有效。
6. `__toolbox*` 抛通道原因码（`SHIZUKU_UNAVAILABLE` / `NO_CHANNEL_AVAILABLE` 等）→ 如实上报，不改用无障碍兜底。
7. 同步阶段每个文件都报 `下载失败，HTTP状态: 401` → 判定为 V5 Web 登录保护下的设备下载无票据，停止重推；处置顺序见 `references/verification-and-benchmark.md` 的「同步」前置检查。

## 产物契约

```text
<本地项目根>/
  projects/<项目名>/
    project.json           AutoJs 项目声明（同步与运行入口）
    main.js                入口：读任务模块 readOnly → dryRun/allowWrite 门禁 → 执行 → 判据
    core/                  坐标解析、观察、动作、三层守卫、状态打分、状态机、记录
    tasks/                 任务卡编译出的任务模块 + 未就绪占位（生成物，禁止手改）
    config/                由契约生成的坐标、状态与请求快照
    README.md              任务卡状态 / 未实现 / 运行方式 / 守卫清单
    runs/                  本地运行记录（不进版本库）
```

## 完成标准

- 契约校验与静态自检通过（含执行保真度），生成物可追溯到具体的 `project-request.json` 版本。
- 只读任务在真机跑通，检测通道返回带 bounds 的锚点。
- 至少一个写入型任务完成「动作 → verify 判据 → marker」闭环；判据失败的样本 marker 必须为空。
- 基准与回归记录写入 `runs/`，含 AI 调用次数（稳定期应为 0）。
- 启用目标检测的项目：`detect-targets.js` 只读冒烟在真机跑通（返回带 bounds 的框，阈值过滤符合 `config/detection.json`）；检测失败不得降级为 OCR 猜测或盲点。
- 未就绪任务（partial / blocked）在项目 README、`agent/manifest.json` 的 `missingEvidence` 与 `openGaps` 里显式列出，不写成已完成。

## 交付前自查

- 契约校验通过：`capture-evidence.mjs --verify` 返回 `bad: 0`；`generate-project.mjs --check` 无 error 才允许生成；
- 只有 `readiness=ready` 的任务卡编译成了可执行任务；partial / blocked 如实留占位，缺口写进 README 与 `agent/manifest.json`；
- 生成物没有手改；改动一律回到任务卡/契约后 `--force` 重新生成；
- 输出目录用本地项目根约定（用户未指定时为当前工作目录的 `hz-autojs-projects`），没有写进插件目录、缓存或临时目录；
- 真机首跑先只读任务（`bootstrap` / `detect-state`，启用检测时再加 `detect-targets`）再写入任务；marker 只在 `verify` 判据通过后出现。
- 目标检测选择已问过用户并留痕（`config/generated.json` 的 `detection` 段）；启用时先有训练技能的环境检测与端上验收结论，再生成检测代码。

## 相关文档

- `references/generation-contract.md`：输入契约字段、校验规则与不满足时的处置。
- `references/project-layout.md`：生成项目结构、模块职责与运行时库设计。
- `references/verification-and-benchmark.md`：同步、分级首跑、基准指标与固定回归清单。
- `assets/tools/README.md`：生成器用法、`--check` 校验项与 `self-test.mjs` 自检。
- `references/examples/dupo-cangqiong/`：示例生成项目。与用 `hz-autojs-task-explorer/references/runs/dupo-cangqiong-20261001/` 契约的生成结果一致（除生成时间戳）；它同样是生成物，禁止手改，改动回到任务卡后重新生成。
