# V5 设备执行模式与脚本动作 API

本文件是插件包内关于 **V5 设备直控模式** 与 **模式感知动作 API** 的权威说明。
编写任何会在设备上执行的 AutoJs 脚本（尤其是通过 MCP 下发的脚本）前必须先读本文件。

## 为什么必须先确认执行模式

V5 设备有三个执行模式，取值来自设备运行时配置 `directControlMode`，并在 `/api/device/{deviceId}` 的 `directControlMode` 字段返回：

| 模式 | 含义 | 是否允许无障碍 API |
| --- | --- | --- |
| `AUTO` | 运行时探测，**高级权限优先** | 仅当探测结果落到无障碍通道时允许 |
| `ACCESSIBILITY` | 只用无障碍 | 允许 |
| `PRIVILEGED` | 只用高级权限（root / Shizuku / 直控 Agent） | **禁止**，且不会回退无障碍 |

`PRIVILEGED` 是"设备上不允许出现无障碍痕迹"的场景。选中它以后 V5 **绝不读写、也绝不开启无障碍设置**，两条通道严格二选一、不做自动降级。

## PRIVILEGED 模式下被拦截的全局函数

设备端会把下列全局函数替换为**直接抛错**的桩。它们会隐式启动无障碍服务，因此在高级权限模式下必须拦截：

```text
触控与系统动作：
  click, longClick, press, swipe, gesture,
  home, back, recents, notifications, quickSettings, powerDialog,
  setText, input,
  scrollUp, scrollDown, scrollLeft, scrollRight

无障碍节点选择器：
  text, textContains, textStartsWith, textEndsWith, textMatches,
  desc, descContains, descStartsWith, descEndsWith, descMatches,
  id, idMatches, className, classNameMatches, selector

前台页面查询（同样依赖无障碍服务）：
  currentPackage, currentActivity
```

调用任一被拦截函数会抛出：

```json
{ "code": "ACCESSIBILITY_FORBIDDEN_BY_MODE" }
```

错误消息里会带上可替换的 API 名称。**这不是脚本写错了，而是模式不允许。**

拦截只作用于 **AI 生成的脚本**（依据任务 `sourceScriptName` 是否以 `AI-AUTO/` 开头判定）；手工编写的脚本不在拦截范围，保持既有行为。

## 正确的写法：`__toolbox*` 模式感知 API

以下函数由 V5 注入到脚本引擎，**所有任务脚本都可用**。它们内部按 `directControlMode.resolve()` 解析出的通道执行，与 V5 页面上的结构化操作走同一条链路，因此在 `PRIVILEGED` 与 `ACCESSIBILITY` 下都正确：

| 函数 | 说明 |
| --- | --- |
| `__toolboxTap(x, y)` | 坐标点击 |
| `__toolboxLongPress(x, y, durationMs)` | 长按 |
| `__toolboxSwipe(startX, startY, endX, endY, durationMs)` | 滑动 |
| `__toolboxScroll(x, y, direction, distance)` | 滚动 |
| `__toolboxText(text)` | 输入文本 |
| `__toolboxAction(action)` | 具名动作：`HOME`、`BACK`、`RECENTS` 等 |

### 示例：回到桌面

```javascript
// 正确：模式感知，两种模式下都可用
var result = __toolboxAction('HOME')
log('HOME: ' + JSON.stringify(result))
```

```javascript
// 错误：PRIVILEGED 模式下会抛 ACCESSIBILITY_FORBIDDEN_BY_MODE
home()
```

### 示例：坐标点击

```javascript
__toolboxTap(540, 1200)
```

### 顶层不能写 `return`

脚本正文的顶层 `return` 会让 Rhino 在编译期报 `invalid return`，子引擎还没执行到终态上报就退出；
父引擎看护最终只能给出泛化的 `SCRIPT_ENGINE_EXITED_WITHOUT_RESULT`。需要把结果传回时，用日志
marker 包住 JSON，或写文件，不要把结果写成顶层 `return`。

`device_run_script_text` 现在会在提交前直接返回 `INVALID_SCRIPT_TOP_LEVEL_RETURN`；按错误提示改成
函数内 `return` 或日志 marker 后重试，不要把它当成设备故障去查日志或重启设备。

### 失败时的行为

通道不可用时 `__toolbox*` 会抛出带原因码的错误，例如：

- `SHIZUKU_UNAVAILABLE`
- `ROOT_UNAVAILABLE`
- `AGENT_UNAVAILABLE`
- `NO_CHANNEL_AVAILABLE`

**不要**用 `try/catch` 吞掉这些错误后改用无障碍 API 兜底——那正是模式门禁要阻止的行为。应把原因码如实回报。

