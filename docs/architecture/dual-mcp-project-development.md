# 双 MCP 与项目开发能力改造设计

## 状态与目标

本设计定义 AI 能力包从单 MCP 扩展为双 MCP 的目标结构。实现状态以源码、构建和运行证据为准，本文件不表示改造已经完成。

设备与项目两条通道之外，2026-09-25 又增加了默认关闭的第三个通道（教程录制作者工具 `hz-autojs-authoring-mcp`），它不在本文的改造范围内，见[插件运行结构](plugin-runtime.md)。

本文同时记录改造前的事实基线和目标契约。事实基线用于避免把已经正确的行为重复改造，或把尚未存在的能力写成已完成；目标契约是后续任务提示词、代码实现和验收证据的共同依据。事实变化后必须回到源码、测试和运行结果复核。

目标是让同一个插件按使用场景提供两条相互独立、可分别启用的工具通道：

- 设备通道：远程观察、操作设备，以及编写和运行临时 AutoJs 脚本。
- 项目通道：本地项目与设备工作目录同步、设备文件管理、项目运行、服务端打包、产物回收和 APK 安装。

设备通道对应已有两项 skill。项目通道对应新增项目开发 skill。用户只做远程设备操作时，不加载项目通道；用户开发 AutoJs 项目时，不要求加载设备操作工具。

## 分层关系

插件、MCP server、MCP tool 和 skill 是四个不同层级：

| 层级 | 职责 | 决定什么 |
| --- | --- | --- |
| 插件包 | 安装、版本、更新、整体启停和分发 | 用户安装和升级的对象 |
| MCP server | 运行时进程、工具注册边界和独立配置 | 当前会话能看到哪一组工具 |
| MCP tool | 单个可执行动作及其 schema | AI 能发起什么请求 |
| skill | 触发场景、操作顺序、输出约束和安全规则 | AI 何时以及如何使用工具 |

插件可以声明多个 MCP server。拆分 MCP 不等于拆分插件，也不等于拆分 Git 仓库、marketplace 条目或安装缓存版本。

禁用 skill 只影响规则加载，不会自动隐藏同一个 MCP server 的工具。因此运行时按需隔离必须同时控制：

1. 目标 skill 的启用状态。
2. 对应 MCP server 的启用状态。
3. 如需在同一 server 内继续收窄工具面，再评估客户端的工具白名单或黑名单能力，并先做实测。

## 目标结构

```text
hz-autojs-ai-capabilities（一个插件）
├── skills/
│   ├── hz-autojs-device-operator
│   ├── hz-autojs-script-author
│   └── hz-autojs-project-developer
└── mcp/
    ├── device-index.js
    └── project-index.js
```

插件 manifest 继续声明整个 `skills/` 和 MCP 配置入口，MCP 配置同时声明两个 server：

```json
{
  "mcpServers": {
    "hz-autojs-device-mcp": {
      "command": "node",
      "args": ["./mcp/dist/device-index.js"],
      "cwd": "."
    },
    "hz-autojs-project-mcp": {
      "command": "node",
      "args": ["./mcp/dist/project-index.js"],
      "cwd": "."
    }
  }
}
```

两个入口复用同一套 TypeScript 核心模块，只注册各自的工具集合。不得复制 V5 客户端、设备访问、设备锁、审计和输出裁剪逻辑。

建议源码边界：

```text
mcp/src/
├── core/
│   ├── config.ts
│   ├── v5Client.ts
│   ├── audit.ts
│   ├── deviceLock.ts
│   └── transport.ts
├── device/
│   ├── index.ts
│   └── tools/
└── project/
    ├── index.ts
    └── tools/
```

入口差异验收必须同时满足：设备入口为现有 17 个设备、控制、统一纯图色、脚本和任务工具（另有 2 个本地 AutoJs 文档索引工具和 3 个知识库只读工具，都不经设备任务链路）；项目入口只注册项目工具，不出现 `device_list`、`device_status`；两个入口不重复注册同一工具，也不通过跨 MCP 调用补足设备上下文。

## 设备 MCP

`hz-autojs-device-mcp` 是远程设备操作通道，保留现有设备、控制、识别、脚本和任务工具的职责，不包含项目同步、设备文件管理或 APK 安装。

工具范围：

| 能力组 | 工具 |
| --- | --- |
| 设备与状态 | `device_list`、`device_status`、`device_screenshot`、`device_logs` |
| 布局与节点 | `device_layout_dump`、`device_find_node`、`device_click_node` |
| 控制 | `device_tap`、`device_swipe`、`device_input_text` |
| 统一纯图色 | `device_tap_target`：创建/验证图片与色组素材，按素材或 OCR 文字点击，并支持最多 20 步连续点击 |
| 脚本 | `device_run_script_text`、`device_run_script_file`、`device_stop_script` |
| 任务 | `task_get`、`task_wait`、`task_logs` |
| 知识库（只读） | `knowledge_search`、`knowledge_read`、`knowledge_assets`，检索官方知识包与客户资料，取图可回传 image 块 |

开发场景同时启用设备 MCP 和项目 MCP。设备上下文统一由设备 MCP 提供，项目 MCP 不复制 `device_list` 或 `device_status`，也不跨 MCP 调用另一个 server 的工具。

