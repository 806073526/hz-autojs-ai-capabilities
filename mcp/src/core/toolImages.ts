import type { JsonObject, ToolImage, ToolOutcome } from "./types.js";

/**
 * 工具结果里的图片与文本分离。
 *
 * 背景：V5 在 includePreview=true 时把预览图以 previewBase64 文本字段返回。
 * 若原样让它进入工具结果的 JSON，模型拿到的是几万字符 base64——既当不了图片看
 * （超过 maxChars 会被截成半截），又会在后续每一轮请求里随上下文重复计费。
 *
 * 这里的职责只有一个：把 previewBase64 从文本结构里摘出来，还原成 MCP 的
 * image 内容块；文本侧只保留 path/size/width/height 这类元数据。
 */

/** 单次工具结果允许回传的图片数量上限。 */
export const MAX_TOOL_IMAGES = 4;
/** 单张图片解码后的字节上限，与 V5 侧保持一致。 */
export const MAX_TOOL_IMAGE_BYTES = 10 * 1024 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const MIME_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif"
};

export interface DetachImagesResult<T> {
  value: T;
  images: ToolImage[];
}

/**
 * 递归摘出结构里的 previewBase64 并转成图片，返回不含 base64 文本的新值。
 * 传入 images 时可以追加到已有列表，便于分阶段累积。
 */
export function detachToolImages<T>(value: T, images: ToolImage[] = []): DetachImagesResult<T> {
  return { value: walk(value, images) as T, images };
}

/**
 * 把工具结果拆成「给模型的文本」和「图片块」两部分。
 *
 * 文本里绝不会再出现 base64：既清掉 handler 已挂在 outcome.images 上的图片，
 * 也对最终数据结构再做一次兜底扫描，避免任何路径漏掉。
 */
export function splitOutcomeForMcp(outcome: ToolOutcome): { text: string; images: ToolImage[] } {
  const declared = Array.isArray(outcome.images) ? outcome.images : [];
  const rest: JsonObject = { ...(outcome as unknown as JsonObject) };
  delete rest.images;
  const extracted = detachToolImages(rest);
  return {
    text: JSON.stringify(extracted.value, null, 2),
    images: dedupeImages([...declared, ...extracted.images])
  };
}

function dedupeImages(images: ToolImage[]): ToolImage[] {
  const seen = new Set<string>();
  const result: ToolImage[] = [];
  for (const image of images) {
    if (!image || typeof image.data !== "string") continue;
    if (seen.has(image.data)) continue;
    seen.add(image.data);
    result.push(image);
  }
  return result.slice(0, MAX_TOOL_IMAGES);
}

function walk(value: unknown, images: ToolImage[]): unknown {
  if (Array.isArray(value)) {
    return value.map(item => walk(item, images));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...record };
    const preview = copy.previewBase64;
    if (preview !== undefined) {
      delete copy.previewBase64;
      pushImage(preview, copy.previewFormat, images);
    }
    for (const key of Object.keys(copy)) {
      copy[key] = walk(copy[key], images);
    }
    return copy;
  }
  if (typeof value === "string") {
    return walkEmbeddedJson(value, images);
  }
  return value;
}

/**
 * V5 有些任务把 resultPayload 作为「JSON 字符串」再嵌一层，
 * 里面的预览图同样要摘出来，否则仍会以文本形式占上下文。
 */
function walkEmbeddedJson(text: string, images: ToolImage[]): string {
  if (text.length < 64 || !text.includes("previewBase64")) {
    return text;
  }
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return text;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  const walked = walk(parsed, images);
  try {
    return JSON.stringify(walked);
  } catch {
    return text;
  }
}

function pushImage(preview: unknown, format: unknown, images: ToolImage[]): void {
  if (images.length >= MAX_TOOL_IMAGES) return;
  if (typeof preview !== "string") return;
  const data = preview.replace(/\s+/g, "");
  if (!data || data.length % 4 !== 0 || !BASE64_PATTERN.test(data)) return;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(data, "base64");
  } catch {
    return;
  }
  if (bytes.length === 0 || bytes.length > MAX_TOOL_IMAGE_BYTES) return;
  images.push({ data, mimeType: mimeTypeFor(format) });
}

function mimeTypeFor(format: unknown): string {
  const key = typeof format === "string" ? format.trim().toLowerCase() : "";
  return MIME_BY_FORMAT[key] || "image/jpeg";
}