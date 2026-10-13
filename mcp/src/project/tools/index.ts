import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import { deviceFileTools } from "./deviceFiles.js";
import { deployTools } from "./deploy.js";
import { syncTools } from "./sync.js";

/**
 * 项目 MCP 工具集合。
 *
 * 不复制 device_list / device_status，也不跨 MCP 调用设备 server 的工具。
 */
export function buildProjectTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    ...deviceFileTools(ctx),
    ...syncTools(ctx),
    ...deployTools(ctx)
  ];
}
