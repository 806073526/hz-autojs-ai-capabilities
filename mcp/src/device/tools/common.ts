import type {
  ConfirmationDecision,
  JsonObject,
  McpToolDefinition,
  ToolContext,
  ToolImage,
  ToolOutcome
} from "../../core/types.js";
import { executeCanonicalWithConfirmation } from "../../core/pendingConfirmation.js";
import { detachToolImages } from "../../core/toolImages.js";

export const DEVICE_ID_PROPERTY = {
  type: "string",
  description: "V5 设备 ID。操作类工具必须显式传入。"
};

export const WAIT_PROPERTIES = {
  waitForResult: {
    type: "boolean",
    description: "是否等待 V5 任务完成并返回结果。",
    default: true
  },
  timeoutMs: {
    type: "number",
    description: "等待任务完成的超时时间，单位毫秒。"
  }
};

// ---- 响应整形参数：扁平入参的权威 key 清单 ----
//
// 这些字段仍然以“顶层扁平参数”的形式被读取（shapeTaskOutcome / shapeLogOutcome /
// appendLayoutView 都直接看 args.xxx），这样既兼容既有调用习惯，也不会丢失能力；
// 但它们不再逐工具展开进 inputSchema，而是统一收进一个可选的 responseOptions 对象，
// 由 normalizeResponseOptions() 在进入 handler 前合并回顶层。
// 背景：20 个响应参数在 21 个工具里重复展开，曾占 schema 总字符的 55%，
// 而 schema 每一轮对话都要随请求重发，是纯 token 税。
export const TASK_RESPONSE_KEYS = [
  "includeRaw",
  "includePayload",
  "maxPayloadChars",
  "maxLogsChars",
  "logTailLines",
  "markerStart",
  "markerEnd"
] as const;

export const LOG_RESPONSE_KEYS = [
  "maxChars",
  "tailLines",
  "markerStart",
  "markerEnd"
] as const;

export const LAYOUT_RESPONSE_KEYS = [
  "visibleOnly",
  "clickableOnly",
  "textOnly",
  "dedupe",
  "fields",
  "scanLimit",
  "outputFormat",
  "includeRecognitionResults",
  "includeTaskMeta",
  "includeActionCandidates",
  "candidateOnly",
  "actionCandidateLimit",
  "actionCandidateZones"
] as const;

export const ALL_RESPONSE_KEYS: readonly string[] = [
  ...TASK_RESPONSE_KEYS,
  ...LOG_RESPONSE_KEYS,
  ...LAYOUT_RESPONSE_KEYS
];

/**
 * 响应整形入口。完整字段与默认值见 mcp/docs/response-options.md。
 *
 * 这里刻意只保留一句话：该 schema 会随 tools/list 出现在每个工具里，
 * 每多写一行就等于每轮对话多付一次 token；详细说明放文档，按需查阅。
 */
export const RESPONSE_OPTIONS_PROPERTY = {
  type: "object",
  description: "可选响应整形参数，用于显式放大/裁剪返回体积。默认值已按省 token 设定，通常无需传。完整字段见 response-options 文档。",
  additionalProperties: true
};

/**
 * 把可选的 responseOptions 对象合并回顶层扁平参数。
 * 顶层显式传值优先，未显式传值时才由 responseOptions 补齐，避免破坏老调用。
 */
export function normalizeResponseOptions(input: JsonObject): JsonObject {
  const nested = input.responseOptions;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return input;
  }
  const merged: JsonObject = { ...input };
  for (const key of ALL_RESPONSE_KEYS) {
    if (merged[key] === undefined && (nested as JsonObject)[key] !== undefined) {
      merged[key] = (nested as JsonObject)[key];
    }
  }
  delete merged.responseOptions;
  return merged;
}

/** 生成统一的响应整形参数片段；spread 进入工具 schema。 */
export function responseOptionsSchema(): JsonObject {
  return { responseOptions: RESPONSE_OPTIONS_PROPERTY };
}


