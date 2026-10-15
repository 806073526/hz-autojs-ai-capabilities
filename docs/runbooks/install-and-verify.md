# 安装与验证

> 面向终端用户的 zip 由 [分发包打包](../../packaging/README.md) 装配，包内 `README.md` 给出用户侧安装、更新与回退步骤；本文件仍是“装完之后怎么验”的权威，两者不能互相替代。

## 判定层级

插件交付必须分别回答以下问题：

1. 源码是否通过检查。
2. Marketplace 是否能发现插件。
3. 客户端是否安装并启用目标版本。
4. 两个 MCP 是否都从目标版本缓存注册。
5. 新会话是否加载目标 skills 和实时工具。
6. 工具是否能经 V5 完成最小真实调用。

没有完成的层级应明确写成未验证。

包内 `README.md` 的「通用插件模式」章节是文档能力，不在上述 Codex 装机验收层级内：它不新增任何清单文件。豆包的技能注册与 stdio MCP 接入、WorkBuddy 的技能注册已由用户侧验证；WorkBuddy 的 MCP 注册位置（`%USERPROFILE%\.workbuddy\mcp.json` 的 `mcpServers`，按 WorkBuddy 官方文档核对；合并写入、Trust 后重启为用户侧反查结论）与注册步骤已写入用户指南的「各客户端 MCP 注册位置」，其注册态尚无用户侧确认证据。通用模式的验收按「客户端注册态」判定（缺一不可）：客户端 MCP 管理界面可见三个 server 条目、新会话出现原生 `mcp__hz-autojs-*` 工具、原生工具调用成功；只拉起 MCP 进程或经兜底通道调用成功都不代表注册通过；升级时要同步更新注册路径，该要求同表。打包产物在 `plugin-release-manifest.json` 的 `universalModeAcceptance` 记录上述验证范围。其余客户端仍以目标客户端实际能力为准。

## 检查源码

在 `mcp/` 目录执行：

```powershell
npm ci
npm run typecheck
npm test
npm run build
```

