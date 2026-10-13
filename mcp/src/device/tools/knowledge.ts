import type { JsonObject, McpToolDefinition, ToolContext, ToolImage } from "../../core/types.js";
import {
  createTool,
  fail,
  objectSchema,
  ok,
  omitUndefined,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString
} from "./common.js";

/**
 * 知识库只读工具：官方知识包 + 客户资料（V5 本地索引），走 V5 的 `/api/mcp/knowledge/**`。
 *
 * 语义边界：
 * - 官方与客户资料由同一个 RRF 融合检索提供，结果自带 sourceType，引用必须标明来源；
 * - 客户资料默认允许外部检索（可在 V5 的 AI 设置中关闭），关闭后本工具只能拿到官方内容；
 * - AutoJs 符号索引不在这里，用同入口的 `autojs_docs_search`（命中即权威）；
 * - 图片按需以 MCP image 块返回，模型可直接查看；无视觉能力时用返回的路径与受控地址引用。
 */

const SEARCH_DEFAULT_LIMIT = 5;
const SEARCH_MAX_LIMIT = 20;
/** 单次读取窗口：与 V5 的 Web AI knowledge.read、手机端 autojs.knowledge.read 同一口径。 */
const READ_WINDOW_CHARS = 12000;
const ASSET_DEFAULT_LIMIT = 3;
/** 单次工具结果允许回传的图片数量上限（与 toolImages.MAX_TOOL_IMAGES 一致）。 */
const ASSET_MAX_LIMIT = 4;

const SOURCE_TYPE_ALL = { type: "string", enum: ["all", "official", "custom"], default: "all" };
const SOURCE_TYPE_CONCRETE = { type: "string", enum: ["official", "custom"] };

export function knowledgeTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "knowledge_search",
      "检索官方知识包与客户资料（本地索引 + RRF 融合，只读）。用户在问工具箱 V5 / 手机 APP / 网页端的用法、配置位置或操作步骤时，先用本工具检索官方教程，再用 knowledge_read 读命中正文作答，引用标明「来自官方教程」，不要凭记忆或插件自带说明回答；命中客户资料时标明「来自你的资料」。返回每条命中的 docPath / anchor / snippet / score / sourceType / 关联图片。客户资料默认允许外部检索，可在 V5 的 AI 设置中关闭。查 AutoJs 符号用 autojs_docs_search，不要用本工具。",
      objectSchema({
        query: {
          type: "string",
          description: "自然语言问题或关键词（中文长句按二元切分检索；界面原词与 API 名精确命中优先）。"
        },
        limit: { type: "number", default: SEARCH_DEFAULT_LIMIT, description: "返回条数，最大 20。" },
        sourceType: SOURCE_TYPE_ALL
      }, ["query"]),
      async args => searchKnowledge(ctx, args)
    ),
    createTool(
      "knowledge_read",
      "分段读取 knowledge_search 命中文档的正文与关联图片（只读）。单次最多返回 12000 字符：先按 offset=0 读第一段，返回 truncated=true 时用同一 docPath 加 offset=nextOffset 继续读下一段，直到 truncated=false，这样长文档（例如某个端的完整更新日志）也能读完。客户资料传 anchor 时只读该小节。返回的 assets / assetUrls 用于继续调用 knowledge_assets 取图。",
      objectSchema({
        docPath: { type: "string", description: "knowledge_search 返回的 docPath。" },
        sourceType: {
          type: "string",
          enum: ["official", "custom"],
          description: "来源；缺省按 official 读取。"
        },
        anchor: { type: "string", description: "可选小节锚点（客户资料命中时只返回该小节）。" },
        offset: { type: "number", default: 0, description: "正文起始字符位置；续读时填上一段返回的 nextOffset。" },
        maxChars: {
          type: "number",
          default: READ_WINDOW_CHARS,
          description: "本段字符数，默认与上限均为 " + READ_WINDOW_CHARS + " 字符；传更小值只影响本段窗口。"
        }
      }, ["docPath"]),
      async args => readKnowledge(ctx, args)
    ),
    createTool(
      "knowledge_assets",
      "取图（只读）。传 path 取单张图片；传 docPath（可带 anchor）列出该文档 / 小节的图片并默认把前几张以图片块返回，模型可直接查看。超过内联上限的图片只返回路径与本地受控地址。",
      objectSchema({
        sourceType: SOURCE_TYPE_CONCRETE,
        path: { type: "string", description: "图片路径（knowledge_search / knowledge_read 返回的 assets 项）。" },
        docPath: { type: "string", description: "列出该文档的图片；与 path 二选一。" },
        anchor: { type: "string", description: "可选小节锚点，配合 docPath 只列该小节图片。" },
        includeImage: { type: "boolean", default: true, description: "是否把图片作为图片块返回。" },
        limit: { type: "number", default: ASSET_DEFAULT_LIMIT, description: "最多返回几张图片内容，最大 4。" }
      }),
      async args => assetsKnowledge(ctx, args)
    )
  ];
}

