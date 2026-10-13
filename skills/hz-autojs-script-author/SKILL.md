---
name: hz-autojs-script-author
description: 为华仔 AutoJs 工具箱 V5 生成、提交、调试或解释 AutoJs 脚本。用于 AI 需要编写 mobile 端 AutoJs 代码、远程脚本模板、图色脚本、节点脚本、文件脚本，或通过 V5 MCP 任务链路运行和排查脚本时。
---

# hz-autojs-script-author

为华仔 AutoJs 工具箱 V5 生成、提交、调试或解释 AutoJs 脚本时使用本技能。

## 必要上下文

- V5 mobile 脚本通过 V5 Java 后端任务系统下发，并在 V5 APP 的 AutoJs 运行时执行。
- V5 默认在**第一代 Rhino API**（v8）执行，也支持**第二代 Node.js API**（v9）：文件名以 `.node.js` 结尾，或脚本首行是 `"nodejs";` / `"ui nodejs";` 时，V5 会交给内置 Node 16 引擎执行。两代 API 不能混写。

## API 事实来源（强制）

**写任何 AutoJs API 之前，先用 `autojs_docs_search` 确认它存在。**这是硬性前置步骤，不是建议。

1. 按需求拆出要用到的 API，逐个查询：`autojs_docs_search({ query: "images.findMultiColors" })`。
2. 需要参数、返回值或示例时，用 `autojs_docs_read({ symbol: "images.findMultiColors" })` 读原文。
3. 不确定某模块有哪些能力时，用 `autojs_docs_search({ module: "images" })` 列出全部符号。

三条硬约束：

- **查询返回 0 条即代表该 API 不存在**，必须改用检索到的近义符号或换思路，**不得**凭记忆写出文档中没有的函数名。
- **不要用 `grep` / `Read` 直接读 `mcp/docs/autojs/`**：那是 VuePress 构建产物，正文在文件数十 KB 之后，文件级读取取不到 API 说明。查文档只走这两个工具。
- 返回结果带 `generationWarning` 时，该符号属于 v9；只有 Node 入口（`.node.js` / `"nodejs";` / `"ui nodejs";`）能用，Rhino 脚本不能用。

成本控制：一次任务通常 1 次 `search` + ≤2 次 `read` 即可；命中 0 条时可换更短的模块名再查一次，不要逐页遍历。

## 执行模式（强制）

编写任何在设备上执行的脚本前，必须先确认设备执行模式，再决定用哪套 API。模式由 `/api/device/{deviceId}` 的 `directControlMode` 返回，MCP 侧用 `device_status` 读取。

- `PRIVILEGED`（高级权限）模式下，无障碍 API（`click`/`swipe`/`home`/`back`/`setText`/`text()`/`desc()`/`id()`/`currentPackage()` 等）
  会被设备端替换为**直接抛错**的桩，调用即得到 `ACCESSIBILITY_FORBIDDEN_BY_MODE`。完整禁用清单见
  [V5 设备执行模式与脚本动作 API](../../mcp/docs/v5-execution-modes.md)。
- 该模式下改用**模式感知动作 API**：`__toolboxTap(x, y)`、`__toolboxLongPress(x, y, durationMs)`、
  `__toolboxSwipe(startX, startY, endX, endY, durationMs)`、`__toolboxScroll(x, y, direction, distance)`、
  `__toolboxText(text)`、`__toolboxAction(action)`（`HOME` / `BACK` / `RECENTS`）。两种模式下都正确，与 V5 页面结构化操作同链路。
- **不要**用 `try/catch` 捕获 `ACCESSIBILITY_FORBIDDEN_BY_MODE` 后改用无障碍 API 兜底；这正是不允许的行为。应把原因码如实回报。
- **不要**用 `typeof home === 'function'` 之类的探测判断可用性：桩只在函数原本存在时替换，`typeof` 为真但调用会抛错。判断依据是设备模式。
- `PRIVILEGED` 下 `AUTO` 探测不会开启无障碍，且两条通道严格二选一、不自动降级；通道不可用时会给出 `SHIZUKU_UNAVAILABLE`、`ROOT_UNAVAILABLE`、`AGENT_UNAVAILABLE` 或 `NO_CHANNEL_AVAILABLE`。

## 脚本流程

1. 先生成能证明目标行为的最小脚本。
2. 使用 `device_run_script_text` 或 `device_run_script_file` 提交脚本。
3. 结果会影响后续判断时，使用 `task_wait` 等待任务完成。
4. 查看 `task_logs` 和 `device_logs` 时优先使用 `tailLines`、`maxChars` 或 `markerStart/markerEnd`。
5. 只有在确认真实返回 payload 或日志后，才修改脚本。
6. 脚本类任务由子引擎自报终态：正常结束报 `SUCCEEDED`，抛异常报 `FAILED` 并带真实错误信息。
   `FAILED` 时读 `task_logs` 定位原因；`SUCCEEDED` 时**不需要**再额外查日志复核（那是旧缺陷的补偿动作，只会浪费 token）。

