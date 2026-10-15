# 华仔 AutoJs AI 能力包（安装与使用）

本包为 Codex、Claude Code、ZCode 与 WorkBuddy 提供“华仔 AutoJs 工具箱 V5”的 6 个技能与 3 个 MCP 服务：设备通道（26 个工具，含 2 个 AutoJs 离线文档索引工具与 3 个知识库只读工具）、项目开发通道（16 个工具）与作者工具通道（教程录制，默认关闭，开启后 12 个工具）。本包已在 Codex 侧完成装机验收；WorkBuddy 5.8.2 已在本机完成「本地目录市场 → 安装插件 → 三个 MCP 随插件注册并拉起进程」验证（GUI 登录会话里的原生工具调用待复核，见「WorkBuddy（桌面端）」）；通用模式已在豆包完成技能与 stdio MCP 接入验证。Claude Code 与 ZCode 侧仍未随包验证。

技能与 MCP 的定义本身不绑定任何客户端：Codex、Claude Code、ZCode、WorkBuddy 都直接读包内各自的插件清单，装上即带技能与 MCP；其余能接入技能（`SKILL.md` 形式）并配置 stdio MCP 服务的工具（例如豆包）按「通用插件模式」自行接入。注意：MCP 的“验证”指客户端把它注册进自己的 MCP 列表、并在新会话里出现原生工具，不等于“进程能启动”或“兜底通道能调用”；各客户端的注册位置见「通用插件模式」的「各客户端 MCP 注册位置」表。

## 获取渠道、官网与源码

- 官网：<https://atools.zjh336.cn>。
- 完整插件 ZIP：通过 V5 与授权中心的「插件包」下载入口获取；本指南描述的就是这份完整包。
- 源码：插件自有源码以 GPLv3（`GPL-3.0-only`）开源，仓库为 <https://github.com/806073526/hz-autojs-ai-capabilities>；第三方资料与依赖保留各自声明。源码适合阅读实现、跑测试与自行构建；**源码不改变任何授权边界**——设备访问授权与商业授权仍由 V5 与授权中心决定。
- 工具箱本体（V5 后端、Android APP、桌面端与授权中心）闭源，不随本包发布。

## 前置条件

- Node.js 20 或更高版本（MCP 由 `node` 启动；命令行执行 `node -v` 确认）。
- 华仔 AutoJs 工具箱 V5 服务端，默认地址 `http://127.0.0.1:9999`；不在本机时改用户级配置 `config.env` 里的 `HZ_V5_BASE_URL`（见「配置参数」）。
- V5 APP（Android）与 AutoJs 运行时；设备访问授权按 V5 既有流程办理。
- 版本要求记录在同目录 `dependencies.json`（`v5ServerVersion`、`androidAppVersionName` / `androidAppVersionCode`）。本包在该版本上构建，请使用不低于该版本的 V5 服务端与 APP；实际可用能力以你的 V5 版本与授权为准。

## 安装（推荐：放到固定的插件源目录）

