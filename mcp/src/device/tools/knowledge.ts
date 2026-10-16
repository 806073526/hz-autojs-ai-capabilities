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
 * - knowledge_read 会把本段正文引用的图片对齐成 windowImages（path + 说明），可用 includeImages
 *   或 knowledge_assets(paths) 以 MCP image 块返回；通用 agent 客户端会直接把图片展示给用户。
 * - 无视觉能力时用返回的路径与受控地址引用。
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
      "检索官方知识包与客户资料（本地索引 + RRF 融合，只读）。用户在问工具箱 V5 / 手机 APP / 网页端的用法、配置位置或操作步骤时，先用本工具检索官方教程，再用 knowledge_read 读命中正文作答，引用标明「来自官方教程」，不要凭记忆或插件自带说明回答；命中客户资料时标明「来自你的资料」。返回每条命中的 docPath / anchor / snippet / score / sourceType / 关联图片；命中条目带图（assets / imageReferences）且用户在问界面位置、按钮或操作步骤时，读正文后取图展示给用户。客户资料默认允许外部检索，可在 V5 的 AI 设置中关闭。查 AutoJs 符号用 autojs_docs_search，不要用本工具。",
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
      "分段读取 knowledge_search 命中文档的正文与关联图片（只读）。单次最多返回 12000 字符：先按 offset=0 读第一段，返回 truncated=true 时用同一 docPath 加 offset=nextOffset 继续读下一段，直到 truncated=false，这样长文档（例如某个端的完整更新日志）也能读完。客户资料传 anchor 时只读该小节。本段正文引用的图片会列在 windowImages（按出现顺序，含 path 与说明）；涉及界面位置、按钮、操作步骤或用户要求看图时，传 includeImages=true 直接把这些图片作为图片块返回（最多 4 张，客户端会展示给用户），或用 knowledge_assets(paths=[...]) 取。",
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
        },
        includeImages: {
          type: "boolean",
          default: false,
          description: "是否把本段正文引用的图片以内联图片块一并返回（最多 4 张，客户端会直接展示给用户）。"
        }
      }, ["docPath"]),
      async args => readKnowledge(ctx, args)
    ),
    createTool(
      "knowledge_assets",
      "取图（只读）。path 取单张；paths 一次取多张（最多 4 张）；docPath（可带 anchor）列出该文档 / 小节的图片并默认把前几张以图片块返回。图片块由客户端直接展示给用户，适合在回答界面位置、按钮、操作步骤时随答案给出。超过内联上限的图片只返回路径与本地受控地址。",
      objectSchema({
        sourceType: SOURCE_TYPE_CONCRETE,
        path: { type: "string", description: "单张图片路径（knowledge_search 的 assets / knowledge_read 的 windowImages 项）。" },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "一次取多张图片（最多 4 张），例如本段 windowImages 的 path 列表；与 path 二选一。"
        },
        docPath: { type: "string", description: "列出该文档 / 小节的图片；与 path / paths 二选一。" },
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
  const matches = Array.isArray(data.matches) ? data.matches.map(asRecord) : [];
  const sources = Array.isArray(data.sourceTypes) ? data.sourceTypes : [];
  const imageCount = countMatchImages(matches);
  return ok(searchMessage(matches.length, sources, data.customAllowed), {
    ...data,
    citationRule: "回答时必须写明来源：官方内容写「来自官方教程：…」，客户资料写「来自你的资料：…」。",
    readHint: matches.length
      ? "用 knowledge_read 读文档正文；命中小节带图时用 knowledge_assets 取图展示给用户。"
      : "没有命中，不得编造；可换关键词或改用 autojs_docs_search 查 AutoJs 符号。",
    imageHint: imageCount
      ? `命中内容关联 ${imageCount} 张图片（见各条 assets / imageReferences）。涉及界面位置、按钮、操作步骤或用户要看图时，先 knowledge_read 定位小节，再用 knowledge_assets(paths=[...]) 取图展示给用户。`
      : undefined
  });
}

async function readKnowledge(ctx: ToolContext, args: JsonObject) {
  const docPath = requireString(args, "docPath");
  const sourceType = optionalString(args, "sourceType");
  const anchor = optionalString(args, "anchor");
  const includeImages = optionalBoolean(args, "includeImages", false);
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
  const assets = Array.isArray(data.assets) ? data.assets.map(asRecord) : [];
  // 客户资料的分块正文由标题与说明拼成，只有小节级读取才能确定图片属于本段；
  // 官方文档的 assets 是全文档清单，必须按正文引用过滤，不能整篇下发给模型。
  const windowImages = imagesInWindow(data.markdown, assets, custom && data.sectionFound === true);
  const collected = includeImages && windowImages.length
    ? await collectAssets(
        ctx,
        custom ? "custom" : "official",
        windowImages
          .map(item => String(item.path ?? ""))
          .filter(Boolean)
          .slice(0, ASSET_MAX_LIMIT),
        true
      )
    : { images: [] as ToolImage[], entries: [] as JsonObject[], inlined: new Set<string>() };
  const imagesIncluded = collected.images.length;
  return {
    ok: true,
    code: "OK",
    message:
      (custom ? "来自你的资料：" : "来自官方教程：") +
      String(data.title ?? docPath) +
      windowHint +
      (windowImages.length ? "；本段引用 " + windowImages.length + " 张图片" : ""),
    data: {
      ...data,
      windowImages: windowImages.length ? windowImages : undefined,
      imagesIncluded: includeImages ? imagesIncluded : undefined,
      imageHint: readImageHint(windowImages.length, collected.inlined.size, imagesIncluded),
      citationRule: custom
        ? "引用时必须标明「来自你的资料」。"
        : "引用时必须标明「来自官方教程」。",
      readMode: truncated
        ? "分段读取：本段之后还有正文，用同一个 docPath 加 offset=nextOffset 继续，直到 truncated=false。"
        : "本段已读到文档末尾。",
      readMaxCharsHint: READ_WINDOW_CHARS
    },
    images: collected.images.length ? collected.images : undefined
  };
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
  const paths = optionalStringArray(args, "paths");
  const docPath = optionalString(args, "docPath");
  const anchor = optionalString(args, "anchor");
  const includeImage = optionalBoolean(args, "includeImage", true);
  const limit = clamp(
    optionalNumber(args, "limit", ASSET_DEFAULT_LIMIT) ?? ASSET_DEFAULT_LIMIT,
    1,
    ASSET_MAX_LIMIT
  );
  if (!path && !paths.length && !docPath) {
    return fail("INVALID_ARGUMENT", "必须提供 path（单张图片）、paths（多张图片）或 docPath（列出文档图片）。");
  }

  if (path || paths.length) {
    const requested = [...new Set(paths.length ? paths : [path as string])];
    const target = requested.slice(0, ASSET_MAX_LIMIT);
    const collected = await collectAssets(ctx, sourceType, target, includeImage);
    const overflow = requested.length - target.length;
    const imagesIncluded = collected.images.length;
    return {
      ok: true,
      code: "OK",
      message: imagesIncluded
        ? "已返回 " + imagesIncluded + " 张图片"
          + (overflow > 0 ? "（单次上限 " + ASSET_MAX_LIMIT + " 张，另有 " + overflow + " 张未取）" : "") + "。"
        : "已返回 " + collected.entries.length + " 张图片元数据（未内联图片内容）。",
      data: {
        sourceType: collected.entries[0]?.sourceType ?? sourceType,
        count: requested.length,
        imagesIncluded,
        assets: collected.entries,
        notRequested: overflow > 0 ? requested.slice(ASSET_MAX_LIMIT) : undefined,
        displayHint: assetsDisplayHint(collected.inlined.size, imagesIncluded, collected.entries.length)
      },
      images: collected.images.length ? collected.images : undefined
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
  const resolvedSource = typeof listOutcome.data.sourceType === "string" ? listOutcome.data.sourceType : sourceType;
  const selectedPaths = listed
    .map(item => assetPathOf(asRecord(item)))
    .filter(Boolean)
    .slice(0, includeImage ? limit : 0);
  const collected = await collectAssets(ctx, resolvedSource, selectedPaths, includeImage);
  // assets 里 inline 的语义是「本次结果是否带回了这张图」，让模型不用去猜哪些已内联。
  const assets = listed.map(item => {
    const record = stripImagePayload(asRecord(item));
    record.inline = collected.inlined.has(assetPathOf(asRecord(item)));
    return record;
  });
  return {
    ok: true,
    code: "OK",
    message: "共 " + listed.length + " 张图片"
      + (collected.images.length ? "，已内联 " + collected.images.length + " 张。" : "，仅返回路径与受控地址。"),
    data: {
      sourceType: listOutcome.data.sourceType,
      docPath: listOutcome.data.docPath,
      anchor: listOutcome.data.anchor,
      count: listed.length,
      imagesIncluded: collected.images.length,
      assets,
      inlineAssets: collected.entries,
      displayHint: assetsDisplayHint(collected.inlined.size, collected.images.length, listed.length),
      customAllowed: listOutcome.data.customAllowed
    },
    images: collected.images.length ? collected.images : undefined
  };
}

async function fetchAsset(ctx: ToolContext, sourceType: string | undefined, path: string) {
  return ctx.client.get<JsonObject>("/api/mcp/knowledge/assets", omitUndefined({
    sourceType,
    path,
    clientId: ctx.config.mcpClientId
  }));
}

/**
 * 按路径批量取图：entries 是脱敏后的元数据，images 是还原成 MCP image 块的内容。
 *
 * 两点口径：
 * - 每条目的 inline 以「本次结果是否真的带回了图片内容」为准，不采信 V5 的原始标记；
 * - 内容完全相同的图片只保留一个图片块（与传输层 splitOutcomeForMcp 的去重一致），
 *   计数按真实下发的图片块算，避免提示里出现「已展示 N 张」而实际只有 M 张。
 */
async function collectAssets(
  ctx: ToolContext,
  sourceType: string | undefined,
  paths: string[],
  includeImage: boolean
): Promise<{ images: ToolImage[]; entries: JsonObject[]; inlined: Set<string> }> {
  const images: ToolImage[] = [];
  const entries: JsonObject[] = [];
  const delivered = new Set<string>();
  const seenData = new Set<string>();
  for (const path of paths) {
    const outcome = await fetchAsset(ctx, sourceType, path);
    if (!outcome.ok || !outcome.data) {
      continue;
    }
    const entry = stripImagePayload(outcome.data);
    const image = includeImage ? imageOf(outcome.data) : undefined;
    entry.inline = Boolean(image);
    entries.push(entry);
    if (image) {
      if (!seenData.has(image.data)) {
        seenData.add(image.data);
        images.push(image);
      }
      delivered.add(path);
    }
  }
  return { images, entries, inlined: delivered };
}

/** 通用 agent 客户端会把图片块直接展示给用户：把这件事说清楚，避免模型只复述路径。 */
function assetsDisplayHint(delivered: number, blocks: number, listed: number): string {
  if (delivered > 0) {
    return "本次有 " + delivered + " 张图片已作为图片块发给客户端，会直接展示给用户"
      + (blocks < delivered ? "（内容完全相同的图片已合并）" : "")
      + "；回答时可直接引用截图画面，不要只念路径或凭路径猜测内容。";
  }
  if (listed > 0) {
    return "本次未内联图片内容（仅返回路径或受控地址），不能据此描述画面；需要看图时按 assets 里的 path 逐张取。";
  }
  return "没有可返回的图片。";
}

function readImageHint(total: number, delivered: number, blocks: number): string | undefined {
  if (!total) {
    return undefined;
  }
  if (delivered > 0) {
    const rest = total - delivered;
    return "已把本段引用图片中的 " + delivered + " 张随本结果返回，客户端会直接展示给用户"
      + (blocks < delivered ? "（内容完全相同的图片已合并）" : "")
      + "；回答时可直接引用画面内容。"
      + (rest > 0
        ? "另有 " + rest + " 张未内联（单次上限 " + ASSET_MAX_LIMIT + " 张）：需要时用 knowledge_assets(paths=[...]) 继续取。"
        : "");
  }
  return "本段正文引用了 " + total + " 张图片（见 windowImages，按出现顺序，path 可直接用于取图）。"
    + "涉及界面位置、按钮、操作步骤或用户要求看图时，应把对应图片展示给用户：用 knowledge_assets(paths=[...]) 取，"
    + "或重新用 knowledge_read(includeImages=true)。";
}

function optionalStringArray(args: JsonObject, name: string): string[] {
  const value = args[name];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`参数 ${name} 必须是字符串数组`);
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean);
}

/** 图片在取图接口里的路径：优先 path（官方文档是全路径，客户资料是文档相对路径）。 */
function assetPathOf(asset: JsonObject): string {
  for (const key of ["path", "assetPath"]) {
    const value = asset[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

interface ImageReference {
  alt: string;
  href: string;
}

/** 正文里的 Markdown 图片引用：![alt](href "title")。 */
function imageReferences(markdown: string): ImageReference[] {
  const refs: ImageReference[] = [];
  const pattern = /!\[([^\]]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const raw = match[2] ?? "";
    refs.push({
      alt: (match[1] ?? "").trim(),
      href: raw.startsWith("<") ? raw.slice(1, -1) : raw
    });
  }
  return refs;
}

/** 把图片引用与资产路径规范成同一形态：去编码、去反斜杠、去查询串、去 ./ 与 / 前缀。 */
function normalizeAssetReference(value: string): string {
  let text = String(value ?? "").trim();
  const angle = /^<(.*)>$/.exec(text);
  if (angle) {
    text = angle[1];
  }
  try {
    text = decodeURIComponent(text);
  } catch {
    // 非法百分号编码按原文匹配
  }
  text = text.replace(/\\/g, "/");
  const query = text.indexOf("?");
  if (query >= 0) {
    const pathParam = /(?:^|&)path=([^&]*)/.exec(text.slice(query + 1));
    text = pathParam ? pathParam[1] : text.slice(0, query);
  }
  text = text.replace(/^\/+/, "");
  while (text.startsWith("./")) {
    text = text.slice(2);
  }
  return text;
}

function assetReferences(asset: JsonObject): string[] {
  const refs: string[] = [];
  for (const key of ["assetPath", "path"]) {
    const value = asset[key];
    if (typeof value === "string" && value.trim()) {
      refs.push(normalizeAssetReference(value));
    }
  }
  return refs;
}

function findAssetByReference(href: string, assets: JsonObject[]): JsonObject | undefined {
  const target = normalizeAssetReference(href);
  if (!target) {
    return undefined;
  }
  for (const asset of assets) {
    if (assetReferences(asset).includes(target)) {
      return asset;
    }
  }
  // 引用可能带上级目录或绝对 URL：退化为按文件名匹配，避免整段对不上图。
  const fileName = target.slice(target.lastIndexOf("/") + 1);
  if (!fileName) {
    return undefined;
  }
  for (const asset of assets) {
    if (assetReferences(asset).some(item => item.slice(item.lastIndexOf("/") + 1) === fileName)) {
      return asset;
    }
  }
  return undefined;
}

/**
 * 本段正文引用的图片：与文档 assets 对齐、按出现顺序去重。
 * sectionScoped（客户资料且命中具体小节）时，正文由标题与说明拼成、不含图片引用，
 * 直接采用小节资产，避免「有图却列不出来」。
 */
function imagesInWindow(markdown: unknown, assets: JsonObject[], sectionScoped: boolean): JsonObject[] {
  if (!assets.length) {
    return [];
  }
  const result: JsonObject[] = [];
  const seen = new Set<string>();
  if (typeof markdown === "string" && markdown.includes("![")) {
    for (const ref of imageReferences(markdown)) {
      const asset = findAssetByReference(ref.href, assets);
      if (!asset) {
        continue;
      }
      const path = assetPathOf(asset);
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      result.push(imageEntry(asset, ref.alt));
    }
  }
  if (result.length || !sectionScoped) {
    return result;
  }
  for (const asset of assets) {
    const path = assetPathOf(asset);
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    result.push(imageEntry(asset, ""));
  }
  return result;
}

function imageEntry(asset: JsonObject, caption: string): JsonObject {
  const entry: JsonObject = { path: assetPathOf(asset) };
  for (const key of ["docPath", "assetPath", "mime", "width", "height", "url"]) {
    const value = asset[key];
    if (value !== undefined && value !== null && value !== "") {
      entry[key] = value;
    }
  }
  const text = caption || (typeof asset.caption === "string" ? asset.caption.trim() : "");
  if (text) {
    entry.caption = text;
  }
  return entry;
}

/** 命中条目里关联的图片数（按路径去重）。 */
function countMatchImages(matches: JsonObject[]): number {
  const seen = new Set<string>();
  for (const match of matches) {
    const assets = Array.isArray(match.assets) ? match.assets : [];
    for (const item of assets) {
      const path = typeof item === "string" ? item : assetPathOf(asRecord(item));
      if (path) {
        seen.add(path);
      }
    }
    const references = Array.isArray(match.imageReferences) ? match.imageReferences : [];
    for (const item of references) {
      const path = assetPathOf(asRecord(item));
      if (path) {
        seen.add(path);
      }
    }
  }
  return seen.size;
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
