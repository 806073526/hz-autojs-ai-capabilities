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
  optionalString,
  requireString,
  responseOptionsSchema
} from "./common.js";
import { ANALYSIS_NODE_DEFAULTS, appendLayoutView } from "./layoutView.js";

export function deviceTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "device_list",
      "列出 V5 设备。默认只返回在线设备，可通过 includeOffline 返回全部设备。",
      objectSchema({
        includeOffline: {
          type: "boolean",
          description: "是否包含离线设备。",
          default: false
        }
      }),
      async args => guardedHandler(ctx, "device_list", args, {}, async () => {
        const includeOffline = optionalBoolean(args, "includeOffline", false);
        return ctx.client.executeCanonicalTool(includeOffline ? "device.list" : "device.online", { includeOffline }, {
          permissionMode: "FULL_AUTO"
        });
      })
    ),

    createTool(
      "device_status",
      "查询单台设备状态。返回中的 directControlMode 决定该设备允许的脚本写法：PRIVILEGED 模式禁止 home/back/click/swipe/setText/text()/desc()/id()/currentPackage() 等无障碍 API，必须使用 __toolboxTap/__toolboxSwipe/__toolboxText/__toolboxAction 等模式感知 API。下发脚本前必须先看此字段。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        includeDirectControl: {
          type: "boolean",
          description: "是否附带查询 /api/device-control/{deviceId}/status（V5 直控通道实时状态，含可用性与原因码）。",
          default: false
        }
      }, ["deviceId"]),
      async args => guardedHandler(ctx, "device_status", args, {}, async () => {
        const deviceId = requireString(args, "deviceId");
        const device = await ctx.client.get(`/api/device/${encodeURIComponent(deviceId)}`);
        if (!optionalBoolean(args, "includeDirectControl", false)) {
          return device;
        }
        const directControl = await ctx.client.get(`/api/device-control/${encodeURIComponent(deviceId)}/status`);
        return {
          ok: device.ok,
          code: device.code,
          message: device.message,
          data: {
            device: device.data,
            directControl
          }
        };
      })
    ),

    createTool(
      "device_screenshot",
      "下发 V5 截图任务。默认等待任务完成。includePreview=true 时返回真实图片内容块（可直接观察屏幕），base64 不会作为文本进入上下文。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        outputPath: {
          type: "string",
          description: "设备端截图保存路径，例如 /sdcard/Download/v5_mcp_screen.png。"
        },
        includePreview: {
          type: "boolean",
          description: "是否返回预览图。true 时以真实图片内容块返回，可直接看图；不占用文本上下文。",
          default: false
        },
        previewFormat: {
          type: "string",
          enum: ["jpg", "png"],
          description: "预览图格式。"
        },
        previewQuality: {
          type: "number",
          description: "预览图质量。"
        },
        resetScreenCapture: {
          type: "boolean",
          description: "是否强制重置截图权限后再截图。"
        },
        screenCaptureTimeout: {
          type: "number",
          description: "截图权限等待超时，单位毫秒。"
        },
        waitStable: {
          type: "boolean",
          description: "是否等待画面稳定后再返回截图；用于规避页面加载/动画中的过渡帧。"
        },
        waitStableTimeoutMs: {
          type: "number",
          description: "等待画面稳定的最长毫秒数，默认 6000。"
        },
        waitStableIntervalMs: {
          type: "number",
          description: "稳定检测的相邻两帧间隔毫秒数，默认 700。"
        },
        stableThreshold: {
          type: "number",
          description: "判定稳定的采样像素平均色差阈值，默认 8；越小越严格。"
        },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId"]),
      async args => executeCanonicalTool(ctx, "device_screenshot", args, "device.screenshot", {
          deviceId: requireString(args, "deviceId"),
          outputPath: optionalString(args, "outputPath"),
          includePreview: optionalBoolean(args, "includePreview", false),
          previewFormat: optionalString(args, "previewFormat"),
          previewQuality: optionalNumber(args, "previewQuality"),
          resetScreenCapture: args.resetScreenCapture,
          screenCaptureTimeout: optionalNumber(args, "screenCaptureTimeout"),
          waitStable: optionalBoolean(args, "waitStable", false),
          waitStableTimeoutMs: optionalNumber(args, "waitStableTimeoutMs"),
          waitStableIntervalMs: optionalNumber(args, "waitStableIntervalMs"),
          stableThreshold: optionalNumber(args, "stableThreshold")
        }, {
          operation: false,
          deviceId: requireString(args, "deviceId"),
          waitForTask: args.waitForResult !== false
        })
    ),

    createTool(
      "device_layout_dump",
      "下发布局分析任务（结构分析口径）。默认全量：全部窗口（layoutRange=all）、不限数量（limit=0）、不做可见性/可用性/去重过滤（visibleOnly=false、usableOnly=false、dedupe=false），屏外与零面积节点同样返回，用于布局结构分析、页面理解和完整节点核对。只看当前操作页面时可传 layoutRange=active；想要可操作节点清单时传 usableOnly=true、visibleOnly=true。默认不返回预览图。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        limit: {
          type: "number",
          description: "最多返回节点数量。0 或不传表示不限制，返回全部节点；大于 0 时按遍历顺序截断。",
          default: 0
        },
        layoutRange: {
          type: "string",
          enum: ["active", "all"],
          description: "节点采集范围：all=全部窗口（默认，结构分析用），active=仅当前活跃窗口。设备处于高级权限（uiautomator dump）通道时该参数不生效，两种取值结果相同。",
          default: "all"
        },
        visibleOnly: {
          type: "boolean",
          description: "只保留具备有效可见边界的节点（丢掉零面积、屏外节点）。默认 false=全量；WebView 页面要拿全必须保持 false。",
          default: false
        },
        usableOnly: {
          type: "boolean",
          description: "只保留可用节点：enabled 且（可点击/长按/滚动/勾选/可输入，或带 text/desc）。默认 false=全量；只要可用节点清单时设 true。",
          default: false
        },
        clickableOnly: {
          type: "boolean",
          description: "只保留 clickable=true 的节点。默认 false。",
          default: false
        },
        textOnly: {
          type: "boolean",
          description: "只保留带 text 或 desc 的节点。默认 false。",
          default: false
        },
        dedupe: {
          type: "boolean",
          description: "按 文本+描述+ID+类名+bounds 去重。默认 false，保留全部节点。",
          default: false
        },
        fields: {
          type: "string",
          description: "逗号分隔的返回字段，默认 text,desc,id,className,clickable,scrollable,bounds,center。"
        },
        outputFormat: {
          type: "string",
          enum: ["json", "compact", "lines"],
          description: "返回格式。默认 json；节点很多时可改用 compact 或 lines 省体积。",
          default: "json"
        },
        includeActionCandidates: {
          type: "boolean",
          description: "是否附带图标型操作候选（用于文本节点找不到维护入口时）。默认 false。",
          default: false
        },
        candidateOnly: {
          type: "boolean",
          description: "只返回操作候选、不返回完整节点数组。默认 false。",
          default: false
        },
        actionCandidateLimit: { type: "number", description: "操作候选数量上限，默认 30。" },
        actionCandidateZones: { type: "string", description: "操作候选区域，逗号分隔，默认 topRight,listRight,cardRight,rowRight。" },
        includeRecognitionResults: {
          type: "boolean",
          description: "是否附带统一识别结果（sourceType/confidence/bounds/center）。默认 false。",
          default: false
        },
        includeTaskMeta: {
          type: "boolean",
          description: "是否附带完整任务元数据。默认 false。",
          default: false
        },
        includePreview: {
          type: "boolean",
          description: "是否回传预览图。默认 false。",
          default: false
        },
        waitForResult: { type: "boolean", default: true },
        timeoutMs: { type: "number" },
        includeLogs: { type: "boolean", default: false },
        ...responseOptionsSchema(),
      }, ["deviceId"]),
      async args => {
        const limit = optionalNumber(args, "limit", 0) ?? 0;
        const scanLimit = limit > 0 ? Math.max(limit, 500) : 0;
        const result = await executeCanonicalTool(ctx, "device_layout_dump", args, "device.layout.read", {
          deviceId: requireString(args, "deviceId"),
          limit: scanLimit,
          layoutRange: optionalString(args, "layoutRange") || "all",
          includePreview: optionalBoolean(args, "includePreview", false)
        }, {
          operation: false,
          deviceId: requireString(args, "deviceId"),
          waitForTask: args.waitForResult !== false,
          shapeOptions: { deferResponseShaping: true }
        });
        if (!result.ok) return result;
        return appendLayoutView(result, args, {
          sourceType: "device_layout_dump",
          defaults: ANALYSIS_NODE_DEFAULTS
        });
      }
    )
  ];
}
