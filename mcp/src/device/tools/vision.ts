import type { JsonObject, McpToolDefinition, ToolContext } from "../../core/types.js";
import {
  arrayValue,
  asRecord,
  parseMaybeJson
} from "../../core/v5Client.js";
import {
  ALL_RESPONSE_KEYS,
  DEVICE_ID_PROPERTY,
  createTool,
  executeCanonicalTool,
  fail,
  guardedHandler,
  objectSchema,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  responseOptionsSchema
} from "./common.js";
import { OPERATION_NODE_DEFAULTS, appendLayoutView } from "./layoutView.js";

export function visionTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "device_find_node",
      "在设备当前页面查找节点（操作口径）。默认只返回可用节点（usableOnly=true：enabled 且可点击/长按/滚动/勾选/可输入，或带 text/desc 的可读节点）、可见节点（visibleOnly=true），按文本/ID/描述/类名过滤，且不限数量（limit=0 返回全部匹配节点，不截断）。默认只读当前活跃窗口，跨窗口查找时传 layoutRange=all。需要完整布局结构（全部窗口、全部节点、含空容器与屏外节点）时改用 device_layout_dump。",
      nodeToolSchema(),
      async args => submitLayoutSearch(ctx, "device_find_node", args)
    ),
    createTool(
      "device_click_node",
      "device_find_node 的查找别名，不会自动点击：返回可用节点及其 center，由 AI 确认后再调 device_tap。autoClickFirst=true 会被拒绝。需要完整布局结构时改用 device_layout_dump。",
      nodeToolSchema({
        autoClickFirst: { type: "boolean", description: "是否在脚本中点击第一个匹配节点。", default: false },
        confirmAutoClick: { type: "boolean", description: "autoClickFirst=true 时必须显式为 true。" }
      }),
      async args => {
        if (optionalBoolean(args, "autoClickFirst", false)) {
          return {
            ok: false,
            code: "FULL_AUTO_DENIED",
            message: "device_click_node 不再直接拼脚本点击节点；请先调用 device_find_node 读取节点中心点，再调用 canonical device_tap。",
            data: {
              canonicalNextTool: "device.control.tap",
              mcpNextTool: "device_tap"
            }
          };
        }
        return submitLayoutSearch(ctx, "device_click_node", args);
      }
    ),
    createTool(
      "device_tap_target",
      "统一纯图色入口：制作并验证图片/色组素材，按素材 ID 或 OCR 文字点击目标，或执行最多 20 个连续点击步骤。素材固定保存在设备本机，只有 verified 且包名、版本、分辨率、SHA-256 全部匹配时才允许点击；缺失、过期或命中歧义一律失败停机。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        operation: {
          type: "string",
          enum: ["CREATE_IMAGE", "CREATE_COLOR_GROUP", "TAP_IMAGE", "TAP_COLOR_GROUP", "TAP_TEXT", "RUN_SEQUENCE", "SET_STATUS"],
          description: "图色操作类型。"
        },
        name: { type: "string", description: "素材名称；创建、取用或变更状态时使用。" },
        text: { type: "string", description: "OCR 目标文字，最多 500 字符。" },
        region: visionRegionSchema("截图区域；创建图片时必填。"),
        threshold: { type: "number", description: "图片相似度范围 (0,1]，色组颜色阈值范围 [0,255]；TAP_TEXT 不接受。" },
        status: { type: "string", enum: ["candidate", "verified", "deprecated"], description: "SET_STATUS 的目标状态。" },
        points: {
          type: "array",
          minItems: 2,
          maxItems: 20,
          description: "CREATE_COLOR_GROUP 的 2-20 个取色点。",
          items: objectSchema({
            x: { type: "number", description: "屏幕 X 坐标。" },
            y: { type: "number", description: "屏幕 Y 坐标。" },
            color: { type: "string", description: "可选颜色值；省略时从当前截图取色。" }
          }, ["x", "y"])
        },
        steps: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          description: "RUN_SEQUENCE 的连续点击步骤，禁止嵌套 RUN_SEQUENCE。",
          items: visionStepSchema()
        },
        ocrEngine: { type: "string", description: "可选 OCR 引擎名称。" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "operation"]),
      async args => {
        const deviceId = requireString(args, "deviceId");
        const normalized = normalizeVisionTapTargetArgs(args);
        if (!normalized.ok) {
          return fail("INVALID_ARGUMENT", normalized.message, { argument: normalized.argument });
        }
        return executeCanonicalTool(
          ctx,
          "device_tap_target",
          args,
          "device.vision.tapTarget",
          normalized.params,
          { operation: true, deviceId, waitForTask: args.waitForResult !== false }
        );
      }
    )
  ];
}

