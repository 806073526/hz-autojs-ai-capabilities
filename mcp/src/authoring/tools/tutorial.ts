import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { JsonObject, McpToolDefinition, ToolContext, ToolImage } from "../../core/types.js";
import {
  createTool,
  fail,
  guardedHandler,
  objectSchema,
  ok,
  omitUndefined,
  optionalBoolean,
  optionalNumber,
  optionalObject,
  optionalString,
  requireNumber,
  requireString
} from "./common.js";

/**
 * 教程录制作者工具（MCP 写通道）。
 *
 * 链路：Codex → 本工具 → V5 `POST /api/tutorial/**`（默认只接受本机回环请求）→ 设备任务链路 / 录制目录。
 * - 手机端：复用既有设备链路（布局节点、截图、点击 / 滑动 / 输入），自动生成高亮；
 * - 桌面端：写入 Codex / 作者抓好的帧与 DOM 边界高亮、脱敏区域；
 * - 审核（含脱敏）通过后才能发布，发布产物为可导入授权中心的教程包（index.md + steps.json + images）。
 *
 * 权限归类：复用 V5 既有「教程录制」能力，不新增商业授权项。
 */

const NODE_LIMIT_DEFAULT = 40;
const NODE_LIMIT_MAX = 300;
const STEP_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_REVIEWED_BY = "codex-mcp";

const TARGET_VALUES = ["MOBILE", "DESKTOP"];
const STATUS_VALUES = ["RECORDING", "REVIEWED", "PUBLISHED"];

const DEVICE_TOKEN_PROPERTIES: JsonObject = {
  deviceAccessToken: {
    type: "string",
    description: "设备访问令牌；设备启用访问密码时必填（可用设备密码换取，然后复用同一 token）。"
  },
  devicePassword: {
    type: "string",
    description: "设备访问密码（一次性，建议改用 deviceAccessToken）。"
  }
};

const ACTION_SCHEMA: JsonObject = {
  type: "object",
  description: "录制该步之前先执行的设备动作；省略表示只截图（仅截图）。TAP 可以只给 type 并配合 nodeIndex / nodeId / nodeText：服务端会用命中节点的中心作为点击坐标。",
  properties: {
    type: { type: "string", enum: ["TAP", "SWIPE", "INPUT"], description: "动作类型。" },
    x: { type: "number", description: "TAP / SWIPE 起点 X 像素。" },
    y: { type: "number", description: "TAP / SWIPE 起点 Y 像素。" },
    startX: { type: "number", description: "SWIPE 起点 X。" },
    startY: { type: "number", description: "SWIPE 起点 Y。" },
    endX: { type: "number", description: "SWIPE 终点 X。" },
    endY: { type: "number", description: "SWIPE 终点 Y。" },
    durationMs: { type: "number", default: 450, description: "SWIPE 时长毫秒。" },
    text: {
      type: "string",
      description: "INPUT 文本。高级权限（PRIVILEGED）通道走 `input text`，不支持非 ASCII（中文）；中文请改用无障碍模式设备或避免中文输入。"
    },
    clearKeyCount: { type: "number", description: "INPUT 前先发的退格次数（高级权限插入语义）。" }
  },
  required: ["type"]
};

const HIGHLIGHT_SCHEMA: JsonObject = {
  type: "object",
  description: "高亮框（百分比坐标，左上角原点）。手机端可省略，由布局节点自动生成。",
  properties: {
    x: { type: "number" },
    y: { type: "number" },
    width: { type: "number" },
    height: { type: "number" },
    label: { type: "string" }
  }
};

