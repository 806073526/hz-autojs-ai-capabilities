import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { buildTools } from "../src/device/tools/index.ts";
import { V5Client } from "../src/core/v5Client.ts";
import type { AppConfig } from "../src/core/config.ts";
import type { JsonObject, ToolContext, ToolOutcome } from "../src/core/types.ts";

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

function toolContext(config: AppConfig, calls: JsonObject[] = [], outcome?: ToolOutcome): ToolContext {
  return {
    config,
    client: {
      executeCanonicalTool: async (toolName: string, params: JsonObject, options: JsonObject) => {
        calls.push({ toolName, params, options });
        return outcome || {
          ok: true,
          code: "OK",
          message: "OK",
          data: { taskId: `task-${toolName}`, taskMode: "RUN_SCRIPT_TEXT" }
        };
      },
      waitForTask: async taskId => ({
        ok: true,
        code: "OK",
        message: "任务完成",
        data: { taskId, taskStatus: "SUCCEEDED", taskMode: "RUN_SCRIPT_TEXT", raw: {} }
      })
    } as any,
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId, _action, callback) => callback(),
    supportsElicitation: () => false,
    requestConfirmation: async () => "decline"
  };
}

function findTool(ctx: ToolContext, name: string) {
  const tool = buildTools(ctx).find(item => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test("snake_case MCP device_tap maps to V5 canonical execute endpoint", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);

  const result = await findTool(ctx, "device_tap").handler({
    deviceId: "device-1",
    x: 12.6,
    y: 34.2,
    waitForResult: false
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{
    toolName: "device.control.tap",
    params: {
      deviceId: "device-1",
      x: 13,
      y: 34
    },
    options: {
      permissionMode: "FULL_AUTO"
    }
  }]);
});

test("read-only MCP mode blocks control tools but still allows canonical screenshot", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({ readOnly: true }), calls);

  const blocked = await findTool(ctx, "device_tap").handler({
    deviceId: "device-1",
    x: 1,
    y: 2
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "READ_ONLY");
  assert.equal(calls.length, 0);

  const blockedScript = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: "toastLog('blocked')"
  });
  assert.equal(blockedScript.ok, false);
  assert.equal(blockedScript.code, "READ_ONLY");
  assert.equal(calls.length, 0);

  const screenshot = await findTool(ctx, "device_screenshot").handler({
    deviceId: "device-1",
    includePreview: false,
    waitForResult: false
  });
  assert.equal(screenshot.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "device.screenshot");
  assert.deepEqual(calls[0].options, { permissionMode: "FULL_AUTO" });
});

test("device_run_script_text rejects a top-level return before submitting to V5", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: "var apps = app.getInstalledApps();\nreturn apps;"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SCRIPT_TOP_LEVEL_RETURN");
  assert.match(result.message, /顶层 return/);
  assert.equal(calls.length, 0, "顶层 return 必须在调用 V5 之前被拦截");
});

test("device_run_script_text still submits scripts that return inside a function", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: "function pick() {\n  return 'ok';\n}\nlog(pick());"
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "device.script.runText");
});

test("device_run_script_text treats combined nodejs directive headers as Node scripts", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);

  // `"ui nodejs";` 是 Node UI 组合指令：顶层 return 由 Node 引擎执行，必须放行。
  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: "\"ui nodejs\";\nreturn 1;"
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "device.script.runText");
});

test("device_run_script_text keeps the phone-side wording: nodejs ui stays Rhino on the phone", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);

  // 文档示例 `"nodejs ui";` 目前不在手机端 hasNodejsScriptHeader 识别范围内，
  // 实际仍按 Rhino 执行，顶层 return 必须拦截，避免提交必然失败的脚本。
  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: "\"nodejs ui\";\nreturn 1;"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SCRIPT_TOP_LEVEL_RETURN");
  assert.equal(calls.length, 0);
});

test("device_run_script_text still rejects top-level return when the header has no nodejs tag", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);

  // `"ui";` 不含 nodejs 标签，内容通道仍按 Rhino 执行，顶层 return 必须拦截。
  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: "\"ui\";\nreturn 1;"
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "INVALID_SCRIPT_TOP_LEVEL_RETURN");
  assert.equal(calls.length, 0);
});

