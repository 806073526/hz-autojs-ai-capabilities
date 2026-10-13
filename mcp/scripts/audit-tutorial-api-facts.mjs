// AutoJs 教程语料 API 事实核对：把语料里出现的「模块.成员」逐个对离线索引、官方例子、引擎模块源码取证。
// 输出：occurrences.json（逐条明细）、audit-report.md、audit-summary.json 到 --out 目录。
// 用法：node mcp/scripts/audit-tutorial-api-facts.mjs [--root <集合根>] [--corpus <教程文档目录>] [--index <autojs-index.json>] [--out <输出目录>]
// 调用方与结论见 docs/planning/autojs-tutorial-corpus-audit.md。
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const ROOT = argOf("--root", process.cwd());
const CORPUS = argOf("--corpus", path.join(ROOT, "legacy/otherProject/教程文档"));
const INDEX_PATH = argOf("--index", path.join(ROOT, "hz_autojs_toolbox_ai_capabilities/mcp/docs/autojs-index.json"));
const OUT = argOf("--out", path.join(ROOT, ".codex-tmp/autojs-corpus-audit"));
fs.mkdirSync(OUT, { recursive: true });

const SCOPES = [
  { id: "gen1-docs", gen: "v8", kind: "doc", root: path.join(CORPUS, "第一代引擎教程文档/教程总结"), exts: [".md"] },
  { id: "gen1-examples", gen: "v8", kind: "code", root: path.join(CORPUS, "第一代引擎教程文档/第一代引擎的官方例子"), exts: [".js", ".json", ".xml", ".html"] },
  { id: "gen2-docs", gen: "v9", kind: "doc", root: path.join(CORPUS, "第二代引擎教程文档/教程总结"), exts: [".md"] },
  { id: "gen2-detail", gen: "v9", kind: "doc", root: path.join(CORPUS, "第二代引擎教程文档/详细例子"), exts: [".md"] },
  { id: "gen2-examples", gen: "v9", kind: "code", root: path.join(CORPUS, "第二代引擎教程文档/第二代引擎的官方例子"), exts: [".js", ".json", ".xml", ".html", ".vue", ".css"] }
];

const RHINO_DIR = path.join(CORPUS, "第一代引擎教程文档/rhino-modules");
const NODE_MODULES_DIR = path.join(CORPUS, "第二代引擎教程文档/nodejs-modules");

const MODULE_ALIASES = [
  "auto", "ui", "$ui", "$autojs", "$java", "runtime", "window", "notification", "$notifications",
  "workManager", "powerManager", "webSocket", "media_projection", "root_automator", "lazy_ui_object",
  "coroutines", "worker_threads", "handler_thread", "java_utils", "websocket", "timers", "globals",
  "toast", "lang", "clip_manager", "datastore", "floating_window", "accessibility", "opencv", "color",
  "axios", "Image", "images", "$images", "crypto", "base64", "keys", "OCR", "OCRResult", "Selector",
  "selector", "automator", "canvas", "colors", "console", "device", "dialogs", "engines",
  "events", "files", "floaty", "http", "media", "ocr", "plugins", "sensors", "settings", "shell",
  "storages", "threads", "util", "zip", "app", "sqlite", "bridges", "continuation", "memory"
];

const FENCE_EXT = new Set([
  "js", "mjs", "cjs", "md", "markdown", "json", "ts", "tsx", "vue", "html", "htm", "css", "xml",
  "png", "jpg", "jpeg", "gif", "webp", "txt", "sh", "ps1", "psm1", "yml", "yaml", "map", "node",
  "ignore", "gitignore", "log", "csv", "zip", "apk", "dex", "jar", "so", "class", "exe", "bat",
  "cmd", "py", "java", "kt", "lock", "min", "prototype", "constructor"
]);

const index = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
const indexText = fs.readFileSync(INDEX_PATH, "utf8");

