# 插件运行结构

## 分层模型

```text
源目录
  -> plugin manifest 与 marketplace 元数据
  -> 客户端安装记录
  -> 版本化插件缓存
  -> MCP 注册与进程
  -> 当前会话 skills / tools
  -> V5 后端
  -> V5 APP / AutoJs / Android 设备
```

每一层都能独立成功或失败，不能用上一层的存在推断下一层可用。

| 层 | 权威证据 | 能证明什么 | 不能证明什么 |
| --- | --- | --- | --- |
| 源目录 | Git、manifest、`mcp/src/`、skills | 待分发内容和实现 | 已安装或已加载 |
| Marketplace | marketplace 元数据和客户端列表 | 客户端能发现安装源 | 插件已安装 |
| 安装记录 | `codex plugin list --json` | 插件版本、启用状态和来源 | MCP 已启动或 tools 可调用 |
| 缓存 | 版本化 cache 目录及文件 | 某版本内容已复制 | 当前配置指向该版本 |
| MCP 注册 | `codex mcp list --json` | command、cwd、transport 和启用状态 | 进程健康或工具调用成功 |
| 会话运行面 | 新会话 skills 列表、MCP `tools/list` 和真实调用 | 当前会话实际加载能力 | V5 或设备端一定可用 |

## 三入口结构

源码按设备通道、项目开发通道与作者工具通道拆分，三者共用同一套 TypeScript 核心，不复制 V5 客户端、审计、设备锁或输出裁剪逻辑。

- `mcp/src/core/`：`config`、`v5Client`、`audit`、`deviceLock`、`types`、`mcpServer`、`transport`。
- `mcp/docs/v5-execution-modes.md`：V5 设备执行模式、被拦截无障碍 API 清单与 `__toolbox*` 模式感知动作 API 的权威说明。
- `mcp/src/device/`：设备 MCP 入口与设备、控制、识别、脚本、任务工具。
- `mcp/src/project/`：项目 MCP 入口与项目同步、运行、打包、安装、状态和日志工具。
- `mcp/src/authoring/`：作者工具 MCP 入口与教程录制工具（默认关闭，开启后注册 10 个录制工具）。
- `.mcp.json`、`.claude.mcp.json` 与 `mcp/workbuddy.mcp.json` 同时声明 `hz-autojs-device-mcp`、`hz-autojs-project-mcp` 和 `hz-autojs-authoring-mcp`。

设备入口在原有 21 个设备工具之外，另注册 2 个不依赖 V5 的 AutoJs 文档索引工具（`autojs_docs_search`、`autojs_docs_read`）与 3 个知识库只读工具（`knowledge_search`、`knowledge_read`、`knowledge_assets`）；原有 21 个工具的名称、schema 和行为不变，且不包含项目同步、设备文件管理或 APK 安装。
项目入口不复制 `device_list` 和 `device_status`，也不跨 MCP 调用另一个 server 的工具。三个入口的工具名不重复。

## 客户端清单与市场

同一份源目录装配四个客户端的清单，版本由打包脚本校验一致：

