#!/usr/bin/env node
/**
 * 从随包 AutoJs 离线文档（VuePress 预渲染 HTML）蒸馏出符号级索引。
 *
 * 背景：
 *   `mcp/docs/autojs/` 是 VuePress 构建产物，正文埋在 <main> 的
 *   `theme-hope-content` 容器里，前面几十 KB 全是侧边栏与目录。
 *   直接 grep 命中不到 API 正文，文件级截断读取（如只读前 32KB）永远错过正文。
 *
 * 三类页面结构不同，需分别处理：
 *   1. v8 API 页：标题自带模块前缀，如 `images.findMultiColors(...)`、`Image.getWidth()`。
 *   2. v9 TypeDoc 页（`v9/generated/**`）：h2 是类型分组（变量/函数/类/枚举），
 *      h3 是裸符号名（如 `getAppName`）；模块名来自页面文件名。
 *   3. 指南/博客页：标题是自然语言主题，没有 API 符号。
 *
 * 产出：
 *   `mcp/docs/autojs-index.json` —— 符号级索引。
 *   同一份文件既供插件侧 device MCP 查询，也供 V5 AI 工作台检索。
 *
 * 用法：
 *   node mcp/scripts/build-autojs-index.mjs
 *   node mcp/scripts/build-autojs-index.mjs --check   # 只校验，不写文件
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, "..");
const DOCS_ROOT = path.resolve(PKG_ROOT, "docs", "autojs");
const OUT_FILE = path.resolve(PKG_ROOT, "docs", "autojs-index.json");

const SCHEMA_VERSION = 1;
const MAX_TEXT_CHARS = 6000;
const MAX_SUMMARY_CHARS = 260;
const CHECK_ONLY = process.argv.includes("--check");

// v9 TypeDoc 的 h2 分组标题（这些是分类，不是符号）
const V9_GROUP_TITLES = new Set([
  "目录", "变量", "函数", "类", "接口", "枚举", "类型别名", "属性", "方法", "构造函数",
  "Accessors", "Constructors", "Properties", "Methods", "Functions", "Variables",
  "Classes", "Interfaces", "Enums", "Type Aliases", "Hierarchy", "Index"
]);

// ---- 来源分类 ----------------------------------------------------------
// v8 = 第一代 Rhino API，V5 脚本运行时默认引擎。
// v9 = 第二代 Node.js API，V5 通过 Node 入口（文件名 .node.js 或脚本头 "nodejs";）支持。
function classify(rel) {
  const p = rel.replace(/\\/g, "/");
  // runtime/ = 官方文档未收录、但 V5 真机运行时实证存在的公开能力。
  // 与官方页分开来源，检索结果里会带 origin=runtime，避免与官方文档混淆。
  // runtime/v9/ 收录 Node（第二代）入口的实证能力，标题即完整符号。
  if (p.startsWith("runtime/v9/")) {
    return { generation: "v9", origin: "runtime", priority: 3, typedoc: false, fullSymbol: true };
  }
  if (p.startsWith("runtime/")) {
    return { generation: "v8", origin: "runtime", priority: 2, typedoc: false };
  }
  if (p.startsWith("v8/")) {
    // v8 API 文档页位于 v8 根目录（images.html / device.html ...），指南在 v8/automator 等
    return { generation: "v8", origin: "api", priority: 1, typedoc: false };
  }
  if (p.startsWith("v9/generated/")) {
    return { generation: "v9", origin: "api", priority: 3, typedoc: true };
  }
  if (p.startsWith("v9/")) {
    return { generation: "v9", origin: "guide", priority: 4, typedoc: false };
  }
  if (p.startsWith("blog/")) {
    return { generation: "common", origin: "blog", priority: 5, typedoc: false };
  }
  return { generation: "common", origin: "guide", priority: 2, typedoc: false };
}

// ---- HTML → 纯文本 -----------------------------------------------------
function decodeEntities(input) {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // &amp; 必须最后解，避免 "&amp;lt;" 被误还原成 "<"
    .replace(/&amp;/g, "&");
}

function htmlToText(html) {
  let s = html;
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote|table|thead|tbody|dd|dt)>/gi, "\n");
  s = s.replace(/<\/(td|th)>/gi, "\t");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

// ---- 正文容器定位 ------------------------------------------------------
function extractMain(html) {
  const mStart = html.search(/<main[\s>]/);
  if (mStart < 0) return null;
  const mEnd = html.indexOf("</main>", mStart);
  return html.slice(mStart, mEnd < 0 ? undefined : mEnd);
}

// 正文结束标记：随包文档来自两个 VuePress 构建（beta.66 用 vp-page-nav，beta.51 用 page-nav），
// 两者页脚都是 page-meta。取正文起点之后最早出现的标记，避免把页脚与翻页导航并进最后一节。
const CONTENT_END_MARKERS = [
  '<nav class="vp-page-nav">',
  '<nav class="page-nav">',
  '<footer class="page-meta">'
];

function extractContent(main) {
  const cStart = main.indexOf('<div class="theme-hope-content">');
  if (cStart < 0) return null;
  let end = main.length;
  for (const marker of CONTENT_END_MARKERS) {
    const index = main.indexOf(marker, cStart);
    if (index > cStart && index < end) end = index;
  }
  return main.slice(cStart, end);
}

function pageTitle(html) {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return null;
  const t = htmlToText(m[1]).replace(/\s*\|.*$/, "").trim();
  return t || null;
}

// ---- 标题收集 ----------------------------------------------------------
function collectHeadings(content) {
  const re = /<(h[1-6])\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
  const out = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    out.push({
      level: Number(m[1].slice(1)),
      id: m[2],
      title: htmlToText(m[3]).replace(/^#+\s*/, "").replace(/\s+/g, " ").trim(),
      start: m.index,
      contentStart: m.index + m[0].length
    });
  }
  return out;
}