## AutoJs 模式

- 节点类 UI 自动化前先使用 `auto.waitFor()`。
- 能使用布局或节点选择器时，不优先使用裸坐标。
- 只有在截图权限可预期且可恢复时，才使用 `requestScreenCapture()` 和 `captureScreen()`。
- 图色脚本先小区域验证再全屏查找：多点找色用目标上**稀有色**作起始色（避免浅白/浅灰/纯黑等大面积常见色），阈值默认 4、上限 8；全屏匹配前先用局部 `region` 证明能命中，避免整屏穷举拖垮运行时。图色 API 报 `UnsatisfiedLinkError` / `IMAGE_MODULE_UNAVAILABLE` 时说明该包未内置 OpenCV，不要反复重试同一写法。
- 长脚本必须可中断，并记录有意义的检查点日志。
- 脚本需要停其他脚本时，**禁止**使用 `engines.stopAll()` / `engines.stopAllAndToast()`：它们会把当前脚本所在引擎一并停止，导致脚本无法上报终态、任务悬挂在 RUNNING、设备控制通道断开。应改用 `device_stop_script` 工具；需要在脚本内停止时，遍历 `engines.all()` 逐引擎判断后 `forceStop()`，并显式保留当前引擎（`engine.id === engines.myEngine().id`）。
- 脚本需要返回大量结构化结果时，用明确 marker 包住最终 JSON，例如 `RESULT_JSON_BEGIN...RESULT_JSON_END`，随后用 `task_logs` 的 `markerStart/markerEnd` 只提取这段内容。
- 不要在脚本文本中直接内嵌大体积二进制数据或截图。
- Rhino（v8）脚本顶层 `return` 是**语法错误**（`return` 只能出现在函数体内），会在编译期报 `invalid return`；Node 入口按 CommonJS 执行，顶层 `return` 合法。整个脚本无法执行，连 `return` 之前的语句也不会运行，子引擎无法上报终态，父引擎只能兜底判 `FAILED`。`device_run_script_text` 现在会在提交前直接返回 `INVALID_SCRIPT_TOP_LEVEL_RETURN`，不要把它当成设备故障重试。需要把结果传出时，用日志 marker（见上一条）或写文件，不要用顶层 `return`。

- **UI 线程（仅当脚本带 `"ui";` 界面）**：主线程即 UI 线程，回调里做 `sleep` 或长任务会卡死界面；长任务放 `threads.start`（索引确认存在），子线程更新界面必须切回 UI 线程执行。
- **兼容性（Rhino）**：避免 `?.`、`??`、`Array.prototype.flat` 等较新语法；时间戳用 `new Date().getTime()`，不要依赖 `Date.now()`（部分旧版缺失）。这两条为实践建议，未逐条实测。

## Node 引擎（V5 已支持第二代 API）

V5 已支持内置 Node 16.14.0：文件名以 `.node.js` 结尾，或脚本首行是 `"nodejs";` 时，任务系统按独立文件模式启动 Node 引擎，并在 Node 进程内自报心跳与终态。`.mjs` 不是 V5 任务通道的识别后缀；需要 Node 时统一用 `.node.js` 或 `"nodejs";` 头。已在真机 `emulator-5554` 验证 Node `v16.14.0` 文件入口可执行并返回 `CHILD_ENGINE`。

- 启用方式：脚本头 `"nodejs";` 或文件名后缀 `.node.js`；**混用两代 API 会直接出错**（Node 下没有 Rhino 的全局注入、`importClass`、`JavaAdapter`）。
- 入口结构：推荐 `async function main() {}` + `main().catch(...)`；顶层 `await` 不可以，CommonJS 顶层 `return` 合法。IO / 交互 / 等待类调用返回 Promise，必须 `await`，漏 `await` 不报错但行为错误。
- 模块全部用 `require()` 导入；V5 文本通道会自动为 NODE 模板补 `"nodejs";` 头，再写成 `.node.js` 入口；首行已是 `"ui nodejs";` 时保持原样，首行是 `"ui";` 时改写为 `"ui nodejs";`。
- **Node + UI 界面必须用 `"ui nodejs";` 作首行**：手机端只把 `"nodejs";` 与 `"ui nodejs";` 当作 Node 入口，并且只按引擎入口文件头部识别 UI 指令。首行只有 `"nodejs";` 时 `ui.setMainActivity` 会静默失效——界面不弹但任务仍报 `SUCCEEDED`（真机验证）。`"nodejs ui";` 等其它组合写法手机端暂未识别，提交层会把含 ui 的组合规范化为 `"ui nodejs";`。
- 需要 UI 线程时使用 `"ui-thread";`（Rhino 入口）；Node 入口下与 nodejs 组合的 UI 线程写法暂不在手机端识别范围内，需真机验证后再用。界面同一时刻只能被一个引擎占用；回调里不跑长阻塞任务。
- 事实来源：v9 符号在离线索引中带 `v9` 标记；写 Node 脚本必须按 v9 核对，不得沿用 v8 写法。
- **版本对齐**：设备端引擎固定为 Node v16.14.0；设备外安装依赖用 Node 16.x（最好 16.14.0），脚本不得使用 18/20+ 专属 API；原生模块（`.node`）需按 Android + Node 16 ABI 编译，一般不可用，依赖优先选纯 JS 包。
- 排查：Node 入口失败时先看 `task_logs` 里的 `NODE_RUNTIME` / `terminalSource` 信息；`SUCCEEDED` + `CHILD_ENGINE` 才代表脚本真实执行完成。不要用 Rhino 的顶层 `return` 规则去判断 Node 入口。

