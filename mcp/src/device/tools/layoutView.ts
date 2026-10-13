import type { JsonObject, ToolOutcome } from "../../core/types.js";
import {
  arrayValue,
  asRecord,
  parseMaybeJson
} from "../../core/v5Client.js";
import {
  shapeTaskOutcome,
  optionalBoolean,
  optionalNumber,
  optionalString
} from "./common.js";

export interface LayoutViewDefaults {
  limit?: number;
  visibleOnly?: boolean;
  clickableOnly?: boolean;
  textOnly?: boolean;
  usableOnly?: boolean;
  dedupe?: boolean;
}

interface LayoutViewOptions {
  sourceType?: string;
  filter?: (node: Record<string, unknown>) => boolean;
  defaults?: LayoutViewDefaults;
}

/**
 * 操作场景默认口径：只给"可用"节点（enabled 且可点击/长按/滚动/勾选/可输入），
 * 可见性只用于过滤掉零面积、屏外的坏边界；数量不设上限（limit=0 表示不限）。
 */
export const OPERATION_NODE_DEFAULTS: LayoutViewDefaults = {
  limit: 0,
  visibleOnly: true,
  clickableOnly: false,
  textOnly: false,
  usableOnly: true,
  dedupe: true
};

/**
 * 结构分析场景默认口径：不做可用性、可见性、去重过滤，返回全部节点；数量不设上限。
 * 屏外节点保留（WebView 会把整个 DOM 都报出来，视口外的边界多为零面积或负数）。
 */
export const ANALYSIS_NODE_DEFAULTS: LayoutViewDefaults = {
  limit: 0,
  visibleOnly: false,
  clickableOnly: false,
  textOnly: false,
  usableOnly: false,
  dedupe: false
};

const DEFAULT_FIELDS = ["text", "desc", "id", "className", "clickable", "scrollable", "bounds", "center"];
const DEFAULT_ACTION_CANDIDATE_ZONES = ["topRight", "listRight", "cardRight", "rowRight"];

interface ResolvedViewOptions {
  limit: number;
  visibleOnly: boolean;
  clickableOnly: boolean;
  textOnly: boolean;
  usableOnly: boolean;
  dedupe: boolean;
}

function resolveViewOptions(args: JsonObject, defaults?: LayoutViewDefaults): ResolvedViewOptions {
  const merged: LayoutViewDefaults = { ...OPERATION_NODE_DEFAULTS, ...(defaults || {}) };
  return {
    limit: Math.max(0, Math.round(optionalNumber(args, "limit", merged.limit ?? 0) ?? 0)),
    visibleOnly: optionalBoolean(args, "visibleOnly", merged.visibleOnly ?? true),
    clickableOnly: optionalBoolean(args, "clickableOnly", merged.clickableOnly ?? false),
    textOnly: optionalBoolean(args, "textOnly", merged.textOnly ?? false),
    usableOnly: optionalBoolean(args, "usableOnly", merged.usableOnly ?? false),
    dedupe: optionalBoolean(args, "dedupe", merged.dedupe ?? true)
  };
}

