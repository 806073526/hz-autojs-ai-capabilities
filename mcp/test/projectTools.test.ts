import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildProjectTools } from "../src/project/tools/index.ts";
import type { AppConfig } from "../src/core/config.ts";
import type { JsonObject, ToolContext, ToolOutcome } from "../src/core/types.ts";

const config = (): AppConfig => ({
  transportMode: "stdio",
  v5BaseUrl: "http://127.0.0.1:9999",
  v5PublicUrl: "",
  v5AuthToken: "",
  mcpClientId: "hz-autojs-project-mcp",
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
  stateDir: join(tmpdir(), "hz-project-mcp-test"),
  enableElicitation: true,
  elicitationAutoDeclineMs: 1000,
  autoApproveOnClientPreauthorization: true
});

function projectContext(
  calls: JsonObject[],
  canonical: (toolName: string, params: JsonObject) => ToolOutcome<JsonObject>,
  options: { config?: Partial<AppConfig>; client?: JsonObject } = {}
): ToolContext {
  return {
    config: { ...config(), ...(options.config ?? {}) },
    client: {
      executeCanonicalTool: async (toolName: string, params: JsonObject, options: JsonObject) => {
        calls.push({ toolName, params, options });
        return canonical(toolName, params);
      },
      uploadMultipart: async (path: string, _form: FormData, query?: JsonObject) => {
        calls.push({ toolName: "upload", path, query });
        return { ok: true, code: "OK", message: "OK", data: { id: "2101552625647890433" } } as ToolOutcome<JsonObject>;
      },
      get: async (path: string) => {
        calls.push({ toolName: `GET ${path}` });
        return { ok: true, code: "OK", message: "OK", data: { uploadedChunks: [] } } as ToolOutcome<JsonObject>;
      },
      waitForTask: async taskId => ({ ok: true, code: "OK", message: "OK", data: { taskId } }) as ToolOutcome<JsonObject>,
      post: async (path: string, body?: unknown) => {
        calls.push({ toolName: `POST ${path}`, body: body as JsonObject });
        return { ok: true, code: "OK", message: "OK", data: {} } as ToolOutcome<JsonObject>;
      },
      delete: async (path: string, body?: unknown) => {
        calls.push({ toolName: `DELETE ${path}`, body: body as JsonObject });
        return { ok: true, code: "OK", message: "OK", data: {} } as ToolOutcome<JsonObject>;
      },
      ...(options.client ?? {})
    } as any,
    audit: { log: async () => undefined },
    withDeviceLock: async (_deviceId, _action, callback) => callback(),
    supportsElicitation: () => false,
    requestConfirmation: async () => "decline"
  };
}

let tempProjectSequence = 0;

function tempProjectRoot(label: string): string {
  return join(tmpdir(), `hz-project-${label}-${Date.now()}-${tempProjectSequence++}`);
}

