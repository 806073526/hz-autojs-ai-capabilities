#!/usr/bin/env node
/**
 * Evidence capture helper for hz-autojs-task-explorer.
 *
 * Drives the device MCP over stdio and persists the raw exploration evidence:
 * the decoded screenshot bytes, the raw tool metadata, and a
 * hash-stamped entry in manifest.json.
 *
 * Screenshots default to JPEG q85: a full-resolution PNG frame is 2-3 MB and,
 * once the model has looked at it, it stays in the conversation and is re-sent
 * on every later turn - a handful of them can push the whole request past the
 * upstream size limit. Use --format png when exact pixel colours matter.
 *
 * Usage:
 *   node capture-evidence.mjs --device <id> --run <dir> --label <name> [options]
 *
 * Options:
 *   --state <STATE_ID>     state label stored with the record
 *   --note <text>          free-form note stored with the record
 *   --region x1,y1,x2,y2   capture only this region
 *   --wait-stable          wait for a stable frame (skip during animation)
 *   --format <png|jpg>     preview format written to disk (default: jpg)
 *   --quality <1-100>      jpeg quality for --format jpg (default: 85)
 *   --no-status            skip the device_status lookup
 *   --mcp-root <dir>       plugin mcp directory (default: auto-detect)
 *   --verify               verify existing manifest hashes; no capture
 *   --export-index <file>  write a commit-safe text index derived from manifest
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 截图落盘默认格式与体积预设：jpg/q85，约为全分辨率 PNG 的 1/8~1/10。 */
const DEFAULT_SCREENSHOT_FORMAT = "jpg";
const DEFAULT_JPEG_QUALITY = 85;
/** 超过这个体积就提示：图一旦被模型看过，会留在会话里每轮重发。 */
const SCREENSHOT_SIZE_WARN_BYTES = 1.5 * 1024 * 1024;

const SETTINGS = parseArgs(process.argv.slice(2));

if (SETTINGS.verify) {
  process.exit(runVerify());
}

if (SETTINGS.exportIndex) {
  process.exit(runExportIndex());
}

if (!SETTINGS.device || !SETTINGS.run || !SETTINGS.label) {
  console.error("用法: node capture-evidence.mjs --device <id> --run <dir> --label <name> [options]");
  process.exit(2);
}

const RUN_DIR = resolve(SETTINGS.run);
const SHOT_DIR = join(RUN_DIR, "screenshots");
const META_DIR = join(RUN_DIR, "meta");
const MANIFEST_PATH = join(RUN_DIR, "manifest.json");
const MCP_ROOT = resolveMcpRoot(SETTINGS.mcpRoot);
const ENTRY = join(MCP_ROOT, "dist", "device", "index.js");

if (!existsSync(ENTRY)) {
  console.error(`找不到设备 MCP 入口: ${ENTRY}`);
  process.exit(2);
}

for (const dir of [SHOT_DIR, META_DIR]) {
  mkdirSync(dir, { recursive: true });
}

class McpClient {
  constructor() {
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
  }

  start() {
    this.child = spawn(process.execPath, [ENTRY], {
      cwd: MCP_ROOT,
      env: {
        ...process.env,
        HZ_MCP_TRANSPORT: "stdio",
        HZ_MCP_CLIENT_ID: "hz-autojs-explore-evidence",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", () => {});
    this.child.on("exit", (code) => {
      for (const entry of this.pending.values()) {
        entry.reject(new Error(`设备 MCP 已退出 (code=${code})`));
      }
      this.pending.clear();
    });
    return this;
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  onMessage(message) {
    if (message.method === "elicitation/create" && message.id !== undefined) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        result: { action: "accept", content: { approved: true } },
      });
      return;
    }
    if (message.id === undefined) return;
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(`${message.error.code}: ${message.error.message}`));
    } else {
      entry.resolve(message.result);
    }
  }

  write(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  async handshake() {
    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "hz-autojs-evidence", version: "0.1.0" },
      },
      60000,
    );
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async call(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const blocks = flattenBlocks(result);
    const images = blocks.filter((block) => block.type === "image" && typeof block.data === "string");
    const texts = blocks.filter((block) => typeof block.text === "string").map((block) => block.text);
    return { result, images, texts };
  }

  stop() {
    try {
      this.child?.kill();
    } catch {
      // ignore
    }
  }
}

