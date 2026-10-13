import type { JsonObject, McpToolDefinition, ToolContext, ToolOutcome } from "../../core/types.js";
import { executeCanonicalWithConfirmation } from "../../core/pendingConfirmation.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  executeCanonicalTool,
  guardedHandler,
  objectSchema,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  shapeLogOutcome,
  responseOptionsSchema
} from "../../device/tools/common.js";

/**
 * 打包参数透传辅助：缺省字段不进入请求体，后端按 project.json 解析。
 * MCP 不注入默认能力开关，避免静默覆盖项目声明（例如打出缺 OpenCV 的半截包）。
 */
function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function triStateBoolean(args: JsonObject, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error("参数 " + key + " 必须是布尔值");
  return value;
}

function optionalStringArray(args: JsonObject, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  return value.filter(item => typeof item === "string" && item.trim()).map(item => String(item).trim());
}

/**
 * 项目运行与部署工具。
 *
 * project_run 只映射 RUN_PROJECT；任何一层失败都不得回退为单文件脚本运行。
 */
export function deployTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "project_run",
      "运行设备端包含 project.json 的项目目录，映射 V5 RUN_PROJECT。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        projectPath: { type: "string", description: "设备端项目目录绝对路径。" },
        workRoots: { type: "string", description: "允许的设备工作根，多个用逗号分隔；MCP 预检使用。" },
        sourceScriptName: { type: "string" },
        priority: { type: "string", enum: ["HIGH", "NORMAL", "LOW"], default: "HIGH" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "projectPath"]),
      async args => {
        const deviceId = requireString(args, "deviceId");
        const projectPath = requireString(args, "projectPath");
        const precheck = precheckProject(args, projectPath);
        if (!precheck.ok) return precheck.outcome;
        const devicePrecheck = await verifyProjectOnDevice(ctx, deviceId, precheck.data.projectPath, args);
        if (!devicePrecheck.ok) return devicePrecheck.outcome;
        return executeCanonicalTool(ctx, "project_run", args, "device.script.runFile", {
          deviceId,
          taskMode: "RUN_PROJECT",
          scriptPath: precheck.data.projectPath,
          sourceScriptName: optionalString(args, "sourceScriptName") || "MCP:项目运行",
          priority: optionalString(args, "priority") || "HIGH",
          deviceAccessToken: optionalString(args, "deviceAccessToken"),
          mcpProjectPrecheck: devicePrecheck.data
        }, { operation: true, deviceId, waitForTask: args.waitForResult !== false });
      }
    ),

    createTool(
      "project_build",
      [
        "提交服务端打包任务。默认 PUBLIC 来源；DEVICE 需明确设备访问。",
        "",
        "打包参数遵循「未显式传入即沿用项目 project.json」：",
        "- 不传 = 项目既定配置，MCP 不替项目做默认值决策；",
        "- 显式传入 = 只对本次打包生效的一次性覆盖，不回写 project.json。",
        "",
        "能力开关含义（与 project.json 对应）：",
        "- openImageModule：图色模块，对应 optimization.removeOpenCv 取反。false 会移除 libopencv_java4.so，findMultiColors / 图色匹配 / 颜色识别会直接抛 UnsatisfiedLinkError；",
        "- openNodeJs：NodeJs 运行时，对应 features.nodejs。false 会移除 libnode.so / libv8.so 并清空 V8 内置模块；",
        "- installNodeDependencies：项目带 package.json 且开启 NodeJs 时，默认用服务端内置的 Node 16 工具链安装依赖（npm ci/install，--omit=dev --ignore-scripts --no-bin-links），node_modules 已存在则跳过；显式 false 可关闭；",
        "- nodeDependencyRegistry：依赖安装使用的 npm 源；不传用 npm 默认源，国内环境可传镜像地址；",
        "- openObfuscator：混淆，对应 project.json openObfuscator；",
        "- openJsToDex：快照加密（JS 转 DEX）。开启后固定顺序为「原始快照 → JS 转 DEX → 混淆」；可转换的 JS 会编译成 dex 并重写为加载壳，已有加载壳会被跳过；单文件转换失败会让整个打包任务失败；",
        "- jsToDexExcludePaths：转换排除路径，与「混淆排除」相互独立；命中的 JS 保持原样，不参与 JS 转 DEX；",
        "- plugins / abis：不传沿用 project.json；传入则整体替换该次打包取值，不是增量合并；",
        "- tempPackagingMode：临时打包模式，一次性包名 + 一次性签名，都不回写 project.json。",
        "",
        "完整功能打包由项目自身 project.json 声明，或由调用方显式传全套参数，不依赖本工具缺省值。",
        "打包前请先读取 project.json 确认能力声明，避免打出缺少原生库的半截包。"
      ].join("\n"),
      objectSchema({
        sourceType: { type: "string", enum: ["PUBLIC", "DEVICE", "LOCAL_PATH"], default: "PUBLIC" },
        deviceId: DEVICE_ID_PROPERTY,
        publicPath: { type: "string", description: "PUBLIC 来源的项目路径。" },
        localPath: { type: "string", description: "LOCAL_PATH 来源的服务端本机项目路径；缺省使用服务端项目根目录下的 mobile。" },
        projectPath: { type: "string", description: "DEVICE 来源的设备端项目目录绝对路径。" },
        appName: { type: "string", description: "应用名称；不传沿用 project.json。" },
        packageName: { type: "string", description: "包名；不传沿用 project.json。" },
        versionName: { type: "string", description: "版本名称；不传沿用 project.json。" },
        versionCode: { type: "number", description: "版本号；不传沿用 project.json。" },
        appIcon: { type: "string", description: "应用图标相对路径；不传沿用 project.json。" },
        splashIcon: { type: "string", description: "启动页图标相对路径；不传沿用 project.json。" },
        splashText: { type: "string", description: "启动页文本；不传沿用 project.json。" },
        abis: {
          type: "array",
          items: { type: "string" },
          description: "CPU 架构列表，如 [armeabi-v7a, arm64-v8a]。不传沿用 project.json；传入则整体替换。"
        },
        plugins: {
          type: "array",
          items: { type: "string" },
          description: "插件包名列表。不传沿用 project.json；传入则整体替换该次打包的插件集合，漏写会真的少打插件。"
        },
        openNodeJs: { type: "boolean", description: "是否启用 NodeJs 运行时。不传沿用 project.json（features.nodejs）。false 会移除 libnode.so / libv8.so。" },
        installNodeDependencies: { type: "boolean", description: "是否在打包前用内置 Node 16 工具链安装项目依赖。不传时项目开启 NodeJs 且存在 package.json 即默认安装；node_modules 已存在则跳过。安装固定带 --omit=dev --ignore-scripts --no-bin-links。" },
        nodeDependencyRegistry: { type: "string", description: "依赖安装使用的 npm registry；留空使用 npm 默认源，例如 https://registry.npmmirror.com。" },
        openImageModule: { type: "boolean", description: "是否启用图色模块（OpenCV）。不传沿用 project.json（optimization.removeOpenCv 取反）。false 会移除 libopencv_java4.so，图色脚本与图色匹配将不可用。" },
        openObfuscator: { type: "boolean", description: "是否开启混淆。不传沿用 project.json。" },
        obfuscatorExcludePaths: { type: "string", description: "混淆排除路径；不传沿用 project.json。" },
        openJsToDex: { type: "boolean", description: "是否开启快照加密（JS 转 DEX）。不传沿用 project.json。开启后先归档原始快照，再把 JS 转 DEX 并重写为加载壳，最后执行混淆（如勾选）。单文件转换失败即整个任务失败。" },
        jsToDexExcludePaths: { type: "string", description: "转换排除路径，与混淆排除相互独立；命中的 JS 保持原样不参与 JS 转 DEX。不传沿用 project.json。" },
        autoOpen: { type: "boolean", description: "是否开机自启动。不传沿用 project.json。" },
        hideLogs: { type: "boolean", description: "是否隐藏日志。不传沿用 project.json。" },
        signingProfile: { type: "string", description: "签名配置档案；不传使用服务端默认档案。" },
        tempPackagingMode: { type: "boolean", description: "临时打包模式：一次性包名 + 一次性证书签名，都不回写 project.json。" },
        deviceAccessToken: { type: "string" }
      }, ["sourceType"]),
      async args => {
        const sourceType = (optionalString(args, "sourceType") || "PUBLIC").toUpperCase();
        // 只透传显式给出的字段：缺省一律交给后端按 project.json 解析，MCP 不注入默认值。
        const passthrough = compactObject({
          appName: optionalString(args, "appName"),
          packageName: optionalString(args, "packageName"),
          versionName: optionalString(args, "versionName"),
          versionCode: optionalNumber(args, "versionCode"),
          appIcon: optionalString(args, "appIcon"),
          splashIcon: optionalString(args, "splashIcon"),
          splashText: optionalString(args, "splashText"),
          abis: optionalStringArray(args, "abis"),
          plugins: optionalStringArray(args, "plugins"),
          openNodeJs: triStateBoolean(args, "openNodeJs"),
          installNodeDependencies: triStateBoolean(args, "installNodeDependencies"),
          nodeDependencyRegistry: optionalString(args, "nodeDependencyRegistry"),
          openImageModule: triStateBoolean(args, "openImageModule"),
          openObfuscator: triStateBoolean(args, "openObfuscator"),
          obfuscatorExcludePaths: optionalString(args, "obfuscatorExcludePaths"),
          openJsToDex: triStateBoolean(args, "openJsToDex"),
          jsToDexExcludePaths: optionalString(args, "jsToDexExcludePaths"),
          autoOpen: triStateBoolean(args, "autoOpen"),
          hideLogs: triStateBoolean(args, "hideLogs"),
          signingProfile: optionalString(args, "signingProfile"),
          tempPackagingMode: triStateBoolean(args, "tempPackagingMode")
        });
        if (sourceType === "DEVICE") {
          const deviceId = requireString(args, "deviceId");
          return executeCanonicalTool(ctx, "project_build", args, "packaging.build", {
            sourceType,
            deviceId,
            projectPath: requireString(args, "projectPath"),
            ...passthrough,
            deviceAccessToken: optionalString(args, "deviceAccessToken")
          }, { operation: true, deviceId, waitForTask: false });
        }
        if (sourceType === "LOCAL_PATH") {
          const localPath = optionalString(args, "localPath");
          return executeCanonicalTool(ctx, "project_build", args, "packaging.build", {
            sourceType,
            ...(localPath ? { localPath } : {}),
            ...passthrough
          }, { operation: true, waitForTask: false });
        }
        return executeCanonicalTool(ctx, "project_build", args, "packaging.build", {
          sourceType: "PUBLIC",
          publicPath: requireString(args, "publicPath"),
          ...passthrough
        }, { operation: true, waitForTask: false });
      }
    ),

    createTool(
      "project_apk_install",
      "统一三来源 APK 安装：LOCAL_ARTIFACT、SERVER_BUILD、DEVICE_APK；立即返回 taskId（异步），下载、安装与 APK 元数据以任务结果为准。",
      objectSchema({
        sourceType: { type: "string", enum: ["LOCAL_ARTIFACT", "SERVER_BUILD", "DEVICE_APK"] },
        deviceId: DEVICE_ID_PROPERTY,
        jobId: { type: "string" },
        fileId: { type: "number" },
        devicePath: { type: "string" },
        targetDirectory: { type: "string" },
        launchAfterInstall: { type: "boolean", default: false },
        deviceAccessToken: { type: "string" }
      }, ["sourceType", "deviceId"]),
      async args => executeCanonicalTool(ctx, "project_apk_install", args, "device.apk.install", {
        sourceType: (optionalString(args, "sourceType") || "").toUpperCase(),
        deviceId: requireString(args, "deviceId"),
        jobId: optionalString(args, "jobId"),
        fileId: args.fileId,
        devicePath: optionalString(args, "devicePath"),
        targetDirectory: optionalString(args, "targetDirectory"),
        launchAfterInstall: optionalBoolean(args, "launchAfterInstall", false),
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: true, dangerous: true, deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "project_dependencies_status",
      "检查设备端 Node 项目的依赖状态：是否为 Node 项目、是否有 package.json/package-lock.json/node_modules、project.json 是否开启 NodeJs。只读，不安装。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        projectPath: { type: "string", description: "设备端项目目录绝对路径。" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "projectPath"]),
      async args => executeCanonicalTool(ctx, "project_dependencies_status", args, "packaging.project.dependencies.status", {
        deviceId: requireString(args, "deviceId"),
        projectPath: requireString(args, "projectPath"),
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: false, deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "project_install_dependencies",
      [
        "用服务端内置 Node 16 工具链为设备端 Node 项目安装依赖，并把 node_modules 回填到设备项目目录（不打包的调试链路）。",
        "",
        "使用场景：",
        "- 项目在设备端直接运行（RUN_PROJECT）但缺少 node_modules：服务端读 package.json（有 package-lock.json 时用 npm ci，否则 npm install），",
        "  安装参数固定为 --omit=dev --ignore-scripts --no-bin-links --no-audit --no-fund，打 zip 后经 FILE_PUSH 回填并解压，再删除设备端压缩包；",
        "- 项目在本地、经 MCP 同步到设备端：MCP 默认排除 node_modules，同步后用本工具在设备端补齐依赖。",
        "",
        "返回 jobId；安装是服务端后台任务，用 project_dependencies_status 可查设备端结果，用 project_deploy_status/task 链路可跟踪回填任务。",
        "node_modules 已存在时默认跳过，force=true 可强制重装；registry 可指定 npm 源（默认 npm 官方源）。"
      ].join("\n"),
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        projectPath: { type: "string", description: "设备端项目目录绝对路径（必须包含 package.json）。" },
        registry: { type: "string", description: "npm registry；留空用 npm 默认源，例如 https://registry.npmmirror.com。" },
        force: { type: "boolean", default: false, description: "node_modules 已存在时是否强制重装。" },
        deviceAccessToken: { type: "string" }
      }, ["deviceId", "projectPath"]),
      async args => executeCanonicalTool(ctx, "project_install_dependencies", args, "packaging.project.dependencies.install", {
        deviceId: requireString(args, "deviceId"),
        projectPath: requireString(args, "projectPath"),
        registry: optionalString(args, "registry"),
        force: optionalBoolean(args, "force", false),
        deviceAccessToken: optionalString(args, "deviceAccessToken")
      }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: false })
    ),

    createTool(
      "project_deploy_status",
      "返回打包状态、安装状态或部署汇总状态。",
      objectSchema({
        jobId: { type: "string" },
        taskId: { type: "string" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }),
      async args => {
        const jobId = optionalString(args, "jobId");
        if (jobId) {
          return guardedHandler(ctx, "project_deploy_status", args, {}, async () =>
            executeCanonicalWithConfirmation(ctx, "packaging.build.status", { jobId }));
        }
        const taskId = optionalString(args, "taskId");
        if (taskId) {
          return guardedHandler(ctx, "project_deploy_status", args, {}, async () => {
            const task = await ctx.client.getTask(taskId);
            if (!task.ok || !optionalBoolean(args, "includeLogs", false)) return task;
            const logs = await ctx.client.getTaskLogs(taskId);
            return {
              ok: task.ok,
              code: task.code,
              message: task.message,
              data: { task: task.data, logs: logs.ok ? logs.data : logs }
            };
          });
        }
        return guardedHandler(ctx, "project_deploy_status", args, {}, async () => {
          const tasks = await ctx.client.get("/api/task/query", { limit: 20 });
          return tasks;
        });
      }
    ),

    createTool(
      "project_task_logs",
      "读取项目相关任务日志，按行数和字符数裁剪返回。",
      objectSchema({
        taskId: { type: "string" },
        jobId: { type: "string" },
        ...responseOptionsSchema(),
      }, []),
      async args => guardedHandler(ctx, "project_task_logs", args, {}, async () => {
        const jobId = optionalString(args, "jobId");
        if (jobId) {
          const result = await executeCanonicalWithConfirmation(ctx, "packaging.build.logs", {
            jobId,
            tailLines: optionalNumber(args, "tailLines", 200),
            maxChars: optionalNumber(args, "maxChars", 8000),
            markerStart: optionalString(args, "markerStart"),
            markerEnd: optionalString(args, "markerEnd")
          }, { permissionMode: "FULL_AUTO" });
          return shapeLogOutcome(result, args);
        }
        const result = await executeCanonicalWithConfirmation(ctx, "task.log.tail", {
          taskId: requireString(args, "taskId"),
          limit: optionalNumber(args, "tailLines", 200)
        }, { permissionMode: "FULL_AUTO" });
        return shapeLogOutcome(result, args);
      })
    )
  ];
}

