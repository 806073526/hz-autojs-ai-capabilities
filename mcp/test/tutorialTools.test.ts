import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AppConfig } from "../src/core/config.ts";
import type { JsonObject, ToolContext, ToolOutcome } from "../src/core/types.ts";
import { buildAuthoringTools } from "../src/authoring/tools/index.ts";

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
  enableDangerousActions: true,
  useDirectControl: false,
  enableDeviceLock: true,
  enableTutorialTools: true,
  requestTimeoutMs: 15000,
  uploadRequestTimeoutMs: 600000,
  uploadChunkBytes: 8388608,
  uploadResumableThresholdBytes: 16777216,
  uploadRetryCount: 3,
  taskWaitTimeoutMs: 30000,
  taskPollIntervalMs: 1000,
  auditLogPath: "",
  stateDir: "/tmp/hz-mcp-tutorial-test",
  enableElicitation: true,
  elicitationAutoDeclineMs: 1000,
  autoApproveOnClientPreauthorization: true
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
  query?: JsonObject;
  headers?: JsonObject;
}

interface ContextOptions {
  supportsElicitation?: boolean;
  confirmationDecision?: "accept" | "decline" | "cancel";
}

function contextWith(
  handler: (call: Call) => ToolOutcome,
  override: AppConfig = config,
  options: ContextOptions = {}
): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    config: override,
    client: {
      get: async (path: string, query?: JsonObject, headers?: JsonObject) => {
        const call: Call = { method: "GET", path, query, headers };
        calls.push(call);
        return handler(call);
      },
      post: async (path: string, body?: unknown, query?: JsonObject, headers?: JsonObject) => {
        const call: Call = { method: "POST", path, body, query, headers };
        calls.push(call);
        return handler(call);
      },
      put: async (path: string, body?: unknown, query?: JsonObject, headers?: JsonObject) => {
        const call: Call = { method: "PUT", path, body, query, headers };
        calls.push(call);
        return handler(call);
      },
      executeCanonicalTool: async (): Promise<ToolOutcome<JsonObject>> => ({ ok: true, code: "OK", message: "OK", data: {} }),
      waitForTask: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      getTask: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      getTaskLogs: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      uploadMultipart: async () => ({ ok: true, code: "OK", message: "OK", data: {} })
    } as any,
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId: string, _action: string, callback: () => Promise<unknown>) => callback(),
    supportsElicitation: () => options.supportsElicitation === true,
    requestConfirmation: async () => options.confirmationDecision || "decline"
  } as unknown as ToolContext;
  return { ctx, calls };
}

function tool(ctx: ToolContext, name: string) {
  const found = buildAuthoringTools(ctx).find(item => item.name === name);
  assert.ok(found, `工具未注册: ${name}`);
  return found;
}

const SESSION: JsonObject = {
  sessionId: "tut-demo-0001",
  title: "演示教程",
  category: "投屏",
  target: "MOBILE",
  status: "RECORDING",
  deviceId: "device_demo",
  appVersion: "5.2.2",
  steps: [],
  redactions: []
};

