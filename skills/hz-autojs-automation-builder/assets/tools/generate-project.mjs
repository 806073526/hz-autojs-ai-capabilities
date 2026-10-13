#!/usr/bin/env node
/**
 * generate-project.mjs
 * 自动化项目生成器：把探索产出的「任务卡」契约编译成独立 AutoJs 项目。
 *
 * 用法:
 *   node generate-project.mjs --run <探索运行目录> --check
 *   node generate-project.mjs --run <探索运行目录> --out <本地项目根> [--id <项目名>] [--force]
 *   node generate-project.mjs --run <探索运行目录> --out <本地项目根> [--id <项目名>] [--force] \
 *     --detect-model <设备端 /sdcard/appSync/yolo/xxx.onnx> --detect-classes <类1,类2> [--detect-min-score 0.5] [--detect-class-min nav=0.6]
 *   --out 省略时默认 <当前工作目录>/hz-autojs-projects（项目落在其 projects/<项目名>/ 下）
 *
 * 说明:
 *   - 只读契约，不联网、不访问设备。
 *   - bootstrap.js / detect-state.js 是内建框架任务，始终只读。
 *   - 目标检测是可选能力：--detect-model 启用（生成 core/detect.js + config/detection.json +
 *     只读框架任务 detect-targets.js）；--no-detect 显式关闭；两者都不带则默认不生成检测代码。
 *   - 其余脚本只有 readiness=ready 且带 spec 任务卡时才编译为可执行任务；
 *     readiness=partial/blocked 或缺 spec 的脚本生成 not-ready 占位模块，缺口写入 README 与 manifest。
 *   - --check 只校验并打印报告，不写文件；执行保真度问题按 error，未接线但未执行的能力按 warning。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SCHEMA_VERSION = 1;
const FRAMEWORK_TASKS = {
  "bootstrap.js": { readOnly: true, markers: ["BOOTSTRAP_OK"] },
  "detect-state.js": { readOnly: true, markers: ["STATE_DETECTED"] },
  "detect-targets.js": { readOnly: true, markers: ["TARGETS_DETECTED"] }
};
const FRAMEWORK_MARKERS = new Set(Object.values(FRAMEWORK_TASKS).flatMap((t) => t.markers));
const READINESS = new Set(["ready", "partial", "blocked"]);
const STEP_OPS = new Set(["tap", "longPress", "swipe", "wait", "read"]);
const CHECK_TYPES = new Set(["anchor", "number", "changed", "unchanged"]);
const NUMBER_OPS = new Set([">=", ">", "<=", "<", "==", "!="]);
const READ_WHEN = new Set(["before", "after", "both"]);
const CONFIDENCE = new Set(["verified", "partial", "assumption"]);
const TASK_NAME_RE = /^[A-Za-z0-9._-]+\.js$/;

function parseArgs(argv) {
  const args = { check: false, force: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") args.check = true;
    else if (a === "--force") args.force = true;
    else if (a === "--run") args.run = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--id") args.id = argv[++i];
    else if (a === "--detect-model") args.detectModel = argv[++i];
    else if (a === "--detect-classes") args.detectClasses = argv[++i];
    else if (a === "--detect-min-score") args.detectMinScore = argv[++i];
    else if (a === "--detect-class-min") args.detectClassMin = argv[++i];
    else if (a === "--no-detect") args.noDetect = true;
  }
  return args;
}
function buildDetection(args) {
  const errors = [];
  const wantsDetect = !!args.detectModel;
  if (args.noDetect && wantsDetect) errors.push("--no-detect 与 --detect-model 不能同时使用");
  if (!wantsDetect && (args.detectClasses || args.detectMinScore !== undefined || args.detectClassMin)) {
    errors.push("--detect-classes / --detect-min-score / --detect-class-min 必须与 --detect-model 一起使用");
  }
  const classes = String(args.detectClasses || "").split(",").map((s) => s.trim()).filter(Boolean);
  let minScore = 0.5;
  if (args.detectMinScore !== undefined) {
    minScore = Number(args.detectMinScore);
    if (!(minScore >= 0 && minScore <= 1)) errors.push("--detect-min-score 必须是 0~1 的数字: " + args.detectMinScore);
  }
  const classMinScore = {};
  if (args.detectClassMin) {
    for (const pair of String(args.detectClassMin).split(",").map((s) => s.trim()).filter(Boolean)) {
      const m = pair.match(/^([A-Za-z0-9_.-]+)=([0-9]*\.?[0-9]+)$/);
      if (!m) { errors.push("--detect-class-min 条目格式应为 <类名>=<0~1 的阈值>: " + pair); continue; }
      const v = Number(m[2]);
      if (!(v >= 0 && v <= 1)) { errors.push("--detect-class-min 阈值越界: " + pair); continue; }
      if (Object.prototype.hasOwnProperty.call(classMinScore, m[1])) { errors.push("--detect-class-min 类名重复: " + m[1]); continue; }
      classMinScore[m[1]] = v;
    }
  }
  if (wantsDetect) {
    const model = String(args.detectModel);
    if (!model.startsWith("/")) errors.push("--detect-model 必须是设备端绝对路径（以 / 开头）: " + model);
    if (!/\.onnx$/i.test(model)) errors.push("--detect-model 必须是 .onnx 文件（yolodet 按 ONNX 消费）: " + model);
    if (!classes.length) errors.push("启用目标检测必须提供 --detect-classes <类1,类2>（与模型同目录 classes.json 一致）");
    const seen = new Set();
    for (const c of classes) {
      if (!/^[A-Za-z0-9_.-]+$/.test(c)) errors.push("类名不合法（只允许字母数字._-）: " + c);
      if (seen.has(c)) errors.push("类名重复: " + c);
      seen.add(c);
    }
    for (const k of Object.keys(classMinScore)) {
      if (!seen.has(k)) errors.push("--detect-class-min 的类名不在 --detect-classes 中: " + k);
    }
  }
  const config = {
    schemaVersion: 1,
    enabled: wantsDetect && errors.length === 0,
    plugin: "com.zjh336.cn.tools.plugin.yolodet",
    model: wantsDetect ? String(args.detectModel) : null,
    classes: wantsDetect ? classes : [],
    minScore: minScore,
    classMinScore: classMinScore,
    source: {
      trainer: "hz-autojs-detect-trainer",
      envCheck: "hz-autojs-detect-trainer/scripts/check-env.py",
      deviceVerify: "hz-autojs-detect-trainer/assets/verify-on-device.js"
    }
  };
  return { errors, config };
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}
function die(report) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors && report.errors.length ? 1 : 0);
}
function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function anchorOf(a) {
  if (typeof a === "string") return { text: a, kind: "text", weight: 1, required: false, exclusive: false };
  if (isObject(a)) return {
    text: String(a.text || ""),
    kind: String(a.kind || "text"),
    weight: typeof a.weight === "number" ? a.weight : 1,
    required: a.required === true,
    exclusive: a.exclusive === true
  };
  return { text: "", kind: "text", weight: 1, required: false, exclusive: false };
}
function elementText(el) {
  const anchor = el.anchor && el.anchor.text ? String(el.anchor.text) : "";
  return [el.id, el.desc, anchor].map((s) => String(s || "")).join(" ");
}

function validate(ctx) {
  const errors = [];
  const warnings = [];
  const stats = {
    states: 0, elements: 0, scripts: 0, ready: 0, partial: 0, blocked: 0,
    compiled: 0, placeholders: 0, uncoveredMarkers: [], uncoveredGuards: [],
    noTextAnchorStates: [], reachabilityUnverified: []
  };
  if (!ctx.request) errors.push("project-request.json 缺失或不可解析");
  if (!ctx.stateModel) errors.push("state-model.json 缺失或不可解析");
  if (!ctx.spec) errors.push("坐标契约缺失或不可解析（project-request.coordinateSpec.file）");
  if (errors.length) return { errors, warnings, stats, tasks: [] };

  if (ctx.request.schemaVersion !== SCHEMA_VERSION) errors.push("project-request.schemaVersion 不是 " + SCHEMA_VERSION + "（未知版本拒绝生成）");
  if (ctx.stateModel.schemaVersion !== SCHEMA_VERSION) errors.push("state-model.schemaVersion 不是 " + SCHEMA_VERSION + "（未知版本拒绝生成）");

  const states = ctx.stateModel.states || [];
  const ids = new Set();
  for (const s of states) {
    if (!s.id) { errors.push("状态缺少 id"); continue; }
    if (ids.has(s.id)) { errors.push("状态 id 重复: " + s.id); continue; }
    ids.add(s.id);
    if (!Array.isArray(s.anchors) || !s.anchors.length) errors.push("状态缺锚点: " + s.id);
    if (s.confidence && !CONFIDENCE.has(s.confidence)) errors.push("状态 confidence 非法: " + s.id + " -> " + s.confidence);
    const textAnchors = (s.anchors || []).map(anchorOf).filter((a) => a.kind === "text" && a.text);
    if ((s.confidence || "partial") === "verified" && !textAnchors.length) {
      warnings.push("verified 状态没有 OCR 可用文本锚点，运行时永远无法识别: " + s.id);
      stats.noTextAnchorStates.push(s.id);
    }
  }
  for (const s of states) {
    for (const n of s.next || []) {
      if (n !== "UNMAPPED" && !ids.has(n)) errors.push("状态转移目标不存在: " + s.id + " -> " + n);
    }
  }
  stats.states = states.length;

  const spec = ctx.spec;
  const elements = spec.elements || [];
  const elementIds = new Set();
  const elementById = new Map();
  for (const el of elements) {
    if (!el.id) { errors.push("坐标元素缺少 id"); continue; }
    if (elementIds.has(el.id)) { errors.push("坐标元素 id 重复: " + el.id); continue; }
    elementIds.add(el.id);
    elementById.set(el.id, el);
    const mode = el.mode || el.xMode || el.yMode;
    if (!mode) errors.push("坐标元素缺少 mode: " + el.id);
    if (!el.fallback && !el.noFallbackReason && (el.mode === "anchor" || el.anchor)) {
      warnings.push("锚点元素缺少 fallback 且未声明 noFallbackReason（OCR 失败将直接停机）: " + el.id);
    }
  }
  stats.elements = elements.length;
  if (spec.baseline && ctx.request.target && ctx.request.target.baseline) {
    const a = spec.baseline;
    const b = ctx.request.target.baseline;
    if (a.width !== b.width || a.height !== b.height) errors.push("坐标契约 baseline 与 project-request.target.baseline 不一致");
  } else {
    errors.push("坐标契约或 project-request 缺少 baseline");
  }
  const guards = spec.guards || {};
  if (!Array.isArray(guards.forbiddenTexts)) errors.push("坐标契约缺少 guards.forbiddenTexts");
  if (!Array.isArray(guards.guardedActions)) errors.push("坐标契约缺少 guards.guardedActions");

  const scripts = ctx.request.requestedScripts || [];
  const names = new Set();
  const tasks = [];
  for (const raw of scripts) {
    if (typeof raw === "string") {
      errors.push("requestedScripts 条目必须是对象（name + duty + readiness），当前是字符串: " + raw);
      continue;
    }
    if (!isObject(raw)) { errors.push("requestedScripts 条目不是对象"); continue; }
    const name = String(raw.name || "");
    if (!name) { errors.push("requestedScripts 缺少 name"); continue; }
    if (!TASK_NAME_RE.test(name)) { errors.push("任务名不合法（只允许字母数字._- 且以 .js 结尾）: " + name); continue; }
    if (names.has(name)) { errors.push("脚本名重复: " + name); continue; }
    names.add(name);
    const framework = Object.prototype.hasOwnProperty.call(FRAMEWORK_TASKS, name);
    const readiness = String(raw.readiness || "");
    if (!READINESS.has(readiness)) errors.push("任务缺少合法 readiness（ready/partial/blocked）: " + name);
    const specCard = isObject(raw.spec) ? raw.spec : null;
    const missingEvidence = Array.isArray(raw.missingEvidence) ? raw.missingEvidence.map(String) : [];
    let status = "not-implemented";
    if (framework) {
      status = "generated";
      if (readiness !== "ready") errors.push("框架任务 readiness 必须是 ready: " + name);
    } else if (readiness === "ready") {
      if (!specCard) errors.push("readiness=ready 但没有 spec 任务卡: " + name);
      status = specCard ? "needs-verification" : "not-implemented";
    } else if (readiness === "partial") {
      status = "partial-implementation";
      if (!missingEvidence.length) warnings.push("partial 任务未列出 missingEvidence: " + name);
    } else if (readiness === "blocked") {
      status = "not-implemented";
      if (!missingEvidence.length) warnings.push("blocked 任务未列出 missingEvidence: " + name);
    }
    const task = {
      name, duty: String(raw.duty || ""), readiness, spec: specCard,
      missingEvidence, framework, status, readOnly: framework,
      markers: framework ? FRAMEWORK_TASKS[name].markers.slice() : (specCard && Array.isArray(specCard.markers) ? specCard.markers.map(String) : [])
    };
    if (specCard) validateSpec(task, errors, warnings, stats, ids, elementById);
    tasks.push(task);
  }
  if (ctx.detection && ctx.detection.enabled && !names.has("detect-targets.js")) {
    names.add("detect-targets.js");
    tasks.push({
      name: "detect-targets.js",
      duty: "只读目标检测冒烟（框架任务）",
      readiness: "ready", spec: null, missingEvidence: [],
      framework: true, status: "generated", readOnly: true,
      markers: FRAMEWORK_TASKS["detect-targets.js"].markers.slice()
    });
  }
  stats.scripts = tasks.length;
  stats.ready = tasks.filter((t) => t.readiness === "ready").length;
  stats.partial = tasks.filter((t) => t.readiness === "partial").length;
  stats.blocked = tasks.filter((t) => t.readiness === "blocked").length;
  stats.compiled = tasks.filter((t) => t.framework || (t.readiness === "ready" && t.spec)).length;
  stats.placeholders = tasks.length - stats.compiled;

  const successMarkers = new Set((ctx.request.verification && ctx.request.verification.successMarkers) || []);
  if (!successMarkers.size) errors.push("request.verification.successMarkers 为空");
  const covered = new Set();
  for (const t of tasks) {
    for (const m of t.markers) {
      if (!successMarkers.has(m) && !FRAMEWORK_MARKERS.has(m)) {
        errors.push("任务 " + t.name + " 发出的 marker 不在 verification.successMarkers 中: " + m);
      }
      if (t.readiness === "ready") covered.add(m);
    }
  }
  for (const m of successMarkers) {
    if (!covered.has(m)) {
      warnings.push("successMarker 没有就绪任务实现: " + m);
      stats.uncoveredMarkers.push(m);
    }
  }

  for (const g of guards.guardedActions || []) {
    const text = String(g.text || "");
    const readingKey = g.readingKey ? String(g.readingKey) : "";
    const consumers = tasks.filter((t) => t.readiness === "ready" && t.spec && (t.spec.steps || []).some((s) => {
      if (s.guard === false) return false;
      if (s.guardAction && String(s.guardAction) === text) return true;
      const el = s.element && elementById.get(s.element);
      return !!el && elementText(el).indexOf(text) >= 0;
    }));
    if (!consumers.length) {
      warnings.push("守卫「" + text + "」没有就绪任务消费（未接线，相关能力未实现）");
      stats.uncoveredGuards.push(text);
      continue;
    }
    if (!readingKey) continue;
    for (const t of consumers) {
      const produced = (t.spec.readings || []).some((r) => r.key === readingKey);
      const armed = (t.spec.steps || []).some((s) => {
        if (s.guard === false || s.readFirst !== true) return false;
        if (s.guardAction && String(s.guardAction) === text) return true;
        const el = s.element && elementById.get(s.element);
        return !!el && elementText(el).indexOf(text) >= 0;
      });
      if (!produced) errors.push("任务 " + t.name + " 消费守卫「" + text + "」但没有产出读数 " + readingKey);
      if (!armed) errors.push("任务 " + t.name + " 的守卫步骤「" + text + "」缺少 readFirst: true，无法在动作前读取 " + readingKey);
    }
  }
  stats.guardedActions = (guards.guardedActions || []).length;

  if (ctx.evidenceIndex && ctx.evidenceIndex.records) {
    const seen = new Set(ctx.evidenceIndex.records.map((r) => r.state));
    stats.evidenceLabels = seen.size;
    const alias = (ctx.stateModel.evidenceStateAliases && ctx.stateModel.evidenceStateAliases.map) || null;
    if (!alias) warnings.push("证据索引存在但 state-model 没有 evidenceStateAliases，证据无法挂回状态");
    else {
      const missing = [...seen].filter((s) => !(s in alias));
      if (missing.length) errors.push("证据标签没有映射: " + missing.slice(0, 8).join(", "));
    }
  }
  return { errors, warnings, stats, tasks };
}
function validateSpec(task, errors, warnings, stats, ids, elementById) {
  const spec = task.spec;
  const who = task.name;
  const startStates = Array.isArray(spec.startStates) ? spec.startStates.map(String) : [];
  if (!startStates.length) errors.push(who + ": spec.startStates 为空");
  for (const s of startStates) if (!ids.has(s)) errors.push(who + ": spec.startStates 引用了不存在的状态 " + s);

  const steps = spec.steps;
  if (!Array.isArray(steps) || !steps.length) errors.push(who + ": spec.steps 为空");
  const visitsStates = (Array.isArray(spec.visitsStates) && spec.visitsStates.length) ? spec.visitsStates.map(String) : startStates;
  for (const s of visitsStates) if (!ids.has(s)) errors.push(who + ": spec.visitsStates 引用了不存在的状态 " + s);
  const usedElements = new Set();
  const preSteps = Array.isArray(spec.preSteps) ? spec.preSteps : [];
  for (const group of [{ label: "preSteps", list: preSteps }, { label: "steps", list: (Array.isArray(steps) ? steps : []) }]) {
    for (let i = 0; i < group.list.length; i++) {
      const st = group.list[i] || {};
      const where = who + ": " + group.label + "[" + i + "]";
      const op = String(st.op || "");
      if (!STEP_OPS.has(op)) { errors.push(where + " op 非法: " + op); continue; }
      if (op === "tap" || op === "longPress") {
        if (!st.element) errors.push(where + " 缺少 element");
        else if (!elementById.has(st.element)) errors.push(where + " 引用了不存在的坐标元素 " + st.element);
        else usedElements.add(st.element);
      }
      if (op === "swipe") {
        for (const k of ["element", "toElement"]) {
          if (!st[k]) errors.push(where + " 缺少 " + k);
          else if (!elementById.has(st[k])) errors.push(where + " 引用了不存在的坐标元素 " + st[k]);
          else usedElements.add(st[k]);
        }
      }
      if (st.guardAction && !["tap", "longPress"].includes(op)) errors.push(where + " guardAction 只能用在 tap/longPress");
    }
  }
  if (spec.verifyOnStep !== undefined) {
    const stepTotal = preSteps.length + (Array.isArray(steps) ? steps.length : 0);
    if (!Number.isInteger(spec.verifyOnStep) || spec.verifyOnStep < 1 || spec.verifyOnStep > stepTotal) {
      errors.push(who + ": verifyOnStep 必须是 1.." + stepTotal + " 的整数（按 preSteps → steps 顺序计）");
    }
  }
  for (const id of usedElements) {
    const el = elementById.get(id);
    if (Array.isArray(el.visibleInStates) && el.visibleInStates.length) {
      const overlap = el.visibleInStates.some((s) => visitsStates.indexOf(s) >= 0);
      if (!overlap) errors.push(who + ": 元素 " + id + " 的 visibleInStates 与 visitsStates/startStates 无交集");
    } else {
      const key = who + ":" + id;
      if (!stats.reachabilityUnverified.includes(key)) stats.reachabilityUnverified.push(key);
      warnings.push(who + ": 元素 " + id + " 未声明 visibleInStates，起点可达性未校验");
    }
  }

  const readings = Array.isArray(spec.readings) ? spec.readings : [];
  const readingKeys = new Set();
  for (let i = 0; i < readings.length; i++) {
    const r = readings[i] || {};
    if (!r.key) errors.push(who + ": readings[" + i + "] 缺少 key");
    else if (readingKeys.has(r.key)) errors.push(who + ": readings key 重复: " + r.key);
    else readingKeys.add(r.key);
    if (!r.pattern) errors.push(who + ": readings[" + i + "] 缺少 pattern");
    else { try { new RegExp(r.pattern); } catch (e) { errors.push(who + ": readings[" + i + "] pattern 不是合法正则: " + String(e)); } }
    const when = String(r.when || "before");
    if (!READ_WHEN.has(when)) errors.push(who + ": readings[" + i + "] when 非法: " + when);
  }

  const verify = spec.verify;
  if (!Array.isArray(verify) || !verify.length) errors.push(who + ": spec.verify 为空（就绪任务必须带判据）");
  for (let i = 0; Array.isArray(verify) && i < verify.length; i++) {
    const v = verify[i] || {};
    const type = String(v.type || "");
    if (!CHECK_TYPES.has(type)) { errors.push(who + ": verify[" + i + "] type 非法: " + type); continue; }
    if (type === "anchor") {
      if (!v.text) errors.push(who + ": verify[" + i + "] 缺少 text");
    } else {
      if (!v.key) errors.push(who + ": verify[" + i + "] 缺少 key");
      else if (!readingKeys.has(v.key)) errors.push(who + ": verify[" + i + "] 引用了未声明的读数 " + v.key);
      if (type === "number") {
        if (!NUMBER_OPS.has(String(v.op || ""))) errors.push(who + ": verify[" + i + "] op 非法: " + v.op);
        if (typeof v.value !== "number") errors.push(who + ": verify[" + i + "] value 必须是数字");
      }
      if (type === "changed" && v.direction && !["increase", "decrease"].includes(v.direction)) errors.push(who + ": verify[" + i + "] direction 非法: " + v.direction);
    }
  }
  const verifyList = Array.isArray(verify) ? verify : [];
  for (const key of readingKeys) {
    const r = readings.find((x) => x.key === key) || {};
    const when = String(r.when || "before");
    const usedAfter = verifyList.some((v) => ["changed", "unchanged", "number"].includes(v.type) && v.key === key);
    if (usedAfter && when === "before") errors.push(who + ": 读数 " + key + " 被 verify 用于动作后判据，但 when=before（应设 after/both）");
    if (!usedAfter && when === "after") warnings.push(who + ": 读数 " + key + " 只有 after 值，没有 before 对照");
  }

  if (!Array.isArray(spec.markers) || !spec.markers.length) errors.push(who + ": spec.markers 为空");
  if (spec.loop) {
    if (!Number.isInteger(spec.loop.maxIterations) || spec.loop.maxIterations < 1) errors.push(who + ": loop.maxIterations 必须是 >=1 的整数");
    if (spec.loop.stopWhenAnchor !== undefined && typeof spec.loop.stopWhenAnchor !== "string") errors.push(who + ": loop.stopWhenAnchor 必须是字符串");
    if (spec.loop.verifyOnStop !== undefined && typeof spec.loop.verifyOnStop !== "boolean") errors.push(who + ": loop.verifyOnStop 必须是布尔值");
    if (spec.loop.verifyOnStop === true && !spec.loop.stopWhenAnchor) errors.push(who + ": loop.verifyOnStop 需要同时声明 stopWhenAnchor（否则没有可复核的停止帧）");
    if (spec.loop.stopWhenState !== undefined) {
      const list = Array.isArray(spec.loop.stopWhenState) ? spec.loop.stopWhenState : null;
      if (!list || !list.length) errors.push(who + ": loop.stopWhenState 必须是非空状态数组");
      else for (const s of list) if (!ids.has(String(s))) errors.push(who + ": loop.stopWhenState 引用了不存在的状态 " + s);
    }
  }
}

function renderCoreBootstrap() {
  return `/** core/bootstrap.js —— 环境自检：契约、分辨率分组、缩放一致性、截图/OCR 与锚点覆盖（生成物，勿手改） */