## 能力探测不要用 `typeof`

`PRIVILEGED` 下的桩只在全局函数**原本存在**时才替换，因此 `typeof home === 'function'` 依然为真、却会在调用时抛错。**判断能不能用某个动作，要看设备模式，而不是 `typeof`。**

## 建议的脚本骨架

```javascript
// 1. 先读设备模式（MCP 侧用 device_status；脚本内可用 __toolboxRequireMobileModule）
// 2. 按模式选择 API：不要假设无障碍可用
// 3. 动作结果必须检查

var result = __toolboxAction('HOME')
if (!result || result.success !== true) {
  throw new Error('HOME 失败: ' + String((result && result.reasonCode) || ''))
}
```

## 任务状态与执行结果

`RUN_SCRIPT_TEXT` / `RUN_SCRIPT_FILE` 把脚本提交到**独立引擎**执行。父引擎只负责提交，
**不再在提交成功时上报 `SUCCEEDED`**；脚本类任务的终态由子引擎自报（两条路径都由设备端包装
脚本注入心跳与终态上报；文件路径的包装文件与原脚本同目录、引擎 `path` 指向脚本目录，因此
`require('./x.js')` 的解析语义不变），因此：

> **任务 `SUCCEEDED` 即脚本真实执行完成；脚本抛错会得到 `FAILED` 与真实错误信息。**

前提是终态来源正确。`task_get` / `task_wait` 的 `terminalSource` 字段标明终态由谁写入：

| terminalSource | 含义 | 脚本类任务是否代表真实执行结果 |
| --- | --- | --- |
| `CHILD_ENGINE` | 独立子引擎自报 | 是 |
| `PARENT_ENGINE` | 父引擎看护兜底（引擎崩溃/消失/硬超时） | 否，属兜底判定 |
| `WATCHDOG` | 后端看门狗静默/硬上限判定 | 否，属兜底判定 |
| `DEPENDENCY` | 依赖任务未成功导致阻塞失败 | 否 |
| `CANCEL` | 用户主动取消 | 否 |
| `SERVER` | 服务端其它直接判定 | 否 |

因此**不需要**再对每次 `SUCCEEDED` 追加 `task_logs` 复核（那是旧假成功缺陷的补偿动作，纯浪费 token）。
只有以下情况才追加查询：

1. `FAILED` —— 读 `task_logs` 定位具体报错位置；
2. 需要确认页面产生了预期变化 —— 用 `device_screenshot` 等观察类工具验证结果，而非复核任务状态。

脚本自身也应把关键结果写进日志（`log(...)` 会被采集），并对失败显式抛错。

## 脚本参数、固化运行与画面稳定

- **参数化触发**：`device_run_script_text` 支持 `scriptParams`（JSON 对象），脚本内通过全局 `__toolboxParams` 读取；参数由服务端注入脚本正文头部，不需要也不允许用字符串替换改脚本。文件/项目通道暂不支持参数。
- **固化脚本**：长脚本先 `device_file_write_text` 写到设备，再 `device_run_script_file` 运行。文件通道与文本通道共用同一包装（心跳、终态上报、错误文本），正常结束同样是 `SUCCEEDED` + `CHILD_ENGINE`，相对 `require` 按脚本所在目录解析。
- **稳定帧**：`device_screenshot` 传 `waitStable:true`（`waitStableTimeoutMs` 默认 6000、`waitStableIntervalMs` 默认 700、`stableThreshold` 默认 8）时，设备端连续采样比对，稳定或超时后返回最后一帧，结果 payload 带 `stableWait` 报告。
- **黑帧自检**：截图疑似纯黑时 payload 返回 `suspectedBlackFrame=true`、`reasonCode=SCREEN_CAPTURE_BLACK_FRAME_SUSPECTED` 和 `hint`；根因通常是脚本内 `images.requestScreenCapture()` 抢占 MediaProjection，恢复用 `resetScreenCapture:true`。
- **统一纯图色**：`device_tap_target` 通过 `TAP_TEXT` 识别并点击文字，或用 `TAP_IMAGE` / `TAP_COLOR_GROUP` 点击本机已验证素材；`region` 应尽量缩小到目标区域。该工具会执行点击，只读模式会直接拒绝，不能用作只读 OCR 或探针。
- **任务查询**：`task_wait` / `task_logs` 允许携带 `deviceId`（仅用于上下文，不参与查询）；`task_logs` 的 `tailLines` 可直接裁剪尾部。

## 脚本终态、心跳与父引擎看护