1. 把 zip 完整解压到一个固定位置，例如用户目录下的 Codex 插件源目录：

   ```text
   %USERPROFILE%\.codex\plugin-sources\hz-autojs-ai-capabilities\<版本>\
   ```

   例如 `C:\Users\你的用户名\.codex\plugin-sources\hz-autojs-ai-capabilities\1.0.3+hz.20260930013729\`。
   不要把包解压到临时目录后再注册：临时目录被清理后，后续安装或升级会失败。

2. 注册市场并安装插件（把路径换成你的实际解压目录）：

   ```powershell
   codex plugin marketplace add "C:\Users\你的用户名\.codex\plugin-sources\hz-autojs-ai-capabilities\<版本>"
   codex plugin add hz-autojs-ai-capabilities@hz-autojs-local
   codex plugin list --json
   codex mcp list --json
   ```

   `plugin list` 应显示 `installed=true`、`enabled=true` 和本包版本；`mcp list` 应出现 `hz-autojs-device-mcp`、`hz-autojs-project-mcp` 与 `hz-autojs-authoring-mcp`（作者工具 MCP 默认只暴露一个状态工具）。

3. 新开一个 Codex 任务，按需启用技能与 MCP（两者是独立开关）。首次可先做一次只读调用（例如设备列表）确认链路可用。

## 更新

新版本一律“新目录 + 重新注册”，不要覆盖旧目录：

```powershell
codex plugin marketplace remove hz-autojs-local
codex plugin marketplace add "C:\Users\你的用户名\.codex\plugin-sources\hz-autojs-ai-capabilities\<新版本>"
codex plugin add hz-autojs-ai-capabilities@hz-autojs-local
```

Codex 会把插件复制进自己的缓存目录运行，源目录只用于安装和升级；确认新版本可用并关闭旧会话后，可以删除旧版本目录。升级不成功时旧目录仍在，重新注册即可回退。

## 卸载

```powershell
codex plugin remove hz-autojs-ai-capabilities@hz-autojs-local
codex plugin marketplace remove hz-autojs-local
```

随后删除对应版本目录。若提示文件被占用，先关闭正在使用该插件的 Codex 任务。

## ZCode（桌面端）

包内提供 ZCode 插件清单 `.zcode-plugin/plugin.json` 与本地市场清单 `.claude-plugin/marketplace.json`，与 Codex 共用同一份解压目录：

1. 保持解压目录不变（与 Codex 使用同一份，例如 `%USERPROFILE%\.codex\plugin-sources\hz-autojs-ai-capabilities\<版本>\`）。
2. 打开 ZCode，进入 设置 → 插件，点右上角「创建」→「添加插件市场」，来源选择本地目录（选择上面的解压目录）。
3. 在「个人」分段找到「华仔 AutoJs AI 能力包」，点「安装」并保持启用。启用后 6 个技能与 3 个 MCP 服务会注册到当前工作台。
4. 新开任务验证：技能出现 `hz-autojs-device-operator`、`hz-autojs-script-author`、`hz-autojs-project-developer`、`hz-autojs-task-explorer`、`hz-autojs-automation-builder`、`hz-autojs-detect-trainer` 六项；MCP 设置里出现三个 server（命名空间 `plugin:hz-autojs-ai-capabilities:`）；可先做一次只读的 `device_list` 调用确认链路。
5. 升级：解压新版本目录后，在 ZCode 的市场源面板移除旧市场源，再添加新目录并重新安装。不要覆盖旧目录，与 Codex 的「新目录 + 重新注册」口径一致。

配置与 Codex 共用同一份用户级 `config.env`（见「配置参数」），不通过 ZCode 插件配置界面填写。

### 交给 ZCode 里的 AI 安装（可选）

ZCode 有与界面同源的插件 CLI（`zcode plugins`），ZCode 任务里的 AI 能执行终端命令，可以把安装过程直接交给它。把下列步骤作为指令发给它：

1. 添加本地市场：`zcode plugins marketplace add "<解压目录>"`；如提示 `hz-autojs-local` 已存在，先执行 `zcode plugins marketplace remove hz-autojs-local` 再添加。
2. 安装：`zcode plugins install hz-autojs-ai-capabilities@hz-autojs-local`；安装后如为停用状态，执行 `zcode plugins enable hz-autojs-ai-capabilities`。
3. 校验：`zcode plugins list --json`，确认版本与你解压的版本一致、`installed` 与 `enabled` 均为真。
4. 若提示 `zcode` 不在 PATH，让 AI 改用上方的界面入口安装，或在 ZCode 安装目录中定位自带的 CLI。

安装完成后新开一个任务，先做一次只读 `device_list` 验证。执行这些命令时 ZCode 会按它自己的安全确认策略向你请求批准。

注意：本包在 ZCode 上的装机与运行验收尚未执行。插件清单、市场清单与 MCP 引用关系已按 ZCode 官方文档与开源实现（`zai-org/ZCode`）核对；ZCode 市场刷新依赖本机目录或 GitHub 访问，网络受限时可能加载失败。

## WorkBuddy（桌面端）

包内提供 WorkBuddy 插件清单 `.workbuddy-plugin/plugin.json`（`skills` 指向 `./skills/`，`mcpServers` 指向 `./mcp/workbuddy.mcp.json`）与本地市场清单 `.workbuddy-plugin/marketplace.json`（市场名与 Codex 一致，条目 `source` 为 `"."`）。装上插件即同时获得 6 个技能与 3 个 MCP，MCP 由插件清单直接注册，不需要再手写用户级 `~/.workbuddy/mcp.json`。

1. 保持解压目录不变（与 Codex 共用同一份，例如 `%USERPROFILE%\.codex\plugin-sources\hz-autojs-ai-capabilities\<版本>\`）。
2. 在 WorkBuddy 里添加本地市场并安装：侧边栏「插件」→ 添加市场（来源选本地目录，指向上面的解压目录）→ 找到「华仔 AutoJs AI 能力包」→ 安装并保持启用。
3. 验证：`~/.workbuddy/plugins/installed_plugins.json` 与 `~/.workbuddy/settings.json` 中出现 `hz-autojs-ai-capabilities@hz-autojs-local` 且版本与包内清单一致；重启或新开 WorkBuddy 会话后工具列表出现 `mcp__hz-autojs-device-mcp__device_list` 等原生工具，并做一次只读 `device_list` 调用。
4. 升级：解压新版本目录后，在 WorkBuddy 的市场源面板移除旧市场源，再添加新目录并重新安装。不要覆盖旧目录，与 Codex 的「新目录 + 重新注册」口径一致。

### 用 WorkBuddy 自带 CLI 安装或核对（可选，无需登录）

```powershell
$wb  = "E:\Program\WorkBuddy"   # 换成你的 WorkBuddy 安装目录
$cli = "$wb\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs"
$env:ACC_PRODUCT_CONFIG_PATH = "$wb\resources\app.asar.unpacked\cli\product.json"
$env:CODEBUDDY_CONFIG_DIR    = "$env:USERPROFILE\.workbuddy"
node $cli plugin marketplace add "<解压目录>"
node $cli plugin install hz-autojs-ai-capabilities@hz-autojs-local
node $cli plugin list --json
```

GUI 与 CLI 读写同一份 `~/.workbuddy` 安装记录，任选一种即可；CLI 的内部文件名与子命令名随 WorkBuddy 版本可能变化，找不到时以 GUI 为准。

手工注册用户级 `%USERPROFILE%\.workbuddy\mcp.json`（见「各客户端 MCP 注册位置」的 WorkBuddy 行）只作为回退路径：适用于你的 WorkBuddy 版本不识别 `.workbuddy-plugin\` 插件清单，或你不想安装插件、只单独接 MCP 的情况。

**本机验证边界**：本机 WorkBuddy 5.8.2 已验证「本地市场注册 → 安装插件 → 插件清单加载 → 三个 MCP server 注册并随插件拉起进程」（插件源目录与安装缓存目录各一次，入口与 `cwd` 均指向插件根，引擎连接状态为 `connected` 并进入各 agent 的工具集）；未登录的 `--serve` 会话内调用会返回 `AuthenticationRequiredError`，因此登录后的 GUI 会话内原生工具调用、MCP 确认卡（elicitation）与图片块渲染仍需登录后复核。本包在 WorkBuddy 上的验收只覆盖到上述边界。

## 包内内容

- `skills\`：设备操作、AutoJs 脚本编写、项目开发、任务探索、自动化项目生成、检测模型训练六个技能。
- `mcp\dist\`、`mcp\node_modules\`：三个 MCP 的可执行入口与生产依赖，安装后无需再执行 `npm install`。
- `mcp\docs\autojs-index.json`：随包 AutoJs API 索引，供 `autojs_docs_search` / `autojs_docs_read` 使用；另外四份 `.md` 是技能正文引用的说明（设备执行模式、确认与设备访问、兜底通道、响应裁剪）。
- `config.env.example`：用户级配置模板（中文注释、含全部参数与默认值），`mcp-config.mjs init` 以它为准。
- `mcp\tools\`：兜底直连器 `mcp-call.mjs` 与配置助手 `mcp-config.mjs`（`init` / `sync` / `show`）。
- `dependencies.json`：本包对应的 V5 服务端与 Android APP 版本。

## 通用插件模式（其他 AI 工具）

Codex、Claude Code、ZCode、WorkBuddy 各有自己的章节与随包清单，所以上面的章节按客户端分别写。如果你的工具不在其中——豆包，或任何能接入技能并配置 stdio MCP 的客户端——按这一章自行接入：把这一章连同解压目录交给该工具里的 AI，它只取需要的部分，按自己客户端的结构把技能与 MCP 配好即可。客户端把这套东西叫插件、连接器还是扩展都不影响接入。本包不为这些客户端提供专属清单或安装器。

### 通用模式的三份事实来源

| 用途 | 位置 | 说明 |
| --- | --- | --- |
| 技能 | `skills\<技能名>\SKILL.md` | 标准 YAML frontmatter（`name` + `description`，技能名为 kebab-case）+ Markdown 正文 |
| MCP 服务 | `.mcp.json` | 三个 server 的启动命令、参数、工作目录与环境变量；这是**模板与唯一事实来源**，用它换算成目标客户端的注册格式 |
| 用户级配置 | `config.env.example` → `<用户主目录>\.hz-autojs-mcp\config.env` | 全部可调参数，与客户端无关，所有宿主共用同一份 |

四个客户端专属目录（`.codex-plugin\`、`.claude-plugin\`、`.zcode-plugin\`、`.workbuddy-plugin\`）对通用模式没有意义，可以忽略。`.claude.mcp.json` 只在支持“插件根变量”的宿主里用，其中 `${CLAUDE_PLUGIN_ROOT}` 需要替换成解压目录的绝对路径；其余情况以 `.mcp.json` 为准，把里面的相对路径换成解压目录的绝对路径。

**包内 `.mcp.json` 是通用模式的模板与唯一事实来源，不是最终注册位置**：Codex / Claude Code / ZCode / WorkBuddy 由各自的插件机制读取对应清单（WorkBuddy 为 `.workbuddy-plugin\plugin.json` → `mcp\workbuddy.mcp.json`），其他客户端必须把三个 server 写进它自己的 MCP 注册文件，客户端才会加载。找不到对应条目时，先向用户确认该客户端的 MCP 配置路径，不要凭猜测写入。

### 各客户端 MCP 注册位置

| 客户端 | 注册到哪 | 格式与要求 | 是否需手动信任 |
| --- | --- | --- | --- |
| Codex | 插件机制（`codex plugin add`），包内 `.mcp.json` 由 Codex 按插件根解析 | 相对路径即可 | 是（启用插件/MCP 开关） |
| Claude Code / ZCode | 插件清单，包内 `.claude.mcp.json` | `${CLAUDE_PLUGIN_ROOT}` 由宿主替换成解压目录 | 是 |
| WorkBuddy | 插件机制（添加本地目录市场 → 安装插件），包内 `.workbuddy-plugin\plugin.json` 的 `mcpServers` 指向 `mcp\workbuddy.mcp.json`，由 `${CODEBUDDY_PLUGIN_ROOT}` 解析插件根 | 相对路径 + 插件根变量，随插件自动注册 | 是（启用插件 / 重启会话） |
| WorkBuddy（手工回退） | 用户级 `%USERPROFILE%\.workbuddy\mcp.json`（Windows）/ `$HOME/.workbuddy/mcp.json`；项目级 `<项目目录>\.workbuddy\mcp.json` | `{"mcpServers": { ... }}`；每个 server 用 `command` / `args` / `cwd` / `env`，路径写解压目录的**绝对路径** | 是（MCP 管理界面 Trust/启用 + 重启） |
| 其他 / 未知 | 未知 | 未知 | 未知 |

**WorkBuddy 注册说明**（默认路径为本机 5.8.2 实测 + 引擎加载逻辑核对；手工回退位置与界面入口依据 WorkBuddy 官方文档「MCP」页）：

- 默认路径（推荐）：随包装插件。WorkBuddy 按 `.codebuddy-plugin` → `.workbuddy-plugin` → `.claude-plugin` 的顺序找插件清单（`marketplace.json` / `plugin.json`），本包提供 `.workbuddy-plugin\plugin.json` 与 `.workbuddy-plugin\marketplace.json`；MCP 配置在 `mcp\workbuddy.mcp.json`，三个 server 都用 `command: node`、`args: ${CODEBUDDY_PLUGIN_ROOT}/mcp/dist/<通道>/index.js`、`cwd: ${CODEBUDDY_PLUGIN_ROOT}`，WorkBuddy 在加载插件时自动注册，不用手工写配置文件。
- 手工回退（不装插件时）：用户级 `%USERPROFILE%\.workbuddy\mcp.json`（Windows）/ `$HOME/.workbuddy/mcp.json`，或项目级 `<项目目录>\.workbuddy\mcp.json`，结构为 `{"mcpServers": { ... }}`。官方界面入口：侧边栏「插件」→「MCP 服务器」→「配置 MCP」，保存后查看状态灯（🟢 连接成功 / 🔴 配置异常）。
- `~/.workbuddy/mcp.json` 是**全局共享**文件（你的其他 MCP 也在里面）：写入前先读取现有内容，只新增/更新本插件的三个键，**不要整体覆盖**；每个 server 用 `command` / `args` / `cwd` / `env`，路径写解压目录的**绝对路径**，写入后在 MCP 管理界面确认启用（Trust），必要时重启 WorkBuddy。
- 三个通道的工具数应为 device **26** / project **16** / authoring **1**（作者工具默认关闭；开启后 12）。数量对不上即说明注册未生效。
- 官方文档：<https://www.workbuddy.ai/docs/zh/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide>。

### 交给 AI 配置（可直接复制）

> 这个目录是「华仔 AutoJs AI 能力包」，为外部工具提供 6 个技能与 3 个 stdio MCP 服务。请按你所在客户端的方式接入，不要修改包内文件：
>
> 1. 技能：`skills\` 下有 `hz-autojs-device-operator`、`hz-autojs-script-author`、`hz-autojs-project-developer`、`hz-autojs-task-explorer`、`hz-autojs-automation-builder`、`hz-autojs-detect-trainer` 六个 `SKILL.md`。注册到你的技能目录；如果支持指向外部目录，就直接指向本包的 `skills\`，不要再复制一份，避免以后升级时两处漂移。
> 2. MCP：**优先走客户端的插件机制**——Codex 用 `codex plugin marketplace add` + `plugin add`；WorkBuddy 添加本地目录市场后安装插件（插件清单自带 MCP：`.workbuddy-plugin\plugin.json` → `mcp\workbuddy.mcp.json`）。只有客户端不支持插件清单、必须手工接入时，才读包根 `.mcp.json`，把三个 server 转成该客户端的 MCP 配置格式写进它自己的 MCP 注册位置（WorkBuddy 手工回退为 `%USERPROFILE%\.workbuddy\mcp.json` 的 `mcpServers`，先读现有内容合并，只增改本插件三个键，不要覆盖其他 MCP）；其余客户端先核对它的注册位置与字段，不要凭猜测写入。启动命令是 `node`；参数里的相对路径换成解压目录的绝对路径；工作目录设为解压目录。
> 3. 配置：执行 `node <解压目录>\mcp\tools\mcp-config.mjs init` 生成用户级配置，再执行 `node <解压目录>\mcp\tools\mcp-config.mjs show`，把脱敏后的结果贴回来。
> 4. 验证（验收标准，缺一不可）：a) 客户端的 MCP 管理界面能看到 `hz-autojs-device-mcp`、`hz-autojs-project-mcp`、`hz-autojs-authoring-mcp` 三个条目；b) 新开的会话里工具列表出现 `mcp__hz-autojs-device-mcp__device_list` 等原生 MCP 工具（命名格式以客户端为准）；c) 用该原生工具成功调用一次 `device_list`。注意：**“MCP 进程能启动” ≠ “MCP 已被客户端注册”**——直接拉起进程、`tools/list` 返回正常或改用兜底直连，都不等于注册通过；a / b 不满足时不得报告“安装完成”，要说明卡在哪一步。
> 5. 报告：说明你实际写入的配置文件位置与验证结果；做不到的项直接说“本客户端不支持”，不要静默跳过。

### 三个 MCP 通道

三个 server 全部走 stdio，只依赖包内 `mcp\node_modules`，不需要额外执行 `npm install`。

| server | 启动命令 | 工具数 | 需要的环境变量 |
| --- | --- | --- | --- |
| `hz-autojs-device-mcp` | `node <解压目录>\mcp\dist\device\index.js` | 26 | 无 |
| `hz-autojs-project-mcp` | `node <解压目录>\mcp\dist\project\index.js` | 16 | `HZ_MCP_CLIENT_ID=hz-autojs-project-mcp` |
| `hz-autojs-authoring-mcp` | `node <解压目录>\mcp\dist\authoring\index.js` | 1（默认）/ 12（开启） | `HZ_MCP_CLIENT_ID=hz-autojs-authoring-mcp` |

工作目录都设为解压目录。`hz-autojs-project-mcp` 与 `hz-autojs-authoring-mcp` 的 `HZ_MCP_CLIENT_ID` 在 `.mcp.json` 里已经写好，照抄即可——部分宿主会过滤掉它认为像凭据的环境变量，所以这个值要写在客户端的 server 配置里，不要指望从系统环境继承。

### 升级

升级要做三件事：

1. 把新版本的解压目录交给同一段指令，按各客户端的方式把技能与 MCP 入口重新指向新目录：Codex 与 WorkBuddy 都是「新目录 + 重新注册市场 / 重装插件」，插件机制会自动带上新目录的 MCP 入口；只有走手工回退的客户端才需要**改客户端的 MCP 注册文件**——把三个 server 的 `args` / `cwd` 改指新目录（WorkBuddy 手工回退为 `~/.workbuddy/mcp.json`，其余客户端见「各客户端 MCP 注册位置」表）。
2. 执行 `node <新解压目录>\mcp\tools\mcp-config.mjs sync`，只补齐新版本新增的配置键。注意：`mcp-config.mjs sync` **只处理用户级 `config.env`，不会更新客户端的 MCP 注册**，第 1 步必须单独完成。
3. 重新执行「交给 AI 配置」里的验收标准：MCP 管理界面可见 + 新会话出现原生 `mcp__hz-autojs-*` 工具 + 原生工具调用成功。

升级采用「新目录 + 重新注册、不覆盖旧目录」时，如果漏掉第 1 步，客户端的注册会继续指向已删除的旧目录——MCP 静默失效且没有报错。用户级配置 `config.env` 与状态目录（默认 `<用户主目录>\.hz-autojs-mcp\state`）都在用户主目录、不在包里，所以升级既不覆盖你的配置，也不会丢项目同步基线。确认新目录可用、旧目录不再被任何客户端引用之后再删除旧目录。

### 通用模式的边界

- 本包不为通用模式的客户端提供专属清单或安装器，接入动作由目标客户端自己完成；本包只保证 `skills\`、`.mcp.json`、`mcp\dist\`、`mcp\tools\` 这几处的内容稳定。
- 通用模式的技能与 MCP 接入已在豆包由用户侧验证；WorkBuddy 已在本机 5.8.2 完成「安装插件 → 三个 MCP 随插件注册并拉起进程」，其 GUI 会话内原生工具调用、确认卡与图片块渲染待复核；其他具名客户端仍需以目标客户端实际能力为准（例如是否支持 elicitation 确认卡、是否渲染 MCP `image` 内容块）。不支持 elicitation 时，需要确认的动作会自动转到 V5 确认页。
- 只支持 stdio 接入。需要远程 HTTP 的客户端请自行用 MCP 代理转换，本包不提供远程 MCP 端点。
- 技能、MCP 的开关互相独立：启用技能不会自动启用对应 MCP，反之亦然。

## 配置参数（用户级 config.env）

插件的全部可调参数都在**用户主目录**下的一份配置文件里，插件目录内的 `.mcp.json` 只保留启动命令，不再放可调参数——所以**插件升级不会覆盖你的配置**。

- 默认路径：`%USERPROFILE%\.hz-autojs-mcp\config.env`（Windows）/ `$HOME/.hz-autojs-mcp/config.env`
- 路径由程序启动时自动解析，跨电脑、跨账户都对；要用别的位置就设置环境变量 `HZ_MCP_CONFIG_FILE`
- 取值优先级：进程环境变量 > 配置文件 > 代码内置默认值；配置文件里的空值（`KEY=`）表示"未设置"，继续用默认值

### 三步走（人和 AI 都按这个流程）

```powershell
node mcp\tools\mcp-config.mjs path    # 1. 看本机解析到的配置路径与状态
node mcp\tools\mcp-config.mjs init    # 2. 首次按包内模板创建（已存在则原样保留，不覆盖）
node mcp\tools\mcp-config.mjs show    # 3. 脱敏查看当前生效值，以及每个键来自哪一层
```

- `init` 以包根目录的 `config.env.example` 为模板：中文注释、包含全部参数与默认值，直接照着改即可。
- 插件升级后如果新增了参数，执行 `node mcp\tools\mcp-config.mjs sync`：只把缺失的新键追加到文件末尾，**已有的键和取值一律不动**。
- 改完配置需要**重新打开任务会话**：MCP 进程只在启动时读一次配置。

### 最常改的几个参数

完整参数与说明见包根 `config.env.example`（每项都有中文注释）。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `HZ_V5_AUTH_TOKEN` | 空 | V5 服务访问令牌（V5 设置 > 访问安全 > V5 服务级 MCP Token）。只有 V5 开启「Web 登录保护」后才需要填 |
| `HZ_V5_BASE_URL` | `http://127.0.0.1:9999` | V5 服务端地址；V5 不在本机时改成实际地址 |
| `HZ_V5_PUBLIC_URL` | 空（回落 `HZ_V5_BASE_URL`） | 发给你的确认页/授权页链接使用的外部地址；只有"MCP 访问 V5 的地址"和"你的浏览器能打开的地址"不同才填 |
| `HZ_MCP_READ_ONLY` | `false` | 只读模式：拦截点击、滑动、输入、脚本下发、设备文件写入、打包与安装，并返回 `READ_ONLY` |
| `HZ_MCP_ENABLE_DANGEROUS_ACTIONS` | `true` | 危险动作总开关：`false` 时含 `shell(`、`uninstall`、`支付` 等关键词的脚本与 APK 安装一律被拒绝；`true` 时按客户端审批模式处理（完全访问自动放行，需要审批时弹确认卡，客户端无法确认时拒绝） |
| `HZ_MCP_ENABLE_DEVICE_LOCK` | `true` | 同一台设备同时只允许一个操作在跑 |
| `HZ_MCP_ENABLE_ELICITATION` | `true` | 是否就地向客户端弹确认卡；关闭后 V5 待确认动作转到 V5 确认页，危险动作直接拒绝（服务端无法判断客户端审批模式） |
| `HZ_MCP_STATE_DIR` | `<用户主目录>/.hz-autojs-mcp/state` | 项目同步基线目录；保持默认就不会随插件升级丢失 |
| `HZ_MCP_ENABLE_TUTORIAL_TOOLS` | `false` | 作者工具（教程录制）MCP 工具开关：默认只暴露只读状态工具 `tutorial_authoring_status`；改成 `true` 并重新打开任务会话后，`hz-autojs-authoring-mcp` 才提供录制、审核与发布工具 |
| `HZ_MCP_AUDIT_LOG_PATH` | 空（不落文件） | 指定后按 JSONL 追加审计记录（敏感字段写入前替换为 `***`） |

