/** core/bootstrap.js —— 环境自检：契约、分辨率分组、缩放一致性、截图/OCR 与锚点覆盖（生成物，勿手改） */
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