const VISION_OPERATIONS = new Set([
  "CREATE_IMAGE",
  "CREATE_COLOR_GROUP",
  "TAP_IMAGE",
  "TAP_COLOR_GROUP",
  "TAP_TEXT",
  "RUN_SEQUENCE",
  "SET_STATUS"
]);

const VISION_INPUT_KEYS = new Set([
  "deviceId",
  "operation",
  "name",
  "text",
  "region",
  "threshold",
  "status",
  "points",
  "steps",
  "ocrEngine",
  "waitForResult",
  "timeoutMs",
  "includeLogs",
  ...ALL_RESPONSE_KEYS
]);

type VisionNormalizationResult =
  | { ok: true; params: JsonObject }
  | { ok: false; message: string; argument?: string };

function visionRegionSchema(description: string): JsonObject {
  return {
    ...objectSchema({
      x: { type: "number", description: "区域左上角 X 坐标。" },
      y: { type: "number", description: "区域左上角 Y 坐标。" },
      width: { type: "number", description: "区域宽度，必须大于 0。" },
      height: { type: "number", description: "区域高度，必须大于 0。" }
    }, ["x", "y", "width", "height"]),
    description
  };
}

function visionStepSchema(): JsonObject {
  return {
    ...objectSchema({
      operation: { type: "string", enum: ["TAP_IMAGE", "TAP_COLOR_GROUP", "TAP_TEXT"] },
      name: { type: "string", description: "图片或色组素材名称。" },
      text: { type: "string", description: "OCR 目标文字。" },
      region: visionRegionSchema("可选截图区域。"),
      threshold: { type: "number", description: "图片或色组阈值；TAP_TEXT 不接受。" },
      ocrEngine: { type: "string", description: "可选 OCR 引擎名称。" }
    }, ["operation"]),
    description: "单个点击步骤。"
  };
}