var B = (function () {
  function bucketOf(w, h) {
    if (w > h) return 'landscape';
    var r = w / h;
    if (Math.abs(r - 16 / 9) <= 0.06) return '16:9';
    if (Math.abs(r - 18 / 9) <= 0.06) return '18:9';
    if (r >= 2.1) return '19.5:9+';
    return 'other';
  }
  function run(ctx) {
    var report = { ok: false, stage: 'init', checks: [] };
    var spec = ctx.spec || {};
    var baseline = spec.baseline || {};
    var w = device.width;
    var h = device.height;
    var bucket = bucketOf(w, h);
    report.device = { width: w, height: h, bucket: bucket };
    report.baseline = baseline;
    if (!baseline.width || !baseline.height) { report.reason = 'CONTRACT_BASELINE_MISSING'; return report; }
    if (!(ctx.statesConfig && ctx.statesConfig.states && ctx.statesConfig.states.length)) { report.reason = 'CONTRACT_STATES_MISSING'; return report; }
    if (!(spec.guards && spec.guards.forbiddenTexts && spec.guards.guardedActions)) { report.reason = 'CONTRACT_GUARDS_MISSING'; return report; }
    var rx = w / baseline.width;
    var ry = h / baseline.height;
    report.scale = { x: rx, y: ry };
    var scaleDelta = Math.abs(rx - ry) / (ry || 1);
    report.checks.push({ name: 'scale-consistency', ok: scaleDelta <= 0.02, value: scaleDelta });
    var verifiedBuckets = (spec.verification && spec.verification.verifiedBuckets) || [];
    var exact = (w === baseline.width && h === baseline.height);
    var bucketVerified = exact || verifiedBuckets.some(function (b) { return String(b).indexOf(bucket) >= 0; });
    report.checks.push({ name: 'resolution-bucket', ok: bucketVerified, bucket: bucket, verifiedBuckets: verifiedBuckets });
    var shot = ctx.observe.capture(ctx);
    report.checks.push({ name: 'capture', ok: shot.ok === true, detail: shot.message || shot.path });
    if (shot.ok !== true) { report.reason = 'CAPTURE_FAILED'; return report; }
    var ocr = ctx.observe.ocr(ctx);
    var text = (ocr && ocr.text) || '';
    report.checks.push({ name: 'ocr-healthy', ok: text.length > 0, engine: (ocr && ocr.engine) || '', sample: text.slice(0, 40) });
    if (!text) { report.reason = 'OCR_EMPTY'; return report; }
    var anchors = ctx.states.anchorTexts(ctx);
    var hits = [];
    for (var i = 0; i < anchors.length; i++) { if (text.indexOf(anchors[i]) >= 0) hits.push(anchors[i]); }
    report.anchorCoverage = { total: anchors.length, hits: hits.length, matched: hits.slice(0, 6) };
    report.checks.push({ name: 'anchor-coverage', ok: hits.length > 0, value: hits.length });
    report.ok = report.checks.every(function (c) { return c.ok === true; });
    report.reason = report.ok ? 'OK' : 'CHECK_FAILED';
    return report;
  }
  return { run: run };
})();
module.exports = B;
`;
}

function renderCoreCoordinates() {
  return `/** core/coordinates.js —— 坐标契约解析（anchor / edge / ratio），不落裸像素（生成物，勿手改） */
