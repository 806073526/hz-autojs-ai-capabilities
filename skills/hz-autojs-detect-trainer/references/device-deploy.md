# 端上部署与验收

## 插件与模型

- 插件包名：`com.zjh336.cn.tools.plugin.yolodet`（AutoJs Plugin SDK 0.2，ORT 1.20，纯 Kotlin，不依赖 OpenCV）。
- 内置 demo 模型 `models/ui_demo/model.onnx`（工具箱 UI，3 类）；**自训练模型不改插件包**，用 `setModel()` 指定设备路径即可。
- 部署路径约定：
  - 模型：`/sdcard/appSync/yolo/<run>.onnx`
  - 类别：`/sdcard/appSync/yolo/classes.json`（JSON 字符串数组，与模型同目录，索引即类别 id）
- 插件来源：官方 V5 APP 默认内置该插件——插件 APK 在 APP 插件目录里，V5 引擎按「设备上已安装的应用 → APP 插件目录」两处查找，`$plugins.load` 直接可用，**不需要安装到设备**；自定义打包时在打包抽屉 / `mobile/project.json` 里勾选 `com.zjh336.cn.tools.plugin.yolodet`（官方包默认已勾选）。
- 验收前在脚本里 `$plugins.load` 实例化一次，确认插件通道可用。
- 插件源码工程：`hz_autojs_toolbox_yolo_plugin`（维护者调试用）。x86_64 模拟器构建：
  ```powershell
  .\gradlew.bat --no-daemon assembleDebug -PextraAbis=x86_64
  ```

## 脚本侧 API（AutoJs）

```js
let YoloDet = $plugins.load("com.zjh336.cn.tools.plugin.yolodet");
let det = new YoloDet();
det.setModel("/sdcard/appSync/yolo/<run>.onnx");  // 同目录 classes.json 自动读取
det.prepare();
let items  = det.detect(image);                   // 明细数组（失败抛错）
let ex     = det.detectEx(image);                 // {ok,width,height,count,costMs,inferMs,items}
let badges = det.findAll(image, "badge");         // 按类名过滤的全部命中
let first  = det.find(image, "badge");            // 第一个命中或 null（不是数组！）
let best   = det.findBest(image);                 // 置信度最高项
```

- `image` 支持：图片路径字符串、Bitmap、`image.getBitmap()` 返回值。
- 返回值坐标已还原到原图像素：`bounds{left,top,right,bottom}` + `center{x,y}`。
- `setOptions({confThreshold, iouThreshold, maxDet, numThreads, inputSize})` 覆盖运行期参数（默认 conf 0.25 / IoU 0.45）。
- 脚本正文禁止顶层 `return`；结果用 log marker 或 `files.write()` 落盘再读。

## 验收流程（模板 `assets/verify-on-device.js`）

1. 推模型与 `classes.json`；
2. 截图到设备（`/sdcard/appSync/yolo/<shot>.png`），再下发验收脚本对**同一张图**推理；
3. 桌面端用同一张图跑 ONNX（letterbox 预处理与插件一致：scale=min(640/w,640/h)，灰 114 补边），比对：**IoU≥0.5 匹配率应为 100%，置信度差 ≤0.05**（实测 23/23 匹配、差 0.000）；
4. 记录性能：x86_64 模拟器实测 冷载 ~30~80ms、单帧 ~120~150ms（预处理+NMS 在内，推理 80~110ms）；
5. 弱项复检：登录页、异常弹窗、无目标面板应报 0 目标；
6. 验收图（框选可视化）存 `<工作目录>\exports\`，结论写 `reports/`。

## 采图注意

- 截图一律**落盘**（设备路径或工作机文件），不把整张 PNG 带回对话；需要看画面时用 MCP 低质量预览（jpg、quality≤45）。
- 批量采图用"点击序列 + 等待 + 截屏"的脚本化流程；每次导航后先确认状态再继续，避免采到过渡帧。
- 同一状态建议至少 2 张（间隔 1~2 秒），便于发现状态漂移与做去重。
