# 华仔 AutoJs AI 能力包

> 源码镜像说明：AI 能力包源码同步到 GitHub 仓库 `806073526/hz-autojs-ai-capabilities`，自有源码采用 GPLv3（`GPL-3.0-only`）；该镜像只包含 AI 能力包源码，不含工具箱本体（V5 后端 / APP / 桌面端 / 授权中心），也不含依赖 Gitee 主线仓库的维护者流程（`packaging/package-plugin.cmd` 等）。完整插件 ZIP 仍走下方「用途与获取方式」说明的 V5 与授权中心下载入口。

`hz_autojs_toolbox_ai_capabilities` 为 AI 客户端提供 AutoJs 领域技能，以及按用途拆分的设备 MCP 与项目开发 MCP 工具。真实设备操作仍经 V5 后端、V5 APP 与 AutoJs 运行时完成，本项目不替代这些运行组件。

## 用途与获取方式

- 用途：本包为支持「技能（skills）+ stdio MCP」的 AI 客户端提供华仔 AutoJs 工具箱 V5 的 AI 侧能力——设备观察与控制、项目开发与部署、教程录制作者工具（默认关闭），以及随包 AutoJs 离线文档检索。真实设备操作仍由 V5 后端、V5 APP 与 AutoJs 运行时完成。
- 官网：<https://atools.zjh336.cn>。版本、下载与使用说明以官网与 V5 内的入口为准。
- 工具箱本体闭源：V5 后端、Android APP、桌面端与授权中心不公开源码；本插件源码只包含 AI 能力包这一部分，也不包含依赖 Gitee 主线的维护者发布流程。
- 授权边界：设备访问授权与商业授权由 V5 与授权中心决定；本包只提供 AI 侧技能与 MCP 入口，不绕过也不放宽任何 V5 门禁，并在此之上叠加只读模式、危险动作开关与设备锁。
- GitHub 源码入口：<https://github.com/806073526/hz-autojs-ai-capabilities>。

完整 ZIP 与源码的区别：

| 形态 | 获取方式 | 包含什么 | 需要什么 |
| --- | --- | --- | --- |
| 完整插件 ZIP（推荐给使用者） | V5 与授权中心的「插件包」下载入口 | 编译好的 `mcp/dist`、生产依赖 `node_modules`、skills、离线索引与用户说明 | 解压后注册并安装插件；不需要 TypeScript 构建工具链，但 MCP 仍由 Node.js 20+ 运行时启动 |
| 源码（本目录与独立源码镜像） | 私有开发主线（Gitee 大仓库子目录）；打包成功后自动同步到 GitHub 源码镜像 | `mcp/src`、测试、构建脚本、离线文档源、skills 与模板 | Node.js 20+，自行执行 `npm ci` 并构建；不含 `dist` 与 `node_modules` |

## 从源码构建

在 `mcp/` 目录执行（命令与 Node 版本要求来自 `mcp/package.json`）：

```powershell
cd mcp
npm ci
npm run typecheck
npm test
npm run build
```

`npm ci` 按 `mcp/package-lock.json` 精确安装依赖，要求 Node.js 20 及以上（`engines.node`）。`npm test` 与 `npm run build` 会先执行 `pretest` / `prebuild` 中的 `docs:index:check`，校验 `mcp/docs/autojs-index.json` 与离线文档源一致；`npm run build` 产出三个 MCP 入口的 `mcp/dist/`。

## 许可与发布状态

- 自有源码采用 **GNU GPL 第 3 版**（`GPL-3.0-only`），全文见 [LICENSE](LICENSE)。许可证适用于本插件的自有源码；第三方资料与依赖保留各自的声明与署名。
- 源码公开范围仅限本插件；工具箱本体的商业授权和闭源属性保持原有口径。
- 第三方资料：`mcp/docs/autojs/**` 是 Auto.js Pro 文档的离线副本，随包保留的原始 HTML 中带站点标识 `tool.zjh336.cn` 与作者署名；它只用于构建随包符号级索引 `mcp/docs/autojs-index.json`。该目录的著作权归 Auto.js Pro 作者，随本仓库分发只为离线检索与索引构建所需，不适用本仓库的 GPLv3 授权；权利方如有异议可在仓库提出。第三方依赖的许可信息见 `mcp/package-lock.json` 与各依赖包自带声明。

## 文档入口

- [文档索引](docs/README.md)
- [产品定位](docs/product/overview.md)
- [插件运行结构](docs/architecture/plugin-runtime.md)
- [双 MCP 与项目开发能力改造设计](docs/architecture/dual-mcp-project-development.md)
- [安装与验证](docs/runbooks/install-and-verify.md)
- [分发包打包](packaging/README.md)

## 目录职责

- `.codex-plugin/`、`.mcp.json`：Codex 插件和 MCP 启动入口。
- `.zcode-plugin/`：ZCode 插件清单；`mcpServers` 指向 `.claude.mcp.json`，覆盖 ZCode 自动读取的 Codex 相对路径配置。
- `.claude-plugin/`、`.claude.mcp.json`：Claude Code 插件清单与 MCP 启动入口；`.claude-plugin/marketplace.json` 同时是 ZCode 与 Claude Code 的本地市场清单。
- `.workbuddy-plugin/`、`mcp/workbuddy.mcp.json`：WorkBuddy 插件清单、本地市场清单与 MCP 启动入口；用 `${CODEBUDDY_PLUGIN_ROOT}` 绝对化入口路径。该 MCP 文件必须留在 `mcp/` 目录：WorkBuddy 引擎会扫描插件内 `mcp/*.json`，靠它覆盖插件根 `.mcp.json` 的同名 server（覆盖顺序：清单 mcpServers → `.mcp.json` → `mcp/*.json`）。
- `mcp/`：TypeScript MCP Server、测试、随包 AutoJs 离线文档与符号级索引；`mcp/src/core/` 为双入口共用核心。
- `mcp/docs/autojs-index.json`：从离线文档蒸馏的符号级索引，供 device MCP 与 V5 AI 工作台共用。
- `skills/`：设备操作、AutoJs 脚本编写、项目开发部署、任务探索、自动化项目生成和检测模型训练技能。
- `examples/`：独立 MCP 与 marketplace 配置示例。

设备 MCP 与项目开发 MCP 是两个独立 server，skill 与 MCP 也是两个独立开关：启用 skill 不会自动启用 MCP。

构建、安装、缓存和实时工具验证是不同环节。修改本目录中的源码或文档，不代表已重新安装插件或更新当前 AI 会话；完整判定方法见[安装与验证](docs/runbooks/install-and-verify.md)。

