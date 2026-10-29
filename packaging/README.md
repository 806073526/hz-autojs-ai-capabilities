# AI 能力包分发包打包说明

> 源码镜像说明：独立源码镜像只保留分发包结构、依赖登记与版本口径的说明。正式分发打包脚本 `package-plugin.cmd`、它的测试与 `history_version/` 归档流程都依赖 Gitee 主线的上级仓库（`scripts/release`、V5 仓库），**不在本镜像内，也不能在此运行**；使用者请直接从 V5 与授权中心的「插件包」入口下载完整 ZIP。

本文件是 `hz_autojs_toolbox_ai_capabilities` 面向终端用户分发包（zip）的命令、装配白名单和产物结构权威。装完之后的安装/缓存/MCP 分层验收口径见 [安装与验证](../docs/runbooks/install-and-verify.md)：本文件负责“产出什么”，runbook 负责“装完怎么验”，两者不能互相替代。V5 桌面三平台标准包由 V5 仓库维护（`hz_autojs_toolbox_v5/packaging/README.md`），插件包是独立产物，不并入那份流程。



## 装配白名单

只复制下列内容，其余一律不进分发包：

| 内容 | 为什么需要 |
| --- | --- |
| `.codex-plugin/plugin.json` | Codex 插件 manifest 与版本 |
| `.agents/plugins/marketplace.json` | 让用户 `codex plugin marketplace add <解压目录>` 即可注册市场 `hz-autojs-local` |
| `.mcp.json` | Codex 侧三个 MCP 入口（设备 / 项目 / 作者工具）；入口用相对路径，由 Codex 按插件根解析 |
| `.zcode-plugin/plugin.json` | ZCode 插件清单；`skills` 指向 `./skills/`，`mcpServers` 指向 `./.claude.mcp.json` |
| `.workbuddy-plugin/plugin.json`、`.workbuddy-plugin/marketplace.json` | WorkBuddy 插件清单与本地市场清单；`skills` 指向 `./skills/`，`mcpServers` 指向 `./mcp/workbuddy.mcp.json`，市场条目 `source` 为 `"."` |
| `mcp/workbuddy.mcp.json` | WorkBuddy 侧三个 MCP 入口；用 `${CODEBUDDY_PLUGIN_ROOT}` 绝对化入口路径与工作目录。WorkBuddy 引擎除清单 `mcpServers` 外还会扫描插件内 `mcp/*.json`，本文件按文件名序最后加载，覆盖根 `.mcp.json` 的相对路径版本（放插件根反而会被覆盖，故不提供根级 `.workbuddy.mcp.json`） |
| `.claude-plugin/plugin.json`、`.claude.mcp.json` | Claude Code 插件清单与 MCP 启动入口；`.claude.mcp.json` 用 `${CLAUDE_PLUGIN_ROOT}` 绝对化入口路径，同时被 ZCode 清单引用 |
| `.claude-plugin/marketplace.json` | ZCode 与 Claude Code 共用的本地市场清单；条目 `source` 为 `"."`，把解压目录自身解析为插件根 |
| `skills/**` | 仅装配正式七项技能（设备操作、手机本地操作记忆、脚本编写、项目开发、任务探索、自动化项目生成、检测模型训练）；按正式技能白名单逐目录复制，不复制整个 `skills/` 目录 |

| `mcp/dist/**` | 已编译的 stdio 入口，用户不需要 TypeScript 工具链 |
| `mcp/node_modules/**` | 运行时依赖（`@modelcontextprotocol/sdk`、`dotenv`），裁剪为生产依赖 |
| `mcp/package.json`、`mcp/package-lock.json` | 依赖声明，便于用户自行重建依赖 |
| `mcp/docs/autojs-index.json` | `autojs_docs_search` / `autojs_docs_read` 唯一读取的文档文件（约 0.9 MB） |
| `mcp/docs/v5-execution-modes.md`、`confirmation-and-access.md`、`fallback-channel.md`、`response-options.md` | skills 正文直接引用，属于 AI/用户可见说明 |
| `mcp/tools/**` | 兜底直连器 `mcp-call.mjs` 与用户级配置助手 `mcp-config.mjs`（`init` / `sync` / `show`），技能正文与部署流程直接引用 |
| `config.env.example` | 用户级配置模板（中文注释、含全部配置键）。用户或 AI 执行 `node mcp/tools/mcp-config.mjs init` 时以它为准，复制到 `<用户主目录>/.hz-autojs-mcp/config.env` |
| `dependencies.json` | 依赖版本登记（脚本生成） |
| `README.md` | 面向用户的安装/更新/使用/配置参数说明（由 `packaging/USER-GUIDE.md` 复制），含「通用插件模式」章节：其他支持技能 + MCP 的客户端按该章自行接入，本包不出专属清单 |
| `LICENSE` | GPLv3（`GPL-3.0-only`）许可证全文，随包分发（根目录 `LICENSE`，是唯一允许未跟踪导出的公开白名单文件） |