## 项目 MCP

`hz-autojs-project-mcp` 是项目开发和部署通道。设备文件操作属于此通道，不向设备 MCP 重复注册。

工具按三层组织：

### 设备文件原语

| 工具 | 作用 | 方向 |
| --- | --- | --- |
| `device_file_list` | 列出设备目录，供同步前检查和同步后验证 | 设备 -> AI |
| `device_file_read_text` | 读取设备文本文件，供入口、配置和版本核对 | 设备 -> AI |
| `device_file_write_text` | 写入单个设备文本文件 | AI -> 设备 |
| `device_file_push` | 将 V5 文件库中的文件或目录下发到设备 | 文件库 -> 设备 |
| `device_file_pull` | 将设备文件或目录拉回 V5 文件库 | 设备 -> 文件库 |
| `device_file_operation` | 对设备执行建目录、删除、重命名、压缩、解压等操作 | AI -> 设备 |

### 项目同步编排

| 工具 | 作用 |
| --- | --- |
| `project_sync_plan` | 按本地文件相对最近一次同步基线的变化计算新增、修改、删除候选和冲突（不检测设备端外部改动），不写设备 |
| `project_sync_push` | 按显式文件清单执行全量或增量同步，并返回逐文件结果 |
| `project_sync_status` | 返回本地根、设备、远端根、基线版本、最近同步结果和失败项 |

### 项目运行与部署

| 工具 | 作用 |
| --- | --- |
| `project_run` | 运行包含 `project.json` 的设备端项目，映射 V5 的 `RUN_PROJECT` |
| `project_dependencies_status` | 检查设备端 Node 项目的依赖状态（`package.json`/`package-lock.json`/`node_modules`/`features.nodejs`），只读 |
| `project_install_dependencies` | 用服务端内置 Node 16 工具链安装依赖并把 `node_modules` 回填设备项目目录，映射 `packaging.project.dependencies.install` |
| `project_build` | 提交服务端打包任务，输入为已上传的公共项目目录或设备端项目目录 |
| `project_apk_install` | 安装 Codex 本地产物、服务端打包产物或设备已有 APK；立即返回 taskId（异步），包名、版本、签名与安装结果以任务结果为准 |
| `project_deploy_status` | 返回同步、运行或安装任务的汇总状态 |
| `project_task_logs` | 读取项目相关任务日志，按需裁剪返回 |

Node 项目（`project.json` 的 `features.nodejs=enabled` 且有 `package.json`）在设备端直接运行时，设备侧只有 Node 运行时、没有 npm。调试链路固定为：`project_sync_push` 同步源码（MCP 默认排除 `node_modules`）→ `project_install_dependencies` 由服务端用打包资源包内置的 Node 16 工具链安装依赖并回填设备项目目录 → `project_run` 运行。V5 Web 端「下发并运行当前项目 / 运行当前项目」会在运行前自动做同一套检查：缺 `node_modules` 时先安装再运行，安装进度在页面提示。

## Skill 映射

| skill | 使用场景 | 对应 MCP |
| --- | --- | --- |
| `hz-autojs-device-operator` | 截图、布局、节点、点击、滑动、输入和页面验证 | `hz-autojs-device-mcp` |
| `hz-autojs-script-author` | 编写、提交、调试和排查临时 AutoJs 脚本 | `hz-autojs-device-mcp` |
| `hz-autojs-project-developer` | 项目目录映射、全量或增量同步、项目运行、服务端打包、产物回收和 APK 安装 | `hz-autojs-project-mcp` |

推荐运行组合：

| 用户场景 | skills | MCP servers |
| --- | --- | --- |
| 只远程操作设备 | `device-operator` | `device MCP` |
| 写脚本操作设备 | `script-author` | `device MCP` |
| 开发并部署项目 | `project-developer` 与按需设备 skill | 两个 MCP 都启用 |
| 边开发边观察设备 | 三者按需组合 | 两个都启用 |

skill 和 MCP 的启停仍由客户端配置分别控制。安装文档必须把它们成对说明，不能暗示启用 skill 会自动启用 MCP。

## 当前实现基线

本节记录改造开始前已核对的源码事实。事实变化后应重新核对，不能把本节当作长期有效的缓存。

| 范围 | 当前基线 | 对改造的影响 |
| --- | --- | --- |
| 设备 MCP 工具数 | 17 个设备/任务工具 + 2 个 AutoJs 文档索引工具 + 3 个知识库只读工具 | 旧分工具视觉入口已收敛为 `device_tap_target`，其余设备工具保持名称、schema 和行为不变 |
| 设备授权时长 | 普通访问令牌为 2 小时，MCP grant 为 30 分钟 | 改为两个系统参数后默认值均为 2 小时；已签发记录保留原 `expiresAt`，只影响后续签发 |
| 设备文件访问 | `file.device.*` 当前只检查 `deviceAccessTokens` | 必须复用共享设备访问判定，并接受同一设备的设备级 MCP grant |
| 项目配置回写 | 公共/Web 来源当前已解析同一 `project.json`，保存时写回该路径并更新 `fileSize/fileHash/fileType/updatedAt` | 不得重复新造脱钩副本；只补齐实际缺失的项目元数据与行为验证 |
| 三来源 APK 安装 | `submitInstallToDevice(jobId, ...)` 当前只覆盖服务端打包产物 | 必须新增统一安装契约，再由内部能力分派三类来源，不能把现有 job 安装接口当三来源实现 |
| 项目映射持久化 | V5 当前没有项目映射记录和最近同步摘要持久化 | 目标契约必须在 V5 增加持久化能力；完整同步基线仍只保存在 MCP 客户端 |