function parseArgs(argv) {
  const settings = { ocr: false, waitStable: false, status: true, verify: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case "--device":
        settings.device = argv[++index];
        break;
      case "--run":
        settings.run = argv[++index];
        break;
      case "--label":
        settings.label = argv[++index];
        break;
      case "--state":
        settings.state = argv[++index];
        break;
      case "--note":
        settings.note = argv[++index];
        break;
      case "--region":
        settings.region = argv[++index];
        break;
      case "--mcp-root":
        settings.mcpRoot = argv[++index];
        break;
      case "--wait-stable":
        settings.waitStable = true;
        break;
      case "--format":
        settings.format = argv[++index];
        break;
      case "--quality":
        settings.quality = argv[++index];
        break;
      case "--no-status":
        settings.status = false;
        break;
      case "--verify":
        settings.verify = true;
        break;
      case "--export-index":
        settings.exportIndex = argv[++index];
        break;
      case "--help":
      case "-h":
        settings.help = true;
        break;
      default:
        break;
    }
  }
  return settings;
}

function resolveScreenshotFormat(settings) {
  const raw = String(settings.format || DEFAULT_SCREENSHOT_FORMAT).trim().toLowerCase();
  const format = raw === "jpeg" ? "jpg" : raw;
  if (format !== "jpg" && format !== "png") {
    throw new Error(`--format 只支持 png / jpg，收到: ${settings.format}`);
  }
  let quality;
  if (format === "jpg") {
    const value = settings.quality === undefined ? DEFAULT_JPEG_QUALITY : Number(settings.quality);
    if (!Number.isFinite(value) || value < 1 || value > 100) {
      throw new Error(`--quality 需要 1-100 的数值，收到: ${settings.quality}`);
    }
    quality = Math.round(value);
  }
  return { format, extension: format === "jpg" ? ".jpg" : ".png", quality };
}

function flattenBlocks(node, output = []) {
  if (Array.isArray(node)) {
    for (const item of node) flattenBlocks(item, output);
    return output;
  }
  if (node && typeof node === "object") {
    if (node.type === "image" && typeof node.data === "string") output.push(node);
    else if (typeof node.text === "string") output.push(node);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") flattenBlocks(value, output);
    }
  }
  return output;
}

function resolveMcpRoot(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.HZ_MCP_ROOT) candidates.push(process.env.HZ_MCP_ROOT);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const codexHome = process.env.CODEX_HOME || (home ? join(home, ".codex") : "");
  if (codexHome) {
    candidates.push(...discoverPluginRoots(join(codexHome, "plugins", "cache", "hz-autojs-source", "hz-autojs-ai-capabilities")));
    candidates.push(...discoverPluginRoots(join(codexHome, "plugins", "cache", "openai-bundled", "hz-autojs-ai-capabilities")));
  }
  const here = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(here, "..", "..", "..", "..", "..", "mcp"));
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, "dist", "device", "index.js"))) return candidate;
  }
  throw new Error(
    "找不到设备 MCP。请传 --mcp-root，或设置 HZ_MCP_ROOT 指向插件 mcp 目录。",
  );
}

function discoverPluginRoots(parent) {
  if (!parent || !existsSync(parent)) return [];
  return readdirSync(parent)
    .filter((name) => statSync(join(parent, name)).isDirectory())
    .sort(compareVersionDesc)
    .map((name) => join(parent, name, "mcp"));
}

function compareVersionDesc(a, b) {
  return stampOf(b) - stampOf(a);
}

