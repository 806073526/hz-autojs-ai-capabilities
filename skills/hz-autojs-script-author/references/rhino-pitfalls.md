# V5 脚本交付前自查清单（Rhino / v8）

供 `hz-autojs-script-author` 使用：写完或修改任何在设备上执行的脚本后逐条核对。

验证状态：**已实测** = 本仓库有真实设备/接口证据；**索引确认** = 已在 v8 离线索引（`autojs_docs_search`）核对；**实践建议** = 外部资料或通用实践，尚未在本仓库逐条验证。

## 一、硬门禁（必须全过）

1. **执行模式**：先读 `device_status` 的 `directControlMode`。`PRIVILEGED` 下无障碍 API 是抛错桩（`ACCESSIBILITY_FORBIDDEN_BY_MODE`），一律改用 `__toolboxTap` / `__toolboxLongPress` / `__toolboxSwipe` / `__toolboxScroll` / `__toolboxText` / `__toolboxAction`；不得 `try/catch` 改走兜底。（已实测）
2. **顶层 `return` 禁止**：Rhino 编译期报 `invalid return`，整个脚本不执行；结果用日志 marker 或写文件传出。（已实测）
3. **禁止 `images.requestScreenCapture()`**：会抢占 MediaProjection 通道导致宿主截图黑帧；画面由宿主 `device_screenshot` 提供，脚本用 `images.read(path)` 读取。（已实测）
4. **禁止 `engines.stopAll()` / `engines.stopAllAndToast()`**：会连同当前引擎一起停止，任务悬挂在 RUNNING；改用 `device_stop_script`，或在脚本内遍历 `engines.all()` 并保留当前引擎。（已实测；索引确认两个符号存在）
5. **参数走 `scriptParams`**：脚本内读 `__toolboxParams`；不把参数拼进脚本文本。（已实测）
6. **不内嵌大体积数据**：截图/二进制不进脚本文本；结构化结果用 marker 包住（如 `RESULT_JSON_BEGIN` / `RESULT_JSON_END`），再用 `task_logs` 的 `markerStart` / `markerEnd` 提取。（已实测）

## 二、外部教程防照抄（v8 索引核对）

写任何 API 前先 `autojs_docs_search`；返回 0 条即不存在。以下外部 Auto.js 教程的常见写法**已核对不适用**：

| 外部写法 | 核对结果 | 在 V5 该怎么做 |
| --- | --- | --- |
| UiSelector 族：`text()` / `textContains()` / `textMatches()` / `desc()` / `findOne()` / `visibleToUser()` / `clickable()` 等 | 代表符号逐个查询均为 0 条，离线索引未收录该族符号 | 脚本内不写；节点信息用设备工具（`device_find_node` / `device_layout_dump`），动作走 `__toolbox*` |
| 第一行必须写 `"auto";` / `"ui";`，否则不生效 | V5 脚本由工具箱任务系统调度，现有生成项目与任务脚本都不写这些头 | 不按外部文档的理由加头；执行模式按 `directControlMode` 判定 |
| `http` 请求设置 `timeout` 选项 | `http.request(url[, options])` 的文档选项只有 headers / method / contentType / body | 不要凭外部文档写 timeout；超时/重试逻辑在脚本侧自行实现 |
| `random(min, max)` 是 `[min, max)` 整数 | v8 globals 文档：`random(0, 2)` 可能产生 0、1、2（含端点） | 按 v8 文档使用，不要假设半开区间 |

## 三、数据与存储（索引确认）

- `storages.create(name)`：不同名称的数据相互隔离；官方文档建议名称带域名/邮箱等唯一前缀，避免脚本间冲突。
- `http.get(url[, options, callback])`：存在，返回 `Response`；必须判 `statusCode` 并写异常分支。

## 四、兼容性与风格（实践建议，未逐条实测）

- 避免 `?.`、`??`、`Array.prototype.flat` 等较新语法；保守使用 `var` / `let` 与普通函数。
- 时间戳用 `new Date().getTime()`，不要依赖 `Date.now()`（部分旧版 Rhino 缺失）。
- 等待时间、阈值、区域必须来自证据（探索记录 / 任务卡），不凭手感写死。
- 关键节点打短日志（marker）；日志内容要能被判据消费。
