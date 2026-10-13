import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  executeCanonicalTool,
  objectSchema,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString
} from "../../device/tools/common.js";

/**
 * 项目 MCP 的设备文件原语。
 *
 * 全部桥接 V5 canonical tool；设备访问 token 与设备级 MCP grant 由 V5 统一判定，
 * 项目 MCP 不保存设备明文密码。
 */
export function deviceFileTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "device_file_list",
      "列出设备目录。默认最多返回前 40 项，超出时用 truncated/totalCount/nextOffset 提示继续翻页，避免整目录（可能上千项）一次性灌进上下文。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        path: { type: "string", description: "设备端目录路径。", default: "/sdcard" },
        offset: { type: "number", description: "起始下标，默认 0；配合 nextOffset 翻页。", default: 0 },
        limit: { type: "number", description: "最多返回条目数，默认 40，上限 500。", default: 200 },
        directoriesOnly: { type: "boolean", description: "只返回子目录，用于快速定位项目目录。", default: false },
        nameContains: { type: "string", description: "按名称子串过滤（不区分大小写）。" },
        deviceAccessToken: { type: "string", description: "设备访问 token；设备级 MCP grant 可替代。" }
      }, ["deviceId"]),
      async args => {
        const outcome = await executeCanonicalTool(ctx, "device_file_list", args, "file.device.list", {
          deviceId: requireString(args, "deviceId"),
          path: optionalString(args, "path") || "/sdcard",
          // 分页/过滤必须下发给 V5：设备根目录可达上千项，
          // 不分页会让 resultJson 超出 V5 的截断上限，返回无法解析的半截 JSON。
          offset: optionalNumber(args, "offset", 0),
          limit: optionalNumber(args, "limit", 40),
          directoriesOnly: optionalBoolean(args, "directoriesOnly", false),
          nameContains: optionalString(args, "nameContains"),
          deviceAccessToken: optionalString(args, "deviceAccessToken")
        }, { deviceId: requireString(args, "deviceId"), waitForTask: false });
        return compactDeviceFileList(outcome, args);
      }
    ),

    createTool(
      "device_file_read_text",
      "读取设备文本文件，供入口、配置和版本核对。单次最多返回 12000 字符；超出时 content 被截断，并回传 truncated/originalChars/maxChars 供判断是否还有未读内容。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        path: { type: "string", description: "设备端文本文件路径。" },
        encoding: { type: "string", default: "UTF-8" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "path"]),
      async args => executeCanonicalTool(ctx, "device_file_read_text", args, "file.device.readText", {
        deviceId: requireString(args, "deviceId"),
        path: requireString(args, "path"),
        encoding: optionalString(args, "encoding") || "UTF-8",
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "device_file_write_text",
      "写入单个设备文本文件。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        path: { type: "string", description: "设备端文本文件路径。" },
        content: { type: "string" },
        encoding: { type: "string", default: "UTF-8" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "path", "content"]),
      async args => executeCanonicalTool(ctx, "device_file_write_text", args, "file.device.writeText", {
        deviceId: requireString(args, "deviceId"),
        path: requireString(args, "path"),
        content: requireString(args, "content"),
        encoding: optionalString(args, "encoding") || "UTF-8",
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "device_file_push",
      "将 V5 文件库中的文件或目录下发到设备。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        fileId: { type: ["number", "string"], description: "V5 文件库文件 ID；雪花 ID 以字符串传更安全。" },
        sourcePath: { type: "string" },
        isPublic: { type: "boolean" },
        targetPath: { type: "string" },
        conflictPolicy: { type: "string" },
        includeSourceRoot: { type: "boolean" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId"]),
      async args => executeCanonicalTool(ctx, "device_file_push", args, "file.device.push", {
        deviceId: requireString(args, "deviceId"),
        fileId: args.fileId,
        sourcePath: optionalString(args, "sourcePath"),
        isPublic: optionalBoolean(args, "isPublic", false),
        targetPath: optionalString(args, "targetPath"),
        conflictPolicy: optionalString(args, "conflictPolicy"),
        includeSourceRoot: args.includeSourceRoot,
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "device_file_pull",
      "将设备文件或目录拉回 V5 文件库。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        path: { type: "string" },
        isPublic: { type: "boolean" },
        conflictPolicy: { type: "string" },
        targetDirectory: { type: "string" },
        directory: { type: "boolean" },
        preserveArchive: { type: "boolean" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "path"]),
      async args => executeCanonicalTool(ctx, "device_file_pull", args, "file.device.pull", {
        deviceId: requireString(args, "deviceId"),
        path: requireString(args, "path"),
        isPublic: optionalBoolean(args, "isPublic", false),
        conflictPolicy: optionalString(args, "conflictPolicy"),
        targetDirectory: optionalString(args, "targetDirectory"),
        directory: args.directory,
        preserveArchive: args.preserveArchive,
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "device_file_operation",
      "对设备执行建目录、删除、重命名、压缩、解压等操作。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        operation: { type: "string" },
        path: { type: "string" },
        targetPath: { type: "string" },
        content: { type: "string" },
        encoding: { type: "string" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "operation", "path"]),
      async args => executeCanonicalTool(ctx, "device_file_operation", args, "file.device.operation", {
        deviceId: requireString(args, "deviceId"),
        operation: requireString(args, "operation"),
        path: requireString(args, "path"),
        targetPath: optionalString(args, "targetPath"),
        content: optionalString(args, "content"),
        encoding: optionalString(args, "encoding"),
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: false })
    )
  ];
}


/**
 * 目录列表裁剪：默认只回前 N 项，附带翻页元数据。
 *
 * 设备根目录可能有上千项，全量返回会一次性占掉大量上下文；
 * 这里统一在 MCP 侧做分页与过滤，不改变 V5 的 file.device.list 契约。
 */
function compactDeviceFileList(outcome: { ok: boolean; code: string; message: string; data?: unknown }, args: { [key: string]: unknown }) {
  if (!outcome.ok || !outcome.data || typeof outcome.data !== "object" || Array.isArray(outcome.data)) {
    return outcome;
  }
  const data = { ...(outcome.data as Record<string, unknown>) };
  const payload = parsePayload(data);
  if (!payload || !Array.isArray(payload.entries)) {
    return outcome;
  }
  // V5 已按 offset/limit 分页并回传元数据时，直接透传，避免二次分页覆盖统计值。
  if (typeof payload.totalCount === "number" && typeof payload.truncated === "boolean") {
    return outcome;
  }
  const all = payload.entries.filter(item => item && typeof item === "object") as Record<string, unknown>[];
  const directoriesOnly = args.directoriesOnly === true;
  const nameFilter = typeof args.nameContains === "string" ? args.nameContains.trim().toLowerCase() : "";
  const filtered = all.filter(entry => {
    if (directoriesOnly && entry.directory !== true) return false;
    if (nameFilter && !String(entry.name ?? "").toLowerCase().includes(nameFilter)) return false;
    return true;
  });
  const limit = normalizeInt(args.limit, 200, 1, 1000);
  const offset = normalizeInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length < filtered.length ? offset + page.length : null;
  payload.entries = page;
  payload.totalCount = all.length;
  payload.filteredCount = filtered.length;
  payload.offset = offset;
  payload.limit = limit;
  payload.returnedCount = page.length;
  payload.truncated = nextOffset !== null;
  payload.nextOffset = nextOffset;
  if (nextOffset !== null) {
    payload.hint = `本页 ${page.length}/${filtered.length} 项，继续读取请传 offset=${nextOffset}`;
  }
  return { ...outcome, data: { ...data, ...payload, resultJson: JSON.stringify(payload) } };
}

function parsePayload(data: Record<string, unknown>): Record<string, unknown> | null {
  const raw = data.resultJson;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}