async function createProjectFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = join(root, relativePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

function transferSummaryOf(data: JsonObject | undefined): JsonObject {
  assert.ok(data);
  const summary = data.transferSummary;
  assert.ok(summary && typeof summary === "object" && !Array.isArray(summary));
  return summary as JsonObject;
}

test("project_sync_push 整批一次下发：上传到暂存目录、只提交一个 FILE_PUSH 任务、下发后清暂存", async () => {
  const localRoot = join(tmpdir(), `hz-sync-${Date.now()}`);
  await mkdir(join(localRoot, "lib"), { recursive: true });
  await writeFile(join(localRoot, "project.json"), "{}", "utf8");
  await writeFile(join(localRoot, "lib", "util.js"), "module.exports = 1;", "utf8");
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "t1" } }));

  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_push");
  assert.ok(tool);
  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/probe",
    mode: "incremental",
    files: ["lib/util.js"],
    stateDir: join(tmpdir(), `hz-sync-state-${Date.now()}`),
    enableElicitation: true,
    elicitationAutoDeclineMs: 1000,
    autoApproveOnClientPreauthorization: true
  });

  assert.equal(result.ok, true);
  const upload = calls.find(call => call.toolName === "upload");
  const libraryPath = String(upload?.query?.relativePath || "");
  // 上传进项目暂存目录，不再散落到公共库根目录；暂存路径带项目标识与内容派生的批次键。
  assert.match(libraryPath, /^mcp-project-sync\/probe-[0-9a-f]{12}\/[0-9a-f]{16}\/lib\/util\.js$/);
  const stagingPath = libraryPath.replace(/\/lib\/util\.js$/, "");

  // 一批文件只允许一个设备任务：逐文件任务会让设备端每个文件弹一次「文件下发」窗口。
  const pushes = calls.filter(call => call.toolName === "file.device.push");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].params?.sourcePath, stagingPath);
  assert.equal(pushes[0].params?.fileId, undefined);
  assert.equal(pushes[0].params?.isPublic, true);
  assert.equal(pushes[0].params?.targetPath, "/sdcard/appSync/probe");
  assert.equal(pushes[0].params?.includeSourceRoot, false);
  assert.equal(pushes[0].params?.conflictPolicy, "SKIP_SAME_HASH");

  // 下发结束后清掉暂存目录：先清历史残留，再清本次批次。
  const deletes = calls.filter(call => call.toolName === "DELETE /api/file/public/path");
  assert.equal(deletes.length, 2);
  assert.equal(String(deletes[0].body?.sourcePath), stagingPath.replace(/\/[0-9a-f]{16}$/, ""));
  assert.equal(deletes[deletes.length - 1].body?.sourcePath, stagingPath);
});

test("project_sync_push 大文件分片续传：跳过已上传分片、补齐后带 SHA-256 完成", async () => {
  const localRoot = join(tmpdir(), `hz-sync-resumable-${Date.now()}`);
  await mkdir(join(localRoot, "lib"), { recursive: true });
  await writeFile(join(localRoot, "project.json"), "{}", "utf8");
  const content = "0123456789";
  await writeFile(join(localRoot, "lib", "big.bin"), content, "utf8");

  const calls: JsonObject[] = [];
  const chunkIndexes: number[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "t1" } }), {
    config: { uploadChunkBytes: 4, uploadResumableThresholdBytes: 4 },
    client: {
      get: async (path: string) => {
        calls.push({ toolName: `GET ${path}` });
        return { ok: true, code: "OK", message: "OK", data: { uploadedChunks: [0] } } as ToolOutcome<JsonObject>;
      },
      uploadMultipart: async (path: string, _form: FormData, query?: JsonObject) => {
        calls.push({ toolName: "upload", path, query });
        chunkIndexes.push(Number(query?.chunkIndex));
        return { ok: true, code: "OK", message: "OK", data: { uploadedChunks: [] } } as ToolOutcome<JsonObject>;
      },
      post: async (path: string, body?: unknown) => {
        calls.push({ toolName: `POST ${path}`, body: body as JsonObject });
        return { ok: true, code: "OK", message: "OK", data: { id: "9001" } } as ToolOutcome<JsonObject>;
      }
    }
  });

  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_push");
  assert.ok(tool);
  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/resume",
    mode: "incremental",
    files: ["lib/big.bin"],
    stateDir: join(tmpdir(), `hz-sync-resume-state-${Date.now()}`)
  });

  assert.equal(result.ok, true);
  // 服务端已有分片 0：只补 1、2 两片，不再整包重传。
  assert.deepEqual(chunkIndexes, [1, 2]);
  const uploads = calls.filter(call => call.toolName === "upload");
  assert.equal(uploads.length, 2);
  assert.match(String(uploads[0].path), /^\/api\/file\/upload\/resumable\/[0-9a-f]{64}\/chunk$/);
  const complete = calls.find(call => String(call.toolName).startsWith("POST /api/file/upload/resumable/"));
  assert.ok(complete);
  assert.equal(complete?.body?.chunkCount, 3);
  assert.equal(complete?.body?.fileSize, 10);
  assert.equal(complete?.body?.sha256, createHash("sha256").update(content).digest("hex"));
  assert.match(String(complete?.body?.relativePath),
    /^mcp-project-sync\/resume-[0-9a-f]{12}\/[0-9a-f]{16}\/lib\/big\.bin$/);
});

