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
import { buildTools } from "./tools/index.js";

const SERVER_NAME = "hz-autojs-device-mcp";
const SERVER_VERSION = "0.1.0";

async function main(): Promise<void> {
  const { config, userConfig } = loadConfigWithMeta();
  writeStderr(SERVER_NAME, `用户配置 ${userConfig.path}（${userConfig.status}：${userConfig.detail}）`);
  const runtime: McpRuntime = {
    config,
    client: new V5Client(config),
    audit: createAuditLogger(config),
    lockManager: new DeviceLockManager(config.enableDeviceLock)
  };
  const factory = () => createMcpServer(runtime, {
    serverName: SERVER_NAME,
    version: SERVER_VERSION,
    buildTools
  });

  await startTransports(factory, config, SERVER_NAME);
}

main().catch(error => {
  process.stderr.write(`[${SERVER_NAME}] ${errorMessage(error)}\n`);
  process.exit(1);
});