export interface TaskResponseShapeOptions {
  deferResponseShaping?: boolean;
  includeRawDefault?: boolean;
  includePayloadDefault?: boolean;
  maxPayloadCharsDefault?: number;
  maxLogsCharsDefault?: number;
  logTailLinesDefault?: number;
}

export interface CanonicalExecuteOptions {
  operation?: boolean;
  dangerous?: boolean;
  deviceId?: string;
  waitForTask?: boolean;
  shapeOptions?: TaskResponseShapeOptions;
}

export function ok<T>(message: string, data?: T): ToolOutcome<T> {
  return { ok: true, code: "OK", message, data };
}

export function fail(code: string, message: string, data?: unknown): ToolOutcome {
  return { ok: false, code, message, data };
}

export async function guardedHandler(
  ctx: ToolContext,
  toolName: string,
  args: JsonObject,
  options: { operation?: boolean; dangerous?: boolean; deviceId?: string },
  callback: () => Promise<ToolOutcome>
): Promise<ToolOutcome> {
  try {
    if (options.operation && ctx.config.readOnly) {
      return fail("READ_ONLY", "MCP 当前处于只读模式，禁止真实设备操作");
    }
    if (options.dangerous) {
      const dangerousGate = await resolveDangerousActionGate(ctx, toolName, args);
      if (dangerousGate) {
        return dangerousGate;
      }
    }
    await ctx.audit.log("tool_call", { toolName, args: redactArgs(args) });
    if (options.deviceId) {
      return await ctx.withDeviceLock(options.deviceId, toolName, callback);
    }
    return await callback();
  } catch (error) {
    return fail("TOOL_ERROR", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 危险动作门禁：总开关决定能力是否开放，客户端审批模式决定如何确认。
 *
 * 客户端完全访问会让 elicitation 快速短路，这表示用户已预授权，可以直接执行；
 * 普通审批模式会返回 accept/decline/cancel，由用户当场决定。危险动作只使用本地
 * MCP elicitation，不借用 V5 的服务端待确认动作。
 */
async function resolveDangerousActionGate(
  ctx: ToolContext,
  toolName: string,
  args: JsonObject
): Promise<ToolOutcome | undefined> {
  if (!ctx.config.enableDangerousActions) {
    return fail("DANGEROUS_ACTION_DISABLED", "危险动作总开关已关闭：请设置 HZ_MCP_ENABLE_DANGEROUS_ACTIONS=true 后重新打开任务会话。");
  }
  if (!ctx.config.enableElicitation || !ctx.supportsElicitation()) {
    return fail(
      "DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE",
      "危险动作需要本地 MCP 确认卡，但当前客户端不支持 elicitation 或已关闭；动作未执行。请使用支持确认卡的客户端，或选择完全访问。"
    );
  }
  let decision: ConfirmationDecision;
  const startedAt = Date.now();
  try {
    decision = await ctx.requestConfirmation({
      title: "确认危险动作",
      message: `AI 请求执行危险动作：${toolName}`,
      details: dangerousActionDetails(args)
    });
  } catch (error) {
    return fail("DANGEROUS_ACTION_CONFIRMATION_FAILED", `危险动作确认失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const elapsedMs = Date.now() - startedAt;
  if (decision === "accept") {
    return undefined;
  }
  if (decision === "decline") {
    if (elapsedMs < ctx.config.elicitationAutoDeclineMs) {
      if (ctx.config.autoApproveOnClientPreauthorization) {
        return undefined;
      }
      return fail("DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE", "客户端未展示确认卡，且自动预授权已关闭；危险动作未执行。");
    }
    return fail("USER_DECLINED", "用户拒绝执行该危险动作。");
  }
  return fail("USER_CANCELLED", "用户未完成危险动作确认，动作未执行。");
}

function dangerousActionDetails(args: JsonObject): string[] {
  const details: string[] = [];
  pushDangerousDetail(details, "目标设备", args.deviceId);
  pushDangerousDetail(details, "脚本预览", args.scriptContent, 500);
  pushDangerousDetail(details, "脚本路径", args.scriptPath);
  const targetPath = typeof args.artifactPath === "string"
    ? args.artifactPath
    : typeof args.packagePath === "string"
      ? args.packagePath
      : args.path;
  pushDangerousDetail(details, "目标路径", targetPath);
  pushDangerousDetail(details, "会话", args.sessionId);
  return details;
}

function pushDangerousDetail(details: string[], label: string, value: unknown, maxChars = 0): void {
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  const text = value.trim().replace(/\s+/g, " ");
  details.push(`${label}：${maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars)}...` : text}`);
}

export async function executeCanonicalTool(
  ctx: ToolContext,
  mcpToolName: string,
  args: JsonObject,
  canonicalToolName: string,
  params: JsonObject,
  options: CanonicalExecuteOptions = {}
): Promise<ToolOutcome> {
  return guardedHandler(ctx, mcpToolName, args, {
    operation: options.operation,
    dangerous: options.dangerous,
    deviceId: options.deviceId
  }, async () => {
    const outcome: ToolOutcome = await executeCanonicalWithConfirmation(
      ctx,
      canonicalToolName,
      omitUndefined(params),
      { permissionMode: "FULL_AUTO" }
    );
    if (!outcome.ok || options.waitForTask === false) {
      return outcome;
    }
    const data = outcome.data && typeof outcome.data === "object" && !Array.isArray(outcome.data)
      ? outcome.data as JsonObject
      : {};
    const wait = await maybeWaitForTask(ctx, data.result, args, options.shapeOptions);
    return wait;
  });
}

export function requireString(args: JsonObject, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`参数 ${name} 必须是非空字符串`);
  }
  return value.trim();
}

export function optionalString(args: JsonObject, name: string): string | undefined {
  const value = args[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function requireNumber(args: JsonObject, name: string): number {
  const value = args[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`参数 ${name} 必须是数字`);
  }
  return value;
}

export function optionalNumber(args: JsonObject, name: string, fallback?: number): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`参数 ${name} 必须是数字`);
  }
  return value;
}