// ---- 符号提取 ----------------------------------------------------------
// v8：标题形如 images.findMultiColors(...) / Image.getWidth() / Point.x
const V8_SYMBOL_RE = /^(\$?[A-Za-z_][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/;

function v8Symbol(title) {
  const m = V8_SYMBOL_RE.exec(title);
  return m ? m[1] : null;
}

function moduleOf(symbol) {
  if (!symbol) return null;
  const i = symbol.indexOf(".");
  return i < 0 ? symbol : symbol.slice(0, i);
}

// v9 模块名来自页面文件名，如 v9/generated/modules/app.html -> "app"
function v9ModuleOf(rel) {
  const base = path.basename(rel).replace(/\.html?$/i, "");
  return base === "index" ? null : base;
}

// v9 类/接口页文件名形如 accessibility.Accessibility.html / ui_selector.UiSelector.html。
// 这些页面承载实例成员；符号按 module.Owner.member 收录，避免同名成员互相覆盖。
function v9TypePageOf(rel) {
  const m = /^v9\/generated\/(classes|interfaces)\/([^./]+)\.([^./]+)\.html$/i.exec(rel);
  if (!m) return null;
  return {
    kind: m[1] === "classes" ? "class" : "interface",
    module: m[2],
    owner: m[3]
  };
}

// ---- 摘要 --------------------------------------------------------------
function buildSummary(text) {
  const lines = text
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !/^Stability:\s*\d/i.test(line));
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length <= MAX_SUMMARY_CHARS) return joined;
  const cut = joined.slice(0, MAX_SUMMARY_CHARS);
  const lastStop = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"), cut.lastIndexOf("."));
  return (lastStop > MAX_SUMMARY_CHARS * 0.5 ? cut.slice(0, lastStop + 1) : cut).trim();
}

function capText(text) {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

// ---- 遍历文档 ----------------------------------------------------------
function walkHtml(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // assets/ 只放图片与打包 JS，没有正文
      if (entry.name === "assets" || entry.name === "image") continue;
      walkHtml(full, base, acc);
    } else if (entry.name.toLowerCase().endsWith(".html")) {
      acc.push(path.relative(base, full).replace(/\\/g, "/"));
    }
  }
  return acc;
}

function buildPage(rel, meta, html) {
  const main = extractMain(html);
  const content = main ? extractContent(main) : null;
  if (!content) return { records: [], reason: "未找到 theme-hope-content 正文容器" };

  const records = [];
  const headings = collectHeadings(content);
  const v9Module = meta.typedoc ? v9ModuleOf(rel) : null;
  const v9TypePage = meta.typedoc ? v9TypePageOf(rel) : null;
  const v9ModuleName = v9TypePage ? v9TypePage.module : v9Module;

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (h.level < 2 || h.level > 3) continue; // h1 是页面标题，h4+ 是参数/返回值细节

    // 本节自有正文：到下一个任意级别标题为止
    const ownEnd = i + 1 < headings.length ? headings[i + 1].start : content.length;
    const ownText = htmlToText(content.slice(h.contentStart, ownEnd));
    if (!ownText) continue; // 纯分组标题、无正文，跳过噪音

    let symbol = null;
    let owner = null;
    if (meta.typedoc) {
      if (h.level !== 3) continue;                       // v9 TypeDoc 的 h2 只是分组
      if (V9_GROUP_TITLES.has(h.title)) continue;        // 目录里的分组标题
      if (!/^[A-Za-z_$][\w$]*$/.test(h.title)) continue; // 符号必须是裸标识符
      if (v9TypePage) {
        owner = v9TypePage.owner;
        symbol = `${v9TypePage.module}.${v9TypePage.owner}.${h.title}`;
      } else {
        symbol = v9ModuleName ? `${v9ModuleName}.${h.title}` : h.title;
      }
    } else if (meta.fullSymbol) {
      symbol = v8Symbol(h.title) ?? h.title.trim();
    } else if (meta.generation === "v8" && (meta.origin === "api" || meta.origin === "runtime")) {
      symbol = v8Symbol(h.title);
    }

    // 直接子节（仅用于提示下钻）
    const children = [];
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) break;
      if (headings[j].level === h.level + 1) {
        children.push({ title: headings[j].title, anchor: headings[j].id });
      }
    }

    const capped = capText(ownText);
    const record = {
      page: rel,
      anchor: h.id,
      level: h.level,
      title: h.title,
      symbol,
      ...(owner ? { owner } : {}),
      module: moduleOf(symbol),
      generation: meta.generation,
      origin: meta.origin,
      priority: meta.priority,
      summary: buildSummary(ownText)
    };
    if (capped.text) record.text = capped.text;
    if (capped.truncated) record.textTruncated = true;
    if (children.length) record.children = children;
    records.push(record);
  }

  // 无小节标题的整页正文，仍以页面级记录入索引，避免漏掉可检索内容
  if (!records.length) {
    const whole = htmlToText(content);
    if (!whole) return { records: [], reason: "正文为空" };
    const capped = capText(whole);
    records.push({
      page: rel,
      anchor: null,
      level: 1,
      title: pageTitle(html) || rel,
      symbol: null,
      module: meta.typedoc ? (v9TypePage ? v9TypePage.module : v9ModuleOf(rel)) : null,
      generation: meta.generation,
      origin: meta.origin,
      priority: meta.priority,
      pageLevel: true,
      summary: buildSummary(whole),
      ...(capped.text ? { text: capped.text } : {}),
      ...(capped.truncated ? { textTruncated: true } : {})
    });
  }
  return { records };
}