export function appendLayoutView(result: ToolOutcome, args: JsonObject, options: LayoutViewOptions = {}): ToolOutcome {
  const data = asRecord(result.data);
  const raw = asRecord(data.raw);
  const payload = asRecord(parseMaybeJson(raw.resultPayload));
  const allNodes = arrayValue(payload.nodes).map(node => asRecord(node));
  const view = resolveViewOptions(args, options.defaults);
  const nodes = buildNodeView(allNodes, args, options);
  const shaped = shapeTaskOutcome(result, args, {
    includeRawDefault: false,
    includePayloadDefault: false
  });
  const includeRecognitionResults = optionalBoolean(args, "includeRecognitionResults", false);
  const includeTaskMeta = optionalBoolean(args, "includeTaskMeta", false);
  const includeActionCandidates = optionalBoolean(args, "includeActionCandidates", false);
  const candidateOnly = optionalBoolean(args, "candidateOnly", false);
  const outputFormat = normalizeOutputFormat(optionalString(args, "outputFormat"));
  const actionCandidates = includeActionCandidates || candidateOnly
    ? buildActionCandidates(allNodes, nodes, args, view)
    : [];
  const summary = {
    sourceType: options.sourceType || "layout",
    totalNodeCount: allNodes.length,
    returnedNodeCount: nodes.length,
    actionCandidateCount: actionCandidates.length,
    visibleOnly: view.visibleOnly,
    usableOnly: view.usableOnly,
    clickableOnly: view.clickableOnly,
    textOnly: view.textOnly,
    dedupe: view.dedupe,
    limit: view.limit,
    truncated: typeof payload.truncated === "boolean"
      ? payload.truncated
      : view.limit > 0 && nodes.length >= view.limit,
    fields: selectedFields(args),
    outputFormat
  };
  const shapedData = asRecord(shaped.data);
  const baseData: JsonObject = includeTaskMeta
    ? { ...shapedData }
    : pickTaskResultData(shapedData);
  const nodeOutput = formatNodes(nodes, outputFormat);
  const responseData: JsonObject = {
    ...baseData,
    layoutSummary: summary
  };
  if (!candidateOnly) {
    responseData.nodes = nodeOutput;
  }
  if (includeActionCandidates || candidateOnly) {
    responseData.actionCandidates = formatNodes(actionCandidates, outputFormat);
  }
  if (includeRecognitionResults) {
    responseData.recognitionResults = nodes
      .map(node => nodeRecognition(node))
      .filter(Boolean);
  }
  return {
    ...shaped,
    data: responseData
  };
}

export function buildNodeView(
  rawNodes: Record<string, unknown>[],
  args: JsonObject,
  options: LayoutViewOptions = {}
): JsonObject[] {
  const view = resolveViewOptions(args, options.defaults);
  const { limit, visibleOnly, clickableOnly, textOnly, usableOnly, dedupe } = view;
  const fields = selectedFields(args);
  const result: JsonObject[] = [];
  const seen = new Set<string>();

  for (const rawNode of rawNodes) {
    if (options.filter && !options.filter(rawNode)) continue;
    if (visibleOnly && !isVisibleNode(rawNode)) continue;
    if (usableOnly && !isUsableNode(rawNode)) continue;
    if (clickableOnly && !booleanValue(rawNode.clickable)) continue;
    if (textOnly && !stringValue(rawNode.text) && !stringValue(rawNode.desc)) continue;

    const node = projectNode(rawNode, fields);
    if (dedupe) {
      const key = dedupeKey(node);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(node);
    if (limit > 0 && result.length >= limit) break;
  }

  return result;
}

export function nodeRecognition(node: Record<string, unknown>) {
  const bounds = normalizeBounds(node.bounds);
  if (!bounds) return undefined;
  return {
    sourceType: "layout",
    confidence: 1,
    text: stringValue(node.text),
    id: stringValue(node.id),
    desc: stringValue(node.desc),
    className: stringValue(node.className),
    bounds,
    center: centerOf(bounds)
  };
}

export function normalizeBounds(value: unknown): { left: number; top: number; right: number; bottom: number } | undefined {
  const bounds = asRecord(value);
  const left = numberValue(bounds.left ?? bounds.l);
  const top = numberValue(bounds.top ?? bounds.t);
  const right = numberValue(bounds.right ?? bounds.r);
  const bottom = numberValue(bounds.bottom ?? bounds.b);
  if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
    return undefined;
  }
  return { left, top, right, bottom };
}

export function isVisibleNode(node: Record<string, unknown>): boolean {
  const bounds = normalizeBounds(node.bounds);
  if (!bounds) return false;
  return bounds.right > bounds.left
    && bounds.bottom > bounds.top
    && bounds.right > 0
    && bounds.bottom > 0
    && bounds.left < 10000
    && bounds.top < 10000;
}

/**
 * "可用节点"判定：enabled 且满足任一条件——
 * 1. 自身可操作：点击 / 长按 / 滚动 / 勾选 / 可输入（可输入口径与手机 AI 助手一致，按 EditText 类名）；
 * 2. 带 text/desc：这类节点是识别目标的唯一文字锚点，丢掉会让"按文字找入口"直接全空。
 * 只用于操作场景的默认收窄（丢掉空容器等噪声）；结构分析场景传 usableOnly=false 拿全部节点。
 */
