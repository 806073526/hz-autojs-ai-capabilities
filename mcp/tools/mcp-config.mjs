#!/usr/bin/env node
/**
 * 华仔 AutoJs 工具箱 · AI 能力包 —— 用户级配置助手
 *
 * 用户级配置文件是唯一需要维护的一份配置，默认位于：
 *   Windows      %USERPROFILE%\.hz-autojs-mcp\config.env
 *   macOS/Linux  $HOME/.hz-autojs-mcp/config.env
 * 也可以用环境变量 HZ_MCP_CONFIG_FILE 指定到别处。
 *
 * 用法（在插件根目录执行）：
 *   node mcp/tools/mcp-config.mjs path    打印本机解析到的配置路径与状态
 *   node mcp/tools/mcp-config.mjs init    首次按模板创建（已存在则原样保留）
 *   node mcp/tools/mcp-config.mjs sync    按模板补齐缺失参数（不动已有值）
 *   node mcp/tools/mcp-config.mjs show    脱敏打印生效值 + 每个键的来源
 *
 * 所有命令输出 JSON；失败以非 0 退出码结束，message 里给出原因。
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(HERE, "..");
const PLUGIN_ROOT = resolve(MCP_ROOT, "..");

function print(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(message) {
  print({ ok: false, code: "MCP_CONFIG_FAILED", message });
  process.exit(1);
}

const command = (process.argv[2] || "").trim();

let configFileModule;
let configModule;
try {
  configFileModule = await import("../dist/core/configFile.js");
  configModule = await import("../dist/core/config.js");
} catch (error) {
  fail(`无法加载插件构建产物（mcp/dist）：${error instanceof Error ? error.message : String(error)}；请确认插件包完整。`);
}

const { initUserConfig, readUserConfig, syncUserConfig } = configFileModule;
const { describeConfig } = configModule;

if (!command || command === "help" || command === "--help" || command === "-h") {
  print({
    ok: true,
    usage: [
      "node mcp/tools/mcp-config.mjs path",
      "node mcp/tools/mcp-config.mjs init",
      "node mcp/tools/mcp-config.mjs sync",
      "node mcp/tools/mcp-config.mjs show"
    ],
    note: "配置改完后需要重新打开任务会话，MCP 进程只在启动时读取配置。"
  });
  process.exit(0);
}

try {
  if (command === "path") {
    const snapshot = readUserConfig();
    print({
      ok: true,
      command,
      path: snapshot.path,
      overriddenByEnv: snapshot.overridden,
      status: snapshot.status,
      detail: snapshot.detail,
      exists: snapshot.status === "loaded"
    });
    process.exit(0);
  }

  if (command === "init") {
    const result = initUserConfig(PLUGIN_ROOT);
    print({
      ok: true,
      command,
      path: result.path,
      created: result.created,
      detail: result.reason,
      next: result.created
        ? "按需编辑该文件（例如填 HZ_V5_AUTH_TOKEN），然后重新打开任务会话。"
        : "文件已存在，未做任何改动；需要补齐新增参数请执行 sync。"
    });
    process.exit(0);
  }

  if (command === "sync") {
    const result = syncUserConfig(PLUGIN_ROOT);
    print({
      ok: true,
      command,
      path: result.path,
      createdFile: result.created,
      addedKeys: result.addedKeys,
      detail: result.addedKeys.length === 0
        ? "没有缺失参数，文件未改动。"
        : `已追加 ${result.addedKeys.length} 个新增参数；你已有的键与取值没有被改动。`,
      next: "确认无误后重新打开任务会话。"
    });
    process.exit(0);
  }

  if (command === "show") {
    const described = describeConfig();
    const bySource = { env: 0, "config-file": 0, default: 0 };
    for (const entry of described.keys) bySource[entry.source] += 1;
    print({
      ok: true,
      command,
      userConfig: described.userConfig,
      summary: {
        keys: described.keys.length,
        fromEnv: bySource.env,
        fromConfigFile: bySource["config-file"],
        fromDefault: bySource.default,
        unknownKeys: described.unknownKeys
      },
      keys: described.keys,
      note: "值已脱敏；source 表示该键的取值来自哪一层。"
    });
    process.exit(0);
  }

  fail(`未知命令：${command}。可用命令：path / init / sync / show。`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}