test("project_sync_plan 使用根 .hzignore 跳过目录子树并汇总传输大小", async () => {
  const localRoot = tempProjectRoot("hzignore-subtree");
  const hzignoreText = "# ignore internals\n\nprivate\n";
  await createProjectFiles(localRoot, {
    ".hzignore": hzignoreText,
    "project.json": "{}",
    "private/a.txt": "secret",
    "private/nested/b.txt": "nested",
    "src/main.js": "ok"
  });
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/hzignore",
    stateDir: tempProjectRoot("hzignore-state"),
    maxEntries: 100
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), [".hzignore", "project.json", "src/main.js"].sort());
  assert.equal((data.deletedCandidates as string[]).length, 0);
  const summary = transferSummaryOf(data);
  assert.equal(summary.totalBytes, Buffer.byteLength(hzignoreText) + 4);
  assert.equal(summary.fileCount, 3);
  assert.deepEqual(summary.excludedDirectories, ["private"]);
  assert.equal("ignoredFileCount" in summary, false);
  assert.equal(summary.configFound, true);
  assert.deepEqual(summary.warnings, []);
});

test(".hzignore 自身始终保留，即使规则或显式 excludes 命中", async () => {
  const localRoot = tempProjectRoot("hzignore-self");
  await createProjectFiles(localRoot, {
    ".hzignore": ".hzignore\n",
    "project.json": "{}"
  });
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/self",
    excludes: ".hzignore",
    stateDir: tempProjectRoot("hzignore-self-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), [".hzignore", "project.json"].sort());
  const summary = transferSummaryOf(data);
  assert.deepEqual(summary.excludedDirectories, []);
  assert.equal("ignoredFileCount" in summary, false);
});

test("子目录 .hzignore 不作为配置生效", async () => {
  const localRoot = tempProjectRoot("hzignore-nested");
  await createProjectFiles(localRoot, {
    "project.json": "{}",
    "sub/.hzignore": "secret.txt\n",
    "sub/secret.txt": "keep"
  });
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/nested-ignore",
    stateDir: tempProjectRoot("hzignore-nested-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), ["project.json", "sub/.hzignore", "sub/secret.txt"].sort());
  assert.equal(transferSummaryOf(data).configFound, false);
});

test("localRoot 为子目录时不读取父目录 .hzignore", async () => {
  const parentRoot = tempProjectRoot("hzignore-parent");
  await createProjectFiles(parentRoot, {
    ".hzignore": "blocked\n",
    "child/project.json": "{}",
    "child/blocked/a.txt": "keep"
  });
  const localRoot = join(parentRoot, "child");
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/child-root",
    stateDir: tempProjectRoot("hzignore-parent-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), ["blocked/a.txt", "project.json"].sort());
  assert.equal(transferSummaryOf(data).configFound, false);
});

test(".hzignore 规则按根路径和大小写精确匹配，不误伤 foo 与 foobar", async () => {
  const localRoot = tempProjectRoot("hzignore-boundary");
  await createProjectFiles(localRoot, {
    ".hzignore": "foo\nCase/Target.txt\ndup//segment\n",
    "project.json": "{}",
    "foo/a.txt": "excluded",
    "duplicate-keep.txt": "keep",
    "dup/segment/a.txt": "excluded",
    "foobar/b.txt": "keep",
    "Case/target.txt": "keep"
  });
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/boundary",
    stateDir: tempProjectRoot("hzignore-boundary-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), [".hzignore", "Case/target.txt", "duplicate-keep.txt", "foobar/b.txt", "project.json"].sort());
  const summary = transferSummaryOf(data);
  assert.deepEqual(summary.excludedDirectories, ["dup/segment", "foo"]);
  assert.equal("ignoredFileCount" in summary, false);
});

test(".hzignore 非法与通配符规则记录 warning 后跳过，不阻断同步", async () => {
  const localRoot = tempProjectRoot("hzignore-invalid");
  const invalidRules = [
    "*.log",
    "cache?",
    "name[0]",
    "/absolute",
    "C:\\drive.txt",
    "C:relative.txt",
    "a/./b",
    "a/../b",
    "!keep.txt"
  ];
  await createProjectFiles(localRoot, {
    ".hzignore": invalidRules.join("\n") + "\nvalid\n",
    "project.json": "{}",
    "keep.log": "keep",
    "valid/a.txt": "ignored"
  });
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/invalid-rules",
    stateDir: tempProjectRoot("hzignore-invalid-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), [".hzignore", "keep.log", "project.json"].sort());
  const warnings = transferSummaryOf(data).warnings as string[];
  assert.equal(warnings.length, invalidRules.length);
  assert.ok(warnings.every(item => item.includes(".hzignore")));
});

test(".hzignore 存在但读取失败时停止同步且不发起上传", async () => {
  const localRoot = tempProjectRoot("hzignore-unreadable");
  await createProjectFiles(localRoot, {
    "project.json": "{}",
    "lib/main.js": "module.exports = 1;"
  });
  await mkdir(join(localRoot, ".hzignore"));
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "unexpected" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_push");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/unreadable",
    mode: "full",
    stateDir: tempProjectRoot("hzignore-unreadable-state")
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "HZIGNORE_READ_FAILED");
  assert.match(result.message, /\.hzignore/);
  assert.equal(calls.some(call => call.toolName === "upload"), false);
  assert.equal(calls.some(call => call.toolName === "file.device.push"), false);
});

test("显式 excludes 与默认排除合并而不是覆盖", async () => {
  const localRoot = tempProjectRoot("exclude-merge");
  await createProjectFiles(localRoot, {
    "project.json": "{}",
    "keep.txt": "keep",
    "node_modules/pkg/index.js": "default excluded",
    "custom/cache.txt": "explicit excluded"
  });
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_plan");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/exclude-merge",
    excludes: "custom",
    stateDir: tempProjectRoot("exclude-merge-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  assert.deepEqual([...(data.added as string[])].sort(), ["keep.txt", "project.json"].sort());
  assert.deepEqual(transferSummaryOf(data).excludedDirectories, ["custom", "node_modules"]);
});

test("project_sync_push full 返回传输摘要且只上传保留文件", async () => {
  const localRoot = tempProjectRoot("push-summary");
  const hzignoreText = "dist\n";
  await createProjectFiles(localRoot, {
    ".hzignore": hzignoreText,
    "project.json": "{}",
    "keep.js": "keep",
    "dist/bundle.js": "ignored"
  });
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "push-summary" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_push");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/push-summary",
    mode: "full",
    stateDir: tempProjectRoot("push-summary-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  const summary = transferSummaryOf(data);
  assert.equal(summary.totalBytes, Buffer.byteLength(hzignoreText) + 6);
  assert.equal(summary.fileCount, 3);
  assert.deepEqual(summary.excludedDirectories, ["dist"]);
  assert.equal("ignoredFileCount" in summary, false);
  const uploads = calls.filter(call => call.toolName === "upload");
  assert.equal(uploads.length, 3);
  assert.equal(uploads.some(call => String(call.query?.relativePath || "").endsWith("/dist/bundle.js")), false);
});

test("project_sync_push incremental 将 .hzignore 命中路径放入 skipped", async () => {
  const localRoot = tempProjectRoot("push-incremental-ignored");
  await createProjectFiles(localRoot, {
    ".hzignore": "ignored\n",
    "project.json": "{}",
    "ignored/secret.txt": "do not transfer"
  });
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "unexpected" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_push");
  assert.ok(tool);

  const result = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot: "/sdcard/appSync/incremental-ignored",
    mode: "incremental",
    files: ["ignored/secret.txt"],
    stateDir: tempProjectRoot("push-incremental-ignored-state")
  });

  assert.equal(result.ok, true);
  const data = result.data as JsonObject;
  const skipped = data.skipped as JsonObject[];
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].path, "ignored/secret.txt");
  assert.match(String(skipped[0].reason), /\.hzignore/);
  assert.deepEqual(data.failed, []);
  assert.equal(calls.some(call => call.toolName === "upload"), false);
});

test("mirrorDelete 保留旧基线中的 .hzignore 路径且不生成删除候选", async () => {
  const localRoot = tempProjectRoot("mirror-ignore");
  const stateDir = tempProjectRoot("mirror-ignore-state");
  const remoteRoot = "/sdcard/appSync/mirror-ignore";
  await createProjectFiles(localRoot, {
    "project.json": "{}",
    "old/secret.txt": "keep remote"
  });
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "mirror" } }));
  const tools = buildProjectTools(ctx);
  const pushTool = tools.find(item => item.name === "project_sync_push");
  const planTool = tools.find(item => item.name === "project_sync_plan");
  assert.ok(pushTool);
  assert.ok(planTool);

  const initial = await pushTool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot,
    mode: "incremental",
    files: ["old/secret.txt"],
    stateDir
  });
  assert.equal(initial.ok, true);

  await createProjectFiles(localRoot, { ".hzignore": "old\n" });
  const plan = await planTool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot,
    stateDir
  });
  assert.equal(plan.ok, true);
  assert.equal((plan.data as JsonObject).deletedCandidates?.includes("old/secret.txt"), false);

  const mirrored = await pushTool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot,
    mode: "full",
    mirrorDelete: true,
    stateDir
  });
  assert.equal(mirrored.ok, true);
  assert.equal(calls.some(call => call.toolName === "file.device.operation"), false);
  assert.deepEqual(transferSummaryOf(mirrored.data as JsonObject).excludedDirectories, ["old"]);

  const key = createHash("sha256").update(localRoot + "|device-1|" + remoteRoot).digest("hex").slice(0, 32);
  const baseline = JSON.parse(await readFile(join(stateDir, "project-sync", key + ".json"), "utf8")) as {
    files: Record<string, unknown>;
  };
  assert.ok(baseline.files["old/secret.txt"]);
});

