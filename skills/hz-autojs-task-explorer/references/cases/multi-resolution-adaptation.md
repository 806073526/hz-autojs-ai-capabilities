# 多分辨率适配与坐标契约

- 类型：探索基础设施，跨设备可移植性
- 适用范围：所有固化脚本、候选技能、项目请求
- 证据日期：2026-10-01

## 一、先搞清平台能力边界（已核实）

不要凭猜测设计坐标方案。V5 当前的坐标处理事实如下：

### 1. 图色 / 图像匹配区域支持标准坐标系

`mobile/toolManager.js` 中的 `convertStandardPoint()` / `getStandardCoordinateCoefficient()` 实现了一套标准空间换算：

```text
actualX = round(standardX * targetWidth  / standardWidth)
actualY = round(standardY * targetHeight / standardHeight)
```

启用条件是多参数中的 `coordinateMode = "standard"`，配合：

| 参数 | 含义 |
| --- | --- |
| `standardWidth` / `standardHeight` | 制作坐标时使用的基准分辨率 |
| `offsetX` / `offsetY` | 边角元素的百分比偏移系数（支持负数） |
| `screenDirection` | 横竖屏方向 |

服务端 `AiIntegrationServiceImpl.appendImageCoordinateParams()` 把这组参数透传给**图像类任务**。也就是说：图像匹配的区域坐标可以按标准空间写，由平台负责缩放。

### 2. 点击 / 滑动**不做**自动缩放

`AiIntegrationServiceImpl.submitDeviceControlTap()` 的实际实现是：

```java
let __aiResult = click(x, y);
```

`device_swipe` 同理，直接用 `startX/startY/endX/endY`。**没有任何标准坐标换算**。

### 结论（决定整个方案）

```text
图像区域  → 可以用 coordinateMode=standard，交给平台缩放
点击/滑动 → 必须由脚本/技能在运行时自己算出真实像素
```

因此**坐标不能作为"像素事实"写进案例和脚本**，必须作为"契约"声明，并在运行时解析。

## 二、坐标契约：三种定位模式

禁止裸像素。每个可点元素必须声明为下面三种模式之一。

### 模式 A：anchor（锚点相对定位，首选）

先用可识别元素定位锚点，再用基准空间下的偏移量计算。

```json
{
  "id": "sortie_button",
  "mode": "anchor",
  "anchor": { "by": "ocr", "text": "出战" },
  "offset": { "dx": 0, "dy": 0 },
  "fallback": { "mode": "edge", "edge": "bottom-center", "dx": 0, "dy": 245 }
}
```

```text
actualX = anchorCenterX + dx * scale
actualY = anchorCenterY + dy * scale
```

适用：按钮带文字、列表项、任何 OCR / 图色能稳定识别的元素。
优点：换分辨率、换语言皮肤、列表滚动后都仍然有效。
`偏移量` 的意义是"相对这个锚点往右/往下多少基准像素"，不是绝对坐标。

### 模式 B：edge（边缘锚定）

用于贴边元素：底部导航栏、顶部状态条、四角按钮、弹层角落的关闭按钮。
这类元素在 18:9 / 20:9 长屏上**不会等比缩放**，用 ratio 会整体漂移。

```json
{
  "id": "nav_adventure",
  "mode": "edge",
  "edge": "bottom-right",
  "dx": 122,
  "dy": 43
}
```

解析规则（`DW`/`DH` 为设备实际宽高）：

| edge | actualX | actualY |
| --- | --- | --- |
| `top-left` | `dx` | `dy` |
| `top-center` | `DW/2 + dx` | `dy` |
| `top-right` | `DW - dx` | `dy` |
| `center` | `DW/2 + dx` | `DH/2 + dy` |
| `bottom-left` | `dx` | `DH - dy` |
| `bottom-center` | `DW/2 + dx` | `DH - dy` |
| `bottom-right` | `DW - dx` | `DH - dy` |

斗破苍穹底部六导航就属于这一类：`城市/斗者/纳戒/势力/历练/冒险` 必须用 `bottom-center` + 各自 `dx` 表达，不能写成绝对 y。

### 模式 C：ratio（等比）

仅用于**真正随画布等比缩放**的元素：全屏背景上的场景热点、比例布局的弹窗主体、战斗编队格位。

```json
{
  "id": "formation_slot_4",
  "mode": "ratio",
  "rx": 0.34,
  "ry": 0.34
}
```

```text
actualX = round(rx * DW)
actualY = round(ry * DH)
```

注意：`ratio` 在长屏上会沿 y 方向拉伸。只有确认该元素确实按屏幕比例布局时才用。

### 关键补充：必须支持**分轴定位**

同一个元素的两个轴经常遵循不同规则，这是最容易写错的一点：

| 元素 | x 轴 | y 轴 |
| --- | --- | --- |
| 底部导航栏 | 按宽度铺开（`ratio`） | 贴底固定（`edge: bottom`） |
| 四角按钮 | 贴边（`edge: left/right`） | 贴边（`edge: top/bottom`） |
| 居中弹窗按钮 | 居中（`ratio 0.5` 或 `center`） | 贴底或按比例 |
| 场景热点 | `ratio` | `ratio` |

所以坐标契约除 `mode` 外还支持 `xMode` / `yMode` 单轴覆盖：

```json
{
  "id": "nav_adventure",
  "mode": "edge",
  "edge": "bottom-center",
  "xMode": "ratio",
  "rx": 0.887,
  "yMode": "edge",
  "dy": 43
}
```