var C = (function () {
  function axisMode(el, axis) {
    var m = axis === 'x' ? el.xMode : el.yMode;
    return m || el.mode || 'ratio';
  }
  function edgeOf(el) { return String(el.edge || 'center'); }
  function resolveAxis(el, axis, ctx) {
    var mode = axisMode(el, axis);
    var r = ctx.render;
    if (mode === 'ratio') {
      if (axis === 'x') return r.left + Number(el.rx || 0) * r.width;
      return r.top + Number(el.ry || 0) * r.height;
    }
    var edge = edgeOf(el);
    var d = axis === 'x' ? Number(el.dx || 0) : Number(el.dy || 0);
    if (axis === 'x') {
      if (edge.indexOf('right') >= 0) return r.left + r.width - d;
      if (edge.indexOf('left') >= 0) return r.left + d;
      return r.left + r.width / 2 + d;
    }
    if (edge.indexOf('bottom') >= 0) return r.top + r.height - d;
    if (edge.indexOf('top') >= 0) return r.top + d;
    return r.top + r.height / 2 + d;
  }
  function resolveAnchor(el, ctx) {
    var anchor = el.anchor || {};
    var text = String(anchor.text || '');
    if (!text) return null;
    var hit = ctx.observe.findText(ctx, text);
    if (!hit) return null;
    var off = el.offset || {};
    return { x: hit.x + Number(off.dx || 0), y: hit.y + Number(off.dy || 0), source: 'anchor:' + text };
  }
  function resolveElement(el, ctx) {
    var mode = el.mode || el.xMode || el.yMode;
    if (mode === 'anchor' || el.anchor) {
      var hit = resolveAnchor(el, ctx);
      if (hit) return hit;
    }
    if (mode === 'anchor') return null;
    return { x: resolveAxis(el, 'x', ctx), y: resolveAxis(el, 'y', ctx), source: 'geometry:' + mode };
  }
  function byId(ctx, id) {
    var list = (ctx.spec && ctx.spec.elements) || [];
    for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
    throw new Error('坐标契约缺少元素: ' + id);
  }
  function resolve(ctx, id) {
    var el = byId(ctx, id);
    var hit = resolveElement(el, ctx);
    if (!hit && el.fallback) hit = resolveElement(el.fallback, ctx);
    if (!hit) throw new Error('坐标解析失败: ' + id + (el.noFallbackReason ? '（' + el.noFallbackReason + '）' : ''));
    hit.id = id;
    return hit;
  }
  return { resolve: resolve, byId: byId };
})();
module.exports = C;
`;
}

function renderCoreObserve() {
  return `/** core/observe.js —— 设备侧截图 + OCR（shell screencap 主链路，toolManager 兜底；不抢占截图通道）（生成物，勿手改） */
var O = (function () {
  function toolManager() {
    if (typeof __toolboxScriptRequire !== 'function') throw new Error('NO_TOOLBOX_REQUIRE');
    var tm = __toolboxScriptRequire('toolManager.js');
    if (!tm || typeof tm.captureScreenshot !== 'function' || typeof tm.recognizeText !== 'function') throw new Error('TOOL_MANAGER_UNAVAILABLE');
    return tm;
  }
  // 截图主链路：优先 shell screencap（实测 0.7s/次且不阻塞子引擎）；
  // toolManager.captureScreenshot 作为兜底（该通道在部分设备/工具箱版本上会让
  // 子引擎无法上报终态，故不再作为默认路径，见项目 runs/evidence 记录）。
  function captureByShell(ctx, out) {
    if (typeof shell !== 'function') return { ok: false, message: 'NO_SHELL' };
    var r = shell('screencap -p ' + out, true);
    if (!r || r.code !== 0) return { ok: false, message: 'SHELL_SCREENCAP_CODE:' + (r ? r.code : 'null') };
    var f = new java.io.File(out);
    if (!f.exists() || f.length() <= 0) return { ok: false, message: 'SHELL_SCREENCAP_EMPTY' };
    return { ok: true, path: out, width: device.width, height: device.height, at: new Date().getTime(), via: 'shell' };
  }
  function capture(ctx) {
    var out = ctx.workDir + '/shots/shot-' + ctx.stamp() + '.png';
    try {
      files.createWithDirs(out);
      var shellShot = captureByShell(ctx, out);
      if (shellShot.ok === true) { ctx.lastOcr = null; ctx.lastShot = shellShot; return ctx.lastShot; }
      var tm = toolManager();
      var res = tm.captureScreenshot({ outputPath: out, includePreview: false });
      ctx.lastOcr = null; // 新截图后旧 OCR 立即失效，禁止用上一屏文本判状态
      if (!res || res.success !== true) return { ok: false, message: String(shellShot.message) + '|' + String((res && res.message) || 'capture failed') };
      var p = res.payload || {};
      ctx.lastShot = { ok: true, path: String(p.path || out), width: p.width || 0, height: p.height || 0, at: new Date().getTime(), via: 'toolManager' };
      return ctx.lastShot;
    } catch (e) { return { ok: false, message: String(e) }; }
  }
  function ocr(ctx, region) {
    try {
      var shot = ctx.lastShot;
      if (!shot || shot.ok !== true) shot = capture(ctx);
      if (!shot || shot.ok !== true) return { ok: false, text: '', items: [], message: 'NO_CAPTURE' };
      var tm = toolManager();
      var params = { sourcePath: shot.path };
      if (region) { params.x1 = region.x1; params.y1 = region.y1; params.x2 = region.x2; params.y2 = region.y2; }
      var res = tm.recognizeText(params);
      if (!res || res.success !== true) return { ok: false, text: '', items: [], message: String((res && res.message) || 'ocr failed') };
      var p = res.payload || {};
      ctx.lastOcr = { ok: true, engine: String(p.engine || ''), text: String(p.text || ''), items: p.items || [] };
      return ctx.lastOcr;
    } catch (e) { return { ok: false, text: '', items: [], message: String(e) }; }
  }
  function findText(ctx, text) {
    var current = ctx.lastOcr;
    if (!current || current.ok !== true) current = ocr(ctx);
    var items = (current && current.items) || [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      if (String(it.text || '').indexOf(text) >= 0 && it.bounds) {
        var b = it.bounds;
        return { x: (Number(b.left) + Number(b.right)) / 2, y: (Number(b.top) + Number(b.bottom)) / 2, text: String(it.text || ''), bounds: b };
      }
    }
    return null;
  }
  function readNumber(ctx, pattern) {
    var current = ctx.lastOcr;
    if (!current || current.ok !== true) current = ocr(ctx);
    var text = (current && current.text) || '';
    var re = new RegExp(pattern);
    var m = re.exec(text);
    return m ? Number(m[1]) : null;
  }
  return { capture: capture, ocr: ocr, findText: findText, readNumber: readNumber };
})();
module.exports = O;
`;
}

function renderCoreGuards() {
  return `/** core/guards.js —— 支付/消耗守卫：元素文本、点击落点与数值读数三层判定（生成物，勿手改） */
