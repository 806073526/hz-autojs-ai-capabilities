import assert from "node:assert/strict";
import { test } from "node:test";
import { detachToolImages, splitOutcomeForMcp } from "../src/core/toolImages.ts";
import { toMcpResponse } from "../src/core/mcpServer.ts";
import type { ToolOutcome } from "../src/core/types.ts";

const JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("detachToolImages 把 previewBase64 从文本结果里摘出来变成图片", () => {
  const input = {
    ok: true,
    taskMode: "TOOL_SCREENSHOT_CAPTURE",
    path: "/sdcard/a.png",
    previewFormat: "jpg",
    previewBase64: JPG
  };
  const { value, images } = detachToolImages(input);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/jpeg");
  assert.equal(images[0].data, JPG);
  const text = JSON.stringify(value);
  assert.ok(!text.includes("previewBase64"), "文本结果里不应再残留 previewBase64");
  assert.ok(text.includes("/sdcard/a.png"), "普通元数据必须保留");
});

test("detachToolImages 按 previewFormat 推断 mimeType，png 不会被误标成 jpeg", () => {
  const { images } = detachToolImages({ previewFormat: "png", previewBase64: PNG });
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
});

test("detachToolImages 处理嵌套结构，并把内嵌 JSON 字符串里的预览也摘出来", () => {
  const nested = JSON.stringify({ path: "/sdcard/n.png", previewFormat: "png", previewBase64: PNG });
  const input = { data: { resultPayload: nested, keep: 1 } };
  const { value, images } = detachToolImages(input);
  assert.equal(images.length, 1);
  assert.equal(images[0].mimeType, "image/png");
  const record = value as { data: { resultPayload: string } };
  assert.ok(!record.data.resultPayload.includes("previewBase64"));
});

test("detachToolImages 丢弃非法或超限的 base64，不让坏数据变成图片块", () => {
  const { images } = detachToolImages({ previewFormat: "jpg", previewBase64: "not-a-real-image!!" });
  assert.equal(images.length, 0);
});

test("detachToolImages 对图片数量设上限，避免一次返回过大", () => {
  const { images } = detachToolImages({
    items: Array.from({ length: 10 }, () => ({ previewFormat: "jpg", previewBase64: JPG }))
  });
  assert.equal(images.length, 4);
});

test("splitOutcomeForMcp 的文本里不含 base64，图片单独成块", () => {
  const outcome: ToolOutcome = {
    ok: true,
    code: "OK",
    message: "截图完成",
    data: { path: "/sdcard/a.png", previewFormat: "jpg", previewBase64: JPG },
    images: [{ data: JPG, mimeType: "image/jpeg" }]
  };
  const { text, images } = splitOutcomeForMcp(outcome);
  assert.ok(!text.includes("previewBase64"));
  assert.ok(!text.includes(JPG), "图片数据不能进入文本块");
  assert.equal(images.length, 1);
});

test("toMcpResponse 输出 text + image 内容块，图片不再以文本形式发给模型", () => {
  const outcome: ToolOutcome = {
    ok: true,
    code: "OK",
    message: "截图完成",
    data: { path: "/sdcard/a.png" },
    images: [{ data: JPG, mimeType: "image/jpeg" }]
  };
  const response = toMcpResponse(outcome);
  assert.equal(response.isError, false);
  assert.equal(response.content[0].type, "text");
  assert.equal(response.content[1].type, "image");
  assert.equal((response.content[1] as { mimeType: string }).mimeType, "image/jpeg");
  assert.equal((response.content[1] as { data: string }).data, JPG);
  assert.ok(!response.content[0].text.includes(JPG));
});import { buildTools } from "../src/device/tools/index.ts";
import type { AppConfig } from "../src/core/config.ts";
import type { JsonObject, ToolContext } from "../src/core/types.ts";

const baseConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
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
  enableElicitation: true,
  elicitationAutoDeclineMs: 1000,
  autoApproveOnClientPreauthorization: true,
  stateDir: "/tmp/hz-mcp-test",
  ...overrides
});

/** 用真实的 device_screenshot 工具走一遍整形链路，验证 base64 不会以文本形式外泄。 */
test("device_screenshot 真实链路：base64 变成 image 块，文本侧不再重复计费", async () => {
  const rawPayload = JSON.stringify({
    path: "/sdcard/Download/shot.png",
    source: "screenshot",
    size: 139203,
    width: 1080,
    height: 1920,
    previewFormat: "jpg",
    previewBase64: JPG
  });
  const ctx = {
    config: baseConfig(),
    client: {
      executeCanonicalTool: async () => ({
        ok: true,
        code: "OK",
        message: "任务已提交",
        data: { result: { taskId: "task-shot", taskMode: "TOOL_SCREENSHOT_CAPTURE" } }
      }),
      waitForTask: async (taskId: string) => ({
        ok: true,
        code: "OK",
        message: "截图已保存",
        data: {
          taskId,
          taskStatus: "SUCCEEDED",
          taskMode: "TOOL_SCREENSHOT_CAPTURE",
          resultMessage: "截图已保存: /sdcard/Download/shot.png",
          resultPayload: JSON.parse(rawPayload),
          raw: { resultPayload: rawPayload }
        }
      })
    } as unknown as ToolContext["client"],
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId: string, _action: string, callback: () => Promise<never>) => callback(),
    supportsElicitation: () => false,
    requestConfirmation: async () => "decline" as const
  } as unknown as ToolContext;

  const tool = buildTools(ctx).find(item => item.name === "device_screenshot");
  assert.ok(tool, "missing device_screenshot");
  const outcome = await tool.handler({ deviceId: "device_android_test" } as JsonObject);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.images?.length, 1, "截图应产出 1 个图片块");
  assert.equal(outcome.images?.[0].mimeType, "image/jpeg");

  const text = JSON.stringify(outcome.data);
  assert.ok(!text.includes("previewBase64"), "文本结果里不得残留 previewBase64 字段");
  assert.ok(!text.includes(JPG), "base64 数据不得进入文本结果");
  assert.ok(text.includes("/sdcard/Download/shot.png"), "路径元数据必须保留");

  const response = toMcpResponse(outcome);
  const imageBlocks = response.content.filter(block => block.type === "image");
  assert.equal(imageBlocks.length, 1, "MCP 响应里应有真实 image 块");
  assert.ok(!response.content[0].text.includes(JPG), "text 块里不得出现 base64");
});