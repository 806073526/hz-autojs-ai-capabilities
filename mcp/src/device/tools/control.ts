import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  executeCanonicalTool,
  objectSchema,
  optionalNumber,
  optionalString,
  requireNumber,
  requireString
} from "./common.js";

export function controlTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "device_tap",
      "在设备屏幕坐标上点击。通过 V5 任务系统下发 AutoJs click 脚本，或在配置允许时走直控通道。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        x: { type: "number", description: "屏幕 X 坐标。" },
        y: { type: "number", description: "屏幕 Y 坐标。" },
        dispatchMode: { type: "string", enum: ["task", "direct"], description: "下发方式。默认 task。" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false }
      }, ["deviceId", "x", "y"]),
      async args => {
        const x = Math.round(requireNumber(args, "x"));
        const y = Math.round(requireNumber(args, "y"));
        return executeCanonicalTool(ctx, "device_tap", args, "device.control.tap", {
          deviceId: requireString(args, "deviceId"),
          x,
          y
        }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: args.waitForResult !== false });
      }
    ),

    createTool(
      "device_swipe",
      "在设备屏幕坐标上滑动。通过 V5 任务系统下发 AutoJs swipe 脚本，或在配置允许时走直控通道。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        x1: { type: "number" },
        y1: { type: "number" },
        x2: { type: "number" },
        y2: { type: "number" },
        durationMs: { type: "number", description: "滑动持续时间，单位毫秒。", default: 500 },
        dispatchMode: { type: "string", enum: ["task", "direct"], description: "下发方式。默认 task。" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false }
      }, ["deviceId", "x1", "y1", "x2", "y2"]),
      async args => {
        const x1 = Math.round(requireNumber(args, "x1"));
        const y1 = Math.round(requireNumber(args, "y1"));
        const x2 = Math.round(requireNumber(args, "x2"));
        const y2 = Math.round(requireNumber(args, "y2"));
        const durationMs = Math.max(1, Math.round(optionalNumber(args, "durationMs", 500) || 500));
        return executeCanonicalTool(ctx, "device_swipe", args, "device.control.swipe", {
          deviceId: requireString(args, "deviceId"),
          startX: x1,
          startY: y1,
          endX: x2,
          endY: y2,
          duration: durationMs
        }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: args.waitForResult !== false });
      }
    ),

    createTool(
      "device_input_text",
      "向当前输入框输入文本。默认使用 setText，必要时可切换 input。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        text: { type: "string", description: "要输入的文本。" },
        mode: { type: "string", enum: ["setText", "input"], default: "setText" },
        index: { type: "number", description: "可选输入框索引。" },
        dispatchMode: { type: "string", enum: ["task", "direct"], description: "下发方式。默认 task。" },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false }
      }, ["deviceId", "text"]),
      async args => {
        const text = requireString(args, "text");
        const mode = optionalString(args, "mode") === "input" ? "input" : "setText";
        return executeCanonicalTool(ctx, "device_input_text", args, "device.control.inputText", {
          deviceId: requireString(args, "deviceId"),
          text,
          textMode: mode
        }, { operation: true, deviceId: requireString(args, "deviceId"), waitForTask: args.waitForResult !== false });
      }
    )
  ];
}