test("mirrorDelete 仍删除普通未忽略的旧基线路径", async () => {
  const localRoot = tempProjectRoot("mirror-normal-delete");
  const stateDir = tempProjectRoot("mirror-normal-delete-state");
  const remoteRoot = "/sdcard/appSync/mirror-normal-delete";
  await createProjectFiles(localRoot, {
    "project.json": "{}",
    "removed/old.txt": "remove me"
  });
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { taskId: "delete" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_sync_push");
  assert.ok(tool);

  const initial = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot,
    mode: "full",
    stateDir
  });
  assert.equal(initial.ok, true);
  await unlink(join(localRoot, "removed", "old.txt"));

  const mirrored = await tool.handler({
    localRoot,
    deviceId: "device-1",
    remoteRoot,
    mode: "full",
    mirrorDelete: true,
    stateDir
  });
  assert.equal(mirrored.ok, true);
  const removals = calls.filter(call => call.toolName === "file.device.operation");
  assert.equal(removals.length, 1);
  assert.equal(removals[0].params?.operation, "DELETE");
  assert.equal(removals[0].params?.path, remoteRoot + "/removed/old.txt");

  const key = createHash("sha256").update(localRoot + "|device-1|" + remoteRoot).digest("hex").slice(0, 32);
  const baseline = JSON.parse(await readFile(join(stateDir, "project-sync", key + ".json"), "utf8")) as {
    files: Record<string, unknown>;
  };
  assert.equal(baseline.files["removed/old.txt"], undefined);
});

