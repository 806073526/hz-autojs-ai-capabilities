import { createHash } from "node:crypto";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { JsonObject, McpToolDefinition, ToolContext, ToolOutcome } from "../../core/types.js";
import { executeCanonicalWithConfirmation } from "../../core/pendingConfirmation.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  fail,
  objectSchema,
  ok,
  optionalBoolean,
  optionalString,
  requireString,
  taskIdFromSubmitResult
} from "../../device/tools/common.js";

interface BaselineEntry {
  hash: string;
  size: number;
}

interface BaselineFile {
  version: number;
  localRoot: string;
  deviceId: string;
  remoteRoot: string;
  updatedAt: string;
  files: Record<string, BaselineEntry>;
  lastResult?: JsonObject;
  /** 未完成批次标记：客户端调用被超时打断后，下一次同名批次据此直接断点续传。 */
  inFlightStaging?: InFlightStaging;
}

interface InFlightStaging {
  path: string;
  batchKey: string;
  startedAt: string;
}

interface UploadedFileRef {
  id?: number | string;
  fileId?: number | string;
}

interface ResumableUploadStatusPayload {
  uploadKey?: string;
  uploadedChunks?: unknown[];
  completed?: boolean;
  fileId?: number | string;
}

interface TransferSummary {
  totalBytes: number;
  fileCount: number;
  excludedDirectories: string[];
  configFound: boolean;
  warnings: string[];
}

interface HzIgnoreConfig {
  rules: string[];
  configFound: boolean;
  warnings: string[];
}

const BASELINE_VERSION = 1;
const DEFAULT_EXCLUDES = "node_modules,.git,dist,build,logs,target";
const HZIGNORE_FILE = ".hzignore";
/** 公共库里的项目暂存根；整批下发结束后立即清理，不长期占用公共库。 */
const PUSH_STAGING_PREFIX = "mcp-project-sync";
/** 等待设备端整批下发完成的默认上限。 */
const DEFAULT_PUSH_WAIT_TIMEOUT_MS = 600000;

/**
 * 项目同步编排。
 *
 * 完整同步基线只保存在 MCP 客户端本地状态目录；V5 只保存映射记录与最近同步摘要。
 *
 * 上传复用 V5 现有单文件上传接口（上传到公共库的暂存目录），下发复用 V5 现有「目录下发」任务：
 * 一批文件只提交一个 FILE_PUSH 任务，设备端只弹一次「目录下发」窗口，逐文件结果由任务回传。
 * 不得回退成「一个文件一个任务」：设备端每个 FILE_PUSH 任务都会弹一次「文件下发」窗口，
 * 实测 811 个文件弹 811 次、排队 13 分钟，用户明确拒绝该模式。
 */