function normalizeVisionTapTargetArgs(args: JsonObject): VisionNormalizationResult {
  try {
    for (const key of Object.keys(args)) {
      if (!VISION_INPUT_KEYS.has(key)) {
        throw visionArgumentError(key, `不接受参数: ${key}`);
      }
    }
    const deviceId = requireVisionString(args.deviceId, "deviceId", 1, 200);
    const operation = requireVisionString(args.operation, "operation", 1, 40).toUpperCase();
    if (!VISION_OPERATIONS.has(operation)) {
      throw visionArgumentError("operation", `不支持的图色操作: ${operation}`);
    }
    const params: JsonObject = { deviceId, operation };
    if (operation === "CREATE_IMAGE") {
      rejectVisionFields(args, ["name", "region", "threshold"], operation);
      params.name = normalizeVisionName(args.name);
      params.region = normalizeVisionRegion(args.region, "region");
      putVisionThreshold(params, args.threshold, operation);
    } else if (operation === "CREATE_COLOR_GROUP") {
      rejectVisionFields(args, ["name", "points", "threshold"], operation);
      params.name = normalizeVisionName(args.name);
      params.points = normalizeVisionPoints(args.points);
      putVisionThreshold(params, args.threshold, operation);
    } else if (operation === "TAP_IMAGE" || operation === "TAP_COLOR_GROUP") {
      rejectVisionFields(args, ["name", "region", "threshold"], operation);
      params.name = normalizeVisionName(args.name);
      putOptionalVisionRegion(params, args.region);
      putVisionThreshold(params, args.threshold, operation);
    } else if (operation === "TAP_TEXT") {
      rejectVisionFields(args, ["text", "region", "ocrEngine"], operation);
      params.text = requireVisionString(args.text, "text", 1, 500);
      putOptionalVisionRegion(params, args.region);
      putOptionalVisionString(params, "ocrEngine", args.ocrEngine, 100);
    } else if (operation === "RUN_SEQUENCE") {
      rejectVisionFields(args, ["steps"], operation);
      params.steps = normalizeVisionSteps(args.steps);
    } else {
      rejectVisionFields(args, ["name", "status"], operation);
      params.name = normalizeVisionName(args.name);
      const status = requireVisionString(args.status, "status", 1, 20).toLowerCase();
      if (!["candidate", "verified", "deprecated"].includes(status)) {
        throw visionArgumentError("status", "status 必须是 candidate、verified 或 deprecated");
      }
      params.status = status;
    }
    return { ok: true, params };
  } catch (error) {
    if (error instanceof VisionArgumentError) {
      return { ok: false, message: error.message, argument: error.argument };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

class VisionArgumentError extends Error {
  constructor(public readonly argument: string, message: string) {
    super(message);
    this.name = "VisionArgumentError";
  }
}

function visionArgumentError(argument: string, message: string): VisionArgumentError {
  return new VisionArgumentError(argument, message);
}

function rejectVisionFields(args: JsonObject, allowed: string[], operation: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (VISION_INPUT_KEYS.has(key) && !isVisionEnvelopeKey(key) && !allowedKeys.has(key)) {
      throw visionArgumentError(key, `operation=${operation} 不接受参数: ${key}`);
    }
  }
}

function isVisionEnvelopeKey(key: string): boolean {
  return key === "deviceId"
    || key === "operation"
    || key === "waitForResult"
    || key === "timeoutMs"
    || key === "includeLogs"
    || (ALL_RESPONSE_KEYS as readonly string[]).includes(key);
}

function normalizeVisionName(value: unknown): string {
  const name = requireVisionString(value, "name", 1, 80);
  if (name === "." || name === ".." || /[\\/\u0000-\u001f]/.test(name)) {
    throw visionArgumentError("name", "name 不能包含路径分隔符或控制字符");
  }
  return name;
}

function normalizeVisionRegion(value: unknown, key: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw visionArgumentError(key, `${key} 必须是 {x,y,width,height} 对象`);
  }
  const source = value as JsonObject;
  const allowed = new Set(["x", "y", "width", "height"]);
  for (const field of Object.keys(source)) {
    if (!allowed.has(field)) {
      throw visionArgumentError(`${key}.${field}`, `${key} 不接受字段: ${field}`);
    }
  }
  const x = visionInteger(source.x, `${key}.x`, 0, 100000);
  const y = visionInteger(source.y, `${key}.y`, 0, 100000);
  const width = visionInteger(source.width, `${key}.width`, 1, 100000);
  const height = visionInteger(source.height, `${key}.height`, 1, 100000);
  return { x, y, width, height };
}

function putOptionalVisionRegion(params: JsonObject, value: unknown): void {
  if (value !== undefined && value !== null) {
    params.region = normalizeVisionRegion(value, "region");
  }
}

function putVisionThreshold(params: JsonObject, value: unknown, operation: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 255) {
    throw visionArgumentError("threshold", "threshold 必须是 0-255 之间的数字");
  }
  if ((operation === "CREATE_IMAGE" || operation === "TAP_IMAGE") && (value <= 0 || value > 1)) {
    throw visionArgumentError("threshold", "图片 threshold 必须大于 0 且不超过 1");
  }
  params.threshold = value;
}

function normalizeVisionPoints(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 20) {
    throw visionArgumentError("points", "points 必须包含 2-20 个取色点");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw visionArgumentError(`points[${index}]`, `points[${index}] 必须是 {x,y,color?} 对象`);
    }
    const source = item as JsonObject;
    for (const field of Object.keys(source)) {
      if (!["x", "y", "color"].includes(field)) {
        throw visionArgumentError(`points[${index}].${field}`, `points[${index}] 不接受字段: ${field}`);
      }
    }
    const x = visionInteger(source.x, `points[${index}].x`, 0, 100000);
    const y = visionInteger(source.y, `points[${index}].y`, 0, 100000);
    const location = `${x},${y}`;
    if (seen.has(location)) {
      throw visionArgumentError(`points[${index}]`, `points 不能包含重复坐标: ${location}`);
    }
    seen.add(location);
    const point: JsonObject = { x, y };
    if (source.color !== undefined && source.color !== null) {
      point.color = requireVisionString(source.color, `points[${index}].color`, 1, 32);
    }
    return point;
  });
}

