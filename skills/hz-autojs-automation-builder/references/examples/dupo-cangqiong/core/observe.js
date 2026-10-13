/** core/observe.js —— 设备侧截图 + OCR（shell screencap 主链路，toolManager 兜底；不抢占截图通道）（生成物，勿手改） */
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
