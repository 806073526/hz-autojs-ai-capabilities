---
name: hz-autojs-task-explorer
description: 把未知 Android 应用或游戏任务探索成可复用的领域技能、最小脚本、状态模型、原始证据（含截图）和项目请求（project-request.json）。用于 V5 设备上的探索型自动化任务；先使用 hz-autojs-device-operator、hz-autojs-script-author 和 hz-autojs-project-developer，本技能负责探索编排、证据留存、固化与交接。
---

# 任务探索元技能

当任务目标已知、但页面流程、状态、锚点和可执行动作尚未摸清时使用本技能。它不替代设备操作、脚本编写或项目部署技能，而是在三者之上规定探索顺序、证据格式和交接产物。

[手机本地操作记忆](../hz-autojs-device-memory/SKILL.md) 只在重复失败、复用同版本同页面经验或核对已知反例时按需读取，不是设备探索的启动步骤；稳定执行直接依据当前页面证据，验证出新经验后再主动写回手机。

## 定位与边界

- 本技能负责把未知任务变成可验证的领域技能和可固化脚本，不负责长期运行时逐帧决策。
- 领域事实写入案例和候选技能；通用流程只保留在本技能。
- 探索期间不直接改写稳定技能。先把发现写入运行记录，完成复跑后再提升为候选技能。
- 不凭记忆补 AutoJs API。任何脚本 API 先用 `autojs_docs_search` / `autojs_docs_read` 确认。
- 不把 ADB 当主链路。设备 MCP 工具可用时一律直接用 `mcp__hz_autojs_device_mcp__*`；只有 MCP 未注册、工具箱断开或 MCP 连续失败时才使用插件兜底通道，ADB 只在救援或环境配置场景使用。使用兜底通道时必须把「MCP 未被客户端注册」的事实与注册位置修复指引告知用户，不得静默降级（见 `mcp/docs/fallback-channel.md`）。
- **坐标必须可移植**：案例、脚本、候选技能、项目请求里不允许出现没有归属说明的裸像素坐标对。坐标一律表达为契约（锚点 / 边缘 / 比例），在运行时解析成设备像素。详见 `references/cases/multi-resolution-adaptation.md`。

## 必需前置

1. 加载 `hz-autojs-device-operator`，确认设备 ID、在线状态和 `directControlMode`。
2. 需要执行 AutoJs 脚本时加载 `hz-autojs-script-author`，并先查离线 API 文档。
3. 需要同步项目、运行项目、打包或安装时加载 `hz-autojs-project-developer`。
4. 用户未明确要求切换时，不修改 `directControlMode`；`AUTO`、`ACCESSIBILITY` 和 `PRIVILEGED` 按设备现状使用。

## 运行期对话（用户打开探索运行目录跟 AI 说话时）

探索运行目录自带 `AGENTS.md`（AI 入口，在 Codex 里打开该目录时自动加载）与 `agent/manifest.json`（机器可读清单）。用户问「这个探索现在到什么程度 / 现在能做什么 / 下一步做什么 / 你能发什么指令」时：

1. 先读 `AGENTS.md` + `agent/manifest.json`，不要凭记忆答。
2. 按四段回答：**这是什么 → 已经探到什么、能做什么 → 现在在哪、下一步建议 → 你可以怎么说**。
3. 只报清单里的真实数字（状态数、已验证锚点数、证据条数、未标定条数）；有状态没证据就显式说出来，不给用户错觉。涉及交接时看 `handoff.readyScripts` / `blockedScripts`：未就绪脚本只能报缺口，不得说成「可以生成/已经可用」。
4. 用户发指令后按指令动手（继续探索 / 补证据 / 校验证据 / 生成项目）；需要设备操作时先确认设备与当前画面。
5. 探索每推进一轮就刷新一次说明书：`node assets/tools/refresh-agent-brief.mjs --run <运行目录>`。不刷新等于给用户过期信息。

## 探索闭环

