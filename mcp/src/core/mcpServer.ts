import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { AppConfig } from "./config.js";
import type {
  AuditLogger,
  ConfirmationDecision,
  ConfirmationRequest,
  JsonObject,
  McpToolDefinition,
  ToolContext,
  ToolOutcome
} from "./types.js";
import { DeviceLockManager } from "./deviceLock.js";
import { V5Client } from "./v5Client.js";
import { splitOutcomeForMcp } from "./toolImages.js";

export interface McpRuntime {
  config: AppConfig;
  client: V5Client;
  audit: AuditLogger;
  lockManager: DeviceLockManager;
}

export interface CreateMcpServerOptions {
  serverName: string;
  version: string;
  buildTools: (ctx: ToolContext) => McpToolDefinition[];
}

export function createMcpServer(runtime: McpRuntime, options: CreateMcpServerOptions): Server {
  const server = new Server(
    {
      name: options.serverName,
      version: options.version
    },
    {
      // 只声明 tools 会让客户端探测 resources/* 时拿到 -32601，进而把整条
      // MCP 连接标记为 connection-failed。声明 resources 并返回空列表，
      // 是对“支持列举、当前无资源”的诚实表达，也避免误报连接失败。
      capabilities: {
        tools: {},
        resources: {}
      }
    }
  );

  const context: ToolContext = {
    config: runtime.config,
    client: runtime.client,
    audit: runtime.audit,
    withDeviceLock: <T>(deviceId: string, action: string, callback: () => Promise<T>) => runtime.lockManager.withLock(deviceId, action, callback),
    supportsElicitation: () => supportsElicitation(server),
    requestConfirmation: (request: ConfirmationRequest) => requestConfirmation(server, request)
  };
  const tools = options.buildTools(context);
  const toolMap = new Map(tools.map(tool => [tool.name, tool]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }))
  }));

  // 能力声明里只有 tools，客户端仍会探测 resources / resourceTemplates。
  // 若不注册处理器，SDK 会回 -32601 Method not found，客户端会记为连接失败。
  // 明确返回空列表，语义是“支持但为空”，不会污染连接健康状态。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const tool = toolMap.get(request.params.name);
    if (!tool) {
      return toMcpResponse({
        ok: false,
        code: "TOOL_NOT_FOUND",
        message: `未知工具: ${request.params.name}`
      });
    }

    const args = normalizeArgs(request.params.arguments);
    const outcome = await tool.handler(args);
    return toMcpResponse(outcome);
  });

  return server;
}

function normalizeArgs(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/**
 * 把工具结果转成 MCP 响应。
 *
 * 关键点：文本块里永远不出现 base64。V5 回传的 previewBase64 由 splitOutcomeForMcp
 * 摘出来，作为真正的 image 内容块发送——否则模型拿到的是半截 base64 文本，
 * 既看不了图，又会在后续每一轮请求里重复计费。
 */
export function toMcpResponse(outcome: ToolOutcome) {
  const { text, images } = splitOutcomeForMcp(outcome);
  return {
    content: [
      {
        type: "text" as const,
        text
      },
      ...images.map(image => ({
        type: "image" as const,
        data: image.data,
        mimeType: image.mimeType
      }))
    ],
    isError: !outcome.ok
  };
}

/**
 * 客户端是否声明支持 form 模式的 elicitation。
 */
function supportsElicitation(server: Server): boolean {
  const capabilities = server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    return false;
  }
  // MCP 规范允许 elicitation 只声明 url；本实现只使用 form，缺少 form 时按不支持处理。
  return Boolean(capabilities.elicitation.form);
}

/**
 * 向客户端发起一次就地确认。
 *
 * 使用 form 模式收集一个布尔决定，避免依赖客户端对 URL 模式的支持。
 * 客户端未声明 elicitation 能力时直接抛出，由调用方降级为兜底地址。
 */
async function requestConfirmation(server: Server, request: ConfirmationRequest): Promise<ConfirmationDecision> {
  if (!supportsElicitation(server)) {
    throw new Error("CLIENT_ELICITATION_UNSUPPORTED");
  }
  const detailLines = Array.isArray(request.details) ? request.details.filter(Boolean) : [];
  const message = detailLines.length
    ? `${request.message}\n\n${detailLines.join("\n")}`
    : request.message;
  const result = await server.elicitInput({
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      properties: {
        approved: {
          type: "boolean",
          title: request.title || "是否确认执行",
          description: "选择“是”将执行该动作，选择“否”将拒绝该动作。",
          default: false
        }
      },
      required: ["approved"]
    }
  });
  if (result.action === "accept") {
    return result.content?.approved === true ? "accept" : "decline";
  }
  if (result.action === "decline") {
    return "decline";
  }
  return "cancel";
}