`HZ_MCP_ENABLE_DANGEROUS_ACTIONS=false` 时一律拒绝；为 `true`（默认值）时，由客户端审批模式决定：完全访问会自动放行，需要审批的客户端会弹本地确认卡，客户端无法展示确认时拒绝。判定只看脚本文本，不区分只读还是写入，例如 `shell("appops get ...")` 一样会进入危险动作门禁。

### 交给 AI 安装时

把这一节连同包一起给 AI 即可，它的动作应该是：解压 → 按客户端插件机制注册并安装（Codex：`codex plugin marketplace add` → `plugin add`；WorkBuddy：添加本地目录市场 → 安装插件；两者都自带 MCP 配置）→ 仅当客户端不支持插件清单时才按「各客户端 MCP 注册位置」手工把三个 server 写进客户端自己的 MCP 注册文件 → `mcp-config.mjs init` → `mcp-config.mjs show` 把结果贴回来 → 需要时再改配置文件。AI 不需要、也不应该去改**插件目录内**的 `.mcp.json` 或客户端缓存目录；但**必须**让客户端真正注册到 MCP（插件机制或手工注册文件，见「各客户端 MCP 注册位置」）——这是安装的必要步骤，不是可选项。

## 目标检测（端上识别，官方 APP 默认内置）