test("dangerous action gate reports the config switch when it is disabled", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({ enableDangerousActions: false }), calls);

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: 'shell("ip link show")'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "DANGEROUS_ACTION_DISABLED");
  assert.match(result.message, /总开关/);
  assert.equal(calls.length, 0);
});

test("dangerous action gate asks the client for confirmation when enabled", async () => {
  const calls: JsonObject[] = [];
  const confirmations: string[] = [];
  const ctx = toolContext(baseConfig({ enableDangerousActions: true }), calls);
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async request => {
    confirmations.push(request.message);
    return "accept";
  };

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: 'shell("ip link show")'
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /危险动作/);
  assert.equal((calls[0].options as JsonObject).permissionMode, "FULL_AUTO");
});

test("dangerous action gate auto-approves full-access client preauthorization", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({
    enableDangerousActions: true,
    elicitationAutoDeclineMs: 1000,
    autoApproveOnClientPreauthorization: true
  }), calls);
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "decline";

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: 'shell("ip link show")'
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
});

test("dangerous action gate respects a real client decline", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({
    enableDangerousActions: true,
    elicitationAutoDeclineMs: 0,
    autoApproveOnClientPreauthorization: true
  }), calls);
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "decline";

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: 'shell("ip link show")'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "USER_DECLINED");
  assert.equal(calls.length, 0);
});

test("dangerous action gate rejects when the client cannot show a local confirmation card", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({ enableDangerousActions: true }), calls);
  ctx.supportsElicitation = () => false;

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: 'shell("ip link show")'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("dangerous action gate rejects when local elicitation is disabled", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({
    enableDangerousActions: true,
    enableElicitation: false
  }), calls);

  const result = await findTool(ctx, "device_run_script_text").handler({
    deviceId: "device-1",
    scriptContent: 'shell("ip link show")'
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "DANGEROUS_ACTION_CONFIRMATION_UNAVAILABLE");
  assert.equal(calls.length, 0);
});

test("nested canonical MCP tools do not deadlock on their own device lock", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls);
  const lockedDevices = new Map<string, string>();
  ctx.withDeviceLock = async (deviceId, action, callback) => {
    const current = lockedDevices.get(deviceId);
    if (current) {
      throw new Error(`设备 ${deviceId} 正在执行 ${current}`);
    }
    lockedDevices.set(deviceId, action);
    try {
      return await callback();
    } finally {
      lockedDevices.delete(deviceId);
    }
  };

  const result = await findTool(ctx, "device_click_node").handler({
    deviceId: "device-1",
    text: "确定",
    waitForResult: false
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "device.layout.read");
});

