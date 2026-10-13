# AI 能力包文档

## 当前权威

- [产品定位](product/overview.md)：使用者、能力范围、非目标与分发边界。
- [插件运行结构](architecture/plugin-runtime.md)：源码、插件、缓存、三个 MCP 入口（设备 / 项目 / 教程录制作者工具）、skills 和 V5 边界。
- [双 MCP 与项目开发能力改造设计](architecture/dual-mcp-project-development.md)：设备通道与项目开发通道的拆分目标、工具边界和改造阶段。
- [安装与验证](runbooks/install-and-verify.md)：从源码检查到实时工具验证的完整流程。
- [分发包打包说明](../packaging/README.md)：面向终端用户 zip 的装配白名单、依赖版本登记、归档位置和装机验收门禁。

## 事实优先级

1. MCP 行为以 `mcp/src/`、测试和实际运行结果为准。
2. 插件打包入口以 `.codex-plugin/plugin.json`、`.claude-plugin/plugin.json`、`.zcode-plugin/plugin.json`、`.claude-plugin/marketplace.json` 和各自 MCP 配置为准。
3. 安装状态以客户端命令输出为准；缓存目录存在不等于已启用。
4. 实时能力以新会话实际加载的 skills 和 MCP 工具列表为准。

MCP 工具的响应整形参数以 [`mcp/docs/response-options.md`](../mcp/docs/response-options.md) 为权威。

AutoJs API 和运行时行为应先经 `autojs_docs_search` / `autojs_docs_read` 检索随包索引 `mcp/docs/autojs-index.json`（V5 脚本适用第一代 Rhino API / v8）。**V5 设备执行模式（`AUTO` / `ACCESSIBILITY` / `PRIVILEGED`）与被拦截的无障碍 API 清单以 [V5 设备执行模式与脚本动作 API](../mcp/docs/v5-execution-modes.md) 为权威**，编写设备脚本前必须先读。

源码镜像说明：`docs/planning/**` 与 `docs/runbooks/mcp-configuration.md` 属于 Gitee 主线维护者资料，只在主线仓库保留，不随独立源码镜像发布。