确认 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json`、`.mcp.json`、`.claude.mcp.json` 与 `.claude-plugin/marketplace.json` 指向存在的文件或目录。三个 manifest 与市场条目版本必须一致；打包脚本会做这项静态校验。

## 检查 Marketplace

从项目集合根目录执行：

```powershell
codex plugin marketplace list --json
```

若列表中没有 `hz-autojs-source`，注册当前项目集合：

```powershell
codex plugin marketplace add E:\selfWork\hz_autojs_project --json
```

Marketplace 可见只代表插件可安装。

## 安装 Codex 插件

首次安装或目标版本更新后执行：

```powershell
codex plugin add hz-autojs-ai-capabilities@hz-autojs-source --json
codex plugin list --json
```

核对 `pluginId`、`version`、`installed`、`enabled` 和来源。更新版本时先修改三个 manifest 的 cachebuster，再重装；Windows 文件锁可能阻止移除，不能删除源目录或直接编辑缓存来规避。

## 安装 ZCode 插件（GUI，手动）

ZCode 没有稳定的命令行装机验收入口，按以下步骤在客户端内执行并留证：

1. 设置 → 插件 → 创建 → 添加插件市场，来源选择本包解压目录（市场清单 `.claude-plugin/marketplace.json` 的条目 `source` 为 `"."`，指向目录自身）。
2. 安装 `hz-autojs-ai-capabilities` 并启用。
3. 核对六个技能注册到「Plugin 技能」：`hz-autojs-device-operator`、`hz-autojs-script-author`、`hz-autojs-project-developer`、`hz-autojs-task-explorer`、`hz-autojs-automation-builder`、`hz-autojs-detect-trainer`。
4. 核对 MCP 设置中出现三个 server（命名空间 `plugin:hz-autojs-ai-capabilities:`）：`hz-autojs-device-mcp`、`hz-autojs-project-mcp`、`hz-autojs-authoring-mcp`，入口指向插件根 `mcp/dist/{device,project,authoring}/index.js`。
5. 以新任务执行一次只读 `device_list`；V5 条件不具备时停在工具列表验证，并把真实调用记为缺口。

## 核对 MCP 注册和缓存

```powershell
codex mcp list --json
```

分别找到 `hz-autojs-device-mcp`、`hz-autojs-project-mcp` 和 `hz-autojs-authoring-mcp`，逐一核对：

- `enabled` 为 true。
- command 指向 Node，入口分别为 `mcp/dist/device/index.js`、`mcp/dist/project/index.js` 和 `mcp/dist/authoring/index.js`。
- 三者 `cwd` 均位于同一目标插件版本缓存。
- 三个 server 的 `command` / `args` / `cwd` 正确；`.mcp.json` 里不应再出现可调参数（只允许项目 MCP 的 `HZ_MCP_CLIENT_ID`）。可调参数在用户级 `config.env`，用 `node mcp/tools/mcp-config.mjs show` 核对生效值与来源。
- 输出中不泄漏真实令牌或设备密码。

再确认该缓存中存在三个构建入口和三个 skill。缓存目录存在只证明文件已复制，仍需下一步运行验证。

## 验证三个入口的工具列表

不依赖新会话的快速检查（在目标缓存目录内）：

```powershell
$cache = "C:\Users\Administrator\.codex\plugins\cache\hz-autojs-source\hz-autojs-ai-capabilities\<目标版本>"
node "$cache\mcp\dist\device\index.js"
node "$cache\mcp\dist\project\index.js"
node "$cache\mcp\dist\authoring\index.js"
```

按 MCP stdio 协议发送 `initialize`、`notifications/initialized` 和 `tools/list`，核对：

- 设备入口返回 26 个工具：原有 21 个设备/任务工具，加 2 个 AutoJs 文档索引工具 `autojs_docs_search`、`autojs_docs_read`，加 3 个知识库只读工具 `knowledge_search`、`knowledge_read`、`knowledge_assets`（检索官方知识包与客户资料，直接调用 V5 的 `/api/mcp/knowledge/**`，不占用设备）。
- 项目入口返回 16 个工具：`device_file_list`、`device_file_read_text`、`device_file_write_text`、`device_file_push`、`device_file_pull`、`device_file_operation`、`project_sync_plan`、`project_sync_push`、`project_sync_status`、`project_run`、`project_dependencies_status`、`project_install_dependencies`、`project_build`、`project_apk_install`、`project_deploy_status`、`project_task_logs`。
- 项目入口不包含 `device_list` 和 `device_status`。
- 作者工具入口默认只返回 1 个工具 `tutorial_authoring_status`；带 `HZ_MCP_ENABLE_TUTORIAL_TOOLS=true` 启动时返回 12 个工具（`tutorial_session_create` / `tutorial_session_update` / `tutorial_session_list` / `tutorial_session_delete` / `tutorial_mobile_preview` / `tutorial_mobile_step` / `tutorial_desktop_step` / `tutorial_step_update` / `tutorial_step_delete` / `tutorial_session_review` / `tutorial_session_publish` 加状态工具），关闭时录制类工具不得出现在列表里。
- 三个入口无重复工具名。

## 新会话运行验证

插件安装后新建 Codex 任务，核对：

- 三项 `hz-autojs` skill 来自目标版本缓存。
- 按场景启用需要的 skill 与 MCP；启用 skill 不会自动启用对应 MCP。
- 三个 MCP 的 `tools/list` 返回源码当前注册的工具，名称和 schema 可解析。
- 先执行只读的设备列表或状态调用；有可用 V5 和测试设备时，再按授权范围执行最小闭环。
- 操作类验证必须显式指定 `deviceId`；危险动作保持关闭。

若 V5、设备或授权条件不具备，停止在工具列表验证，并把真实调用记为缺口。

## 最小真实闭环

以下五项分别验证、分别留证：

1. 设备文件工具：写入设备路径并用 ADB 或 `device_file_read_text` 复核内容。
2. 项目同步：`project_sync_plan` -> `project_sync_push`，核对逐文件结果并复核设备端内容。
3. `project_run`：提交真实项目目录，同时记录缺 `project.json` 与路径越界的拒绝结果。
4. `project_build`：提交打包并取得产物或明确失败日志。
5. APK 安装：至少完成 `SERVER_BUILD`、`LOCAL_ARTIFACT`、`DEVICE_APK` 三类来源中的一类；其余来源明确记录为未验证。

## 结果记录

每次发布至少记录源 commit、三个 manifest 版本、构建与测试结果、Codex 安装版本、三个 MCP 的 cache `cwd`、ZCode 客户端市场/安装/工具列表结论（或未验证）、三入口工具数量与差异、最小调用结果和未验证项。不要用“源码已更新”代替发布结论。
