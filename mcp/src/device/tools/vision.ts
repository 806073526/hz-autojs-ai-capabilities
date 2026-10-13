import type { JsonObject, McpToolDefinition, ToolContext } from "../../core/types.js";
import {
  arrayValue,
  asRecord,
  parseMaybeJson
} from "../../core/v5Client.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  executeCanonicalTool,
  guardedHandler,
  objectSchema,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  requireString,
  shapeTaskOutcome,
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
      "device_find_text",
      "通过 OCR 或布局辅助寻找文本。默认走 OCR 工具任务。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        text: { type: "string", description: "目标文字。" },
        sourcePath: { type: "string" },
        ocrEngine: { type: "string" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "text"]),
      async args => guardedToolTask(ctx, "device_find_text", args, "device.vision.ocr", {
        context: requireString(args, "text"),
        sourcePath: optionalString(args, "sourcePath"),
        ocrEngine: optionalString(args, "ocrEngine"),
        includePreview: false
      })
    ),
    createTool(
      "device_image_match",
      "下发 V5 图像匹配任务，支持 findImage、matchTemplate、multiColor、featureMatch。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        matchType: { type: "string", enum: ["findImage", "matchTemplate", "multiColor", "featureMatch"] },
        sourcePath: { type: "string" },
        targetPath: { type: "string" },
        positionList: { type: "string" },
        imgThreshold: { type: "number" },
        colorThreshold: { type: "number" },
        maxMatches: { type: "number" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "matchType"]),
      async args => guardedToolTask(ctx, "device_image_match", args, "device.vision.imageMatch", {
        matchType: optionalString(args, "matchType"),
        sourcePath: optionalString(args, "sourcePath"),
        targetPath: optionalString(args, "targetPath"),
        positionList: optionalString(args, "positionList"),
        imgThreshold: optionalNumber(args, "imgThreshold"),
        colorThreshold: optionalNumber(args, "colorThreshold"),
        maxMatches: optionalNumber(args, "maxMatches"),
        includePreview: false
      })
    ),
    createTool(
      "device_color_pick",
      "下发 V5 图色处理任务，可结合 positionList 或区域参数取色/处理。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        sourcePath: { type: "string" },
        positionList: { type: "string" },
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId"]),
      async args => guardedToolTask(ctx, "device_color_pick", args, "device.vision.colorPick", {
        sourcePath: optionalString(args, "sourcePath"),
        positionList: optionalString(args, "positionList"),
        x1: optionalNumber(args, "x1"),
        y1: optionalNumber(args, "y1"),
        x2: optionalNumber(args, "x2"),
        y2: optionalNumber(args, "y2"),
        includePreview: false
      })
    ),
    createTool(
      "device_ocr",
      "下发 V5 OCR 识别任务。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        sourcePath: { type: "string" },
        x1: { type: "number", description: "识别区域左上角 X；与 y1/x2/y2 一起限定 OCR 区域。" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        context: { type: "string", description: "可选目标文字。" },
        ocrEngine: { type: "string" },
        ocrLanguage: { type: "string" },
        detectRotation: { type: "boolean", description: "是否检测旋转文字。" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId"]),
      async args => guardedToolTask(ctx, "device_ocr", args, "device.vision.ocr", {
        sourcePath: optionalString(args, "sourcePath"),
        x1: optionalNumber(args, "x1"),
        y1: optionalNumber(args, "y1"),
        x2: optionalNumber(args, "x2"),
        y2: optionalNumber(args, "y2"),
        context: optionalString(args, "context"),
        ocrEngine: optionalString(args, "ocrEngine"),
        ocrLanguage: optionalString(args, "ocrLanguage"),
        detectRotation: optionalBoolean(args, "detectRotation", false),
        includePreview: false
      })
    ),
    createTool(
      "page_match",
      "下发 V5 页面规则匹配任务。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        pageRule: { type: "object", description: "页面匹配规则 JSON。" },
        limit: { type: "number", default: 300 },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "pageRule"]),
      async args => guardedToolTask(ctx, "page_match", args, "device.page.match", {
        pageRule: optionalObject(args, "pageRule"),
        limit: optionalNumber(args, "limit", 300)
      })
    )
  ];
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
  }, { deferShaping: true });
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
  body: JsonObject,
  options: { includePayloadDefault?: boolean; deferShaping?: boolean } = {}
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
    // shapeTaskOutcome 默认会删掉 data.raw，先整形会让节点过滤拿到空表（find_node 全空就是这么来的）。
    if (options.deferShaping) {
      return result;
    }
    return appendRecognitionResults(result, toolName, args, options);
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

