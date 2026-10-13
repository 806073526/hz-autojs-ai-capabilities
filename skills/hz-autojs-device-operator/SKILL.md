---
name: hz-autojs-device-operator
description: 通过华仔 AutoJs 工具箱 V5 MCP 工具操作 Android 设备。用于 AI 需要列出设备、截图观察、读取布局节点、做页面结构分析、查找节点、点击、滑动、输入、OCR、图像匹配，或验证远程设备操作结果时。
---

# hz-autojs-device-operator

通过华仔 AutoJs 工具箱 V5 MCP 工具操作 Android 设备时使用本技能。

## 操作顺序

1. 先调用 `device_list`，明确选择要操作的 `deviceId`。
2. 调用 `device_screenshot` 观察当前屏幕。
3. 页面可能存在无障碍节点时，先按下面「节点采集口径」判断意图：**操作类查找**用 `device_find_node`（默认只给可用节点、不限数量）；**结构分析**用 `device_layout_dump`（默认全部窗口 + 全量节点 + 不过滤）。
4. 优先使用节点操作；在裸坐标前先尝试 `device_find_node` 或 `device_click_node`。
5. 验证新增、编辑、删除、保存等维护入口时，若文本节点没找到入口，二次读布局并开 `includeActionCandidates=true`（或 `candidateOnly=true`），检查图标型候选。
6. 节点明显过少、为空或与截图不一致时，先核对采集口径是否被过滤或截断：结构分析口径应为 `layoutRange: "all"`、`limit: 0`、`visibleOnly: false`、`dedupe: false`，并检查返回里的 `layoutSummary.truncated`。
7. 当全部窗口布局仍不完整或不可用时，再使用 `device_ocr` 或 `device_image_match`。
8. 只有在目标状态明确后，才使用 `device_tap`、`device_swipe` 或 `device_input_text`。
9. 每次操作后都再次调用 `device_screenshot`，确认页面结果。
10. 用户只要求「写脚本并运行 / 远程执行脚本」时，直接用 `device_run_script_text` 提交或在单控页用 `page.remoteScript.runCurrent` 执行；**不要先调 `page.remoteScript.readEditor` / `page.fileEditor.readEditor`**——读编辑器只在需要改现有内容或用户明确指向编辑器内容时才用。
11. 下发任何脚本前，先确认设备执行模式（`device_status` 读 `directControlMode`）。`PRIVILEGED`（高级权限）模式下 `home`/`back`/`click`/`swipe`/`setText`/`text()`/`desc()`/`id()`/`currentPackage()` 等无障碍 API 会被设备端替换为抛错桩（`ACCESSIBILITY_FORBIDDEN_BY_MODE`），必须改用 `__toolboxTap` / `__toolboxSwipe` / `__toolboxText` / `__toolboxAction` 等模式感知 API。清单与示例见 [V5 设备执行模式与脚本动作 API](../../mcp/docs/v5-execution-modes.md)。

## 节点采集口径（操作 vs 分析）

先判断用户意图再选工具和参数，不要用同一种口径套所有场景：

| 意图 | 工具 | 默认口径 |
| --- | --- | --- |
| 找可点的东西、执行操作 | `device_find_node` / `device_click_node` | 只给可用节点（`usableOnly: true`：enabled 且可点击/长按/滚动/勾选/可输入，或带 `text`/`desc` 的可读锚点）、只读当前活跃窗口、**不限数量**（`limit: 0` 返回全部匹配节点，不截断） |
| 页面结构分析、布局核对、WebView 内容梳理、节点是否缺失的排查 | `device_layout_dump` | 全部窗口（`layoutRange: "all"`）、全量节点（`limit: 0` 不限数量）、不过滤（`visibleOnly: false`、`usableOnly: false`、`dedupe: false`） |

- 节点数量默认不设上限：`limit: 0`（或不传）表示返回全部节点。只有明确要抽样时才传正数；传了正数就会按遍历顺序截断，节点树会缺整条分支。
- `visibleOnly` 过滤的是**边界退化**节点（零面积 / 屏外 / 负数 bounds）。WebView 会把整个 DOM 都报出来，视口外节点大多边界退化，开启它会让网页节点少掉大半。做结构分析时必须保持 `false`；只看当前屏幕、不关心页面其余内容时才用 `true`。
- `usableOnly` 按 `enabled` + 可操作性（点击 / 长按 / 滚动 / 勾选 / 可输入）过滤，带 `text`/`desc` 的可读锚点也会保留（否则按文字找入口会全空）；分析场景保持 `false`。
- 设备处于高级权限（uiautomator dump）通道时 `layoutRange` 不生效（只有一份单窗口 dump），`active` 与 `all` 结果相同；此时不要把窗口范围当成节点缺失的原因。
- `layoutSummary.truncated=true` 表示撞到了数量上限、`totalNodeCount` 不是真实总数；看到它就把 `limit` 改成 0 重读，不要凭截断结果下结论。

