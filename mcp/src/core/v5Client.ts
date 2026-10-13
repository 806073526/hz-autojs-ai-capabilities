import type { AppConfig } from "./config.js";
import type { JsonObject, TaskWaitOptions, ToolOutcome } from "./types.js";
import { randomUUID } from "node:crypto";

interface V5Result<T = unknown> {
  code?: number;
  msg?: string;
  message?: string;
  data?: T;
}

interface AiToolExecuteResponse {
  toolCallId?: string;
  toolName?: string;
  riskLevel?: string;
  status?: string;
  resultSummary?: string;
  resultJson?: string;
  errorMessage?: string;
  errorCode?: string;
  errorData?: JsonObject;
  durationMs?: number;
  pendingAction?: unknown;
}

export interface TaskSummary {
  taskId: string;
  taskStatus?: string;
  taskMode?: string;
  deviceId?: string;
  resultMessage?: string;
  resultPayload?: unknown;
  /**
   * 终态来源（由 V5 服务端归类）：
   * CHILD_ENGINE / PARENT_ENGINE / WATCHDOG / DEPENDENCY / CANCEL / SERVER。
   *
   * 脚本类任务的 SUCCEEDED 只有 CHILD_ENGINE 代表脚本真实执行完成；
   * 其它来源都是服务端或父引擎的兜底判定。
   */
  terminalSource?: string;
  raw: unknown;
  logs?: unknown;
}

const TERMINAL_TASK_STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);

export interface RequestOptions {
  /** 覆盖本次请求的超时（毫秒）；普通接口默认 requestTimeoutMs，上传接口默认 uploadRequestTimeoutMs。 */
  timeoutMs?: number;
}

export class V5Client {
  constructor(private readonly config: AppConfig) {}

  async get<T = unknown>(path: string, query?: JsonObject, headers?: JsonObject, options?: RequestOptions): Promise<ToolOutcome<T>> {
    return this.request<T>("GET", path, undefined, query, headers, options);
  }

  async post<T = unknown>(path: string, body?: unknown, query?: JsonObject, headers?: JsonObject, options?: RequestOptions): Promise<ToolOutcome<T>> {
    return this.request<T>("POST", path, body, query, headers, options);
  }

  async put<T = unknown>(path: string, body?: unknown, query?: JsonObject, headers?: JsonObject, options?: RequestOptions): Promise<ToolOutcome<T>> {
    return this.request<T>("PUT", path, body, query, headers, options);
  }

  /**
   * 删除类接口（V5 用 @DeleteMapping + @RequestBody，例如清理公共库目录）。
   */
  async delete<T = unknown>(path: string, body?: unknown, query?: JsonObject, options?: RequestOptions): Promise<ToolOutcome<T>> {
    return this.request<T>("DELETE", path, body, query, undefined, options);
  }

  async executeCanonicalTool(
    toolName: string,
    params: JsonObject = {},
    options: { permissionMode?: string; toolCallId?: string; runId?: string; sessionId?: string } = {}
  ): Promise<ToolOutcome<JsonObject>> {
    const canonicalParams = {
      ...params,
      mcpClientId: this.config.mcpClientId,
      mcpRequestId: randomUUID()
    };
    const response = await this.post<AiToolExecuteResponse>("/api/ai/tools/execute", {
      toolName,
      toolCallId: options.toolCallId,
      runId: options.runId,
      sessionId: options.sessionId,
      permissionMode: options.permissionMode || "FULL_AUTO",
      params: canonicalParams
    });
    if (!response.ok) {
      return response as ToolOutcome<JsonObject>;
    }
    return this.toCanonicalOutcome(response.data);
  }

  /**
   * 按 actionId 只读读取待确认动作内容，供 elicitation 展示与兜底确认页复用。
   */
  async getPendingAction(actionId: string): Promise<ToolOutcome<JsonObject>> {
    const response = await this.get<JsonObject>(`/api/ai/pending-actions/${encodeURIComponent(actionId)}`);
    if (!response.ok || !response.data) {
      return response;
    }
    return { ...response, data: this.normalizePendingAction(response.data) };
  }

  /**
   * 确认待确认动作；V5 是执行的唯一权威，确认后返回真实执行结果。
   */
  async confirmPendingAction(actionId: string, body: JsonObject = {}): Promise<ToolOutcome<JsonObject>> {
    return this.post<JsonObject>(`/api/ai/pending-actions/${encodeURIComponent(actionId)}/confirm`, body);
  }

  /**
   * 拒绝待确认动作。
   */
  async rejectPendingAction(actionId: string, body: JsonObject = {}): Promise<ToolOutcome<JsonObject>> {
    return this.post<JsonObject>(`/api/ai/pending-actions/${encodeURIComponent(actionId)}/reject`, body);
  }

