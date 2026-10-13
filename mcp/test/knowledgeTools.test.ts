import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/core/config.ts";
import type { JsonObject, ToolContext, ToolOutcome } from "../src/core/types.ts";
import { buildTools } from "../src/device/tools/index.ts";

const config: AppConfig = {
  transportMode: "stdio",
  v5BaseUrl: "http://127.0.0.1:9999",
  v5PublicUrl: "",
  v5AuthToken: "",
  mcpClientId: "hz-autojs-device-mcp",
  httpHost: "127.0.0.1",
  httpPort: 3333,
  httpPath: "/mcp",
  httpAuthToken: "",
  httpJsonResponse: false,
  httpSessionIdleMs: 1800000,
  readOnly: false,
  enableDangerousActions: false,
  useDirectControl: false,
  enableDeviceLock: true,
  enableTutorialTools: false,
  requestTimeoutMs: 15000,
  uploadRequestTimeoutMs: 600000,
  uploadChunkBytes: 8388608,
  uploadResumableThresholdBytes: 16777216,
  uploadRetryCount: 3,
  taskWaitTimeoutMs: 30000,
  taskPollIntervalMs: 1000,
  auditLogPath: "",
  stateDir: "/tmp/hz-mcp-test",
  enableElicitation: true,
  elicitationAutoDeclineMs: 1000,
  autoApproveOnClientPreauthorization: true
};

interface Call {
  path: string;
  query?: JsonObject;
}

function contextWith(handler: (path: string, query?: JsonObject) => ToolOutcome): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    config,
    client: {
      get: async (path: string, query?: JsonObject) => {
        calls.push({ path, query });
        return handler(path, query);
      },
      executeCanonicalTool: async (): Promise<ToolOutcome<JsonObject>> => ({ ok: true, code: "OK", message: "OK", data: {} }),
      waitForTask: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      getTask: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      getTaskLogs: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      uploadMultipart: async () => ({ ok: true, code: "OK", message: "OK", data: {} })
    } as any,
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId: string, _action: string, callback: () => Promise<unknown>) => callback(),
    supportsElicitation: () => false,
    requestConfirmation: async () => "decline"
  } as unknown as ToolContext;
  return { ctx, calls };
}

function tool(ctx: ToolContext, name: string) {
  const found = buildTools(ctx).find(item => item.name === name);
  assert.ok(found, `工具未注册: ${name}`);
  return found;
}

test("knowledge_search 走 V5 只读接口并带上调用方与来源过滤", async () => {
  const { ctx, calls } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: {
      query: "怎么录音",
      matches: [{ sourceType: "official", docPath: "docs/manual/record/index.md" }],
      sourceTypes: ["official", "custom"],
      customAllowed: true
    }
  }));

  const outcome = await tool(ctx, "knowledge_search").handler({ query: "怎么录音", limit: 3, sourceType: "all" });

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/mcp/knowledge/search");
  assert.equal(calls[0].query?.query, "怎么录音");
  assert.equal(calls[0].query?.limit, 3);
  assert.equal(calls[0].query?.sourceType, "all");
  assert.equal(calls[0].query?.clientId, "hz-autojs-device-mcp");
  assert.match(String((outcome.data as JsonObject).citationRule), /来自官方教程/);
  assert.match(outcome.message, /官方|来源/);
});

test("knowledge_search 在客户资料对外关闭时给出提示", async () => {
  const { ctx } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: { matches: [{ sourceType: "official" }], sourceTypes: ["official"], customAllowed: false }
  }));

  const outcome = await tool(ctx, "knowledge_search").handler({ query: "资料" });

  assert.equal(outcome.ok, true);
  assert.match(outcome.message, /客户资料对外检索已关闭/);
});

test("knowledge_search 未命中时禁止编造", async () => {
  const { ctx } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: { matches: [], sourceTypes: [], customAllowed: true }
  }));

  const outcome = await tool(ctx, "knowledge_search").handler({ query: "不存在的主题" });

  assert.equal(outcome.ok, true);
  assert.match(outcome.message, /不得编造/);
  assert.match(outcome.message, /autojs_docs_search/);
});

test("knowledge_read 透传分段窗口，并提示用 nextOffset 继续读", async () => {
  const { ctx, calls } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: {
      sourceType: "official",
      title: "服务端更新日志",
      docPath: "docs/manual/更新日志/服务端/index.md",
      markdown: "# 服务端更新日志",
      html: "<h1>服务端更新日志</h1>",
      offset: 12000,
      maxChars: 12000,
      totalChars: 30000,
      nextOffset: 24000,
      truncated: true
    }
  }));

  const outcome = await tool(ctx, "knowledge_read").handler({
    docPath: "docs/manual/更新日志/服务端/index.md",
    offset: 12000,
    maxChars: 12000
  });

  assert.equal(outcome.ok, true);
  assert.equal(calls[0].path, "/api/mcp/knowledge/read");
  assert.equal(calls[0].query?.offset, 12000);
  assert.equal(calls[0].query?.maxChars, 12000);
  assert.equal(outcome.data?.nextOffset, 24000);
  // 渲染用 HTML 与 markdown 重复，不进模型上下文。
  assert.equal(outcome.data?.html, undefined);
  assert.match(outcome.message, /offset=24000/);
  assert.match(String(outcome.data?.readMode), /直到 truncated=false/);
});

