import {
  isSecretKey,
  maskValue,
  readUserConfig,
  resolveUserStateDir,
  type UserConfigSnapshot
} from "./configFile.js";

export type McpTransportMode = "stdio" | "http" | "both";

export interface AppConfig {
  transportMode: McpTransportMode;
  v5BaseUrl: string;
  v5PublicUrl: string;
  v5AuthToken: string;
  mcpClientId: string;
  httpHost: string;
  httpPort: number;
  httpPath: string;
  httpAuthToken: string;
  httpJsonResponse: boolean;
  httpSessionIdleMs: number;
  readOnly: boolean;
  enableDangerousActions: boolean;
  useDirectControl: boolean;
  enableDeviceLock: boolean;
  /** 作者工具（教程录制）MCP 工具是否启用；默认关闭，用 HZ_MCP_ENABLE_TUTORIAL_TOOLS=true 打开。 */
  enableTutorialTools: boolean;
  /** 普通 V5 HTTP 请求（JSON 接口）单次超时；上传类请求不受该上限约束。 */
  requestTimeoutMs: number;
  /** 上传类请求（整文件或单个分片）的单次超时，独立预算，不套用普通请求的 120 秒上限。 */
  uploadRequestTimeoutMs: number;
  /** 分片上传的单片字节数。 */
  uploadChunkBytes: number;
  /** 超过该字节数的文件改用分片/断点续传上传。 */
  uploadResumableThresholdBytes: number;
  /** 单个分片上传失败后的最大重试次数。 */
  uploadRetryCount: number;
  taskWaitTimeoutMs: number;
  taskPollIntervalMs: number;
  auditLogPath: string;
  stateDir: string;
  /** 是否允许就地向 MCP 客户端发起确认；关闭后一律走 V5 兜底确认页。 */
  enableElicitation: boolean;
  /**
   * 低于该耗时的 decline 没有经过用户（例如 Desktop 选择"完全访问"时客户端直接短路），
   * 按客户端预授权处理：自动向 V5 确认执行，而不是当成拒绝。
   */
  elicitationAutoDeclineMs: number;
  /**
   * 客户端在阈值内短路拒绝（用户没看到确认框）时是否按预授权自动通过。
   * 关闭后这类动作退回 V5 兜底确认页，保持人工确认。
   */
  autoApproveOnClientPreauthorization: boolean;
}

export type ConfigValueSource = "env" | "config-file" | "default";

export interface ConfigKeyReport {
  key: string;
  source: ConfigValueSource;
  value: string;
  secret: boolean;
}

export interface ConfigLoadResult {
  config: AppConfig;
  userConfig: UserConfigSnapshot;
  keys: ConfigKeyReport[];
  unknownKeys: string[];
}

/** 全部受支持的配置键，用于来源报告与未知键告警。 */
export const CONFIG_KEYS: readonly string[] = [
  "HZ_MCP_TRANSPORT",
  "HZ_V5_BASE_URL",
  "HZ_V5_PUBLIC_URL",
  "HZ_V5_AUTH_TOKEN",
  "HZ_MCP_CLIENT_ID",
  "HZ_MCP_HTTP_HOST",
  "HZ_MCP_HTTP_PORT",
  "HZ_MCP_HTTP_PATH",
  "HZ_MCP_HTTP_AUTH_TOKEN",
  "HZ_MCP_HTTP_JSON_RESPONSE",
  "HZ_MCP_HTTP_SESSION_IDLE_MS",
  "HZ_MCP_READ_ONLY",
  "HZ_MCP_ENABLE_DANGEROUS_ACTIONS",
  "HZ_MCP_USE_DIRECT_CONTROL",
  "HZ_MCP_ENABLE_DEVICE_LOCK",
  "HZ_MCP_ENABLE_TUTORIAL_TOOLS",
  "HZ_MCP_REQUEST_TIMEOUT_MS",
  "HZ_MCP_UPLOAD_REQUEST_TIMEOUT_MS",
  "HZ_MCP_UPLOAD_CHUNK_BYTES",
  "HZ_MCP_UPLOAD_RESUMABLE_THRESHOLD_BYTES",
  "HZ_MCP_UPLOAD_RETRY_COUNT",
  "HZ_MCP_TASK_WAIT_TIMEOUT_MS",
  "HZ_MCP_TASK_POLL_INTERVAL_MS",
  "HZ_MCP_ENABLE_ELICITATION",
  "HZ_MCP_ELICITATION_AUTO_DECLINE_MS",
  "HZ_MCP_AUTO_APPROVE_ON_PREAUTHORIZATION",
  "HZ_MCP_AUDIT_LOG_PATH",
  "HZ_MCP_STATE_DIR"
];

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim() || "http://127.0.0.1:9999";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeOptionalBaseUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function normalizeTransportMode(value: string): McpTransportMode {
  const mode = value.trim().toLowerCase();
  if (mode === "stdio" || mode === "http" || mode === "both") {
    return mode;
  }
  throw new Error(`HZ_MCP_TRANSPORT 只支持 stdio、http 或 both，当前值: ${value}`);
}