const gens = { v8: { symbols: new Set(), moduleText: new Map() }, v9: { symbols: new Set(), moduleText: new Map() } };
/** 各代际实际出现的模块名，用于识别 camelCase 与 snake_case 的同一模块。 */
const genModuleNames = { v8: {}, v9: {} };
const modules = new Set(MODULE_ALIASES);
for (const section of index.sections) {
  const generation = section.generation === "v9" ? "v9" : "v8";
  const bucket = gens[generation];
  if (section.symbol) bucket.symbols.add(section.symbol);
  if (section.module) {
    modules.add(section.module);
    genModuleNames[generation][section.module] = true;
    const prev = bucket.moduleText.get(section.module) || "";
    bucket.moduleText.set(section.module, prev + "\n" + (section.title || "") + "\n" + (section.text || ""));
  }
}
for (const symbol of index.symbols) {
  const mod = symbol.split(".")[0];
  if (gens.v9.symbols.has(symbol)) continue;
  if (gens.v8.symbols.has(symbol)) continue;
  // symbols 汇总里跨代际存在的条目，按模块归属补齐
  if (gens[v9ModuleSet().has(mod) ? "v9" : "v8"]) {}
}
function v9ModuleSet() {
  const set = new Set();
  for (const section of index.sections) if (section.generation === "v9" && section.module) set.add(section.module);
  return set;
}

function walk(root, exts, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) walk(full, exts, out);
    else if (exts.includes(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const v8SourceFiles = walk(RHINO_DIR, [".js"]).filter(f => !f.includes("node_modules"));
const v9SourceFiles = walk(NODE_MODULES_DIR, [".js"]).filter(f => !f.includes("node_modules"));
const v9SourceByModule = new Map();
for (const file of v9SourceFiles) {
  const name = path.basename(file, ".js");
  if (!v9SourceByModule.has(name)) v9SourceByModule.set(name, []);
  v9SourceByModule.get(name).push(file);
}
const v8SourceByModule = new Map();
for (const file of v8SourceFiles) {
  const m = /^__(.+?)__\.js$/.exec(path.basename(file));
  if (m) {
    if (!v8SourceByModule.has(m[1])) v8SourceByModule.set(m[1], []);
    v8SourceByModule.get(m[1]).push(file);
  }
}
const sourceCache = new Map();
const readFileCached = file => {
  if (!sourceCache.has(file)) sourceCache.set(file, fs.readFileSync(file, "utf8"));
  return sourceCache.get(file);
};
function sourceEvidence(gen, mod, member, token) {
  const candidates = [];
  if (gen === "v8") {
    const bare = mod.replace(/^\$/, "");
    for (const key of [mod, bare, "$" + bare]) if (v8SourceByModule.has(key)) candidates.push(...v8SourceByModule.get(key));
  } else if (v9SourceByModule.has(mod)) {
    candidates.push(...v9SourceByModule.get(mod));
  }
  const word = new RegExp("\\b" + member.replace(/[$]/g, "\\$") + "\\b");
  for (const file of candidates) if (word.test(readFileCached(file))) return "module-file:" + path.basename(file);
  const pool = gen === "v8" ? v8SourceFiles : v9SourceFiles;
  for (const file of pool) if (readFileCached(file).includes(token)) return "token:" + path.basename(file);
  const definition = new RegExp("(?:^|[^A-Za-z0-9_$])" + member.replace(/[$]/g, "\\$") + "\\s*(?::|=|\\()", "m");
  for (const file of pool) if (definition.test(readFileCached(file))) return "def:" + path.basename(file);
  return "";
}

const exampleText = SCOPES.filter(s => s.kind === "code").flatMap(s => walk(s.root, s.exts)).map(f => fs.readFileSync(f, "utf8")).join("\n");

/** 同一 API 在离线文档里存在带前缀的别名叫法（ui 模块与内部对象写法互为别名）。 */
function aliasToken(token) {
  return token.startsWith("$") ? token.slice(1) : "$" + token;
}

/** 模块名写法差异：workManager 与文档里的 work_manager、powerManager 与 power_manager 等同属一个模块。 */
function moduleVariants(moduleName, generation) {
  const variants = new Set([moduleName, aliasToken(moduleName)]);
  const normalized = moduleName.replace(/_/g, "").toLowerCase();
  for (const name of Object.keys(genModuleNames[generation])) {
    if (name.replace(/_/g, "").toLowerCase() === normalized) variants.add(name);
  }
  return [...variants];
}

function support(token, member, generation) {
  const bucket = gens[generation];
  for (const moduleName of moduleVariants(token.split(".")[0], generation)) {
    const candidate = moduleName + "." + member;
    if (bucket.symbols.has(candidate)) return "symbol";
    const text = bucket.moduleText.get(moduleName);
    if (!text) continue;
    if (text.includes(candidate)) return "page";
    const word = new RegExp("\\b" + member.replace(/[$]/g, "\\$") + "\\b");
    if (word.test(text)) return "member";
  }
  return "";
}

const TOKEN_RE = /(?<![A-Za-z0-9_$.])(\$?[A-Za-z_][A-Za-z0-9_$]*)\.([A-Za-z_][A-Za-z0-9_$]*)/g;
const URL_PREFIX = /^https?$/i;

const occurrences = [];
for (const scope of SCOPES) {
  const files = walk(scope.root, scope.exts).sort();
  scope.files = files.length;
  for (const file of files) {
    const rel = path.relative(CORPUS, file).replace(/\\/g, "/");
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, idx) => {
      TOKEN_RE.lastIndex = 0;
      let match;
      while ((match = TOKEN_RE.exec(line))) {
        const mod = match[1], member = match[2];
        if (!modules.has(mod) || URL_PREFIX.test(mod) || FENCE_EXT.has(member.toLowerCase())) continue;
        occurrences.push({ scope: scope.id, gen: scope.gen, kind: scope.kind, file: rel, line: idx + 1, token: mod + "." + member, mod, member, text: line.trim().slice(0, 160) });
      }
    });
  }
}