export function syncTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "project_sync_plan",
      "按本地文件相对最近一次同步基线的变化计算差异（新增/修改/删除候选/冲突），只计算不写设备；不读取设备端实际内容，设备端外部改动不参与差异。仅读取 localRoot 根目录单个 .hzignore（不读取子目录，也不向父目录搜索）：每行是精确根相对路径，命中路径自身及全部子树，区分大小写；空行和 # 注释忽略，非法或通配符规则记录 warning 后跳过。默认排除始终与显式 excludes 合并。返回 transferSummary，包含 totalBytes、fileCount、excludedDirectories、configFound、warnings。",
      objectSchema({
        localRoot: { type: "string", description: "本地项目根绝对路径。" },
        deviceId: DEVICE_ID_PROPERTY,
        remoteRoot: { type: "string", description: "设备端项目根绝对路径。" },
        excludes: { type: "string", description: "排除规则，逗号分隔。" },
        stateDir: { type: "string", description: "本地同步状态目录，留空时使用 HZ_MCP_STATE_DIR。" },
        deviceAccessToken: { type: "string" },
        maxEntries: { type: "number", default: 5000 }
      }, ["localRoot", "deviceId", "remoteRoot"]),
      async args => planSync(ctx, args)
    ),

    createTool(
      "project_sync_push",
      "按显式文件清单执行同步；mode 支持 full 和 incremental，mirror_delete 必须显式开启。只下发本地相对基线发生变化的文件（不检测设备端外部改动）。仅读取 localRoot 根目录单个 .hzignore（不读取子目录，也不向父目录搜索），命中路径及子树；默认排除始终与显式 excludes 合并。full 只上传扫描后保留的文件；incremental 中命中 .hzignore 的请求进入 skipped；mirrorDelete 不删除被 .hzignore 忽略的旧基线远端文件。返回 transferSummary，包含 totalBytes、fileCount、excludedDirectories、configFound、warnings。整批只提交一个设备任务，设备端只弹一次「目录下发」窗口。超过 HZ_MCP_UPLOAD_RESUMABLE_THRESHOLD_BYTES 的大文件自动走分片/断点续传上传，调用被打断后重跑同一批清单会从已完成分片继续。",
      objectSchema({
        localRoot: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        remoteRoot: { type: "string" },
        mode: { type: "string", enum: ["full", "incremental"], default: "incremental" },
        files: { type: "array", description: "显式文件清单；incremental 必填。", items: { type: "string" } },
        mirrorDelete: { type: "boolean", description: "是否删除远端多余文件，默认 false。", default: false },
        waitTimeoutMs: { type: "number", description: "等待设备端整批下发完成的毫秒数，超时不写入基线，默认 600000。", default: 600000 },
        excludes: { type: "string" },
        stateDir: { type: "string" },
        deviceAccessToken: { type: "string" }
      }, ["localRoot", "deviceId", "remoteRoot"]),
      async args => pushSync(ctx, args)
    ),

    createTool(
      "project_sync_status",
      "返回本地根、设备、远端根、本地基线版本、最近同步结果和失败项。",
      objectSchema({
        localRoot: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        remoteRoot: { type: "string" },
        stateDir: { type: "string" }
      }, ["localRoot", "deviceId", "remoteRoot"]),
      async args => syncStatus(ctx, args)
    )
  ];
}

async function planSync(_ctx: ToolContext, args: JsonObject): Promise<ToolOutcome> {
  const localRoot = resolve(requireString(args, "localRoot"));
  const deviceId = requireString(args, "deviceId");
  const remoteRoot = requireString(args, "remoteRoot");
  const maxEntries = Math.max(1, Math.round(Number(args.maxEntries) || 5000));

  const local = await scanLocal(localRoot, parseExcludes(optionalString(args, "excludes")), maxEntries);
  if (!local.ok) return local.outcome;

  const baseline = await readBaseline(baselinePath(_ctx, args, localRoot, deviceId, remoteRoot));
  const previous = baseline?.files ?? {};
  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  for (const [path, entry] of Object.entries(local.files)) {
    const known = previous[path];
    if (!known) added.push(path);
    else if (known.hash !== entry.hash) modified.push(path);
    else unchanged.push(path);
  }
  const deletedCandidates = Object.keys(previous).filter(path =>
    !local.files[path] && !isHzIgnored(path, local.hzIgnoreRules));
  const conflict: JsonObject[] = [];
  if (!local.files["project.json"]) {
    conflict.push({ path: "project.json", reason: "本地项目根缺少 project.json。" });
  }

  return ok("同步计划已计算", {
    localRoot,
    deviceId,
    remoteRoot,
    baselineVersion: baseline?.version ?? 0,
    hasLocalBaseline: !!baseline,
    added,
    modified,
    deletedCandidates,
    unchanged,
    conflict,
    transferSummary: local.transferSummary,
    totals: {
      added: added.length,
      modified: modified.length,
      deleted: deletedCandidates.length,
      unchanged: unchanged.length,
      conflict: conflict.length
    }
  });
}