function normalizeVisionSteps(value: unknown): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw visionArgumentError("steps", "steps 必须包含 1-20 个点击步骤");
  }
  return value.map((item, index) => normalizeVisionStep(item, index));
}

function normalizeVisionStep(value: unknown, index: number): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw visionArgumentError(`steps[${index}]`, `steps[${index}] 必须是对象`);
  }
  const source = value as JsonObject;
  const operation = requireVisionString(source.operation, `steps[${index}].operation`, 1, 40).toUpperCase();
  if (!["TAP_IMAGE", "TAP_COLOR_GROUP", "TAP_TEXT"].includes(operation)) {
    throw visionArgumentError(`steps[${index}].operation`, `steps[${index}] 只允许 TAP_IMAGE、TAP_COLOR_GROUP 或 TAP_TEXT`);
  }
  const allowed = operation === "TAP_TEXT"
    ? new Set(["operation", "text", "region", "ocrEngine"])
    : new Set(["operation", "name", "region", "threshold"]);
  for (const field of Object.keys(source)) {
    if (!allowed.has(field)) {
      throw visionArgumentError(`steps[${index}].${field}`, `steps[${index}] 不接受字段: ${field}`);
    }
  }
  const step: JsonObject = { operation };
  if (operation === "TAP_TEXT") {
    step.text = requireVisionString(source.text, `steps[${index}].text`, 1, 500);
    putOptionalVisionString(step, "ocrEngine", source.ocrEngine, 100, `steps[${index}].ocrEngine`);
  } else {
    step.name = normalizeVisionNameForStep(source.name, index);
    putVisionThreshold(step, source.threshold, operation);
  }
  putOptionalVisionRegion(step, source.region);
  return step;
}

function normalizeVisionNameForStep(value: unknown, index: number): string {
  try {
    return normalizeVisionName(value);
  } catch (error) {
    if (error instanceof VisionArgumentError) {
      throw visionArgumentError(`steps[${index}].${error.argument}`, error.message);
    }
    throw error;
  }
}

function putOptionalVisionString(
  params: JsonObject,
  key: string,
  value: unknown,
  maxLength: number,
  argument = key
): void {
  if (value !== undefined && value !== null) {
    params[key] = requireVisionString(value, argument, 1, maxLength);
  }
}

function requireVisionString(value: unknown, key: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") {
    throw visionArgumentError(key, `${key} 必须是非空字符串`);
  }
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength) {
    throw visionArgumentError(key, `${key} 长度必须为 ${minLength}-${maxLength}`);
  }
  return text;
}

function visionInteger(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw visionArgumentError(key, `${key} 必须是 ${min}-${max} 的整数`);
  }
  return value;
}

function nodeToolSchema(extra: JsonObject = {}): JsonObject {
  return objectSchema({
    deviceId: DEVICE_ID_PROPERTY,
    text: { type: "string", description: "精确匹配节点文本。" },
    textContains: { type: "string", description: "按子串匹配节点文本。" },
    id: { type: "string", description: "按子串匹配节点 ID。" },
    desc: { type: "string", description: "按子串匹配 contentDescription。" },
    className: { type: "string", description: "按子串匹配类名。" },
    limit: {
      type: "number",
      description: "最多返回节点数量。0 或不传表示不限制，返回全部匹配节点。",
      default: 0
    },
    layoutRange: {
      type: "string",
      enum: ["active", "all"],
      description: "节点采集范围：active=仅当前活跃窗口（默认，操作口径），all=全部窗口。设备处于高级权限（uiautomator dump）通道时该参数不生效。",
      default: "active"
    },
    usableOnly: {
      type: "boolean",
      description: "只返回可用节点：enabled 且（可点击/长按/滚动/勾选/可输入，或带 text/desc 作为可读锚点）。默认 true，用来丢掉空容器等噪声；要连空容器、屏外节点一起看，请改用 device_layout_dump 的结构分析口径。",
      default: true
    },
    visibleOnly: {
      type: "boolean",
      description: "只返回具备有效可见边界的节点（排除零面积、屏外节点）。默认 true。",
      default: true
    },
    clickableOnly: {
      type: "boolean",
      description: "只保留 clickable=true 的节点。默认 false。",
      default: false
    },
    textOnly: {
      type: "boolean",
      description: "只保留带 text 或 desc 的节点。默认 false。",
      default: false
    },
    dedupe: {
      type: "boolean",
      description: "按 文本+描述+ID+类名+bounds 去重。默认 true。",
      default: true
    },
    fields: {
      type: "string",
      description: "逗号分隔的返回字段，默认 text,desc,id,className,clickable,scrollable,bounds,center。"
    },
    outputFormat: {
      type: "string",
      enum: ["json", "compact", "lines"],
      description: "返回格式。默认 json；命中很多时可改用 compact 或 lines 省体积。",
      default: "json"
    },
    includeRecognitionResults: {
      type: "boolean",
      description: "是否附带统一识别结果（sourceType/confidence/bounds/center）。默认 false。",
      default: false
    },
    includeTaskMeta: {
      type: "boolean",
      description: "是否附带完整任务元数据。默认 false。",
      default: false
    },
    waitForResult: { type: "boolean", default: true },
    timeoutMs: { type: "number" },
    includeLogs: { type: "boolean", default: false },
    ...responseOptionsSchema(),
    ...extra
  }, ["deviceId"]);
}