test("教程录制工具按 MCP 名字注册（12 个）", () => {
  const { ctx } = contextWith(() => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const names = buildAuthoringTools(ctx).map(item => item.name).filter(name => name.startsWith("tutorial_"));
  assert.deepEqual(names.sort(), [
    "tutorial_authoring_status",
    "tutorial_desktop_step",
    "tutorial_mobile_preview",
    "tutorial_mobile_step",
    "tutorial_session_create",
    "tutorial_session_delete",
    "tutorial_session_list",
    "tutorial_session_publish",
    "tutorial_session_review",
    "tutorial_session_update",
    "tutorial_step_delete",
    "tutorial_step_update"
  ]);
});

test("tutorial_session_create 手机端必须给 deviceId，并落到 /api/tutorial/sessions", async () => {
  const { ctx, calls } = contextWith(call => (
    call.path === "/api/tutorial/sessions"
      ? { ok: true, code: "OK", message: "OK", data: SESSION }
      : { ok: false, code: "UNEXPECTED", message: call.path }
  ));
  const create = tool(ctx, "tutorial_session_create");

  const missing = await create.handler({ title: "缺设备", target: "MOBILE" });
  assert.equal(missing.ok, false);
  assert.equal(missing.code, "INVALID_ARGUMENT");

  const created = await create.handler({
    title: "演示教程",
    target: "MOBILE",
    deviceId: "device_demo",
    appVersion: "5.2.2",
    category: "投屏/插件与安装"
  });
  assert.equal(created.ok, true);
  assert.equal(created.data?.sessionId, "tut-demo-0001");
  // 分类随会话摘要回给 AI，发布后就是教程包目录层级
  assert.equal(created.data?.category, "投屏");
  assert.deepEqual(calls[0].body, {
    title: "演示教程",
    target: "MOBILE",
    deviceId: "device_demo",
    appVersion: "5.2.2",
    category: "投屏/插件与安装"
  });
});

test("tutorial_session_update 改标题/分类/版本，空串可清空分类", async () => {
  const { ctx, calls } = contextWith(call => (
    call.path === "/api/tutorial/sessions/tut-demo-0001"
      ? { ok: true, code: "OK", message: "OK", data: SESSION }
      : { ok: false, code: "UNEXPECTED", message: call.path }
  ));
  const update = tool(ctx, "tutorial_session_update");

  const updated = await update.handler({
    sessionId: "tut-demo-0001",
    title: "演示教程（修订）",
    category: "投屏/插件与安装",
    appVersion: "5.2.4"
  });
  assert.equal(updated.ok, true);
  assert.equal(updated.data?.sessionId, "tut-demo-0001");
  assert.deepEqual(calls[0].body, {
    title: "演示教程（修订）",
    category: "投屏/插件与安装",
    appVersion: "5.2.4"
  });

  await update.handler({ sessionId: "tut-demo-0001", category: "" });
  assert.deepEqual(calls[1].body, { category: "" });
});

test("tutorial_mobile_preview 带设备令牌头，返回节点与设备画面图片块", async () => {
  const { ctx, calls } = contextWith(() => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: {
      sessionId: "tut-demo-0001",
      deviceId: "device_demo",
      packageName: "com.zjh.toolbox.v5",
      width: 1080,
      height: 1920,
      nodes: [{ index: 3, label: "设置", className: "android.widget.TextView", clickable: true, bounds: { x: 1, y: 2, width: 3, height: 4 }, center: { x: 100, y: 200 } }],
      imageDataUrl: "data:image/png;base64,QUJD"
    }
  }));
  const preview = tool(ctx, "tutorial_mobile_preview");
  const outcome = await preview.handler({
    sessionId: "tut-demo-0001",
    deviceId: "device_demo",
    deviceAccessToken: "token-1",
    nodeLimit: 10
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.data?.nodeCount, 1);
  assert.equal(outcome.images?.length, 1);
  assert.equal(outcome.images?.[0].data, "QUJD");
  assert.equal(outcome.images?.[0].mimeType, "image/png");
  assert.equal(JSON.stringify(outcome.data).includes("QUJD"), false, "文本结果不得泄漏 base64");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].path, "/api/tutorial/sessions/tut-demo-0001/device/preview");
  assert.equal(calls[0].headers?.deviceAccessToken, "token-1");
  assert.equal((calls[0].body as JsonObject).nodeLimit, 10);
});

test("tutorial_mobile_step 先执行动作再取图，中文输入提示高级权限限制", async () => {
  const { ctx, calls } = contextWith(call => {
    if (call.path.endsWith("/steps/mobile")) {
      return {
        ok: true,
        code: "OK",
        message: "OK",
        data: { stepIndex: 2, title: "进入设置", description: "点击 (900, 1836)", image: "images/step-02.png", highlight: { x: 1, y: 2, width: 3, height: 4, label: "运行状态" }, targetRoute: "/settings", appVersion: "5.2.2", recordedFrom: "MOBILE" }
      };
    }
    if (call.path.endsWith("/images/step-02.png")) {
      return { ok: true, code: "OK", message: "OK", data: { fileName: "step-02.png", mime: "image/png", size: 3, imageBase64: "QUJD" } };
    }
    return { ok: false, code: "UNEXPECTED", message: call.path };
  });
  const step = tool(ctx, "tutorial_mobile_step");
  const outcome = await step.handler({
    sessionId: "tut-demo-0001",
    deviceId: "device_demo",
    nodeText: "运行状态",
    title: "进入设置",
    description: "点击底部设置",
    targetRoute: "/settings",
    action: { type: "TAP", x: 900, y: 1836 }
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.data?.stepIndex, 2);
  assert.equal(outcome.images?.length, 1);
  const body = calls[0].body as JsonObject;
  assert.equal(body.nodeText, "运行状态");
  assert.deepEqual(body.action, { type: "TAP", x: 900, y: 1836 });
  assert.equal(calls[1].path, "/api/tutorial/sessions/tut-demo-0001/images/step-02.png");
  const actionSchema = ((step.inputSchema.properties ?? {}) as JsonObject).action as JsonObject;
  const textSchema = ((actionSchema.properties ?? {}) as JsonObject).text as JsonObject;
  assert.match(String(textSchema.description), /input text/);
});

test("tutorial_desktop_step 从本地图片路径读帧并写入步骤", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tutorial-desktop-"));
  const imagePath = join(dir, "shot.png");
  writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { ctx, calls } = contextWith(call => {
    if (call.path.endsWith("/steps/desktop")) {
      return {
        ok: true,
        code: "OK",
        message: "OK",
        data: { stepIndex: 1, title: "打开知识库", description: "从菜单进入", image: "images/step-01.png", highlight: { x: 1, y: 2, width: 3, height: 4, label: "知识库" }, targetRoute: "/knowledge", appVersion: "5.2.2", recordedFrom: "DESKTOP" }
      };
    }
    if (call.path.endsWith("/images/step-01.png")) {
      return { ok: true, code: "OK", message: "OK", data: { fileName: "step-01.png", mime: "image/png", size: 3, imageBase64: "QUJD" } };
    }
    return { ok: false, code: "UNEXPECTED", message: call.path };
  });
  const step = tool(ctx, "tutorial_desktop_step");
  const outcome = await step.handler({
    sessionId: "tut-demo-0001",
    imagePath,
    title: "打开知识库",
    description: "从菜单进入",
    targetRoute: "/knowledge",
    highlight: { x: 1, y: 2, width: 3, height: 4, label: "知识库" },
    redactions: [{ stepIndex: 1, x: 0, y: 0, width: 10, height: 10, reason: "顶部信息" }]
  });

  assert.equal(outcome.ok, true);
  const body = calls[0].body as JsonObject;
  assert.match(String(body.image), /^data:image\/png;base64,/);
  assert.equal(body.imageFormat, "png");
  assert.equal((body.redactions as JsonObject[]).length, 1);
});