公共文件库与 Web 文件库的项目配置必须分别在真实文件记录和物理路径上验证，不能只根据代码中的公共变量推断两者语义一致。

## 跨节点拓扑与文件中转

Codex、V5 服务端和设备可以位于三台不同机器：

```text
A：Codex 与项目 MCP 进程
B：V5 服务端与文件库
C：Android 设备和 V5 APP
```

现有设备文件任务的方向始终是 B 到 C，或 C 到 B。A 的本地文件不在 V5 文件库中，因此跨节点同步必须先让 A 通过 MCP 访问 V5 的上传接口，把变更文件登记到 B，再触发面向 C 的设备任务。

标准同步链路：

```text
A 本地项目变更
  -> MCP 计算文件清单和摘要
  -> 逐个上传到 B，取得文件库记录
  -> B 向 C 下发 FILE_PUSH
  -> C 回传结果
  -> B 将逐文件结果返回 A
```

回收链路对称：

```text
C 文件或目录
  -> B 执行 FILE_PULL，登记到文件库
  -> MCP 从 B 下载
  -> A 写入本地映射目录
```

下发固定复用 V5 现有「目录下发」能力：文件先经单文件上传接口登记到公共库的项目暂存目录（`mcp-project-sync/<项目>-<指纹>/<批次>`），再用一个 `FILE_PUSH` 任务下发整个目录，任务结算后清理暂存目录。设备端因此只弹一次「目录下发」窗口，逐文件失败清单由该任务回传。

逐文件下发任务（一个文件一个 `FILE_PUSH`）已被实测否决：811 个文件会产生 811 次设备弹窗，并在设备端排队约 13 分钟。该模式不得回退，也不得新增服务端批量接口来形成第二套文件登记、冲突或权限语义。

### 认证与授权链

MCP 到 V5 的调用继续使用 `HZ_V5_AUTH_TOKEN` 作为服务访问凭据。设备访问授权是独立叠加层：

1. 设备未启用访问密码时，服务访问通过后即可执行。
2. 设备启用访问密码时，普通设备访问令牌按签发时读取的系统参数计算有效期。
3. MCP 还可使用设备级短期授权缓存，同样按签发时读取的系统参数计算有效期。
4. V5 的 canonical 执行先接受 `deviceAccessTokens`，再接受同一设备的短期授权 grant。

因此，MCP 不应保存设备明文密码，也不应假定服务访问令牌可以绕过设备授权。首次设备访问仍需经过 V5 的密码校验或既有授权流程，授权窗口内可由 MCP 免重复授权。

授权校验以设备为粒度，不区分发起授权的 `mcpClientId`。设备 MCP 与项目 MCP 可以使用各自的 `mcpClientId` 以便审计区分来源，但同一设备只需完成一次授权，两个 MCP 在授权有效期内通用。

`mcpClientId` 仍参与授权记录的审计字段，记录最近签发来源；它不参与校验，也不形成按客户端隔离的授权窗口。

两个时长均为系统参数：

| 参数 | 默认值 | 单位 | 约束 |
| --- | --- | --- | --- |
| `toolbox.security.device-access.token-ttl-hours` | `2` | 小时 | 正数，最多两位小数，不得小于等于 0 |
| `toolbox.security.device-access.mcp-grant-ttl-hours` | `2` | 小时 | 正数，最多两位小数，不得小于等于 0 |

参数不设上下限，由用户自行输入。保存时校验格式；读取时以签发时刻的参数值计算 `expiresAt`，已签发的令牌和授权不重算、不遍历、不触发变更事件。

设备文件 canonical tools 的设备访问判定必须复用与其他设备工具一致的实现，同时接受 `deviceAccessTokens` 和设备级 MCP grant。当前 `file.device.*` 只检查 `deviceAccessTokens`，缺少 grant 回退，属于本次改造必须修复的不一致。

## 本地项目与同步语义

第一版以本地项目根和设备工作目录的一对一映射为边界。每个映射至少包含：

- 本地根目录绝对路径。
- 设备 ID。
- 设备工作目录绝对路径。
- 同步基线版本和各文件摘要。
- 排除规则。
- 冲突策略。

`project_sync_plan` 只负责计算，不执行写入。`project_sync_push` 接收明确的文件清单，区分：

- `full`：按当前计划推送本地存在的文件和目录。
- `incremental`：只推送 AI 已识别的本地变更清单。
- `mirror_delete`：显式请求后处理远端多余文件，必须单独确认，不能由 `full` 隐式触发。

同步失败时不得把部分成功写成整体成功。结果必须包含成功、跳过、冲突和失败文件清单。

