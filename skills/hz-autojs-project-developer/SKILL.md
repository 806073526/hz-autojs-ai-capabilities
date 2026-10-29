---
name: hz-autojs-project-developer
description: 面向华仔 AutoJs 工具箱 V5 的项目开发与部署：项目目录映射、全量或增量同步、项目运行、服务端打包、产物回收、APK 安装和结果读取。当用户要求同步项目到设备、运行设备端项目、打包 APK、安装 APK 或读取项目部署状态时使用本 skill，并启用 hz-autojs-project-mcp。
---

# 项目开发 MCP

本 skill 对应 `hz-autojs-project-mcp`，覆盖项目映射、同步、运行、打包、安装和结果读取。

涉及目标设备的任务 [手机本地操作记忆](../hz-autojs-device-memory/SKILL.md) 只在重复失败、复用同版本同页面经验或核对已知反例时按需读取；稳定执行与项目同步不得依赖记忆，排障得到已验证的方法后再主动写回，并保留手机记忆目录。

## 启用方式

skill 与 MCP 是两个独立开关：启用本 skill 不会自动启用 MCP。请同时在客户端启用
`hz-autojs-project-mcp`；需要设备截图、布局或控制时再启用 `hz-autojs-device-mcp`。
启用位置因客户端而异：先把 server 写进客户端自己的 MCP 注册位置（表见分发包根目录 `README.md`
的「各客户端 MCP 注册位置」，源码仓库内为 `packaging/USER-GUIDE.md`），再在客户端里启用并在新会话
核对原生 `mcp__hz-autojs-project-mcp__*` 工具出现——MCP 进程能启动不等于已被客户端注册。
项目 MCP 不提供 `device_list` 和 `device_status`，设备上下文统一由设备 MCP 提供。

## 工具边界

- 设备文件原语：`device_file_list`、`device_file_read_text`、`device_file_write_text`、`device_file_push`、`device_file_pull`、`device_file_operation`。
  `device_file_list` 默认只回 40 项并附 `totalCount`/`truncated`/`nextOffset`；定位目录用 `directoriesOnly: true` 或 `nameContains`，不要整目录拉回。
  `device_file_read_text` 单次最多回 12000 字符并带 `truncated`/`originalChars`；需要更多内容时按区间或换用更精确的读取方式，不要反复全量读取。
- 同步编排：`project_sync_plan`、`project_sync_push`、`project_sync_status`。
- 运行与部署：`project_run`、`project_dependencies_status`、`project_install_dependencies`、`project_build`、`project_apk_install`、`project_deploy_status`、`project_task_logs`。

## 关键约束

- 设备访问按设备授权：设备访问 token 与同设备 MCP grant 都可用，两个 MCP 共享同一授权窗口；不要保存设备明文密码。
- 同步默认不删除远端文件；`mirror_delete` 必须显式请求，且不能由 `full` 隐式触发。
- `project_sync_plan` / `project_sync_push` 只读取 `localRoot` 根目录的 `.hzignore`，不搜索父目录或子目录。每行是精确根相对路径，命中路径及全部子树，区分大小写，支持空行和 `#` 注释；通配符、否定规则和非法路径记录 warning 后跳过。`.hzignore` 自身始终保留，配置不可读时停止同步。
- `.hzignore` 命中的旧基线路径不进入删除候选，`mirrorDelete` 不删除对应远端文件；默认排除与显式 `excludes` 始终合并。同步结果必须回传 `transferSummary` 的 `totalBytes`、`fileCount`、`excludedDirectories`、`configFound` 和 `warnings`，用于先判断是否误选了过大项目。
- 逐文件返回成功、跳过、冲突和失败；部分成功不得写成整体成功。
- 一批同步只提交一个设备任务（V5「目录下发」，设备端只弹一次窗口）。不得改回「一个文件一个任务」：设备端会对每个文件弹一次「文件下发」窗口，实测 811 个文件弹 811 次、排队约 13 分钟。
- 完整同步基线只在 MCP 客户端本地状态目录；V5 只保存映射记录、远端根和最近同步摘要。
- 大文件（超过 `HZ_MCP_UPLOAD_RESUMABLE_THRESHOLD_BYTES`，默认 16MB）由 `project_sync_push` 分片上传到 V5 公共库暂存目录；上传类请求用独立预算 `HZ_MCP_UPLOAD_REQUEST_TIMEOUT_MS`（默认 600 秒），不受普通请求上限约束。中途失败或调用被打断后，重跑**同一批清单**会按「路径 + 大小 + SHA-256」派生的会话从已完成分片继续，不要为绕开超时改用分小批次或手工切文件。
- `project_run` 只映射 `RUN_PROJECT`。目标必须是包含 `project.json` 的设备端项目目录，且位于允许工作根内；失败时不得回退为单文件脚本运行。
- `project_build` 默认走 `PUBLIC`：先把本地项目上传到 V5 公共文件库，再提交打包，最后把产物安装到设备。`DEVICE` 来源需要明确的设备访问，用于设备端项目调试。`LOCAL_PATH` 是 V5 服务端本机路径，不作为默认入口。
- `project_build` 的能力开关遵循**「未显式传入即沿用项目 project.json」**：不传不覆盖项目声明，显式传入只对本次打包生效且不回写 `project.json`。禁止用裸 HTTP 直接 POST `/api/app-package/jobs` 绕过本工具——那会绕过「按 project.json 解析」的语义，历史上正是这样把图色模块关掉、打出缺 `libopencv_java4.so` 的半截包。
  完整功能包由项目自身 `project.json` 声明，或由调用方显式传全套参数（`openImageModule`、`openNodeJs`、`plugins`、`abis` 等），不依赖工具缺省值。
  `openImageModule: false` 会移除 `libopencv_java4.so`（图色脚本/图色匹配直接 `UnsatisfiedLinkError`）；`openNodeJs: false` 会移除 `libnode.so`/`libv8.so`；`plugins`/`abis` 传入即**整体替换**而非增量合并，漏写会真的少打。
  打包前先读 `project.json` 确认能力声明，打包后按需核对产物。