## 参数与画面

- **参数化**：脚本需要外部参数时，用 `device_run_script_text` 的 `scriptParams`，脚本内读全局 `__toolboxParams`；不要把参数拼进正文或做字符串替换注入（替换目标不匹配时会静默失败）。
- **不要自截图**：AI 脚本内禁止调用 `images.requestScreenCapture()`，它会抢占工具箱的 MediaProjection 通道，使 `device_screenshot` 变纯黑。需要画面时让宿主截图并传 `outputPath`，脚本用 `images.read(路径)` 读取。
- **等待画面稳定**：页面加载/动画期间不要直接识别，先让 `device_screenshot` 带 `waitStable:true`，再在稳定帧上做图色/OCR。
- **长脚本固化**：长脚本先写到设备，再用 `device_run_script_file` 运行；终态由子引擎自报，正常结束是 `SUCCEEDED` + `CHILD_ENGINE`。

## 任务汇报

脚本任务向用户汇报时按四段给，结论必须可回溯：

1. **结果**：脚本名 / 任务 ID / 终态（`SUCCEEDED` + `CHILD_ENGINE` 才算真实成功；`FAILED` 附真实错误信息）。
2. **证据**：marker 内容或关键日志摘录；涉及页面变化时给出截图/锚点结论。
3. **限制与风险**：坐标/权限/通道依赖、未验证项、被门禁拒绝的动作。
4. **下一步**：需要用户输入或决策的事项。

没有证据不得写「已完成」；部分成功要分别写明成功和失败的部分。

## 安全边界

- ADB 只作为开发、安装或救援辅助工具，不作为正式 AI 自动化链路。
- shell 执行、权限变更、安装卸载、文件删除、短信、支付、账号变更等高风险脚本行为，都必须视为危险动作。危险动作总开关关闭时一律拒绝；开启后由客户端审批模式决定是否弹本地确认卡。开关含义与开启方式见分发包根目录 `README.md` 的「配置参数」一节（源码仓库内为 `docs/runbooks/mcp-configuration.md`）；用户级配置文件用 `node <插件根>/mcp/tools/mcp-config.mjs init|sync|show` 管理，不要改插件目录里的 `.mcp.json`。
- 不得绕过 V5 后端授权、设备访问密码检查、商业能力门禁或任务审计。

## 交付前自查

生成或修改脚本后逐条核对；完整清单见 `references/rhino-pitfalls.md`。

- 设备模式已确认（`device_status` 的 `directControlMode`）；`PRIVILEGED` 下没有写任何无障碍 API；
- 每个用到的 AutoJs API 都过了 `autojs_docs_search`（0 条即不存在，换写法）；
- Rhino 脚本无顶层 `return`（Node 入口不受此限制）；结果通过日志 marker 或文件传出；
- 参数走 `scriptParams` / `__toolboxParams`，没有字符串拼接注入；
- 没有调用 `images.requestScreenCapture()`、`engines.stopAll()` / `engines.stopAllAndToast()`；
- 长脚本已先落设备再用 `device_run_script_file` 运行；
- 汇报或结论都能指到真实终态 / 日志证据；`FAILED` 带真实错误信息。

## 工具未注册时的兜底通道

当会话工具列表里**没有** `mcp__hz-autojs-device-mcp` / `mcp__hz-autojs-project-mcp` 时，
不要改走 HTTP 直连 V5，也不要自己拼 REST 请求。改用插件自带的 stdio 直连器：

```
node <插件根>/mcp/tools/mcp-call.mjs device  <tool> '<jsonArgs>'
node <插件根>/mcp/tools/mcp-call.mjs project <tool> '<jsonArgs>'
```

该通道与 MCP 工具等价，不绕过任何门禁。**用法细节、确认地址语义、输出精简与常见错误见
[兜底通道文档](../../mcp/docs/fallback-channel.md)**。

两条必须记住的：

- JSON 必须用单引号整体包裹、内部用双引号；转义错误是该通道最常见的失败原因。
- `DEVICE_ACCESS_REQUIRED` 时把 `authorizationUrl` 交给用户（`/#/devices` 才有密码输入框），
  `confirmUrl` 不能代替它；转达地址必须用 Markdown 链接或裸 URL，不要包在代码块里。
