import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTools } from "../src/device/tools/index.ts";
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

/** 构造一个只回放固定节点数组的布局任务上下文。 */
function layoutContext(nodes: JsonObject[], calls: JsonObject[] = [], payloadExtra: JsonObject = {}): ToolContext {
  return {
    config: baseConfig(),
    client: {
      executeCanonicalTool: async (toolName: string, params: JsonObject) => {
        calls.push({ toolName, params });
        // 真实 V5Client 把任务提交结果放在 data.result 下，maybeWaitForTask 从这里取 taskId。
        return { ok: true, code: "OK", message: "OK", data: { result: { taskId: "task-layout" } } };
      },
      waitForTask: async (taskId: string) => ({
        ok: true,
        code: "OK",
        message: "布局节点读取成功",
        data: {
          taskId,
          taskStatus: "SUCCEEDED",
          taskMode: "TOOL_LAYOUT_DUMP",
          raw: { resultPayload: JSON.stringify({ nodes, ...payloadExtra }) }
        }
      })
    } as any,
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId: string, _action: string, callback: () => Promise<unknown>) => callback(),
    supportsElicitation: () => false,
    requestConfirmation: async () => "decline"
  };
}

function findTool(ctx: ToolContext, name: string) {
  const tool = buildTools(ctx).find(item => item.name === name);
  assert.ok(tool, "missing tool " + name);
  return tool;
}

const bounds = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

// clickable=true 且 enabled：操作口径要保留。
const clickableButton: JsonObject = {
  index: 1, text: "确定", className: "android.widget.Button", clickable: true,
  longClickable: false, scrollable: false, checkable: false, enabled: true, visible: true,
  bounds: bounds(10, 10, 200, 80)
};
// 纯容器：不可操作，操作口径要过滤。
const plainContainer: JsonObject = {
  index: 2, text: "", className: "android.widget.FrameLayout", clickable: false,
  longClickable: false, scrollable: false, checkable: false, enabled: true, visible: true,
  bounds: bounds(0, 0, 1080, 1920)
};
// 屏外节点：bounds 退化（bottom < top），WebView 视口外节点就是这个形状。
const offscreenNode: JsonObject = {
  index: 3, text: "页脚说明", className: "android.view.View", clickable: false,
  longClickable: false, scrollable: false, checkable: false, enabled: true, visible: true,
  bounds: bounds(10, 2100, 900, 1920)
};
// 禁用按钮：enabled=false，操作口径要过滤。
const disabledButton: JsonObject = {
  index: 4, text: "已禁用", className: "android.widget.Button", clickable: true,
  longClickable: false, scrollable: false, checkable: false, enabled: false, visible: true,
  bounds: bounds(10, 100, 200, 180)
};
// 可输入节点：EditText 即使 clickable=false 也算可用。
const editText: JsonObject = {
  index: 5, text: "", className: "android.widget.EditText", clickable: false,
  longClickable: false, scrollable: false, checkable: false, enabled: true, visible: true,
  bounds: bounds(10, 200, 900, 280)
};

const allFixtureNodes = [clickableButton, plainContainer, offscreenNode, disabledButton, editText];

test("device_layout_dump 默认按结构分析口径采集：全部窗口、不限数量、不过滤", async () => {
  const calls: JsonObject[] = [];
  const ctx = layoutContext(allFixtureNodes, calls);

  const result = await findTool(ctx, "device_layout_dump").handler({ deviceId: "device-1" });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolName, "device.layout.read");
  assert.equal(calls[0].params.layoutRange, "all");
  assert.equal(calls[0].params.limit, 0);

  const data = result.data as JsonObject;
  const summary = data.layoutSummary as JsonObject;
  assert.equal(summary.visibleOnly, false);
  assert.equal(summary.usableOnly, false);
  assert.equal(summary.dedupe, false);
  assert.equal(summary.limit, 0);
  assert.equal(summary.truncated, false);
  // 屏外、禁用、纯容器节点都要保留：结构分析不允许丢节点。
  assert.equal((data.nodes as JsonObject[]).length, allFixtureNodes.length);
});

test("device_layout_dump 显式 limit 时按上限截断并标记 truncated", async () => {
  const calls: JsonObject[] = [];
  const many: JsonObject[] = Array.from({ length: 600 }, (_, i) => ({
    index: i,
    text: "n" + i,
    className: "android.widget.TextView",
    clickable: false,
    enabled: true,
    visible: true,
    bounds: bounds(0, i, 100, i + 10)
  }));
  const ctx = layoutContext(many, calls);

  const result = await findTool(ctx, "device_layout_dump").handler({ deviceId: "device-1", limit: 50 });
  assert.equal(calls[0].params.limit, 500);
  const data = result.data as JsonObject;
  const summary = data.layoutSummary as JsonObject;
  assert.equal(summary.limit, 50);
  assert.equal(summary.truncated, true);
  assert.equal((data.nodes as JsonObject[]).length, 50);
});

