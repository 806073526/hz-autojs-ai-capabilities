import type { ConfirmationDecision, JsonObject, ToolContext, ToolOutcome } from "./types.js";

/**
 * V5 在工具未开放自动调用时返回 PENDING_CONFIRMATION，需要先取得用户决定。
 *
 * 该判定与处置同时服务设备 MCP 和项目 MCP：两端的 canonical 调用都必须先解析
 * 待确认动作，否则用户既看不到就地确认，也拿不到 V5 兜底确认页地址。
 */
export function isPendingConfirmation(outcome: ToolOutcome): boolean {
  const data = asRecord(outcome.data);
  return String(data.status || "").toUpperCase() === "PENDING_CONFIRMATION";
}

/**
 * 以"必要时先确认"的方式调用 canonical tool。
 *
 * 执行成功、非待确认结果和确认后的终态都原样返回，调用方不需要区分这两条路径。
 */
export async function executeCanonicalWithConfirmation(
  ctx: ToolContext,
  canonicalToolName: string,
  params: JsonObject,
  options: { permissionMode?: string } = {}
): Promise<ToolOutcome<JsonObject>> {
  const outcome: ToolOutcome<JsonObject> = await ctx.client.executeCanonicalTool(canonicalToolName, params, {
    permissionMode: options.permissionMode || "FULL_AUTO"
  });
  return isPendingConfirmation(outcome) ? resolvePendingConfirmation(ctx, outcome) : outcome;
}

/**
 * 待确认动作的处置：优先就地 elicitation，无法闭环时透出 V5 兜底确认页地址。
 *
 * 设备访问未满足时不弹确认，直接给出兜底地址：密码必须在 V5 页面输入，
 * 先确认也完不成，避免让用户白点一次。
 */
export async function resolvePendingConfirmation(ctx: ToolContext, outcome: ToolOutcome<JsonObject>): Promise<ToolOutcome<JsonObject>> {
  const data = asRecord(outcome.data) as JsonObject;
  const action = asPendingAction(data.pendingAction);
  const actionId = stringValue(action?.actionId);
  const confirmUrl = stringValue(action?.confirmUrl);
  // 设备访问未满足时，唯一能完成密码校验并写入设备级 MCP 授权的入口是 /#/devices，
  // 必须优先透出它；confirmUrl 指向的确认页只拿一次性 token，无法完成设备授权。
  // 两种来源：WAITING_DEVICE_ACCESS 放在 errorData（data 层），PENDING_CONFIRMATION 放在 pendingAction 里。
  const authorizationUrl = stringValue(action?.authorizationUrl) || stringValue(data.authorizationUrl);
  if (!actionId) {
    return outcome;
  }
  if (action?.deviceAccessSatisfied === false) {
    return deviceAccessOutcome(outcome, action, actionId, authorizationUrl, confirmUrl);
  }
  if (!ctx.config.enableElicitation) {
    return fallbackOutcome(outcome, action, actionId, confirmUrl,
      "MCP 就地确认已关闭，请在 V5 页面处理。");
  }
  if (!ctx.supportsElicitation()) {
    return fallbackOutcome(outcome, action, actionId, confirmUrl,
      "当前客户端不支持就地确认，请在 V5 页面处理。");
  }
  let decision: ConfirmationDecision;
  const elicitStartedAt = Date.now();
  try {
    decision = await ctx.requestConfirmation({
      title: "确认执行设备动作",
      message: `AI 请求执行：${stringValue(action?.title) || canonicalLabel(outcome)}`,
      details: confirmationDetails(action)
    });
  } catch (error) {
    return fallbackOutcome(outcome, action, actionId, confirmUrl,
      error instanceof Error ? error.message : String(error));
  }
  const elicitDurationMs = Date.now() - elicitStartedAt;
  if (decision === "decline") {
    // 客户端把 elicitation 直接短路成 decline 时（例如 Codex Desktop 选择"完全访问"，
    // 对应 approval_policy=never），用户从未看到确认框。这是"别再问我"的预授权，
    // 不是拒绝：按客户端策略自动向 V5 确认执行，而不是把动作判成 USER_DECLINED。
    if (elicitDurationMs < ctx.config.elicitationAutoDeclineMs) {
      if (!ctx.config.autoApproveOnClientPreauthorization) {
        return fallbackOutcome(outcome, action, actionId, confirmUrl,
          `客户端未展示就地确认（${elicitDurationMs}ms 内直接拒绝），已按配置要求人工确认。`);
      }
      const autoConfirmed = await ctx.client.confirmPendingAction(actionId, {
        note: "客户端完全访问策略预授权，自动通过"
      });
      if (!autoConfirmed.ok) {
        return fallbackOutcome(autoConfirmed, action, actionId, confirmUrl, autoConfirmed.message);
      }
      return {
        ok: true,
        code: "OK",
        message: "客户端已预授权（完全访问），动作已自动确认并执行。",
        data: {
          ...data,
          status: "SUCCEEDED",
          autoApprovedByClientPolicy: true,
          result: extractConfirmedResult(autoConfirmed.data)
        }
      };
    }
    await ctx.client.rejectPendingAction(actionId, { note: "用户在 MCP 客户端拒绝" });
    return fail("USER_DECLINED", "用户拒绝执行该动作。", data);
  }
  if (decision === "cancel") {
    return fail("USER_CANCELLED", "用户未完成确认，动作保持待确认。", data);
  }
  const confirmed = await ctx.client.confirmPendingAction(actionId, {});
  if (!confirmed.ok) {
    return fallbackOutcome(confirmed, action, actionId, confirmUrl, confirmed.message);
  }
  return {
    ok: true,
    code: "OK",
    message: "用户已确认并执行完成。",
    data: {
      ...data,
      status: "SUCCEEDED",
      confirmedByUser: true,
      result: extractConfirmedResult(confirmed.data)
    }
  };
}