| 客户端 | 插件清单 | 市场清单 | MCP 入口 |
| --- | --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` | `.agents/plugins/marketplace.json` | `.mcp.json`（相对路径，由 Codex 按插件根解析） |
| Claude Code | `.claude-plugin/plugin.json` | `.claude-plugin/marketplace.json` | `.claude.mcp.json`（`${CLAUDE_PLUGIN_ROOT}` 绝对化） |
| ZCode | `.zcode-plugin/plugin.json` | `.claude-plugin/marketplace.json` | `.claude.mcp.json` |
| WorkBuddy | `.workbuddy-plugin/plugin.json` | `.workbuddy-plugin/marketplace.json` | `mcp/workbuddy.mcp.json`（`${CODEBUDDY_PLUGIN_ROOT}` 绝对化；引擎同时扫描插件内 `mcp/*.json`，该文件按文件名序最后加载，覆盖根 `.mcp.json` 的相对路径版本） |

ZCode 的插件清单查找顺序是 `.zcode-plugin/plugin.json` → `.claude-plugin/plugin.json` → `.codex-plugin/plugin.json`；市场清单优先 `.claude-plugin/marketplace.json`，其次根目录 `marketplace.json`。市场条目 `source` 为 `"."` 时，ZCode 把市场根目录自身解析为插件根，因此解压目录同时是市场根与插件根。ZCode 运行时还会自动读取插件根 `.mcp.json`（Codex 的相对路径版本，ZCode 不会把 `cwd` 解析到插件根），所以 `.zcode-plugin/plugin.json` 显式声明 `mcpServers` 指向 `.claude.mcp.json`，以 manifest 覆盖同名 server 的入口。以上规则依据 ZCode 官方文档与 `zai-org/ZCode` 开源实现（`apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts`、`mcp.ts`、`index.ts`）核对。

上面的四份清单不是接入的唯一形态。`skills/<名>/SKILL.md` 与 `.mcp.json` 本身不绑定客户端，其他支持「技能 + MCP」的工具（例如豆包）按包内 `README.md` 的「通用插件模式」章节自行接入：技能指向 `skills/`，MCP 从 `.mcp.json` 抄启动命令并把相对路径换成解压目录的绝对路径。但「包内 `.mcp.json` 是模板」不等于「写完模板就生效」：各客户端把 server 注册到哪里，必须在用户指南的「各客户端 MCP 注册位置」表里逐一给出（WorkBuddy 默认随 `.workbuddy-plugin/plugin.json` 清单注册——引擎按 `.codebuddy-plugin` → `.workbuddy-plugin` → `.claude-plugin` 顺序找清单，并依次合并清单 `mcpServers`、插件根 `.mcp.json`、插件内 `mcp/*.json`，同名 server 后者覆盖前者，所以 WorkBuddy 专用配置放在 `mcp/workbuddy.mcp.json` 而不是插件根；手工回退才是用户级 `~/.workbuddy/mcp.json` / 项目级 `<项目目录>/.workbuddy/mcp.json` 的 `mcpServers`）；注册态验收（MCP 管理界面条目 + 新会话原生工具 + 原生工具调用成功）与升级时要同步更新注册路径的口径同表。因此本仓库不为通用模式客户端新增专属清单，也不把某一份客户端清单当作通用事实来源；打包白名单与升级口径见 `packaging/README.md`。

## 知识库只读工具

设备入口的 3 个知识库工具直接调用 V5 的只读接口 `/api/mcp/knowledge/{search,read,assets}`，不占用设备、不提交设备任务：

- `knowledge_search`：检索官方知识包与客户资料（V5 侧同一套分块 + BM25F + RRF 融合实现），结果带 `sourceType`；引用必须标明「来自官方教程」或「来自你的资料」。工具描述要求：用户问工具箱 V5 / 手机 APP / 网页端的用法、配置位置或操作步骤时，先检索官方教程并用 `knowledge_read` 读正文作答，不得凭记忆或插件自带说明回答。
- `knowledge_read`：按 `docPath`（可带 `anchor`）分段读取正文与关联图片；单次窗口默认且最多 12000 字符，`offset` 指定起点，响应回带 `offset / maxChars / totalChars / nextOffset / truncated`，`truncated=true` 时用 `offset=nextOffset` 继续读，直到读完。客户资料命中 `anchor` 时只读该小节。本段正文引用的图片会对齐成 `windowImages`（`path` + 图注）：官方文档按 Markdown 图片引用与 `assets[].assetPath` 匹配，客户资料小节级读取（`sectionFound=true`）直接采用该小节资产；`includeImages=true` 时把本段图片以内联 image 块一并返回（最多 4 张），不传则只给清单与提示。返回的 `html` 是渲染副本，工具层不放进模型上下文。
- `knowledge_assets`：按 `path` 取单张、按 `paths` 批量取（最多 4 张）、或按 `docPath` 列文档 / 小节图片；内联的图片以 MCP image 块返回（单次最多 4 张），文本结构里不留 base64，超限图片只给路径与本地受控地址。`assets[].inline` 表示本次结果是否真的带回了该图；内容完全相同的图片按传输层口径合并为一个图片块，计数按真实下发块数；`imageHint` / `displayHint` 明确告知图片块会由客户端直接展示给用户（面向通用 agent 的看图诉求）。

边界与依赖：

- 客户资料默认允许外部检索，由 V5 的 AI 设置 `toolbox.ai.knowledge-external-enabled` 控制；关闭后只返回官方内容，显式的客户资料请求被 V5 拒绝。
- 每次调用由 V5 写入知识访问审计（调用方 `mcpClientId`、来源、检索词、文档 / 图片路径、时间），可在知识库页的 `/api/knowledge/audit` 查看。
- 客户资料的格式白名单、敏感文件排除与用户排除名单在 V5 侧统一执行；MCP 只透传路径，不做本地读取或解析。
- AutoJs 符号索引不在这些工具里：查 API 符号用 `autojs_docs_search`（命中即权威，0 命中即不存在）。

## 作者工具 MCP（教程录制）

`hz-autojs-authoring-mcp` 让 AI 直接录制教程，工具默认关闭：

- 开关 `HZ_MCP_ENABLE_TUTORIAL_TOOLS`（默认 `false`）：关闭时只注册只读的 `tutorial_authoring_status`；打开后注册 `tutorial_session_create` / `tutorial_session_update` / `tutorial_session_list` / `tutorial_session_delete`、`tutorial_mobile_preview` / `tutorial_mobile_step`、`tutorial_desktop_step`、`tutorial_step_update` / `tutorial_step_delete`、`tutorial_session_review` / `tutorial_session_publish` 共 12 个工具。
- 删除会话与删除步骤受危险动作门禁约束（需要 `HZ_MCP_ENABLE_DANGEROUS_ACTIONS=true`；是否弹确认卡由客户端审批模式决定）。
- 手机端录制走 V5 既有设备链路（预览布局与截图、执行 TAP / SWIPE / INPUT、按节点 bounds 自动生成高亮）；`TAP` 只给节点选择器时由 V5 用命中节点中心补齐点击坐标。桌面端录制写入调用方提供的抓帧（`imagePath` / `imageBase64`）与 DOM 百分比高亮。
- 步骤截图通过 V5 的 `GET /api/tutorial/sessions/{id}/images/{fileName}` 读取并以 MCP image 块返回，文本结构里不留 base64。
- 教程包产出后仍走授权中心既有「导入 + 发布」链路；这不是新增商业授权能力项，也不进 V5 产品界面。

## 项目 MCP 工具边界

- 设备文件原语：`device_file_list`、`device_file_read_text`、`device_file_write_text`、`device_file_push`、`device_file_pull`、`device_file_operation`，分别桥接 V5 `file.device.*` canonical tool。
- 项目同步：`project_sync_plan`、`project_sync_push`、`project_sync_status`。同步清单与完整基线保存在 MCP 客户端本地状态目录；V5 只保存映射记录、远端根和最近同步摘要。
- 项目运行：`project_run` 只映射 `RUN_PROJECT`，提交前预检设备端 `project.json` 与入口脚本，失败不回退为单文件运行。
- 打包与部署：`project_build`、`project_apk_install`、`project_deploy_status`、`project_task_logs`。

## 正式调用链

MCP 通过 V5 canonical tool 与任务接口访问 V5 后端，操作类请求显式携带 `deviceId`。V5 继续负责服务访问、设备访问授权、任务审计和商业能力边界；MCP 的本地只读、危险动作和设备锁是在此基础上的附加约束。

设备访问以设备为单位授权：设备访问 token 与同设备的 MCP grant 共享同一授权窗口，设备 MCP 与项目 MCP 可携带不同 `mcpClientId`（作者工具 MCP 不访问设备授权），但都按 `deviceId` 校验；`mcpClientId` 只保留为审计来源。MCP 不保存设备明文密码。

APK 安装统一走 `device.apk.install` 契约，支持 `LOCAL_ARTIFACT`、`SERVER_BUILD`、`DEVICE_APK` 三类来源，由 V5 服务端做包名、版本号、版本名称和签名摘要校验；`DEVICE_APK` 无法读取元数据时拒绝自动安装，MCP 不解析 APK。

## Transport 与令牌边界

- `stdio` 由 AI 客户端拉起本地 MCP 进程。
- `http` 提供 Streamable HTTP；非回环监听必须配置入站保护。
- `both` 在一个进程中同时提供 stdio 和 HTTP，各会话使用独立 MCP Server 实例并共享 V5 client、审计器和设备锁。
- `HZ_V5_AUTH_TOKEN` 用于 MCP 访问 V5，转发到 V5 请求。
- `HZ_MCP_HTTP_AUTH_TOKEN` 只保护 MCP HTTP 入站端点，不转发到 V5。
- `HZ_MCP_STATE_DIR` 指定项目 MCP 的本地同步基线目录，默认落在用户目录（`<用户主目录>/.hz-autojs-mcp/state`），不随插件升级丢失。
- 除启动命令与项目 MCP 的 `HZ_MCP_CLIENT_ID` 外，`.mcp.json` 不再包含可调参数；它们统一由用户级 `config.env` 提供。

文档只记录配置键，不记录真实值。三个 MCP 的全部配置键、路径解析与取值优先级以 MCP 配置项与环境变量 为权威；可调参数不在本目录的 `.mcp.json` 里，而在用户级 `config.env`。
