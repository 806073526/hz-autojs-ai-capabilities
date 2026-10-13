# 兜底通道（mcp-call.mjs）

当会话的工具列表里**没有** `mcp__hz-autojs-device-mcp` / `mcp__hz-autojs-project-mcp`
（客户端未注入插件 MCP 工具）时使用本通道。它替代"客户端 → MCP"这一段传输，
与 MCP 工具**等价**：仍然经过 V5 的授权、设备访问、风险与审计判定，不绕过任何门禁。

## 用法

```
node <插件根>/mcp/tools/mcp-call.mjs list
node <插件根>/mcp/tools/mcp-call.mjs device  <tool> '<jsonArgs>'
node <插件根>/mcp/tools/mcp-call.mjs project <tool> '<jsonArgs>'
```

`<插件根>` 为插件安装目录；开发环境通常是 `<仓库>/hz_autojs_toolbox_ai_capabilities`。

## 环境变量

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `HZ_MCP_CALL_CONFIRM_POLICY` | auto | auto 声明 elicitation 并自动同意（等价"完全访问"）；link 遇待确认动作返回 V5 兜底地址 |
| `HZ_MCP_CALL_VERBOSE` | 未设置 | =1 输出完整原始返回；默认精简输出（省略 resultJson 与 result 的重复项、空值） |
| `HZ_V5_BASE_URL` | 由子进程配置决定 | 本脚本不再注入默认值：子进程按用户级 `config.env` 解析；也可以在本脚本的运行环境里用同名环境变量临时覆盖 |

本脚本只固定 `HZ_MCP_TRANSPORT=stdio` 与 `HZ_MCP_CLIENT_ID=hz-autojs-mcp-call`；其余参数（服务地址、令牌、只读、危险动作、设备锁、状态目录等）一律由子进程按用户级 `config.env` 决定，避免这里的默认值把用户配置压掉。配置路径、全部键与优先级见维护者文档 `docs/runbooks/mcp-configuration.md`；用户侧用 `node mcp/tools/mcp-config.mjs init|sync|show` 管理。

## 输出精简不会降低精准度

默认输出只做两件事：

1. **去掉重复**：`resultJson`（JSON 字符串）与 `result`（同一份数据的已解析对象）同源，只保留 `result`；
   若 `result` 缺失则回退 `resultJson`，无法解析时保留原文。
2. **去掉空值**：去掉 `undefined` / `null` 字段（例如没有待确认动作时的 `pendingAction: null`）。

**所有判断依据都逐字保留**：`ok`、`code`、`message`、`data.result`（含分页元数据、任务状态、错误原因、`authorizationUrl`）。

需要完整原始结构时设 `HZ_MCP_CALL_VERBOSE=1`。

## 与原生 MCP 的差异

唯一差异：需要确认的动作不会出现客户端内联确认卡，而是返回 `PENDING_CONFIRMATION_REQUIRES_V5` 与 `confirmUrl`；
此时把地址交给用户完成确认，不要重复调用。

## 常见问题

- `REQUEST_FAILED` / `REQUEST_TIMEOUT`：先确认 V5 后端是否在运行（`GET /api/health`），不要把后端未启动误报成工具问题。
- `DEVICE_ACCESS_REQUIRED`：动作没有执行、设备访问密码尚未满足。不要重试或改道绕过，
  把返回的 `authorizationUrl` 交给用户（指向 `/#/devices`，有密码输入框），授权后重试。
  不要用 `confirmUrl` 代替：`/#/tool-confirm` 只拿一次性设备 token，无法完成设备授权。
- 参数转义：JSON 必须用单引号整体包裹，内部字符串用双引号。这是该通道最常见的失败原因。