1. 任务界定：记录目标、成功条件、禁止动作、目标设备、目标应用和允许的风控边界。
2. 环境侦察：`device_status`、`device_screenshot`、`device_layout_dump`（结构分析口径：`layoutRange: "all"`、`limit: 0`、`visibleOnly: false`），确认包名、Activity、方向、截图链路、节点树可用性和执行模式。当前没有只读 OCR / 图像匹配 MCP 入口，证据采集不得调用会点击的 `device_tap_target`。
3. 状态建模：把页面拆成可识别状态，记录进入条件、可观察锚点、可执行动作、退出条件和失败恢复。
4. 目标选择：优先选无支付风险、可重复、反馈明确的动作；跳过购买、账号变更、删除、授权变更等高风险动作。
5. 探针实验：一次只改一个变量，记录起止画面、OCR 结果、坐标来源、耗时和返回值。
6. 最小脚本：先写能证明单一行为的短脚本；参数通过 `scriptParams`，不用字符串替换注入。
7. 证据固化：保存截图、OCR 命中、坐标标定、日志 marker、成功和失败样本。
8. 复跑验证：在同一设备和同一版本上复跑；必要时验证横竖屏、分辨率或弹窗差异。按**脚本级**验收：要标 ready 的任务卡必须有单一探针脚本走通「入口 → 动作 → 判据 → 复位」并留 `runs/` 记录；只做过单点动作验证的脚本只能标 partial，并写清 `missingEvidence`。
9. 候选技能：生成领域 `SKILL.md` 草案，明确哪些是已验证事实，哪些仍是假设。
10. 生成交接：生成带任务卡的 `project-request.json`，让后续生成器只消费契约，不重新探索。执行方是 `hz-autojs-automation-builder`，它读任务卡 + `state-model.json` + 坐标契约编译独立项目；没有任务卡的脚本只生成 not-ready 占位。

## 产物契约

探索工作区至少保存以下产物。在代码仓库内探索时，运行目录约定为仓库根的 `data/exploration/<runId>/`，该路径已被 `.gitignore` 覆盖；没有仓库上下文时，放到宿主指定的探索工作区即可。无论哪种情况，截图等二进制原始数据都留在本地，版本库只收文本与索引。

```text
data/exploration/<runId>/
  AGENTS.md            AI 入口：用户打开本目录对话时按四段回答（自动生成，勿手改）
  agent/manifest.json  机器可读：进度、状态与动作候选、证据覆盖、交接物、nextSteps（自动生成，勿手改）
  task-spec.json
  state-model.json
  evidence/
    manifest.json        证据索引：每条含时间、状态、文件、字节数、sha256、OCR 锚点
    screenshots/         原始截图（默认 jpg/q85，--format png 可无损；本地留存，不进版本库）
    meta/                device_screenshot 工具原始返回
  probes/
  runs/
  findings.md
  candidate-skill/SKILL.md
  project-request.json
```

各文件职责：

- `task-spec.json`：目标、设备、应用、成功条件、风控边界和必须采集的证据。
- `state-model.json`：状态、观察锚点、动作、转移和恢复路径。证据索引里的 `state` 是采集当时的标签；当它与标准状态 ID 不一致时，必须额外给出 `evidenceStateAliases` 映射表，否则生成器无法把证据挂回状态。
- `evidence/`：截图、OCR 结果、坐标标定和任务结果摘要。结构、字段与采集命令见「证据留存」一节；`manifest.json` 是唯一索引，任何截图都必须能被它引用并用 sha256 校验。
- **证据同时是检测模型训练的数据源**：截图（保留原始分辨率）＋ `state` 标签 ＋ sha256 构成可被训练流程直接消费的最小契约（已实测：时间戳可把旧式 `runs/shots` 与 `runs/run-*.jsonl` 的 detect 记录挂回状态）。训练侧的补采截图追加回 `evidence/` 并登记 manifest，双方以本目录字段契约为唯一约定，不另设第二套格式；探索侧不要删除或压缩已登记的原图。
- `probes/`：一次性探针脚本，验证单一行为。
- `runs/`：每次复跑的原始日志、耗时和结论。
- `findings.md`：已证实事实、仍待验证假设、失败模式和下一步。
- `candidate-skill/SKILL.md`：可提升为领域技能的草案。
- `project-request.json`：交给 `hz-autojs-automation-builder` 生成器的任务卡清单。每个脚本必须有 `name` + `duty` + `readiness`（ready / partial / blocked）；`ready` 必须带结构化 `spec`（startStates / steps / readings / verify / markers），`partial` / `blocked` 必须带 `missingEvidence`。字段契约以同插件 `hz-autojs-automation-builder/references/generation-contract.md` 为准。

