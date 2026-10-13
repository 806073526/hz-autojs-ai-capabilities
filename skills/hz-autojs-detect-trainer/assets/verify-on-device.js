// yolodet 端上验收脚本模板（AutoJs, 经 device_run_script_text 下发）
// 替换 {{MODEL_PATH}} 与 {{SHOT_PATH}} 后使用；结果落盘 JSON + log marker。
// 注意: 脚本正文禁止顶层 return；PRIVILEGED 模式不使用无障碍 API。
var MODEL = "{{MODEL_PATH}}";   // 例: /sdcard/appSync/yolo/dupo_ui_v6.onnx
var SHOT = "{{SHOT_PATH}}";     // 例: /sdcard/appSync/yolo/final_v6.png
var OUT = "/sdcard/appSync/yolo/verify_result.json";

var YoloDet = $plugins.load("com.zjh336.cn.tools.plugin.yolodet");
var det = new YoloDet();
var setRes = det.setModel(MODEL);
var prep = det.prepare();
var t0 = Date.now();
var r = det.detectEx(SHOT);
var wall = Date.now() - t0;

var counts = {};
for (var i = 0; i < r.items.length; i++) {
  var it = r.items[i];
  if (it.className === "nav" && it.score < 0.5) continue;   // 过滤低置信度边缘碎片
  counts[it.className] = (counts[it.className] || 0) + 1;
}
files.write(OUT, JSON.stringify({ setModel: setRes, prepare: prep, wallMs: wall, detect: r }));
console.log("YOLODET_VERIFY " + JSON.stringify(counts)
  + " wall=" + wall + "ms infer=" + r.inferMs + "ms coldLoad=" + setRes.coldLoadMs + "ms");