async function pushSync(ctx: ToolContext, args: JsonObject): Promise<ToolOutcome> {
  const localRoot = resolve(requireString(args, "localRoot"));
  const deviceId = requireString(args, "deviceId");
  const remoteRoot = requireString(args, "remoteRoot");
  const mode = (optionalString(args, "mode") || "incremental").toLowerCase();
  const mirrorDelete = optionalBoolean(args, "mirrorDelete", false);
  const deviceAccessToken = optionalString(args, "deviceAccessToken");
  const waitTimeoutMs = Math.min(3600000, Math.max(5000, Math.round(Number(args.waitTimeoutMs) || DEFAULT_PUSH_WAIT_TIMEOUT_MS)));

  const local = await scanLocal(localRoot, parseExcludes(optionalString(args, "excludes")), 20000);
  if (!local.ok) return local.outcome;

  const path = baselinePath(ctx, args, localRoot, deviceId, remoteRoot);
  const baseline = await readBaseline(path);
  const previous = baseline?.files ?? {};

  const explicit = Array.isArray(args.files) ? args.files.map(item => String(item).trim()).filter(Boolean) : [];
  let targets: string[];
  if (mode === "full") {
    targets = Object.keys(local.files);
  } else {
    if (!explicit.length) return fail("FILES_REQUIRED", "incremental 同步需要显式传入 files 清单");
    targets = explicit;
  }

  const succeeded: JsonObject[] = [];
  const skipped: JsonObject[] = [];
  const conflict: JsonObject[] = [];
  const failed: JsonObject[] = [];
  const pending: string[] = [];

  for (const raw of targets) {
    const relativePath = normalizeRelative(raw);
    if (!relativePath) {
      failed.push({ path: raw, reason: "非法路径" });
      continue;
    }
    if (isHzIgnored(relativePath, local.hzIgnoreRules)) {
      skipped.push({ path: relativePath, reason: "被 .hzignore 排除" });
      continue;
    }
    const entry = local.files[relativePath];
    if (!entry) {
      failed.push({ path: relativePath, reason: "本地文件不存在" });
      continue;
    }
    const known = previous[relativePath];
    if (known && known.hash === entry.hash && known.size === entry.size) {
      skipped.push({ path: relativePath, reason: "内容未变化" });
      continue;
    }
    pending.push(relativePath);
  }

  // 整批一次下发：先上传到公共库暂存目录，再用一个 FILE_PUSH 任务下发整个目录。
  // 设备端因此只弹一次「目录下发」窗口，逐文件结果由该任务回传。
  let deviceTask: JsonObject | undefined;
  let staging: JsonObject | undefined;
  const awaiting: string[] = [];
  if (pending.length) {
    const base = stagingBase(localRoot, deviceId, remoteRoot);
    // 批次键由清单内容派生：同一批文件重跑时路径稳定，分片会话与已上传文件都能续传。
    const batchKey = batchKeyOf(pending, local.files);
    const stagingPath = base + "/" + batchKey;
    const inFlight = baseline?.inFlightStaging;
    const resuming = inFlight?.batchKey === batchKey && inFlight?.path === stagingPath;
    if (!resuming) {
      // 新批次才清历史残留，避免旧副本混进下发清单；同批次续传必须保留已上传内容。
      await ctx.client.delete("/api/file/public/path", { sourcePath: base });
    }
    // 先记录在途批次：调用被 MCP 客户端超时打断后，下一次同名批次可直接断点续传。
    await writeBaseline(path, {
      version: BASELINE_VERSION,
      localRoot,
      deviceId,
      remoteRoot,
      updatedAt: new Date().toISOString(),
      files: previous,
      lastResult: baseline?.lastResult,
      inFlightStaging: { path: stagingPath, batchKey, startedAt: new Date().toISOString() }
    });
    const uploaded = await uploadBatch(ctx, localRoot, stagingPath, pending, local.files, failed);
    let settled = true;
    if (uploaded.length) {
      const push = await pushBatch(ctx, deviceId, remoteRoot, stagingPath, deviceAccessToken);
      if (!push.ok || !push.taskId) {
        for (const relativePath of uploaded) {
          failed.push({ path: relativePath, reason: push.message || "下发任务未返回任务 ID", result: push.data });
        }
      } else {
        const wait = await ctx.client.waitForTask(push.taskId, { timeoutMs: waitTimeoutMs });
        settled = wait.code !== "TASK_WAIT_TIMEOUT";
        const taskOk = wait.ok;
        const reasons = deviceFailureReasons(wait.data);
        for (const relativePath of uploaded) {
          if (!settled) {
            awaiting.push(relativePath);
            continue;
          }
          const reason = reasons.get(relativePath);
          if (reason) {
            failed.push({ path: relativePath, reason: reason.message });
            continue;
          }
          // 任务整体失败（FAILED/CANCELLED）时没有逐文件清单，不能把未报失败的文件当成已下发。
          if (!taskOk) {
            failed.push({ path: relativePath, reason: wait.message || "设备任务未成功完成" });
            continue;
          }
          succeeded.push({ path: relativePath, hash: local.files[relativePath].hash });
        }
        deviceTask = {
          taskId: push.taskId,
          settled,
          status: taskStatusOf(wait),
          message: wait.message,
          summary: deviceTaskSummary(wait.data)
        };
      }
    }
    if (settled) {
      const cleanup = await ctx.client.delete("/api/file/public/path", { sourcePath: stagingPath });
      staging = { path: stagingPath, batchKey, cleaned: cleanup.ok, message: cleanup.ok ? undefined : cleanup.message };
    } else {
      // 设备还在按清单下载，此时清暂存目录会让下载 404；留给下一次同步清理。
      staging = { path: stagingPath, batchKey, cleaned: false, message: "设备任务未结束，暂存目录保留到下一次同步清理" };
    }
  }

  if (mirrorDelete) {
    for (const relativePath of Object.keys(previous).filter(item =>
      !local.files[item] && !isHzIgnored(item, local.hzIgnoreRules))) {
      const removal = await executeCanonicalWithConfirmation(ctx, "file.device.operation", {
        deviceId,
        operation: "DELETE",
        path: `${remoteRoot}/${relativePath}`,
        deviceAccessToken
      });
      if (removal.ok) succeeded.push({ path: relativePath, deleted: true });
      else failed.push({ path: relativePath, reason: removal.message, result: removal });
    }
  }

  const nextFiles: Record<string, BaselineEntry> = { ...previous };
  for (const item of succeeded) {
    const relativePath = String(item.path || "");
    if (item.deleted === true) delete nextFiles[relativePath];
    else if (local.files[relativePath]) nextFiles[relativePath] = local.files[relativePath];
  }

  const overall = failed.length === 0 && conflict.length === 0;
  const lastResult: JsonObject = {
    at: new Date().toISOString(),
    mode,
    mirrorDelete,
    targets: targets.length,
    succeeded: succeeded.length,
    skipped: skipped.length,
    conflict: conflict.length,
    failed: failed.length,
    awaiting: awaiting.length,
    deviceTask,
    staging,
    failureItems: failed
  };
  await writeBaseline(path, {
    version: BASELINE_VERSION,
    localRoot,
    deviceId,
    remoteRoot,
    updatedAt: new Date().toISOString(),
    files: nextFiles,
    lastResult
  });

  await saveV5Mapping(ctx, localRoot, deviceId, remoteRoot, lastResult);

  const payload = {
    overall,
    partial: !overall && succeeded.length > 0,
    mode,
    mirrorDelete,
    localRoot,
    deviceId,
    remoteRoot,
    succeeded,
    skipped,
    conflict,
    failed,
    awaiting,
    deviceTask,
    staging,
    transferSummary: local.transferSummary,
    lastResult
  };
  return overall
    ? ok("同步完成", payload)
    : fail("PARTIAL_SYNC", "同步未全部成功；详见 succeeded/skipped/conflict/failed", payload);
}