示例文件见 `assets/`，证据工具见 `assets/tools/README.md`。斗破苍穹首个案例见 `references/dupo-cangqiong-case.md`。

## 应用画像与策略

先判断目标属于哪一类，再决定观察和动作方式：

| 画像 | 识别信号 | 首选策略 | 典型案例 |
| --- | --- | --- | --- |
| 节点型 | `device_layout_dump` 返回稳定节点，存在 `id` / `text` / `desc` | 判断可用性用 `device_find_node`（默认只给可用节点、不限数量）；看整体结构用 `device_layout_dump` 结构分析口径，坐标只作兜底 | Android 设置 |
| 画布 / 自绘型 | 布局为空或节点极少，画面由引擎绘制 | 截图、OCR、图色探针、固定状态机 | 斗破苍穹战斗 |
| WebView / 混合型 | 有 WebView 容器但正文节点不稳定 | 先用结构分析口径读全量节点（`layoutRange: "all"`、`limit: 0`、`visibleOnly: false`）：WebView 会把整个 DOM 报出来，视口外节点边界退化，开 `visibleOnly` 会丢掉大半；仍不足再退回 OCR，注意滚动和懒加载 | 待补案例 |
| 广告 / 教程遮挡型 | 首次进入出现弹层、遮罩、手势引导 | 先做弹层识别和关闭动作，再进入业务状态 | 斗破苍穹活动弹窗 |
| 教程引导型 | 屏幕出现手指图标 + 提示文字，且**只有高亮目标可点** | 跟随高亮目标推进教程，不要尝试绕开；非高亮目标点击会被吞 | 斗破苍穹新手链 |
| 奖励 / 展示队列型 | 结算后连续出现多层全屏升级、开箱、道具说明、功能解锁 | 逐层关闭并复核；关层时避开中间可交互图标 | 斗破苍穹升级奖励层 |
| 挂机 / 累积型 | 有倒计时、`/M` 单位收益率、`奖励可领取` 标签 | 先读累积状态，再执行一次领取，最后用资源增量或倒计时归零验证 | 斗破苍穹修炼石台 |
| 任务领取面板型 | 多张任务卡，状态为 `领取` / `已完成` / `前往` | 扫描所有可领取卡片，逐个领取并复核状态与资源增量 | 斗破苍穹境界面板 |
| 不稳定型 | 截图超时、进程僵尸、设备离线、应用闪退 | 只记录反例，不把它作为首批固化目标 | Landscape Test、抖音闪退 |

遮挡层内部还要再分两类，处置完全不同：

- **可交互遮挡层**：有真实关闭按钮或点击任意处关闭，可用一次点击 + 状态复核穿越。
- **教程引导层**：手指图标 + 提示文字，输入被过滤，只有高亮目标可点。必须跟随引导，绕行会一直失败。
- **非交互遮挡层**：排除了「点击落在可交互元素上」之后，`__toolboxTap` 仍持续返回 `success=true` 而锚点不变。此时才停止连点，改用等待、系统返回、重启应用等恢复手段。

### 弹层队列与"关不掉"假象

结算类页面常有多层弹层排队展示（升级 → 道具详情 → 功能解锁）。排查要点：

