# 证据工具

这两个脚本在**宿主侧**运行，直接通过 stdio 驱动插件自带的设备 MCP。它们不替代设备操作技能，只负责把探索过程变成可校验的原始证据。

## capture-evidence.mjs

采集一张当前画面，落盘截图（默认 JPEG q85，可用 `--format png` 保留无损原图）与工具返回元数据，并向 `manifest.json` 追加一条带 sha256 的记录。当前没有只读 OCR / 图像匹配 MCP 入口，本工具不会调用会点击的 `device_tap_target`。

```powershell
node capture-evidence.mjs `
  --device <deviceId> `
  --run <运行目录> `
  --label <短标签> `
  --state <状态ID> `
  --note "<说明>"
```

- `--region x1,y1,x2,y2`：只采集局部区域。
- `--wait-stable`：等待画面稳定后再截。战斗、动画、加载期间不要加。
- `--format png|jpg`：落盘格式，默认 `jpg`。
- `--quality 1-100`：JPEG 质量，默认 `85`。

体积参考（1080×1920 实机样本）：PNG `2.28MB` / JPEG q85 `0.29MB` / JPEG q60 `0.17MB`。默认 q85 肉眼几乎无损、文字清晰、可以直接给模型看图；需要精确取色或无损证据时传 `--format png`。单张超过 1.5MB 时输出里会带 `warning` 字段提示。
- `--no-status`：跳过 `device_status`，少一次设备调用。
- `--mcp-root <dir>`：显式指定插件 mcp 目录；默认从 `CODEX_HOME` 自动探测最新版本。
- `--verify`：只校验，不采集；重算已有记录的 sha256 与字节数。此时只需 `--run`。

输出示例：

```json
{"ok":true,"run":"dupo-cangqiong-20261001","seq":2,"screenshot":"screenshots/002-realm-panel-1-7-prompt.jpg","bytes":297589,"sha256":"3056...","format":"jpg","quality":85,"manifest":"manifest.json"}
```

## import-screenshots.mjs

把此前散落在临时目录里的截图批量归档进同一个证据库。按 sha256 去重，可重复执行。

```powershell
node import-screenshots.mjs --run <运行目录> --source <旧截图目录> --state <默认状态> --note "<说明>"
```

- `--pattern "*.png"`：文件过滤，默认 PNG；导入 JPEG 证据时传 `--pattern "*.jpg"`。导入会保留源文件扩展名。
- 导入记录的 `capturedAt` 取源文件的修改时间，并用 `imported: true` 标记来源。

## export-evidence-index.mjs

把运行目录 `manifest.json` 里的记录导出/合并成可进版本库的文本证据索引（`evidence-index.json`）：只保留状态、时间、sha256 与可复核摘要，截图二进制仍留在本地。历史清单里的旧 `ocr.anchors` 可继续导出为历史 `ocrAnchors`，新采集不再生成该字段。

```powershell
node export-evidence-index.mjs `
  --run <运行目录> `
  --out <索引文件，例如插件仓库的 references/runs/<runId>/evidence-index.json>
```

- 不传 `--out` 时默认写到 `<运行目录>/evidence-index.json`。
- 目标文件已存在时**按 seq 合并**：已有记录保留、缺的追加，不会覆盖历史。
- `--verify`：不导出，只重算每条记录截图的 sha256 与字节数，输出 `{ok,bad,records}`；不一致时以非 0 退出。此时只需 `--run`。

## refresh-agent-brief.mjs

把运行目录的既有产物汇总成"给 AI 读"的两份说明书，供用户在 Codex 里打开该目录对话时直接提问（能做什么 / 现在到哪一步 / 下一步建议 / 可以发什么指令）。只读运行目录，不联网、不访问设备；探索每推进一轮刷新一次。

```powershell
node refresh-agent-brief.mjs --run <运行目录>
```

产出：

- `<运行目录>/AGENTS.md`：AI 入口；写清按四段回答、禁止动作、下一步建议与维护命令。
- `<运行目录>/agent/manifest.json`：机器可读的进度（状态数、已验证锚点数、证据条数、未标定条数）、状态与动作候选、证据覆盖、任务卡交接物与 `nextSteps`。
  - 证据覆盖先按 `state-model.evidenceStateAliases` 把证据标签映射回标准状态再统计；`UNMAPPED` 不参与。
  - `handoff.requestedScripts[]` 带每个脚本的 `readiness` / `hasSpec` / `missingEvidence` / `ready`；`handoff.readyForGeneration` 只有在所有脚本（框架任务除外）都已 ready 且带任务卡时才为 `true`，同时给出 `readyScripts` / `blockedScripts`。
  - 未就绪脚本会进入 `nextSteps`（补任务卡：…），刷新后不得再把它们当成可生成能力。

两份文件都是生成物，不要手改；契约或证据变化后重新执行本脚本。

## 运行目录

在代码仓库内探索时，约定放在仓库根的 `data/exploration/<runId>/`，该路径已被 `.gitignore` 覆盖；没有仓库上下文时，放到宿主指定的探索工作区。两种情况下截图与日志都不进版本库。

```text
data/exploration/<runId>/
  manifest.json
  screenshots/   原始截图（默认 .jpg，--format png 时为 .png）
  meta/          截图工具原始返回
```

版本库只提交由 `manifest.json` 派生出的索引（状态、时间、sha256 与可复核摘要），不提交图片二进制。历史运行目录可能另有旧版 `ocr/`，仅作为历史证据保留。

## 校验

```powershell
node capture-evidence.mjs --run <运行目录> --verify
```

全部一致返回 `bad: 0` 并以退出码 0 结束；有缺失或哈希不一致时返回非 0。
