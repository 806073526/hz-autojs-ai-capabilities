#!/usr/bin/env node
/**
 * self-test.mjs —— 生成器自检（不依赖设备/网络）。
 *
 * 覆盖：
 *   1. 合法任务卡契约 --check 通过，生成项目，所有产物 node --check 通过；
 *   2. 编译任务的 run/verify 判据在 Node 桩环境下真实执行：数值判据通过才发 marker，判据失败 marker 为空；
 *   3. 三层守卫：元素文本、数值读数（不足拒绝）、点击落点 OCR（命中 forbidden 拒绝）；
 *   4. 状态打分：required 门禁与权重；
 *   5. 目标检测可选能力：启用时生成 core/detect.js + config/detection.json + detect-targets.js
 *      （阈值过滤/插件缺失桩测试），未启用不生成；检测参数负例必须报 error。
 *   6. 负例：ready 无任务卡 / 守卫步骤缺 readFirst / marker 不在 successMarkers / requestedScripts 用字符串 —— 必须报 error。
 *
 * 用法：node self-test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const GENERATOR = path.join(here, "generate-project.mjs");
const require = createRequire(import.meta.url);
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? "" : String(detail) });
  if (!ok) console.error("FAIL: " + name + (detail ? " -> " + detail : ""));
}
function runGenerator(args) {
  return spawnSync(process.execPath, [GENERATOR, ...args], { encoding: "utf8" });
}
function nodeCheck(file) {
  return spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
}

function goodRequest(overrides) {
  const request = {
    schemaVersion: 1,
    sourceTaskId: "self-test",
    sourceRun: "self-test",
    projectTemplate: "state-machine",
    inputs: { stateModel: "state-model.json", evidenceIndex: "evidence-index.json" },
    target: { packageName: "com.example.selftest", deviceId: "device_selftest", baseline: { width: 1080, height: 1920 } },
    requestedScripts: [
      { name: "bootstrap.js", duty: "环境自检", readiness: "ready" },
      { name: "detect-state.js", duty: "状态判定", readiness: "ready" },
      {
        name: "claim-reward.js",
        duty: "领取奖励并用剩余数量复核",
        readiness: "ready",
        spec: {
          startStates: ["MAIN_CITY"],
          steps: [
            { op: "tap", element: "mail_entry", guard: false, settleMs: 0 },
            { op: "tap", element: "claim_button" }
          ],
          verifyOnStep: 2,
          readings: [{ key: "rewardCount", pattern: "([0-9]+)封", when: "both" }],
          verify: [
            { type: "number", key: "rewardCount", op: "<=", value: 0 },
            { type: "anchor", text: "已领取" }
          ],
          markers: ["CLAIM_OK"]
        }
      },
      {
        name: "donate.js",
        duty: "只走免费次数捐献一次并复核次数减少",
        readiness: "ready",
        spec: {
          startStates: ["MAIN_CITY"],
          steps: [{ op: "tap", element: "donate_button", readFirst: true }],
          readings: [{ key: "freeDonateLeft", pattern: "([0-9]+)/20", when: "both" }],
          verify: [{ type: "changed", key: "freeDonateLeft", direction: "decrease" }],
          markers: ["DONATE_OK"]
        }
      },
      {
        name: "spin.js",
        duty: "前置步骤只跑一次 + 循环点快进直到结算锚点",
        readiness: "ready",
        spec: {
          startStates: ["MAIN_CITY"],
          preSteps: [{ op: "tap", element: "mail_entry", guard: false, settleMs: 0 }],
          loop: { maxIterations: 3, stopWhenAnchor: "已领取", verifyOnStop: true, stopWhenState: ["BATTLE"] },
          steps: [
            { op: "wait", ms: 10 },
            { op: "tap", element: "claim_button", guard: false, settleMs: 0 }
          ],
          readings: [],
          verify: [{ type: "anchor", text: "已领取" }],
          markers: ["SPIN_OK"]
        }
      },
      { name: "future-task.js", duty: "未完成的能力", readiness: "partial", missingEvidence: ["缺少脚本级复跑证据"] }
    ],
    coordinateSpec: { file: "coordinate-spec.json", verifiedBuckets: ["16:9@1080x1920"], unverifiedBuckets: ["18:9"] },
    runtimeConstraints: { aiInStableLoop: false, maxUnknownStateEscalations: 2, deviceActionApi: "__toolboxTap" },
    verification: { replayRequired: true, evidenceDirectory: "runs/", successMarkers: ["STATE_DETECTED", "CLAIM_OK", "DONATE_OK", "SPIN_OK"] },
    openGaps: ["示例缺口"]
  };
  return Object.assign(request, overrides || {});
}

function stateModel(overrides) {
  const m = {
    schemaVersion: 1,
    states: [
      { id: "MAIN_CITY", confidence: "verified", anchors: [{ text: "城市", weight: 0.2, exclusive: true }, { text: "冒险", weight: 0.2 }], actions: [], next: ["BATTLE"] },
      { id: "BATTLE", confidence: "verified", anchors: [{ text: "回合", required: true }, { text: "胜利", weight: 0.5 }], actions: [], next: ["MAIN_CITY"] }
    ],
    evidenceStateAliases: { map: { CITY_VIEW: ["MAIN_CITY"], BATTLE_VIEW: ["BATTLE"] } }
  };
  return Object.assign(m, overrides || {});
}

function coordinateSpec(overrides) {
  const s = {
    schemaVersion: 1,
    app: "com.example.selftest",
    baseline: { width: 1080, height: 1920 },
    elements: [
      { id: "mail_entry", desc: "主城-邮件", mode: "edge", edge: "top-right", dx: 100, dy: 100, visibleInStates: ["MAIN_CITY"], noFallbackReason: "示例" },
      { id: "claim_button", desc: "邮件-一键领取", mode: "edge", edge: "bottom-center", xMode: "ratio", rx: 0.5, yMode: "edge", dy: 300, visibleInStates: ["MAIN_CITY"], noFallbackReason: "示例" },
      { id: "donate_button", desc: "捐献按钮（只走免费次数）", mode: "edge", edge: "bottom-center", xMode: "ratio", rx: 0.5, yMode: "edge", dy: 400, visibleInStates: ["MAIN_CITY"], noFallbackReason: "示例" }
    ],
    guards: {
      forbiddenTexts: ["购买", "充值"],
      guardedActions: [{ text: "捐献", rule: "只走每日免费次数；超出后消耗紫晶币，跳过", readingKey: "freeDonateLeft" }]
    },
    verification: { maxResidualRatioOfShortSide: 0.015, verifiedBuckets: ["16:9@1080x1920"], unverifiedBuckets: ["18:9"] }
  };
  return Object.assign(s, overrides || {});
}

function writeFixture(root, request, model, spec, evidence) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "project-request.json"), JSON.stringify(request, null, 2));
  fs.writeFileSync(path.join(root, "state-model.json"), JSON.stringify(model, null, 2));
  fs.writeFileSync(path.join(root, "coordinate-spec.json"), JSON.stringify(spec, null, 2));
  fs.writeFileSync(path.join(root, "evidence-index.json"), JSON.stringify(evidence || { schemaVersion: 1, records: [{ state: "CITY_VIEW" }, { state: "BATTLE_VIEW" }] }, null, 2));
}

function makeTaskCtx(values) {
  const seq = {};
  for (const k of Object.keys(values.numbers || {})) seq[k] = [].concat(values.numbers[k]);
  const ctx = {
    readings: {},
    actions: {
      tap: (c, id, guard) => { (c.__taps = c.__taps || []).push({ id, guard: guard !== false }); },
      longPress: () => {}, swipe: () => {}
    },
    observe: {
      // 与设备侧 core/observe.js 同语义：capture/ocr 必须把结果写回 ctx.lastShot / ctx.lastOcr，
      // 否则 verifyOnStep / verifyOnStop 的留档帧永远是空的（判据只能退回重新截图）。
      capture: (c) => { const shot = { ok: true, path: "stub.png" }; if (c) c.lastShot = shot; return shot; },
      ocr: (c) => { const res = { ok: true, text: "", items: [] }; if (c) c.lastOcr = res; return res; },
      findText: (c, text) => ((values.anchors || []).indexOf(text) >= 0 ? { x: 1, y: 1, text } : null),
      readNumber: (c, pattern) => {
        if (!seq[pattern] || !seq[pattern].length) return null;
        return seq[pattern].length > 1 ? seq[pattern].shift() : seq[pattern][0];
      }
    },
    states: { identify: () => ({ id: String(values.state || "MAIN_CITY") }) },
    recorder: { event: () => {} }
  };
  return ctx;
}

function main() {
  global.sleep = () => {}; // 设备侧全局 sleep 的 Node 桩
  global.log = () => {}; // 设备侧全局 log 的 Node 桩
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hz-gen-selftest-"));
  try {
    const good = path.join(tmp, "good");
    writeFixture(good, goodRequest(), stateModel(), coordinateSpec());

    const checkRes = runGenerator(["--run", good, "--check"]);
    check("合法契约 --check 通过（exit 0）", checkRes.status === 0, checkRes.stdout + checkRes.stderr);
    let checkJson = {};
    try { checkJson = JSON.parse(checkRes.stdout); } catch (e) { check("--check 输出为 JSON", false, String(e)); }
    check("--check 报告 compiled=5 / placeholders=1", checkJson.stats && checkJson.stats.compiled === 5 && checkJson.stats.placeholders === 1, JSON.stringify(checkJson.stats));

    const outRoot = path.join(tmp, "out");
    const genRes = runGenerator(["--run", good, "--out", outRoot, "--id", "fixture"]);
    check("生成项目成功（exit 0）", genRes.status === 0, genRes.stdout + genRes.stderr);
    const projectDir = path.join(outRoot, "projects", "fixture");
    const generated = [];
    (function walk(dir) {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith(".js")) generated.push(p);
      }
    })(projectDir);
    let badSyntax = [];
    for (const f of generated) if (nodeCheck(f).status !== 0) badSyntax.push(f);
    check("生成物 " + generated.length + " 个 .js 全部通过 node --check", badSyntax.length === 0, badSyntax.join(", "));

    const mainSrc = fs.readFileSync(path.join(projectDir, "main.js"), "utf8");
    check("写入门禁是 AND 语义（dryRun===false && allowWrite===true）", mainSrc.indexOf("params.dryRun === false && params.allowWrite === true") >= 0);
    check("main.js 不再维护第二份只读白名单", mainSrc.indexOf("READ_ONLY") < 0);
    check("截图后旧 OCR 失效", fs.readFileSync(path.join(projectDir, "core", "observe.js"), "utf8").indexOf("ctx.lastOcr = null") >= 0);
    check("未启用目标检测时不生成 core/detect.js", !fs.existsSync(path.join(projectDir, "core", "detect.js")));
    check("未启用目标检测时 manifest 明确声明", (() => {
      const m = JSON.parse(fs.readFileSync(path.join(projectDir, "agent", "manifest.json"), "utf8"));
      return m.detection && m.detection.enabled === false;
    })());

    const claim = require(path.join(projectDir, "tasks", "claim-reward.js"));
    const ctx1 = makeTaskCtx({ numbers: { "([0-9]+)封": [5, 0] }, anchors: ["已领取"] });
    claim.run({ ctx: ctx1 });
    const v1 = claim.verify({ ctx: ctx1 });
    check("数值+锚点判据通过时才发 marker", v1.ok === true && v1.markers.length === 1 && v1.markers[0] === "CLAIM_OK", JSON.stringify(v1));
    check("导航步骤 guard:false，消耗步骤默认启用守卫", ctx1.__taps.length === 2 && ctx1.__taps[0].guard === false && ctx1.__taps[1].guard === true, JSON.stringify(ctx1.__taps));

    const ctx2 = makeTaskCtx({ numbers: { "([0-9]+)封": [5, 5] }, anchors: [] });
    claim.run({ ctx: ctx2 });
    const v2 = claim.verify({ ctx: ctx2 });
    check("判据失败时 marker 为空", v2.ok === false && v2.markers.length === 0, JSON.stringify(v2));

    const donate = require(path.join(projectDir, "tasks", "donate.js"));
    const ctx3 = makeTaskCtx({ numbers: { "([0-9]+)/20": [3, 3, 2] } });
    donate.run({ ctx: ctx3 });
    const v3 = donate.verify({ ctx: ctx3 });
    check("readFirst 在动作前刷新读数（before=3）", ctx3.readings["freeDonateLeft#before"] === 3, JSON.stringify(ctx3.readings));
    check("after 读数与 before 不同才判 changed 通过", v3.ok === true && v3.markers[0] === "DONATE_OK", JSON.stringify(v3));
    check("verifyOnStep 用留档帧复核（不重新截图）", v1.usedCapture === "step-frame:2", JSON.stringify(v1));

    const spin = require(path.join(projectDir, "tasks", "spin.js"));
    const ctx4 = makeTaskCtx({ anchors: ["已领取"], state: "MAIN_CITY" });
    const spinRun = spin.run({ ctx: ctx4 });
    const v4 = spin.verify({ ctx: ctx4 });
    check("preSteps 只跑一次（不在循环里重放）", ctx4.__taps.length === 1 && ctx4.__taps[0].id === "mail_entry", JSON.stringify(ctx4.__taps));
    check("preSteps + stopWhenAnchor + verifyOnStop 用停止帧发 marker", v4.ok === true && v4.usedCapture === "stop-anchor-frame" && v4.markers[0] === "SPIN_OK" && spinRun.detail.stopReason === "STOP_ANCHOR:已领取", JSON.stringify(v4) + " " + JSON.stringify(spinRun.detail));

    const ctx5 = makeTaskCtx({ anchors: [], state: "BATTLE" });
    const spinRun2 = spin.run({ ctx: ctx5 });
    check("loop.stopWhenState 命中终止态立即停手（循环体不再点）", spinRun2.detail.stopReason === "STOP_STATE:BATTLE" && ctx5.__taps.length === 1, JSON.stringify(spinRun2.detail) + " " + JSON.stringify(ctx5.__taps));

    const placeholder = require(path.join(projectDir, "tasks", "future-task.js"));
    const pOut = placeholder.run({});
    check("partial 任务生成占位并带 missingEvidence", pOut.ok === false && pOut.detail.reason === "NOT_READY" && pOut.detail.missingEvidence.length === 1, JSON.stringify(pOut));

    const guardsMod = require(path.join(projectDir, "core", "guards.js"));
    const actionsMod = require(path.join(projectDir, "core", "actions.js"));
    const specIn = JSON.parse(fs.readFileSync(path.join(projectDir, "config", "coordinates.json"), "utf8"));
    const guardCtx = {
      spec: specIn, numericGuards: specIn.numericGuards || [], readings: { freeDonateLeft: 3 }, render: { left: 0, top: 0, width: 1080, height: 1920 },
      lastOcr: { ok: true, text: "", items: [] }, recorder: { event: () => {} }
    };
    guardCtx.coordinates = require(path.join(projectDir, "core", "coordinates.js"));
    guardCtx.guards = guardsMod;
    guardCtx.observe = { findText: () => ({ x: 540, y: 1520 }), ocr: () => ({ ok: true, text: "", items: [] }), capture: () => ({ ok: true }) };
    global.__toolboxTap = () => ({ success: true });
    let guardError = "";
    try { actionsMod.tap(guardCtx, "donate_button", true); } catch (e) { guardError = String(e); }
    check("读数足够时守卫放行", guardError === "");
    guardCtx.readings.freeDonateLeft = 0;
    guardError = "";
    try { actionsMod.tap(guardCtx, "donate_button", true); } catch (e) { guardError = String(e); }
    check("读数不足时守卫拒绝（GUARD_REJECTED）", guardError.indexOf("GUARD_VALUE_BELOW_MIN") >= 0, guardError);
    guardCtx.readings.freeDonateLeft = 5;
    guardCtx.lastOcr = { ok: true, text: "购买", items: [{ text: "购买", bounds: { left: 0, top: 0, right: 1080, bottom: 1920 } }] };
    guardError = "";
    try { actionsMod.tap(guardCtx, "donate_button", true); } catch (e) { guardError = String(e); }
    check("点击落点命中 forbidden 文本时拒绝（FORBIDDEN_AT_POINT）", guardError.indexOf("FORBIDDEN_AT_POINT") >= 0, guardError);

    const statesMod = require(path.join(projectDir, "core", "states.js"));
    function identify(text) {
      const ctx = { statesConfig: stateModel(), observe: { ocr: () => ({ ok: true, text, items: [] }) }, lastOcr: { ok: true, text, items: [] } };
      return statesMod.identify(ctx);
    }
    check("required 门禁：缺 回合 时 BATTLE 不参与", identify("城市 冒险 胜利").id === "MAIN_CITY", JSON.stringify(identify("城市 冒险 胜利")));
    check("权重生效：回合 命中时 BATTLE 胜过主城通用词", identify("城市 冒险 纳戒 势力 历练 回合").id === "BATTLE", JSON.stringify(identify("城市 冒险 纳戒 势力 历练 回合")));

    // ---- 场景 B：启用目标检测（用户确认后生成） ----
    const checkDet = runGenerator(["--run", good, "--check", "--detect-model", "/sdcard/appSync/yolo/dupo_ui_v6.onnx", "--detect-classes", "badge,nav"]);
    let checkJsonDet = {};
    try { checkJsonDet = JSON.parse(checkDet.stdout); } catch (e) { check("检测场景 --check 输出为 JSON", false, String(e)); }
    check("检测场景 --check 通过且 compiled=6（含 detect-targets.js）",
      checkDet.status === 0 && checkJsonDet.stats && checkJsonDet.stats.compiled === 6 && checkJsonDet.stats.detection.enabled === true,
      checkDet.stdout + checkDet.stderr);

    const outRootB = path.join(tmp, "out-detect");
    const detectRes = runGenerator(["--run", good, "--out", outRootB, "--id", "fixture-detect",
      "--detect-model", "/sdcard/appSync/yolo/dupo_ui_v6.onnx",
      "--detect-classes", "badge,nav", "--detect-min-score", "0.5", "--detect-class-min", "nav=0.6"]);
    check("启用目标检测生成成功（exit 0）", detectRes.status === 0, detectRes.stdout + detectRes.stderr);
    const projectDirB = path.join(outRootB, "projects", "fixture-detect");
    const generatedB = [];
    (function walkB(dir) {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).isDirectory()) walkB(p); else if (p.endsWith(".js")) generatedB.push(p);
      }
    })(projectDirB);
    const badSyntaxB = generatedB.filter((f) => nodeCheck(f).status !== 0);
    check("检测场景生成物 " + generatedB.length + " 个 .js 全部通过 node --check", badSyntaxB.length === 0, badSyntaxB.join(", "));

    const detCfg = JSON.parse(fs.readFileSync(path.join(projectDirB, "config", "detection.json"), "utf8"));
    check("config/detection.json 记录模型/类别/阈值",
      detCfg.enabled === true && detCfg.model === "/sdcard/appSync/yolo/dupo_ui_v6.onnx" &&
      detCfg.classes.join(",") === "badge,nav" && detCfg.minScore === 0.5 && detCfg.classMinScore.nav === 0.6,
      JSON.stringify(detCfg));
    const manifestB = JSON.parse(fs.readFileSync(path.join(projectDirB, "agent", "manifest.json"), "utf8"));
    check("manifest 声明目标检测能力与冒烟任务",
      manifestB.detection.enabled === true && manifestB.detection.task === "detect-targets.js" &&
      manifestB.detection.classes.join(",") === "badge,nav" && String(manifestB.runtime.targetDetectionApi).indexOf("yolodet") >= 0,
      JSON.stringify(manifestB.detection));
    check("main.js 挂载 core/detect.js", fs.readFileSync(path.join(projectDirB, "main.js"), "utf8").indexOf("ctx.detect = require('./core/detect.js')") >= 0);
    check("README 声明目标检测段", fs.readFileSync(path.join(projectDirB, "README.md"), "utf8").indexOf("## 目标检测") >= 0);

    function YoloDetStub() {}
    YoloDetStub.prototype.setModel = function (p) { this.model = p; return { ok: true, coldLoadMs: 30, numClasses: 2 }; };
    YoloDetStub.prototype.prepare = function () { return { ok: true, initMs: 10, coldLoadMs: 30 }; };
    YoloDetStub.prototype.detectEx = function () {
      return { ok: true, width: 1080, height: 1920, count: 3, costMs: 12, inferMs: 9, items: [
        { className: "badge", score: 0.91, center: { x: 10, y: 20 }, bounds: { left: 1, top: 2, right: 3, bottom: 4 } },
        { className: "badge", score: 0.40, center: { x: 11, y: 21 }, bounds: { left: 1, top: 2, right: 3, bottom: 4 } },
        { className: "nav", score: 0.65, center: { x: 12, y: 22 }, bounds: { left: 1, top: 2, right: 3, bottom: 4 } }
      ] };
    };
    const detectMod = require(path.join(projectDirB, "core", "detect.js"));
    function detectCtx() {
      return { detection: detCfg, detect: detectMod, lastShot: { ok: true, path: "stub.png" }, observe: { capture: () => ({ ok: true, path: "stub.png" }) } };
    }
    global.$plugins = undefined;
    const noPlugin = detectMod.detect(detectCtx(), "badge");
    check("插件不可用时返回失败而不是抛穿/降级", noPlugin.ok === false && noPlugin.message.indexOf("PLUGINS_UNAVAILABLE") >= 0, JSON.stringify(noPlugin));
    global.$plugins = { load: () => YoloDetStub };
    const ctxD = detectCtx();
    const badgeRes = detectMod.detect(ctxD, "badge");
    check("检测模块按全局阈值过滤（badge 0.91 过 / 0.40 滤）", badgeRes.ok === true && badgeRes.count === 1 && badgeRes.items[0].score === 0.91, JSON.stringify(badgeRes));
    const navRes = detectMod.detect(ctxD, "nav");
    check("分类阈值覆盖全局阈值（nav=0.6 时 0.65 通过）", navRes.ok === true && navRes.count === 1, JSON.stringify(navRes));
    const missRes = detectMod.detect(ctxD, "entry");
    check("未命中类别返回 0 而不是失败", missRes.ok === true && missRes.count === 0, JSON.stringify(missRes));
    const targetTask = require(path.join(projectDirB, "tasks", "detect-targets.js"));
    const taskOut = targetTask.run({ ctx: ctxD });
    check("detect-targets.js 只读冒烟发 TARGETS_DETECTED",
      taskOut.ok === true && taskOut.markers[0] === "TARGETS_DETECTED" && taskOut.detail.counts.badge === 1 && taskOut.detail.counts.nav === 1,
      JSON.stringify(taskOut));

    const regen = runGenerator(["--run", good, "--out", outRootB, "--id", "fixture-detect", "--force"]);
    check("负例：已启用检测的项目无参数重新生成被拒（防静默丢能力）", regen.status === 1 && regen.stdout.indexOf("--no-detect") >= 0, regen.stdout);
    const regen2 = runGenerator(["--run", good, "--out", outRootB, "--id", "fixture-detect", "--force", "--no-detect"]);
    check("显式 --no-detect 允许关闭检测重新生成", regen2.status === 0, regen2.stdout + regen2.stderr);

    const bad1 = path.join(tmp, "bad1");
    writeFixture(bad1, goodRequest({ requestedScripts: [{ name: "x.js", duty: "d", readiness: "ready" }] }), stateModel(), coordinateSpec());
    let r = runGenerator(["--run", bad1, "--check"]);
    check("负例：ready 无任务卡报 error", r.status === 1 && r.stdout.indexOf("没有 spec 任务卡") >= 0, r.stdout);

    const bad2 = path.join(tmp, "bad2");
    const req2 = goodRequest();
    req2.requestedScripts = req2.requestedScripts.map((s) => {
      if (s.name !== "donate.js") return s;
      const copy = JSON.parse(JSON.stringify(s));
      delete copy.spec.steps[0].readFirst;
      return copy;
    });
    writeFixture(bad2, req2, stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad2, "--check"]);
    check("负例：守卫步骤缺 readFirst 报 error", r.status === 1 && r.stdout.indexOf("readFirst") >= 0, r.stdout);

    const bad3 = path.join(tmp, "bad3");
    const req3 = goodRequest({ verification: { replayRequired: true, evidenceDirectory: "runs/", successMarkers: ["STATE_DETECTED", "DONATE_OK"] } });
    writeFixture(bad3, req3, stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad3, "--check"]);
    check("负例：任务 marker 不在 successMarkers 报 error", r.status === 1 && r.stdout.indexOf("不在 verification.successMarkers") >= 0, r.stdout);

    const bad4 = path.join(tmp, "bad4");
    writeFixture(bad4, goodRequest({ requestedScripts: ["bootstrap.js"] }), stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad4, "--check"]);
    check("负例：requestedScripts 用字符串报 error", r.status === 1 && r.stdout.indexOf("必须是对象") >= 0, r.stdout);
    const bad5 = path.join(tmp, "bad5");
    writeFixture(bad5, goodRequest(), stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad5, "--check", "--detect-model", "/sdcard/appSync/yolo/x.onnx"]);
    check("负例：启用检测但缺 --detect-classes 报 error", r.status === 1 && r.stdout.indexOf("--detect-classes") >= 0, r.stdout);

    const bad6 = path.join(tmp, "bad6");
    writeFixture(bad6, goodRequest(), stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad6, "--check", "--detect-model", "/sdcard/appSync/yolo/x.onnx", "--detect-classes", "badge", "--detect-min-score", "1.5"]);
    check("负例：--detect-min-score 越界报 error", r.status === 1 && r.stdout.indexOf("--detect-min-score") >= 0, r.stdout);

    const bad7 = path.join(tmp, "bad7");
    writeFixture(bad7, goodRequest(), stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad7, "--check", "--detect-model", "C:/tmp/x.onnx", "--detect-classes", "badge"]);
    check("负例：模型路径不是设备端绝对路径报 error", r.status === 1 && r.stdout.indexOf("设备端绝对路径") >= 0, r.stdout);

    const bad8 = path.join(tmp, "bad8");
    writeFixture(bad8, goodRequest(), stateModel(), coordinateSpec());
    r = runGenerator(["--run", bad8, "--check", "--detect-model", "/sdcard/appSync/yolo/x.onnx", "--detect-classes", "badge", "--detect-class-min", "nav=0.5"]);
    check("负例：--detect-class-min 类名不在 --detect-classes 报 error", r.status === 1 && r.stdout.indexOf("不在 --detect-classes") >= 0, r.stdout);
  } finally {
    if (tmp.indexOf(os.tmpdir()) === 0) fs.rmSync(tmp, { recursive: true, force: true });
  }

  const failed = results.filter((x) => !x.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main();