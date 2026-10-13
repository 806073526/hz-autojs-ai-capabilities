/** core/guards.js —— 支付/消耗守卫：元素文本、点击落点与数值读数三层判定（生成物，勿手改） */
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