本地项目同步使用源根目录的单份 `.hzignore`，不搜索父目录，也不叠加子目录配置。规则为精确根相对路径，命中路径及其全部子树，区分大小写；空行和 `#` 注释忽略，通配符、否定规则和非法路径记录 warning 后跳过。`.hzignore` 自身始终保留；配置不可读时同步失败。`project_sync_plan` / `project_sync_push` 必须返回传输大小、文件数、排除目录、配置状态和 warnings，使调用方能在上传前识别误选项目；被忽略的旧基线路径不得因 `mirrorDelete` 被删除。默认排除和显式 `excludes` 合并，不能互相覆盖。该配置只影响传输，不改变 `packageExcludePaths` 的打包语义。

MCP 侧负责本地目录扫描、变更清单、上传编排和映射状态。文件库登记、冲突处理、设备访问校验、任务提交、设备下发和审计继续由 V5 文件服务负责。

### 映射与基线存储

- MCP 客户端本地状态目录保存完整同步基线、文件摘要和变更状态；基线属于 Codex 所在机器的工作区事实。
- V5 侧保存映射记录，至少包含本地标识、设备 ID、远端根、映射状态和最近一次同步清单摘要，供审计和跨会话恢复。
- V5 不保存完整文件内容或可直接执行的摘要；多客户端共享同一项目基线不在第一版范围内，不引入分布式锁。
- `project_sync_status` 必须区分本地基线事实和 V5 映射记录；本地基线缺失时可重建计划，但不得把 V5 最近摘要伪造成完整本地基线。
- `project_sync_push` 的逐文件结果必须包含成功、跳过、冲突和失败；部分成功不得回写为整体成功。

## 项目运行、服务端打包与 APK 安装

V5 已存在 `RUN_PROJECT` 任务能力和 `device.script.runFile` canonical tool。项目 MCP 需要提供明确的 `mode=PROJECT` 语义，并确保目标路径位于设备工作目录内。

`project_run` 在执行前必须验证目标目录是项目目录且包含 `project.json`。缺少 `project.json`、路径不存在、路径越界或项目目录不在允许工作根内时，直接失败，不回退为单文件脚本运行。

项目运行校验必须分两层：MCP 在提交前根据设备映射做目标路径、工作根和 `project.json` 预检；V5 canonical 提交必须再次校验项目语义，不能只校验 `scriptPath` 非空。设备端仍以 `RUN_PROJECT` 解析当前项目的 `project.json`，并在入口缺失或解析失败时返回明确失败。

服务端打包复用 V5 现有 `POST /api/app-package/jobs` 能力。当前 `AppPackageBuildRequest.sourceType` 支持：

| sourceType | 输入 | 项目 MCP 使用方式 |
| --- | --- | --- |
| `PUBLIC` | 公共文件库路径 | 默认推荐；本地项目先上传到公共库，再提交打包 |
| `WEB` | Web 文件库路径 | 仅在调用方明确使用 Web 文件库时使用 |
| `DEVICE` | 设备端项目目录 | 设备先完成项目同步，再从设备端目录提交打包 |
| `LOCAL_PATH` | V5 服务端本机路径 | 不作为跨节点 MCP 默认入口；仅限服务端本机调试 |

推荐默认路径为“本地变更上传到公共文件库 -> `sourceType=PUBLIC` 打包 -> 产物安装”。设备端目录打包作为补充路径，适合先同步到设备再验证或调试的场景。两种来源不得混用同一基线；打包结果必须记录 `jobId`、来源类型、来源路径、项目配置摘要、APK 摘要和签名信息。

项目配置真相源按来源目录区分：

| 来源 | project.json 真相源 | 配置读写目标 |
| --- | --- | --- |
| `DEVICE` | 设备端项目目录 | 设备端目录，服务端只做受控缓存 |
| `PUBLIC` | 公共文件库项目目录 | 公共文件库中的同一 `project.json` |
| `WEB` | Web 文件库项目目录 | Web 文件库中的同一 `project.json` |

设备端链路已经按此语义实现：读取时通过设备任务回传到受控缓存解析，保存时先写服务端副本再写回设备。公共文件与 Web 文件链路当前已经解析对应项目目录，并在保存时写回同一 `project.json` 且更新文件记录的 `fileSize/fileHash/fileType/updatedAt`。后续应按实际测试补齐缺失元数据或失败回写，不得新造第二份配置副本。

APK 安装按部署能力设计，不再按“仅人工确认的高风险动作”设计。必须同时支持三类来源：

1. `LOCAL_ARTIFACT`：Codex 在 A 本机构建或已有的 APK，经 MCP 上传到 B 后安装到 C。
2. `SERVER_BUILD`：基于 A 上传到 B 公共库的项目，或同步到 C 的设备端项目，由 B 打包后安装。
3. `DEVICE_APK`：C 设备已有 APK，由 MCP 指定设备路径并触发安装。

三类来源统一立即返回 `taskId`（异步）、覆盖安装状态、来源类型和失败原因；`packageName`、`versionName`、`versionCode` 与签名摘要以下载安装任务的结果为准。实现自动安装前必须完成：