const sourceMemo = new Map();
for (const occ of occurrences) {
  const own = support(occ.token, occ.member, occ.gen);
  const other = support(occ.token, occ.member, occ.gen === "v8" ? "v9" : "v8");
  if (own === "symbol") occ.evidence = "symbol";
  else if (own === "page") occ.evidence = "doc-page";
  else if (own === "member") occ.evidence = "doc-member";
  else if (other === "symbol") occ.evidence = "other-gen-symbol";
  else if (other === "page" || other === "member") occ.evidence = "other-gen-doc";
  else if (exampleText.includes(occ.token)) occ.evidence = "example";
  else {
    const key = occ.gen + "|" + occ.token;
    if (!sourceMemo.has(key)) sourceMemo.set(key, sourceEvidence(occ.gen, occ.mod, occ.member, occ.token));
    const hit = sourceMemo.get(key);
    occ.sourceHit = hit;
    occ.evidence = hit ? (hit.startsWith("def:") ? "source-weak" : "source") : "none";
  }
}

fs.writeFileSync(path.join(OUT, "occurrences.json"), JSON.stringify(occurrences, null, 1), "utf8");

const CLASSES = ["symbol", "doc-page", "doc-member", "other-gen-symbol", "other-gen-doc", "example", "source", "source-weak", "none"];
const byScope = new Map();
for (const scope of SCOPES) byScope.set(scope.id, { total: 0, evidence: {} });
const aggregated = new Map();
for (const occ of occurrences) {
  const scope = byScope.get(occ.scope);
  scope.total += 1;
  scope.evidence[occ.evidence] = (scope.evidence[occ.evidence] || 0) + 1;
  if (!aggregated.has(occ.token)) aggregated.set(occ.token, { token: occ.token, count: 0, evidence: new Set(), scopes: new Set(), sourceHit: "", sample: occ });
  const rec = aggregated.get(occ.token);
  rec.count += 1;
  rec.evidence.add(occ.evidence);
  rec.scopes.add(occ.scope);
  if (occ.sourceHit) rec.sourceHit = occ.sourceHit;
}

const pick = name => [...aggregated.values()].filter(r => r.evidence.has(name)).sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
const sourceBacked = pick("source");
const sourceWeak = pick("source-weak");
const noneBacked = pick("none");
const crossgenRisk = [...aggregated.values()].filter(r => r.evidence.has("other-gen-symbol") && !r.evidence.has("symbol") && !r.evidence.has("doc-page") && !r.evidence.has("doc-member")).sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));

const totals = {};
for (const occ of occurrences) totals[occ.evidence] = (totals[occ.evidence] || 0) + 1;

