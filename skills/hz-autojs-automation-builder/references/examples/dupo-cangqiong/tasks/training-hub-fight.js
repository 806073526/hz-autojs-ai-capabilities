/** tasks/training-hub-fight.js —— 由任务卡编译，勿手改（见 config/request.json → requestedScripts[].spec） */
var SPEC = {"startStates":["MAIN_CITY","TRAINING_HUB","TRAINING_STAGE_LIST"],"steps":[{"op":"tap","element":"nav_lilian","guard":false,"settleMs":1400},{"op":"tap","element":"training_hub_entry","guard":false,"settleMs":1600},{"op":"tap","element":"training_tab_douqi","guard":false,"settleMs":1200},{"op":"read","guard":false},{"op":"tap","element":"training_sweep","guard":true,"readFirst":true,"guardAction":"扫荡","settleMs":2000}],"readings":[{"key":"freeSweepLeft","pattern":"扫荡[^0-9]{0,3}(\\d+)","when":"before"}],"verify":[{"type":"anchor","text":"喜获"}],"markers":["STAGE_CLEARED"],"visitsStates":["MAIN_CITY","TRAINING_HUB","TRAINING_STAGE_LIST","REWARD_QUEUE"],"fromStates":["MAIN_CITY","ADVENTURE_CHAPTER","IDLE_PANEL","HERO_LIST","HERO_DETAIL","REALM_PANEL","TRAINING_HUB","TRAINING_STAGE_LIST","NAJIE_HOME","XUEJING_PANEL","FACTION_HOME","FACTION_DONATE","STAGE_LIST","FORMATION","BATTLE_RESULT","AUTO_CHALLENGE","REWARD_QUEUE","REWARD_POPUP","MILESTONE_PANEL","QUICK_TRAIN","LEVEL_GATE"],"navSteps":[{"op":"tap","element":"popup_dismiss_zone","guard":false,"settleMs":900},{"op":"back","ms":1300},{"op":"tap","element":"dialog_stay","guard":false,"settleMs":1000},{"op":"tap","element":"back_arrow","guard":false,"settleMs":1300},{"op":"tap","element":"nav_city","guard":false,"settleMs":1400}],"maxNavAttempts":3};

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
module.exports = { name: "training-hub-fight.js", states: SPEC.startStates || [], spec: SPEC, readOnly: false, readiness: 'ready', run: run, verify: verify };