1. 定义统一的安装 canonical 契约和安装任务模式，不复用任意 shell 脚本完成安装。
2. `LOCAL_ARTIFACT` 先上传到 V5 受控文件库，再进入安装链路；`SERVER_BUILD` 以打包 job 产物为输入；`DEVICE_APK` 只接受受控设备路径和设备任务回传元数据。
3. 定义每类来源的路径边界、来源校验、失败原因和 APK 元数据读取方式；MCP 不解析 APK。
4. APK 元数据由受控运行时读取：`DEVICE_APK` 由设备任务回传、服务端校验；`LOCAL_ARTIFACT` 由设备在下载完成后读取校验（无法读取即拒绝安装），元数据随任务结果回传，服务端以任务结果记录审计事实；`SERVER_BUILD` 的包名与版本名称取自构建任务记录。
5. 保留任务审计、设备访问校验和安装结果记录，并确保三类来源都能映射到同一安装事实。
6. 明确自动安装的授权与来源校验，不因为移除风险标签而绕过商业授权或设备边界。

## V5 契约变化

项目 MCP 依赖以下 V5 能力，部分当前已存在但未对外映射：

| 当前 canonical tool | 当前状态 | 目标 |
| --- | --- | --- |
| `file.device.list` | 已实现，`INTERNAL_ONLY` | 映射到 `device_file_list` |
| `file.device.readText` | 已实现，`INTERNAL_ONLY` | 映射到 `device_file_read_text` |
| `file.device.writeText` | 已实现，`INTERNAL_ONLY` | 映射到 `device_file_write_text` |
| `file.device.push` | 已实现，`INTERNAL_ONLY` | 映射到 `device_file_push` |
| `file.device.pull` | 已实现，`INTERNAL_ONLY` | 映射到 `device_file_pull` |
| `file.device.operation` | 已实现，`INTERNAL_ONLY` | 映射到 `device_file_operation` |
| `device.script.runFile` | 已实现，缺项目模式契约 | 增加明确的 `RUN_PROJECT` 语义，并强制校验 `project.json` |
| `device.apk.install` | `RESERVED`、高风险占位 | 改为支持三类来源的统一部署工具；现有 `submitInstallToDevice(jobId, ...)` 只作为 `SERVER_BUILD` 内部能力 |
| `POST /api/app-package/jobs` | 已实现，当前无 MCP 映射 | 增加 `project_build` 打包工具和任务状态读取 |
| 项目映射记录 | 当前无 V5 侧持久化 | 增加映射记录、最近同步摘要和查询契约，不接收客户端完整基线 |
| 设备访问授权记录 | 当前键为 `deviceId + mcpClientId`，MCP grant 默认 30 分钟 | 改为按 `deviceId` 判定；审计保留 `mcpClientId`；两个 TTL 参数默认 2 小时，只在签发时读取 |
| `file.device.*` 设备访问判定 | 当前只检查 `deviceAccessTokens` | 复用共享判定，同时接受 token 和设备级 MCP grant |

项目同步编排本身不是 V5 已有 canonical tool。可在 MCP 侧组合已有能力，但设备推送、文件恢复和审计事实必须继续由 V5 返回。

### 系统参数与授权

两个新增时长参数必须在空库 `data.sql` 和后续不可变 `V...sql` 迁移中同时具备默认值；已有库升级不能依赖首装种子。保存时校验为正数且最多两位小数，不设上下限；读取时值缺失或非法回落到 2 小时；只在新签发 token 或 grant 时读取并计算 `expiresAt`，已签发记录不重算、不遍历、不触发变更事件。

授权校验只按 `deviceId`，`mcpClientId` 只进入最近签发审计。设备 MCP 与项目 MCP 可以携带不同来源标识，但同一设备在授权有效期内共享一次授权窗口。设备文件 canonical tool 的访问判定必须复用其他设备工具使用的共享判定函数，不新建并行逻辑。

## AI 工作台同步补齐

打包能力不只服务外部 MCP。V5 内置 AI 工作台当前同样没有打包工具：工具注册表中只有 `device.apk.install`，且仍为 `RESERVED`；`packaging.apkBuild` 只作为商业授权键和路径拦截键存在，没有对应的 AI canonical tool。服务端 `AppPackageService` 已经具备提交、查询、日志、下载和安装到设备的完整能力，缺口只在 AI 工具层。

因此改造范围包含 V5 侧 AI 工具注册表补齐，使 Web AI 工作台和外部 MCP 共享同一组 canonical tool：

| 新 canonical tool | 对应现有服务 | 建议风险与执行 |
| --- | --- | --- |
| `packaging.build` | `AppPackageService.submitBuild` | `HIGH_RISK` |
| `packaging.build.status` | `getJobStatus` | `READ_ONLY` |
| `packaging.build.logs` | `getJobLogs` | `READ_ONLY`，按行数和字符数裁剪 |
| `packaging.build.download` | `getArtifact` | `READ_ONLY`，返回受控下载路径或元数据，不内嵌大体积二进制 |
| `packaging.build.install` | `submitInstallToDevice` | 部署动作 |
| `packaging.project.toDevice` | `submitProjectArchiveToDevice` | `WRITE` |

外部项目 MCP 的 `project_build` 映射 `packaging.build`，`project_deploy_status` 映射状态与日志工具。这样两端共用一套商业授权（`packaging.apkBuild`）、一套任务事实和一套审计，不产生第二套实现。

`packaging.build` 不应接受自由 shell、任意命令或未受限的 `LOCAL_PATH`。Web 工作台按已有页面上下文限制来源；MCP 侧默认只允许 `PUBLIC`，`DEVICE` 需明确设备访问，`LOCAL_PATH` 仅限服务端本机。

