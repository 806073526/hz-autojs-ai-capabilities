# 设备操作通道案例（MCP / 兜底 / 截图落盘）

- 类型：探索基础设施，非业务应用
- 设备：`device_android_e3bf91f528e0bbfe`，V5 5.2.5
- 关联技能：`hz-autojs-device-operator`

## 目的

记录在 Codex 侧做探索时，设备能力的正确调用顺序和常见陷阱。这决定探索效率，属于所有案例的公共前提。

## 通道分级

| 级别 | 通道 | 使用时机 |
| --- | --- | --- |
| 主链路 | `mcp__hz_autojs_device_mcp__*` | 已注册工具时的默认选择 |
| 兜底 | 插件 `mcp/tools/mcp-call.mjs <service> <tool> <json>` | MCP 命名空间未注册、工具缺失或主链路失效 |
| 救援 | ADB / 模拟器控制台 | 工具箱断开、设备离线、进程僵尸 |

兜底通道仍是同一套 MCP 与同一套 V5 授权，不绕过任何风险判定，只是替换「客户端到 MCP」这一段传输。

### 操作类原生工具需要按需加载

会话里最初可能只注册了部分观察类工具（`device_find_text`、`device_ocr`、`device_logs`、`task_logs`、`page_match`）。操作类工具（`device_tap`、`device_swipe`、`device_screenshot`、`device_run_script_text`、`device_find_node`）需要先用工具检索按名称加载，之后即可原生调用。

**不要因为第一眼没看到操作类工具就切到兜底通道。** 先检索一次；确认确实缺失或调用失败，再使用 `mcp-call.mjs`。

## 设备侧可用工具

设备 MCP（`device` 服务）实测包含：

```text
autojs_docs_search  autojs_docs_read
device_list  device_status  device_screenshot  device_layout_dump
device_tap  device_swipe  device_input_text  device_logs
device_run_script_text  device_run_script_file  device_stop_script
task_get  task_wait  task_logs
device_find_node  device_click_node  device_find_text  device_image_match
device_color_pick  device_ocr  page_match
```

## 截图落盘陷阱

- 直接 `device_screenshot` 时，报告里的 `path` 是**设备侧路径**，例如
  `/data/user/0/com.zjh.toolbox.v5/cache/mobile-ai/system/imageWorkspace/screenshot_*.png`。
  给宿主侧路径（如 `E:/.../x.png`）不会把文件写到宿主，宿主侧会出现「找不到文件」。
- 要拿到可查看图片，用 `includePreview=true` 让工具返回图片块，再由宿主侧解码落盘。
- `size=0` 或 `fileSize=0` 是常见返回，不代表截图失败；以图片块内容和后续观察为准。
- 战斗等连续动画期间不要带 `waitStable=true`，否则容易稳定等待超时；普通截图仍可用。

## 参考实现

探索工作区里的 `capture.mjs` 用 stdio 直接驱动设备 MCP、调用 `device_screenshot` 并解码图片块落盘：

```text
node capture.mjs <deviceId> <outFile>
```

它只调用观察类工具，适合在需要真实画面核对时使用。正式产出时应把等价能力沉淀为设备操作技能或项目工具，避免每次临时写脚本。

## 任务等待陷阱

- `device_run_script_text` 的等待由 `timeoutMs` 控制；超时返回 `TASK_WAIT_TIMEOUT`，脚本可能仍在执行。
- 出现 `TASK_WAIT_TIMEOUT` 时必须用 `task_logs <taskId>` 读终态，不能直接重跑，否则会重复执行点击。
- 脚本用日志 marker（如 `S13_DONE`）上报关键节点，比只看任务状态更容易定位卡在哪一步。

## 动作验证原则

- `success=true` 只代表事件下发成功，不代表界面已响应。
- 每次关键动作后必须用 OCR / 截图 / 节点复核目标状态锚点。
- 连续两次点击后状态锚点不变，应停止重试并升级恢复手段。
