# Landscape Test 不稳定应用案例

- 类型：不稳定应用与设备恢复反例
- 包名：`com.zjh336.test.landscape`
- 应用名：`Landscape Test`

## 发生过程

1. 通过设备 MCP 启动 `Landscape Test`。
2. `device_layout_dump` 超时，任务没有进入终态。
3. 设备 MCP 截图连续超时。
4. 插件兜底通道截图也超时。
5. ADB `screencap` 和 `input` 命令卡住。
6. V5 脚本进程和游戏进程出现僵尸状态，V5 设备列表离线。

## 恢复步骤

1. 确认雷电模拟器安装目录和实例列表。
2. 使用 `ldconsole.exe reboot --index 0` 重启模拟器实例。
3. 等待 ADB 恢复为 `device`。
4. 重新启动 `com.zjh.toolbox.v5`。
5. 轮询设备列表，确认 V5 重新上线。
6. 再次确认 `directControlMode` 仍为预期值。

## 结论

- 该应用不应作为正式探索目标。
- 探索技能必须包含“不稳定应用”画像和整机恢复路径。
- 设备离线后不能继续执行点击；必须先确认 V5 与设备均在线。
- 该案例是反例，但也是恢复流程的正例证据。