  /**
   * 复用 V5 现有单文件 / 分片上传接口；上传走独立超时预算（默认 HZ_MCP_UPLOAD_REQUEST_TIMEOUT_MS），
   * 不再套用普通 JSON 请求的 120 秒上限。
   */
  async uploadMultipart<T = unknown>(path: string, form: FormData, query?: JsonObject, options?: RequestOptions): Promise<ToolOutcome<T>> {
    const timeoutMs = options?.timeoutMs ?? this.config.uploadRequestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (this.config.v5AuthToken) {
        headers.Authorization = `Bearer ${this.config.v5AuthToken}`;
      }
      const response = await fetch(this.buildUrl(path, query), {
        method: "POST",
        headers,
        body: form,
        signal: controller.signal
      });
      const text = await response.text();
      const payload = parseMaybeJson(text);
      if (!response.ok) {
        return { ok: false, code: `HTTP_${response.status}`, message: response.statusText || `HTTP ${response.status}`, data: payload as T };
      }
      if (isV5Result(payload)) {
        const success = payload.code === 200;
        return { ok: success, code: success ? "OK" : `V5_${payload.code ?? "ERROR"}`, message: payload.msg || payload.message || (success ? "OK" : "V5 请求失败"), data: payload.data as T };
      }
      return { ok: true, code: "OK", message: "OK", data: payload as T };
    } catch (error) {
      return { ok: false, code: error instanceof DOMException && error.name === "AbortError" ? "REQUEST_TIMEOUT" : "REQUEST_FAILED", message: error instanceof Error ? error.message : String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async submitTask(body: JsonObject): Promise<ToolOutcome<unknown>> {
    return this.post("/api/task/submit", body);
  }

  async getTask(taskId: string): Promise<ToolOutcome<unknown>> {
    return this.get(`/api/task/${encodeURIComponent(taskId)}`);
  }

  async getTaskLogs(taskId: string): Promise<ToolOutcome<unknown>> {
    return this.get(`/api/logs/task/${encodeURIComponent(taskId)}`);
  }

  async waitForTask(taskId: string, options: TaskWaitOptions = {}): Promise<ToolOutcome<TaskSummary>> {
    const timeoutMs = options.timeoutMs ?? this.config.taskWaitTimeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? this.config.taskPollIntervalMs;
    const deadline = Date.now() + timeoutMs;
    let lastTask: unknown = undefined;

    while (Date.now() <= deadline) {
      const taskResult = await this.getTask(taskId);
      if (!taskResult.ok) {
        return {
          ok: false,
          code: taskResult.code,
          message: taskResult.message,
          data: {
            taskId,
            raw: taskResult.data
          }
        };
      }

      lastTask = taskResult.data;
      const task = asRecord(taskResult.data);
      const status = stringValue(task.taskStatus);
      if (status && TERMINAL_TASK_STATUSES.has(status)) {
        const summary: TaskSummary = {
          taskId,
          taskStatus: status,
          taskMode: stringValue(task.taskMode),
          deviceId: stringValue(task.deviceId),
          resultMessage: stringValue(task.resultMessage),
          resultPayload: parseMaybeJson(task.resultPayload),
          terminalSource: stringValue(task.terminalSource),
          raw: taskResult.data
        };
        if (options.includeLogs) {
          const logs = await this.getTaskLogs(taskId);
          summary.logs = logs.ok ? logs.data : logs;
        }
        return {
          ok: status === "SUCCEEDED",
          code: status === "SUCCEEDED" ? "OK" : `TASK_${status}`,
          message: summary.resultMessage || `任务状态: ${status}`,
          data: summary
        };
      }

      await sleep(pollIntervalMs);
    }

    return {
      ok: false,
      code: "TASK_WAIT_TIMEOUT",
      message: `等待任务 ${taskId} 超时`,
      data: {
        taskId,
        raw: lastTask
      }
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: JsonObject,
    headers?: JsonObject,
    options?: RequestOptions
  ): Promise<ToolOutcome<T>> {
    const timeoutMs = options?.timeoutMs ?? this.config.requestTimeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = this.buildUrl(path, query);
      const response = await fetch(url, {
        method,
        headers: this.buildHeaders(body, headers),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      const payload = parseMaybeJson(text) as V5Result<T> | T;

      if (!response.ok) {
        return {
          ok: false,
          code: `HTTP_${response.status}`,
          message: response.statusText || `HTTP ${response.status}`,
          data: payload as T
        };
      }

      if (isV5Result(payload)) {
        const success = payload.code === 200;
        return {
          ok: success,
          code: success ? "OK" : `V5_${payload.code ?? "ERROR"}`,
          message: payload.msg || payload.message || (success ? "OK" : "V5 请求失败"),
          data: payload.data as T
        };
      }

      return {
        ok: true,
        code: "OK",
        message: "OK",
        data: payload as T
      };
    } catch (error) {
      return {
        ok: false,
        code: error instanceof DOMException && error.name === "AbortError" ? "REQUEST_TIMEOUT" : "REQUEST_FAILED",
        message: error instanceof Error ? error.message : String(error)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string, query?: JsonObject): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${this.config.v5BaseUrl}${normalizedPath}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  private buildHeaders(body?: unknown, extra?: JsonObject): HeadersInit {
    const headers: Record<string, string> = {
      Accept: "application/json"
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (extra) {
      for (const [key, value] of Object.entries(extra)) {
        if (value === undefined || value === null || value === "") {
          continue;
        }
        headers[key] = String(value);
      }
    }
    if (this.config.v5AuthToken) {
      headers.Authorization = `Bearer ${this.config.v5AuthToken}`;
    }
    return headers;
  }

  private toCanonicalOutcome(value: unknown): ToolOutcome<JsonObject> {
    const response = asRecord(value) as AiToolExecuteResponse;
    const status = String(response.status || "").toUpperCase();
    const parsedResult = parseMaybeJson(response.resultJson);
    const data: JsonObject = {
      toolCallId: response.toolCallId,
      toolName: response.toolName,
      riskLevel: response.riskLevel,
      status: response.status,
      resultSummary: response.resultSummary,
      resultJson: response.resultJson,
      result: parsedResult,
      durationMs: response.durationMs,
      pendingAction: response.pendingAction ? this.normalizePendingAction(response.pendingAction) : undefined
    };
    if (response.errorData && typeof response.errorData === "object") {
      Object.assign(data, this.normalizeErrorData(response.errorData));
    }
    if (status === "SUCCEEDED" || status === "FRONTEND_AUTO_EXECUTION") {
      return {
        ok: true,
        code: "OK",
        message: response.resultSummary || response.status || "OK",
        data
      };
    }
    const code = response.errorCode || (status === "PENDING_CONFIRMATION" ? "FULL_AUTO_DENIED" : "CANONICAL_TOOL_FAILED");
    return {
      ok: false,
      code,
      message: withActionableLink(response.errorMessage || response.resultSummary || response.status || "V5 canonical tool failed", code, data),
      data
    };
  }

  /**
   * 待确认动作里的 V5 相对地址按配置转成客户端可访问的绝对地址。
   */
  private normalizePendingAction(value: unknown): JsonObject {
    const action = { ...(asRecord(value) as JsonObject) };
    if (typeof action.authorizationUrl === "string" && action.authorizationUrl) {
      action.authorizationUrl = this.toPublicV5Url(action.authorizationUrl);
    }
    if (typeof action.confirmUrl === "string" && action.confirmUrl) {
      action.confirmUrl = this.toPublicV5Url(action.confirmUrl);
    }
    return action;
  }

  private normalizeErrorData(errorData: JsonObject): JsonObject {
    const copy: JsonObject = { ...errorData };
    if (typeof copy.authorizationUrl === "string" && copy.authorizationUrl) {
      copy.authorizationUrl = this.toPublicV5Url(copy.authorizationUrl);
    }
    return copy;
  }

  private toPublicV5Url(url: string): string {
    if (/^https?:\/\//i.test(url)) {
      return url;
    }
    const base = this.config.v5PublicUrl || this.config.v5BaseUrl;
    const path = url.startsWith("/") ? url : `/${url}`;
    return `${base}${path}`;
  }
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!text) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/**
 * 给需要用户处理的结果补一条可点击地址。
 *
 * 模型经常把地址放进代码块转述，而代码块不会渲染成链接，用户只能手动复制。
 * 这里在 message 里直接给出 Markdown 链接，模型照抄即可点击。
 */
function withActionableLink(message: string, code: string, data: JsonObject): string {
  const record = asRecord(data);
  const candidate = code === "DEVICE_ACCESS_REQUIRED"
    ? stringValue(record.authorizationUrl) || stringValue(asRecord(record.pendingAction).confirmUrl)
    : stringValue(asRecord(record.pendingAction).confirmUrl) || stringValue(record.confirmUrl);
  const url = candidate ? candidate.trim() : "";
  if (!url || !/^https?:\/\//i.test(url) || message.includes(url)) {
    return message;
  }
  const label = code === "DEVICE_ACCESS_REQUIRED" ? "打开 V5 设备授权页" : "打开 V5 确认页";
  return `${message} [${label}](${url})`;
}

function isV5Result(value: unknown): value is V5Result {
  const record = asRecord(value);
  return Object.prototype.hasOwnProperty.call(record, "code")
    && (Object.prototype.hasOwnProperty.call(record, "data") || Object.prototype.hasOwnProperty.call(record, "msg"));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