async function syncStatus(ctx: ToolContext, args: JsonObject): Promise<ToolOutcome> {
  const localRoot = resolve(requireString(args, "localRoot"));
  const deviceId = requireString(args, "deviceId");
  const remoteRoot = requireString(args, "remoteRoot");
  const baseline = await readBaseline(baselinePath(ctx, args, localRoot, deviceId, remoteRoot));
  const mapping = await ctx.client.get("/api/ai/project-mappings", { deviceId });
  const mappingRecords = Array.isArray(mapping.data) ? mapping.data as JsonObject[] : [];
  const v5Mapping = mappingRecords.find(item => String(item.remoteRoot || "") === remoteRoot) || null;
  return ok("同步状态", {
    localRoot,
    deviceId,
    remoteRoot,
    baselineVersion: baseline?.version ?? 0,
    hasLocalBaseline: !!baseline,
    localBaselineUpdatedAt: baseline?.updatedAt,
    localBaselineFileCount: baseline ? Object.keys(baseline.files).length : 0,
    lastResult: baseline?.lastResult ?? null,
    failureItems: baseline?.lastResult?.failureItems ?? [],
    v5MappingAvailable: mapping.ok,
    v5Mapping: v5Mapping,
    note: baseline
      ? "本地完整基线来自 MCP 客户端状态目录；V5 映射记录是独立审计事实。"
      : "本地完整基线不存在；V5 最近摘要不能当作完整基线。"
  });
}