export function tutorialTools(ctx: ToolContext): McpToolDefinition[] {
  return [
    createTool(
      "tutorial_session_create",
      "新建教程录制会话（写操作）。手机端传 target=MOBILE 与 deviceId（用 device_list 查在线设备）；桌面端传 target=DESKTOP。之后用 tutorial_mobile_preview / tutorial_mobile_step 或 tutorial_desktop_step 录步骤，最后 review + publish。",
      objectSchema({
        title: { type: "string", description: "教程标题，例如「如何在 V5 APP 中查看设备信息」。" },
        target: { type: "string", enum: TARGET_VALUES, description: "MOBILE=手机端（复用设备链路），DESKTOP=桌面端（写入抓帧）。" },
        deviceId: { type: "string", description: "手机端录制必填。" },
        appVersion: { type: "string", description: "适用版本，例如 5.2.2；客户端会据此提示重拍。" },
        category: {
          type: "string",
          description: "教程分类（教程包目录层级），例如「投屏」或「投屏/插件与安装」，最多三级；客户端目录树按分类分层，检索结果也带分类名。"
        }
      }, ["title", "target"]),
      async args => createSession(ctx, args)
    ),
    createTool(
      "tutorial_session_update",
      "编辑教程录制会话资料（写操作）：改标题、分类或适用版本。审核后或发布后要调整就用它，改完用 tutorial_session_publish 重新发布覆盖。改标题不换教程包目录，改分类会换目录。",
      objectSchema({
        sessionId: { type: "string" },
        title: { type: "string", description: "新教程标题；不传表示不改。" },
        category: {
          type: "string",
          description: "新分类（教程包目录层级，最多三级），例如「投屏/插件与安装」；传空串表示改回未分类。"
        },
        appVersion: { type: "string", description: "新的适用版本；传空串表示清空。" }
      }, ["sessionId"]),
      async args => updateSession(ctx, args)
    ),
    createTool(
      "tutorial_session_list",
      "列出教程录制会话，或传 sessionId 读取单个会话（含步骤与脱敏记录）。用于挑出待补录 / 待审核 / 待发布的会话。",
      objectSchema({
        sessionId: { type: "string", description: "传则返回该会话详情，不传返回列表。" },
        target: { type: "string", enum: TARGET_VALUES, description: "仅列表模式生效。" },
        status: { type: "string", enum: STATUS_VALUES, description: "仅列表模式生效。" }
      }),
      async args => listSessions(ctx, args)
    ),
    createTool(
      "tutorial_session_delete",
      "删除教程录制会话及其本地步骤图片（写操作，需 HZ_MCP_ENABLE_DANGEROUS_ACTIONS=true；是否弹确认卡由客户端审批模式决定）。仅用于清理录废的会话，不影响已发布教程包。",
      objectSchema({
        sessionId: { type: "string" }
      }, ["sessionId"]),
      async args => deleteSession(ctx, args)
    ),
    createTool(
      "tutorial_mobile_preview",
      "读取手机端当前画面与布局节点（只读设备，不产生步骤）。返回 nodes[]（index / label / className / bounds 百分比 / center 像素）与设备画面；用 nodeIndex 或 nodeText 决定下一步要高亮的控件。",
      objectSchema({
        sessionId: { type: "string", description: "MOBILE 会话。" },
        deviceId: { type: "string", description: "缺省用会话里的设备。" },
        nodeLimit: { type: "number", default: NODE_LIMIT_DEFAULT, description: "最多返回的节点数，最大 300。" },
        includeImage: { type: "boolean", default: true, description: "是否把设备画面作为图片块返回，便于直接观察。" },
        ...DEVICE_TOKEN_PROPERTIES
      }, ["sessionId"]),
      async args => mobilePreview(ctx, args)
    ),
    createTool(
      "tutorial_mobile_step",
      "录制一步手机端教程（写操作）：先执行可选动作（TAP / SWIPE / INPUT），再读取布局节点自动生成高亮并截图落盘。要精确高亮请先调 tutorial_mobile_preview，把命中的 nodeIndex / nodeText 传进来；TAP 只给节点选择器时会自动用节点中心点击，SWIPE / INPUT 仍需显式坐标与文本。动作执行的是动作之后的画面，高亮按该画面生成。",
      objectSchema({
        sessionId: { type: "string" },
        deviceId: { type: "string", description: "缺省用会话里的设备。" },
        nodeIndex: { type: "number", description: "tutorial_mobile_preview 返回的节点序号（优先级最高）。" },
        nodeId: { type: "string", description: "按节点 id 匹配。" },
        nodeText: { type: "string", description: "按节点文本 / 描述包含匹配，例如「设置」。" },
        highlightLabel: { type: "string", description: "高亮标签（读取端步骤卡展示的控件名）。" },
        title: { type: "string", description: "步骤标题。" },
        description: { type: "string", description: "步骤说明（AI 生成文案写这里）。" },
        targetRoute: { type: "string", description: "目标页面，例如 /settings。" },
        appVersion: { type: "string", description: "缺省用会话的适用版本。" },
        action: ACTION_SCHEMA,
        includeImage: { type: "boolean", default: true, description: "是否把本步截图作为图片块返回，便于核对。" },
        ...DEVICE_TOKEN_PROPERTIES
      }, ["sessionId"]),
      async args => mobileStep(ctx, args)
    ),
    createTool(
      "tutorial_desktop_step",
      "写入一步桌面端教程（写操作）：传本地截图路径（imagePath）或 imageBase64 / imageDataUrl，加上 DOM 边界高亮与脱敏区域。图片会连同高亮、脱敏记录一起落盘，发布后进客户端步骤卡。",
      objectSchema({
        sessionId: { type: "string", description: "DESKTOP 会话。" },
        imagePath: { type: "string", description: "本地图片路径（MCP 服务所在机器），推荐用法。" },
        imageBase64: { type: "string", description: "纯 base64 图片内容（不带 data: 前缀）。" },
        imageDataUrl: { type: "string", description: "data:image/...;base64,... 形式。" },
        imageMime: { type: "string", description: "imageBase64 时的 MIME，缺省按 image/png。" },
        title: { type: "string" },
        description: { type: "string" },
        targetRoute: { type: "string" },
        appVersion: { type: "string" },
        highlight: HIGHLIGHT_SCHEMA,
        selector: { type: "string", description: "可读的元素选择器 / 描述，便于回溯。" },
        redactions: {
          type: "array",
          description: "脱敏记录（每项 stepIndex/x/y/width/height/reason，百分比坐标）。",
          items: { type: "object" }
        },
        includeImage: { type: "boolean", default: true, description: "是否把本步图片作为图片块返回，便于核对。" }
      }, ["sessionId", "title"]),
      async args => desktopStep(ctx, args)
    ),
    createTool(
      "tutorial_step_update",
      "修改已录制步骤的文案 / 目标页面 / 适用版本 / 高亮框（写操作）。发布前用它修文案或纠正高亮。",
      objectSchema({
        sessionId: { type: "string" },
        stepIndex: { type: "number", description: "从 1 开始。" },
        title: { type: "string" },
        description: { type: "string" },
        targetRoute: { type: "string" },
        appVersion: { type: "string" },
        highlight: HIGHLIGHT_SCHEMA
      }, ["sessionId", "stepIndex"]),
      async args => updateStep(ctx, args)
    ),
    createTool(
      "tutorial_step_delete",
      "删除某一步并重排序号（写操作）。用于录废重录。",
      objectSchema({
        sessionId: { type: "string" },
        stepIndex: { type: "number", description: "从 1 开始。" }
      }, ["sessionId", "stepIndex"]),
      async args => deleteStep(ctx, args)
    ),
    createTool(
      "tutorial_session_review",
      "人工审核标记（写操作，含脱敏记录）：状态 RECORDING → REVIEWED，未审核不允许发布。有敏感信息时把脱敏区域一并记录，供发布包与审计回溯。",
      objectSchema({
        sessionId: { type: "string" },
        reviewedBy: { type: "string", description: "审核人，缺省 codex-mcp。" },
        redactions: {
          type: "array",
          description: "脱敏记录（每项 stepIndex/x/y/width/height/reason，百分比坐标）。",
          items: { type: "object" }
        }
      }, ["sessionId"]),
      async args => reviewSession(ctx, args)
    ),
    createTool(
      "tutorial_session_publish",
      "发布教程包（写操作）：产出 index.md + steps.json + images 与同名 zip，返回 packagePath / archivePath / contentHash。产物可直接被授权中心「导入 + 发布」链路接受。",
      objectSchema({
        sessionId: { type: "string" }
      }, ["sessionId"]),
      async args => publishSession(ctx, args)
    )
  ];
}