/**
 * 设备访问未满足时的结果：密码必须在 V5 设备页完成校验，
 * 因此优先透出 authorizationUrl（/#/devices），而不是工具确认页。
 */
function deviceAccessOutcome(outcome: ToolOutcome,
                             action: JsonObject | undefined,
                             actionId: string,
                             authorizationUrl: string,
                             confirmUrl: string): ToolOutcome<JsonObject> {
  const data = asRecord(outcome.data) as JsonObject;
  const target = authorizationUrl || confirmUrl;
  const reason = "该动作需要先完成设备访问授权，请在 V5 设备页输入该设备的访问密码。";
  return {
    ok: false,
    code: "DEVICE_ACCESS_REQUIRED",
    message: target
      ? `${reason} [打开 V5 设备授权页](${target})`
      : `${reason} 未取得设备授权页地址，请提供 actionId ${actionId}。`,
    data: {
      ...data,
      pendingActionId: actionId,
      authorizationUrl: target,
      confirmUrl,
      pendingAction: action,
      fallbackReason: reason
    }
  };
}

function fail(code: string, message: string, data?: JsonObject): ToolOutcome<JsonObject> {
  return { ok: false, code, message, data };
}

function fallbackOutcome(outcome: ToolOutcome,
                         action: JsonObject | undefined,
                         actionId: string,
                         confirmUrl: string,
                         reason: string): ToolOutcome<JsonObject> {
  const data = asRecord(outcome.data) as JsonObject;
  return {
    ok: false,
    code: "PENDING_CONFIRMATION_REQUIRES_V5",
    message: confirmUrl
      ? `${reason} 请打开确认页完成：[打开 V5 确认页](${confirmUrl})`
      : `${reason} 未取得确认页地址，请提供 actionId ${actionId}。`,
    data: {
      ...data,
      pendingActionId: actionId,
      confirmUrl,
      pendingAction: action,
      fallbackReason: reason
    }
  };
}

function canonicalLabel(outcome: ToolOutcome): string {
  const data = asRecord(outcome.data);
  return stringValue(data.toolName) || "工具调用";
}

export function confirmationDetails(action: JsonObject | undefined): string[] {
  if (!action) return [];
  const details: string[] = [];
  const riskLevel = stringValue(action.riskLevel);
  if (riskLevel) details.push(`风险等级：${riskLevel}`);
  const payload = parseMaybeJsonSafe(stringValue(action.payloadJson));
  const parameters = asRecord(payload?.params);
  const deviceId = stringValue(parameters?.deviceId);
  if (deviceId) details.push(`目标设备：${deviceId}`);
  return details;
}

function asPendingAction(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseMaybeJsonSafe(value: unknown): JsonObject | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : undefined;
  } catch (error) {
    return undefined;
  }
}

function extractConfirmedResult(value: unknown): unknown {
  const record = asRecord(value);
  const payload = parseMaybeJsonSafe(record.payloadJson);
  return payload?.execution ?? record;
}