只写 `mode: edge` 会把底部导航的 x 也当成"距中心固定偏移"，在宽屏上整排入口会挤在中间；
只写 `mode: ratio` 会把它在长屏上往下推。两个轴必须分开声明。

## 三、画布区域：先判是否有黑边

手游常见两种缩放方式，必须区分：

| 方式 | 表现 | 处理 |
| --- | --- | --- |
| 拉伸铺满 | 画面充满全屏，UI 被拉长 | 用 `edge` + `ratio` 混合，逐元素校准 |
| 等比缩放留黑边 | 上下或左右有黑边 | 先求渲染区 rect，再在 rect 内等比映射 |

等比缩放的映射公式（`BW×BH` 基准，`DW×DH` 设备）：

```text
scale = min(DW / BW, DH / BH)
viewW = round(BW * scale)
viewH = round(BH * scale)
viewX = round((DW - viewW) / 2)
viewY = round((DH - viewH) / 2)
actualX = viewX + round(bx * scale)
actualY = viewY + round(by * scale)
```

判断是否有黑边：取截图四边各 2% 区域做像素方差；接近纯黑说明是黑边。不要用肉眼估算。

## 四、宽高比分组

同一套基准坐标在不同宽高比下的误差不同。固化时按宽高比分桶验证，而不是逐个机型验证：

| 分组 | 宽高比 | 代表分辨率 |
| --- | --- | --- |
| 16:9 | ≈1.78 | 720×1280、1080×1920、1440×2560 |
| 18:9 | ≈2.00 | 1080×2160 |
| 19.5:9+ | ≥2.10 | 1080×2340、1080×2400、1440×3120 |

规则：

- 16:9 组内 `ratio` 通常够用。
- 跨到 18:9 与 19.5:9+ 时，**贴边元素必须切 `edge`**，否则底部导航会明显偏移。
- 每个分组至少要有一台真实设备的验证证据；没有证据的分组只能标成"未验证"，不能声明支持。

## 五、运行时校准流程

固化脚本启动时先做一次校准，再执行动作：

1. 读 `device_status`，取 `screenWidth` / `screenHeight` / `standardWidth` / `standardHeight` / `offsetX` / `offsetY`。
2. 记录宽高比分组；若 `standardWidth/Height` 为空或等于屏幕，说明标准空间是恒等映射。
3. 用 `assets/probes/coordinate-resolver.example.js` 把坐标契约解析成实际像素。
4. 抽 2 到 3 个关键锚点做**残差校验**：用 OCR 或图色定位真实位置，与解析结果比较。
5. 残差超过短边的 1.5% 时，把该元素从 `ratio` 升级为 `anchor` 模式，重新验证。

残差校验是最小可信验证。没有做过残差校验的分辨率，不算支持。

## 五之二、实测数据（2026-10-01）

用 `coordinate-resolver.example.js` 的 `deviceOverride` 做换算验证，基准 1080×1920：

### 正确解析（分轴定位）

| 元素 | 1080×1920 | 1080×2340（19.5:9） | 1440×3120（19.5:9） |
| --- | --- | --- | --- |
| 底部导航-冒险 | `(958,1877)` | `(958,2297)` | `(1277,3077)` |
| 布阵-出战 | `(715,1675)` | `(715,2095)` | `(953,2875)` |
| 左下返回箭头 | `(115,1845)` | `(115,2265)` | `(115,3045)` |

基准分辨率下的解析结果与原始标定值完全一致，说明契约可以无损表达已有坐标。

### 对照：如果偷懒用纯 `ratio`

| 元素 | 1080×2340 漂移 | 1440×3120 漂移 |
| --- | --- | --- |
| 底部导航-冒险 | 10px（0.9%，勉强达标） | 27px（2.5%，超 1.5% 容差） |
| 布阵-出战 | 54px（5.0%，明显超标） | 153px（14.2%，严重超标） |

两个结论：

1. **离锚定边越远，漂移越大。** 底部导航离底边只有 43px，漂移小；出战按钮离底边 245px，漂移大 5 倍以上。
2. **"看起来还行"的纯 `ratio` 在长屏上会失效。** 距离近的元素误差小到可以忽略，容易被误判成"ratio 够用"，然后在流程中段按钮上翻车。

这条数据是"贴边元素禁止用 ratio"这个规则的直接证据，不是经验之谈。

## 六、禁止事项

- 禁止在脚本、候选技能、项目请求里出现没有任何归属说明的裸像素坐标对。
- 禁止用"在某台设备上量过"当作跨分辨率支持证据。
- 禁止把 `ratio` 当作万能解 —— 贴边元素用 ratio 在长屏上必然漂移。
- 禁止只改基准分辨率数字而不重测：基准改变后所有 dx/dy 都要重新标定。
- 禁止在没有 `viewport-fit` 判定结果的情况下假设画面铺满全屏。

## 七、案例改造要求

现有斗破苍穹案例里的绝对坐标（如 `(715,1675)` 出战、`(958,1877)` 底部冒险入口）**只在 1080×1920 基准空间有效**，属于历史证据，不能直接复制进新脚本。

改造要求：

1. 每个元素补一条 `coordinate-spec` 条目，声明 mode 与参数。
2. 保留原绝对坐标作为"基准空间标定值"，用于反算 dx/dy。
3. 新脚本只消费坐标契约，不消费裸像素。

## 待验证

- 斗破苍穹是否是等比缩放留黑边；本轮设备为 1080×1920，与基准同尺寸，无法判定。
- 18:9 与 19.5:9+ 分组下的底部导航残差，尚未实测。
- 横屏游戏（`screenDirection`）的坐标契约尚未覆盖。
