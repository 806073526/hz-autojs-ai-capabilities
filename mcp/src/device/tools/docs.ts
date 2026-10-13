import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject, McpToolDefinition } from "../../core/types.js";
import {
  createTool,
  fail,
  objectSchema,
  ok,
  optionalNumber,
  optionalString
} from "./common.js";

/**
 * AutoJs 离线文档索引查询工具。
 *
 * 索引由 `mcp/scripts/build-autojs-index.mjs` 从随包的 VuePress 预渲染 HTML
 * 蒸馏而来（`mcp/docs/autojs-index.json`）。原始文档正文埋在 <main> 的
 * theme-hope-content 容器内、且位于文件数十 KB 之后，直接 grep 或文件级截断
 * 读取都取不到 API 说明；本工具是脚本编写前确认 API 事实的唯一入口。
 *
 * 关键语义：查询返回 0 条即代表该符号不在离线文档中，调用方不得凭记忆补全。
 */

interface IndexChild {
  title: string;
  anchor: string;
}

interface IndexSection {
  page: string;
  anchor: string | null;
  level: number;
  title: string;
  symbol: string | null;
  module: string | null;
  owner?: string | null;
  generation: string;
  origin: string;
  priority: number;
  summary: string;
  text?: string;
  textTruncated?: boolean;
  pageLevel?: boolean;
  children?: IndexChild[];
}