端上检测插件 yolodet 随官方 V5 APP 默认内置，**不需要安装**：插件 APK 在 APP 插件目录里，脚本里 `$plugins.load("com.zjh336.cn.tools.plugin.yolodet")` 直接可用，用来让设备端脚本「看画面做判断」（红点角标、功能图标、页面导航等）。模型在设备本地推理（ONNX Runtime），不联网、不上传截图。

1. **导入模型**：把训练好的 `.onnx` 与同目录 `classes.json` 推到设备 `/sdcard/appSync/yolo/`（不推就用插件内置 demo 模型）；
2. **脚本里用**：

   ```js
   let YoloDet = $plugins.load("com.zjh336.cn.tools.plugin.yolodet");
   let det = new YoloDet();
   det.setModel("/sdcard/appSync/yolo/my_model.onnx");
   det.prepare();
   let hits = det.findAll(image, "badge");
   ```

3. **训练自己的模型**：用技能 `hz-autojs-detect-trainer`（环境检测 → 环境部署 → 采图 → 自动标注与人工复核 → 训练导出 → 端上验收）；
4. **让生成的项目自动接入检测**：用技能 `hz-autojs-automation-builder`，生成时回答「启用目标检测」。

细节见知识库《目标检测怎么用（端上识别）》。

## 作者工具 MCP（教程录制，默认关闭）