export function optionalBoolean(args: JsonObject, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new Error(`参数 ${name} 必须是布尔值`);
  }
  return value;
}

export function optionalObject(args: JsonObject, name: string): JsonObject | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`参数 ${name} 必须是对象`);
  }
  return value as JsonObject;
}

export function taskIdFromSubmitResult(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const value = (data as Record<string, unknown>).taskId;
  return typeof value === "string" && value ? value : undefined;
}

export async function maybeWaitForTask(
  ctx: ToolContext,
  submitData: unknown,
  args: JsonObject,
  shapeOptions: TaskResponseShapeOptions = {}
): Promise<ToolOutcome> {
  const waitForResult = optionalBoolean(args, "waitForResult", true);
  const taskId = taskIdFromSubmitResult(submitData);
  if (!waitForResult || !taskId) {
    return ok("任务已提交", submitData);
  }
  const result = await ctx.client.waitForTask(taskId, {
    timeoutMs: optionalNumber(args, "timeoutMs"),
    includeLogs: optionalBoolean(args, "includeLogs", false)
  });
  return shapeOptions.deferResponseShaping ? result : shapeTaskOutcome(result, args, shapeOptions);
}

export function createTool(name: string, description: string, inputSchema: JsonObject, handler: McpToolDefinition["handler"]): McpToolDefinition {
  // 统一入口：把可选的 responseOptions 对象摊平回顶层参数，再交给原有 handler。
  // 这样所有工具共享同一套响应整形开关，schema 里不必逐工具重复展开 20 个字段。
  const normalizedHandler: McpToolDefinition["handler"] = args => handler(normalizeResponseOptions(args));
  return { name, description, inputSchema, handler: normalizedHandler };
}

export function redactArgs(args: JsonObject): JsonObject {
  const copy: JsonObject = { ...args };
  for (const key of Object.keys(copy)) {
    if (/password|token|secret/i.test(key)) {
      copy[key] = "***";
    }
  }
  return copy;
}