- 关层时点击**底部提示区或空白区**，不要点画面中间的道具/按钮图标。
- 点了图标会重新打开上一层，形成 A↔B 循环，容易被误判成"层不可交互"。
- 若锚点在两个状态间来回切换，先怀疑命中了可交互图标，而不是先怀疑弹层无响应。
- 判定"不可交互"必须同时满足：已避开可交互元素 + 单次点击后锚点不变 + 等待后仍不变。

## 状态转移验证

探索的核心产物不是「点了哪里」，而是「什么观察能证明状态已转移」。执行规范：

- 每个关键动作后必须指定一个**状态锚点**并实际复核，锚点优先用 OCR 文本、数值、节点字段。
- `__toolboxTap` / `device_tap` 的 `success=true` 只代表事件下发成功，**不代表应用消费了事件**。
- 同一动作连续两次后锚点不变，判定为「疑似非交互遮挡或该动作无效」，停止重试并升级恢复手段。
- 数值型锚点（如 `上阵人数:2/6`、`等级:3`、`第1/15回合`）比按钮高亮更可靠，优先采集。
- 战斗、动画、加载期间不要带 `waitStable=true`；用普通截图 + 明确 sleep 或锚点轮询。

## 证据留存（原始数据 + 截图）

探索必须留下原始数据，而不只是结论。四条硬规则：

1. **原始优先**：状态判断的每个关键节点都要有当次截图，而不是事后凭记忆补描述。截图与工具元数据一并保留。
2. **哈希可校验**：每条截图记录写入 `sha256` 与字节数，任何后续整理都能证明文件未被替换。
3. **二进制不进版本库**：截图、日志属于运行数据，写入 `data/exploration/<runId>/`；版本库只提交由清单派生的文本索引（状态、时间、sha256 与可复核摘要）。
4. **按用途选格式**：当前操作要用颜色（取色、图色匹配、颜色阈值、写进脚本的颜色参数）→ `--format png`，无损、颜色准确；只是识别页面上有什么内容、记录步骤或留痕复查 → 默认 `jpg`（q85，同屏约为 PNG 的 1/8，想更省用 `--quality 60`）。同一批证据可以混用：取色图用 PNG，过程留痕用 JPG。

### 采集与校验工具

宿主侧工具位于 `assets/tools/`，直接通过 stdio 驱动设备 MCP，不占用脚本引擎的截图通道。

```powershell
# 采一张：落盘截图（默认 jpg/q85）+ 工具元数据，并追加 manifest 记录
node assets/tools/capture-evidence.mjs --device <deviceId> --run data/exploration/<runId> `
  --label <短标签> --state <状态ID> --note "<说明>"

# 这一张要用来取色/做颜色判断：改用 PNG 无损
node assets/tools/capture-evidence.mjs --device <deviceId> --run data/exploration/<runId> `
  --label <短标签> --format png --no-status

# 归档此前散落的截图（按 sha256 去重，可重复执行）
node assets/tools/import-screenshots.mjs --run data/exploration/<runId> --source <旧目录> --state <默认状态>

# 校验：重算所有记录的 sha256 与字节数
node assets/tools/capture-evidence.mjs --run data/exploration/<runId> --verify
```

详细用法与输出格式见 `assets/tools/README.md`，清单字段示例见 `assets/evidence-manifest.example.json`。

### 清单字段

`manifest.json` 顶层记录 `runId`、`device`、`app` 和 `records[]`。每条记录至少包含：

- `capturedAt` / `label` / `state` / `note`：何时、何状态、何说明。
- `screenshot.file` / `bytes` / `sha256`：截图相对路径、字节数、哈希。
- `device` / `app`：分辨率、直控模式、包名、Activity，供多分辨率与版本比对。
  历史运行目录可能保留旧版 `ocr/` 数据作为既有证据，但新采集不再生成该目录。

### 截图链路事实

