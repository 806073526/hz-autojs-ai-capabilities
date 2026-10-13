#!/usr/bin/env node
/**
 * Import previously captured screenshots into an exploration evidence run.
 *
 * Files already present in the manifest (matched by sha256) are skipped, so
 * the command is safe to re-run. Originals stay untouched; the copy inside
 * the run directory is what the manifest references.
 *
 * Usage:
 *   node import-screenshots.mjs --run <dir> --source <dir> [options]
 *
 * Options:
 *   --state <STATE_ID>   default state label for imported records
 *   --note <text>        default note for imported records
 *   --pattern <glob>     file filter, default "*.png" (use "*.jpg" for jpeg evidence)
 */

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve } from "node:path";

const settings = parseArgs(process.argv.slice(2));
if (!settings.run || !settings.source) {
  console.error("用法: node import-screenshots.mjs --run <dir> --source <dir> [--state S] [--note T]");
  process.exit(2);
}

const RUN_DIR = resolve(settings.run);
const SOURCE_DIR = resolve(settings.source);
const SHOT_DIR = join(RUN_DIR, "screenshots");
const MANIFEST_PATH = join(RUN_DIR, "manifest.json");

if (!existsSync(SOURCE_DIR)) {
  console.error(`源目录不存在: ${SOURCE_DIR}`);
  process.exit(2);
}
mkdirSync(SHOT_DIR, { recursive: true });

const manifest = loadManifest();
const knownHashes = new Set(
  (manifest.records || []).map((record) => record.screenshot?.sha256).filter(Boolean),
);

const matcher = globToRegExp(settings.pattern || "*.png");
const files = readdirSync(SOURCE_DIR)
  .map((name) => ({ name, path: join(SOURCE_DIR, name) }))
  .filter((entry) => {
    try {
      return statSync(entry.path).isFile() && matcher.test(entry.name);
    } catch {
      return false;
    }
  })
  .sort((a, b) => a.name.localeCompare(b.name));

let seq = (manifest.records || []).reduce(
  (max, record) => Math.max(max, Number(record.seq) || 0),
  0,
);
let imported = 0;
let skipped = 0;

for (const entry of files) {
  const bytes = readFileSync(entry.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (knownHashes.has(sha256)) {
    skipped += 1;
    continue;
  }
  knownHashes.add(sha256);
  seq += 1;
  const padded = String(seq).padStart(3, "0");
  const label = safeLabel(entry.name.replace(/\.[^.]+$/, ""));
  const extension = extname(entry.name).toLowerCase() || ".png";
  const targetName = `${padded}-${label}${extension}`;
  const targetPath = join(SHOT_DIR, targetName);
  copyFileSync(entry.path, targetPath);
  const capturedAt = statSync(entry.path).mtime.toISOString();
  manifest.records.push({
    seq,
    capturedAt,
    label,
    state: settings.state || null,
    note: settings.note || null,
    imported: true,
    originalName: entry.name,
    screenshot: {
      file: `screenshots/${targetName}`,
      bytes: bytes.length,
      sha256,
      region: null,
    },
    meta: null,
    ocr: null,
    device: {
      screenWidth: manifest.device?.screenWidth,
      screenHeight: manifest.device?.screenHeight,
      directControlMode: manifest.device?.directControlMode,
    },
    app: {
      packageName: manifest.app?.packageName,
      activity: manifest.app?.activity,
    },
  });
  imported += 1;
}

manifest.updatedAt = new Date().toISOString();
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify({
    ok: true,
    run: RUN_DIR,
    source: SOURCE_DIR,
    imported,
    skipped,
    records: manifest.records.length,
  }),
);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case "--run":
        result.run = argv[++index];
        break;
      case "--source":
        result.source = argv[++index];
        break;
      case "--state":
        result.state = argv[++index];
        break;
      case "--note":
        result.note = argv[++index];
        break;
      case "--pattern":
        result.pattern = argv[++index];
        break;
      default:
        break;
    }
  }
  return result;
}

function loadManifest() {
  if (existsSync(MANIFEST_PATH)) {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  }
  return {
    schemaVersion: 1,
    runId: (RUN_DIR.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "run"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    device: {},
    app: {},
    records: [],
  };
}

function safeLabel(label) {
  return String(label).trim().replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "capture";
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
