import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import {
  DEVICE_ID_PROPERTY,
  createTool,
  guardedHandler,
  objectSchema,
  optionalNumber,
  optionalString,
  requireString,
  shapeLogOutcome,
  responseOptionsSchema
} from "./common.js";

export function logTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "device_logs",
      "查询 V5 设备日志。",
      objectSchema({
        deviceId: DEVICE_ID_PROPERTY,
        limit: { type: "number", default: 100 },
        level: { type: "string" },
        source: { type: "string" },
        ...responseOptionsSchema(),
      }, ["deviceId"]),
      async args => guardedHandler(ctx, "device_logs", args, {}, async () => {
        return shapeLogOutcome(await ctx.client.executeCanonicalTool("log.query", {
          deviceId: requireString(args, "deviceId"),
          level: optionalString(args, "level"),
          source: optionalString(args, "source"),
          limit: optionalNumber(args, "limit", 100)
        }, { permissionMode: "FULL_AUTO" }), args);
      })
    )
  ];
}
