import type { AppConfig } from "./config.js";
import type { V5Client } from "./v5Client.js";

export type JsonObject = Record<string, unknown>;

/**
 * 工具结果里携带的真实图片内容块（MCP image content）。
 * data 是纯 base64（不带 data: 前缀），由 mcpServer 转成 image 块发给客户端。
 */
export interface ToolImage {
  data: string;
  mimeType: string;
}

export interface ToolOutcome<T = unknown> {
  ok: boolean;
  code: string;
  message: string;
  data?: T;
  /** 随结果返回的图片。绝不进入文本块：文本里出现 base64 会既不可用又重复计费。 */
  images?: ToolImage[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  handler: (args: JsonObject) => Promise<ToolOutcome>;
}

export interface AuditLogger {
  log: (event: string, payload: JsonObject) => Promise<void>;
}

/**
 * 用户对确认请求的决定。accept 表示同意执行，decline 表示拒绝，cancel 表示未做决定。
 */
export type ConfirmationDecision = "accept" | "decline" | "cancel";

export interface ConfirmationRequest {
  message: string;
  /** 确认标题，用于客户端展示。 */
  title?: string;
  /** 需要用户确认的动作说明，逐行展示。 */
  details?: string[];
}

export interface ToolContext {
  config: AppConfig;
  client: V5Client;
  audit: AuditLogger;
  withDeviceLock: <T>(deviceId: string, action: string, callback: () => Promise<T>) => Promise<T>;
  /**
   * 当前客户端是否支持 MCP elicitation（就地确认）。
   */
  supportsElicitation: () => boolean;
  /**
   * 向用户发起一次就地确认；客户端不支持时抛出。
   */
  requestConfirmation: (request: ConfirmationRequest) => Promise<ConfirmationDecision>;
}

export interface TaskWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  includeLogs?: boolean;
}