async function createSession(ctx: ToolContext, args: JsonObject) {
  const target = (optionalString(args, "target") || "MOBILE").toUpperCase();
  if (!TARGET_VALUES.includes(target)) {
    return fail("INVALID_ARGUMENT", "target 只能是 MOBILE 或 DESKTOP。");
  }
  const deviceId = optionalString(args, "deviceId");
  if (target === "MOBILE" && !deviceId) {
    return fail("INVALID_ARGUMENT", "手机端录制必须指定 deviceId，可先用 device_list 查看在线设备。");
  }
  return guardedHandler(ctx, "tutorial_session_create", args, { operation: true, deviceId }, async () => {
    const outcome = await ctx.client.post<JsonObject>("/api/tutorial/sessions", omitUndefined({
      title: requireString(args, "title"),
      target,
      deviceId,
      appVersion: optionalString(args, "appVersion"),
      category: optionalString(args, "category")
    }));
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const summary = sessionSummary(outcome.data);
    return ok(
      `已创建${target === "MOBILE" ? "手机端" : "桌面端"}录制会话 ${summary.sessionId}。`,
      {
        ...summary,
        nextHint: target === "MOBILE"
          ? "先 tutorial_mobile_preview 看画面与节点，再 tutorial_mobile_step 逐步录制。"
          : "用 tutorial_desktop_step 写入抓帧（imagePath / imageBase64）。"
      }
    );
  });
}

