/** core/machine.js —— 状态判定 + 单步执行 + 任务判据（生成物，勿手改） */
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