test("device_find_node 默认只返回可用节点且不限数量", async () => {
  const calls: JsonObject[] = [];
  const ctx = layoutContext(allFixtureNodes, calls);

  const result = await findTool(ctx, "device_find_node").handler({ deviceId: "device-1" });
  assert.equal(result.ok, true);
  assert.equal(calls[0].params.layoutRange, "active");
  assert.equal(calls[0].params.limit, 0);

  const data = result.data as JsonObject;
  const returned = data.nodes as JsonObject[];
  assert.deepEqual(returned.map(node => node.className), ["android.widget.Button", "android.widget.EditText"]);
  assert.equal(data.matchedCount, allFixtureNodes.length);
  const summary = data.layoutSummary as JsonObject;
  assert.equal(summary.usableOnly, true);
  assert.equal(summary.visibleOnly, true);
  assert.equal(summary.limit, 0);
});

test("device_find_node 显式关闭过滤后返回全部节点（含屏外与不可操作）", async () => {
  const calls: JsonObject[] = [];
  const ctx = layoutContext(allFixtureNodes, calls);

  const result = await findTool(ctx, "device_find_node").handler({
    deviceId: "device-1",
    usableOnly: false,
    visibleOnly: false
  });
  const data = result.data as JsonObject;
  assert.equal((data.nodes as JsonObject[]).length, allFixtureNodes.length);
});

test("设备端标记 truncated 时透传到 layoutSummary", async () => {
  const calls: JsonObject[] = [];
  const ctx = layoutContext([clickableButton], calls, { truncated: true });

  const result = await findTool(ctx, "device_layout_dump").handler({ deviceId: "device-1" });
  const summary = (result.data as JsonObject).layoutSummary as JsonObject;
  assert.equal(summary.truncated, true);
});

test("工具 schema 暴露全量/过滤参数并写清默认口径", () => {
  const ctx = layoutContext([]);
  const tools = buildTools(ctx);
  const layoutTool = tools.find(tool => tool.name === "device_layout_dump");
  const nodeTool = tools.find(tool => tool.name === "device_find_node");
  assert.ok(layoutTool && nodeTool);

  const layoutProps = (layoutTool.inputSchema as JsonObject).properties as JsonObject;
  for (const key of [
    "limit", "layoutRange", "visibleOnly", "usableOnly", "clickableOnly", "textOnly", "dedupe",
    "fields", "outputFormat", "includeActionCandidates", "candidateOnly", "actionCandidateLimit",
    "actionCandidateZones", "includeRecognitionResults", "includeTaskMeta", "includePreview"
  ]) {
    assert.ok(layoutProps[key], "device_layout_dump 缺少参数 " + key);
  }
  assert.equal((layoutProps.limit as JsonObject).default, 0);
  assert.equal((layoutProps.layoutRange as JsonObject).default, "all");
  assert.equal((layoutProps.visibleOnly as JsonObject).default, false);
  assert.equal((layoutProps.usableOnly as JsonObject).default, false);
  assert.equal((layoutProps.dedupe as JsonObject).default, false);
  assert.match(layoutTool.description, /结构分析/);
  assert.match(layoutTool.description, /全部窗口/);
  assert.match(layoutTool.description, /不限数量/);

  const nodeProps = (nodeTool.inputSchema as JsonObject).properties as JsonObject;
  for (const key of [
    "limit", "layoutRange", "usableOnly", "visibleOnly", "clickableOnly", "textOnly", "dedupe",
    "fields", "outputFormat", "includeRecognitionResults", "includeTaskMeta"
  ]) {
    assert.ok(nodeProps[key], "device_find_node 缺少参数 " + key);
  }
  assert.equal((nodeProps.limit as JsonObject).default, 0);
  assert.equal((nodeProps.layoutRange as JsonObject).default, "active");
  assert.equal((nodeProps.usableOnly as JsonObject).default, true);
  assert.match(nodeTool.description, /可用节点/);
  assert.match(nodeTool.description, /device_layout_dump/);
});

// 列表项标题这类文本节点本身不可点击，但它是唯一的文字锚点：
// 操作口径必须保留，否则"按文字找入口"会返回空结果。
const textLabel: JsonObject = {
  index: 6, text: "无线和网络", className: "android.widget.TextView", clickable: false,
  longClickable: false, scrollable: false, checkable: false, enabled: true, visible: true,
  bounds: bounds(120, 300, 700, 360)
};

test("device_find_node 保留可读文本锚点，只丢空容器", async () => {
  const calls: JsonObject[] = [];
  const ctx = layoutContext([plainContainer, textLabel], calls);

  const result = await findTool(ctx, "device_find_node").handler({ deviceId: "device-1" });
  const returned = (result.data as JsonObject).nodes as JsonObject[];
  assert.deepEqual(returned.map(node => node.text), ["无线和网络"]);
});

test("device_find_node 默认不限数量：可用节点全部返回", async () => {
  const calls: JsonObject[] = [];
  const many: JsonObject[] = Array.from({ length: 320 }, (_, i) => ({
    index: i,
    text: "入口 " + i,
    className: "android.widget.Button",
    clickable: true,
    enabled: true,
    visible: true,
    bounds: bounds(10, 10 + i, 900, 60 + i)
  }));
  const ctx = layoutContext(many, calls);

  const result = await findTool(ctx, "device_find_node").handler({ deviceId: "device-1" });
  const data = result.data as JsonObject;
  assert.equal(calls[0].params.limit, 0);
  assert.equal((data.nodes as JsonObject[]).length, 320);
  assert.equal((data.layoutSummary as JsonObject).limit, 0);
});