function normalizeHttpPath(value: string): string {
  const path = value.trim() || "/mcp";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.length > 1 && normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function isEnabled(raw: string): boolean {
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * 配置取值优先级（没有第二套说法）：
 *   1. 进程环境变量（客户端 .mcp.json 的 env、CI、命令行）；
 *   2. 用户级 config.env（路径见 configFile.ts 的 resolveUserConfigPath）；
 *   3. 代码内置默认值。
 * 空字符串一律视为"未设置"，继续往下一层找。
 */
export function loadConfigWithMeta(env: NodeJS.ProcessEnv = process.env): ConfigLoadResult {
  const userConfig = readUserConfig(env);
  const keys: ConfigKeyReport[] = [];
  const report = (key: string, source: ConfigValueSource, value: string): void => {
    keys.push({ key, source, value, secret: isSecretKey(key) });
  };
  const pick = (key: string): { raw?: string; source: ConfigValueSource } => {
    const fromEnv = env[key];
    if (fromEnv !== undefined && fromEnv.trim() !== "") {
      return { raw: fromEnv.trim(), source: "env" };
    }
    const fromFile = userConfig.values[key];
    if (fromFile !== undefined && fromFile.trim() !== "") {
      return { raw: fromFile.trim(), source: "config-file" };
    }
    return { source: "default" };
  };
  const text = (key: string, fallback = ""): string => {
    const layer = pick(key);
    const value = layer.raw ?? fallback;
    report(key, layer.source, value);
    return value;
  };
  const boolean = (key: string, fallback: boolean): boolean => {
    const layer = pick(key);
    const value = layer.raw === undefined ? fallback : isEnabled(layer.raw);
    report(key, layer.source, String(value));
    return value;
  };
  const warn = (message: string): void => {
    process.stderr.write(`[hz-autojs-mcp] 配置提示: ${message}\n`);
  };
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const layer = pick(key);
    let value = fallback;
    if (layer.raw !== undefined) {
      const parsed = Number.parseInt(layer.raw, 10);
      if (!Number.isFinite(parsed)) {
        warn(`${key} 不是合法整数（${layer.raw}），按默认值 ${fallback} 生效`);
      } else {
        const clamped = Math.min(Math.max(parsed, min), max);
        if (clamped !== parsed) {
          // 显式配置越界不再静默：写 stderr 提示实际生效值，便于排查“配了没生效”。
          warn(`${key} 配置值 ${parsed} 超出允许区间 [${min}, ${max}]，按 ${clamped} 生效`);
        }
        value = clamped;
      }
    }
    report(key, layer.source, String(value));
    return value;
  };

  const config: AppConfig = {
    transportMode: normalizeTransportMode(text("HZ_MCP_TRANSPORT", "stdio")),
    v5BaseUrl: normalizeBaseUrl(text("HZ_V5_BASE_URL", "http://127.0.0.1:9999")),
    v5PublicUrl: normalizeOptionalBaseUrl(text("HZ_V5_PUBLIC_URL")),
    v5AuthToken: text("HZ_V5_AUTH_TOKEN"),
    mcpClientId: text("HZ_MCP_CLIENT_ID", "hz-autojs-device-mcp"),
    httpHost: text("HZ_MCP_HTTP_HOST", "127.0.0.1"),
    httpPort: integer("HZ_MCP_HTTP_PORT", 3333, 1, 65535),
    httpPath: normalizeHttpPath(text("HZ_MCP_HTTP_PATH", "/mcp")),
    httpAuthToken: text("HZ_MCP_HTTP_AUTH_TOKEN"),
    httpJsonResponse: boolean("HZ_MCP_HTTP_JSON_RESPONSE", false),
    httpSessionIdleMs: integer("HZ_MCP_HTTP_SESSION_IDLE_MS", 1800000, 60000, 86400000),
    readOnly: boolean("HZ_MCP_READ_ONLY", false),
    enableDangerousActions: boolean("HZ_MCP_ENABLE_DANGEROUS_ACTIONS", true),
    useDirectControl: boolean("HZ_MCP_USE_DIRECT_CONTROL", false),
    enableDeviceLock: boolean("HZ_MCP_ENABLE_DEVICE_LOCK", true),
    enableTutorialTools: boolean("HZ_MCP_ENABLE_TUTORIAL_TOOLS", false),
    requestTimeoutMs: integer("HZ_MCP_REQUEST_TIMEOUT_MS", 15000, 1000, 120000),
    uploadRequestTimeoutMs: integer("HZ_MCP_UPLOAD_REQUEST_TIMEOUT_MS", 600000, 5000, 3600000),
    uploadChunkBytes: integer("HZ_MCP_UPLOAD_CHUNK_BYTES", 8388608, 1048576, 33554432),
    uploadResumableThresholdBytes: integer("HZ_MCP_UPLOAD_RESUMABLE_THRESHOLD_BYTES", 16777216, 1048576, 1073741824),
    uploadRetryCount: integer("HZ_MCP_UPLOAD_RETRY_COUNT", 3, 0, 10),
    taskWaitTimeoutMs: integer("HZ_MCP_TASK_WAIT_TIMEOUT_MS", 30000, 1000, 600000),
    taskPollIntervalMs: integer("HZ_MCP_TASK_POLL_INTERVAL_MS", 1000, 200, 10000),
    auditLogPath: text("HZ_MCP_AUDIT_LOG_PATH"),
    stateDir: text("HZ_MCP_STATE_DIR", resolveUserStateDir(env)),
    enableElicitation: boolean("HZ_MCP_ENABLE_ELICITATION", true),
    elicitationAutoDeclineMs: integer("HZ_MCP_ELICITATION_AUTO_DECLINE_MS", 1000, 0, 60000),
    autoApproveOnClientPreauthorization: boolean("HZ_MCP_AUTO_APPROVE_ON_PREAUTHORIZATION", true)
  };

  const unknownKeys = Object.keys(userConfig.values).filter(key => !CONFIG_KEYS.includes(key));
  return { config, userConfig, keys: keys.sort((a, b) => a.key.localeCompare(b.key)), unknownKeys };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return loadConfigWithMeta(env).config;
}

export interface ConfigDescribeResult {
  userConfig: {
    path: string;
    overridden: boolean;
    status: UserConfigSnapshot["status"];
    detail: string;
  };
  keys: Array<{ key: string; source: ConfigValueSource; value: string; secret: boolean }>;
  unknownKeys: string[];
}

/** 给 mcp-config.mjs show 用的脱敏快照：值 + 每个键的来源。 */
export function describeConfig(env: NodeJS.ProcessEnv = process.env): ConfigDescribeResult {
  const result = loadConfigWithMeta(env);
  return {
    userConfig: {
      path: result.userConfig.path,
      overridden: result.userConfig.overridden,
      status: result.userConfig.status,
      detail: result.userConfig.detail
    },
    keys: result.keys.map(entry => ({
      key: entry.key,
      source: entry.source,
      value: maskValue(entry.key, entry.value),
      secret: entry.secret
    })),
    unknownKeys: result.unknownKeys
  };
}