var G = (function () {
  function forbidden(ctx, text) {
    var list = (ctx.spec.guards && ctx.spec.guards.forbiddenTexts) || [];
    var t = String(text || '');
    for (var i = 0; i < list.length; i++) if (t.indexOf(list[i]) >= 0) return list[i];
    return null;
  }
  function guarded(ctx, text) {
    var list = (ctx.spec.guards && ctx.spec.guards.guardedActions) || [];
    var t = String(text || '');
    for (var i = 0; i < list.length; i++) if (t.indexOf(list[i].text) >= 0) return list[i];
    return null;
  }
  function numericRule(ctx, text) {
    var list = ctx.numericGuards || [];
    for (var i = 0; i < list.length; i++) if (String(text || '').indexOf(list[i].text) >= 0) return list[i];
    return null;
  }
  function evaluate(ctx, text, readings) {
    var f = forbidden(ctx, text);
    if (f) return { allow: false, reason: 'FORBIDDEN_TEXT', detail: f };
    var g = guarded(ctx, text);
    if (!g) return { allow: true, reason: 'NO_GUARD' };
    var rule = numericRule(ctx, g.text);
    if (!rule || rule.min === null) return { allow: false, reason: 'GUARD_RULE_TEXT_ONLY', detail: g.rule };
    var value = null;
    if (rule.readingKey && readings) value = readings[rule.readingKey];
    if (typeof value !== 'number' || isNaN(value)) return { allow: false, reason: 'GUARD_READING_REQUIRED', detail: g.text };
    if (value < rule.min) return { allow: false, reason: 'GUARD_VALUE_BELOW_MIN', detail: g.text, value: value, min: rule.min };
    return { allow: true, reason: 'GUARD_OK', value: value, min: rule.min };
  }
  // 点击落点守卫：命中该坐标的 OCR 文本若含 forbiddenTexts，直接拒绝（防止几何兜底点进付费入口）
  function atPoint(ctx, pt) {
    var ocr = ctx.lastOcr;
    var items = (ocr && ocr.items) || [];
    var hits = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i] || {};
      var b = it.bounds;
      if (!b) continue;
      var x = Number(pt.x), y = Number(pt.y);
      if (x >= Number(b.left) && x <= Number(b.right) && y >= Number(b.top) && y <= Number(b.bottom)) {
        var f = forbidden(ctx, it.text);
        if (f) hits.push({ text: String(it.text || ''), forbidden: f });
      }
    }
    return hits;
  }
  return { evaluate: evaluate, forbidden: forbidden, guarded: guarded, atPoint: atPoint };
})();
module.exports = G;
`;
}

function renderCoreActions() {
  return `/** core/actions.js —— 模式感知动作封装 + 守卫（生成物，勿手改） */
var A = (function () {
  function record(ctx, entry) { ctx.recorder.event(ctx, entry); }
  function checkResult(res, label) {
    if (!res || res.success !== true) {
      var code = String((res && res.reasonCode) || 'ACTION_FAILED');
      var err = new Error('动作失败 ' + label + ': ' + code + ' ' + String((res && res.message) || ''));
      err.code = code;
      throw err;
    }
    return res;
  }
  function guardFor(ctx, elementId) {
    var el = ctx.coordinates.byId(ctx, elementId);
    var text = String(el.desc || '') + ' ' + String((el.anchor && el.anchor.text) || '');
    var verdict = ctx.guards.evaluate(ctx, text, ctx.readings);
    if (verdict.allow !== true) {
      record(ctx, { kind: 'guard', target: elementId, verdict: verdict });
      var err = new Error('守卫拒绝 ' + elementId + ': ' + verdict.reason + ' ' + String(verdict.detail || ''));
      err.code = 'GUARD_REJECTED';
      throw err;
    }
    return verdict;
  }
  function pointGuard(ctx, elementId, pt) {
    var hits = ctx.guards.atPoint(ctx, pt);
    if (hits.length) {
      record(ctx, { kind: 'guard', target: elementId, reason: 'FORBIDDEN_AT_POINT', hits: hits });
      var err = new Error('守卫拒绝 ' + elementId + ': FORBIDDEN_AT_POINT ' + hits[0].forbidden);
      err.code = 'GUARD_REJECTED';
      throw err;
    }
  }
  // 元素可见性守卫：元素声明了 visibleInStates 时，只有最后一次截图/OCR 命中其中某个状态的文本锚点才允许动作。
  // 不额外截图（用缓存），专门挡住「页面已经翻过去、旧坐标还在盲点」的动作（真机实测：战斗结束后继续点快进会点进装备页）。
  function visibilityGuard(ctx, elementId) {
    var el = ctx.coordinates.byId(ctx, elementId);
    var vis = (el && Array.isArray(el.visibleInStates)) ? el.visibleInStates : null;
    if (!vis || !vis.length) return { allow: true, reason: 'NO_VISIBILITY_DECLARED' };
    var ocr = ctx.lastOcr;
    var text = (ocr && ocr.ok === true) ? String(ocr.text || '') : '';
    if (!text) return { allow: true, reason: 'NO_OCR_CACHE' };
    var states = (ctx.states && typeof ctx.states.list === 'function') ? ctx.states.list(ctx) : [];
    for (var i = 0; i < states.length; i++) {
      var st = states[i] || {};
      if (vis.indexOf(st.id) < 0) continue;
      var anchors = st.anchors || [];
      for (var j = 0; j < anchors.length; j++) {
        var a = anchors[j];
        var t = '';
        if (typeof a === 'string') t = a;
        else if (a && (!a.kind || a.kind === 'text')) t = String(a.text || '');
        if (t && text.indexOf(t) >= 0) return { allow: true, reason: 'VISIBLE:' + st.id, hit: t };
      }
    }
    return { allow: false, reason: 'ELEMENT_NOT_VISIBLE', states: vis };
  }
  function tap(ctx, elementId, enforceGuard) {
    if (enforceGuard !== false) guardFor(ctx, elementId);
    var pt = ctx.coordinates.resolve(ctx, elementId);
    pointGuard(ctx, elementId, pt);
    var vis = visibilityGuard(ctx, elementId);
    if (vis.allow !== true) {
      record(ctx, { kind: 'action-skipped', op: 'tap', target: elementId, verdict: vis });
      return { skipped: true, reason: vis.reason };
    }
    var res = __toolboxTap(pt.x, pt.y);
    checkResult(res, elementId);
    record(ctx, { kind: 'tap', target: elementId, x: pt.x, y: pt.y, source: pt.source });
    return { x: pt.x, y: pt.y };
  }
  function longPress(ctx, elementId, durationMs, enforceGuard) {
    if (enforceGuard !== false) guardFor(ctx, elementId);
    var pt = ctx.coordinates.resolve(ctx, elementId);
    pointGuard(ctx, elementId, pt);
    var visLP = visibilityGuard(ctx, elementId);
    if (visLP.allow !== true) {
      record(ctx, { kind: 'action-skipped', op: 'longPress', target: elementId, verdict: visLP });
      return { skipped: true, reason: visLP.reason };
    }
    var res = __toolboxLongPress(pt.x, pt.y, durationMs || 1500);
    checkResult(res, elementId);
    record(ctx, { kind: 'longPress', target: elementId, x: pt.x, y: pt.y, durationMs: durationMs || 1500 });
    return { x: pt.x, y: pt.y };
  }
  function swipe(ctx, fromId, toId, durationMs) {
    var a = ctx.coordinates.resolve(ctx, fromId);
    var b = ctx.coordinates.resolve(ctx, toId);
    pointGuard(ctx, fromId, a);
    pointGuard(ctx, toId, b);
    var visA = visibilityGuard(ctx, fromId);
    var visB = visibilityGuard(ctx, toId);
    if (visA.allow !== true || visB.allow !== true) {
      record(ctx, { kind: 'action-skipped', op: 'swipe', target: fromId + '->' + toId, verdict: (visA.allow !== true ? visA : visB) });
      return { skipped: true, reason: (visA.allow !== true ? visA.reason : visB.reason) };
    }
    var res = __toolboxSwipe(a.x, a.y, b.x, b.y, durationMs || 800);
    checkResult(res, fromId + '->' + toId);
    record(ctx, { kind: 'swipe', from: fromId, to: toId });
    return true;
  }
  function action(ctx, name) {
    var res = __toolboxAction(name);
    checkResult(res, name);
    record(ctx, { kind: 'action', name: name });
    return res;
  }
  return { tap: tap, longPress: longPress, swipe: swipe, action: action };
})();
module.exports = A;
`;
}
function renderCoreStates() {
  return `/** core/states.js —— 状态表与锚点打分（权重/required/exclusive/负锚点/优先级）（生成物，勿手改） */
var S = (function () {
  function list(ctx) { return (ctx.statesConfig && ctx.statesConfig.states) || []; }
  function normalizeAnchor(a) {
    if (typeof a === 'string') return { text: a, kind: 'text', weight: 1, required: false, exclusive: false };
    var o = a || {};
    return { text: String(o.text || ''), kind: String(o.kind || 'text'), weight: Number(o.weight || 1), required: o.required === true, exclusive: o.exclusive === true };
  }
  function anchorTexts(ctx) {
    var out = [];
    var st = list(ctx);
    for (var i = 0; i < st.length; i++) {
      if (st[i].confidence !== 'verified') continue;
      var a = st[i].anchors || [];
      for (var j = 0; j < a.length; j++) {
        var n = normalizeAnchor(a[j]);
        if (n.kind === 'text' && n.text && out.indexOf(n.text) < 0) out.push(n.text);
      }
    }
    return out;
  }
  function identify(ctx) {
    var current = ctx.lastOcr;
    if (!current || current.ok !== true) current = ctx.observe.ocr(ctx);
    var text = (current && current.text) || '';
    var best = { id: 'UNKNOWN', hits: [], score: 0, confidence: 'unknown' };
    var bestPriority = -Infinity;
    var st = list(ctx);
    for (var i = 0; i < st.length; i++) {
      var s = st[i];
      var neg = s.negativeAnchors || [];
      var negativeHit = false;
      for (var k = 0; k < neg.length; k++) if (text.indexOf(String(neg[k])) >= 0) negativeHit = true;
      if (negativeHit) continue;
      var raw = s.anchors || [];
      var anchors = [];
      for (var j = 0; j < raw.length; j++) anchors.push(normalizeAnchor(raw[j]));
      var textAnchors = [];
      for (var t = 0; t < anchors.length; t++) if (anchors[t].kind === 'text' && anchors[t].text) textAnchors.push(anchors[t]);
      if (!textAnchors.length) continue;
      var hits = [], score = 0, requiredOk = true, exclusiveHit = false, hasExclusive = false;
      for (var m = 0; m < textAnchors.length; m++) {
        var a = textAnchors[m];
        if (a.exclusive) hasExclusive = true;
        if (text.indexOf(a.text) >= 0) {
          hits.push(a.text);
          score += a.weight;
          if (a.exclusive) exclusiveHit = true;
        } else if (a.required) {
          requiredOk = false;
        }
      }
      if (!requiredOk) continue;
      if (hasExclusive && !exclusiveHit) continue;
      var minScore = (s.minScore === undefined ? 0 : Number(s.minScore));
      if (score <= 0 || score < minScore) continue;
      var priority = Number(s.priority || 0);
      if (score > best.score || (score === best.score && priority > bestPriority)) {
        best = { id: s.id, hits: hits, score: score, confidence: s.confidence || 'partial' };
        bestPriority = priority;
      }
    }
    return best;
  }
  function allowed(ctx, stateId, nextId) {
    var st = list(ctx);
    for (var i = 0; i < st.length; i++) {
      if (st[i].id !== stateId) continue;
      var next = st[i].next || [];
      return next.indexOf(nextId) >= 0;
    }
    return false;
  }
  return { list: list, anchorTexts: anchorTexts, identify: identify, allowed: allowed };
})();
module.exports = S;
`;
}

function renderCoreRecorder() {
  return `/** core/recorder.js —— 运行记录（JSONL 追加，不覆盖历史）（生成物，勿手改） */