async function submitLayoutSearch(ctx: ToolContext, toolName: string, args: JsonObject) {
  const limit = optionalNumber(args, "limit", 0) ?? 0;
  const scanLimit = limit > 0 ? Math.max(limit, 500) : 0;
  const result = await guardedToolTask(ctx, toolName, args, "device.layout.read", {
    limit: scanLimit,
    layoutRange: optionalString(args, "layoutRange") || "active",
    includePreview: false
  });
  if (!result.ok || !result.data) {
    return result;
  }
  return appendFilteredNodes(result, args);
}

async function guardedToolTask(
  ctx: ToolContext,
  toolName: string,
  args: JsonObject,
  canonicalToolName: string,
  body: JsonObject
) {
  const deviceId = requireString(args, "deviceId");
  return guardedHandler(ctx, toolName, args, { operation: false, deviceId }, async () => {
    const result = await executeCanonicalTool(ctx, toolName, args, canonicalToolName, {
      deviceId,
      ...body
    }, {
      operation: false,
      waitForTask: args.waitForResult !== false,
      shapeOptions: { deferResponseShaping: true }
    });
    // 调用方还要从 raw.resultPayload 里投影节点时，整形必须后置：
    // find_node 需要先读取原始 payload，再按传入过滤条件投影节点。
    return result;
  });
}

function appendFilteredNodes(result: { ok: boolean; code: string; message: string; data?: unknown }, args: JsonObject) {
  const data = asRecord(result.data);
  const raw = asRecord(data.raw);
  const payload = asRecord(parseMaybeJson(raw.resultPayload));
  const nodes = arrayValue(payload.nodes);
  const limit = optionalNumber(args, "limit", 0) ?? 0;
  const matches = nodes.filter(node => matchesNode(asRecord(node), args));
  const limitedMatches = limit > 0 ? matches.slice(0, limit) : matches;
  return appendLayoutView(
    {
      ...result,
      data: {
        ...data,
        matchedCount: limitedMatches.length,
        filter: {
          text: optionalString(args, "text"),
          textContains: optionalString(args, "textContains"),
          id: optionalString(args, "id"),
          desc: optionalString(args, "desc"),
          className: optionalString(args, "className")
        }
      }
    },
    args,
    {
      sourceType: "device_find_node",
      filter: node => matchesNode(node, args),
      defaults: OPERATION_NODE_DEFAULTS
    }
  );
}

function matchesNode(node: Record<string, unknown>, args: JsonObject): boolean {
  const filters = [
    ["text", optionalString(args, "text"), "equals"],
    ["text", optionalString(args, "textContains"), "contains"],
    ["id", optionalString(args, "id"), "contains"],
    ["desc", optionalString(args, "desc"), "contains"],
    ["className", optionalString(args, "className"), "contains"]
  ] as const;
  const activeFilters = filters.filter(([, value]) => value);
  if (!activeFilters.length) {
    return true;
  }
  return activeFilters.every(([field, value, mode]) => {
    const actual = String(node[field] ?? node[`${field}Name`] ?? "");
    if (!value) return true;
    return mode === "equals" ? actual === value : actual.includes(value);
  });
}
