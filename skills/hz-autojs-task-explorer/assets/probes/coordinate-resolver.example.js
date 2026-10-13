// 多分辨率坐标解析器（设备侧运行）
//
// 作用：把「坐标契约」解析成当前设备的真实像素，避免在任何脚本里写死坐标。
//
// 用法（device_run_script_text + scriptParams）：
//   scriptParams: {
//     spec: { baseline:{width,height}, viewport:{mode}, elements:[...] },  // 见 coordinate-spec.example.json
//     anchors: { "出战": {x:715,y:1675}, ... },                           // 可选：宿主导出的 OCR 锚点中心
//     deviceOverride: { width: 1080, height: 2340 }                       // 可选：只为验证换算，不改变真实设备
//   }
//
// 输出：以 COORD_ 前缀打印每个元素的解析结果，最后打印 COORD_DONE。
// 注意：脚本正文禁止顶层 return；Rhino 环境下只用 ES5 语法。

var p = typeof __toolboxParams === 'object' && __toolboxParams ? __toolboxParams : {};
var spec = p.spec || null;
var anchors = p.anchors || {};

var override = p.deviceOverride || null;
var DW = override && override.width ? Number(override.width) : device.width;
var DH = override && override.height ? Number(override.height) : device.height;
var isSimulated = !!(override && override.width && override.height);

function num(v, d) {
  var n = Number(v);
  return isNaN(n) ? d : n;
}

// ---------- 视口：判定是铺满还是等比留黑边 ----------
function resolveViewport(baseline, mode) {
  var BW = num(baseline.width, DW);
  var BH = num(baseline.height, DH);
  if (mode === 'stretch') {
    return { x: 0, y: 0, width: DW, height: DH, scaleX: DW / BW, scaleY: DH / BH, letterboxed: false };
  }
  var scale = Math.min(DW / BW, DH / BH);
  var viewW = Math.round(BW * scale);
  var viewH = Math.round(BH * scale);
  var viewX = Math.round((DW - viewW) / 2);
  var viewY = Math.round((DH - viewH) / 2);
  var letterboxed = viewW !== DW || viewH !== DH;
  // auto 模式：如果等比结果与铺满几乎一致，就按铺满处理
  if (mode !== 'fit' && !letterboxed) {
    return { x: 0, y: 0, width: DW, height: DH, scaleX: DW / BW, scaleY: DH / BH, letterboxed: false };
  }
  return { x: viewX, y: viewY, width: viewW, height: viewH, scaleX: scale, scaleY: scale, letterboxed: letterboxed };
}

// ---------- 分轴定位 ----------
// 同一个元素的两个轴可能遵循不同规则，这是最容易写错的地方：
//   底部导航栏 → x 按宽度铺开(ratio)，y 贴底固定(bottom)
//   四角按钮   → x 贴边(left/right)，y 贴边(top/bottom)
//   居中弹窗   → x 居中(center)，y 贴底或按比例
// 因此每个元素支持 xMode / yMode 单独覆盖 mode。

function axisSpec(el, axis) {
  var key = axis === 'x' ? 'xMode' : 'yMode';
  return String(el[key] || el.mode || 'edge');
}

function resolveAxisX(el, vp) {
  var mode = axisSpec(el, 'x');
  if (mode === 'ratio') {
    return vp.x + num(el.rx, 0) * vp.width;
  }
  if (mode === 'anchor') {
    return null; // 由 resolveAnchor 统一处理
  }
  var edge = String(el.edge || 'bottom-center');
  if (edge.indexOf('right') >= 0) {
    return vp.x + vp.width - num(el.dx, 0);
  }
  if (edge.indexOf('left') >= 0) {
    return vp.x + num(el.dx, 0);
  }
  return vp.x + vp.width / 2 + num(el.dx, 0);
}