var R = (function () {
  function event(ctx, entry) {
    var rec = entry || {};
    rec.at = new Date().getTime();
    rec.task = ctx.taskName;
    try {
      files.createWithDirs(ctx.recordPath);
      files.append(ctx.recordPath, JSON.stringify(rec) + '\\n');
    } catch (e) { log('RECORDER_WRITE_FAILED:' + String(e)); }
    return rec;
  }
  function result(ctx, payload) {
    event(ctx, { kind: 'result', payload: payload });
    log('RESULT:' + JSON.stringify(payload));
    return payload;
  }
  return { event: event, result: result };
})();
module.exports = R;
`;
}

function renderCoreMachine() {
  return `/** core/machine.js —— 状态判定 + 单步执行 + 任务判据（生成物，勿手改） */
var M = (function () {
  function detect(ctx) {
    ctx.observe.capture(ctx);
    var st = ctx.states.identify(ctx);
    ctx.recorder.event(ctx, { kind: 'detect', state: st.id, hits: st.hits, score: st.score, confidence: st.confidence });
    return st;
  }
  function navAttempt(ctx, spec, task) {
    var steps = (spec && Array.isArray(spec.navSteps)) ? spec.navSteps : [];
    var stepErrors = [];
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i] || {};
      // 导航每一步都会换页，点击前刷新一次截图+OCR：元素可见性守卫必须按「当前页面」判定，
      // 否则会拿进入导航时的旧画面把后续步骤全部跳过（2026-10-02 真机实测：NAJIE_HOME → MAIN_CITY 后卡住）。
      if (step.op === 'tap' || step.op === 'longPress' || step.op === 'dismiss') {
        try { ctx.observe.capture(ctx); ctx.observe.ocr(ctx); } catch (refreshError) {}
      }
      try {
        if (step.op === 'tap') ctx.actions.tap(ctx, step.element, step.guard !== false);
        else if (step.op === 'longPress') ctx.actions.longPress(ctx, step.element, step.ms || 1500, step.guard !== false);
        else if (step.op === 'wait') sleep(step.ms || 1000);
        else if (step.op === 'back') { __toolboxAction('BACK'); sleep(step.ms || 1200); }
        else if (step.op === 'dismiss') {
          var zone = step.element || 'popup_dismiss_zone';
          try { ctx.actions.tap(ctx, zone, false); } catch (e) { __toolboxTap(540, 1650); }
          sleep(step.ms || 1000);
        }
      } catch (e) {
        // 导航步骤失败不中断整条导航：后面的步骤仍可能把页面带回目标状态，
        // 最终是否到位由导航后的状态判定决定（2026-10-02 真机实测：结算页 BACK 不弹退出确认，
        // dialog_stay 的 fail-closed 抛错曾让整条导航直接放弃）。
        stepErrors.push({ index: i, op: String(step.op || ''), element: step.element || null, message: String(e) });
      }
      if (step.settleMs) sleep(step.settleMs);
    }
    if (stepErrors.length) ctx.recorder.event(ctx, { kind: 'nav-step-errors', task: task && task.name, errors: stepErrors });
    return { ok: true, stepErrors: stepErrors };
  }
  function runTask(ctx, task) {
    var st = detect(ctx);
    if (st.confidence === 'assumption') {
      return { ok: false, task: task.name, state: st.id, reason: 'STATE_ASSUMPTION_UNSAFE', detail: 'assumption 状态不得进入自动执行路径' };
    }
    var allowed = task.states || [];
    if (allowed.length && allowed.indexOf(st.id) < 0) {
      var spec0 = task.spec || {};
      var fromStates = Array.isArray(spec0.fromStates) ? spec0.fromStates : [];
      // 未识别页面（UNKNOWN）但有导航步骤时，允许一次「先归位再判定」：真机实测 2026-10-02 ——
      // 领奖弹窗（喜获得 / 点击任意位置关）OCR 命中不稳定，识别失败会让所有任务直接 STATE_NOT_ALLOWED 卡死；
      // 导航首步就是「点底部空白关闭弹层」的安全落点，所以只给一次机会，之后仍按 fail-closed 处理。
      var navSteps = Array.isArray(spec0.navSteps) ? spec0.navSteps : [];
      var unknownRecovery = (st.confidence === 'unknown') && navSteps.length > 0;
      if (!unknownRecovery && fromStates.indexOf(st.id) < 0) {
        return { ok: false, task: task.name, state: st.id, reason: 'STATE_NOT_ALLOWED', allowed: allowed, fromStates: fromStates };
      }
      if (unknownRecovery) ctx.recorder.event(ctx, { kind: 'nav-from-unknown', task: task.name, state: st.id });
      var maxNav = unknownRecovery ? 1 : Number(spec0.maxNavAttempts || 3);
      var reached = false;
      for (var attempt = 0; attempt < maxNav && !reached; attempt++) {
        var navOut = navAttempt(ctx, spec0, task);
        if (navOut.ok !== true) break;
        st = detect(ctx);
        if (st.confidence === 'assumption') break;
        if (!allowed.length || allowed.indexOf(st.id) >= 0) reached = true;
      }
      if (!reached) {
        return { ok: false, task: task.name, state: st.id, reason: 'STATE_NAV_FAILED', allowed: allowed, fromStates: fromStates, attempts: maxNav };
      }
      ctx.recorder.event(ctx, { kind: 'nav', task: task.name, toState: st.id });
    }
    var before = st.id;
    var out = task.run({ ctx: ctx, state: st });
    var ok = !!(out && out.ok !== false);
    var after = (out && out.skipVerify) ? null : detect(ctx);
    var verify = null;
    if (ok && typeof task.verify === 'function') {
      try { verify = task.verify({ ctx: ctx, state: after || st }); }
      catch (e) { verify = { ok: false, checks: [{ type: 'error', message: String(e) }], markers: [] }; }
      ok = verify.ok === true;
    }
    var markers = [];
    if (ok && verify) markers = verify.markers || [];
    else if (ok && out && out.markers) markers = out.markers;
    ctx.recorder.event(ctx, { kind: 'verify', state: after ? after.id : null, ok: ok, verify: verify });
    return {
      ok: ok,
      task: task.name,
      fromState: before,
      toState: after ? after.id : null,
      transitionAllowed: after ? ctx.states.allowed(ctx, before, after.id) : null,
      markers: markers,
      verify: verify,
      reason: (out && out.reason) || undefined,
      detail: (out && out.detail) || null
    };
  }
  return { detect: detect, runTask: runTask };
})();
module.exports = M;
`;
}

function renderCoreDetect(config) {
  return `/** core/detect.js —— yolodet 端上目标检测封装：懒加载 + 预热 + 按类阈值过滤（失败不降级）（生成物，勿手改） */
var D = (function () {
  var plugin = null;
  var prepared = false;
  function ensure(ctx) {
    if (prepared) return plugin;
    var cfg = ctx.detection || {};
    if (typeof $plugins === 'undefined' || !$plugins || typeof $plugins.load !== 'function') throw new Error('PLUGINS_UNAVAILABLE');
    var YoloDet = $plugins.load(String(cfg.plugin || 'com.zjh336.cn.tools.plugin.yolodet'));
    plugin = new YoloDet();
    var setRes = plugin.setModel(String(cfg.model || ''));
    if (!(setRes && setRes.ok === true)) throw new Error('SET_MODEL_FAILED:' + JSON.stringify(setRes));
    var prep = plugin.prepare();
    if (!(prep && prep.ok === true)) throw new Error('PREPARE_FAILED:' + JSON.stringify(prep));
    prepared = true;
    return plugin;
  }
  function thresholdOf(ctx, cls) {
    var cfg = ctx.detection || {};
    var per = cfg.classMinScore || {};
    if (typeof per[cls] === 'number') return per[cls];
    return typeof cfg.minScore === 'number' ? cfg.minScore : 0.5;
  }
  function detect(ctx, cls) {
    try {
      var shot = ctx.lastShot;
      if (!shot || shot.ok !== true) shot = ctx.observe.capture(ctx);
      if (!shot || shot.ok !== true) return { ok: false, count: 0, items: [], message: 'NO_CAPTURE' };
      var r = ensure(ctx).detectEx(shot.path);
      if (!r || r.ok !== true) return { ok: false, count: 0, items: [], message: 'DETECT_FAILED:' + String((r && r.message) || '') };
      var th = thresholdOf(ctx, cls);
      var items = [];
      var all = r.items || [];
      for (var i = 0; i < all.length; i++) {
        var it = all[i] || {};
        if (cls && String(it.className || '') !== String(cls)) continue;
        if (Number(it.score || 0) >= th) items.push(it);
      }
      return { ok: true, count: items.length, items: items, total: all.length, inferMs: r.inferMs, costMs: r.costMs, shot: shot.path };
    } catch (e) { return { ok: false, count: 0, items: [], message: String(e) }; }
  }
  function count(ctx, cls) { var r = detect(ctx, cls); return r.ok === true ? r.count : -1; }
  return { detect: detect, count: count };
})();
module.exports = D;
`;
}

function renderMain(detection) {
  const detectInit = (detection && detection.enabled)
    ? "ctx.detection = loadJson('config/detection.json');\nctx.detect = require('./core/detect.js');\n"
    : "";
  return `/** main.js —— 入口：解析参数 → 选任务 → 校验可写性 → 执行 → 输出 marker（生成物，勿手改） */
