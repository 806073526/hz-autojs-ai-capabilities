/** core/states.js —— 状态表与锚点打分（权重/required/exclusive/负锚点/优先级）（生成物，勿手改） */
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