export function isUsableNode(node: Record<string, unknown>): boolean {
  if (node.enabled === false || node.enabled === "false") return false;
  if (booleanValue(node.clickable) || booleanValue(node.longClickable)
    || booleanValue(node.scrollable) || booleanValue(node.checkable)) {
    return true;
  }
  const className = stringValue(node.className);
  if (className && /(?:^|\.)EditText$/i.test(className)) return true;
  return !!stringValue(node.text) || !!stringValue(node.desc);
}

function selectedFields(args: JsonObject): string[] {
  const fields = optionalString(args, "fields");
  if (!fields) return DEFAULT_FIELDS;
  const parsed = fields
    .split(",")
    .map(field => field.trim())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_FIELDS;
}

function projectNode(node: Record<string, unknown>, fields: string[]): JsonObject {
  const result: JsonObject = {};
  for (const field of fields) {
    if (field === "bounds") {
      const bounds = normalizeBounds(node.bounds);
      if (bounds) result.bounds = bounds;
      continue;
    }
    if (field === "center") {
      const bounds = normalizeBounds(node.bounds);
      if (bounds) result.center = centerOf(bounds);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(node, field)) {
      const value = node[field];
      if (value !== undefined && value !== null && value !== "") {
        result[field] = value;
      }
    }
  }
  return result;
}

function normalizeOutputFormat(value: string | undefined): "json" | "compact" | "lines" {
  if (value === "compact" || value === "lines") return value;
  return "json";
}

function pickTaskResultData(data: Record<string, unknown>): JsonObject {
  const result: JsonObject = {};
  if (data.matchedCount !== undefined) result.matchedCount = data.matchedCount;
  if (data.filter !== undefined) result.filter = data.filter;
  return result;
}

function formatNodes(nodes: JsonObject[], outputFormat: "json" | "compact" | "lines"): unknown {
  if (outputFormat === "json") return nodes;
  if (outputFormat === "lines") {
    return nodes.map((node, index) => nodeLine(node, index + 1)).join("\n");
  }
  return nodes.map(compactNode);
}

function compactNode(node: JsonObject): JsonObject {
  const result: JsonObject = {};
  const text = stringValue(node.text);
  const desc = stringValue(node.desc);
  const id = stringValue(node.id);
  const className = stringValue(node.className);
  const bounds = normalizeBounds(node.bounds);
  const center = bounds ? centerOf(bounds) : asCenter(node.center);
  if (text) result.t = text;
  if (desc) result.d = desc;
  if (id) result.i = id;
  if (className) result.cls = className;
  if (typeof node.clickable === "boolean") result.clk = node.clickable;
  if (typeof node.scrollable === "boolean") result.scr = node.scrollable;
  if (node.kind) result.k = node.kind;
  if (node.reason) result.r = node.reason;
  if (node.score !== undefined) result.s = node.score;
  if (node.nearbyText) result.nt = node.nearbyText;
  if (node.parentText) result.pt = node.parentText;
  if (node.zone) result.z = node.zone;
  if (bounds) result.b = [bounds.left, bounds.top, bounds.right, bounds.bottom];
  if (center) result.c = [center.x, center.y];
  return result;
}

function nodeLine(node: JsonObject, index: number): string {
  const compact = compactNode(node);
  const parts = [`${index}`];
  if (compact.t) parts.push(`text=${compact.t}`);
  if (compact.d) parts.push(`desc=${compact.d}`);
  if (compact.i) parts.push(`id=${compact.i}`);
  if (compact.cls) parts.push(`class=${compact.cls}`);
  if (compact.clk !== undefined) parts.push(`clickable=${compact.clk}`);
  if (compact.k) parts.push(`kind=${compact.k}`);
  if (compact.z) parts.push(`zone=${compact.z}`);
  if (compact.r) parts.push(`reason=${compact.r}`);
  if (compact.s !== undefined) parts.push(`score=${compact.s}`);
  if (compact.nt) parts.push(`nearby=${compact.nt}`);
  if (compact.pt) parts.push(`parent=${compact.pt}`);
  if (Array.isArray(compact.c)) parts.push(`c=${compact.c.join(",")}`);
  if (Array.isArray(compact.b)) parts.push(`b=${compact.b.join(",")}`);
  return parts.join(" ");
}