async function scanLocal(
  localRoot: string,
  excludes: string[],
  maxEntries: number
): Promise<{
  ok: true;
  files: Record<string, BaselineEntry>;
  hzIgnoreRules: string[];
  transferSummary: TransferSummary;
} | { ok: false; outcome: ToolOutcome }> {
  const info = await stat(localRoot).catch(() => undefined);
  if (!info || !info.isDirectory()) {
    return { ok: false, outcome: fail("LOCAL_ROOT_INVALID", `本地项目根不存在或不是目录: ${localRoot}`) };
  }
  const hzIgnore = await loadHzIgnore(localRoot);
  if (!hzIgnore.ok) return { ok: false, outcome: hzIgnore.outcome };

  const files: Record<string, BaselineEntry> = {};
  const excludedDirectories = new Set<string>();
  let count = 0;
  let totalBytes = 0;
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (count >= maxEntries) return;
      const absolute = join(dir, entry.name);
      const relativePath = toPosix(relative(localRoot, absolute));
      const isConfigFile = relativePath === HZIGNORE_FILE;
      if (!isConfigFile && isHzIgnored(relativePath, hzIgnore.rules)) {
        if (entry.isDirectory()) excludedDirectories.add(relativePath);
        continue;
      }
      if (!isConfigFile && isExcluded(relativePath, excludes)) {
        if (entry.isDirectory()) excludedDirectories.add(relativePath);
        continue;
      }
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const buffer = await readFile(absolute);
        files[relativePath] = { hash: createHash("sha256").update(buffer).digest("hex"), size: buffer.length };
        totalBytes += buffer.length;
        count += 1;
      }
    }
  };
  await walk(localRoot);
  return {
    ok: true,
    files,
    hzIgnoreRules: hzIgnore.rules,
    transferSummary: {
      totalBytes,
      fileCount: count,
      excludedDirectories: [...excludedDirectories].sort(),
      configFound: hzIgnore.configFound,
      warnings: hzIgnore.warnings
    }
  };
}

async function loadHzIgnore(
  localRoot: string
): Promise<({ ok: true } & HzIgnoreConfig) | { ok: false; outcome: ToolOutcome }> {
  const configPath = join(localRoot, HZIGNORE_FILE);
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    const code = fileErrorCode(error);
    if (code === "ENOENT") {
      return { ok: true, rules: [], configFound: false, warnings: [] };
    }
    const suffix = code ? ` (${code})` : "";
    return {
      ok: false,
      outcome: fail("HZIGNORE_READ_FAILED", `读取根目录 .hzignore 失败，已停止同步: ${configPath}${suffix}`, {
        path: configPath
      })
    };
  }
  const parsed = parseHzIgnore(content);
  return { ok: true, rules: parsed.rules, configFound: true, warnings: parsed.warnings };
}

function parseHzIgnore(content: string): Pick<HzIgnoreConfig, "rules" | "warnings"> {
  const rules = new Set<string>();
  const warnings: string[] = [];
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) continue;
    const reason = invalidHzIgnoreReason(raw);
    if (reason) {
      warnings.push(`${HZIGNORE_FILE} 第 ${index + 1} 行已跳过（${reason}）: ${raw}`);
      continue;
    }
    rules.add(raw.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/+$/, ""));
  }
  return { rules: [...rules], warnings };
}

function invalidHzIgnoreReason(rule: string): string | undefined {
  if (rule.startsWith("!")) return "不支持否定规则";
  if (/[*?\[\]]/.test(rule)) return "不支持通配符或正则字符";
  if (/^[A-Za-z]:/.test(rule) || isAbsolute(rule) || /^[\\/]/.test(rule)) {
    return "不支持绝对路径或盘符路径";
  }
  if (rule.split(/[\\/]+/).some(segment => segment === "." || segment === "..")) {
    return "不支持 . 或 .. 路径段";
  }
  return undefined;
}

function fileErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code || "");
}