test("同步工具描述说明根 .hzignore、排除合并和传输摘要", () => {
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  for (const name of ["project_sync_plan", "project_sync_push"]) {
    const tool = buildProjectTools(ctx).find(item => item.name === name);
    assert.ok(tool);
    const description = String(tool.description || "");
    assert.match(description, /\.hzignore/);
    assert.match(description, /根目录/);
    assert.match(description, /默认排除/);
    assert.match(description, /合并/);
    assert.match(description, /transferSummary/);
    assert.match(description, /totalBytes/);
    assert.match(description, /excludedDirectories/);
    assert.doesNotMatch(description, /ignoredFileCount/);
  }
});

test("project_run reads project.json from device before submitting RUN_PROJECT", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, (toolName) => {
    if (toolName === "file.device.readText") {
      const path = String((calls[calls.length - 1].params as JsonObject).path || "");
      if (path.endsWith("/project.json")) {
        return {
          ok: true,
          code: "OK",
          message: "OK",
          data: { status: "SUCCEEDED", result: { content: JSON.stringify({ main: "main.js" }) } }
        };
      }
      return { ok: true, code: "OK", message: "OK", data: { status: "SUCCEEDED", result: { content: "toast(1)" } } };
    }
    return { ok: true, code: "OK", message: "OK", data: { taskId: "task-run-project", taskStatus: "SUCCEEDED" } };
  });
  const tool = buildProjectTools(ctx).find(item => item.name === "project_run");
  assert.ok(tool);

  const result = await tool.handler({
    deviceId: "device-1",
    projectPath: "/sdcard/appSync/project",
    waitForResult: false
  });

  assert.equal(result.ok, true);
  const reads = calls.filter(call => call.toolName === "file.device.readText").map(call => (call.params as JsonObject).path);
  assert.deepEqual(reads, ["/sdcard/appSync/project/project.json", "/sdcard/appSync/project/main.js"]);
  const submit = calls.find(call => call.toolName === "device.script.runFile");
  assert.equal(submit?.params?.taskMode, "RUN_PROJECT");
  assert.equal(submit?.params?.scriptPath, "/sdcard/appSync/project");
});

