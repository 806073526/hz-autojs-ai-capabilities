import assert from "node:assert/strict";
import { test } from "node:test";
import type { AppConfig } from "../src/core/config.ts";
import type { JsonObject, ToolContext, ToolOutcome } from "../src/core/types.ts";
import { buildTools } from "../src/device/tools/index.ts";
import { buildProjectTools } from "../src/project/tools/index.ts";

// 21 个设备/任务工具 + 2 个 AutoJs 文档索引工具 + 3 个知识库只读工具
const DEVICE_TOOL_COUNT = 26;

const EXPECTED_DEVICE_TOOLS = [
  // AutoJs 离线文档索引：脚本编写前确认 API 存在性的唯一入口
  "autojs_docs_search",
  "autojs_docs_read",
  // 知识库只读工具：官方知识包 + 客户资料（V5 本地索引）
  "knowledge_search",
  "knowledge_read",
  "knowledge_assets",
  "device_list",
  "device_status",
  "device_screenshot",
  "device_layout_dump",
  "device_find_node",
  "device_click_node",
  "device_tap",
  "device_swipe",
  "device_input_text",
  "device_find_text",
  "device_ocr",
  "device_image_match",
  "device_color_pick",
  "page_match",
  "device_run_script_text",
  "device_run_script_file",
  "device_stop_script",
  "task_get",
  "task_wait",
  "task_logs",
  "device_logs"
];

const EXPECTED_PROJECT_TOOLS = [
  "device_file_list",
  "device_file_read_text",
  "device_file_write_text",
  "device_file_push",
  "device_file_pull",
  "device_file_operation",
  "project_sync_plan",
  "project_sync_push",
  "project_sync_status",
  "project_run",
  "project_dependencies_status",
  "project_install_dependencies",
  "project_build",
  "project_apk_install",
  "project_deploy_status",
  "project_task_logs"
];

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

function toolContext(): ToolContext {
  return {
    config,
    client: {
      executeCanonicalTool: async (): Promise<ToolOutcome<JsonObject>> => ({ ok: true, code: "OK", message: "OK", data: {} }),
      waitForTask: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      get: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      getTask: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      getTaskLogs: async () => ({ ok: true, code: "OK", message: "OK", data: {} }),
      uploadMultipart: async () => ({ ok: true, code: "OK", message: "OK", data: {} })
    } as any,
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId, _action, callback) => callback(),
    supportsElicitation: () => false,
    requestConfirmation: async () => "decline"
  };
}

test("device entry keeps the 21 device tools plus 2 docs tools plus 3 knowledge tools with unchanged names", () => {
  const names = buildTools(toolContext()).map(tool => tool.name);
  assert.equal(names.length, DEVICE_TOOL_COUNT, `设备入口工具数量应为 ${DEVICE_TOOL_COUNT}`);
  assert.deepEqual([...names].sort(), [...EXPECTED_DEVICE_TOOLS].sort());
  assert.equal(new Set(names).size, names.length, "设备入口不应有重复工具");
});

test("project entry registers project tools without device_list or device_status", () => {
  const names = buildProjectTools(toolContext()).map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, "项目入口不应有重复工具");
  assert.ok(!names.includes("device_list"), "项目入口不应包含 device_list");
  assert.ok(!names.includes("device_status"), "项目入口不应包含 device_status");
  assert.ok(!names.includes("device_screenshot"), "项目入口不应复制设备截图工具");
  for (const expected of EXPECTED_PROJECT_TOOLS) {
    assert.ok(names.includes(expected), `项目入口缺少工具 ${expected}`);
  }
});

test("two entries share no tool names", () => {
  const deviceNames = new Set(buildTools(toolContext()).map(tool => tool.name));
  const projectNames = buildProjectTools(toolContext()).map(tool => tool.name);
  const duplicates = projectNames.filter(name => deviceNames.has(name));
  assert.deepEqual(duplicates, [], `两个入口存在重复注册: ${duplicates.join(", ")}`);
});