- `device_screenshot` 报告里的 `path` 是设备侧路径；把宿主路径填进 `outputPath` 不会在宿主生成文件。
- 宿主可见图片必须靠 `includePreview` 返回的图片块解码落盘；设备侧 PNG 只供脚本读取。
- `size=0` / `fileSize=0` 是常见返回，不代表截图失败；以图片块是否返回和哈希校验为准。
- 每个成功案例至少保留：状态锚点、坐标来源、动作序列、成功样本、一次失败或恢复样本。
- 探索工作区参考实现见 `assets/probes/`；案例记录见 `references/cases/`。

## 挂机 / 累积型任务模板

这类任务（修炼石台、离线收益、扫荡、每日领取）是自动化项目生成最容易固化的目标，因为状态少、反馈明确。统一按下面的顺序做：

1. **定位入口**：主界面或子页面上的图标、`奖励可领取` 标签、倒计时。倒计时本身就是"是否可领"的低成本判据。
2. **进入面板**：读取累积量与单位收益率（常见写成 `54/M`、`17/M`）。
3. **守卫付费/消耗入口**：面板上常同时存在付费购买、加速、快速修炼等入口，探索时只走"领取"路径，付费入口只记录不点击。
4. **执行一轮**：点击领取，观察奖励弹层与资源变化。
5. **验证**：用顶栏资源增量、倒计时归零、或累积量重置作为成功判据；不要只看弹层出现过。固化时把这条写成任务卡的 `readings`（`when: "both"` 或 `after`）+ `verify`（`changed` / `number`），不要只留在案例里。
6. **记录上限与冷却**：是否封顶、是否离线计入、加速是否消耗道具，都属于固化的必要参数，未验证的要显式标成缺口。

参照案例：`references/cases/dupo-cangqiong-idle-cultivation.md`。

## 任务领取面板模板

日常、成就、境界、通行证等页面通常是「多张任务卡 + 一键领取」，比单点流程更适合批量固化：

1. **扫描**：截图 + OCR 找出所有按钮文本，按 `领取` / `已完成` / `前往` 分类。
2. **过滤**：只处理 `领取`；`前往` 是否安全取决于目标页，必须显式列出白名单。
3. **领取**：逐个点击，每次点击后立刻关闭奖励弹层。
4. **验证**：复核该卡片状态从 `领取` 变为 `已完成`，并核对顶栏资源增量；固化时写成任务卡的 `verify`（锚点 + 数值判据）。
5. **守卫**：面板上常同时存在战令、购买、充值等付费入口，一律跳过。

参照案例：`references/cases/dupo-cangqiong-realm-panel.md`。

### 找不到入口时的高亮启发

教程解锁新功能后，引导指向的目标可能不是模块入口，而是一个信息条。若提示"已解锁，去看看"却找不到入口，优先点击屏幕上**唯一带高亮边框**的元素（斗破苍穹本例中是左下角任务追踪条）。

## 动态目标定位

- 列表中的“挑战”“升级”“领取”等按钮会随条目位置变化，禁止把行号写死。
- 先用 OCR 定位当前可操作按钮，再取 bounds 中心点击。
- 同一按钮在不同状态下可能移动。斗破苍穹章节页的挑战按钮从 1-1 的 `(850,650)` 移动到 1-2 的 `(909,838)`，必须动态定位。
- 关卡越往后，`挑战` 按钮越靠下：1-3 的目标按钮中心为 `(911,1054)`。列表条目会因已通关标记和滚动位置变化，禁止按行号推算 y。
- 按钮文本被 OCR 误识别时，用相邻稳定文本、颜色门槛或局部图色探针交叉验证。
- 对资源消耗型按钮，先确认资源数量，再执行动作；资源不足时应停在原状态并记录。
- 章节选择页和关卡列表页是不同状态：章节页有右下 `开始挑战`，关卡列表页有条目和 `挑战`。OCR 未命中 `挑战` 时先确认在哪个页面。

