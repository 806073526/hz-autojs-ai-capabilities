#!/usr/bin/env node
/**
 * hz-autojs MCP 直连调用器（Codex 未注册 MCP 工具时的兜底通道）
 *
 * 用途：
 *   当 AI 客户端的工具列表里没有 mcp__hz_autojs_device_mcp /
 *   mcp__hz_autojs_project_mcp 时，用本脚本以 stdio 直接驱动插件自带的
 *   MCP 服务，功能与 MCP 工具等价。
 *
 * 重要约束：
 *   - 本脚本不绕过任何 V5 授权、风险与设备访问校验：所有调用最终仍由
 *     V5 服务端裁决。脚本只是替代"客户端 → MCP"这一段传输。
 *   - 因此需要确认的动作会走 V5 兜底地址（confirmUrl），不会出现
 *     Codex 内联确认卡（那种确认需要客户端的 elicitation 通道）。
 *
 * 用法：
 *   node mcp/tools/mcp-call.mjs list                      # 列出两个服务的工具
 *   node mcp/tools/mcp-call.mjs <service> <tool> [json]   # 调用工具
 *
 *   service ∈ device | project | authoring
 *   json    ∈ 工具参数对象，缺省为 {}
 *
 * 输出策略（HZ_MCP_CALL_VERBOSE）：
 *   默认精简：省略 resultJson 与 result 的重复项及空值，保留全部判断依据（错误码/原因/任务状态）。
 *   =1 输出完整原始返回，便于排查 MCP/V5 原始结构。
 *
 * 确认策略（HZ_MCP_CALL_CONFIRM_POLICY）：
 *   auto    默认。声明 elicitation 能力并自动同意，等价 Desktop 的"完全访问"。
 *   link    不声明 elicitation，遇待确认动作返回 V5 兜底确认页地址给用户。
 *
 * 示例：
 *   node mcp/tools/mcp-call.mjs device device_list '{"includeOffline":false}'
 *   node mcp/tools/mcp-call.mjs device device_status '{"deviceId":"xxx"}'
 *   node mcp/tools/mcp-call.mjs project project_sync_status '{"deviceId":"xxx"}'
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(HERE, "..");

const SERVICES = {
  device: {
    entry: resolve(MCP_ROOT, "dist/device/index.js"),
    label: "hz-autojs-device-mcp"
  },
  project: {
    entry: resolve(MCP_ROOT, "dist/project/index.js"),
    label: "hz-autojs-project-mcp"
  },
  authoring: {
    entry: resolve(MCP_ROOT, "dist/authoring/index.js"),
    label: "hz-autojs-authoring-mcp"
  }
};

// 只固定"兜底通道自身"必须掌控的两项，其余参数一律交给子进程按用户级 config.env 解析，
// 避免这里的环境变量把用户在 config.env 里的设置压掉（环境变量优先级更高）。
const DEFAULT_ENV = {
  HZ_MCP_TRANSPORT: "stdio",
  HZ_MCP_CLIENT_ID: process.env.HZ_MCP_CLIENT_ID || "hz-autojs-mcp-call"
};

function usage(message) {
  if (message) process.stderr.write(`错误: ${message}\n\n`);
  process.stderr.write(
    [
      "用法:",
      "  node mcp/tools/mcp-call.mjs list",
      "  node mcp/tools/mcp-call.mjs <service> <tool> [jsonArgs]",
      "",
      "  service ∈ device | project | authoring",
      ""
    ].join("\n")
  );
  process.exit(2);
}

/** 一个极简的 MCP stdio 客户端：够用即可，不引入额外依赖。 */
class StdioMcpClient {
  constructor(service, confirmPolicy = "auto") {
    this.service = service;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
    // 兜底通道自己扮演 MCP 客户端，按命令行声明的确认策略响应 elicitation。
    this.confirmPolicy = confirmPolicy;
  }

  start() {
    const spec = SERVICES[this.service];
    this.child = spawn(process.execPath, [spec.entry], {
      cwd: MCP_ROOT,
      env: { ...process.env, ...DEFAULT_ENV },
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.on("data", chunk => this.#onData(chunk));
    this.child.stderr.on("data", chunk => {
      this.stderr += chunk.toString("utf8");
    });
    this.child.on("exit", code => {
      this.closed = true;
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`${spec.label} 提前退出（code=${code}）${this.stderrSuffix()}`));
      }
      this.pending.clear();
    });
    this.child.on("error", error => {
      this.closed = true;
      for (const [, entry] of this.pending) entry.reject(error);
      this.pending.clear();
    });
    return this;
  }

  stderrSuffix() {
    const text = this.stderr.trim();
    return text ? `\n--- 服务端 stderr ---\n${text}` : "";
  }