async function searchKnowledge(ctx: ToolContext, args: JsonObject) {
  const query = requireString(args, "query");
  const limit = clamp(optionalNumber(args, "limit", SEARCH_DEFAULT_LIMIT) ?? SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const sourceType = optionalString(args, "sourceType");
  const outcome = await ctx.client.get<JsonObject>("/api/mcp/knowledge/search", omitUndefined({
    query,
    limit,
    sourceType,
    clientId: ctx.config.mcpClientId
  }));
  if (!outcome.ok || !outcome.data) {
    return outcome;
  }
  const data = outcome.data;
  const matches = Array.isArray(data.matches) ? data.matches : [];
  const sources = Array.isArray(data.sourceTypes) ? data.sourceTypes : [];
  return ok(searchMessage(matches.length, sources, data.customAllowed), {
    ...data,
    citationRule: "回答时必须写明来源：官方内容写「来自官方教程：…」，客户资料写「来自你的资料：…」。",
    readHint: matches.length
      ? "用 knowledge_read 读文档正文，用 knowledge_assets 查看命中小节的图片。"
      : "没有命中，不得编造；可换关键词或改用 autojs_docs_search 查 AutoJs 符号。"
  });
}

async function readKnowledge(ctx: ToolContext, args: JsonObject) {
  const docPath = requireString(args, "docPath");
  const sourceType = optionalString(args, "sourceType");
  const anchor = optionalString(args, "anchor");
  const offset = clamp(optionalNumber(args, "offset", 0) ?? 0, 0, 1000000);
  const maxChars = clamp(
    optionalNumber(args, "maxChars", READ_WINDOW_CHARS) ?? READ_WINDOW_CHARS,
    500,
    READ_WINDOW_CHARS
  );
  const outcome = await ctx.client.get<JsonObject>("/api/mcp/knowledge/read", omitUndefined({
    docPath,
    sourceType,
    anchor,
    offset,
    maxChars,
    clientId: ctx.config.mcpClientId
  }));
  if (!outcome.ok || !outcome.data) {
    return outcome;
  }
  const data = stripRenderPayload(outcome.data);
  const custom = String(data.sourceType ?? "") === "custom";
  const truncated = data.truncated === true;
  const nextOffset = truncated && typeof data.nextOffset === "number" ? data.nextOffset : undefined;
  const windowHint = truncated
    ? "（本段从 " + offset + " 开始，后面还有正文：用同一个 docPath 加 offset=" + nextOffset + " 继续读）"
    : "";
  return ok(
    (custom ? "来自你的资料：" : "来自官方教程：") + String(data.title ?? docPath) + windowHint,
    {
      ...data,
      citationRule: custom
        ? "引用时必须标明「来自你的资料」。"
        : "引用时必须标明「来自官方教程」。",
      readMode: truncated
        ? "分段读取：本段之后还有正文，用同一个 docPath 加 offset=nextOffset 继续，直到 truncated=false。"
        : "本段已读到文档末尾。",
      readMaxCharsHint: READ_WINDOW_CHARS
    }
  );
}

/** 渲染用 HTML 与 markdown 正文重复且体积更大，不进模型上下文：只保留正文与元数据。 */
function stripRenderPayload(value: JsonObject): JsonObject {
  const copy: JsonObject = { ...value };
  delete copy.html;
  return copy;
}

async function assetsKnowledge(ctx: ToolContext, args: JsonObject) {
  const sourceType = optionalString(args, "sourceType");
  const path = optionalString(args, "path");
  const docPath = optionalString(args, "docPath");
  const anchor = optionalString(args, "anchor");
  const includeImage = optionalBoolean(args, "includeImage", true);
  const limit = clamp(
    optionalNumber(args, "limit", ASSET_DEFAULT_LIMIT) ?? ASSET_DEFAULT_LIMIT,
    1,
    ASSET_MAX_LIMIT
  );
  if (!path && !docPath) {
    return fail("INVALID_ARGUMENT", "必须提供 path（单张图片）或 docPath（列出文档图片）。");
  }

  if (path) {
    const outcome = await fetchAsset(ctx, sourceType, path);
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const images = includeImage ? imagesOf([outcome.data]) : [];
    return {
      ok: true,
      code: "OK",
      message: images.length ? `已返回图片 ${path}。` : `已返回图片元数据 ${path}（未内联图片内容）。`,
      data: { sourceType: outcome.data.sourceType, count: 1, assets: [stripImagePayload(outcome.data)] },
      images: images.length ? images : undefined
    };
  }

  const listOutcome = await ctx.client.get<JsonObject>("/api/mcp/knowledge/assets", omitUndefined({
    sourceType,
    docPath,
    anchor,
    clientId: ctx.config.mcpClientId
  }));
  if (!listOutcome.ok || !listOutcome.data) {
    return listOutcome;
  }
  const listed = Array.isArray(listOutcome.data.assets) ? listOutcome.data.assets : [];
  const selected = listed.slice(0, includeImage ? limit : 0);
  const fetched: JsonObject[] = [];
  const images: ToolImage[] = [];
  for (const item of selected) {
    const record = asRecord(item);
    const assetPath = typeof record.path === "string" ? record.path : "";
    if (!assetPath) {
      continue;
    }
    const outcome = await fetchAsset(ctx, sourceType, assetPath);
    if (!outcome.ok || !outcome.data) {
      continue;
    }
    fetched.push(outcome.data);
    const image = imageOf(outcome.data);
    if (image && images.length < ASSET_MAX_LIMIT) {
      images.push(image);
    }
  }
  const assets = listed.map(item => stripImagePayload(asRecord(item)));
  const inline = fetched.map(item => stripImagePayload(item));
  return {
    ok: true,
    code: "OK",
    message: `共 ${listed.length} 张图片` + (images.length ? `，已内联 ${images.length} 张。` : "，仅返回路径与受控地址。"),
    data: {
      sourceType: listOutcome.data.sourceType,
      docPath: listOutcome.data.docPath,
      anchor: listOutcome.data.anchor,
      count: listed.length,
      imagesIncluded: images.length,
      assets,
      inlineAssets: inline,
      customAllowed: listOutcome.data.customAllowed
    },
    images: images.length ? images : undefined
  };
}

async function fetchAsset(ctx: ToolContext, sourceType: string | undefined, path: string) {
  return ctx.client.get<JsonObject>("/api/mcp/knowledge/assets", omitUndefined({
    sourceType,
    path,
    clientId: ctx.config.mcpClientId
  }));
}

/** 把 V5 的 base64 字段还原成 MCP image 块；文本结构里绝不留 base64。 */
function imagesOf(values: JsonObject[]): ToolImage[] {
  const images: ToolImage[] = [];
  for (const value of values) {
    const image = imageOf(value);
    if (image) {
      images.push(image);
    }
  }
  return images;
}

function imageOf(value: JsonObject): ToolImage | undefined {
  const base64 = typeof value.base64 === "string" ? value.base64 : "";
  if (!base64 || value.inline === false) {
    return undefined;
  }
  const mimeType = typeof value.mime === "string" && value.mime ? value.mime : "image/png";
  return { data: base64, mimeType };
}

function stripImagePayload(value: JsonObject): JsonObject {
  const copy: JsonObject = { ...value };
  const inline = typeof copy.base64 === "string";
  delete copy.base64;
  copy.inline = value.inline === undefined ? inline : value.inline;
  return copy;
}

function searchMessage(matched: number, sources: unknown[], customAllowed: unknown): string {
  if (!matched) {
    return "没有命中任何知识内容，不得编造；可换关键词或改用 autojs_docs_search 查 AutoJs 符号。";
  }
  const sourceText = sources.length ? sources.join(" / ") : "unknown";
  const customHint = customAllowed === false ? "（客户资料对外检索已关闭，本次只检索官方内容）" : "";
  return `命中 ${matched} 条，来源：${sourceText}${customHint}。`;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function clamp(value: number, min: number, max: number): number {
  const rounded = Math.round(value);
  return Math.min(max, Math.max(min, rounded));
}