const lines = [];
lines.push("# A 步骤：AutoJs 教程语料 API 事实核对报告");
lines.push("");
lines.push("取证据顺序（按文档目标代际分别取证）：本代际符号 → 本代际模块页正文 → 本代际模块页成员名 → 另一代际符号 → 另一代际正文 → 官方例子 → 引擎模块源码 → 无依据。");
lines.push("");
lines.push("| 范围 | 代际 | 文件数 | 引用点 | 符号 | 模块页正文 | 成员名 | 跨代际符号 | 跨代际正文 | 官方例子 | 源码实证 | 源码弱证 | 无依据 |");
lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const scope of SCOPES) {
  const e = byScope.get(scope.id).evidence;
  lines.push(`| ${scope.id} | ${scope.gen} | ${scope.files} | ${byScope.get(scope.id).total} | ${e.symbol || 0} | ${e["doc-page"] || 0} | ${e["doc-member"] || 0} | ${e["other-gen-symbol"] || 0} | ${e["other-gen-doc"] || 0} | ${e.example || 0} | ${e.source || 0} | ${e["source-weak"] || 0} | ${e.none || 0} |`);
}
lines.push(`| **合计** |  |  | ${occurrences.length} | ${totals.symbol || 0} | ${totals["doc-page"] || 0} | ${totals["doc-member"] || 0} | ${totals["other-gen-symbol"] || 0} | ${totals["other-gen-doc"] || 0} | ${totals.example || 0} | ${totals.source || 0} | ${totals["source-weak"] || 0} | ${totals.none || 0} |`);
lines.push("");
lines.push(`去重符号 ${aggregated.size} 个：源码实证 **${sourceBacked.length}**、源码弱证 **${sourceWeak.length}**、无依据 **${noneBacked.length}**、跨代际风险 **${crossgenRisk.length}**。`);
lines.push("");
lines.push("## 1. 源码实证（官方文档没有，引擎模块源码里有 → 「高级用法」知识来源）");
lines.push("");
lines.push("| 符号 | 次数 | 涉及范围 | 源码定位 | 示例 |");
lines.push("|---|---|---|---|---|");
for (const r of sourceBacked) lines.push(`| ${r.token} | ${r.count} | ${[...r.scopes].join(",")} | ${r.sourceHit} | ${(r.sample.text || "").replace(/\|/g, "/")} |`);
lines.push("");
lines.push("## 1b. 源码弱证（同名成员出现在某个引擎模块文件里，不足以确证）");
lines.push("");
lines.push("| 符号 | 次数 | 涉及范围 | 弱证定位 | 示例 |");
lines.push("|---|---|---|---|---|");
for (const r of sourceWeak) lines.push(`| ${r.token} | ${r.count} | ${[...r.scopes].join(",")} | ${r.sourceHit} | ${(r.sample.text || "").replace(/\|/g, "/")} |`);
lines.push("");
lines.push("## 2. 无依据（索引、官方例子、引擎源码都没有）");
lines.push("");
lines.push("| 符号 | 次数 | 涉及范围 | 首个位置 | 示例 |");
lines.push("|---|---|---|---|---|");
for (const r of noneBacked) lines.push(`| ${r.token} | ${r.count} | ${[...r.scopes].join(",")} | ${r.sample.file}:${r.sample.line} | ${(r.sample.text || "").replace(/\|/g, "/")} |`);
lines.push("");
lines.push("## 3. 跨代际风险（只在本代际的“另一代”有符号证据）");
lines.push("");
lines.push("| 符号 | 次数 | 涉及范围 | 首个位置 | 示例 |");
lines.push("|---|---|---|---|---|");
for (const r of crossgenRisk) lines.push(`| ${r.token} | ${r.count} | ${[...r.scopes].join(",")} | ${r.sample.file}:${r.sample.line} | ${(r.sample.text || "").replace(/\|/g, "/")} |`);
lines.push("");

fs.writeFileSync(path.join(OUT, "audit-report.md"), lines.join("\n"), "utf8");
const summary = {
  scopes: SCOPES.map(s => ({ id: s.id, gen: s.gen, files: s.files })),
  occurrences: occurrences.length,
  uniqueTokens: aggregated.size,
  byEvidence: totals,
  sourceBacked: sourceBacked.length,
  noneBacked: noneBacked.length,
  crossgenRisk: crossgenRisk.length
};
fs.writeFileSync(path.join(OUT, "audit-summary.json"), JSON.stringify(summary, null, 1), "utf8");
console.log(JSON.stringify(summary, null, 1));
console.log("\n-- source-backed --");
for (const r of sourceBacked) console.log(`  ${r.count}\t${r.token}\t${[...r.scopes].join(",")}\t${r.sourceHit}`);
console.log("\n-- none --");
for (const r of noneBacked) console.log(`  ${r.count}\t${r.token}\t${[...r.scopes].join(",")}`);
console.log("\n-- crossgen risk --");
for (const r of crossgenRisk) console.log(`  ${r.count}\t${r.token}\t${[...r.scopes].join(",")}`);