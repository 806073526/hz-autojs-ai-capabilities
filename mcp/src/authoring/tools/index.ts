import type { McpToolDefinition, ToolContext } from "../../core/types.js";
import { createTool, objectSchema } from "./common.js";
import { tutorialTools } from "./tutorial.js";

/**
 * 作者工具（教程录制）MCP 工具集。
 *
 * 默认关闭：只有 `HZ_MCP_ENABLE_TUTORIAL_TOOLS=true`（环境变量或用户配置）时才暴露
 * 教程录制写工具，避免把作者侧能力暴露给只需要设备/项目能力的用户。
 */
export function buildAuthoringTools(ctx: ToolContext): McpToolDefinition[] {
  const enabled = ctx.config.enableTutorialTools;
  const statusTool = createTool(
    "tutorial_authoring_status",
    "教程录制作者工具的状态与开关说明（只读）。默认关闭；在 MCP 用户配置或环境变量里设置 HZ_MCP_ENABLE_TUTORIAL_TOOLS=true 后重启 MCP，才会出现 tutorial_session_* / tutorial_mobile_* / tutorial_desktop_step 等录制工具。",
    objectSchema({}),
    async () => ({
      ok: true,
      code: "OK",
      message: enabled
        ? "教程录制作者工具已开启。"
        : "教程录制作者工具当前关闭：设置 HZ_MCP_ENABLE_TUTORIAL_TOOLS=true 后重启 MCP 即可使用。",
      data: {
        enabled,
        enableKey: "HZ_MCP_ENABLE_TUTORIAL_TOOLS",
        tools: enabled
          ? tutorialTools(ctx).map(item => item.name)
          : ["tutorial_session_create", "tutorial_session_list", "tutorial_session_delete", "tutorial_mobile_preview", "tutorial_mobile_step", "tutorial_desktop_step", "tutorial_step_update", "tutorial_step_delete", "tutorial_session_review", "tutorial_session_publish"],
        hint: enabled
          ? "教程录制链路：tutorial_session_create → tutorial_mobile_preview / tutorial_mobile_step（或 tutorial_desktop_step）→ tutorial_session_review → tutorial_session_publish。"
          : "开启后可让 AI 直接录制手机端 / 桌面端教程并发布到授权中心。"
      }
    })
  );
  if (!enabled) {
    return [statusTool];
  }
  return [statusTool, ...tutorialTools(ctx)];
}