风险等级只决定默认确认行为，不决定自动开关是否可用。以上六个工具以及部署类工具都必须在 AI 工作台设置中支持开启自动执行，不能因为等级较高而禁止勾选自动。用户可以在设置页显式开启，开启后不再生成待确认动作。

自动执行必须同时覆盖前端工具设置、后端风险与确认状态机、canonical 工具执行分派、pending action 和审计，不能只放开前端勾选框。未开启自动时仍保留风险等级与确认行为；开启后不能绕过商业授权、设备访问校验或部署来源边界。

## 待确认动作与就地确认

MCP 调用 canonical tool 时，V5 可能返回 `PENDING_CONFIRMATION`（工具自动开关未开启）。这类结果不是错误终态，MCP 必须把它当作需要用户决定的中断处理，而不是原样抛回给模型。

处置顺序固定为两级：

1. **MCP elicitation（首选）**。客户端在初始化时声明 `elicitation.form` 能力时，MCP 发起一次 form 模式确认，收集单个布尔字段 `approved`。用户确认后由 MCP 调用 `POST /api/ai/pending-actions/{actionId}/confirm`，V5 是执行的唯一权威；用户拒绝时调用 reject 接口并把 `USER_DECLINED` 返回给模型；取消时保持动作待确认并返回 `USER_CANCELLED`。MCP 不执行工具本身，只转发用户决定。
2. **V5 兜底确认页（降级）**。客户端不支持 elicitation、用户取消、或 elicitation 往返失败时，MCP 不弹自己的界面，而是把 V5 返回的 `confirmUrl` 透出为可点击地址。`confirmUrl` 指向独立路由 `/#/tool-confirm`，不属于 AI 工作台会话，也不复用工作台面板；它复用既有设备访问密码逻辑完成校验后再向 V5 发起确认。

设备访问未满足时**不发起 elicitation**：密码必须在 V5 页面输入，先确认也完不成，只会让用户白点一次。V5 在待确认动作响应中返回 `deviceAccessSatisfied`；MCP 在它为 `false` 时返回 `DEVICE_ACCESS_REQUIRED`，并**优先透出 `authorizationUrl`（指向 `/#/devices`）**而不是 `confirmUrl`。`/#/devices` 是唯一能完成密码校验并写入设备级 MCP 授权的入口；`/#/tool-confirm` 只拿一次性设备 token，用户在那里会看到确认按钮但无法完成设备授权，因此不得用它替代设备授权入口。V5 的两条分支（`WAITING_DEVICE_ACCESS` 与 `PENDING_CONFIRMATION`）都必须带 `authorizationUrl`，MCP 侧同时兼容 `errorData` 与 `pendingAction` 两种承载位置。

**客户端权限档位与确认通道**：Codex Desktop 的权限选择器决定 elicitation 能否到达用户。选"请求批准"时 elicitation 正常弹出，MCP 按用户决定调用 V5 confirm/reject；选"完全访问"时客户端把 elicitation 直接短路成 `decline`（实测 form 与 url 两种模式均在数毫秒内返回，前端不产生任何确认事件），这是"别再问我"的预授权语义，不是用户拒绝。MCP 以 elicitation 往返耗时区分两者：低于 `HZ_MCP_ELICITATION_AUTO_DECLINE_MS`（默认 1000ms）的 `decline` 判定为客户端预授权，调用 V5 confirm 自动执行并返回 `autoApprovedByClientPolicy: true`；真人拒绝必然远慢于该阈值，仍按 `USER_DECLINED` 处理。`HZ_MCP_AUTO_APPROVE_ON_PREAUTHORIZATION=false` 可让这类动作退回 V5 兜底确认页保持人工确认，`HZ_MCP_ENABLE_ELICITATION=false` 则完全跳过 elicitation。

注意 `config.toml` 的 `approval_policy` 不是 Desktop 的实际权限来源：Desktop 在 `.codex-global-state.json` 的 `permission-selection-by-host-id` / `heartbeat-thread-permissions-by-id` 中保存每个会话的权限快照，会话启动时以该快照为准，覆盖配置文件。已确认 `permissions.mcp_elicitations` 无法在 `approval_policy=never` 下放开 elicitation，故不采用该配置作为解决方案。

**三条路径必须严格区分**（互不替代）：①设备访问密码未满足 → 只给 `authorizationUrl`（`/#/devices`），必须先完成密码校验，这一层任何时候都不能省；②设备访问已满足 + 客户端要求审批 → elicitation 弹出确认卡，按用户选择 confirm/reject；③设备访问已满足 + 客户端"完全访问" → elicitation 被客户端短路成 decline，按预授权自动 confirm 执行，不弹链接、不判拒绝。

**兜底通道 `mcp-call.mjs` 的确认策略**：它自己扮演 MCP 客户端，`HZ_MCP_CALL_CONFIRM_POLICY=auto`（默认）声明 `elicitation.form` 能力并自动同意，等价 Desktop 的"完全访问"；设为 `link` 则不声明该能力，遇待确认动作直接返回兜底确认页地址。不能无条件声明 elicitation：否则客户端对"快速 decline"的预授权判定会把需要人工审批的动作误自动执行。