## 多分辨率与坐标契约

像素坐标是本技能最容易产生技术债的地方。硬规则如下。

### 平台能力边界（已核实，不要想当然）

- `coordinateMode = "standard"`（配合 `standardWidth` / `standardHeight` / `offsetX` / `offsetY`）**只对图色与图像匹配区域生效**。
- `device_tap` / `device_swipe` 的后端实现是裸的 `click(x, y)` / `swipe(...)`，**没有任何自动缩放**。

结论：图像区域可以交给平台换算；**点击与滑动必须由脚本在运行时自己算出真实像素**。

### 坐标一律写成契约，不写裸像素

每个可点元素必须声明为三种模式之一：

| 模式 | 用途 | 关键参数 |
| --- | --- | --- |
| `anchor` | 首选。有 OCR 文本、图色模板或节点可定位的元素 | `anchor.by/text` + `offset.dx/dy` |
| `edge` | 贴边元素：底部导航、顶部条、四角按钮、弹层角落 | `edge` + `dx` + `dy` |
| `ratio` | 真正随画布等比缩放的元素：场景热点、编队格位 | `rx` / `ry` |

判定要点：

- 贴边元素**禁止**用 `ratio`。底部导航在 18:9 / 20:9 长屏上不会等比缩放，用 ratio 必然漂移。
- **必须支持分轴定位**：同一个元素的 x 与 y 常常规则不同。底部导航是 `xMode: ratio`（按宽度铺开）+ `yMode: edge`（贴底固定）；四角按钮两轴都贴边；居中弹窗按钮 x 居中、y 贴底。只声明一个 `mode` 会在宽屏或长屏上出错。
- 有稳定锚点时优先 `anchor`；`ratio` / `edge` 只是锚点不可用时的退化方案。
- `ratio` / `edge` 元素必须写 `fallback`；`anchor` 元素要么写 `fallback`，要么显式写 `noFallbackReason` 接受 fail-closed（OCR 未命中即停机），不要留空。
- 建议给元素标 `visibleInStates`（该元素在哪些状态可见可点），生成器用它校验任务卡起点与步骤元素的可达性。

实测反例（基准 1080×1920 → 1080×2340）：布阵页 `出战` 用纯 ratio 会漂移 54px（短边的 5%），远超 1.5% 容差；而离底边更近的底部导航只漂移 10px。**离锚定边越远，漂移越大**，所以不能靠"离得近的元素看着没问题"来推断 ratio 可用。

### 基准空间与分辨率分组

- 坐标契约必须声明 `baseline`（例如 `1080×1920`）。`dx/dy/rx/ry` 都是基准空间里的量，不是设备像素。
- 按宽高比分桶验证：`16:9` / `18:9` / `19.5:9+`。跨桶时贴边元素必须切 `edge`。
- 没有实测证据的分辨率分组只能标成"未验证"，不得声明支持。
- 手游可能等比缩放留黑边。先判定渲染区是否有黑边，再决定用 `fit` 还是 `stretch` 映射，不要默认铺满全屏。

### 校准与残差校验

固化脚本启动时按顺序做：

1. 读 `device_status`，记录 `screenWidth` / `screenHeight` / 宽高比。
2. 用 `assets/probes/coordinate-resolver.example.js` 解析坐标契约。
3. 抽 2 到 3 个关键锚点做残差校验：OCR 实测位置与解析结果比较。
4. 残差超过短边的 **1.5%** 时，把该元素从 `ratio` 升级为 `anchor` 并重新验证。

契约示例见 `assets/coordinate-spec.example.json`，规则细节见 `references/cases/multi-resolution-adaptation.md`。

## 失败与恢复分级

按成本从低到高恢复：

