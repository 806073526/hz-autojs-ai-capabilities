/** core/actions.js —— 模式感知动作封装 + 守卫（生成物，勿手改） */
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