function resolveAxisY(el, vp) {
  var mode = axisSpec(el, 'y');
  if (mode === 'ratio') {
    return vp.y + num(el.ry, 0) * vp.height;
  }
  if (mode === 'anchor') {
    return null;
  }
  var edge = String(el.edge || 'bottom-center');
  if (edge.indexOf('bottom') >= 0) {
    return vp.y + vp.height - num(el.dy, 0);
  }
  if (edge.indexOf('top') >= 0) {
    return vp.y + num(el.dy, 0);
  }
  return vp.y + vp.height / 2 + num(el.dy, 0);
}

function resolveEdge(el, vp) {
  var x = resolveAxisX(el, vp);
  var y = resolveAxisY(el, vp);
  return {
    x: Math.round(x === null ? vp.x : x),
    y: Math.round(y === null ? vp.y : y)
  };
}

function resolveRatio(el, vp) {
  var rx = num(el.rx, 0);
  var ry = num(el.ry, 0);
  return {
    x: Math.round(vp.x + rx * vp.width),
    y: Math.round(vp.y + ry * vp.height)
  };
}

function resolveAnchor(el, anchorsOnly) {
  var text = el.anchor && el.anchor.text ? String(el.anchor.text) : '';
  var hit = text && anchorsOnly[text] ? anchorsOnly[text] : null;
  if (!hit) {
    return null;
  }
  var dx = el.offset && typeof el.offset.dx === 'number' ? el.offset.dx : 0;
  var dy = el.offset && typeof el.offset.dy === 'number' ? el.offset.dy : 0;
  return { x: Math.round(hit.x + dx), y: Math.round(hit.y + dy) };
}

function resolveElement(el, vp, anchorsOnly, baseline) {
  var mode = String(el.mode || 'edge');
  var point = null;
  if (mode === 'anchor') {
    point = resolveAnchor(el, anchorsOnly);
  } else if (mode === 'ratio') {
    point = resolveRatio(el, vp);
  } else {
    point = resolveEdge(el, vp, baseline);
  }
  // 分轴覆盖：anchor 失败后仍可对单轴退化为 edge/ratio
  if (point && mode !== 'anchor') {
    var xMode = axisSpec(el, 'x');
    var yMode = axisSpec(el, 'y');
    if (xMode !== mode || yMode !== mode) {
      point = resolveEdge(el, vp);
    }
  }
  if (!point && el.fallback) {
    point = resolveElement(el.fallback, vp, anchorsOnly, baseline);
    if (point) {
      point.viaFallback = true;
    }
  }
  return point;
}

function clampPoint(pt) {
  return {
    x: Math.max(0, Math.min(DW, Math.round(pt.x))),
    y: Math.max(0, Math.min(DH, Math.round(pt.y)))
  };
}

// ---------- 主流程 ----------
if (!spec || !spec.elements) {
  console.log('COORD_ABORT=缺少 spec.elements');
} else {
  var baseline = spec.baseline || { width: DW, height: DH };
  var vp = resolveViewport(baseline, (spec.viewport && spec.viewport.mode) || 'auto');
  console.log('COORD_DEVICE=' + JSON.stringify({
    w: DW, h: DH,
    aspect: Math.round((DH / DW) * 1000) / 1000,
    simulated: isSimulated
  }));
  console.log('COORD_VIEWPORT=' + JSON.stringify({
    mode: (spec.viewport && spec.viewport.mode) || 'auto',
    letterboxed: vp.letterboxed,
    x: vp.x, y: vp.y, width: vp.width, height: vp.height,
    scaleX: Math.round(vp.scaleX * 100000) / 100000,
    scaleY: Math.round(vp.scaleY * 100000) / 100000
  }));

  for (var i = 0; i < spec.elements.length; i++) {
    var el = spec.elements[i];
    var pt = resolveElement(el, vp, anchors, baseline);
    if (!pt) {
      console.log('COORD_' + el.id + '=UNRESOLVED');
      continue;
    }
    var c = clampPoint(pt);
    console.log('COORD_' + el.id + '=' + JSON.stringify({
      x: c.x, y: c.y,
      mode: el.mode,
      xMode: axisSpec(el, 'x'),
      yMode: axisSpec(el, 'y'),
      viaFallback: pt.viaFallback === true
    }));
  }
  console.log('COORD_DONE');
}

'ok';