function buildActionCandidates(
  rawNodes: Record<string, unknown>[],
  projectedNodes: JsonObject[],
  args: JsonObject,
  view: ResolvedViewOptions
): JsonObject[] {
  const visibleOnly = view.visibleOnly;
  const dedupe = view.dedupe;
  const limit = Math.max(0, Math.round(optionalNumber(args, "actionCandidateLimit", 30) ?? 30));
  const zones = parseCandidateZones(optionalString(args, "actionCandidateZones"));
  const textAnchors = rawNodes
    .filter(node => !visibleOnly || isVisibleNode(node))
    .map(node => {
      const bounds = normalizeBounds(node.bounds);
      const label = stringValue(node.text) || stringValue(node.desc);
      return bounds && label ? { bounds, label } : undefined;
    })
    .filter(Boolean) as Array<{ bounds: { left: number; top: number; right: number; bottom: number }; label: string }>;
  const result: JsonObject[] = [];
  const seen = new Set<string>();

  for (const rawNode of rawNodes) {
    if (visibleOnly && !isVisibleNode(rawNode)) continue;
    const candidate = toActionCandidate(rawNode, textAnchors, projectedNodes, zones);
    if (!candidate) continue;
    if (dedupe) {
      const key = dedupeKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(candidate);
    if (limit > 0 && result.length >= limit) break;
  }

  return result;
}

function toActionCandidate(
  node: Record<string, unknown>,
  textAnchors: Array<{ bounds: { left: number; top: number; right: number; bottom: number }; label: string }>,
  projectedNodes: JsonObject[],
  zones: string[]
): JsonObject | undefined {
  const bounds = normalizeBounds(node.bounds);
  if (!bounds) return undefined;
  const width = bounds.right - bounds.left;
  const height = bounds.bottom - bounds.top;
  const center = centerOf(bounds);
  const className = stringValue(node.className) || "";
  const text = stringValue(node.text);
  const desc = stringValue(node.desc);
  const id = stringValue(node.id);
  const clickable = booleanValue(node.clickable);
  const hasLabel = !!(text || desc);
  const iconLike = isIconLikeNode(className, text, desc, width, height);
  const zone = classifyCandidateZone(bounds, zones);
  const actionText = text || desc || id || "";
  const actionNameScore = scoreActionName(actionText);
  let score = actionNameScore;
  const reasons: string[] = [];
  if (clickable) {
    score += 3;
    reasons.push("clickable");
  }
  if (iconLike) {
    score += 3;
    reasons.push("iconLike");
  }
  if (zone) {
    score += 2;
    reasons.push(zone);
  }
  if (!hasLabel && width <= 160 && height <= 160) {
    score += 1;
    reasons.push("smallNoText");
  }
  if (actionNameScore > 0) {
    reasons.push("actionName");
  }
  if (score < 4) return undefined;

  const nearbyText = nearestTextLabel(bounds, textAnchors);
  const parentText = containingProjectedText(bounds, projectedNodes);
  const result: JsonObject = {
    kind: guessCandidateKind(actionText, iconLike),
    className,
    clickable,
    bounds,
    center,
    score,
    reason: reasons.join(",")
  };
  if (text) result.text = text;
  if (desc) result.desc = desc;
  if (id) result.id = id;
  if (zone) result.zone = zone;
  if (nearbyText) result.nearbyText = nearbyText;
  if (parentText) result.parentText = parentText;
  return result;
}

function isIconLikeNode(className: string, text: string | undefined, desc: string | undefined, width: number, height: number): boolean {
  if (/ImageView|ImageButton|Button/i.test(className)) return true;
  const label = text || desc || "";
  if (label && label.length <= 2 && /[^\w\s\u4e00-\u9fa5]/.test(label)) return true;
  return !label && width > 0 && height > 0 && width <= 180 && height <= 180;
}

function classifyCandidateZone(bounds: { left: number; top: number; right: number; bottom: number }, zones: string[]): string | undefined {
  if (zones.includes("all")) return "all";
  const center = centerOf(bounds);
  if (zones.includes("topRight") && center.x >= 720 && center.y <= 260) return "topRight";
  if (zones.includes("listRight") && center.x >= 760 && center.y > 240) return "listRight";
  if (zones.includes("cardRight") && center.x >= 700 && bounds.bottom > bounds.top) return "cardRight";
  if (zones.includes("rowRight") && center.x >= 760) return "rowRight";
  return undefined;
}

function parseCandidateZones(value: string | undefined): string[] {
  if (!value) return DEFAULT_ACTION_CANDIDATE_ZONES;
  const zones = value
    .split(",")
    .map(item => item.trim())
    .filter(Boolean);
  return zones.length ? zones : DEFAULT_ACTION_CANDIDATE_ZONES;
}

function scoreActionName(value: string): number {
  if (!value) return 0;
  if (/新增|添加|编辑|修改|删除|保存|提交|管理|更多|操作|完成|确认|取消|创建|发布/.test(value)) return 4;
  if (/edit|delete|remove|save|submit|add|create|more|manage|operate/i.test(value)) return 4;
  return 0;
}

function guessCandidateKind(value: string, iconLike: boolean): string {
  if (/新增|添加|add|create/i.test(value)) return "add";
  if (/编辑|修改|edit/i.test(value)) return "edit";
  if (/删除|delete|remove/i.test(value)) return "delete";
  if (/保存|save/i.test(value)) return "save";
  if (/提交|submit|发布/i.test(value)) return "submit";
  if (/更多|more|操作|管理|manage|operate/i.test(value)) return "more";
  return iconLike ? "icon" : "action";
}

function nearestTextLabel(bounds: { left: number; top: number; right: number; bottom: number }, anchors: Array<{ bounds: { left: number; top: number; right: number; bottom: number }; label: string }>): string | undefined {
  const center = centerOf(bounds);
  let best: { label: string; distance: number } | undefined;
  for (const anchor of anchors) {
    const anchorCenter = centerOf(anchor.bounds);
    const yDistance = Math.abs(anchorCenter.y - center.y);
    const xDistance = Math.abs(anchorCenter.x - center.x);
    if (yDistance > 90 || xDistance > 820) continue;
    const distance = yDistance * 4 + xDistance;
    if (!best || distance < best.distance) {
      best = { label: anchor.label, distance };
    }
  }
  return best?.label;
}

function containingProjectedText(bounds: { left: number; top: number; right: number; bottom: number }, nodes: JsonObject[]): string | undefined {
  for (const node of nodes) {
    const nodeBounds = normalizeBounds(node.bounds);
    if (!nodeBounds) continue;
    if (nodeBounds.left <= bounds.left && nodeBounds.top <= bounds.top && nodeBounds.right >= bounds.right && nodeBounds.bottom >= bounds.bottom) {
      const label = stringValue(node.text) || stringValue(node.desc);
      if (label) return label;
    }
  }
  return undefined;
}

function centerOf(bounds: { left: number; top: number; right: number; bottom: number }) {
  return {
    x: Math.round((bounds.left + bounds.right) / 2),
    y: Math.round((bounds.top + bounds.bottom) / 2)
  };
}

function asCenter(value: unknown): { x: number; y: number } | undefined {
  const center = asRecord(value);
  const x = numberValue(center.x);
  const y = numberValue(center.y);
  return x === undefined || y === undefined ? undefined : { x, y };
}

function dedupeKey(node: JsonObject): string {
  const bounds = normalizeBounds(node.bounds);
  return [
    stringValue(node.text) || "",
    stringValue(node.desc) || "",
    stringValue(node.id) || "",
    stringValue(node.className) || "",
    bounds ? `${bounds.left},${bounds.top},${bounds.right},${bounds.bottom}` : ""
  ].join("|");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === "true";
}