async function uploadOne(
  ctx: ToolContext,
  localRoot: string,
  relativePath: string,
  libraryPath: string,
  entry: BaselineEntry
): Promise<ToolOutcome<UploadedFileRef>> {
  const absolute = join(localRoot, relativePath.split("/").join(sep));
  if (entry.size > ctx.config.uploadResumableThresholdBytes) {
    return uploadResumable(ctx, absolute, relativePath, libraryPath, entry);
  }
  const buffer = await readFile(absolute);
  const slash = relativePath.lastIndexOf("/");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buffer)]), relativePath.slice(slash + 1));
  // V5 上传接口的 relativePath 是文件在公共库中的完整相对路径（含文件名）；
  // 同步统一走项目暂存目录，不再把项目文件散落到公共库根目录。
  return ctx.client.uploadMultipart<UploadedFileRef>("/api/file/upload", form, {
    isPublic: "true",
    relativePath: libraryPath
  });
}

/**
 * 大文件分片上传：会话键由「目标相对路径 + 文件大小 + SHA-256」派生，服务端逐片落盘。
 *
 * 中途失败或调用被 MCP 客户端超时打断后，重跑同一批清单会先查会话状态，只补未上传的分片；
 * 单次分片请求使用独立上传超时预算，不再受普通请求 120 秒上限约束。
 */
async function uploadResumable(
  ctx: ToolContext,
  absolute: string,
  relativePath: string,
  libraryPath: string,
  entry: BaselineEntry
): Promise<ToolOutcome<UploadedFileRef>> {
  const uploadKey = createHash("sha256").update(`${libraryPath}|${entry.size}|${entry.hash}`).digest("hex");
  const endpoint = `/api/file/upload/resumable/${uploadKey}`;
  const timeoutMs = ctx.config.uploadRequestTimeoutMs;
  const status = await readResumableUploadStatus(ctx, endpoint, timeoutMs);
  if (!status.ok) {
    const message = status.code === "HTTP_404" || status.code === "HTTP_405"
      ? `服务端不支持分片上传（${status.code}），请先升级 V5 服务端: ${status.message}`
      : status.message;
    return { ok: false, code: status.code, message, data: status.data };
  }
  if (status.completed) {
    const completedFileId = resolveUploadedFileId({ id: status.fileId });
    if (completedFileId !== undefined) {
      return { ok: true, code: "OK", message: "文件已存在，复用已完成上传", data: { id: completedFileId } };
    }
  }
  const chunkBytes = ctx.config.uploadChunkBytes;
  const chunkCount = Math.max(1, Math.ceil(entry.size / chunkBytes));
  const uploadedChunks = status.uploadedChunks;
  const handle = await open(absolute, "r");
  try {
    for (let index = 0; index < chunkCount; index++) {
      if (uploadedChunks.has(index)) continue;
      const start = index * chunkBytes;
      const length = Math.min(chunkBytes, entry.size - start);
      if (length <= 0) break;
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(chunk, 0, length, start);
      const payload = bytesRead === length ? chunk : chunk.subarray(0, bytesRead);
      let lastMessage = "";
      let succeeded = false;
      for (let attempt = 0; attempt <= ctx.config.uploadRetryCount; attempt++) {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(payload)], { type: "application/octet-stream" }), `chunk-${String(index).padStart(6, "0")}`);
        const response = await ctx.client.uploadMultipart<ResumableUploadStatusPayload>(
          `${endpoint}/chunk`, form, { chunkIndex: String(index) }, { timeoutMs });
        if (response.ok) {
          succeeded = true;
          break;
        }
        lastMessage = response.message || `分片 ${index} 上传失败`;
        if (attempt >= ctx.config.uploadRetryCount) break;
        // 请求可能已在服务端落盘只是响应丢失：重试前复查会话，避免重复上传整片。
        const recheck = await readResumableUploadStatus(ctx, endpoint, timeoutMs);
        if (recheck.ok && recheck.uploadedChunks.has(index)) {
          succeeded = true;
          break;
        }
        await sleep(1000 * (attempt + 1));
      }
      if (!succeeded) {
        return { ok: false, code: "CHUNK_UPLOAD_FAILED", message: `分片 ${index + 1}/${chunkCount} 上传失败: ${lastMessage}` };
      }
    }
  } finally {
    await handle.close();
  }
  return ctx.client.post<UploadedFileRef>(`${endpoint}/complete`, {
    chunkCount,
    fileSize: entry.size,
    relativePath: libraryPath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    contentType: "application/octet-stream",
    sha256: entry.hash
  }, undefined, undefined, { timeoutMs });
}