test("V5 canonical execute preserves structured DEVICE_ACCESS_REQUIRED with public authorization URL", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: JsonObject | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestedBody = JSON.parse(String(init?.body || "{}")) as JsonObject;
    return new Response(JSON.stringify({
      code: 200,
      data: {
        status: "FAILED",
        errorCode: "DEVICE_ACCESS_REQUIRED",
        errorMessage: "DEVICE_ACCESS_REQUIRED: 需要设备访问授权",
        errorData: {
          authorizationUrl: "/devices?deviceAccess=required&source=mcp&deviceId=device-1"
        }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new V5Client(baseConfig({
      v5BaseUrl: "http://10.0.0.2:9999",
      v5PublicUrl: "https://v5.example.com"
    }));

    const result = await client.executeCanonicalTool("device.control.tap", { deviceId: "device-1", x: 1, y: 2 });

    assert.equal(result.ok, false);
    assert.equal(result.code, "DEVICE_ACCESS_REQUIRED");
    assert.equal(requestedBody?.toolName, "device.control.tap");
    assert.equal(requestedBody?.permissionMode, "FULL_AUTO");
    assert.equal((requestedBody?.params as JsonObject)?.deviceId, "device-1");
    assert.equal((requestedBody?.params as JsonObject)?.x, 1);
    assert.equal((requestedBody?.params as JsonObject)?.y, 2);
    assert.equal((requestedBody?.params as JsonObject)?.mcpClientId, "hz-autojs-device-mcp");
    assert.equal(typeof (requestedBody?.params as JsonObject)?.mcpRequestId, "string");
    assert.equal((result.data as JsonObject).authorizationUrl, "https://v5.example.com/devices?deviceAccess=required&source=mcp&deviceId=device-1");
    assert.equal(String((result.data as JsonObject).authorizationUrl).includes("password"), false);
    assert.equal(String((result.data as JsonObject).authorizationUrl).includes("token="), false);
    assert.match(result.message, /\[打开 V5 设备授权页\]\(https:\/\/v5\.example\.com\/devices\?/, "DEVICE_ACCESS_REQUIRED 的 message 必须带可点击 Markdown 链接");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function pendingOutcome(overrides: Partial<JsonObject> = {}): ToolOutcome {
  return {
    ok: false,
    code: "FULL_AUTO_DENIED",
    message: "工具自动开关未开启",
    data: {
      toolName: "device.control.tap",
      status: "PENDING_CONFIRMATION",
      pendingAction: {
        actionId: "act-1",
        status: "PENDING",
        title: "确认 AI 工具调用：device.control.tap",
        riskLevel: "LOW_RISK",
        payloadJson: JSON.stringify({ params: { deviceId: "device-1" } }),
        confirmUrl: "https://v5.example.com/#/tool-confirm?actionId=act-1&source=mcp",
        deviceAccessSatisfied: true,
        ...overrides
      }
    }
  };
}

test("pending confirmation runs elicitation and executes when accepted", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls, pendingOutcome());
  let confirmRequest: JsonObject | undefined;
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async request => {
    confirmRequest = request as unknown as JsonObject;
    return "accept";
  };
  (ctx.client as any).confirmPendingAction = async (actionId: string, body: JsonObject) => {
    calls.push({ toolName: "confirm", actionId, body });
    return { ok: true, code: "OK", message: "ok", data: { status: "CONFIRMED" } };
  };
  (ctx.client as any).rejectPendingAction = async () => {
    throw new Error("must not reject on accept");
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, true);
  assert.equal((result.data as JsonObject).status, "SUCCEEDED");
  assert.equal((result.data as JsonObject).confirmedByUser, true);
  assert.ok(confirmRequest?.message);
  assert.deepEqual(calls.map(call => call.toolName), ["device.control.tap", "confirm"]);
});

test("pending confirmation declines and rejects the action", async () => {
  const calls: JsonObject[] = [];
  // 阈值置 0 表示按真人拒绝处理，专门覆盖 USER_DECLINED 分支。
  const ctx = toolContext(baseConfig({ elicitationAutoDeclineMs: 0 }), calls, pendingOutcome());
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "decline";
  (ctx.client as any).rejectPendingAction = async (actionId: string, body: JsonObject) => {
    calls.push({ toolName: "reject", actionId, body });
    return { ok: true, code: "OK", message: "ok", data: {} };
  };
  (ctx.client as any).confirmPendingAction = async () => {
    throw new Error("must not confirm on decline");
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "USER_DECLINED");
  assert.deepEqual(calls.map(call => call.toolName), ["device.control.tap", "reject"]);
});

test("pending confirmation cancel keeps action pending without rejecting", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls, pendingOutcome());
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "cancel";
  (ctx.client as any).rejectPendingAction = async () => {
    throw new Error("must not reject on cancel");
  };
  (ctx.client as any).confirmPendingAction = async () => {
    throw new Error("must not confirm on cancel");
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "USER_CANCELLED");
  assert.deepEqual(calls.map(call => call.toolName), ["device.control.tap"]);
});

test("pending confirmation points at the device authorization page when device access is unsatisfied", async () => {
  const calls: JsonObject[] = [];
  const outcome = pendingOutcome({ deviceAccessSatisfied: false });
  // authorizationUrl 由 V5 放在 errorData 层（与 pendingAction 同级），不是 pendingAction 字段。
  (outcome.data as JsonObject).authorizationUrl =
    "https://v5.example.com/#/devices?deviceAccess=required&source=mcp&deviceId=device-1";
  const ctx = toolContext(baseConfig(), calls, outcome);
  let elicitationCalled = false;
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => {
    elicitationCalled = true;
    return "accept";
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(elicitationCalled, false);
  assert.equal(result.ok, false);
  assert.equal(result.code, "DEVICE_ACCESS_REQUIRED");
  assert.equal(
    (result.data as JsonObject).authorizationUrl,
    "https://v5.example.com/#/devices?deviceAccess=required&source=mcp&deviceId=device-1"
  );
  assert.match(result.message, /\[打开 V5 设备授权页\]\(https:\/\/v5\.example\.com\/#\/devices\?/);
  assert.equal(result.message.includes("/#/tool-confirm"), false);
});

test("pending confirmation falls back to V5 URL when client lacks elicitation", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls, pendingOutcome());
  ctx.supportsElicitation = () => false;

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PENDING_CONFIRMATION_REQUIRES_V5");
  assert.equal((result.data as JsonObject).confirmUrl, "https://v5.example.com/#/tool-confirm?actionId=act-1&source=mcp");
});

test("pending confirmation falls back to V5 URL when elicitation throws", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls, pendingOutcome());
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => {
    throw new Error("elicit unavailable");
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PENDING_CONFIRMATION_REQUIRES_V5");
  assert.match(result.message, /elicit unavailable/);
});

test("pending confirmation auto-approves when the client short-circuits elicitation (full access)", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig(), calls, pendingOutcome());
  ctx.supportsElicitation = () => true;
  // Codex Desktop 选择"完全访问"时，客户端在阈值内直接 decline，用户不会看到确认框。
  ctx.requestConfirmation = async () => "decline";
  (ctx.client as any).rejectPendingAction = async () => {
    throw new Error("完全访问是预授权，不允许走拒绝路径");
  };
  (ctx.client as any).confirmPendingAction = async (actionId: string, body: JsonObject) => {
    calls.push({ toolName: "confirm", actionId, body });
    return { ok: true, code: "OK", message: "ok", data: { status: "CONFIRMED", payloadJson: JSON.stringify({ execution: { status: "SUCCEEDED" } }) } };
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, true);
  assert.equal((result.data as JsonObject).status, "SUCCEEDED");
  assert.equal((result.data as JsonObject).autoApprovedByClientPolicy, true);
  assert.deepEqual(calls.map(call => call.toolName), ["device.control.tap", "confirm"]);
});