export function objectSchema(properties: JsonObject, required: string[] = []): JsonObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false
  };
}

export function omitUndefined<T extends JsonObject>(value: T): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
  );
}

export function shapeTaskOutcome(
  result: ToolOutcome,
  args: JsonObject,
  options: TaskResponseShapeOptions = {}
): ToolOutcome {
  if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
    return result;
  }
  const data: JsonObject = { ...(result.data as JsonObject) };
  const meta: JsonObject = typeof data.responseMeta === "object" && data.responseMeta !== null && !Array.isArray(data.responseMeta)
    ? { ...(data.responseMeta as JsonObject) }
    : {};

  // 图片必须在任何截断之前摘出来：resultPayload 一旦被 limitValue 压成 _preview，
  // base64 就变成不可解析的半截文本，既还原不成图片，又白占上下文。
  const collectedImages: ToolImage[] = Array.isArray(result.images) ? [...result.images] : [];
  if (Object.prototype.hasOwnProperty.call(data, "resultPayload")) {
    data.resultPayload = detachToolImages(data.resultPayload, collectedImages).value;
  }

  const includeRaw = optionalBoolean(args, "includeRaw", options.includeRawDefault ?? false);
  if (!includeRaw) {
    delete data.raw;
    meta.rawIncluded = false;
  } else {
    // raw 会被保留时才值得遍历：里面的 resultPayload 是 JSON 字符串，同样可能藏预览图。
    if (Object.prototype.hasOwnProperty.call(data, "raw")) {
      data.raw = detachToolImages(data.raw, collectedImages).value;
    }
    meta.rawIncluded = true;
  }

  const includePayload = optionalBoolean(args, "includePayload", options.includePayloadDefault ?? true);
  const maxPayloadChars = Math.max(0, Math.round(optionalNumber(args, "maxPayloadChars", options.maxPayloadCharsDefault ?? 8000) ?? 8000));
  if (!includePayload || maxPayloadChars === 0) {
    delete data.resultPayload;
    meta.payloadIncluded = false;
  } else if (Object.prototype.hasOwnProperty.call(data, "resultPayload")) {
    const limited = limitValue(data.resultPayload, maxPayloadChars);
    data.resultPayload = limited.value;
    meta.payloadIncluded = true;
    if (limited.truncated) {
      meta.payloadTruncated = true;
      meta.payloadOriginalChars = limited.originalChars;
      meta.payloadReturnedChars = limited.returnedChars;
    }
  }

  if (Object.prototype.hasOwnProperty.call(data, "logs")) {
    const compacted = compactLogValue(data.logs, args, {
      maxCharsDefault: options.maxLogsCharsDefault ?? 8000,
      tailLinesDefault: options.logTailLinesDefault ?? 200,
      maxCharsField: "maxLogsChars",
      tailLinesField: "logTailLines"
    });
    data.logs = compacted.value;
    if (compacted.meta) {
      meta.logs = compacted.meta;
    }
  }

  if (Object.keys(meta).length) {
    data.responseMeta = meta;
  }
  return {
    ...result,
    data,
    images: collectedImages.length ? collectedImages : result.images
  };
}

export function shapeLogOutcome(result: ToolOutcome, args: JsonObject): ToolOutcome {
  if (!result.data) {
    return result;
  }
  const compacted = compactLogValue(result.data, args, {
    maxCharsDefault: 8000,
    tailLinesDefault: 200,
    maxCharsField: "maxChars",
    tailLinesField: "tailLines"
  });
  return {
    ...result,
    data: {
      logs: compacted.value,
      responseMeta: compacted.meta
    }
  };
}