test("project_run rejects missing project.json on device without falling back to script run", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({
    ok: false,
    code: "TOOL_EXECUTION_FAILED",
    message: "文件不存在: /sdcard/appSync/project/project.json"
  }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_run");
  assert.ok(tool);

  const result = await tool.handler({
    deviceId: "device-1",
    projectPath: "/sdcard/appSync/project",
    waitForResult: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "PROJECT_JSON_UNAVAILABLE");
  assert.equal(calls.some(call => call.toolName === "device.script.runFile"), false);
});

test("project MCP internal canonical calls resolve pending confirmation instead of failing silently", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, toolName => ({
    ok: false,
    code: "FULL_AUTO_DENIED",
    message: "工具自动开关未开启",
    data: {
      toolName,
      status: "PENDING_CONFIRMATION",
      authorizationUrl: "https://v5.example.com/#/devices?deviceAccess=required&source=mcp&deviceId=device-1",
      pendingAction: {
        actionId: "act-project-1",
        status: "PENDING",
        riskLevel: "WRITE",
        payloadJson: JSON.stringify({ params: { deviceId: "device-1" } }),
        confirmUrl: "https://v5.example.com/#/tool-confirm?actionId=act-project-1&source=mcp",
        deviceAccessSatisfied: false
      }
    }
  }));
  let elicitationCalled = false;
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => {
    elicitationCalled = true;
    return "accept";
  };

  const tool = buildProjectTools(ctx).find(item => item.name === "device_file_read_text");
  assert.ok(tool);
  const result = await tool.handler({ deviceId: "device-1", path: "/sdcard/appSync/project.json" });

  assert.equal(elicitationCalled, false, "设备访问未满足时不应发起 elicitation");
  assert.equal(result.ok, false);
  assert.equal(result.code, "DEVICE_ACCESS_REQUIRED");
  assert.equal((result.data as JsonObject).authorizationUrl, "https://v5.example.com/#/devices?deviceAccess=required&source=mcp&deviceId=device-1");
});