## 动作优先级

- 优先使用稳定布局字段，例如 `id`、精确 `text`、`desc`/`contentDescription`、`className`。
- 其次使用 `textContains`、OCR、页面匹配、图像匹配、颜色锚点。
- 最后才使用最近一次截图或布局边界推导出的裸坐标。
- 提取菜单或入口列表时，不要只看 `text`；很多 App 会把可见标题放在 `desc`/`contentDescription` 中。
- 判断维护入口时，不要只看文字型按钮；图标型编辑/删除/更多操作应优先看 `actionCandidates` 中的 `nearbyText`、`parentText`、`zone`、`reason` 和 `center`，必要时再截图确认。

## 图色与截图任务

- 页面刚加载/切换时截图会拿到**过渡帧**。`device_screenshot` 支持 `waitStable=true`：设备端按 `waitStableIntervalMs`（默认 700ms）连续比对采样像素，稳定或 `waitStableTimeoutMs`（默认 6000ms）超时后返回最后一帧；结果 payload 的 `stableWait` 给出 `stable` / `attempts` / `diff` / `timedOut`。用它替代硬编码 `sleep` 猜加载时间。
- 读取 canvas 绘制的 HUD（倒计时、分数）用 `device_ocr`；支持 `x1/y1/x2/y2` 只识别目标区域，以及 `detectRotation`。区域越小越稳也越快。
- **按用途选截图格式**：当前操作要用颜色（取色、图色匹配、颜色阈值、写进脚本的颜色参数）→ `previewFormat: "png"`，无损、颜色准确；只是为了识别页面上有什么内容、记录步骤或留痕复查 → `previewFormat: "jpg"`（可用 `previewQuality` 调小），体积小得多。图片一旦进入会话，之后每一轮请求都会带着它重发，所以别把"只看一眼"的图存成 PNG。
- 截图 payload 出现 `suspectedBlackFrame=true` / `reasonCode=SCREEN_CAPTURE_BLACK_FRAME_SUSPECTED` 时，说明截图通道被脚本内 `images.requestScreenCapture()` 抢占（症状是约 12KB 的纯黑帧，屏幕上看不出异常）。改用 `device_screenshot` 的 `outputPath` 落盘、脚本用 `images.read()` 读取；必要时用 `resetScreenCapture:true` 恢复通道。
- 长脚本先 `device_file_write_text` 固化到设备，再用 `device_run_script_file` 直接运行，不要再写“一行 eval”。需要变参时用 `device_run_script_text` 的 `scriptParams`（脚本内读 `__toolboxParams`），不要用字符串替换注入。
- `task_wait` / `task_logs` 都接受 `deviceId`（仅作上下文，不参与查询）；`task_logs` 的 `tailLines` 可直接裁剪尾部。

## 失败恢复

- 脚本类任务（`RUN_SCRIPT_TEXT` / `RUN_SCRIPT_FILE` / `RUN_PROJECT`）现在由子引擎自报终态：脚本正常结束才 `SUCCEEDED`，抛异常则是 `FAILED` 并带上真实错误信息。因此**不要**再习惯性地用 `task_wait`+`task_logs`+`device_screenshot` 三连去复核每一次脚本调用（那是旧缺陷的补偿动作，现在只是浪费 token）；只有 `FAILED`、或需要确认页面产生了预期变化时，才追加一次验证。
- `device_run_script_text` 的脚本正文禁止顶层 `return`。Rhino 会在编译期报 `invalid return`，子引擎来不及上报终态，父引擎只能给出泛化的 `SCRIPT_ENGINE_EXITED_WITHOUT_RESULT`。MCP 已前置拦截并返回 `INVALID_SCRIPT_TOP_LEVEL_RETURN`；按提示改成函数内 `return` 或 log marker 后重试，不要把它当成设备故障去查日志或重启设备。
- 收到 `DANGEROUS_ACTION_DISABLED` 表示危险动作总开关关闭；收到 `DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE` 表示客户端无法展示本地危险动作确认卡。两者都不要绕到别的工具或界面去执行；按错误信息向用户说明状态后停止或等待授权。
- **等待任务结束只用一次 `task_wait`**（默认即等待进入终态，可传 `timeoutMs`）。不要用 `task_get` 轮询：每次轮询都是一整轮模型调用，实测一个任务能被轮询十几轮。
- 任务进入终态后**不要**默认再查日志：`SUCCEEDED` 的结果已在 `resultMessage`；仅在 `FAILED` 需要定位报错位置时查一次 `task_logs`。
- 脚本提交后若 `waitForResult` 已经返回终态，就直接采信，不要为了「确认」再跑一次 `task_get`。
- 收到 `ACCESSIBILITY_FORBIDDEN_BY_MODE` 时不要用 `try/catch` 改成无障碍 API 兜底，也不要重试同一写法；按设备模式改用 `__toolbox*` API，或如实回报通道不可用的原因码。
- 找不到节点时，先按结构分析口径重读布局（`layoutRange: "all"`、`limit: 0`、`visibleOnly: false`、`usableOnly: false`），确认不是被过滤或截断，再尝试 OCR、图像匹配或坐标兜底方案。
- 任务超时时，查询 `task_get`、`task_logs` 和 `device_logs`；日志查询优先使用 `tailLines`、`maxChars` 或 `markerStart/markerEnd`，避免把完整日志一次性拉回上下文。
- 收到 `DEVICE_ACCESS_REQUIRED` / `PENDING_CONFIRMATION_REQUIRES_V5` 时，动作都没有执行，不要重复调用：
  前者的 `authorizationUrl` 指向 `/#/devices`（设备访问密码），后者的 `confirmUrl` 才是执行确认入口，两者不能互替。
  转达时必须用 Markdown 链接或裸 URL，不要包进代码块（代码块里的 URL 不可点击）。
  完整语义（含 `USER_DECLINED` / `USER_CANCELLED` 差异、客户端权限档位行为）见
  [确认与设备访问](../../mcp/docs/confirmation-and-access.md)。