test("knowledge_read 透传 docPath 与 anchor，并按来源标注", async () => {
  const { ctx, calls } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: { sourceType: "custom", title: "演示指南", docPath: "guide.md", sectionFound: true, assets: [] }
  }));

  const outcome = await tool(ctx, "knowledge_read").handler({
    docPath: "guide.md",
    sourceType: "custom",
    anchor: "步骤一"
  });

  assert.equal(outcome.ok, true);
  assert.equal(calls[0].path, "/api/mcp/knowledge/read");
  assert.equal(calls[0].query?.docPath, "guide.md");
  assert.equal(calls[0].query?.anchor, "步骤一");
  assert.equal(calls[0].query?.sourceType, "custom");
  assert.equal(calls[0].query?.clientId, "hz-autojs-device-mcp");
  assert.match(outcome.message, /来自你的资料：演示指南/);
});

test("knowledge_assets 取单张图片时返回图片块且文本里不留 base64", async () => {
  const { ctx, calls } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: {
      sourceType: "official",
      path: "docs/manual/demo/images/step-01.png",
      mime: "image/png",
      size: 1024,
      width: 320,
      height: 200,
      inline: true,
      base64: "QUJD"
    }
  }));

  const outcome = await tool(ctx, "knowledge_assets").handler({
    sourceType: "official",
    path: "docs/manual/demo/images/step-01.png"
  });

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/mcp/knowledge/assets");
  assert.equal(calls[0].query?.path, "docs/manual/demo/images/step-01.png");
  assert.equal(outcome.images?.length, 1);
  assert.equal(outcome.images?.[0].mimeType, "image/png");
  assert.equal(outcome.images?.[0].data, "QUJD");
  const assets = (outcome.data as JsonObject).assets as JsonObject[];
  assert.equal(assets[0].base64, undefined, "文本结构里不允许出现 base64");
  assert.equal(assets[0].inline, true);
});

test("knowledge_assets 列文档图片时按 limit 内联图片并跳过未内联项", async () => {
  const { ctx, calls } = contextWith((_path, query) => {
    if (query?.docPath) {
      return {
        ok: true,
        code: "OK",
        message: "OK",
        data: {
          sourceType: "custom",
          docPath: "guide.md",
          anchor: "步骤一",
          count: 3,
          assets: [
            { path: "images/step-01.png", url: "/api/knowledge/local-assets?path=images%2Fstep-01.png" },
            { path: "images/step-02.png", url: "/api/knowledge/local-assets?path=images%2Fstep-02.png" },
            { path: "images/step-03.png", url: "/api/knowledge/local-assets?path=images%2Fstep-03.png" }
          ]
        }
      };
    }
    const path = String(query?.path ?? "");
    const index = path.endsWith("step-02.png")
      ? { sourceType: "custom", path, mime: "image/png", inline: false, message: "图片超过内联上限" }
      : { sourceType: "custom", path, mime: "image/png", inline: true, base64: "QUJD" };
    return { ok: true, code: "OK", message: "OK", data: index as JsonObject };
  });

  const outcome = await tool(ctx, "knowledge_assets").handler({
    sourceType: "custom",
    docPath: "guide.md",
    anchor: "步骤一",
    limit: 2
  });

  assert.equal(outcome.ok, true);
  // 1 次清单 + 2 次取图（limit=2）
  assert.equal(calls.length, 3);
  assert.equal(calls[0].query?.docPath, "guide.md");
  assert.equal(calls[0].query?.anchor, "步骤一");
  assert.equal(outcome.images?.length, 1, "只有真实内联的图片才作为图片块返回");
  const data = outcome.data as JsonObject;
  assert.equal(data.count, 3);
  assert.equal(data.imagesIncluded, 1);
  assert.equal((data.inlineAssets as JsonObject[]).length, 2);
  assert.equal(JSON.stringify(outcome.data).includes("base64"), false, "文本结构里不允许出现 base64");
  assert.equal(JSON.stringify(outcome.data).includes("QUJD"), false, "图片内容不能进入文本块");
});

test("knowledge_assets 缺少 path 与 docPath 时直接失败且不调用 V5", async () => {
  const { ctx, calls } = contextWith(() => ({ ok: true, code: "OK", message: "OK", data: {} }));

  const outcome = await tool(ctx, "knowledge_assets").handler({ sourceType: "official" });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "INVALID_ARGUMENT");
  assert.equal(calls.length, 0);
});

test("knowledge_assets 关闭 includeImage 时不取图片内容", async () => {
  const { ctx, calls } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: {
      sourceType: "official",
      docPath: "docs/manual/demo/index.md",
      count: 1,
      assets: [{ path: "docs/manual/demo/images/step-01.png" }]
    }
  }));

  const outcome = await tool(ctx, "knowledge_assets").handler({
    sourceType: "official",
    docPath: "docs/manual/demo/index.md",
    includeImage: false
  });

  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(outcome.images, undefined);
  assert.equal((outcome.data as JsonObject).imagesIncluded, 0);
});

test("V5 拒绝客户资料时原样返回失败信息", async () => {
  const { ctx } = contextWith(() => ({
    ok: false,
    code: "TOOL_ERROR",
    message: "客户资料当前不允许外部 AI 检索：请在 AI 设置中开启「允许外部 AI 检索我的资料」"
  }));

  const outcome = await tool(ctx, "knowledge_search").handler({ query: "资料", sourceType: "custom" });

  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /不允许外部 AI 检索/);
});