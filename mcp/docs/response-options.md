# 响应整形参数（responseOptions）

MCP 工具的返回值默认按“最小必要”返回，避免把 token 浪费在模型用不到的字段上。
需要在个别调用上显式放大或裁剪时，给该工具传一个可选的 `responseOptions` 对象即可。

```json
{
  "deviceId": "device_android_xxx",
  "responseOptions": {
    "outputFormat": "compact",
    "includeRaw": false,
    "maxPayloadChars": 2000
  }
}
```

## 为什么收进一个对象

这些开关原本以顶层扁平参数的形式出现在几乎每个工具的 schema 里。
实测设备入口 23 个工具的 schema 合计约 27000 字符，其中 20 个重复展开的响应参数占 55%（该数字是收拢前的快照；之后新增的知识库只读工具走同一 `createTool` 入口，没有再展开响应参数）。
schema 每轮对话都要随请求重发，这部分是纯 token 税，且重复内容会让模型更难抓重点。

现在这些开关只以 `responseOptions` 一个字段暴露，schema 总量降到约 13700 字符（-47%）。
顶层扁平写法仍然兼容：`normalizeResponseOptions()` 只在顶层缺省时才用 `responseOptions` 补齐，顶层显式传值优先。

## 预览图（includePreview）不占文本上下文

`device_screenshot` / `device_layout_dump` 等工具在 `includePreview: true` 时，V5 会把预览图
以 `previewBase64` 文本字段回传。MCP 侧会在任何截断之前把它摘出来，还原成真正的
**image 内容块**发给客户端：

- 文本块里**不会**再出现 `previewBase64`，也不会出现 base64 片段；
- 模型因此能真正“看图”，而不是拿到一段被 `maxChars` 截成半截、既不可用又重复计费的文本；
- 单次结果最多回传 4 张图片，单张解码上限 10 MB；非法或超限的 base64 会被丢弃而不是变成图片块；
- 只取路径、尺寸、状态这类元数据时，保持默认 `includePreview: false` 即可，不传图片。

因此不要再用“避免大 base64”为由关掉预览；需要看图就开 `includePreview`。

## 字段

### 任务类（device_screenshot / device_run_script_* / task_wait / device_stop_script 等）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| includeRaw | boolean | false | 是否附带 V5 原始任务详情 raw |
| includePayload | boolean | 视工具 | 是否返回 resultPayload；识别/布局类默认 false，脚本任务默认 true |
| maxPayloadChars | number | 8000 | resultPayload 字符上限，0 表示不返回 |
| maxLogsChars | number | 8000 | includeLogs=true 时日志字符上限 |
| logTailLines | number | 200 | includeLogs=true 时只保留末尾 N 行，0 表示不按行截断 |
| markerStart / markerEnd | string | - | 只提取两个 marker 之间的日志 |

### 日志类（device_logs / task_logs）

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| maxChars | number | 8000 | 日志字符上限 |
| tailLines | number | 200 | 只保留末尾 N 行，0 表示不按行截断 |
| markerStart / markerEnd | string | - | 只提取两个 marker 之间的日志 |

### 布局类（device_find_node / device_click_node / device_layout_dump）

两类口径的默认值不同：**操作口径**（`device_find_node` / `device_click_node`）只给可用节点，
**结构分析口径**（`device_layout_dump`）给全部窗口与全部节点。

| 字段 | 类型 | 操作口径默认 | 结构分析口径默认 | 说明 |
| --- | --- | --- | --- | --- |
| limit | number | 0 | 0 | 最多返回节点数；**0 = 不限数量**，返回全部节点 |
| layoutRange | active \| all | active | all | 采集窗口范围；高级权限（uiautomator dump）通道下该参数不生效 |
| visibleOnly | boolean | true | false | 只返回边界有效的节点（排除零面积、屏外、负数 bounds；WebView 视口外节点大多属于此类） |
| usableOnly | boolean | true | false | 只返回可用节点：enabled 且可点击/长按/滚动/勾选/可输入，或带 text/desc 的可读锚点 |
| clickableOnly | boolean | false | false | 只返回 clickable=true 的节点 |
| textOnly | boolean | false | false | 只返回带 text 或 desc 的节点 |
| dedupe | boolean | true | false | 按 text/desc/id/className/bounds 去重 |
| fields | string | text,desc,id,className,clickable,scrollable,bounds,center | 同左 | 节点返回字段，逗号分隔 |
| scanLimit | number | limit>0 时 max(limit,500)，limit=0 时不限制 | 同左 | 内部采集节点数，先多取再在 MCP 侧过滤 |
| outputFormat | json \| compact \| lines | json | json | 输出格式；compact 使用短字段，lines 返回可读行文本 |
| includeRecognitionResults | boolean | false | false | 是否附带通用识别结果 |
| includeTaskMeta | boolean | false | false | 是否附带任务元信息 |
| includeActionCandidates | boolean | false | false | 是否附带可疑操作图标/按钮候选 |
| candidateOnly | boolean | false | false | 只返回 actionCandidates |
| actionCandidateLimit | number | 30 | 30 | 操作候选上限 |
| actionCandidateZones | string | topRight,listRight,cardRight,rowRight | 同左 | 操作候选区域，逗号分隔 |

返回里的 `layoutSummary` 会回显实际生效的口径：`limit`、`truncated`、`usableOnly`、`visibleOnly`、
`dedupe`、`totalNodeCount`、`returnedNodeCount`。`truncated=true` 表示撞到了数量上限，
`totalNodeCount` 不是真实总数，此时把 `limit` 改成 0 重读。