- 设备离线时，不要把 ADB 当作正式控制链路；ADB 只作为 MCP 运行时之外的开发或救援工具。
- 动作存在风险时，只有 MCP 工具和运行环境明确启用危险动作门禁后才继续。只读、危险动作、设备锁等环境开关的含义与开启方式见分发包根目录 `README.md` 的「配置参数」一节（源码仓库内为 `docs/runbooks/mcp-configuration.md`）；用户级配置文件用 `node <插件根>/mcp/tools/mcp-config.mjs init|sync|show` 管理，不要改插件目录里的 `.mcp.json`。

## 安全边界

- 始终显式传入 `deviceId`。
- 不要假设存在全局当前设备。
- 未经用户明确限定任务范围，且未启用 MCP 危险动作门禁时，不执行支付、消息发送、删除、安装、卸载、权限变更或账号相关动作。危险动作放行由总开关和客户端审批模式共同决定：完全访问自动放行，需要审批时弹本地确认卡，无法确认时拒绝。
- 截图取图直接传 `includePreview: true`：MCP 会把预览还原成真实图片内容块，模型可以直接看图；base64 不会作为文本进入上下文，因此**不需要**为了省 token 而关掉预览。预览格式按上面「按用途选截图格式」的取色/识别规则选。
- 只取任务元数据（路径/尺寸/状态）时再保持默认 `includePreview: false`，避免无谓地传输图片。
- 不要为了省体积去砍节点：`device_layout_dump` 的结构分析口径默认就是完整节点树（全部窗口 + 全量 + 不过滤），改小 `limit` 或打开 `visibleOnly` 会造成节点缺失、结论失真。要省体积用 `outputFormat: "compact"` 或 `fields` 收窄字段，不要丢节点。完整 `resultPayload` 或完整日志只在排查 MCP/V5 原始返回时才显式索取。
- 响应整形参数统一放在 `responseOptions` 对象里（字段与默认值见 `mcp/docs/response-options.md`）。默认值已按省 token 设定，**通常无需传**；需要时例如 `responseOptions: { outputFormat: "compact", includePayload: false }`。
- `device_file_list` 默认只回 40 项并带 `totalCount`/`truncated`/`nextOffset`。**不要**为了"看全"而反复翻页：先用 `directoriesOnly=true` 或 `nameContains` 收窄，再按需取一页。

## 交付前自查

- 每个「已执行」的动作都有动作后的证据（截图 / 布局 / OCR 锚点）；不把 `success=true` 当动作生效；
- 截图按用途选格式，取图时直接 `includePreview: true` 看图；只在确实只需要元数据时关预览；
- 布局读取口径正确：结构分析用全量节点（不改 `limit` / 可见性过滤），操作清单用可用节点；
- 坐标类操作说明了来源（锚点 / 边缘 / 比例契约），没有裸像素；
- 危险动作遵守总开关与审批；被拒绝或待确认的调用没有换工具重试；
- 结论区分「已观察 / 已执行 / 已生效」，未验证项明确写出。

## 工具未注册时的兜底通道

当会话工具列表里**没有** `mcp__hz-autojs-device-mcp` / `mcp__hz-autojs-project-mcp` 时，
不要改走 HTTP 直连 V5 `/api/ai/tools/execute`，也不要自己拼 REST 请求。改用插件自带的 stdio 直连器：

```
node <插件根>/mcp/tools/mcp-call.mjs device  <tool> '<jsonArgs>'
node <插件根>/mcp/tools/mcp-call.mjs project <tool> '<jsonArgs>'
```

该通道与 MCP 工具等价，不绕过任何门禁。**用法、确认地址语义、输出精简与常见错误见
[兜底通道文档](../../mcp/docs/fallback-channel.md)**。