var params = (typeof __toolboxParams === 'object' && __toolboxParams) ? __toolboxParams : {};
var taskName = String(params.task || 'detect-state');
if (taskName.slice(-3) !== '.js') { taskName = taskName + '.js'; }
if (!/^[A-Za-z0-9._-]+\\.js$/.test(taskName)) { throw new Error('TASK_NAME_INVALID:' + taskName); }
function stamp() { return String(new Date().getTime()); }
var workDir = String(params.workDir || (files.cwd() + '/runs'));
var ctx = {
  taskName: taskName,
  dryRun: params.dryRun !== false,
  workDir: workDir,
  recordPath: workDir + '/run-' + stamp() + '.jsonl',
  stamp: stamp,
  readings: {},
  render: { left: 0, top: 0, width: device.width, height: device.height },
  lastShot: null,
  lastOcr: null
};
ctx.recorder = require('./core/recorder.js');
var baseDir = String((typeof __toolboxProjectDir === 'string' && __toolboxProjectDir) ? __toolboxProjectDir : (files.cwd() || ''));
if (!baseDir) { throw new Error('CWD_UNAVAILABLE'); }
function loadJson(rel) { return JSON.parse(files.read(baseDir + '/' + rel)); }
ctx.spec = loadJson('config/coordinates.json');
ctx.statesConfig = loadJson('config/states.json');
ctx.request = loadJson('config/request.json');
ctx.numericGuards = ctx.spec.numericGuards || [];
ctx.observe = require('./core/observe.js');
${detectInit}ctx.coordinates = require('./core/coordinates.js');
ctx.guards = require('./core/guards.js');
ctx.actions = require('./core/actions.js');
ctx.states = require('./core/states.js');
ctx.bootstrap = require('./core/bootstrap.js');
ctx.machine = require('./core/machine.js');
// 只读来源只有一个：任务模块自己的 readOnly 标记（不再维护第二份白名单）
try {
  var task = require('./tasks/' + taskName);
  var writeAllowed = (params.dryRun === false && params.allowWrite === true);
  if (task.readOnly !== true && !writeAllowed) {
    ctx.recorder.result(ctx, { ok: false, task: taskName, reason: 'WRITE_TASK_BLOCKED_IN_DRY_RUN', required: '{ task, dryRun: false, allowWrite: true }' });
    throw new Error('WRITE_TASK_BLOCKED_IN_DRY_RUN');
  }
  var payload = ctx.machine.runTask(ctx, task);
  ctx.recorder.result(ctx, payload);
} catch (e) {
  var failure = { ok: false, task: taskName, error: String(e), code: String((e && e.code) || '') };
  ctx.recorder.result(ctx, failure);
  throw e;
}
`;
}

function renderSpecTask(task) {
  const nameLit = JSON.stringify(task.name);
  return `/** tasks/${task.name} —— 由任务卡编译，勿手改（见 config/request.json → requestedScripts[].spec） */
var SPEC = ${JSON.stringify(task.spec)};

function isNumber(v) { return typeof v === 'number' && !isNaN(v); }
function valueOf(ctx, key) { return ctx && ctx.readings ? ctx.readings[key] : undefined; }
function snapshotReading(ctx, r, slot) {
  var v = ctx.observe.readNumber(ctx, r.pattern);
  if (slot === 'before') { ctx.readings[r.key] = v; if (ctx.readings[r.key + '#before'] === undefined) ctx.readings[r.key + '#before'] = v; }
  else { ctx.readings[r.key + '#after'] = v; ctx.readings[r.key] = v; }
  return v;
}
function readReadings(ctx, phase) {
  var list = SPEC.readings || [];
  for (var i = 0; i < list.length; i++) {
    var r = list[i];
    var when = r.when || 'before';
    if (phase === 'before' && (when === 'before' || when === 'both')) snapshotReading(ctx, r, 'before');
    if (phase === 'after' && (when === 'after' || when === 'both')) snapshotReading(ctx, r, 'after');
  }
  return ctx.readings;
}
function captureAndOcr(ctx) { ctx.observe.capture(ctx); ctx.observe.ocr(ctx); }
function settleMsOf(step) {
  if (step.settleMs !== undefined) return Number(step.settleMs);
  var op = String(step.op || '');
  return (op === 'tap' || op === 'longPress' || op === 'swipe') ? 1200 : 0;
}
function execStep(ctx, step, done) {
  step = step || {};
  if (step.readFirst) readReadings(ctx, 'before');
  var op = String(step.op || '');
  if (op === 'tap') { ctx.actions.tap(ctx, step.element, step.guard !== false); done.push('tap:' + step.element); }
  else if (op === 'longPress') { ctx.actions.longPress(ctx, step.element, step.ms || 1500, step.guard !== false); done.push('longPress:' + step.element); }
  else if (op === 'swipe') { ctx.actions.swipe(ctx, step.element, step.toElement, step.ms || 800); done.push('swipe:' + step.element + '->' + step.toElement); }
  else if (op === 'wait') { sleep(step.ms || 1000); done.push('wait:' + (step.ms || 1000)); }
  else if (op === 'read') { readReadings(ctx, 'before'); done.push('read'); }
  var settle = settleMsOf(step);
  if (settle > 0) sleep(settle);
  captureAndOcr(ctx);
  // 每一步之后的画面都留档：领奖弹窗这类「点完就消失」的页面，判据只能用当时那一帧复核，
  // 否则 verify 重新截图时弹窗已被后续收尾步骤关掉（真机实测：里程碑领取后判据必然落空）。
  ctx.stepCaptures.push({ ocr: ctx.lastOcr, shot: ctx.lastShot, at: new Date().getTime() });
  return ctx.stepCaptures.length;
}
function stopStateHit(ctx) {
  var list = (SPEC.loop && Array.isArray(SPEC.loop.stopWhenState)) ? SPEC.loop.stopWhenState : [];
  if (!list.length) return null;
  var st = ctx.states.identify(ctx);
  return (st && list.indexOf(st.id) >= 0) ? st.id : null;
}
function run(io) {
  var ctx = io.ctx;
  ctx.readings = ctx.readings || {};
  captureAndOcr(ctx);
  readReadings(ctx, 'before');
  var done = [];
  ctx.stepCaptures = [];
  var iterations = (SPEC.loop && SPEC.loop.maxIterations) ? SPEC.loop.maxIterations : 1;
  var stopReason = null;
  var finished = 0;
  var preSteps = SPEC.preSteps || [];
  for (var p = 0; p < preSteps.length; p++) { execStep(ctx, preSteps[p], done); }
  for (var it = 0; it < iterations; it++) {
    var steps = SPEC.steps || [];
    for (var i = 0; i < steps.length; i++) {
      execStep(ctx, steps[i], done);
      if (SPEC.loop && SPEC.loop.stopWhenAnchor && ctx.observe.findText(ctx, SPEC.loop.stopWhenAnchor)) {
        stopReason = 'STOP_ANCHOR:' + SPEC.loop.stopWhenAnchor;
        // 命中停止锚点的那一帧留档：结算页这类「一闪而过」的页面，判据必须用这一帧复核，
        // 否则 verify 重新截图时页面已经翻过去（真机实测：自动连战的胜利页约 2–3 秒后被下一场战斗顶掉）。
        ctx.stopCapture = { text: SPEC.loop.stopWhenAnchor, ocr: ctx.lastOcr, shot: ctx.lastShot, at: new Date().getTime() };
        it = iterations;
        break;
      }
      var hitState = stopStateHit(ctx);
      if (hitState) {
        // 终止态（如战败）立即停手：既不再按旧坐标盲点，也不必空转到次数上限。
        stopReason = 'STOP_STATE:' + hitState;
        it = iterations;
        break;
      }
    }
    finished = it + 1;
  }
  readReadings(ctx, 'after');
  return { ok: true, markers: [], detail: { steps: done, iterations: finished, stopReason: stopReason, readings: ctx.readings } };
}
function compareNumber(v, op, target) {
  if (!isNumber(v) || !isNumber(target)) return false;
  if (op === '>=') return v >= target;
  if (op === '>') return v > target;
  if (op === '<=') return v <= target;
  if (op === '<') return v < target;
  if (op === '==') return v === target;
  if (op === '!=') return v !== target;
  return false;
}
function verify(io) {
  var ctx = io.ctx;
  // 判据取样优先级：verifyOnStep（第 N 步之后的留档帧）> verifyOnStop（命中停止锚点的那一帧）> 重新截图。
  // 领奖弹窗、结算页这类瞬时页面只能用留档帧复核；缺省仍是重新截图判据（fail-closed）。
  var stepIdx = Number(SPEC.verifyOnStep || 0);
  var usedStepFrame = false;
  if (stepIdx > 0 && ctx.stepCaptures && ctx.stepCaptures[stepIdx - 1] && ctx.stepCaptures[stepIdx - 1].ocr) {
    ctx.lastOcr = ctx.stepCaptures[stepIdx - 1].ocr;
    usedStepFrame = true;
  }
  var usedStopFrame = !usedStepFrame && !!(SPEC.loop && SPEC.loop.verifyOnStop === true && ctx.stopCapture && ctx.stopCapture.ocr);
  if (usedStopFrame) ctx.lastOcr = ctx.stopCapture.ocr;
  else if (!usedStepFrame) captureAndOcr(ctx);
  var checks = [];
  var allOk = true;
  var list = SPEC.verify || [];
  for (var i = 0; i < list.length; i++) {
    var v = list[i] || {};
    var ok = false;
    var observed = null;
    if (v.type === 'anchor') {
      var hit = ctx.observe.findText(ctx, v.text);
      observed = !!hit;
      ok = (v.expect === false) ? !observed : observed;
    } else if (v.type === 'number') {
      observed = valueOf(ctx, v.key + '#after');
      if (observed === undefined) observed = valueOf(ctx, v.key);
      ok = compareNumber(observed, String(v.op || ''), v.value);
    } else if (v.type === 'changed' || v.type === 'unchanged') {
      var b = valueOf(ctx, v.key + '#before');
      var a = valueOf(ctx, v.key + '#after');
      if (a === undefined) a = valueOf(ctx, v.key);
      observed = { before: (b === undefined ? null : b), after: (a === undefined ? null : a) };
      if (v.type === 'changed') {
        ok = isNumber(a) && isNumber(b) && a !== b;
        if (ok && v.direction === 'increase') ok = a > b;
        if (ok && v.direction === 'decrease') ok = a < b;
      } else {
        ok = isNumber(a) && isNumber(b) && a === b;
      }
    }
    checks.push({ type: v.type, key: v.key || null, text: v.text || null, expect: (v.expect === undefined ? true : v.expect), op: v.op || null, value: (v.value === undefined ? null : v.value), direction: v.direction || null, observed: observed, ok: ok });
    if (!ok) allOk = false;
  }
  return { ok: allOk, checks: checks, usedCapture: usedStepFrame ? ('step-frame:' + stepIdx) : (usedStopFrame ? 'stop-anchor-frame' : 'fresh'), stopCaptureAt: usedStopFrame ? ctx.stopCapture.at : null, markers: allOk ? (SPEC.markers || []) : [] };
}
module.exports = { name: ${nameLit}, states: SPEC.startStates || [], spec: SPEC, readOnly: false, readiness: 'ready', run: run, verify: verify };
`;
}
function renderPlaceholderTask(task) {
  const name = JSON.stringify(task.name);
  return `/** tasks/${task.name} —— 占位：readiness=${task.readiness}，未生成可执行任务（勿手改） */
var task = {
  name: ${name},
  states: [],
  readOnly: true,
  notReady: true,
  readiness: ${JSON.stringify(task.readiness)},
  run: function () {
    return { ok: false, markers: [], detail: { reason: 'NOT_READY', readiness: ${JSON.stringify(task.readiness)}, missingEvidence: ${JSON.stringify(task.missingEvidence)} }, skipVerify: true };
  }
};
module.exports = task;
`;
}

function renderFrameworkTask(name, detection) {
  if (name === "bootstrap.js") {
    return `/** tasks/bootstrap.js —— 只读环境自检（框架任务，勿手改） */