test("pending confirmation keeps USER_DECLINED when the user really decided", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({ elicitationAutoDeclineMs: 0 }), calls, pendingOutcome());
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "decline";
  (ctx.client as any).rejectPendingAction = async (actionId: string, body: JsonObject) => {
    calls.push({ toolName: "reject", actionId, body });
    return { ok: true, code: "OK", message: "ok", data: {} };
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "USER_DECLINED");
  assert.equal(calls.filter(c => c.toolName === "reject").length, 1);
});

test("pending confirmation keeps manual confirmation when auto-approve is disabled", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({ autoApproveOnClientPreauthorization: false }), calls, pendingOutcome());
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "decline";
  (ctx.client as any).confirmPendingAction = async () => {
    throw new Error("关闭自动通过后不得直接确认");
  };
  (ctx.client as any).rejectPendingAction = async () => {
    throw new Error("关闭自动通过后不得判成拒绝");
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PENDING_CONFIRMATION_REQUIRES_V5");
  assert.match(result.message, /人工确认/);
});

test("pending confirmation skips elicitation entirely when the switch is off", async () => {
  const calls: JsonObject[] = [];
  const ctx = toolContext(baseConfig({ enableElicitation: false }), calls, pendingOutcome());
  let elicitCalled = false;
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => {
    elicitCalled = true;
    return "accept";
  };

  const result = await findTool(ctx, "device_tap").handler({ deviceId: "device-1", x: 1, y: 2, waitForResult: false });

  assert.equal(elicitCalled, false);
  assert.equal(result.code, "PENDING_CONFIRMATION_REQUIRES_V5");
  assert.equal((result.data as JsonObject).confirmUrl, "https://v5.example.com/#/tool-confirm?actionId=act-1&source=mcp");
});

