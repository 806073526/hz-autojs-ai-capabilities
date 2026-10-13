# Android 设置节点树案例

- 类型：节点型系统应用
- 包名：`com.android.settings`
- 屏幕：1080×1920
- 布局来源：`device_layout_dump`

## 验证结果

`device_layout_dump` 在 Android 设置上成功返回 53 个节点，包含 `text`、`id`、`className`、`bounds`、`center`、`clickable` 和 `scrollable`。

## 可复用节点

| 用途 | 字段 |
| --- | --- |
| 页面容器 | `com.android.settings:id/content_frame` |
| 搜索入口 | `com.android.settings:id/search_action_bar` |
| 设置列表 | `com.android.settings:id/dashboard_container` |
| 条目容器 | `com.android.settings:id/dashboard_tile` |
| 条目标题 | `android:id/title` |
| 条目摘要 | `android:id/summary` |

## 探索策略

- 先用 `device_find_node` 按 `id` 或 `text` 查找节点。
- 条目容器通常是可点击节点，标题文本本身不一定可点击。
- 节点树可用时，不用坐标点击；需要点击时选择最近的 clickable 祖先。
- 页面滚动后重新读取布局，避免复用滚动前 bounds。
- 该案例证明探索技能必须同时支持节点型和画布型，不能只依赖 OCR。

## 对照价值

Android 设置属于“节点型”，斗破苍穹属于“画布型”。同一套探索技能必须根据画像切换观察与动作策略，而不是把一种方法套到所有应用。
