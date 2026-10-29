# 探索证据库

探索的产出不能只有结论。本案例规定原始截图与工具返回怎么落盘、怎么索引、怎么校验，以及哪些内容允许进入版本库。

## 目录结构

```text
data/exploration/<runId>/
  manifest.json          唯一索引，每条记录带 sha256 与字节数
  screenshots/NNN-<label>.jpg（默认；`--format png` 时为 .png）
  meta/NNN-<label>.json  device_screenshot 工具原始返回
```

`data/` 已被根 `.gitignore` 覆盖，所以截图和日志天然不进版本库。需要长期留存的只有从清单派生的文本索引。

## 三条硬规则

1. 关键状态必须有当次截图，不允许事后补描述。
2. 每条截图记录写入 `sha256` 与字节数，整理后仍可证明文件未被替换。
3. 图片、日志、临时截图不进版本库；版本库只提交状态、时间、哈希和可复核的文本摘要。

这条边界同时满足两个约束：探索需要原始数据可复查，仓库又禁止提交运行数据与截图。

## 工具

- `assets/tools/capture-evidence.mjs`：采一张当前画面，落盘截图（默认 JPEG q85，`--format png` 可保留无损原图）与工具元数据，并追加清单记录。
- `assets/tools/import-screenshots.mjs`：把此前散落在临时目录的截图批量归档，按 sha256 去重。
- `capture-evidence.mjs --verify`：重算已有记录的 sha256 与字节数。

## 实测结果（2026-10-01）

斗破苍穹首次探索的 31 张历史截图从 `.tmp-explore/` 归档，加上 2 张实时采集，共 33 条记录，约 9.8 MB。

```text
{"run":"dupo-cangqiong-20261001","ok":33,"bad":0,"records":33}
```

历史实时采集样本（`REALM_PANEL`，境界面板引导前往 1-7；其中的 `ocr` 字段只代表当时的旧工具结果）：

```text
{"ok":true,"seq":2,"screenshot":"screenshots/002-realm-panel-1-7-prompt.png",
 "bytes":2163845,"sha256":"30567c91ae07e83c1cda3422877b369df397d36be7314b14ac1e49578f4bd0b2",
 "ocr":["斗气:12318","继续冒险提升实力吧","冒险通关1-7","前往"]}
```

## 实施中踩到的坑

- **设备侧路径不是宿主路径**。`device_screenshot` 返回的 `path` 指向设备私有目录；宿主必须用 `includePreview` 的图片块解码落盘，否则 `outputPath` 填宿主路径也不会产生文件。
- **元数据文本要先解析再取值**。`device_status`、`device_screenshot` 的返回是包在文本块里的 JSON 字符串，直接按对象取字段会得到空值。采集工具先 `JSON.parse` 文本块，再取 `data.device` 或 `data.resultPayload`。
- **清单的设备信息来自第二次采集才补齐**。第一次记录只带截图；汇总字段在后续采集时写入。若要单条记录也完整，采集时不要加 `--no-status`。
- **不要用删除来重置运行目录**。安全策略会拦截递归删除；换用新的 `<runId>`，或用导入工具按哈希去重后重新采集。
- **战斗与动画期间不要加 `--wait-stable`**。等待稳定会超时；这类画面用普通截图配合显式等待或锚点轮询。

## 与探索闭环的关系

证据库服务闭环第 7 步（证据固化）和第 8 步（复跑验证）：

- 固化：每个关键状态至少一张截图；坐标或视觉素材标定必须有来源图。新证据不依赖只读 OCR，需要 OCR 点击时由 `device_tap_target` 的动作结果另记。
- 复跑：复跑结果作为新记录追加，与旧记录按 `label` / `state` 对比截图和动作结果，而不是覆盖历史。

无法复跑的案例要在 `findings.md` 里显式标成缺口，不能靠一张截图就声明流程可用。