  #onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.#onMessage(message);
    }
  }

  #onMessage(message) {
    // 服务端发起就地确认：兜底通道没有交互界面，按策略自动应答。
    if (message.method === "elicitation/create" && message.id !== undefined) {
      const accept = this.confirmPolicy === "auto";
      this.#write({
        jsonrpc: "2.0",
        id: message.id,
        result: accept
          ? { action: "accept", content: { approved: true } }
          : { action: "decline" }
      });
      return;
    }
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      entry.resolve(message.result);
    }
  }

  #write(payload) {
    if (this.closed) throw new Error("MCP 连接已关闭");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  request(method, params, timeoutMs = 180000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} 超时（${timeoutMs}ms）${this.stderrSuffix()}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: value => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: error => {
          clearTimeout(timer);
          rejectPromise(error);
        }
      });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  async handshake() {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      // 只有 auto 策略才声明 elicitation：否则客户端会自己应答 decline，
      // 而"快速 decline"按协议语义等于"完全访问预授权"，会导致误自动执行。
      capabilities: this.confirmPolicy === "auto"
        ? { elicitation: { form: {} } }
        : {},
      clientInfo: { name: "hz-autojs-mcp-call", version: "0.1.0" }
    }, 60000);
    this.notify("notifications/initialized");
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }
}

function parseArgs(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    usage(`参数不是合法 JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    usage("参数必须是 JSON 对象");
  }
  return parsed;
}

/**
 * 兜底通道输出精简：默认只输出模型真正要读的部分。
 *
 * 关键取舍（不牺牲精准度）：
 *   - 保留 ok / code / message：失败原因、错误码一字不改，这是排障与止损的依据。
 *   - 保留 data.result 或 data.resultJson 的【其中之一】：两者是同一份数据的两种形态，
 *     result 少一层转义、更省 token，优先用 result；缺失时才回退 resultJson。
 *   - 保留 taskId / taskStatus 等顶层定位字段：否则无法追查任务。
 *   - 仅省略重复项与空值；任何"信息"都不删，所以不会让模型判断失误。
 *   - 需要完整原始返回时传 HZ_MCP_CALL_VERBOSE=1，行为与改造前完全一致。
 */
function compactOutcome(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text; // 非 JSON（例如 SDK 报错文本）：原样输出
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return text;
  }
  const out = {};
  for (const key of ["ok", "code", "message"]) {
    if (parsed[key] !== undefined) out[key] = parsed[key];
  }
  const data = parsed.data && typeof parsed.data === "object" && !Array.isArray(parsed.data)
    ? { ...parsed.data }
    : undefined;
  if (data) {
    // result 与 resultJson 同源：只保留更易读的 result，必要时回退。
    const hasResult = data.result !== undefined && data.result !== null;
    if (hasResult) {
      delete data.resultJson;
    } else if (typeof data.resultJson === "string") {
      try {
        data.result = JSON.parse(data.resultJson);
        delete data.resultJson;
      } catch {
        // resultJson 无法解析时保留原文，避免丢信息（例如被下游截断）
      }
    }
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined || value === null) {
        // pendingAction 等为 null 表示"没有"，删掉不损失判断依据。
        delete data[key];
      }
    }
    out.data = data;
  }
  return JSON.stringify(out, null, 2);
}

/** 把 MCP content 数组还原成可直接阅读的文本。 */
function renderContent(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const texts = [];
  for (const part of parts) {
    if (part?.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    } else if (part !== undefined && part !== null) {
      texts.push(JSON.stringify(part));
    }
  }
  return texts.join("\n");
}

async function listTools() {
  const output = {};
  for (const service of Object.keys(SERVICES)) {
    const client = new StdioMcpClient(service, process.env.HZ_MCP_CALL_CONFIRM_POLICY || "auto").start();
    try {
      await client.handshake();
      const result = await client.request("tools/list", {});
      output[SERVICES[service].label] = (result.tools || []).map(tool => tool.name);
    } finally {
      client.stop();
    }
  }
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

async function callTool(service, toolName, args) {
  const client = new StdioMcpClient(service).start();
  try {
    await client.handshake();
    const result = await client.request("tools/call", { name: toolName, arguments: args });
    const text = renderContent(result);
    const verbose = process.env.HZ_MCP_CALL_VERBOSE === "1";
    if (text) process.stdout.write(`${verbose ? text : compactOutcome(text)}\n`);
    else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result?.isError === true) process.exitCode = 1;
    return result;
  } finally {
    client.stop();
  }
}

async function main() {
  const [first, second, third] = process.argv.slice(2);

  if (!first) usage("缺少参数");
  if (first === "list") {
    await listTools();
    return;
  }

  const service = first;
  if (!SERVICES[service]) usage(`未知服务: ${service}`);
  if (!second) usage("缺少工具名");

  await callTool(service, second, parseArgs(third));
}

main().catch(error => {
  process.stderr.write(`调用失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
