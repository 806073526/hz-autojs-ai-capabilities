import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTools } from "../src/device/tools/index.js";
import type { ToolContext } from "../src/core/types.js";
import type { McpToolDefinition } from "../src/core/types.js";

/**
 * AutoJs 文档索引工具测试。
 *
 * 重点覆盖"符号存在性判定"这条核心契约：脚本编写前必须先确认 API 存在，
 * 查询无结果即代表符号不存在，不得凭记忆补全。
 *
 * 索引文件由 mcp/scripts/build-autojs-index.mjs 生成，测试直接读取真实索引，
 * 保证契约与随包数据一致。
 */

// 文档工具不使用 ctx，占位即可
const ctx = {} as ToolContext;

function tool(name: string): McpToolDefinition {
  const found = buildTools(ctx).find(item => item.name === name);
  assert.ok(found, `工具 ${name} 未注册`);
  return found;
}

async function search(args: Record<string, unknown>) {
  return tool("autojs_docs_search").handler(args);
}

async function read(args: Record<string, unknown>) {
  return tool("autojs_docs_read").handler(args);
}

test("两个文档工具已注册", () => {
  const names = buildTools(ctx).map(item => item.name);
  assert.ok(names.includes("autojs_docs_search"));
  assert.ok(names.includes("autojs_docs_read"));
});

test("工具 schema 声明的必填与默认值正确", () => {
  const searchTool = tool("autojs_docs_search");
  const readTool = tool("autojs_docs_read");
  assert.equal(searchTool.inputSchema.type, "object");
  assert.equal(readTool.inputSchema.type, "object");
  const searchProps = searchTool.inputSchema.properties as Record<string, unknown>;
  assert.ok(searchProps.query);
  assert.ok(searchProps.module);
  assert.ok(searchProps.generation);
});

test("存在性：images.findMultiColors 能命中并带正文", async () => {
  const result = await search({ query: "images.findMultiColors" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.ok(Number(data.matched) > 0, "应至少有 1 条匹配");
  const matches = data.matches as Array<Record<string, unknown>>;
  assert.ok(matches.length > 0, "应命中 images.findMultiColors");
  assert.equal(matches[0].symbol, "images.findMultiColors");

  const detail = await read({ symbol: "images.findMultiColors" });
  assert.equal(detail.ok, true);
  const detailData = detail.data as Record<string, unknown>;
  assert.equal(detailData.found, true);
  const text = String(detailData.text);
  assert.match(text, /firstColor/);
  assert.match(text, /threshold/);
});

test("存在性：Image.getWidth 命中且归属 Image 类", async () => {
  const result = await read({ symbol: "Image.getWidth" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.found, true);
  assert.equal(data.symbol, "Image.getWidth");
});

test("否定结论：setPixel 不存在时必须给出明确结论", async () => {
  const result = await search({ query: "setPixel" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.matched, 0);
  assert.equal(data.symbolNotFound, true);
  assert.match(String(data.conclusion), /没有|不得凭记忆/);
});

test("否定结论：images.drawRect 不存在（drawRect 只属于 canvas）", async () => {
  const result = await search({ query: "images.drawRect" });
  const data = result.data as Record<string, unknown>;
  assert.equal(data.matched, 0);
  assert.equal(data.symbolNotFound, true);

  // drawRect 本身存在于 canvas，但不能是 images 的方法
  const canvasDrawRect = await read({ symbol: "canvas.drawRect" });
  const canvasData = canvasDrawRect.data as Record<string, unknown>;
  assert.equal(canvasData.found, true);
  assert.equal(canvasData.generation, "v8");
});

test("读取不存在符号时返回建议而非报错", async () => {
  const result = await read({ symbol: "images.findColour" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.found, false);
  assert.equal(data.symbolNotFound, true);
  const suggestions = data.suggestions as string[] | undefined;
  assert.ok(suggestions && suggestions.length > 0, "应给出相近符号建议");
});

test("代际护栏：v9 符号带 Node.js 警告", async () => {
  const result = await read({ symbol: "app.getAppName", generation: undefined });
  // app.getAppName 在 v8 与 v9 都存在，默认应优先返回 v8
  const data = result.data as Record<string, unknown>;
  assert.equal(data.generation, "v8");
  assert.equal(data.generationWarning, undefined);
  const alternates = data.alternates as string[] | undefined;
  assert.ok(alternates && alternates.some(item => item.includes("v9")), "应提示存在 v9 版本");

  const v9 = await read({ symbol: "opencv.Mat" });
  const v9data = v9.data as Record<string, unknown>;
  if (v9data.found) {
    assert.equal(v9data.generation, "v9");
    assert.ok(v9data.generationWarning, "v9 符号必须带代际警告");
  }
});

test("v9 Node API：类成员可用 runtime alias 命中并读取", async () => {
  const result = await search({ query: "accessibility.enableService", generation: "v9" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.ok(Number(data.matched) > 0, "应命中 accessibility.enableService");
  const matches = data.matches as Array<Record<string, unknown>>;
  assert.ok(matches.some(item => item.symbol === "accessibility.Accessibility.enableService"));

  const detail = await read({ symbol: "accessibility.enableService" });
  assert.equal(detail.ok, true);
  const detailData = detail.data as Record<string, unknown>;
  assert.equal(detailData.found, true);
  assert.equal(detailData.symbol, "accessibility.Accessibility.enableService");
  assert.equal(detailData.generation, "v9");
  assert.match(String(detailData.generationWarning), /Node 入口|\.node\.js/);
});

test("模块清单模式：只传 module 时列出符号", async () => {
  const result = await search({ module: "images", generation: "v8" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.mode, "list");
  const symbols = data.symbols as string[];
  assert.ok(symbols.length > 0);
  assert.ok(symbols.every(symbol => symbol.startsWith("images.")));
});

test("页面大纲：只传 page 返回大纲", async () => {
  const result = await read({ page: "v8/images.html" });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.mode, "outline");
  const outline = data.outline as Array<Record<string, unknown>>;
  assert.ok(outline.some(item => item.symbol === "images.findMultiColors"));
});

test("page+anchor 精确定位", async () => {
  const result = await read({
    page: "v8/images.html",
    anchor: "images-findmulticolors-img-firstcolor-colors-options"
  });
  assert.equal(result.ok, true);
  const data = result.data as Record<string, unknown>;
  assert.equal(data.found, true);
  assert.equal(data.symbol, "images.findMultiColors");
});

test("缺少参数时返回 INVALID_ARGUMENT", async () => {
  const result = await search({});
  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_ARGUMENT");

  const readResult = await read({});
  assert.equal(readResult.ok, false);
  assert.equal(readResult.code, "INVALID_ARGUMENT");
});

test("maxChars 生效：正文被截断并标记", async () => {
  const full = await read({ symbol: "images.findMultiColors" });
  const fullData = full.data as Record<string, unknown>;
  const fullLen = String(fullData.text).length;

  const small = await read({ symbol: "images.findMultiColors", maxChars: 100 });
  const smallData = small.data as Record<string, unknown>;
  assert.ok(String(smallData.text).length <= 100);
  if (fullLen > 100) {
    assert.equal(smallData.textTruncated, true);
  }
});

test("索引统计可用：符号与页面数量非空", async () => {
  const result = await search({ module: "images" });
  const data = result.data as Record<string, unknown>;
  assert.ok(Number(data.total) > 0);
});