/**
 * MCP 提交前预检：先做本地路径规范化，再通过设备文件工具真实读取
 * project.json 并确认入口脚本存在；任一环节失败都直接返回失败，不回退为单文件运行。
 */
async function verifyProjectOnDevice(
  ctx: ToolContext,
  deviceId: string,
  projectPath: string,
  args: JsonObject
): Promise<{ ok: true; data: JsonObject } | { ok: false; outcome: ToolOutcome }> {
  const deviceAccessToken = optionalString(args, "deviceAccessToken");
  const projectJsonPath = projectPath + "/project.json";
  const projectJsonResult = await executeCanonicalWithConfirmation(ctx, "file.device.readText", {
    deviceId,
    path: projectJsonPath,
    encoding: "UTF-8",
    deviceAccessToken
  }, { permissionMode: "FULL_AUTO" });
  if (!projectJsonResult.ok) {
    return {
      ok: false,
      outcome: {
        ok: false,
        code: "PROJECT_JSON_UNAVAILABLE",
        message: "无法读取设备端 project.json: " + projectJsonResult.message,
        data: projectJsonResult.data
      }
    };
  }
  const projectJsonText = extractCanonicalResultText(projectJsonResult.data);
  if (!projectJsonText) {
    return {
      ok: false,
      outcome: { ok: false, code: "PROJECT_JSON_EMPTY", message: "设备端 project.json 内容为空: " + projectJsonPath }
    };
  }
  let projectJson: JsonObject;
  try {
    const parsed = JSON.parse(projectJsonText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("project.json 必须是 JSON 对象");
    projectJson = parsed as JsonObject;
  } catch (error) {
    return {
      ok: false,
      outcome: {
        ok: false,
        code: "PROJECT_JSON_INVALID",
        message: "设备端 project.json 解析失败: " + (error instanceof Error ? error.message : String(error))
      }
    };
  }
  const main = typeof projectJson.main === "string" && projectJson.main.trim()
    ? projectJson.main.trim()
    : typeof projectJson.mainFile === "string" && projectJson.mainFile.trim()
      ? projectJson.mainFile.trim()
      : "main.js";
  const entryPath = main.startsWith("/")
    ? main.replace(/\/+/g, "/")
    : projectPath + "/" + main.replace(/^\/+/, "");
  const entryResult = await executeCanonicalWithConfirmation(ctx, "file.device.readText", {
    deviceId,
    path: entryPath,
    encoding: "UTF-8",
    deviceAccessToken
  }, { permissionMode: "FULL_AUTO" });
  if (!entryResult.ok) {
    return {
      ok: false,
      outcome: {
        ok: false,
        code: "PROJECT_ENTRY_UNAVAILABLE",
        message: "项目入口脚本不存在或不可读: " + entryPath,
        data: entryResult.data
      }
    };
  }
  return {
    ok: true,
    data: {
      projectPath,
      projectJsonPath,
      entryPath,
      projectJson,
      note: "MCP 已通过设备文件工具确认 project.json 与入口脚本存在；V5 canonical 与设备端仍会再次校验。"
    }
  };
}

function extractCanonicalResultText(data: JsonObject | undefined): string {
  const result = data && typeof data.result === "object" && !Array.isArray(data.result)
    ? data.result as JsonObject
    : undefined;
  return result && typeof result.content === "string" ? result.content : "";
}

/**
 * 路径规范化与契约检查：目标必须在允许工作根内；project.json 与入口脚本由 verifyProjectOnDevice 真实读取校验。
 */
function precheckProject(args: Record<string, unknown>, projectPath: string) {
  const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.startsWith("/")) {
    return { ok: false as const, outcome: { ok: false, code: "PROJECT_PATH_INVALID", message: "项目路径必须是设备端绝对路径" } };
  }
  if (normalized.split("/").includes("..")) {
    return { ok: false as const, outcome: { ok: false, code: "PROJECT_PATH_TRAVERSAL", message: "项目路径不允许包含 .." } };
  }
  const rawRoots = optionalString(args, "workRoots") || "/sdcard/appSync";
  const roots = rawRoots.split(/[,;\s]+/).map(item => item.trim().replace(/\/+$/, "")).filter(Boolean);
  if (roots.length && !roots.some(root => normalized === root || normalized.startsWith(`${root}/`))) {
    return {
      ok: false as const,
      outcome: {
        ok: false,
        code: "PROJECT_OUTSIDE_WORK_ROOT",
        message: `项目路径不在允许工作根内: ${roots.join(", ")}`
      }
    };
  }
  return {
    ok: true as const,
    data: {
      projectPath: normalized,
      allowedWorkRoots: roots,
      projectJson: `${normalized}/project.json`,
      note: "MCP 预检通过；V5 canonical 与设备端仍会再次校验 project.json。"
    }
  };
}