V5 的脚本类任务（`RUN_SCRIPT_TEXT` / `RUN_SCRIPT_FILE` / `RUN_PROJECT` / `SCRIPT_CONTENT` / `SCRIPT_PATH`）
由**子引擎自报终态**，同时有两条兜底链路。理解它们可以避免误判"任务卡死"：

### 父引擎看护（秒级）

父引擎提交脚本后启动看护，按引擎 ID / source 匹配目标子引擎：

- **子引擎消失且服务端无终态** → 约 6 秒内由父引擎判 `FAILED`，原因码 `SCRIPT_ENGINE_EXITED_WITHOUT_RESULT`。
  覆盖：原生调用崩溃、`engines.stopAll()` 自杀、被 `forceStop`、宿主回收。
- **子引擎仍在运行** → 每分钟记一次进度告警；硬超时 15 分钟兜底判 `FAILED`
  （原因码 `SCRIPT_PARENT_GUARD_TIMEOUT`），仅在后端看门狗失效时触发。
- 父引擎判定前**一定先查服务端终态**：子引擎正常上报的结果永远不会被覆盖。

### 脚本心跳（15 秒）

包装脚本在**独立线程**（`threads.start`）上每 15 秒上报一次 `/progress`，用于刷新任务的
`updatedAt`。

注意 AutoJs 的 `setInterval` 与脚本主线程共用 Looper，`sleep()` 或阻塞式原生调用会把它一起冻住
（实测 `sleep(3000)` 期间定时器 0 次触发），因此心跳必须跑独立线程。

心跳只能证明**进程还活着**，不能证明脚本有进展。卡在不可中断的原生调用里时心跳仍会继续，
所以"活着但永不结束"必须靠**总时长硬上限**拦截，而不是靠静默检测。

`RUN_SCRIPT_FILE` / `RUN_PROJECT` 与文本路径共用同一个包装函数：设备端读回脚本正文后调用
`wrapScriptContent`（心跳、终态上报、错误文本格式化都在这里定义），再以
`engines.execScript(sourceName, wrapped, { path: scriptDir })` 提交。`path` 必须保留，否则脚本里的
`require('./lib/x.js')` 会按引擎默认目录解析并报模块不存在。因此文件路径不该再出现
`SCRIPT_ENGINE_EXITED_WITHOUT_RESULT`：该原因码此后只代表子引擎真的异常消失，而不代表文件路径缺少上报。

### 后端任务看门狗（分级）

`ScriptTaskWatchdogJob` 按任务类型分级。**静默阈值**（无终态且无进度）与**总时长硬上限**
（有进度也不放行）成对使用：

| 分级 | 覆盖任务 | 静默阈值 | 总时长硬上限 |
| --- | --- | --- | --- |
| 即时型 | `TOOL_LAYOUT_DUMP` `FILE_LIST` `FILE_OPERATION` `DEVICE_CONFIG_SYNC` `STOP_SCRIPT_ENGINES` 日志类 `APP_DIAGNOSTICS` `RUN_SHELL` | 90 秒 | 3 分钟 |
| 图色型 | `TOOL_SCREENSHOT_CAPTURE` `TOOL_IMAGE_PROCESS` `TOOL_IMAGE_MATCH` `TOOL_IMAGE_OCR` `TOOL_VISION_TAP_TARGET` `STREAM_REFRESH_CAPTURE` | 150 秒 | 5 分钟 |
| 脚本型 | `RUN_SCRIPT_TEXT` `RUN_SCRIPT_FILE` `SCRIPT_CONTENT` `SCRIPT_PATH` | 180 秒 | 6 分钟 |
| 项目型 | `RUN_PROJECT` | 10 分钟 | 20 分钟 |
| 传输型 | `FILE_PUSH` `FILE_PULL` `APP_PACKAGE_INSTALL` `DEVICE_APK_INSTALL` `APK_METADATA_READ` | 15 分钟 | 45 分钟 |
| 未分类 | 其它任务模式 | 180 秒 | 6 分钟 |

收敛前先查设备在线状态：设备已离线直接判 `FAILED`（原因码 `TASK_DEVICE_OFFLINE`），不等满阈值。
原因码形如 `TASK_WATCHDOG_TIMEOUT_*`（静默）与 `TASK_WATCHDOG_CEILING_*`（总时长）。

### 对调用方的含义

- 脚本正常结束或抛异常时**不需要**额外轮询复核；
- 子引擎异常消失会在约 6 秒内得到明确 `FAILED` 与原因码，不必等 10 分钟；
- 卡在不可中断原生调用的任务最迟在对应分级的硬上限内收敛；
- 图色类任务不再无限悬挂。