1. 单次识别失败：重新截图，等待稳定后重试一次。
2. 节点读取失败：改用 OCR 或图色，不反复请求布局。
3. MCP 截图超时：先不带 `waitStable` 重试，再尝试 `resetScreenCapture`。
4. 脚本任务卡住：用 `device_stop_script` 停止业务脚本引擎。先查 `task_logs` 确认是否只是 `TASK_WAIT_TIMEOUT`，脚本可能已成功执行。
5. 动作成功但状态不变：停止重复点击，判定是否非交互遮挡层或教程引导层；先等待复核，再尝试系统返回，仍无效则重启目标应用。
6. 设备 MCP 不可用：切换到插件兜底直连通道；ADB 只用于救援。
7. 应用卡死：强制结束目标应用，重新启动 V5 和目标任务。
8. 系统半死或设备离线：用模拟器控制台重启实例，重新启动 V5，确认设备列表和执行模式后再继续。

恢复后必须重新记录当前状态，不能假设卡死前的画面仍有效。

应用重启是探索期最有效的状态复位手段，优于和目标弹层反复纠缠。重启后要重新走登录、活动弹窗、教程引导，遇到教程引导时先完成或等待其目标动作，再进入目标模块。

## 设备通道

设备探索统一按 `references/cases/device-operation-channels.md` 的通道分级执行：优先设备 MCP，其次插件兜底调用器，最后 ADB / 模拟器控制台。任何通道都不绕过 V5 授权与风险判定。切换到兜底调用器或 ADB 时，必须把「当前 MCP 未被客户端注册 / 不可用，正在用兜底链路」告知用户，并给出注册位置修复指引（分发包 `README.md` 的「各客户端 MCP 注册位置」）；不要把兜底链路当作默认主链路。

原生设备 MCP 可直接调用的操作类工具（优先用这些，不要先写兜底命令）：

```text
观察：device_screenshot  device_find_node  device_layout_dump  device_logs
操作：device_tap  device_swipe  device_input_text  device_click_node  device_tap_target
脚本：device_run_script_text  device_run_script_file  device_stop_script
任务：task_get  task_wait  task_logs
```

截图核对直接用 `device_screenshot` 的 `includePreview`；需要长按、拖动换位、批量步骤时用 `device_run_script_text` 配合 `__toolboxLongPress` / `__toolboxSwipe` / `__toolboxTap`，并写日志 marker。

## 案例索引

- `references/dupo-cangqiong-case.md`：斗破苍穹总览与状态链。
- `references/cases/dupo-cangqiong-battle-cycle.md`：画布型多状态战斗循环。
- `references/cases/dupo-cangqiong-stage-progression.md`：1-2 起的连续关卡推进、动态挑战按钮、动作有效性验证、`下一关` / `开启自动挑战` 与 `还差N关` 里程碑语义。
- `references/cases/dupo-cangqiong-tutorial-chain.md`：新手教程链、引导层输入过滤、弹层队列与逐层关闭。
- `references/cases/dupo-cangqiong-reward-overlay.md`：结算后多层奖励弹层队列，含"关不掉"假象的成因修正。
- `references/cases/dupo-cangqiong-idle-cultivation.md`：挂机累积与领取一轮，含收益率、守卫付费入口、验证判据、教程气泡吞点击的处置。
- `references/cases/dupo-cangqiong-realm-panel.md`：境界任务面板，任务卡三态与批量领取模板。
- `references/cases/dupo-cangqiong-module-recon.md`：底部六模块入口侦察与遮挡层阻塞，含 `历练`（日常修行四页签）、`纳戒`（血精凝练）、`势力`（申请与免费捐献）的首屏与单动作。
- `references/cases/dupo-cangqiong-hero-upgrade.md`：资源消耗型角色升级。
- `references/cases/android-settings-node-tree.md`：节点型通用应用。
- `references/cases/landscape-test-device-offline.md`：不稳定应用与设备恢复。
- `references/cases/douyin-crash-anti-case.md`：闪退应用反例。
- `references/cases/device-operation-channels.md`：设备 MCP / 兜底 / ADB 分级与截图落盘陷阱。
- `references/cases/evidence-store.md`：探索证据库结构与原始数据留存规范，含真实哈希校验结果。
- `references/cases/multi-resolution-adaptation.md`：多分辨率适配与坐标契约（锚点 / 边缘 / 比例、黑边判定、残差校验、宽高比分桶）。
- `references/runs/dupo-cangqiong-20261001/`：首个完整运行记录，含 `task-spec.json`、`state-model.json`（27 状态 + 证据标签映射）、`project-request.json`、`findings.md` 与 247 条证据索引；原始截图在 `data/exploration/dupo-cangqiong-20261001/`；由它生成的示例项目见 `hz-autojs-automation-builder/references/examples/dupo-cangqiong/`。