function appendRecognitionResults(
  result: { ok: boolean; code: string; message: string; data?: unknown },
  sourceType: string,
  args: JsonObject,
  options: { includePayloadDefault?: boolean } = {}
) {
  if (!result.data) {
    return result;
  }
  const data = asRecord(result.data);
  const raw = asRecord(data.raw);
  const payload = asRecord(parseMaybeJson(raw.resultPayload));
  const recognitionResults = normalizeRecognitionResults(payload, sourceType);
  const withRecognition = {
    ...result,
    data: {
      ...data,
      recognitionResults
    }
  };
  return shapeTaskOutcome(withRecognition, args, {
    includeRawDefault: false,
    includePayloadDefault: options.includePayloadDefault ?? false
  });
}

function normalizeRecognitionResults(payload: Record<string, unknown>, sourceType: string): unknown[] {
  const results: unknown[] = [];
  if (Array.isArray(payload.points)) {
    for (const point of payload.points) {
      const normalized = pointRecognition(asRecord(point), sourceType);
      if (normalized) results.push(normalized);
    }
  }
  const singlePoint = pointRecognition(asRecord(payload.point), sourceType);
  if (singlePoint && !results.some(item => JSON.stringify(item) === JSON.stringify(singlePoint))) {
    results.unshift(singlePoint);
  }
  const ocrItems = arrayValue(payload.matchedItems).length ? arrayValue(payload.matchedItems) : arrayValue(payload.items);
  for (const item of ocrItems) {
    const normalized = ocrRecognition(asRecord(item), sourceType);
    if (normalized) results.push(normalized);
  }
  if (Array.isArray(payload.colors)) {
    for (const item of payload.colors) {
      const normalized = colorRecognition(asRecord(item), sourceType);
      if (normalized) results.push(normalized);
    }
  }
  return results;
}

function nodeRecognition(node: Record<string, unknown>) {
  const bounds = asRecord(node.bounds);
  const left = toNumber(bounds.left);
  const top = toNumber(bounds.top);
  const right = toNumber(bounds.right);
  const bottom = toNumber(bounds.bottom);
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    return undefined;
  }
  return {
    sourceType: "layout",
    confidence: 1,
    text: stringOrUndefined(node.text),
    id: stringOrUndefined(node.id),
    desc: stringOrUndefined(node.desc),
    className: stringOrUndefined(node.className),
    bounds: { left, top, right, bottom },
    center: {
      x: Math.round((left + right) / 2),
      y: Math.round((top + bottom) / 2)
    },
    raw: node
  };
}

function pointRecognition(point: Record<string, unknown>, sourceType: string) {
  const x = toNumber(point.x);
  const y = toNumber(point.y);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return {
    sourceType,
    confidence: toNumber(point.confidence) ?? toNumber(point.similarity) ?? toNumber(point.score) ?? null,
    center: { x, y },
    raw: point
  };
}

function ocrRecognition(item: Record<string, unknown>, sourceType: string) {
  const bounds = asRecord(item.bounds);
  const left = toNumber(bounds.left);
  const top = toNumber(bounds.top);
  const right = toNumber(bounds.right);
  const bottom = toNumber(bounds.bottom);
  const hasBounds = left !== undefined && top !== undefined && right !== undefined && bottom !== undefined;
  const result = {
    sourceType,
    confidence: toNumber(item.confidence) ?? toNumber(item.score) ?? null,
    text: stringOrUndefined(item.text),
    bounds: hasBounds ? { left, top, right, bottom } : undefined,
    center: hasBounds
      ? { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) }
      : undefined,
    raw: item
  };
  return result.text || result.bounds ? result : undefined;
}

function colorRecognition(item: Record<string, unknown>, sourceType: string) {
  const x = toNumber(item.x);
  const y = toNumber(item.y);
  if (x === undefined || y === undefined) {
    return undefined;
  }
  return {
    sourceType,
    confidence: item.valid === false ? 0 : 1,
    center: { x, y },
    color: stringOrUndefined(item.color),
    raw: item
  };
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

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