test("project run surfaces pending confirmation from internal project.json read", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, toolName => ({
    ok: false,
    code: "FULL_AUTO_DENIED",
    message: "工具自动开关未开启",
    data: {
      toolName,
      status: "PENDING_CONFIRMATION",
      pendingAction: {
        actionId: "act-project-2",
        status: "PENDING",
        riskLevel: "WRITE",
        payloadJson: JSON.stringify({ params: { deviceId: "device-1" } }),
        confirmUrl: "https://v5.example.com/#/tool-confirm?actionId=act-project-2&source=mcp",
        deviceAccessSatisfied: true
      }
    }
  }));
  ctx.supportsElicitation = () => true;
  ctx.requestConfirmation = async () => "accept";
  (ctx.client as any).confirmPendingAction = async (actionId: string) => {
    calls.push({ toolName: "confirmPendingAction", actionId });
    return {
      ok: true,
      code: "OK",
      message: "ok",
      data: { payloadJson: JSON.stringify({ execution: { status: "SUCCEEDED", result: { content: "{}" } } }) }
    };
  };
  const tool = buildProjectTools(ctx).find(item => item.name === "project_run");
  assert.ok(tool);
  const result = await tool.handler({ deviceId: "device-1", projectPath: "/sdcard/appSync/demo", waitForResult: false });

  const confirmCall = calls.find(call => call.toolName === "confirmPendingAction");
  assert.ok(confirmCall, "项目运行读取 project.json 时应在确认后继续");
});

test("project_build omits unset capability switches so backend follows project.json", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { jobId: "job1" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_build");
  assert.ok(tool, "project_build should be registered");

  await tool.handler({
    sourceType: "PUBLIC",
    publicPath: "projects/demo",
    appName: "Demo",
    packageName: "com.demo.app"
  });

  const build = calls.find(call => call.toolName === "packaging.build");
  assert.ok(build, "packaging.build should be invoked");
  const params = build.params as JsonObject;
  assert.equal(params.appName, "Demo");
  assert.equal(params.packageName, "com.demo.app");
  // 关键：未显式传入的能力开关不得出现在请求里，否则会静默覆盖 project.json。
  assert.equal("openImageModule" in params, false);
  assert.equal("openNodeJs" in params, false);
  assert.equal("openObfuscator" in params, false);
  assert.equal("openJsToDex" in params, false);
  assert.equal("plugins" in params, false);
  assert.equal("abis" in params, false);
  assert.equal("tempPackagingMode" in params, false);
});

test("project_build forwards explicit openJsToDex and jsToDexExcludePaths", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { jobId: "job-js2dex" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_build");
  assert.ok(tool);

  await tool.handler({
    sourceType: "PUBLIC",
    publicPath: "projects/demo",
    openJsToDex: true,
    jsToDexExcludePaths: "lib,plugins"
  });

  const params = (calls.find(call => call.toolName === "packaging.build") as JsonObject).params as JsonObject;
  assert.equal(params.openJsToDex, true);
  assert.equal(params.jsToDexExcludePaths, "lib,plugins");
  assert.equal("openObfuscator" in params, false);
  assert.equal("obfuscatorExcludePaths" in params, false);
});

test("project_build forwards explicit openImageModule=false without inventing other fields", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { jobId: "job2" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_build");
  assert.ok(tool);

  await tool.handler({
    sourceType: "PUBLIC",
    publicPath: "projects/demo",
    openImageModule: false
  });

  const params = (calls.find(call => call.toolName === "packaging.build") as JsonObject).params as JsonObject;
  assert.equal(params.openImageModule, false);
  assert.equal("openNodeJs" in params, false);
  assert.equal("plugins" in params, false);
  assert.equal("appName" in params, false);
});

