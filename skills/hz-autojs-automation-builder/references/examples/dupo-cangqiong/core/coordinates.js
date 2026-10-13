/** core/coordinates.js —— 坐标契约解析（anchor / edge / ratio），不落裸像素（生成物，勿手改） */
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