`confirmUrl` 与既有 `authorizationUrl` 语义不同，不得混用：

| 字段 | 出现位置 | 语义 |
| --- | --- | --- |
| `authorizationUrl` | `DEVICE_ACCESS_REQUIRED` 的结构化错误 | 设备访问密码尚未满足，去 `/#/devices` 完成授权 |
| `confirmUrl` | `PENDING_CONFIRMATION` 的待确认动作 | 设备访问已满足或无需密码，去 `/#/tool-confirm` 决定是否执行 |

`confirmUrl` 由 V5 生成相对路径，MCP 按 `HZ_V5_PUBLIC_URL`（缺省回落到 `HZ_V5_BASE_URL`）转成绝对地址后再返回给模型；MCP 不自行拼接 URL，也不解析或改写其中参数。

设备访问凭证始终由 V5 校验：确认路径同时接受设备访问 token、设备访问密码和设备级 MCP grant。MCP 不保存设备密码，也不把密码写入 MCP 配置或长期缓存。

地址必须以可点击链接形式交给用户：`authorizationUrl` 与 `confirmUrl` 在 MCP 返回的 `message` 里内嵌 Markdown 链接（`[打开 V5 确认页](URL)`），skill 同时要求模型转达时不得放进代码块或行内代码。代码块不会渲染成链接，用户只能手动复制，等于把"可确认"降级成"需要自己拼地址"。

处置实现位于 `mcp/src/core/pendingConfirmation.ts`，设备 MCP 与项目 MCP 共用，不允许任何入口自行实现第二套确认逻辑。项目 MCP 的同步、运行和部署流程会在内部调用多个 canonical tool（读取 `project.json`、入口脚本、设备推送、镜像删除等），这些内部调用同样必须经过统一处置：否则用户会在同步或运行中途遇到"动作未执行但也没看到确认入口"的静默失败。内部调用发生在一次 MCP 工具调用之内，因此 elicitation 的展示对象仍是发起该工具调用的用户，不需要额外会话。


## 改造阶段

| 阶段 | 内容 | 完成证据 |
| --- | --- | --- |
| 1 | 抽取 `core`，建立 `device-index` 和 `project-index` 两个入口，保持现有设备工具行为不变 | typecheck、测试、构建、两入口工具列表对比 |
| 2 | 项目 MCP 桥接六个设备文件 canonical tools | 单文件读写、目录列表、push、pull、operation 的最小真实调用 |
| 3 | 增加项目同步计划、增量清单和状态契约 | 全量、增量、冲突、失败和部分成功用例 |
| 4 | 增加项目运行和部署状态 | `RUN_PROJECT`、入口脚本、任务日志和失败原因 |
| 5 | 接入 `project_build` 服务端打包，覆盖公共库和设备端两种来源 | 打包任务、产物摘要、失败日志和来源一致性证据 |
| 6 | 将 APK 安装改为部署工具并支持三类来源和自动安装 | 本地 APK、服务端产物、设备已有 APK、覆盖安装和失败回滚证据 |
| 7 | 增加项目开发 skill 和双 MCP 安装说明 | 新会话 skills 列表、两个 MCP 工具列表和按需启停验证 |

阶段 2 至 6 的真实调用必须分别记录证据，不能把一次串行尝试当作所有阶段都已验证。V5、设备、打包运行时或签名环境不具备时，应停在对应层并明确记录未验证项；源码测试、构建、插件安装、缓存更新和实时工具可用必须分别记录状态。

## 风险与约束

- 一个插件声明两个 MCP 后，版本仍然是同一个插件版本；两个 MCP 的工具契约必须同时测试。
- MCP server 独立启停不等于工具权限独立。高风险或高风险来源动作仍必须经过 V5 授权、设备访问和审计。
- 设备文件操作不能同时在两个 MCP 注册，否则会出现重复工具和边界漂移。
- 项目同步必须显式区分新增、覆盖和删除。默认不得删除远端文件。
- `device_file_operation` 的删除、重命名和解压必须可追踪，不能作为同步失败的静默修复。
- 本地目录扫描、完整同步基线和上传编排属于 MCP 侧；V5 只保存映射记录与最近同步摘要，文件库和设备真实状态仍以 V5 任务结果为准。
- Codex、Claude Code、ZCode、WorkBuddy 和未来客户端的 MCP 配置格式不同，需要分别验证多 server 声明。
- 当前缓存版本不能被直接编辑。源码、构建、安装、注册、缓存和实时工具列表必须逐层验收。
- A 与 B 跨节点时，`LOCAL_PATH` 指向 B 的服务端路径，不能用于表达 A 的本地项目；A 的本地文件必须经上传接口登记到 B。
- 设备访问密码不得写入 MCP 配置或长期缓存；只允许使用既有设备访问令牌和 MCP 短期 grant。

## 定稿决策

### 同步基线与映射

客户端本地状态目录保存同步基线，包括文件摘要和变更状态。V5 侧保存映射记录，包括本地标识、设备 ID、远端根和最近一次同步清单摘要，用于审计和跨会话恢复。

文件摘要计算发生在 Codex 所在机器，基线属于本地工作区事实。V5 不保存完整文件内容或可执行摘要。多客户端共享同一项目基线不在第一版范围内，不引入分布式锁。

