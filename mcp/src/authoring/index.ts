#!/usr/bin/env node

import { createAuditLogger } from "../core/audit.js";
import { loadConfigWithMeta } from "../core/config.js";
import { DeviceLockManager } from "../core/deviceLock.js";
import { createMcpServer, type McpRuntime } from "../core/mcpServer.js";
import { V5Client } from "../core/v5Client.js";
import {
  errorMessage,
  startTransports,
  writeStderr
} from "../core/transport.js";
import { buildAuthoringTools } from "./tools/index.js";

/**
 * 作者工具 MCP：教程录制（手机端复用设备链路、桌面端写入抓帧、审核与发布）。
 *
 * 默认关闭：只有 HZ_MCP_ENABLE_TUTORIAL_TOOLS=true 时才暴露录制写工具；
 * 关闭时仅暴露 tutorial_authoring_status（说明开关方式），不影响设备/项目 MCP。
 */
const SERVER_NAME = "hz-autojs-authoring-mcp";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const { config, userConfig } = loadConfigWithMeta();
  writeStderr(SERVER_NAME, `用户配置 ${userConfig.path}（${userConfig.status}：${userConfig.detail}）`);
  writeStderr(
    SERVER_NAME,
    config.enableTutorialTools
      ? "教程录制作者工具已开启（HZ_MCP_ENABLE_TUTORIAL_TOOLS=true）"
      : "教程录制作者工具未开启：设置 HZ_MCP_ENABLE_TUTORIAL_TOOLS=true 后重启本 MCP"
  );
  const runtime: McpRuntime = {
    config,
    client: new V5Client(config),
    audit: createAuditLogger(config),
    lockManager: new DeviceLockManager(config.enableDeviceLock)
  };
  const factory = () => createMcpServer(runtime, {
    serverName: SERVER_NAME,
    version: SERVER_VERSION,
    buildTools: buildAuthoringTools
  });

  await startTransports(factory, config, SERVER_NAME);
}

main().catch(error => {
  process.stderr.write(`[${SERVER_NAME}] ${errorMessage(error)}\n`);
  process.exit(1);
});