var task = {
  name: "bootstrap.js",
  states: [],
  readOnly: true,
  run: function (io) {
    var report = io.ctx.bootstrap.run(io.ctx);
    log('BOOTSTRAP:' + JSON.stringify(report));
    return { ok: report.ok === true, markers: report.ok ? ['BOOTSTRAP_OK'] : [], detail: report, skipVerify: true };
  }
};
module.exports = task;
`;
  }
  if (name === "detect-targets.js") {
    return `/** tasks/detect-targets.js —— 只读目标检测冒烟（框架任务，勿手改） */
var task = {
  name: "detect-targets.js",
  states: [],
  readOnly: true,
  run: function (io) {
    var ctx = io.ctx;
    var classes = (ctx.detection && ctx.detection.classes) || [];
    var out = { ok: true, counts: {}, samples: {}, message: "" };
    for (var i = 0; i < classes.length; i++) {
      var r = ctx.detect.detect(ctx, classes[i]);
      if (r.ok !== true) { out.ok = false; out.message = String(r.message || 'DETECT_FAILED'); }
      out.counts[classes[i]] = r.ok === true ? r.count : -1;
      out.samples[classes[i]] = (r.items || []).slice(0, 5);
    }
    log('TARGETS_DETECTED:' + JSON.stringify(out));
    return { ok: out.ok === true, markers: out.ok ? ['TARGETS_DETECTED'] : [], detail: out, skipVerify: true };
  }
};
module.exports = task;
`;
  }
  return `/** tasks/detect-state.js —— 只读状态判定（框架任务，勿手改） */
var task = {
  name: "detect-state.js",
  states: [],
  readOnly: true,
  run: function (io) {
    var st = io.ctx.machine.detect(io.ctx);
    log('STATE_DETECTED:' + JSON.stringify(st));
    return { ok: st.id !== 'UNKNOWN', markers: ['STATE_DETECTED'], detail: st, skipVerify: true };
  }
};
module.exports = task;
`;
}

function renderTaskIndex(names) {
  return "module.exports = " + JSON.stringify(names, null, 2) + ";\n";
}

function statusLabel(status) {
  const labels = {
    "generated": "framework-generated",
    "needs-verification": "compiled-needs-verification",
    "partial-implementation": "partial-implementation",
    "not-implemented": "not-implemented"
  };
  return labels[status] || String(status);
}

function renderReadme(projectName, ctx, info, tasks) {
  const lines = [];
  lines.push("# " + projectName + "（生成物）");
  lines.push("");
  lines.push("由 `hz-autojs-automation-builder` 的 `generate-project.mjs` 从任务卡契约编译，来源运行目录：`" + info.runDir + "`。");
  lines.push("生成时间：" + info.generatedAt + "。任务模块由任务卡编译，**禁止手改 `tasks/`**；契约变化后重新生成。");
  lines.push("");
  lines.push("## 运行");
  lines.push("");
  lines.push("- 同步：`project_sync_plan` → `project_sync_push`（显式清单，一次一批）。");
  lines.push("- 只读任务：`bootstrap.js`、`detect-state.js`（`project_run` 默认 dryRun）。");
  lines.push("- 写入任务：必须同时传 `{ \"task\": \"<name>\", \"dryRun\": false, \"allowWrite\": true }`；缺一项会被拒绝并判失败。");
  lines.push("- 运行记录：`<项目目录>/runs/*.jsonl`（追加写）+ `runs/shots/`。");
  lines.push("");
  lines.push("## 任务清单（任务卡状态）");
  lines.push("");
  for (const t of tasks) {
    const nature = t.readOnly ? "只读" : "写入";
    const detail = t.missingEvidence.length ? "；缺：" + t.missingEvidence.join("；") : "";
    lines.push("- `" + t.name + "`：" + t.duty + " —— " + statusLabel(t.status) + "（" + nature + "，readiness=" + t.readiness + "）" + detail);
  }
  lines.push("");
  if (ctx.detection && ctx.detection.enabled) {
    lines.push("## 目标检测");
    lines.push("");
    lines.push("- 插件：`" + ctx.detection.plugin + "`；模型：`" + ctx.detection.model + "`");
    const perClass = Object.keys(ctx.detection.classMinScore || {}).map((k) => k + "=" + ctx.detection.classMinScore[k]);
    lines.push("- 类别：" + ctx.detection.classes.join(" / ") + "；全局阈值：" + ctx.detection.minScore + (perClass.length ? "；分类阈值：" + perClass.join(" / ") : ""));
    lines.push("- 只读冒烟任务：`detect-targets.js`（首跑门禁；检测失败不降级、不点屏）。");
    lines.push("- 环境检测与端上验收：`hz-autojs-detect-trainer`（`scripts/check-env.py` / `assets/verify-on-device.js`）。");
    lines.push("");
  }
  lines.push("## 守卫");
  lines.push("");
  lines.push("- 禁止文本（元素文本 + 点击落点 OCR 双层）：" + ((ctx.spec.guards.forbiddenTexts || []).join(" / ") || "无"));
  for (const g of (ctx.spec.guards.guardedActions || [])) lines.push("- " + g.text + "：" + g.rule);
  lines.push("");
  lines.push("## 未完成 / 未验证");
  lines.push("");
  for (const gap of ctx.request.openGaps || []) lines.push("- " + gap);
  if (info.uncoveredMarkers.length) lines.push("- 没有就绪任务实现的 successMarker：" + info.uncoveredMarkers.join(" / "));
  if (info.uncoveredGuards.length) lines.push("- 没有就绪任务消费的守卫：" + info.uncoveredGuards.join(" / "));
  lines.push("");
  lines.push("## 注意");
  lines.push("");
  lines.push("- marker 只在任务判据（verify）通过后发出；`RESULT.ok=false` 或判据未通过都代表业务未完成。");
  lines.push("- partial / blocked 任务只生成占位模块，运行返回 NOT_READY 并带 missingEvidence，不会执行任何动作。");
  return lines.join("\n") + "\n";
}

function buildAgentManifest(projectId, ctx, info, tasks, validation) {
  const spec = ctx.spec || {};
  const guardedActions = (spec.guards && spec.guards.guardedActions) || [];
  const forbiddenTexts = (spec.guards && spec.guards.forbiddenTexts) || [];
  const capabilities = tasks.map((t) => ({
    file: t.name,
    id: String(t.name).replace(/\\.js$/, ""),
    duty: t.duty,
    readOnly: t.readOnly === true,
    status: t.status,
    readiness: t.readiness,
    requiresStates: (t.spec && t.spec.startStates) || [],
    markers: t.markers,
    readings: (t.spec && t.spec.readings) || [],
    checks: (t.spec && t.spec.verify) || [],
    loop: (t.spec && t.spec.loop) || null,
    missingEvidence: t.missingEvidence,
    params: t.framework ? { task: t.name } : { task: t.name, dryRun: false, allowWrite: true },
    successRule: "marker 只在 verify 判据通过后发出；SUCCEEDED 只代表脚本跑完"
  }));
  return {
    schemaVersion: 1,
    kind: "hz-autojs-project-brief",
    project: {
      id: projectId,
      packageName: (ctx.request.target && ctx.request.target.packageName) || "",
      deviceId: (ctx.request.target && ctx.request.target.deviceId) || "",
      baseline: (ctx.request.target && ctx.request.target.baseline) || null,
      generator: "hz-autojs-automation-builder/generate-project.mjs",
      generatedAt: info.generatedAt,
      sourceRun: ctx.request.sourceRun || info.runDir,
      sourceTaskId: ctx.request.sourceTaskId || "",
      contractProvenance: "config/generated.json"
    },
    conversation: {
      answerSections: ["这是什么", "现在能做什么", "你现在在哪、建议做什么", "你可以怎么说"],
      commandExamples: ["这个项目能做什么？", "现在能做什么？", "先只判一下当前状态", "跑一次 <任务名>", "关一下弹窗"],
      rules: [
        "只列 status 为 generated 或 compiled-needs-verification 的能力；partial-implementation / not-implemented 不得承诺",
        "回答前先只读跑 detect-state.js 拿当前状态",
        "knownGaps / missingEvidence 里的内容不得承诺",
        "写入任务必须先说明消耗与守卫，并且只接受 { task, dryRun:false, allowWrite:true }"
      ]
    },
    detection: (ctx.detection && ctx.detection.enabled) ? {
      enabled: true,
      module: "core/detect.js",
      task: "detect-targets.js",
      plugin: ctx.detection.plugin,
      model: ctx.detection.model,
      classes: ctx.detection.classes,
      minScore: ctx.detection.minScore,
      classMinScore: ctx.detection.classMinScore || {},
      envCheck: "hz-autojs-detect-trainer/scripts/check-env.py",
      deviceVerify: "hz-autojs-detect-trainer/assets/verify-on-device.js"
    } : { enabled: false },
    capabilities: capabilities,
    guards: { forbiddenTexts: forbiddenTexts, guardedActions: guardedActions, uncoveredGuards: validation.stats.uncoveredGuards },
    verification: {
      successMarkers: (ctx.request.verification && ctx.request.verification.successMarkers) || [],
      uncoveredMarkers: validation.stats.uncoveredMarkers,
      markerRule: "marker 只在任务 verify 判据通过后发出"
    },
    runtime: {
      aiInStableLoop: false,
      screenshotSource: "设备侧 toolManager.captureScreenshot",
      stateDetectionApi: "toolManager.recognizeText",
      targetDetectionApi: (ctx.detection && ctx.detection.enabled) ? "yolodet 插件 detectEx（core/detect.js 封装）" : null,
      deviceActionApi: "__toolboxTap",
      sync: "project_sync_plan → project_sync_push（显式清单）",
      runReadOnly: "project_run（默认 dryRun，只允许只读任务）",
      runWrite: "写入任务需要 { task, dryRun: false, allowWrite: true }",
      records: "<项目目录>/runs/*.jsonl（追加写）+ runs/shots/"
    },
    knownGaps: ctx.request.openGaps || [],
    contractWarnings: validation.warnings,
    notImplemented: tasks.filter((t) => t.status === "not-implemented").map((t) => t.name),
    partialImplementation: tasks.filter((t) => t.status === "partial-implementation").map((t) => t.name)
  };
}