async function updateSession(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  return guardedHandler(ctx, "tutorial_session_update", args, { operation: true }, async () => {
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}`,
      omitUndefined({
        title: optionalString(args, "title"),
        // 空串是有意义的输入（改回未分类 / 清空版本），不能用 optionalString 丢掉。
        category: editableString(args, "category"),
        appVersion: editableString(args, "appVersion")
      })
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    return ok(
      "会话资料已更新；确认无误后用 tutorial_session_publish 重新发布（同名覆盖）。",
      sessionSummary(outcome.data)
    );
  });
}

/** 可清空的字符串参数：缺省返回 undefined，空串保留为空串（服务端据此清除字段）。 */
function editableString(args: JsonObject, name: string): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    return undefined;
  }
  return String(value).trim();
}

async function listSessions(ctx: ToolContext, args: JsonObject) {
  const sessionId = optionalString(args, "sessionId");
  if (sessionId) {
    const outcome = await ctx.client.get<JsonObject>(`/api/tutorial/sessions/${encodeURIComponent(sessionId)}`);
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    return ok(`会话 ${sessionId} 共 ${(Array.isArray(outcome.data.steps) ? outcome.data.steps.length : 0)} 步。`, {
      ...sessionSummary(outcome.data),
      steps: asArray(outcome.data.steps).map(item => stepSummary(asRecord(item))),
      redactions: asArray(outcome.data.redactions)
    });
  }
  const outcome = await ctx.client.get<JsonObject>("/api/tutorial/sessions");
  if (!outcome.ok || !outcome.data) {
    return outcome;
  }
  const target = optionalString(args, "target");
  const status = optionalString(args, "status");
  const sessions = asArray(outcome.data)
    .map(item => sessionSummary(asRecord(item)))
    .filter(item => (!target || String(item.target) === target) && (!status || String(item.status) === status));
  return ok(`共 ${sessions.length} 个录制会话。`, { sessions });
}

async function deleteSession(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  return guardedHandler(ctx, "tutorial_session_delete", args, { operation: true, dangerous: true }, async () => {
    const outcome = await ctx.client.post<JsonObject>(`/api/tutorial/sessions/${encodeURIComponent(sessionId)}/delete`);
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    return ok(`已删除录制会话 ${sessionId}。`, sessionSummary(outcome.data));
  });
}

async function mobilePreview(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  const deviceId = optionalString(args, "deviceId");
  const includeImage = optionalBoolean(args, "includeImage", true);
  const nodeLimit = clamp(optionalNumber(args, "nodeLimit", NODE_LIMIT_DEFAULT) ?? NODE_LIMIT_DEFAULT, 1, NODE_LIMIT_MAX);
  return guardedHandler(ctx, "tutorial_mobile_preview", args, { operation: true, deviceId }, async () => {
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/device/preview`,
      omitUndefined({ deviceId, nodeLimit }),
      undefined,
      deviceHeaders(args)
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const data = outcome.data;
    const nodes = asArray(data.nodes).map(item => nodeSummary(asRecord(item)));
    const image = includeImage ? imageFromDataUrl(data.imageDataUrl) : undefined;
    return {
      ok: true,
      code: "OK",
      message: `读取到 ${nodes.length} 个布局节点` + (image ? "与设备画面。" : "。"),
      data: {
        sessionId,
        deviceId: data.deviceId ?? deviceId,
        packageName: data.packageName,
        width: data.width,
        height: data.height,
        nodeCount: nodes.length,
        nodes,
        imageIncluded: Boolean(image),
        nextHint: "选定节点后调用 tutorial_mobile_step，传 nodeIndex 或 nodeText；动作先执行、按动作后的画面生成高亮。"
      },
      images: image ? [image] : undefined
    };
  });
}