interface AutojsIndex {
  schemaVersion: number;
  source: string;
  v5ScriptApiGeneration: string;
  generations: Record<string, string>;
  stats: Record<string, unknown>;
  symbols: string[];
  sections: IndexSection[];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/device/tools 与 dist/device/tools 深度一致，向上三层即 mcp 根
const PKG_ROOT = path.resolve(HERE, "..", "..", "..");
const DEFAULT_INDEX_PATH = path.resolve(PKG_ROOT, "docs", "autojs-index.json");

const SEARCH_DEFAULT_LIMIT = 8;
const SEARCH_MAX_LIMIT = 30;
const SEARCH_SUMMARY_CHARS = 240;
const READ_DEFAULT_CHARS = 6000;
const READ_MAX_CHARS = 20000;
const MODULE_LIST_LIMIT = 60;
const NEAREST_LIMIT = 10;
const OUTLINE_LIMIT = 120;

let cachedIndex: AutojsIndex | null = null;
let cachedError: string | null = null;

export function docsTools(): McpToolDefinition[] {
  return [
    createTool(
      "autojs_docs_search",
      "按符号或关键词检索随包 AutoJs 离线文档索引，用于确认 AutoJs 运行时 API（images.* / device.* / app.* / canvas.* 等）是否存在。写任何 AutoJs API 之前先用本工具确认；返回 0 条即代表该 AutoJs API 不在离线文档中，不得凭记忆补全。索引同时包含 v8（第一代 Rhino）和 v9（第二代 Node.js）：V5 默认用 Rhino，也可用 .node.js 文件或 \"nodejs\"; 脚本头进入 Node 引擎。注意：V5 平台工具名（如 device_screenshot、task_logs）不在本索引范围内，不要用本工具校验它们。",
      objectSchema({
        query: {
          type: "string",
          description: "AutoJs API 符号名（如 images.findMultiColors）或中文关键词。V5 平台工具名不适用。"
        },
        module: {
          type: "string",
          description: "限定模块（images、device、canvas 等）。只传 module 时列出该模块全部符号。"
        },
        generation: {
          type: "string",
          enum: ["all", "v8", "v9", "common"],
          default: "all",
          description: "API 代际过滤。v8 是 Rhino（V5 默认），v9 是 Node.js（V5 通过 .node.js 或 \"nodejs\"; 入口）。"
        },
        limit: { type: "number", default: SEARCH_DEFAULT_LIMIT }
      }),
      async args => searchDocs(args)
    ),
    createTool(
      "autojs_docs_read",
      "读取 autojs_docs_search 命中项的完整原文（参数、返回值、示例）。传 symbol 精确读取（仅限 AutoJs API；v9 类/接口成员可传 module.Owner.member 或其 runtime alias）；只传 page 返回该页大纲。",
      objectSchema({
        symbol: { type: "string", description: "符号名，如 images.findMultiColors。" },
        page: { type: "string", description: "文档页相对路径，如 v8/images.html。" },
        anchor: { type: "string", description: "小节锚点；与 page 一起精确定位。" },
        maxChars: { type: "number", default: READ_DEFAULT_CHARS }
      }),
      async args => readDocs(args)
    )
  ];
}

// ---- 索引加载 ----------------------------------------------------------

function envText(name: string): string | undefined {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function indexFilePath(): string {
  const override = envText("HZ_AUTOJS_DOCS_INDEX");
  return override ? path.resolve(override) : DEFAULT_INDEX_PATH;
}

function loadIndex(): { index?: AutojsIndex; error?: string } {
  if (cachedIndex) return { index: cachedIndex };
  if (cachedError) return { error: cachedError };
  const file = indexFilePath();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as AutojsIndex;
    if (!parsed || !Array.isArray(parsed.sections) || !Array.isArray(parsed.symbols)) {
      cachedError = `AutoJs 文档索引格式无效: ${file}`;
      return { error: cachedError };
    }
    cachedIndex = parsed;
    return { index: parsed };
  } catch (error) {
    cachedError = `无法读取 AutoJs 文档索引 (${file}): ${error instanceof Error ? error.message : String(error)}`;
    return { error: cachedError };
  }
}

// ---- 检索 --------------------------------------------------------------

function generationWarning(generation: string): string | undefined {
  if (generation !== "v9") return undefined;
  return "该符号属于第二代 Node.js API（V5 支持 Node 入口：文件名 .node.js 或脚本头 '\"nodejs\";' 才启用）。不要在 Rhino 脚本里直接混用；Node 入口会由 V5 用第二代引擎执行。";
}

function symbolAliases(section: IndexSection): string[] {
  const symbol = section.symbol ?? "";
  const parts = symbol.split(".");
  if (parts.length >= 3 && section.owner && parts[1] === section.owner) {
    return [`${parts[0]}.${parts.slice(2).join(".")}`];
  }
  return [];
}

function scoreSection(section: IndexSection, query: string): number {
  const q = query.toLowerCase();
  const symbol = (section.symbol ?? "").toLowerCase();
  const title = section.title.toLowerCase();
  const aliases = symbolAliases(section).map(alias => alias.toLowerCase());
  if (symbol && symbol === q) return 1000;
  if (aliases.includes(q)) return 1000;
  if (title === q) return 450;

  let score = 0;
  if (symbol && symbol.startsWith(q)) score = Math.max(score, 600);
  if (aliases.some(alias => alias.startsWith(q))) score = Math.max(score, 600);
  if (title.startsWith(q)) score = Math.max(score, 350);
  if (symbol && symbol.includes(q)) score = Math.max(score, 300);
  if (aliases.some(alias => alias.includes(q))) score = Math.max(score, 300);
  if (title.includes(q)) score = Math.max(score, 200);
  const summary = (section.summary ?? "").toLowerCase();
  if (summary.includes(q)) score = Math.max(score, 90);
  if (!score) {
    const text = (section.text ?? "").toLowerCase();
    if (text.includes(q)) score = Math.max(score, 60);
  }
  if (!score) {
    const tokens = q.split(/[\s,，。；;]+/).filter(Boolean);
    if (tokens.length > 1) {
      const haystack = `${symbol} ${title} ${summary}`;
      if (tokens.every(token => haystack.includes(token))) score = 40;
    }
  }
  return score;
}

function nearestSymbols(index: AutojsIndex, query: string, limit: number): string[] {
  const q = query.toLowerCase();
  const out: string[] = [];
  const aliases = index.sections
    .map(section => ({ full: section.symbol ?? "", aliases: symbolAliases(section) }))
    .filter(item => item.full);
  const dot = q.lastIndexOf(".");
  if (dot > 0) {
    const module = q.slice(0, dot);
    for (const item of aliases) {
      if (out.length >= limit) break;
      const values = [item.full, ...item.aliases].map(value => value.toLowerCase());
      if (values.some(value => value === q || value.startsWith(`${module}.`))) out.push(item.full);
    }
    if (out.length) return out;
  }
  const leaf = dot > 0 ? q.slice(dot + 1) : q;
  if (leaf.length < 3) return out;
  const prefix = leaf.slice(0, Math.min(6, leaf.length));
  for (const item of aliases) {
    if (out.length >= limit) break;
    const values = [item.full, ...item.aliases].map(value => value.toLowerCase());
    const segment = values.map(value => value.split(".").pop() ?? "").find(value => value.includes(leaf) || value.startsWith(prefix));
    if (segment) out.push(item.full);
  }
  return out;
}

function looksLikeSymbol(query: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(query) || /^[A-Za-z_$][\w$]{2,}$/.test(query);
}

function listModule(index: AutojsIndex, module: string, generation: string, limit: number): JsonObject {
  const moduleLower = module.toLowerCase();
  const sections = index.sections.filter(section =>
    (section.module ?? "").toLowerCase() === moduleLower &&
    (generation === "all" || section.generation === generation)
  );
  const symbols = [...new Set(sections.map(section => section.symbol).filter(Boolean))] as string[];
  if (symbols.length) {
    return {
      module,
      kind: "symbols",
      total: symbols.length,
      symbols: symbols.slice(0, limit),
      truncated: symbols.length > limit
    };
  }
  const topics = sections.map(section => {
    const entry: JsonObject = {
      title: section.title,
      page: section.page,
      anchor: section.anchor,
      generation: section.generation
    };
    const warning = generationWarning(section.generation);
    if (warning) entry.generationWarning = warning;
    return entry;
  });
  return {
    module,
    kind: topics.length ? "topics" : "none",
    total: topics.length,
    topics: topics.slice(0, limit)
  };
}

async function searchDocs(args: JsonObject) {
  const loaded = loadIndex();
  if (!loaded.index) return fail("DOCS_INDEX_UNAVAILABLE", loaded.error ?? "文档索引不可用");

  const query = optionalString(args, "query");
  const module = optionalString(args, "module");
  const generation = optionalString(args, "generation") ?? "all";
  const limit = clamp(optionalNumber(args, "limit", SEARCH_DEFAULT_LIMIT) ?? SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
  const index = loaded.index;

  if (!query && !module) {
    return fail("INVALID_ARGUMENT", "必须提供 query（符号或关键词）或 module（模块名）之一。", {
      indexedSymbols: index.stats.symbols,
      indexedSections: index.stats.sections,
      example: { query: "images.findMultiColors" }
    });
  }

  // 模块清单模式
  if (!query && module) {
    return ok(`模块 ${module} 的索引清单。`, {
      mode: "list",
      ...listModule(index, module, generation, MODULE_LIST_LIMIT)
    });
  }

  const matches = index.sections
    .filter(section => generation === "all" || section.generation === generation)
    .filter(section => !module || (section.module ?? "").toLowerCase() === module.toLowerCase())
    .map(section => ({ section, score: scoreSection(section, query as string) }))
    .filter(item => item.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      a.section.priority - b.section.priority ||
      String(a.section.symbol ?? "").localeCompare(String(b.section.symbol ?? "")) ||
      a.section.page.localeCompare(b.section.page)
    );

  if (!matches.length) {
    const suggestions = nearestSymbols(index, query as string, NEAREST_LIMIT);
    const symbolLike = looksLikeSymbol(query as string);
    const conclusion = symbolLike
      ? `离线文档中没有 "${query}" 这个符号，不得凭记忆使用。`
      : `离线文档中没有匹配 "${query}" 的内容。`;
    return ok(conclusion, {
      mode: "search",
      query,
      matched: 0,
      symbolNotFound: symbolLike,
      conclusion,
      suggestions: suggestions.length ? suggestions : undefined,
      suggestionHint: suggestions.length
        ? "以上是该模块/前缀下的可用符号，请从中选择。"
        : "该前缀下没有可用符号；请改用更短的模块名检索，如 images 或 device。",
      indexedSymbols: index.stats.symbols
    });
  }

  const top = matches.slice(0, limit).map(item => {
    const section = item.section;
    const entry: JsonObject = {
      symbol: section.symbol,
      title: section.title,
      page: section.page,
      anchor: section.anchor,
      generation: section.generation,
      origin: section.origin,
      summary: truncate(section.summary, SEARCH_SUMMARY_CHARS)
    };
    const warning = generationWarning(section.generation);
    if (warning) entry.generationWarning = warning;
    return entry;
  });

  return ok(`匹配 ${matches.length} 条，返回前 ${top.length} 条。`, {
    mode: "search",
    query,
    matched: matches.length,
    returned: top.length,
    truncated: matches.length > top.length,
    matches: top,
    readHint: "用 autojs_docs_read 传 symbol 或 page+anchor 读取完整原文。"
  });
}

// ---- 读取 --------------------------------------------------------------

async function readDocs(args: JsonObject) {
  const loaded = loadIndex();
  if (!loaded.index) return fail("DOCS_INDEX_UNAVAILABLE", loaded.error ?? "文档索引不可用");

  const symbol = optionalString(args, "symbol");
  const page = optionalString(args, "page");
  const anchor = optionalString(args, "anchor");
  const maxChars = clamp(optionalNumber(args, "maxChars", READ_DEFAULT_CHARS) ?? READ_DEFAULT_CHARS, 1, READ_MAX_CHARS);
  const index = loaded.index;

  if (!symbol && !page) {
    return fail("INVALID_ARGUMENT", "必须提供 symbol，或 page（可带 anchor）。");
  }

  if (symbol) {
    const exact = index.sections.filter(section => section.symbol === symbol);
    const aliasMatches = index.sections.filter(section =>
      symbolAliases(section).some(alias => alias.toLowerCase() === symbol.toLowerCase())
    );
    const candidates = exact.length ? exact : aliasMatches;
    if (!candidates.length) {
      const caseInsensitive = index.sections.filter(section =>
        (section.symbol ?? "").toLowerCase() === symbol.toLowerCase()
        || symbolAliases(section).some(alias => alias.toLowerCase() === symbol.toLowerCase())
      );
      if (!caseInsensitive.length) {
        const suggestions = nearestSymbols(index, symbol, NEAREST_LIMIT);
        const conclusion = `离线文档中没有 "${symbol}" 这个符号，不得凭记忆使用。`;
        return ok(conclusion, {
          mode: "read",
          symbol,
          found: false,
          symbolNotFound: true,
          conclusion,
          suggestions: suggestions.length ? suggestions : undefined
        });
      }
      const altCase = caseInsensitive
        .slice(1)
        .map(section => section.symbol)
        .filter((value): value is string => Boolean(value));
      return readSection(caseInsensitive[0], maxChars, altCase);
    }
    // 同符号跨代际时优先低优先级（v8 优先）
    const sorted = candidates.slice().sort((a, b) => a.priority - b.priority);
    const others = sorted.slice(1).map(section => `${section.symbol}@${section.generation}`);
    return readSection(sorted[0], maxChars, others);
  }

  const pageSections = index.sections.filter(section => section.page === page);
  if (!pageSections.length) {
    return fail("PAGE_NOT_FOUND", `索引中没有页面 ${page}。`, {
      examplePages: index.sections.slice(0, 5).map(section => section.page)
    });
  }

  if (anchor) {
    const target = pageSections.find(section => section.anchor === anchor);
    if (!target) {
      return fail("ANCHOR_NOT_FOUND", `页面 ${page} 中没有锚点 ${anchor}。`, {
        availableAnchors: pageSections
          .map(section => section.anchor)
          .filter((value): value is string => Boolean(value))
          .slice(0, 40)
      });
    }
    return readSection(target, maxChars);
  }

  // 只给 page：返回大纲
  return ok(`页面 ${page} 的大纲。`, {
    mode: "outline",
    page,
    sectionCount: pageSections.length,
    outline: pageSections.slice(0, OUTLINE_LIMIT).map(section => {
      const entry: JsonObject = {
        level: section.level,
        title: section.title,
        anchor: section.anchor
      };
      if (section.symbol) entry.symbol = section.symbol;
      return entry;
    }),
    truncated: pageSections.length > OUTLINE_LIMIT,
    readHint: "用 autojs_docs_read 传 symbol 或 page+anchor 读取完整原文。"
  });
}

function readSection(section: IndexSection, maxChars: number, alternates?: string[]) {
  const text = section.text ?? "";
  const truncated = text.length > maxChars;
  const data: JsonObject = {
    mode: "read",
    found: true,
    symbol: section.symbol,
    title: section.title,
    page: section.page,
    anchor: section.anchor,
    generation: section.generation,
    origin: section.origin,
    text: truncated ? text.slice(0, maxChars) : text,
    textTruncated: truncated || Boolean(section.textTruncated),
    originalChars: text.length
  };
  if (section.children?.length) data.children = section.children;
  if (alternates?.length) data.alternates = alternates;
  const warning = generationWarning(section.generation);
  if (warning) data.generationWarning = warning;
  return ok(`${section.symbol ?? section.title} 的文档原文。`, data);
}

// ---- 工具函数 ----------------------------------------------------------

function truncate(text: string, maxChars: number): string {
  const value = text ?? "";
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}