作者工具 MCP（`hz-autojs-authoring-mcp`）用于让 AI 直接录制手机端 / 桌面端教程：建会话 → 录制步骤（手机端复用设备链路，桌面端写入屏幕捕获的抓帧）→ 人工审核（含脱敏）→ 发布成可导入授权中心的教程包。

- **默认关闭**：不配置时该 server 只暴露只读的 `tutorial_authoring_status`，录制类工具不出现在 `tools/list` 里，普通用户不会看到它们。
- **开启方式**：在用户级 `config.env` 里加 `HZ_MCP_ENABLE_TUTORIAL_TOOLS=true`（或同名环境变量），然后重新打开任务会话；开启后该 server 暴露 12 个工具。
- **前提**：教程录制依赖本机可访问的 V5 服务端；手机端录制还要求设备授权（启用访问密码的设备要带设备访问令牌或一次性密码），桌面端抓帧由你在浏览器里手动授权一次捕获源。

## 常见问题

- **MCP 起不来或工具列表为空**：先确认 `node -v` ≥ 20，再确认 `HZ_V5_BASE_URL` 指向的 V5 服务端能在浏览器打开 `/api/health`。
- **WorkBuddy 装完没有 `mcp__hz-autojs-*` 工具**：先确认插件已安装并启用（`~/.workbuddy/plugins/installed_plugins.json` 与 `~/.workbuddy/settings.json` 的 `enabledPlugins`，版本与包内清单一致），再重启或新开 WorkBuddy 会话。若你的 WorkBuddy 版本不识别 `.workbuddy-plugin\` 插件清单，改用手工回退：把三个 server 写进 `~/.workbuddy/mcp.json` 的 `mcpServers`（合并写入，不是插件目录里的 `.mcp.json`），在 MCP 管理界面 Trust/启用后重启。直接拉起 MCP 进程或兜底直连成功都不代表已注册；修复后按「交给 AI 配置」的验收标准自查。
- **报缺少 dotenv 等依赖**：说明解压不完整，重新完整解压（不要只复制 `dist` 目录）。
- **`marketplace add` 提示 "already added from a different source"**：先执行 `codex plugin marketplace remove hz-autojs-local`，再注册新目录。
- **升级后行为没变化**：确认 `codex plugin list --json` 中的 `version` 已是新版本，并在**新任务**里验证。
- **安装或删除时提示文件被占用**：关闭使用该插件的 Codex 任务后重试；不要直接删除或编辑 Codex 的缓存目录。
- **工具返回 `DANGEROUS_ACTION_DISABLED`**：危险动作总开关被显式设成 `false`，动作没有下发到设备。确认 `config.env` 里 `HZ_MCP_ENABLE_DANGEROUS_ACTIONS` 为 `true` 后重新打开任务会话。
- **工具返回 `DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE`**：总开关已开启，但当前客户端无法展示危险动作确认卡。使用支持确认卡的客户端，或在客户端中选择完全访问后重试；涉及 `shell()` 的只读命令同样走这道门禁。
- **工具返回 `READ_ONLY`**：当前处于只读模式。把 `config.env` 里的 `HZ_MCP_READ_ONLY` 改为 `false`，然后重新打开任务会话。
- **改了 config.env 但行为没变**：配置只在 MCP 进程启动时读取，需要重新打开任务会话；先用 `node mcp\tools\mcp-config.mjs show` 核对生效值与来源。`codex mcp list --json` 只能看到启动命令，看不到用户级配置。
- **插件升级后新增了参数**：执行 `node mcp\tools\mcp-config.mjs sync`，它只补齐缺失的新键，不会覆盖你已有的取值。
- **危险动作已放行但仍被 V5 拦**：V5 侧的商业授权、设备访问和待确认动作是独立门禁，MCP 的开关不能越过它们。
- **打开 Web 登录保护后 MCP 报 401「请先登录」**：把 V5 设置里的 MCP Token 完整复制到用户级 `config.env` 的 `HZ_V5_AUTH_TOKEN`，然后重新打开任务会话。V5 的 Web 登录保护关闭时不校验这个 Token；这个值是敏感信息，不要提交到仓库或粘贴到聊天里。

## Claude Code（可选，未随包验证）

包内保留了 `.claude-plugin/plugin.json`、`.claude.mcp.json` 与 `.claude-plugin/marketplace.json`（市场清单同时被 ZCode 使用）。若你使用 Claude Code，按该客户端的插件/市场用法指向同一个解压目录；本包在 Codex 与 WorkBuddy 上做过装机/预注册验收，Claude Code 与 ZCode 侧均未随包验证。

## 边界

本包只提供 AI 侧技能与 MCP 入口。真实设备操作仍由 V5 服务端、V5 APP 与 AutoJs 运行时完成；商业授权与设备访问授权由 V5 侧决定，MCP 的只读模式、危险动作开关与设备锁是在此之上的附加约束（见「配置参数」），本包不绕过任何门禁。配置项的含义、默认值与注释以包内 `config.env.example` 为准；仓库内另有面向维护者的 `docs/runbooks/mcp-configuration.md`（分发包内不含该文件）。

## 许可证与源码

- 本插件的自有源码与自有内容（技能、MCP 源码与随包文档）以 **GPLv3（`GPL-3.0-only`）** 开源发布，许可证全文随包提供（包内 `LICENSE`）；源码仓库：<https://github.com/806073526/hz-autojs-ai-capabilities>。第三方资料与依赖（例如随包 Auto.js Pro 离线文档、npm 依赖）不适用该许可证，保留各自声明。
- 工具箱本体（V5 后端、Android APP、桌面端与授权中心）不在本插件开源范围内，仍按原授权方式提供和使用。