function stampOf(name) {
  const match = /\+hz\.(\d{14})/.exec(name);
  if (match) return Number(match[1]);
  const dotted = /(\d+)\.(\d+)\.(\d+)/.exec(name);
  if (!dotted) return 0;
  return Number(dotted[1]) * 1e12 + Number(dotted[2]) * 1e10 + Number(dotted[3]) * 1e8;
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    return {
      schemaVersion: 1,
      runId: basenameOf(RUN_DIR),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      device: {},
      app: {},
      records: [],
    };
  }
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    throw new Error(`manifest.json 解析失败: ${error.message}`);
  }
}

function saveManifest(manifest) {
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function basenameOf(path) {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
}

function parseJsonText(texts) {
  for (const text of texts) {
    if (!text || typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // keep looking
    }
  }
  return null;
}

function extractStatus(payload) {
  const source = payload?.data?.device || payload?.data || payload || {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
  };
  return {
    deviceId: pick("deviceId"),
    deviceName: pick("deviceName") || pick("model"),
    brand: pick("brand"),
    model: pick("model"),
    release: pick("release"),
    sdkInt: pick("sdkInt"),
    appVersion: pick("appVersion"),
    screenWidth: Number(pick("screenWidth")) || undefined,
    screenHeight: Number(pick("screenHeight")) || undefined,
    directControlMode: pick("directControlMode"),
    deviceStatus: pick("deviceStatus"),
  };
}

function extractPackage(payload) {
  const source = payload?.data?.resultPayload || payload?.data || payload || {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (source[key] !== undefined && source[key] !== null) return source[key];
    }
    return undefined;
  };
  return {
    packageName: pick("packageName", "currentPackage", "package"),
    activity: pick("activity", "currentActivity", "activityName"),
    appName: pick("appName", "applicationName", "label"),
  };
}

function nextSequence(records) {
  return records.reduce((max, record) => Math.max(max, Number(record.seq) || 0), 0) + 1;
}

function hashFile(file) {
  const bytes = readFileSync(file);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function runVerify() {
  if (!SETTINGS.run) {
    console.error("用法: node capture-evidence.mjs --run <dir> --verify");
    return 2;
  }
  const runDir = resolve(SETTINGS.run);
  const manifestPath = join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`找不到 ${manifestPath}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let ok = 0;
  let bad = 0;
  for (const record of manifest.records || []) {
    const file = join(runDir, record.screenshot?.file || "");
    if (!record.screenshot?.file || !existsSync(file)) {
      console.log(`缺失  #${record.seq} ${record.label}`);
      bad += 1;
      continue;
    }
    const actual = hashFile(file);
    const expected = record.screenshot || {};
    if (actual.sha256 === expected.sha256 && actual.bytes === expected.bytes) {
      ok += 1;
    } else {
      console.log(`不一致 #${record.seq} ${record.label}`);
      bad += 1;
    }
  }
  console.log(JSON.stringify({ run: basenameOf(runDir), ok, bad, records: (manifest.records || []).length }));
  return bad === 0 ? 0 : 1;
}

function runExportIndex() {
  if (!SETTINGS.run) {
    console.error("用法: node capture-evidence.mjs --run <dir> --export-index <file>");
    return 2;
  }
  const runDir = resolve(SETTINGS.run);
  const manifestPath = join(runDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`找不到 ${manifestPath}`);
    return 2;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const index = {
    schemaVersion: 1,
    runId: manifest.runId || basenameOf(runDir),
    exportedAt: new Date().toISOString(),
    note: "由 manifest.json 派生的可提交索引；原始截图与工具返回留在 data/exploration/<runId>/，不进版本库。",
    device: manifest.device || {},
    app: manifest.app || {},
    records: (manifest.records || []).map((record) => ({
      seq: record.seq,
      capturedAt: record.capturedAt,
      label: record.label,
      state: record.state || null,
      note: record.note || null,
      imported: record.imported === true ? true : undefined,
      originalName: record.originalName || undefined,
      screenshot: record.screenshot || null,
    })),
  };
  const output = resolve(SETTINGS.exportIndex);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify({ ok: true, run: index.runId, records: index.records.length, output }),
  );
  return 0;
}

function safeLabel(label) {
  return String(label).trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "capture";
}

