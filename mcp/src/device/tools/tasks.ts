import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  executeCanonicalTool,
  guardedHandler,
  maybeWaitForTask,
  objectSchema,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  fail,
  requireString,
  shapeLogOutcome,
  shapeTaskOutcome,
  responseOptionsSchema
} from "./common.js";
import { findTopLevelReturn, isNodeScriptHeader } from "./scriptValidation.js";

export function taskTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "device_run_script_text",
      "通过 V5 任务系统下发 AutoJs 脚本文本。默认按第一代 Rhino 执行；脚本首行使用 \"nodejs\"; 或 Node + UI 组合指令 \"ui nodejs\"; 时，V5 会按 .node.js 入口交给 Node 16 引擎执行，可直接使用第二代 Node API，顶层 return 合法。Rhino 脚本禁止顶层 return（Rhino 会报 invalid return，子引擎无法上报终态，父引擎只能兜底判失败）；需要输出结果时用 log marker 或写文件。先用 device_status 确认 directControlMode：PRIVILEGED 模式下 home/back/click/swipe/setText/text()/desc()/id()/currentPackage() 等无障碍 API 会被替换为抛错桩（ACCESSIBILITY_FORBIDDEN_BY_MODE），须改用 __toolboxTap/__toolboxSwipe/__toolboxText/__toolboxAction。终态由独立子引擎自报，服务端已保证「提交成功」不会写成 SUCCEEDED，因此 SUCCEEDED 即脚本真实执行完成；响应的 terminalSource 可确认来源（CHILD_ENGINE=子引擎自报，PARENT_ENGINE/WATCHDOG=父引擎或看门狗兜底）。脚本失败时结果原因已写在 resultMessage，无需先查日志；只有需要定位具体报错位置时再查 task_logs。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        scriptContent: { type: "string", description: "AutoJs 脚本正文。默认 Rhino；首行 \"nodejs\"; 或 \"ui nodejs\"; 时按 .node.js 入口交给 Node 16 引擎（第二代 API）。" },
        scriptParams: {
          type: "object",
          additionalProperties: true,
          description: "可选脚本参数对象；会以全局变量 __toolboxParams 注入脚本环境，替代在脚本正文里做字符串替换。"
        },
        sourceScriptName: { type: "string", description: "来源脚本名称。" },
        priority: { type: "string", enum: ["HIGH", "NORMAL", "LOW"], default: "HIGH" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "scriptContent"]),
      async args => guardedHandler(
        ctx,
        "device_run_script_text",
        args,
        {
          operation: true,
          dangerous: isDangerousScript(requireString(args, "scriptContent")),
          deviceId: requireString(args, "deviceId")
        },
        async () => {
          const scriptContent = requireString(args, "scriptContent");
          if (!isNodeScriptHeader(scriptContent)) {
            const topLevelReturn = findTopLevelReturn(scriptContent);
            if (topLevelReturn) {
              return fail(
                "INVALID_SCRIPT_TOP_LEVEL_RETURN",
                `scriptContent 第 ${topLevelReturn.line} 行包含顶层 return；Rhino 会报 invalid return，子引擎无法上报终态。请在函数内 return，或改用 log marker 输出结果；Node 入口脚本不受此限制。`
              );
            }
          }
          return executeCanonicalTool(ctx, "device_run_script_text", args, "device.script.runText", {
            deviceId: requireString(args, "deviceId"),
            scriptContent,
            scriptParams: optionalObject(args, "scriptParams"),
            sourceScriptName: optionalString(args, "sourceScriptName") || "MCP:脚本文本",
            priority: optionalString(args, "priority") || "HIGH"
          }, { operation: false, waitForTask: args.waitForResult !== false });
        }
      )
    ),

    createTool(
      "device_run_script_file",
      "通过 V5 任务系统运行设备端已有 AutoJs 脚本文件。默认按 Rhino 执行，顶层 return 会报 invalid return；文件名为 .node.js 或文件头为 \"nodejs\"; / \"ui nodejs\"; 时由 Node 16 引擎执行第二代 Node API，顶层 return 合法。同样受 directControlMode 约束（PRIVILEGED 模式禁用无障碍 API），终态由独立子引擎自报，SUCCEEDED 即脚本真实执行完成；terminalSource=CHILD_ENGINE 表示子引擎自报，PARENT_ENGINE/WATCHDOG 表示兜底判定，失败原因见 resultMessage。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        scriptPath: { type: "string", description: "设备端脚本路径。" },
        sourceScriptName: { type: "string" },
        priority: { type: "string", enum: ["HIGH", "NORMAL", "LOW"], default: "HIGH" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "scriptPath"]),
      async args => guardedHandler(ctx, "device_run_script_file", args, { operation: true, deviceId: requireString(args, "deviceId") }, async () => {
        return executeCanonicalTool(ctx, "device_run_script_file", args, "device.script.runFile", {
          deviceId: requireString(args, "deviceId"),
          scriptPath: requireString(args, "scriptPath"),
          sourceScriptName: optionalString(args, "sourceScriptName") || "MCP:脚本文件",
          priority: optionalString(args, "priority") || "HIGH"
        }, { operation: false, waitForTask: args.waitForResult !== false });
      })
    ),

    createTool(
      "device_stop_script",
      "提交 V5 停止业务脚本引擎任务。需要 confirmStop=true。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        whitelistText: { type: "string", description: "额外白名单路径文本。" },
        confirmStop: { type: "boolean", description: "必须显式为 true。" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId", "confirmStop"]),
      async args => guardedHandler(ctx, "device_stop_script", args, { operation: true, deviceId: requireString(args, "deviceId") }, async () => {
        if (args.confirmStop !== true) {
          return {
            ok: false,
            code: "CONFIRM_STOP_REQUIRED",
            message: "停止脚本引擎需要 confirmStop=true",
            data: undefined
          };
        }
        return executeCanonicalTool(ctx, "device_stop_script", args, "device.script.stop", {
          deviceId: requireString(args, "deviceId"),
          whitelistText: optionalString(args, "whitelistText") || "",
          priority: "HIGH"
        }, { operation: false, waitForTask: args.waitForResult !== false });
      })
    ),

    createTool(
      "task_get",
      "查询 V5 任务详情。脚本类任务看 terminalSource：CHILD_ENGINE=独立子引擎自报的真实执行结果；PARENT_ENGINE/WATCHDOG=父引擎看护或后端看门狗兜底判定。SUCCEEDED + CHILD_ENGINE 即脚本已成功执行完毕，无需再查日志。",
      objectSchema({
        taskId: { type: "string" }
      }, ["taskId"]),
      async args => guardedHandler(ctx, "task_get", args, {}, async () => {
        return ctx.client.executeCanonicalTool("task.get", {
          taskId: requireString(args, "taskId")
        }, { permissionMode: "FULL_AUTO" });
      })
    ),

    createTool(
      "task_wait",
      "等待 V5 任务进入 SUCCEEDED、FAILED 或 CANCELLED。返回含 terminalSource：脚本类任务 SUCCEEDED + CHILD_ENGINE 表示子引擎自报的真实成功，无需追加日志复核；PARENT_ENGINE/WATCHDOG 表示兜底判定。",
      objectSchema({
        taskId: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        timeoutMs: { type: "number" },
        pollIntervalMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["taskId"]),
      async args => guardedHandler(ctx, "task_wait", args, {}, async () => {
        const result = await ctx.client.waitForTask(requireString(args, "taskId"), {
          timeoutMs: optionalNumber(args, "timeoutMs"),
          pollIntervalMs: optionalNumber(args, "pollIntervalMs"),
          includeLogs: optionalBoolean(args, "includeLogs", false)
        });
        return shapeTaskOutcome(result, args);
      })
    ),

    createTool(
      "task_logs",
      "查询 V5 任务日志。",
      objectSchema({
        taskId: { type: "string" },
        deviceId: DEVICE_ID_PROPERTY,
        tailLines: { type: "number", description: "只保留日志尾部若干行，默认 200。" },
        ...responseOptionsSchema(),
      }, ["taskId"]),
      async args => guardedHandler(ctx, "task_logs", args, {}, async () => {
        return shapeLogOutcome(await ctx.client.executeCanonicalTool("task.log.tail", {
          taskId: requireString(args, "taskId"),
          limit: optionalNumber(args, "tailLines", 200)
        }, { permissionMode: "FULL_AUTO" }), args);
      })
    )
  ];
}

function isDangerousScript(script: string): boolean {
  return /delete|remove|unlink|rm\s+-|pm\s+uninstall|uninstall\(|installPackage|sendSms|requestPermissions|WRITE_SECURE_SETTINGS|shell\(|su\s|支付|付款/.test(script);
}