function renderAgentsMd(projectId, manifest) {
  const L = [];
  const p = manifest.project;
  L.push("# " + projectId + " —— 项目说明书（AI 入口）");
  L.push("");
  L.push("> 本文件与 `agent/manifest.json` 由 `generate-project.mjs` 自动生成，请勿手改；契约变化后重新生成。");
  L.push("> 回答用户前先读 `agent/manifest.json`，不要凭记忆答。");
  L.push("");
  L.push("## 这是什么");
  L.push("");
  L.push("- 目标应用：`" + p.packageName + "`" + (p.deviceId ? "（设备 `" + p.deviceId + "`）" : ""));
  L.push("- 分辨率基线：" + (p.baseline ? p.baseline.width + "×" + p.baseline.height : "未声明"));
  L.push("- 来源：探索目录 `" + p.sourceRun + "`；契约快照在 `config/`，来源指纹在 `config/generated.json`");
  L.push("- 性质：设备侧固化项目，稳定运行期 AI 调用 0 次；任务由探索产出的任务卡编译，marker 只在判据通过后发出");
  L.push("- 目标检测：" + ((manifest.detection && manifest.detection.enabled)
    ? "已启用（模型 `" + manifest.detection.model + "`，类别 " + manifest.detection.classes.join(" / ") + "，只读冒烟任务 `detect-targets.js`）"
    : "未启用（生成时未带 --detect-model）"));
  L.push("");
  L.push("## 用户问你时，按这四段回答");
  L.push("");
  L.push("1. **这是什么** —— 一句话：目标应用 + 这个项目负责干什么。");
  L.push("2. **现在能做什么** —— 只列 `generated` / `compiled-needs-verification` 的能力；`partial-implementation` 与 `not-implemented` 一律说「未实现/缺证据」，并给出 missingEvidence。");
  L.push("3. **现在在哪、建议做什么** —— 先只读跑 `detect-state.js` 拿当前状态，再挑前置状态满足的就绪任务。");
  L.push("4. **你可以怎么说** —— 给 2~4 条可以直接复制的指令。");
  L.push("");
  L.push("## 能力清单（自动汇总）");
  L.push("");
  L.push("| 任务 | 用途 | 状态 | 前置状态 | 读数 |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const c of manifest.capabilities) {
    const st = c.requiresStates.length ? c.requiresStates.join(" / ") : "—";
    const rd = c.readings.length ? c.readings.map((r) => r.key).join("、") : "—";
    L.push("| `" + c.file + "` | " + c.duty + " | " + c.status + " | " + st + " | " + rd + " |");
  }
  L.push("");
  L.push("## 守卫（硬规则，不许绕过）");
  L.push("");
  L.push("- 禁止文本（元素文本 + 点击落点 OCR 双层）：" + (manifest.guards.forbiddenTexts.join(" / ") || "无"));
  for (const g of manifest.guards.guardedActions) L.push("- " + g.text + "：" + g.rule);
  L.push("- 未接线（没有就绪任务消费）的守卫：" + (manifest.guards.uncoveredGuards.join(" / ") || "无"));
  L.push("");
  L.push("## 怎么运行");
  L.push("");
  L.push("- 同步：" + manifest.runtime.sync);
  L.push("- 只读任务：" + manifest.runtime.runReadOnly);
  if (manifest.detection && manifest.detection.enabled) L.push("- 目标检测通道：" + manifest.runtime.targetDetectionApi + "；检测失败不降级、不点屏");
  L.push("- 写入任务：" + manifest.runtime.runWrite + "（缺一项会被拒绝并判失败）");
  L.push("- 运行记录：" + manifest.runtime.records + "（不覆盖历史）");
  L.push("");
  L.push("## 没做到的（不得当成已支持）");
  L.push("");
  for (const n of manifest.notImplemented) L.push("- 未实现：" + n);
  for (const n of manifest.partialImplementation) L.push("- 部分实现（无任务卡）：" + n);
  for (const m of manifest.verification.uncoveredMarkers) L.push("- 未兑现 successMarker：" + m);
  for (const g of manifest.knownGaps) L.push("- 未验证：" + g);
  return L.join("\n") + "\n";
}

function buildNumericGuards(guards) {
  const list = [];
  const actions = (guards && guards.guardedActions) || [];
  for (const g of actions) {
    const text = String(g.text || "");
    const rule = String(g.rule || "");
    const m = rule.match(/[>\u2265]=?\s*([0-9]+)/);
    const readingKey = g.readingKey ? String(g.readingKey) : null;
    if (m) list.push({ text, min: Number(m[1]), source: "min", readingKey });
    else if (rule.indexOf("\u514d\u8d39\u6b21\u6570") >= 0) list.push({ text, min: 1, source: "free-quota", readingKey });
    else list.push({ text, min: null, source: "text-only", readingKey });
  }
  return list;
}

function main() {
  const args = parseArgs(process.argv);
  const report = { ok: false, errors: [], warnings: [], stats: {} };
  if (!args.run) {
    report.errors.push("缺少 --run <探索运行目录>");
    die(report);
  }
  const runDir = path.resolve(args.run);
  const requestPath = path.join(runDir, "project-request.json");
  const statePath = path.join(runDir, "state-model.json");
  const evidencePath = path.join(runDir, "evidence-index.json");

  const ctx = { runDir: runDir };
  const detection = buildDetection(args);
  report.errors = report.errors.concat(detection.errors);
  ctx.detection = detection.config;
  if (!fs.existsSync(requestPath)) report.errors.push("找不到 " + requestPath);
  if (!fs.existsSync(statePath)) report.errors.push("找不到 " + statePath);
  if (report.errors.length) die(report);

  ctx.request = readJson(requestPath);
  ctx.stateModel = readJson(statePath);
  ctx.evidenceIndex = fs.existsSync(evidencePath) ? readJson(evidencePath) : null;

  const specRef = (ctx.request.coordinateSpec && ctx.request.coordinateSpec.file) || "";
  const candidates = [
    path.resolve(runDir, specRef),
    path.resolve(runDir, "..", "..", specRef),
    path.resolve(runDir, "..", "..", "..", specRef)
  ];
  const specPath = candidates.find((c) => fs.existsSync(c));
  if (!specPath) report.errors.push("找不到坐标契约: " + specRef + "（尝试过 " + candidates.length + " 个位置）");
  else ctx.spec = readJson(specPath);

  const validation = validate(ctx);
  report.errors = report.errors.concat(validation.errors);
  report.warnings = report.warnings.concat(validation.warnings);
  report.stats = validation.stats;
  report.stats.specPath = specPath || null;
  report.stats.detection = {
    enabled: ctx.detection.enabled,
    model: ctx.detection.model || null,
    classes: ctx.detection.classes,
    minScore: ctx.detection.minScore,
    classMinScore: ctx.detection.classMinScore || {}
  };
  report.stats.notImplemented = validation.tasks.filter((t) => t.status === "not-implemented").map((t) => t.name);

  if (report.errors.length) die(report);
  if (args.check) {
    report.ok = true;
    report.mode = "check";
    die(report);
  }

  const projectId = String(args.id || path.basename(runDir)).replace(/[^A-Za-z0-9._-]/g, "-");
  const outRoot = path.resolve(args.out || path.join(process.cwd(), "hz-autojs-projects"));
  const projectDir = path.join(outRoot, "projects", projectId);
  if (fs.existsSync(projectDir) && !args.force) {
    report.errors.push("目标已存在，加 --force 覆盖: " + projectDir);
    die(report);
  }
  if (fs.existsSync(projectDir) && args.force) {
    const prevGeneratedPath = path.join(projectDir, "config", "generated.json");
    const prev = fs.existsSync(prevGeneratedPath) ? readJson(prevGeneratedPath) : null;
    if (prev && prev.detection && prev.detection.enabled === true && !ctx.detection.enabled && !args.noDetect) {
      report.errors.push("该项目生成时启用了目标检测；重新生成请带 --detect-model/--detect-classes，或显式 --no-detect 关闭");
      die(report);
    }
  }

  const generatedAt = new Date().toISOString();
  const files = {};
  files["project.json"] = JSON.stringify({
    name: projectId,
    packageName: ctx.request.target.packageName,
    main: "main.js",
    versionName: "1.0.0",
    versionCode: 1,
    abis: ["armeabi-v7a", "arm64-v8a"],
    features: { builtInOCR: "with-models", nodejs: "disabled" },
    autoOpen: false,
    launchConfig: { hideLogs: false, displaySplash: false },
    permissionConfig: { requestListOnStartup: ["android.permission.WRITE_EXTERNAL_STORAGE"] },
    ignore: ["runs"]
  }, null, 2) + "\n";

  const specOut = JSON.parse(JSON.stringify(ctx.spec));
  specOut.numericGuards = buildNumericGuards(ctx.spec.guards);
  files["config/coordinates.json"] = JSON.stringify(specOut, null, 2) + "\n";
  files["config/states.json"] = JSON.stringify({ schemaVersion: 1, states: ctx.stateModel.states || [], evidenceStateAliases: ctx.stateModel.evidenceStateAliases || null }, null, 2) + "\n";
  files["config/request.json"] = JSON.stringify(ctx.request, null, 2) + "\n";
  files["config/generated.json"] = JSON.stringify({
    generator: "hz-autojs-automation-builder/generate-project.mjs",
    projectId,
    generatedAt,
    detection: ctx.detection.enabled ? {
      enabled: true,
      module: "core/detect.js",
      task: "detect-targets.js",
      plugin: ctx.detection.plugin,
      model: ctx.detection.model,
      classes: ctx.detection.classes,
      minScore: ctx.detection.minScore,
      classMinScore: ctx.detection.classMinScore || {}
    } : { enabled: false },
    sourceRun: ctx.request.sourceRun,
    sourceTaskId: ctx.request.sourceTaskId,
    inputs: {
      request: { file: "project-request.json", sha256: sha256(requestPath) },
      stateModel: { file: "state-model.json", sha256: sha256(statePath) },
      coordinateSpec: { file: path.basename(specPath), sha256: sha256(specPath) },
      evidenceIndex: ctx.evidenceIndex ? { file: "evidence-index.json", sha256: sha256(evidencePath) } : null
    },
    taskCards: {
      ready: validation.tasks.filter((t) => t.readiness === "ready").map((t) => t.name),
      partial: validation.tasks.filter((t) => t.readiness === "partial").map((t) => t.name),
      blocked: validation.tasks.filter((t) => t.readiness === "blocked").map((t) => t.name)
    },
    uncoveredMarkers: validation.stats.uncoveredMarkers,
    uncoveredGuards: validation.stats.uncoveredGuards,
    notImplemented: report.stats.notImplemented
  }, null, 2) + "\n";

  files["core/bootstrap.js"] = renderCoreBootstrap();
  files["core/coordinates.js"] = renderCoreCoordinates();
  files["core/observe.js"] = renderCoreObserve();
  if (ctx.detection.enabled) {
    files["core/detect.js"] = renderCoreDetect(ctx.detection);
    files["config/detection.json"] = JSON.stringify(ctx.detection, null, 2) + "\n";
  }
  files["core/states.js"] = renderCoreStates();
  files["core/guards.js"] = renderCoreGuards();
  files["core/actions.js"] = renderCoreActions();
  files["core/recorder.js"] = renderCoreRecorder();
  files["core/machine.js"] = renderCoreMachine();
  files["main.js"] = renderMain(ctx.detection);

  const scriptNames = [];
  for (const t of validation.tasks) {
    scriptNames.push(t.name);
    files["tasks/" + t.name] = t.framework ? renderFrameworkTask(t.name, ctx.detection) : (t.spec ? renderSpecTask(t) : renderPlaceholderTask(t));
  }
  files["tasks/index.js"] = renderTaskIndex(scriptNames);
  const info = {
    runDir: ctx.request.sourceRun || runDir,
    generatedAt,
    detection: ctx.detection,
    uncoveredMarkers: validation.stats.uncoveredMarkers,
    uncoveredGuards: validation.stats.uncoveredGuards
  };
  files["README.md"] = renderReadme(projectId, ctx, info, validation.tasks);
  const agentManifest = buildAgentManifest(projectId, ctx, info, validation.tasks, validation);
  files["agent/manifest.json"] = JSON.stringify(agentManifest, null, 2) + "\n";
  files["AGENTS.md"] = renderAgentsMd(projectId, agentManifest);

  for (const [rel, content] of Object.entries(files)) write(path.join(projectDir, rel), content);

  report.ok = true;
  report.mode = "generate";
  report.projectDir = projectDir;
  report.files = Object.keys(files).length;
  die(report);
}

main();