### 打包项目配置来源

每个来源都以对应目录中的 `project.json` 为唯一真相源。`DEVICE` 由设备端文件作为真相源，`PUBLIC` 和 `WEB` 写回对应文件库中的同一 `project.json`，并同步更新文件记录的摘要与元数据，不再另存脱钩副本。具体行为见[项目运行、服务端打包与 APK 安装](#项目运行服务端打包与-apk-安装)。

### APK 签名与版本校验

V5 服务端为唯一校验权威，设备端只执行安装并回报结果。

| 来源 | 校验执行者 | 校验内容 |
| --- | --- | --- |
| `LOCAL_ARTIFACT` | V5 服务端 | 上传后读取包名、版本、签名摘要，与目标设备已安装版本比较 |
| `SERVER_BUILD` | V5 服务端 | 打包完成后校验产物签名，与打包配置中的签名档案比对 |
| `DEVICE_APK` | V5 服务端通过设备任务读取，设备端执行 | 读取包名、版本、签名摘要；无法读取时拒绝自动安装 |

MCP 不解析 APK。APK 解析涉及二进制格式、签名方案差异（v1/v2/v3）和覆盖安装兼容性，服务端已有打包和签名链路。MCP 只传递来源、目标设备和期望校验结果。

### 设备授权粒度与 MCP 标识

设备授权以设备为粒度。授权校验不区分 `mcpClientId`；设备 MCP 与项目 MCP 可以使用不同的 `mcpClientId` 仅用于审计区分来源，同一设备只需授权一次即可在两个 MCP 通用。

授权键从 `deviceId + mcpClientId` 改为 `deviceId`。审计记录保留发起时的 `mcpClientId`。设备授权存储是内存结构，重启即清空，不需要历史键兼容或迁移。

### 授权时长系统参数

定稿：两个时长改为系统参数，默认值统一为 2 小时，单位为小时，正数且最多两位小数，不设上下限。参数名、读取时机和回退规则见[认证与授权链](#认证与授权链)。

### 设备文件工具注册边界

项目 MCP 的设备文件工具全部注册，不按子场景拆分工具白名单。

### 开发场景的 MCP 启用方式

开发场景同时启用设备 MCP 和项目 MCP。项目 MCP 不复制设备只读工具，设备上下文统一由设备 MCP 提供。

### 上传与下发形态

定稿：上传复用 V5 现有单文件上传接口，目标改为公共库里的项目暂存目录；下发把整批合成一个 `FILE_PUSH` 任务（V5 把来源目录展开成 entries 清单），设备端只弹一次「目录下发」窗口，任务结算后清理暂存目录。

逐文件下发任务已实测否决（811 个文件 → 811 次设备弹窗、约 13 分钟排队），不得回退。不新增服务端批量上传接口，也不得形成第二套文件登记语义。设备端按 `SKIP_SAME_HASH` 跳过内容一致的文件，整批只落盘真正变化的文件。

### APK 来源支持

同时支持 `LOCAL_ARTIFACT`、`SERVER_BUILD`、`DEVICE_APK` 三类来源，统一返回包名、版本、版本号、签名摘要、覆盖安装状态、来源类型和失败原因。

### 简单实现原则

以上决策均采用最小实现：授权键直接替换、不保留兼容层；授权值不回溯重算、不遍历存量记录；设备文件访问判定直接复用现成的共享判定函数，不新建并行逻辑；时长参数仅增加保存校验、读取默认值和一次签发时读取。

### 项目运行校验层级

`project_run` 由 MCP 做预检，V5 canonical 提交再次校验，设备端按 `RUN_PROJECT` 执行项目解析。任何一层失败都不得回退为单文件脚本。

### 三来源安装契约

外部项目 MCP、V5 内置 AI 工作台和未来客户端统一使用一个安装 canonical 契约，内部按 `LOCAL_ARTIFACT`、`SERVER_BUILD`、`DEVICE_APK` 分派。现有 `submitInstallToDevice(jobId, ...)` 只保留为 `SERVER_BUILD` 的服务端产物安装能力；不得把 job 安装接口扩展成三来源的隐式兼容层。

### 映射持久化边界

MCP 保存完整同步基线；V5 保存映射记录和最近同步摘要。V5 记录是审计和恢复辅助，不是完整客户端基线。第一版不增加服务端批量上传接口、跨客户端共享基线或分布式锁。

## 验收边界

本设计只描述目标结构和改造顺序。任一阶段完成前，必须分别验证源码、构建、插件安装、MCP 注册、缓存版本、新会话 skills 和实时 tools/list。只更新 skill 或只修改 manifest 不得写成 MCP 已按需隔离。

插件仓库至少执行 `npm run typecheck`、`npm test`、`npm run build`；V5 侧执行与改动范围匹配的 Maven 测试和前端 `node --test`，并覆盖空库初始化与已有库升级。数据库迁移必须保留已发布脚本且严格递增，两个新参数需要同时验证首装和升级。

两个仓库分别提交。项目 MCP 的设备文件工具必须全部注册；至少完成设备文件工具、项目同步、`project_run`、`project_build` 和 APK 安装的独立最小真实证据，未执行项明确记录为未验证。