async function mobileStep(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  const deviceId = optionalString(args, "deviceId");
  const includeImage = optionalBoolean(args, "includeImage", true);
  const action = optionalObject(args, "action");
  return guardedHandler(ctx, "tutorial_mobile_step", args, { operation: true, deviceId }, async () => {
    const body = omitUndefined({
      deviceId,
      nodeIndex: optionalNumber(args, "nodeIndex"),
      nodeId: optionalString(args, "nodeId"),
      nodeText: optionalString(args, "nodeText"),
      highlightLabel: optionalString(args, "highlightLabel"),
      title: optionalString(args, "title"),
      description: optionalString(args, "description"),
      targetRoute: optionalString(args, "targetRoute"),
      appVersion: optionalString(args, "appVersion"),
      action: action ? normalizeAction(action) : undefined
    });
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/steps/mobile`,
      body,
      undefined,
      deviceHeaders(args)
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const step = stepSummary(outcome.data);
    const image = includeImage ? await fetchStepImage(ctx, sessionId, outcome.data.image, deviceHeaders(args)) : undefined;
    return {
      ok: true,
      code: "OK",
      message: `已记录第 ${step.stepIndex} 步：${step.title || step.description || ""}`.trim(),
      data: {
        sessionId,
        ...step,
        imageIncluded: Boolean(image),
        nextHint: "确认截图与高亮无误后继续下一步；全部录完再 tutorial_session_review → tutorial_session_publish。"
      },
      images: image ? [image] : undefined
    };
  });
}

async function desktopStep(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  const includeImage = optionalBoolean(args, "includeImage", true);
  return guardedHandler(ctx, "tutorial_desktop_step", args, { operation: true }, async () => {
    let image: { dataUrl: string; mime: string } | undefined;
    try {
      image = await resolveDesktopImage(args);
    } catch (error) {
      return fail("INVALID_ARGUMENT", error instanceof Error ? error.message : String(error));
    }
    if (!image) {
      return fail("INVALID_ARGUMENT", "必须提供 imagePath、imageBase64 或 imageDataUrl 之一。");
    }
    const body = omitUndefined({
      image: image.dataUrl,
      imageFormat: image.mime === "image/jpeg" ? "jpeg" : "png",
      title: requireString(args, "title"),
      description: optionalString(args, "description"),
      targetRoute: optionalString(args, "targetRoute"),
      appVersion: optionalString(args, "appVersion"),
      selector: optionalString(args, "selector"),
      highlight: optionalObject(args, "highlight"),
      redactions: redactionList(args)
    });
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/steps/desktop`,
      body
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const step = stepSummary(outcome.data);
    const stepImage = includeImage ? await fetchStepImage(ctx, sessionId, outcome.data.image) : undefined;
    return {
      ok: true,
      code: "OK",
      message: `已写入桌面端第 ${step.stepIndex} 步：${step.title || ""}`.trim(),
      data: {
        sessionId,
        ...step,
        imageIncluded: Boolean(stepImage),
        nextHint: "桌面步骤通常成组写入后统一审核、发布。"
      },
      images: stepImage ? [stepImage] : undefined
    };
  });
}