async function readResumableUploadStatus(
  ctx: ToolContext,
  endpoint: string,
  timeoutMs: number
): Promise<{
  ok: boolean;
  code: string;
  message: string;
  uploadedChunks: Set<number>;
  completed: boolean;
  fileId?: number | string;
  data?: JsonObject;
}> {
  const response = await ctx.client.get<ResumableUploadStatusPayload>(endpoint, undefined, undefined, { timeoutMs });
  const uploadedChunks = new Set<number>();
  const payload = response.data;
  if (payload && Array.isArray(payload.uploadedChunks)) {
    for (const item of payload.uploadedChunks) {
      const value = Number(item);
      if (Number.isInteger(value) && value >= 0) uploadedChunks.add(value);
    }
  }
  return {
    ok: response.ok,
    code: response.code,
    message: response.message,
    uploadedChunks,
    completed: payload?.completed === true,
    fileId: payload?.fileId,
    data: payload as JsonObject | undefined
  };
}

/** 上传本批文件到公共库暂存目录；上传失败的路径写进 failed，不进入下发清单。 */
async function uploadBatch(
  ctx: ToolContext,
  localRoot: string,
  stagingPath: string,
  paths: string[],
  files: Record<string, BaselineEntry>,
  failed: JsonObject[]
): Promise<string[]> {
  const uploaded: string[] = [];
  for (const relativePath of paths) {
    const entry = files[relativePath];
    if (!entry) {
      failed.push({ path: relativePath, reason: "本地文件不存在" });
      continue;
    }
    const upload = await uploadOne(ctx, localRoot, relativePath, stagingPath + "/" + relativePath, entry);
    const uploadedFileId = resolveUploadedFileId(upload.data);
    if (!upload.ok || uploadedFileId === undefined) {
      failed.push({ path: relativePath, reason: upload.message || "上传未返回文件库 ID" });
      continue;
    }
    uploaded.push(relativePath);
  }
  return uploaded;
}