test("tutorial_session_review 与 publish 走审核与发布接口", async () => {
  const { ctx, calls } = contextWith(call => {
    if (call.path.endsWith("/review")) {
      return { ok: true, code: "OK", message: "OK", data: { ...SESSION, status: "REVIEWED", reviewedBy: "codex-mcp", redactions: [{ stepIndex: 1, reason: "顶部信息" }] } };
    }
    if (call.path.endsWith("/publish")) {
      return { ok: true, code: "OK", message: "OK", data: { sessionId: "tut-demo-0001", status: "PUBLISHED", stepCount: 2, imageCount: 2, packagePath: "data/tutorial-recordings/tut-demo-0001/package", archivePath: "data/tutorial-recordings/tut-demo-0001/tut-demo-0001.zip", contentHash: "a".repeat(64) } };
    }
    return { ok: false, code: "UNEXPECTED", message: call.path };
  });
  const review = tool(ctx, "tutorial_session_review");
  const publish = tool(ctx, "tutorial_session_publish");

  const reviewed = await review.handler({ sessionId: "tut-demo-0001" });
  assert.equal(reviewed.ok, true);
  assert.equal(reviewed.data?.status, "REVIEWED");
  assert.equal((calls[0].body as JsonObject).reviewedBy, "codex-mcp");

  const published = await publish.handler({ sessionId: "tut-demo-0001" });
  assert.equal(published.ok, true);
  assert.equal(published.data?.contentHash, "a".repeat(64));
});

test("tutorial_session_delete 走客户端危险动作确认", async () => {
  const { ctx, calls } = contextWith(
    () => ({ ok: true, code: "OK", message: "OK", data: SESSION }),
    config,
    { supportsElicitation: true, confirmationDecision: "accept" }
  );
  const remove = tool(ctx, "tutorial_session_delete");

  const done = await remove.handler({ sessionId: "tut-demo-0001" });
  assert.equal(done.ok, true);
  assert.equal(calls[0].path, "/api/tutorial/sessions/tut-demo-0001/delete");
});

test("tutorial_session_delete 在没有确认卡且无 V5 兜底时拒绝执行", async () => {
  const { ctx, calls } = contextWith(
    () => ({ ok: true, code: "OK", message: "OK", data: SESSION }),
    config,
    { supportsElicitation: false }
  );
  const remove = tool(ctx, "tutorial_session_delete");

  const blocked = await remove.handler({ sessionId: "tut-demo-0001" });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("作者工具默认关闭：只暴露状态工具，需 HZ_MCP_ENABLE_TUTORIAL_TOOLS 开启", async () => {
  const disabledConfig: AppConfig = { ...config, enableTutorialTools: false };
  const { ctx } = contextWith(() => ({ ok: true, code: "OK", message: "OK", data: {} }), disabledConfig);
  const names = buildAuthoringTools(ctx).map(item => item.name);
  assert.deepEqual(names, ["tutorial_authoring_status"]);

  const status = await buildAuthoringTools(ctx)[0].handler({});
  assert.equal(status.ok, true);
  assert.equal(status.data?.enabled, false);
  assert.match(String((status.data?.tools as string[]).join(",")), /tutorial_session_create/);

  const enabled = buildAuthoringTools(contextWith(() => ({ ok: true, code: "OK", message: "OK", data: {} })).ctx)
    .map(item => item.name);
  assert.equal(enabled.length, 12);
  assert.ok(enabled.includes("tutorial_session_publish"));
});