async function updateStep(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  const stepIndex = requireNumber(args, "stepIndex");
  return guardedHandler(ctx, "tutorial_step_update", args, { operation: true }, async () => {
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/steps/${stepIndex}`,
      omitUndefined({
        title: optionalString(args, "title"),
        description: optionalString(args, "description"),
        targetRoute: optionalString(args, "targetRoute"),
        appVersion: optionalString(args, "appVersion"),
        highlight: optionalObject(args, "highlight")
      })
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    return ok(`已更新第 ${stepIndex} 步。`, { sessionId, ...stepSummary(outcome.data) });
  });
}

async function deleteStep(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  const stepIndex = requireNumber(args, "stepIndex");
  return guardedHandler(ctx, "tutorial_step_delete", args, { operation: true }, async () => {
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/steps/${stepIndex}/delete`
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    return ok(`已删除第 ${stepIndex} 步并重排序号。`, {
      ...sessionSummary(outcome.data),
      steps: asArray(outcome.data.steps).map(item => stepSummary(asRecord(item)))
    });
  });
}

async function reviewSession(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  return guardedHandler(ctx, "tutorial_session_review", args, { operation: true }, async () => {
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/review`,
      omitUndefined({
        reviewedBy: optionalString(args, "reviewedBy") || DEFAULT_REVIEWED_BY,
        redactions: redactionList(args)
      })
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const summary = sessionSummary(outcome.data);
    if (String(summary.status) !== "REVIEWED" && String(summary.status) !== "PUBLISHED") {
      return fail("REVIEW_INCOMPLETE", `审核未生效，当前状态 ${summary.status}。`, summary);
    }
    return ok(`会话 ${sessionId} 已标记审核通过（${summary.redactionCount} 条脱敏记录）。`, {
      ...summary,
      nextHint: "调用 tutorial_session_publish 产出可导入授权中心的教程包。"
    });
  });
}

async function publishSession(ctx: ToolContext, args: JsonObject) {
  const sessionId = requireString(args, "sessionId");
  return guardedHandler(ctx, "tutorial_session_publish", args, { operation: true }, async () => {
    const outcome = await ctx.client.post<JsonObject>(
      `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/publish`
    );
    if (!outcome.ok || !outcome.data) {
      return outcome;
    }
    const data = outcome.data;
    return ok(
      `已发布教程包：${data.archivePath ?? data.packagePath ?? ""}（${String(data.stepCount ?? "")} 步，${String(data.imageCount ?? "")} 图）。`,
      {
        ...data,
        nextHint: "产物可直接导入授权中心发布；客户端安装后正文、步骤卡与图片随之可见。"
      }
    );
  });
}

function normalizeAction(action: JsonObject): JsonObject {
  const type = String(action.type ?? "").toUpperCase();
  const normalized: JsonObject = { type };
  for (const key of ["x", "y", "startX", "startY", "endX", "endY", "durationMs", "clearKeyCount"]) {
    const value = action[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }
  if (typeof action.text === "string") {
    normalized.text = action.text;
  }
  return normalized;
}

async function resolveDesktopImage(args: JsonObject): Promise<{ dataUrl: string; mime: string } | undefined> {
  const imagePath = optionalString(args, "imagePath");
  if (imagePath) {
    const bytes = await readFile(imagePath);
    if (!bytes.length) {
      throw new Error(`图片为空: ${imagePath}`);
    }
    if (bytes.length > STEP_IMAGE_MAX_BYTES) {
      throw new Error(`图片超过单张上限 ${STEP_IMAGE_MAX_BYTES} 字节: ${bytes.length}`);
    }
    const mime = mimeByPath(imagePath);
    return { dataUrl: `data:${mime};base64,${bytes.toString("base64")}`, mime };
  }
  const dataUrl = optionalString(args, "imageDataUrl");
  if (dataUrl) {
    if (!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(dataUrl)) {
      throw new Error("imageDataUrl 必须是 data:image/png|jpeg|webp;base64 开头。");
    }
    const mime = /jpe?g/i.test(dataUrl.slice(0, 32)) ? "image/jpeg" : "image/png";
    return { dataUrl, mime };
  }
  const base64 = optionalString(args, "imageBase64");
  if (base64) {
    const mime = optionalString(args, "imageMime") || "image/png";
    if (base64.length * 0.75 > STEP_IMAGE_MAX_BYTES) {
      throw new Error(`图片超过单张上限 ${STEP_IMAGE_MAX_BYTES} 字节。`);
    }
    return { dataUrl: `data:${mime};base64,${base64}`, mime };
  }
  return undefined;
}

function redactionList(args: JsonObject): JsonObject[] | undefined {
  const value = args.redactions;
  if (!Array.isArray(value) || !value.length) {
    return undefined;
  }
  return value.map(item => asRecord(item));
}

async function fetchStepImage(
  ctx: ToolContext,
  sessionId: string,
  image: unknown,
  headers?: JsonObject
): Promise<ToolImage | undefined> {
  const fileName = baseName(String(image ?? ""));
  if (!fileName) {
    return undefined;
  }
  const outcome = await ctx.client.get<JsonObject>(
    `/api/tutorial/sessions/${encodeURIComponent(sessionId)}/images/${encodeURIComponent(fileName)}`,
    undefined,
    headers
  );
  if (!outcome.ok || !outcome.data) {
    return undefined;
  }
  const base64 = String(outcome.data.imageBase64 ?? "").trim();
  if (!base64) {
    return undefined;
  }
  return { data: base64, mimeType: String(outcome.data.mime ?? "image/png") };
}

function deviceHeaders(args: JsonObject): JsonObject | undefined {
  const headers: JsonObject = {};
  const token = optionalString(args, "deviceAccessToken");
  const password = optionalString(args, "devicePassword");
  if (token) {
    headers.deviceAccessToken = token;
  }
  if (password) {
    headers.devicePassword = password;
  }
  return Object.keys(headers).length ? headers : undefined;
}

function imageFromDataUrl(value: unknown): ToolImage | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(text);
  if (!match) {
    return undefined;
  }
  return { data: match[2], mimeType: match[1] };
}

function sessionSummary(session: JsonObject): JsonObject {
  const steps = asArray(session.steps);
  const redactions = asArray(session.redactions);
  return {
    sessionId: session.sessionId,
    title: session.title,
    category: session.category,
    target: session.target,
    status: session.status,
    deviceId: session.deviceId,
    appVersion: session.appVersion,
    stepCount: steps.length,
    redactionCount: redactions.length,
    reviewedBy: session.reviewedBy,
    packagePath: session.packagePath,
    updatedAt: session.updatedAt
  };
}

function stepSummary(step: JsonObject): JsonObject {
  return {
    stepIndex: step.stepIndex,
    title: step.title,
    description: step.description,
    image: step.image,
    highlight: step.highlight,
    targetRoute: step.targetRoute,
    appVersion: step.appVersion,
    recordedFrom: step.recordedFrom,
    sourceNode: step.sourceNode
  };
}

function nodeSummary(node: JsonObject): JsonObject {
  return {
    index: node.index,
    label: node.label,
    className: node.className,
    clickable: node.clickable,
    bounds: node.bounds,
    center: node.center
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

function baseName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).trim();
}

function mimeByPath(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  return "image/png";
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.round(value)));
}