- Node 项目（`project.json` 的 `features.nodejs=enabled` 且有 `package.json`）在设备端直接运行时，设备侧没有 npm 也不能联网装依赖：`project_sync_push` 默认不同步 `node_modules`，先用 `project_dependencies_status` 看依赖状态，缺依赖时用 `project_install_dependencies` 让服务端内置 Node 16 工具链安装并回填设备项目目录（有 `package-lock.json` 用 `npm ci`，否则 `npm install`；固定 `--omit=dev --ignore-scripts --no-bin-links`；`node_modules` 已存在时跳过，`force=true` 强制重装），安装完成后再 `project_run`。不要用开发机自带 Node 装依赖再同步：设备运行时固定 Node v16.14.0。
- `project_apk_install` 支持 `LOCAL_ARTIFACT`、`SERVER_BUILD`、`DEVICE_APK` 三类来源：调用立即返回 `taskId`（异步），下载/安装进度与包名、版本、签名以任务结果为准；`LOCAL_ARTIFACT` 由设备下载后读取元数据校验，`DEVICE_APK` 由设备任务回传元数据，无法读取时必须拒绝自动安装；MCP 不解析 APK。
- 自动执行开关不能绕过商业授权、设备访问、部署来源边界或审计。只读、危险动作、设备锁等 MCP 环境开关的含义与开启方式见分发包根目录 `README.md` 的「配置参数」一节（源码仓库内为 `docs/runbooks/mcp-configuration.md`）；用户级配置文件用 `node <插件根>/mcp/tools/mcp-config.mjs init|sync|show` 管理，不要改插件目录里的 `.mcp.json`。

## 推荐流程

1. `project_sync_plan` 计算新增、修改、删除候选和冲突，并先核对 `transferSummary.totalBytes` 与 `excludedDirectories`；项目明显过大时先修正 `localRoot` 或根 `.hzignore`，不要直接推送。
2. `project_sync_push` 按显式清单执行 `full` 或 `incremental`。
3. Node 项目缺依赖时先 `project_install_dependencies` 补齐（已有 `node_modules` 会跳过），再 `project_run` 运行设备端项目；或 `project_build` 先打包再把产物安装到设备。
4. `project_deploy_status` 与 `project_task_logs` 读取状态和裁剪后的日志。

安装与验证步骤见仓库 `docs/runbooks/install-and-verify.md`。

## 交付前自查

- 同步前跑过 `project_sync_plan`，核对过 `transferSummary` 的传输大小和排除目录，推送按显式清单；`mirror_delete` 只有显式要求才开启；根 `.hzignore` 规则只按源根解释；
- 一批同步只提交一个设备任务，没有拆成逐文件任务；
- 大文件同步中断后重跑同一批清单即可续传，没有改用分小批次或手工切文件绕过超时；
- 打包参数未显式传入即沿用 `project.json`；本次改过能力开关（`openImageModule` / `openNodeJs` / `plugins` / `abis`）的，已核对产物；
- Node 项目的依赖由服务端内置 Node 16 工具链安装：打包时 `package.json` + 开启 NodeJs 默认执行；不打包调试时用 `project_install_dependencies` 装到设备项目目录（两处都是 `node_modules` 已存在则跳过）；**不要用开发机自带 Node 装完再同步**——设备运行时固定为 Node v16.14.0，版本不一致会装出跑不了的依赖；需要换源时用 `nodeDependencyRegistry`；
- 结果逐文件/逐项读取，部分成功没有写成整体成功；
- `project_run` 的目标是包含 `project.json` 的设备端项目目录，失败时没有回退成单文件脚本运行。

## 工具未注册时的兜底通道

> ⚠️ 兜底是**故障降级**，不是默认路径：宿主本应支持 MCP 而没有 `mcp__hz-autojs-project-mcp` 时，
> 先排查注册问题（注册位置见分发包根目录 `README.md` 的「各客户端 MCP 注册位置」，源码仓库内为
> `packaging/USER-GUIDE.md`；包内 `.mcp.json` 只是模板）。使用兜底通道时**必须显式告知用户**
> 「当前 MCP 未被客户端注册，正在用兜底直连，建议先修复注册」并给出修复步骤；不得静默走兜底。

当会话工具列表里**没有** `mcp__hz-autojs-project-mcp` 时，改用插件自带的 stdio 直连器：

```
node <插件根>/mcp/tools/mcp-call.mjs project <tool> '<jsonArgs>'
```

该通道与 MCP 工具等价，不绕过任何门禁。用法、确认地址语义与常见错误见
[兜底通道文档](../../mcp/docs/fallback-channel.md)；确认与设备访问语义见
[确认与设备访问](../../mcp/docs/confirmation-and-access.md)。