明确排除的开发过程资料：

- `AGENTS.md` 与 `docs/**`：规划、架构、产品、runbook 和索引都是维护者资料。
- `mcp/docs/autojs/**`：522 个 VuePress 原始文件（94 个 HTML 页面 + 资源，约 16 MB），只用于重建索引，运行期不需要，用户不需要。
- `mcp/src/**`、`mcp/scripts/**`、`mcp/tsconfig.json`、`mcp/test/**`、`mcp/logs/**`。
- `config.env`（真实用户配置）：只存在于用户主目录，绝不进包；包里只带 `config.env.example` 模板。
- `skills/hz-autojs-video-producer/**`：已迁至同级独立视频仓库 `E:/selfWork/video-projects/skills/hz-autojs-video-producer/`，由该仓库版本化；仍不进入本产品仓库 Git、正式插件包或插件公开源码镜像。
- `examples/**`、`.gitignore`、`.git/**`、`packaging/**`。

需要发源码时另出源码包（本脚本不产出），不得把本白名单放宽到“整目录压缩”。

分发形态只有上面这一份 zip。Codex、Claude Code、ZCode、WorkBuddy 走各自的插件清单；其他客户端不单独出包，按包内 `README.md` 的「通用插件模式」章节，从同一份 `skills/**` 与 `.mcp.json` 自行接入技能与 MCP。打包脚本不新增“通用清单”文件，`.mcp.json` 就是通用模式的唯一 MCP 事实来源；WorkBuddy 的专属清单与 MCP 配置必须随包（见上面的装配白名单表）。

## 端上检测插件不随本包分发

端上目标检测插件 yolodet 由**官方 V5 APP 默认内置**（打包时在 `mobile/project.json` / 打包抽屉勾选），
插件 APK 进 APP 插件目录即可被 `$plugins.load` 直接加载，不需要安装到设备，因此本插件包不再随带该 APK，
也不提供独立安装说明；用法见包内 `README.md` 的「目标检测」章节与知识库《目标检测怎么用（端上识别）》。

## 依赖版本登记

分发包根目录的 `dependencies.json` 记录打这个包时的 V5 版本事实：

- `v5ServerVersion`：`hz_autojs_toolbox_v5/backend/pom.xml` 的项目版本。
- `androidAppVersionName` / `androidAppVersionCode` / `androidAppPackageName`：`hz_autojs_toolbox_v5/mobile/project.json`。
- `v5SourceCommit`、`pluginSourceCommit`：两个仓库打这个包时的 commit。
- `clientRequirements`：客户端接入要求（Node.js ≥ 20、`SKILL.md` 技能形态、stdio MCP 与「注册位置见包内 `README.md` 的『各客户端 MCP 注册位置』」指引），供安装前自检；不代替版本兼容性声明。
- `releaseBatch`、`generatedAtUtc`。

口径：这些值表示“本包基于哪个 V5 版本构建”，不是自动的兼容性声明；实际可用能力以用户的 V5 版本、APP 版本和授权为准。可用 `-ServerVersion`、`-AppVersionName`、`-AppVersionCode` 覆盖自动探测值。

## 产物结构

```text
history_version/plugin/<批次>/
  packages/hz-autojs-ai-capabilities-<版本>-<批次>.zip   # 被 git 忽略，只留本机
  manifests/plugin-release-manifest.json                  # 版本、依赖、sha256、文件数、验收结果
  checksums.sha256                                        # zip 校验行
```

分发包解压后的结构：