test("V5 pending action client normalizes relative confirmUrl to public V5 URL", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 200,
    data: {
      actionId: "act-1",
      status: "PENDING",
      confirmUrl: "/#/tool-confirm?actionId=act-1&source=mcp",
      deviceAccessSatisfied: false
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    const client = new V5Client(baseConfig({
      v5BaseUrl: "http://10.0.0.2:9999",
      v5PublicUrl: "https://v5.example.com"
    }));

    const result = await client.getPendingAction("act-1");

    assert.equal(result.ok, true);
    assert.equal((result.data as JsonObject).confirmUrl, "https://v5.example.com/#/tool-confirm?actionId=act-1&source=mcp");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V5 client forwards HZ_V5_AUTH_TOKEN as Authorization Bearer token", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestedHeaders = new Headers();
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requestedUrl = String(url);
    requestedHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({
      code: 200,
      data: []
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new V5Client(baseConfig({
      v5AuthToken: "v5-service-access-token"
    }));

    const result = await client.get("/api/device/list", { keyword: "device-1" });

    assert.equal(result.ok, true);
    assert.equal(requestedUrl, "http://127.0.0.1:9999/api/device/list?keyword=device-1");
    assert.equal(requestedHeaders.get("Authorization"), "Bearer v5-service-access-token");
    assert.equal(requestedHeaders.get("Accept"), "application/json");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V5 canonical execute injects MCP client metadata into canonical params", async () => {
  const originalFetch = globalThis.fetch;
  let requestedBody: JsonObject | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestedBody = JSON.parse(String(init?.body || "{}")) as JsonObject;
    return new Response(JSON.stringify({
      code: 200,
      data: {
        status: "SUCCEEDED",
        resultSummary: "OK",
        resultJson: "{}"
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const client = new V5Client(baseConfig({
      mcpClientId: "codex-mcp"
    }));

    const result = await client.executeCanonicalTool("device.control.tap", {
      deviceId: "device-1",
      x: 1,
      y: 2
    });

    assert.equal(result.ok, true);
    assert.equal(requestedBody?.toolName, "device.control.tap");
    assert.equal((requestedBody?.params as JsonObject)?.mcpClientId, "codex-mcp");
    assert.equal(typeof (requestedBody?.params as JsonObject)?.mcpRequestId, "string");
    assert.notEqual(String((requestedBody?.params as JsonObject)?.mcpRequestId || "").length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V5 canonical execute returns FULL_AUTO_DENIED as structured MCP error", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 200,
    data: {
      status: "FAILED",
      errorCode: "FULL_AUTO_DENIED",
      errorMessage: "FULL_AUTO_DENIED: 请改在 V5 AI 工作台内确认"
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    const client = new V5Client(baseConfig());
    const result = await client.executeCanonicalTool("device.script.runText", {
      deviceId: "device-1",
      scriptContent: "toast('hi')"
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "FULL_AUTO_DENIED");
    assert.match(result.message, /FULL_AUTO_DENIED/);
  } finally {
    globalThis.fetch = originalFetch;
  }


test("V5 task wait surfaces terminalSource so script success can be attributed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 200,
    data: {
      taskId: "task-child",
      taskStatus: "SUCCEEDED",
      taskMode: "RUN_SCRIPT_TEXT",
      resultMessage: "脚本执行完成",
      terminalSource: "CHILD_ENGINE"
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    const client = new V5Client(baseConfig());
    const result = await client.waitForTask("task-child", { timeoutMs: 50, pollIntervalMs: 1 });

    assert.equal(result.ok, true);
    // 脚本类任务的 SUCCEEDED 必须能追溯来源：只有 CHILD_ENGINE 才是子引擎自报的真实结果
    assert.equal((result.data as { terminalSource?: string }).terminalSource, "CHILD_ENGINE");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("V5 task wait surfaces watchdog attribution on failure", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    code: 200,
    data: {
      taskId: "task-watchdog",
      taskStatus: "FAILED",
      taskMode: "RUN_SCRIPT_TEXT",
      resultMessage: "任务已 180 秒无终态且无进度上报，已由看门狗判定失败",
      terminalSource: "WATCHDOG"
    }
  }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  try {
    const client = new V5Client(baseConfig());
    const result = await client.waitForTask("task-watchdog", { timeoutMs: 50, pollIntervalMs: 1 });

    assert.equal(result.ok, false);
    assert.equal(result.code, "TASK_FAILED");
    assert.equal((result.data as { terminalSource?: string }).terminalSource, "WATCHDOG");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
});