function compactLogValue(
  value: unknown,
  args: JsonObject,
  options: {
    maxCharsDefault: number;
    tailLinesDefault: number;
    maxCharsField: string;
    tailLinesField: string;
  }
): { value: unknown; meta?: JsonObject } {
  const maxChars = Math.max(0, Math.round(optionalNumber(args, options.maxCharsField, options.maxCharsDefault) ?? options.maxCharsDefault));
  const tailLines = Math.max(0, Math.round(optionalNumber(args, options.tailLinesField, options.tailLinesDefault) ?? options.tailLinesDefault));
  const markerStart = optionalString(args, "markerStart");
  const markerEnd = optionalString(args, "markerEnd");
  const meta: JsonObject = {};

  let working = value;
  if (markerStart) {
    const text = valueToText(working);
    const extracted = extractBetweenMarkers(text, markerStart, markerEnd);
    working = parseJsonIfPossible(extracted.text);
    meta.markerStart = markerStart;
    if (markerEnd) meta.markerEnd = markerEnd;
    meta.markerFound = extracted.found;
    meta.originalChars = text.length;
    meta.extractedChars = extracted.text.length;
  } else if (tailLines > 0) {
    const tailed = tailValue(working, tailLines);
    working = tailed.value;
    if (tailed.applied) {
      meta.tailLines = tailLines;
      meta.originalLines = tailed.originalLines;
      meta.returnedLines = tailed.returnedLines;
    }
  }

  if (maxChars === 0) {
    return {
      value: undefined,
      meta: {
        ...meta,
        omitted: true
      }
    };
  }

  const limited = limitValue(working, maxChars);
  if (limited.truncated) {
    meta.truncated = true;
    meta.originalChars = limited.originalChars;
    meta.returnedChars = limited.returnedChars;
  }
  return { value: limited.value, meta: Object.keys(meta).length ? meta : undefined };
}

function tailValue(value: unknown, tailLines: number): { value: unknown; applied: boolean; originalLines?: number; returnedLines?: number } {
  if (typeof value === "string") {
    const lines = value.split(/\r?\n/);
    if (lines.length <= tailLines) {
      return { value, applied: false };
    }
    return {
      value: lines.slice(-tailLines).join("\n"),
      applied: true,
      originalLines: lines.length,
      returnedLines: tailLines
    };
  }
  if (Array.isArray(value)) {
    if (value.length <= tailLines) {
      return { value, applied: false };
    }
    return {
      value: value.slice(-tailLines),
      applied: true,
      originalLines: value.length,
      returnedLines: tailLines
    };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["records", "logs", "rows", "items", "list"]) {
      const item = record[key];
      if (Array.isArray(item) && item.length > tailLines) {
        return {
          value: { ...record, [key]: item.slice(-tailLines) },
          applied: true,
          originalLines: item.length,
          returnedLines: tailLines
        };
      }
    }
  }
  return { value, applied: false };
}

function extractBetweenMarkers(text: string, markerStart: string, markerEnd?: string): { text: string; found: boolean } {
  const startIndex = text.indexOf(markerStart);
  if (startIndex < 0) {
    return { text: "", found: false };
  }
  const contentStart = startIndex + markerStart.length;
  if (!markerEnd) {
    return { text: text.slice(contentStart), found: true };
  }
  const endIndex = text.indexOf(markerEnd, contentStart);
  return {
    text: endIndex < 0 ? text.slice(contentStart) : text.slice(contentStart, endIndex),
    found: true
  };
}

function limitValue(value: unknown, maxChars: number): { value: unknown; truncated: boolean; originalChars: number; returnedChars: number } {
  const text = valueToText(value);
  if (text.length <= maxChars) {
    return { value, truncated: false, originalChars: text.length, returnedChars: text.length };
  }
  if (typeof value === "string") {
    const preview = value.slice(0, maxChars);
    return {
      value: `${preview}\n...[truncated ${value.length - preview.length} chars]`,
      truncated: true,
      originalChars: value.length,
      returnedChars: preview.length
    };
  }
  return {
    value: {
      _truncated: true,
      _originalChars: text.length,
      _preview: text.slice(0, maxChars)
    },
    truncated: true,
    originalChars: text.length,
    returnedChars: maxChars
  };
}

function valueToText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonIfPossible(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}
