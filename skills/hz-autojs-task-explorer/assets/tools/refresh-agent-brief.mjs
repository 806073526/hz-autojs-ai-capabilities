#!/usr/bin/env node
/**
 * refresh-agent-brief.mjs
 * 任务探索的"对话入口"刷新器：把探索运行目录汇总成 AI 能直接回答用户的两份产物。
 *
 * 用法:
 *   node refresh-agent-brief.mjs --run <探索运行目录>
 *
 * 产出（写在运行目录内）:
 *   AGENTS.md            运行目录的 AI 入口（在 Codex 里打开该目录对话时自动加载）
 *   agent/manifest.json  机器可读：目标、进度、已发现状态与动作、证据覆盖、交接物、下一步
 *
 * 说明:
 *   - 只读运行目录已有产物（task-spec / state-model / evidence-index / project-request），不联网、不访问设备。
 *   - 可反复执行：探索每推进一轮就刷新一次，清单永远对着当前产物，不写死事实。
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--run") args.run = argv[++i];
  }
  return args;
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.run) {
    console.error("缺少 --run <探索运行目录>");
    process.exit(2);
  }
  const runDir = path.resolve(args.run);
  const taskSpec = readJsonIfExists(path.join(runDir, "task-spec.json"));
  const stateModel = readJsonIfExists(path.join(runDir, "state-model.json"));
  const evidenceIndex = readJsonIfExists(path.join(runDir, "evidence-index.json"));
  const projectRequest = readJsonIfExists(path.join(runDir, "project-request.json"));

  if (!taskSpec && !stateModel) {
    console.error("运行目录里既没有 task-spec.json 也没有 state-model.json，无法生成说明书: " + runDir);
    process.exit(1);
  }

  const states = (stateModel && stateModel.states) || [];
  const records = (evidenceIndex && evidenceIndex.records) || [];
  // 证据标签先经 evidenceStateAliases 映射回标准状态，再统计覆盖；UNMAPPED 不参与
  const aliasMap = (stateModel && stateModel.evidenceStateAliases && stateModel.evidenceStateAliases.map) || {};
  const evidenceByState = new Map();
  for (const r of records) {
    const label = String((r && r.state) || "");
    const mapped = Array.isArray(aliasMap[label]) ? aliasMap[label] : (aliasMap[label] ? [aliasMap[label]] : [label]);
    for (const sid of mapped) {
      if (!sid || sid === "UNMAPPED") continue;
      evidenceByState.set(sid, (evidenceByState.get(sid) || 0) + 1);
    }
  }
  const verifiedStates = states.filter((s) => s.confidence === "verified").map((s) => s.id);
  const statesWithEvidence = states.filter((s) => (evidenceByState.get(s.id) || 0) > 0).map((s) => s.id);
  const statesWithoutEvidence = states.filter((s) => (evidenceByState.get(s.id) || 0) === 0).map((s) => s.id);
  const actionSet = new Set();
  for (const s of states) for (const a of (s.actions || [])) actionSet.add(String(a));
  const unlabeled = [];
  for (const [state, count] of evidenceByState) {
    if (!state || state === "UNKNOWN" || state === "LEGACY_SHOT") unlabeled.push({ state: state || "(空)", count });
  }
  const scripts = (projectRequest && projectRequest.requestedScripts) || [];
  const openGaps = (projectRequest && projectRequest.openGaps) || [];
  const FRAMEWORK_SCRIPT_NAMES = new Set(["bootstrap.js", "detect-state.js"]);
  const scriptBriefs = scripts.map((s) => {
    const item = (s && typeof s === "object") ? s : { name: String(s), duty: "" };
    const name = String(item.name || "");
    const readiness = String(item.readiness || "unspecified");
    const hasSpec = !!(item.spec && Array.isArray(item.spec.steps) && item.spec.steps.length);
    const framework = FRAMEWORK_SCRIPT_NAMES.has(name);
    const missingEvidence = Array.isArray(item.missingEvidence) ? item.missingEvidence.map(String) : [];
    return { name, duty: String(item.duty || ""), readiness, hasSpec, framework, missingEvidence, ready: framework || (readiness === "ready" && hasSpec) };
  });
  const target = (taskSpec && taskSpec.target) || {};
  const app = { name: target.appName || "", packageName: target.packageName || "", deviceId: target.deviceId || "", orientation: target.orientation || "", screen: target.screen || null, directControlMode: target.directControlMode || "", toolboxVersion: target.toolboxVersion || "" };
  const runId = (taskSpec && taskSpec.sourceRun ? String(taskSpec.sourceRun).replace(/\/+$/, "").split("/").pop() : "") || path.basename(runDir);
  const refreshedAt = new Date().toISOString();

  const nextSteps = [];
  for (const id of statesWithoutEvidence.slice(0, 6)) nextSteps.push("补证据：状态 " + id + " 还没有任何截图/OCR 记录");
  for (const g of openGaps.slice(0, 6)) nextSteps.push("待办：" + g);
  for (const s of scriptBriefs.filter((x) => !x.ready).slice(0, 6)) {
    nextSteps.push("补任务卡：" + s.name + "（readiness=" + s.readiness + "，缺 " + s.missingEvidence.length + " 项证据）");
  }
  if (!nextSteps.length) nextSteps.push("没有自动识别出的缺口；可继续扩展未进入的页面，或直接用 hz-autojs-automation-builder 生成项目");

  const manifest = {
    schemaVersion: 1,
    kind: "hz-autojs-exploration-brief",
    exploration: {
      runId: runId,
      runDir: runDir,
      taskId: (taskSpec && taskSpec.taskId) || (stateModel && stateModel.taskId) || "",
      createdAt: (taskSpec && taskSpec.createdAt) || "",
      refreshedAt: refreshedAt,
      goal: (taskSpec && taskSpec.goal) || "",
      app: app,
      sourceRun: (taskSpec && taskSpec.sourceRun) || ""
    },
    progress: {
      states: states.length,
      verifiedStates: verifiedStates.length,
      statesWithEvidence: statesWithEvidence.length,
      statesWithoutEvidence: statesWithoutEvidence,
      evidenceRecords: records.length,
      evidenceByState: Array.from(evidenceByState, ([state, count]) => ({ state: state, count: count })).sort((a, b) => b.count - a.count),
      unlabeledEvidence: unlabeled
    },
    discovered: {
      actions: Array.from(actionSet).sort(),
      states: states.map((s) => ({ id: s.id, confidence: s.confidence || "", anchors: s.anchors || [], textAnchorCount: (s.anchors || []).filter((a) => (typeof a === "string") || (a && String(a.kind || "text") === "text")).length, actions: s.actions || [], next: s.next || [], evidenceCount: evidenceByState.get(s.id) || 0, notes: s.notes || "" }))
    },
    handoff: {
      projectRequestPresent: !!projectRequest,
      requestedScripts: scriptBriefs,
      readyScripts: scriptBriefs.filter((s) => s.ready).map((s) => s.name),
      blockedScripts: scriptBriefs.filter((s) => !s.ready).map((s) => s.name),
      openGaps: openGaps,
      readyForGeneration: !!projectRequest && scriptBriefs.length > 0 && scriptBriefs.every((s) => s.ready)
    },
    conversation: {
      answerSections: ["这是什么", "已经探到什么、能做什么", "现在在哪、下一步建议", "你可以怎么说"],
      commandExamples: [
        "这个探索现在到什么程度了？",
        "现在能做什么？",
        "继续探索 <页面/状态>",
        "补一下 <状态> 的证据",
        "校验一下证据清单",
        "刷新一下说明书",
        "把这个探索生成项目"
      ],
      rules: [
        "只讲已标定状态与已验证锚点；假设必须标成假设",
        "不许无证据下结论；缺证据就说缺哪张、哪个状态",
        "禁止动作（见 task-spec.forbiddenActions）不得尝试",
        "回答完下一步后，等用户明确指令再动手"
      ]
    },
    successCriteria: (taskSpec && taskSpec.successCriteria) || [],
    forbiddenActions: (taskSpec && taskSpec.forbiddenActions) || [],
    evidenceRequired: (taskSpec && taskSpec.evidenceRequired) || [],
    nextSteps: nextSteps
  };

  const L = [];
  L.push("# " + runId + " —— 探索说明书（AI 入口）");
  L.push("");
  L.push("> 本文件与 `agent/manifest.json` 由 `refresh-agent-brief.mjs` 自动生成，请勿手改；探索推进后重新刷新。");
  L.push("> 机器可读的进度、状态清单、动作候选、证据覆盖与下一步都在 `agent/manifest.json`；回答用户前先读它。");
  L.push("");
  L.push("## 这是什么");
  L.push("");
  L.push("- 目标应用：`" + (app.packageName || "未记录") + "`" + (app.name ? "（" + app.name + "）" : "") + (app.deviceId ? "，设备 `" + app.deviceId + "`" : ""));
  if (app.screen) L.push("- 分辨率基线：" + app.screen.width + "×" + app.screen.height + (app.screen.aspectBucket ? "（" + app.screen.aspectBucket + "）" : ""));
  if (manifest.exploration.goal) L.push("- 探索目标：" + manifest.exploration.goal);
  L.push("- 性质：任务探索运行目录；产出契约交给 hz-autojs-automation-builder 生成固化项目");
  L.push("");
  L.push("## 用户问你时，按这四段回答");
  L.push("");
  L.push("1. **这是什么** —— 一句话：目标应用 + 这轮探索要解决什么。");
  L.push("2. **已经探到什么、能做什么** —— 报状态数 / 已验证锚点数 / 证据条数，并按状态列出可执行的动作候选。");
  L.push("3. **现在在哪、下一步建议** —— 用 `manifest.nextSteps`：缺证据的状态、openGaps，给 1~3 条最该做的。");
  L.push("4. **你可以怎么说** —— 给 2~4 条可直接复制的指令。");
  L.push("");
  L.push("不许无证据下结论：锚点、动作、状态转移都要能指到 `evidence-index.json` 里的记录；没有证据就明说缺哪张、缺哪个状态。");
  L.push("禁止动作（`task-spec.forbiddenActions`）：" + (manifest.forbiddenActions.join(" / ") || "未记录"));
  L.push("");
  L.push("## 进度");
  L.push("");
  L.push("- 状态 " + manifest.progress.states + " 个（已验证 " + manifest.progress.verifiedStates + " 个；有证据 " + manifest.progress.statesWithEvidence + " 个）");
  L.push("- 证据记录 " + manifest.progress.evidenceRecords + " 条" + (unlabeled.length ? "（其中未标定 " + unlabeled.reduce((n, x) => n + x.count, 0) + " 条）" : ""));
  if (manifest.handoff.projectRequestPresent) L.push("- 交接物：project-request.json 已就绪，任务卡 " + manifest.handoff.requestedScripts.length + " 个（就绪 " + manifest.handoff.readyScripts.length + " / 未就绪 " + manifest.handoff.blockedScripts.length + "），openGaps " + manifest.handoff.openGaps.length + " 条");
  if (manifest.handoff.projectRequestPresent && manifest.handoff.blockedScripts.length) L.push("- 未就绪任务（不得生成可执行任务）：" + manifest.handoff.blockedScripts.join(" / "));
  L.push("");
  L.push("## 已发现状态（自动汇总）");
  L.push("");
  L.push("| 状态 | 置信度 | 锚点 | 动作候选 | 证据 |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const s of manifest.discovered.states) {
    const anchorText = (s.anchors || []).map((a) => (typeof a === "string" ? a : (a && a.text) || "")).filter(Boolean).join(" / ");
    L.push("| `" + s.id + "` | " + (s.confidence || "—") + " | " + (anchorText || "—") + " | " + ((s.actions || []).join(" / ") || "—") + " | " + s.evidenceCount + " |");
  }
  L.push("");
  L.push("## 下一步建议（自动汇总）");
  L.push("");
  for (const n of nextSteps) L.push("- " + n);
  L.push("");
  L.push("## 怎么维护这份说明书");
  L.push("");
  L.push("- 刷新：`node assets/tools/refresh-agent-brief.mjs --run <运行目录>`（探索每推进一轮跑一次）");
  L.push("- 采证：`node assets/tools/capture-evidence.mjs ...`；校验：`capture-evidence.mjs --run <运行目录> --verify`");
  L.push("- 导出契约：`node assets/tools/export-evidence-index.mjs ...`");
  L.push("- 生成项目：`node ../hz-autojs-automation-builder/assets/tools/generate-project.mjs --run <运行目录> --out <本地项目根> --id <项目名>`");
  write(path.join(runDir, "agent", "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  write(path.join(runDir, "AGENTS.md"), L.join("\n") + "\n");
  console.log(JSON.stringify({
    ok: true,
    runDir: runDir,
    states: manifest.progress.states,
    evidenceRecords: manifest.progress.evidenceRecords,
    nextSteps: nextSteps.length,
    wrote: ["AGENTS.md", "agent/manifest.json"]
  }, null, 2));
}

main();