```text
hz_autojs_toolbox_ai_capabilities/
  README.md                 # 面向用户的安装/更新/使用/配置说明
  config.env.example        # 用户级配置模板（中文注释，全部配置键）
  dependencies.json         # 依赖版本登记
  .codex-plugin/plugin.json
  .agents/plugins/marketplace.json
  .mcp.json
  .zcode-plugin/plugin.json
  .workbuddy-plugin/plugin.json
  .workbuddy-plugin/marketplace.json
  .claude-plugin/plugin.json
  .claude-plugin/marketplace.json
  .claude.mcp.json
  skills/
  mcp/
    dist/
    tools/                  # mcp-call.mjs（兜底直连）+ mcp-config.mjs（配置助手）
    node_modules/           # 生产依赖
    package.json
    workbuddy.mcp.json      # WorkBuddy 三个 MCP 入口（插件根变量绝对化）
    docs/                   # 索引 + 四份说明
```

## 验收门禁

`-VerifyInstall` 验收的是“装配产物能不能装、能不能起 tool 列表”：解压目录注册市场、安装插件、注册 MCP、三个入口 `tools/list`（设备 22 / 项目 16 / 作者 1，开启后 12），结果写进 release manifest。它只覆盖 Codex 侧装机；ZCode 与 WorkBuddy 是 GUI 客户端，装机验收需在客户端内执行（步骤见 [安装与验证](../docs/runbooks/install-and-verify.md) 与用户指南），打包脚本对它们只做静态校验：四个客户端 manifest 版本一致、市场条目 `source` 为 `"."` 且版本一致、ZCode 清单引用 `./.claude.mcp.json`、WorkBuddy 清单引用 `./mcp/workbuddy.mcp.json`。`-VerifyInstall` 不能替代真实 V5 与设备的端到端调用；真实调用按 [安装与验证](../docs/runbooks/install-and-verify.md) 的最小真实闭环执行，并在 `docs/planning/current-status.md` 写明未覆盖项。

## 版本更新与重装

- 分发包版本取自 `.codex-plugin/plugin.json` 的 `version`（cachebuster），形如 `1.0.3+hz.<yyyyMMddHHmmss>`；自 `1.0.3` 起前缀由 `+codex.` 改为端中立的 `+hz.`，历史版本字符串不改写。
- **测试包 / 开发包 / 未正式发布的候选包**：不提升版本号，只刷新 `+hz.<yyyyMMddHHmmss>` 缓存戳。候选包多打几次不代表该语义版本已经正式发布，不得仅因本地存在候选归档就跳到下一个小版本。
- **正式发布的判定**：以插件包本身的正式对外发布为准；正式发布该插件包即视为该插件版本正式发布，不再以授权中心/V5 正式发包的发布说明是否包含插件内容作为判定依据。插件独立分发，不要求作为授权中心组件上传。
- **正式（对外发布）包**：版本基线是最近一次已经正式发布的插件版本，而不是本地最新一次打包记录。插件包尚未正式发布时，内容有变化继续使用该候选语义版本并刷新缓存戳；只有插件包正式发布后，且内容相对最近一次正式发布版本发生变化时，才提升小版本号（`1.0.2` → `1.0.3`）。该版本号是用户侧缓存标识，已正式发布的版本不得承载不同内容，否则用户按版本升级时拿不到新包。
- 历史归档（含 `history_version/VERSION-INDEX.md`）中按旧口径记录的“随 V5/授权中心正式发包即视为插件正式发布”，只保留历史事实，不回溯改写；后续版本判定按本节新口径执行。
- 四个客户端 manifest（`.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json`、`.workbuddy-plugin/plugin.json`）与 `.claude-plugin/marketplace.json`、`.workbuddy-plugin/marketplace.json` 的条目版本必须同步修改并保持一致，打包脚本会校验。
- 用户侧升级顺序：新版本解压到新目录 → `codex plugin marketplace remove hz-autojs-local` → `codex plugin marketplace add <新目录>` → `codex plugin add hz-autojs-ai-capabilities@hz-autojs-local`。市场名固定，源目录变化时 CLI 会拒绝重复添加（实测提示 "already added from a different source"），必须先 remove。CLI 安装时会把插件复制到自己的缓存目录，源目录只用于安装和升级。
- Windows 文件锁可能阻止卸载缓存；不要靠删除源目录或直接改缓存规避，按上述顺序重试，或先关闭占用该插件的会话。