test("project_build forwards explicit openImageModule=true for full-feature packaging", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { jobId: "job3" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_build");
  assert.ok(tool);

  await tool.handler({
    sourceType: "PUBLIC",
    publicPath: "projects/demo",
    openImageModule: true,
    openNodeJs: false,
    plugins: ["org.autojs.autojspro.ocr.v2"],
    abis: ["arm64-v8a", "armeabi-v7a"]
  });

  const params = (calls.find(call => call.toolName === "packaging.build") as JsonObject).params as JsonObject;
  assert.equal(params.openImageModule, true);
  assert.equal(params.openNodeJs, false);
  assert.deepEqual(params.plugins, ["org.autojs.autojspro.ocr.v2"]);
  assert.deepEqual(params.abis, ["arm64-v8a", "armeabi-v7a"]);
});

test("project_build forwards Node dependency installation overrides", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, () => ({ ok: true, code: "OK", message: "OK", data: { jobId: "job4" } }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_build");
  assert.ok(tool);

  await tool.handler({
    sourceType: "PUBLIC",
    publicPath: "projects/demo",
    openNodeJs: true,
    installNodeDependencies: true,
    nodeDependencyRegistry: "https://registry.npmmirror.com"
  });

  const params = (calls.find(call => call.toolName === "packaging.build") as JsonObject).params as JsonObject;
  assert.equal(params.openNodeJs, true);
  assert.equal(params.installNodeDependencies, true);
  assert.equal(params.nodeDependencyRegistry, "https://registry.npmmirror.com");
});

test("project_build exposes capability switch semantics in its description", () => {
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_build");
  assert.ok(tool);
  const description = String(tool.description || "");
  assert.match(description, /project\.json/);
  assert.match(description, /openImageModule/);
  assert.match(description, /libopencv_java4\.so/);
  assert.match(description, /不回写/);
});

test("project_dependencies_status maps to the canonical read-only dependency status tool", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, toolName => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: { deviceId: "device-1", projectPath: "/sdcard/appSync/demo", hasPackageJson: true, hasNodeModules: false }
  }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_dependencies_status");
  assert.ok(tool, "project_dependencies_status should be registered");

  const result = await tool.handler({ deviceId: "device-1", projectPath: "/sdcard/appSync/demo" });

  assert.equal(result.ok, true);
  const call = calls.find(item => item.toolName === "packaging.project.dependencies.status");
  assert.ok(call, "canonical dependency status should be invoked");
  assert.equal(call.params?.deviceId, "device-1");
  assert.equal(call.params?.projectPath, "/sdcard/appSync/demo");
});

test("project_install_dependencies maps to the canonical install tool and forwards registry/force", async () => {
  const calls: JsonObject[] = [];
  const ctx = projectContext(calls, toolName => ({
    ok: true,
    code: "OK",
    message: "OK",
    data: { jobId: "dep-job-1", status: "PENDING" }
  }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_install_dependencies");
  assert.ok(tool, "project_install_dependencies should be registered");

  const result = await tool.handler({
    deviceId: "device-1",
    projectPath: "/sdcard/appSync/demo",
    registry: "https://registry.npmmirror.com",
    force: true
  });

  assert.equal(result.ok, true);
  const call = calls.find(item => item.toolName === "packaging.project.dependencies.install");
  assert.ok(call, "canonical dependency install should be invoked");
  assert.equal(call.params?.deviceId, "device-1");
  assert.equal(call.params?.projectPath, "/sdcard/appSync/demo");
  assert.equal(call.params?.registry, "https://registry.npmmirror.com");
  assert.equal(call.params?.force, true);
});

test("project_install_dependencies documents the server-side Node 16 toolchain and skip rule", () => {
  const ctx = projectContext([], () => ({ ok: true, code: "OK", message: "OK", data: {} }));
  const tool = buildProjectTools(ctx).find(item => item.name === "project_install_dependencies");
  assert.ok(tool);
  const description = String(tool.description || "");
  assert.match(description, /Node 16/);
  assert.match(description, /node_modules/);
  assert.match(description, /npm ci/);
  assert.match(description, /--ignore-scripts/);
});
