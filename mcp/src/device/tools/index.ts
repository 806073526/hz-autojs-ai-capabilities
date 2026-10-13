import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import { controlTools } from "./control.js";
import { deviceTools } from "./device.js";
import { docsTools } from "./docs.js";
import { knowledgeTools } from "./knowledge.js";
import { logTools } from "./logs.js";
import { taskTools } from "./tasks.js";
import { visionTools } from "./vision.js";

export function buildTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    // 文档索引工具不依赖 ToolContext（纯本地索引查询），但保持统一签名。
    ...docsTools(),
    ...knowledgeTools(ctx),
    ...deviceTools(ctx),
    ...controlTools(ctx),
    ...logTools(ctx),
    ...taskTools(ctx),
    ...visionTools(ctx)
  ];
}