function parseRegion(region) {
  if (!region) return undefined;
  const parts = String(region).split(",").map((value) => Number(value.trim()));
  if (parts.length !== 4 || parts.some((value) => !Number.isFinite(value))) {
    throw new Error(`--region 需要四个数字 x1,y1,x2,y2，收到: ${region}`);
  }
  return parts;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main() {
  const screenshotFormat = resolveScreenshotFormat(SETTINGS);
  const client = new McpClient().start();
  try {
    await client.handshake();

    let status = {};
    if (SETTINGS.status) {
      const statusResult = await client.call("device_status", { deviceId: SETTINGS.device });
      status = extractStatus(parseJsonText(statusResult.texts));
    }

    const screenshotArgs = {
      deviceId: SETTINGS.device,
      waitStable: SETTINGS.waitStable,
      includePreview: true,
      previewFormat: screenshotFormat.format,
      previewQuality: screenshotFormat.quality,
    };
    const region = parseRegion(SETTINGS.region);
    if (region) screenshotArgs.position = region;

    const shot = await client.call("device_screenshot", screenshotArgs);
    if (shot.images.length === 0) {
      throw new Error(`截图未返回图片块。工具文本: ${shot.texts.join(" | ").slice(0, 500)}`);
    }
    const image = shot.images[0];
    const buffer = Buffer.from(image.data, "base64");
    const manifest = loadManifest();
    const seq = nextSequence(manifest.records);
    const padded = String(seq).padStart(3, "0");
    const label = safeLabel(SETTINGS.label);
    const shotName = `${padded}-${label}${screenshotFormat.extension}`;
    const shotPath = join(SHOT_DIR, shotName);
    writeFileSync(shotPath, buffer);

    const metaName = `${padded}-${label}.json`;
    writeFileSync(join(META_DIR, metaName), `${JSON.stringify(shot.texts, null, 2)}\n`, "utf8");
    const shotMeta = parseJsonText(shot.texts) || {};
    const app = extractPackage(shotMeta);
    const shotPayload = shotMeta?.data?.resultPayload || {};
    const resolution = {
      screenWidth: status.screenWidth || Number(shotPayload.width) || undefined,
      screenHeight: status.screenHeight || Number(shotPayload.height) || undefined,
      directControlMode: status.directControlMode,
    };

    const hash = hashFile(shotPath);
    const record = {
      seq,
      capturedAt: new Date().toISOString(),
      label,
      state: SETTINGS.state || null,
      note: SETTINGS.note || null,
      screenshot: {
        file: `screenshots/${shotName}`,
        bytes: hash.bytes,
        sha256: hash.sha256,
        format: screenshotFormat.format,
        quality: screenshotFormat.quality ?? null,
        region: region || null,
      },
      meta: { file: `meta/${metaName}` },
      device: {
        screenWidth: resolution.screenWidth,
        screenHeight: resolution.screenHeight,
        directControlMode: resolution.directControlMode,
      },
      app,
    };
    manifest.records.push(record);
    if (!manifest.device?.screenWidth) {
      manifest.device = { ...status, ...resolution, id: SETTINGS.device };
    }
    if (!manifest.app?.packageName && app.packageName) manifest.app = app;
    saveManifest(manifest);

    const sizeWarning = hash.bytes > SCREENSHOT_SIZE_WARN_BYTES
      ? `单张 ${(hash.bytes / 1024 / 1024).toFixed(2)}MB 偏大：可降 --quality、改用 --format jpg，或用 --region 只截关键区域`
      : undefined;
    console.log(
      JSON.stringify({
        ok: true,
        run: basenameOf(RUN_DIR),
        seq,
        screenshot: record.screenshot.file,
        bytes: hash.bytes,
        sha256: hash.sha256,
        format: screenshotFormat.format,
        quality: screenshotFormat.quality ?? null,
        warning: sizeWarning,
        manifest: "manifest.json",
      }),
    );
  } finally {
    client.stop();
    await sleep(50);
  }
}

main().catch((error) => {
  console.error(`采集失败: ${error.message}`);
  process.exit(1);
});