## 观察与动作规范

- 优先使用布局节点；节点不可用时用 `device_screenshot` 观察画面。只有已经决定点击、且需要 OCR/图片/色组定位时才使用 `device_tap_target`；它属于操作工具，只读模式会拒绝，不能拿来做只读识别或证据采集。
- 截图统一由宿主 `device_screenshot` 生成；需要宿主可视化时用 `includePreview`，脚本只读设备侧落盘文件。禁止脚本内调用 `images.requestScreenCapture()`，它会抢占截图通道导致黑帧。
- 任何点击前必须说明坐标来源；坐标只能来自 `anchor` / `edge` / `ratio` 三种契约，禁止直接写裸像素。
- 禁止用缩放预览图估算坐标；预览图只用于状态判断，不用于标定。
- 标定新元素时记录基准分辨率；换设备或换分辨率后必须重跑残差校验，不能沿用旧像素。
- 纯图色按钮先用探针求包围盒和中心，再写入脚本；阈值和区域要记录。
- 页面加载或动画期间不要立即识别，先用 `waitStable` 或明确等待。
- 动作结果必须验证；`__toolboxTap` 返回 true 不代表动作生效。
- 长脚本先写设备再运行，触发控制在一行或一个文件入口。
- 每个成功案例都要保留可复跑脚本或明确说明为何不能复跑。

## 完成标准

- 至少一个真实任务从入口走到成功结算，再复跑一次得到一致结果；每个要标 ready 的脚本都有脚本级复跑记录。
- 证据库存在且可校验：`manifest.json` 覆盖每个关键状态，`capture-evidence.mjs --verify` 返回 `bad: 0`；截图原图本地留存，版本库里没有图片二进制。
- 所有硬编码坐标、阈值、等待时间和图像来源都有证据。
- 所有可点元素都写成坐标契约：`ratio` / `edge` 必须带 `fallback`，`anchor` 要么带 `fallback`，要么显式写 `noFallbackReason`；没有任何裸像素坐标进入脚本或项目请求。
- 坐标契约已做残差校验，且明确列出已验证 / 未验证的宽高比分组。
- 候选技能与案例分离，任务事实不混入通用流程。
- 失败恢复路径覆盖已知弹窗、退出确认、教程遮挡和资源不足。
- 产出 `project-request.json` 任务卡：每个脚本带 `readiness`，`ready` 带可编译的 `spec`，`partial` / `blocked` 带 `missingEvidence`；生成器可以在不重新探索的前提下编译就绪任务、并把未就绪能力显式留成占位。
- 无法验证的内容明确标记为缺口，不写成完成；不得用「近似脚本」顶替未验证的 duty。

## 交付前自查

- 标 ready 的脚本都有脚本级复跑记录；没做到的一律降为 partial 并写 `missingEvidence`；
- 每条结论都能指到证据（`manifest.json` / sha256 / 原始截图），没有证据的写明缺哪张、缺哪个状态；
- 坐标全部是契约表达（anchor / edge / ratio），没有任何裸像素坐标对；
- 高风险动作（支付、账号、授权变更）没有未经批准的尝试；
- 每一轮推进后已用 `refresh-agent-brief.mjs` 刷新运行目录的 `AGENTS.md` 与 `agent/manifest.json`。
