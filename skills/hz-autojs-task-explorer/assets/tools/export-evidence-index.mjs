#!/usr/bin/env node
/**
 * export-evidence-index.mjs
 * 从探索运行目录的 manifest.json 导出/合并精简证据索引（文本，可进版本库）。
 * 图片二进制仍留在本地运行目录，索引只保留状态、时间、sha256 与 OCR 锚点摘要。
 *
 * 用法:
 *   node export-evidence-index.mjs --run <运行目录> [--out <索引文件>] [--anchors 40] [--verify]
 *
 * 说明:
 *   - 默认导出到 <运行目录>/evidence-index.json；给 --out 时写入指定路径（例如插件仓库的 references/runs/<runId>/evidence-index.json）。
 *   - 已存在的 --out 文件会按 seq 合并：已有记录保留，新增记录追加，不会覆盖历史。
 *   - --verify 时重算每条记录截图的 sha256 与字节数，输出 {ok,bad,records}，不一致时以退出码 1 结束。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

function parseArgs(argv) {
  const args = { anchors: 40, verify: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--verify") args.verify = true;
    else if (a === "--run") args.run = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--anchors") args.anchors = Number(argv[++i] || 40);
  }
  return args;
}

function sha256(file) {
  const h = crypto.createHash("sha256");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.run) {
    console.error("missing --run <运行目录>");
    process.exit(2);
  }
  const runDir = path.resolve(args.run);
  const manifestPath = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error("manifest.json not found: " + manifestPath);
    process.exit(2);
  }
  const manifest = readJson(manifestPath);
  const outPath = path.resolve(args.out || path.join(runDir, "evidence-index.json"));

  if (args.verify) {
    let ok = 0;
    const bad = [];
    for (const r of manifest.records || []) {
      const file = path.join(runDir, r.screenshot.file);
      try {
        const bytes = fs.statSync(file).size;
        const hash = sha256(file);
        if (hash === r.screenshot.sha256 && bytes === r.screenshot.bytes) ok++;
        else bad.push({ seq: r.seq, file: r.screenshot.file, reason: "hash-or-size-mismatch" });
      } catch (e) {
        bad.push({ seq: r.seq, file: r.screenshot.file, reason: "missing" });
      }
    }
    console.log(JSON.stringify({ run: manifest.runId, ok, bad: bad.length, records: (manifest.records || []).length, details: bad.slice(0, 5) }));
    process.exit(bad.length ? 1 : 0);
  }

  const existing = fs.existsSync(outPath) ? readJson(outPath) : null;
  const bySeq = new Map();
  for (const r of (existing && existing.records) || []) bySeq.set(r.seq, r);

  const limit = Math.max(0, Number(args.anchors) || 0);
  let added = 0;
  for (const r of manifest.records || []) {
    if (bySeq.has(r.seq)) continue;
    const rec = {
      seq: r.seq,
      capturedAt: r.capturedAt,
      label: r.label,
      state: r.state,
      note: r.note || "",
      screenshot: {
        file: r.screenshot.file,
        bytes: r.screenshot.bytes,
        sha256: r.screenshot.sha256,
        region: r.screenshot.region || null,
      },
    };
    const anchors = r.ocr && Array.isArray(r.ocr.anchors) ? r.ocr.anchors : null;
    if (anchors && anchors.length) rec.ocrAnchors = anchors.slice(0, limit || anchors.length);
    bySeq.set(r.seq, rec);
    added++;
  }

  const records = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  const out = {
    schemaVersion: 1,
    runId: manifest.runId,
    exportedAt: new Date().toISOString(),
    note: (existing && existing.note) || "由 export-evidence-index.mjs 从 manifest.json 导出；仅文本索引，截图二进制留在本地运行目录",
    device: manifest.device,
    app: manifest.app,
    records,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, run: manifest.runId, out: outPath, added, total: records.length }));
}

main();