function build() {
  if (!fs.existsSync(DOCS_ROOT)) {
    throw new Error(`未找到离线文档目录: ${DOCS_ROOT}`);
  }
  const pages = walkHtml(DOCS_ROOT).sort();
  const sections = [];
  const skipped = [];

  for (const rel of pages) {
    const meta = classify(rel);
    const html = fs.readFileSync(path.join(DOCS_ROOT, rel), "utf8");
    const { records, reason } = buildPage(rel, meta, html);
    if (reason) skipped.push({ page: rel, reason });
    sections.push(...records);
  }

  sections.sort((a, b) =>
    a.priority - b.priority ||
    String(a.symbol ?? "").localeCompare(String(b.symbol ?? "")) ||
    a.page.localeCompare(b.page) ||
    String(a.anchor ?? "").localeCompare(String(b.anchor ?? ""))
  );

  const symbols = [...new Set(sections.map(s => s.symbol).filter(Boolean))].sort();
  const byGeneration = {};
  for (const s of sections) {
    const g = byGeneration[s.generation] = byGeneration[s.generation] || { sections: 0, symbols: 0, topics: 0 };
    g.sections++;
    if (s.symbol) g.symbols++; else g.topics++;
  }

  const index = {
    schemaVersion: SCHEMA_VERSION,
    source: "mcp/docs/autojs",
    v5ScriptApiGeneration: "v8+v9",
    generations: {
      v8: "第一代 Rhino API，V5 脚本运行时默认引擎",
      v9: "第二代 Node.js API，需脚本头 '\"nodejs\";' 才启用，V5 通过 .node.js 文件或脚本头进入 Node 引擎执行",
      common: "指南与博客，代际中立"
    },
    stats: {
      pages: pages.length,
      indexedPages: pages.length - skipped.length,
      sections: sections.length,
      symbols: symbols.length,
      byGeneration
    },
    symbols,
    sections
  };
  if (skipped.length) index.skipped = skipped;
  return index;
}

// ---- 主流程 ------------------------------------------------------------
const index = build();
const json = JSON.stringify(index, null, 1);
const bytes = Buffer.byteLength(json, "utf8");

console.log(`文档页数      : ${index.stats.pages}（已索引 ${index.stats.indexedPages}）`);
console.log(`小节数        : ${index.stats.sections}`);
console.log(`API 符号数    : ${index.stats.symbols}`);
console.log(`代际分布      : ${JSON.stringify(index.stats.byGeneration)}`);
console.log(`索引体积      : ${(bytes / 1024).toFixed(1)} KB`);
if (index.skipped) {
  console.log(`跳过页        : ${index.skipped.length}`);
  for (const s of index.skipped) console.log(`   - ${s.page}: ${s.reason}`);
}

if (CHECK_ONLY) {
  // 校验模式：不仅确认索引可生成，还要确认磁盘上的产物与最新生成结果一致。
  // 用于在构建/CI 中拦住"改了文档 HTML 但忘了重建索引"的情况。
  const expected = Buffer.from(json + "\n", "utf8");
  if (!fs.existsSync(OUT_FILE)) {
    console.error(`索引产物缺失: ${path.relative(PKG_ROOT, OUT_FILE).replace(/\\/g, "/")}`);
    console.error("请执行: npm run docs:index");
    process.exit(1);
  }
  const actual = fs.readFileSync(OUT_FILE);
  if (!actual.equals(expected)) {
    console.error("索引产物已过期：磁盘内容与最新生成结果不一致。");
    console.error("请执行: npm run docs:index");
    process.exit(1);
  }
  console.log("--check 通过：索引产物与最新生成结果一致。");
  process.exit(0);
}
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, json + "\n", "utf8");
console.log(`已写入        : ${path.relative(PKG_ROOT, OUT_FILE).replace(/\\/g, "/")}`);