/** 批次键只由清单内容派生：同一批文件重跑得到同一路径，便于断点续传与残留判断。 */
function batchKeyOf(paths: string[], files: Record<string, BaselineEntry>): string {
  return createHash("sha256")
    .update(paths.map(item => `${item}|${files[item]?.size ?? 0}|${files[item]?.hash ?? ""}`).join("\n"))
    .digest("hex")
    .slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 整批一次下发。
 *
 * V5 把来源目录展开成一个 FILE_PUSH 任务（entries 清单），设备端只弹一次「目录下发」窗口，
 * 并回传逐文件失败清单；禁止退回逐文件任务下发。
 */
async function pushBatch(
  ctx: ToolContext,
  deviceId: string,
  remoteRoot: string,
  stagingPath: string,
  deviceAccessToken?: string
): Promise<{ ok: boolean; message: string; data?: JsonObject; taskId?: string }> {
  const outcome = await executeCanonicalWithConfirmation(ctx, "file.device.push", {
    deviceId,
    sourcePath: stagingPath,
    isPublic: true,
    targetPath: remoteRoot,
    // 设备端按 md5 比对：内容一致的文件直接跳过，整批只落盘真正变化的文件。
    conflictPolicy: "SKIP_SAME_HASH",
    includeSourceRoot: false,
    deviceAccessToken
  });
  return {
    ok: outcome.ok,
    message: outcome.message,
    data: asRecord(outcome.data),
    taskId: taskIdFromPayload(outcome.data)
  };
}

/** 本项目专属暂存根：每次下发在其下开一个新目录，下发完成后整棵清掉。 */
function stagingBase(localRoot: string, deviceId: string, remoteRoot: string): string {
  const key = createHash("sha256").update(`${localRoot}|${deviceId}|${remoteRoot}`).digest("hex").slice(0, 12);
  const leaf = (remoteRoot.split("/").filter(Boolean).pop() || "project").replace(/[^A-Za-z0-9._-]+/g, "-");
  return `${PUSH_STAGING_PREFIX}/${leaf}-${key}`;
}

function taskIdFromPayload(data: unknown): string | undefined {
  const record = asRecord(data);
  return taskIdFromSubmitResult(record) ?? taskIdFromSubmitResult(asRecord(record.result));
}

function taskStatusOf(wait: ToolOutcome): string {
  const status = asRecord(wait.data).taskStatus;
  return typeof status === "string" && status ? status : wait.code;
}

/** 设备端逐文件失败清单：清单里的 path 是去掉暂存前缀后的项目相对路径。 */
function deviceFailureReasons(data: unknown): Map<string, { message: string }> {
  const reasons = new Map<string, { message: string }>();
  const payload = asRecord(asRecord(data).resultPayload);
  const failed = Array.isArray(payload.failed) ? payload.failed : [];
  for (const item of failed) {
    const record = asRecord(item);
    const path = normalizeRelative(String(record.path ?? ""));
    if (!path) continue;
    reasons.set(path, { message: String(record.message ?? "设备端写入失败") });
  }
  return reasons;
}

function deviceTaskSummary(data: unknown): JsonObject | undefined {
  const payload = asRecord(asRecord(data).resultPayload);
  if (!Object.keys(payload).length) return undefined;
  return {
    targetPath: payload.targetPath,
    downloadedCount: payload.downloadedCount,
    skippedCount: payload.skippedCount,
    directoryCount: payload.directoryCount,
    conflictPolicy: payload.conflictPolicy
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}


/**
 * V5 /api/file/upload 返回 FileEntity，主键字段是 id（JSON 字符串）。
 * 兼容读取 id / fileId，避免把成功上传误判为失败。
 */
function resolveUploadedFileId(data: UploadedFileRef | JsonObject | undefined): string | undefined {
  if (!data) return undefined;
  const raw = data.id ?? data.fileId;
  // V5 文件库主键是雪花 ID，JSON 中以字符串返回；必须以字符串透传，避免 JS 精度丢失。
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  return undefined;
}

/**
 * 把映射记录和最近同步摘要写回 V5。
 *
 * V5 只保存映射记录与摘要；完整同步基线仍在 MCP 客户端本地状态目录。
 */
async function saveV5Mapping(
  ctx: ToolContext,
  localRoot: string,
  deviceId: string,
  remoteRoot: string,
  lastResult: JsonObject
): Promise<void> {
  const localKey = createHash("sha256").update(localRoot).digest("hex").slice(0, 32);
  const result = await ctx.client.post("/api/ai/project-mappings", {
    localKey,
    deviceId,
    remoteRoot,
    mappingStatus: "ACTIVE",
    lastSyncSummary: {
      mode: lastResult.mode,
      targets: lastResult.targets,
      succeeded: lastResult.succeeded,
      skipped: lastResult.skipped,
      conflict: lastResult.conflict,
      failed: lastResult.failed,
      at: lastResult.at
    }
  });
  if (!result.ok) {
    await ctx.audit.log("project_mapping_save_failed", {
      deviceId,
      remoteRoot,
      message: result.message
    });
  }
}

function baselinePath(
  ctx: ToolContext,
  args: JsonObject,
  localRoot: string,
  deviceId: string,
  remoteRoot: string
): string {
  const stateDir = optionalString(args, "stateDir") || ctx.config.stateDir;
  const key = createHash("sha256").update(`${localRoot}|${deviceId}|${remoteRoot}`).digest("hex").slice(0, 32);
  return join(stateDir, "project-sync", `${key}.json`);
}

async function readBaseline(path: string): Promise<BaselineFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as BaselineFile;
    return parsed && parsed.files && typeof parsed.files === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeBaseline(path: string, baseline: BaselineFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(baseline, null, 2), "utf8");
}

function parseExcludes(value: string | undefined): string[] {
  const defaults = DEFAULT_EXCLUDES.split(/[,;，；\r\n]+/).map(item => item.trim()).filter(Boolean);
  const explicit = (value || "").split(/[,;，；\r\n]+/).map(item => item.trim()).filter(Boolean);
  return [...new Set([...defaults, ...explicit])];
}

function isExcluded(relativePath: string, excludes: string[]): boolean {
  return excludes.some(pattern => relativePath === pattern
    || relativePath.startsWith(`${pattern}/`)
    || relativePath.includes(`/${pattern}/`));
}

function isHzIgnored(relativePath: string, rules: string[]): boolean {
  if (relativePath === HZIGNORE_FILE) return false;
  return rules.some(rule => relativePath === rule || relativePath.startsWith(`${rule}/`));
}

function normalizeRelative(value: string): string | undefined {
  const normalized = toPosix(value).replace(/^\.?\//, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || normalized === "..") {
    return undefined;
  }
  return normalized;
}

function toPosix(value: string): string {
  return value.split(sep).join("/");
}
