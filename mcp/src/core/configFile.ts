import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseDotenv } from "dotenv";

/**
 * 用户级配置：唯一需要用户维护的一份，位于用户主目录下，随插件升级不变。
 *
 * 路径解析规则（没有第二套说法）：
 *   1. HZ_MCP_CONFIG_FILE 显式指定时用它；
 *   2. 否则用 <用户主目录>/.hz-autojs-mcp/config.env。
 */
export const USER_DIR_NAME = ".hz-autojs-mcp";
export const USER_CONFIG_FILE_NAME = "config.env";
export const USER_STATE_DIR_NAME = "state";

export type UserConfigStatus = "loaded" | "missing" | "unreadable";

export interface UserConfigPathInfo {
  path: string;
  /** 是否由 HZ_MCP_CONFIG_FILE 显式指定。 */
  overridden: boolean;
}

export interface UserConfigSnapshot extends UserConfigPathInfo {
  status: UserConfigStatus;
  values: Record<string, string>;
  /** 文件不存在或无权限时的说明，供启动日志与 show 输出使用。 */
  detail: string;
}

export function resolveUserConfigPath(env: NodeJS.ProcessEnv = process.env): UserConfigPathInfo {
  const override = (env.HZ_MCP_CONFIG_FILE ?? "").trim();
  if (override) {
    return { path: resolve(override), overridden: true };
  }
  const home = homedir();
  if (!home) {
    throw new Error("无法确定用户主目录；请用 HZ_MCP_CONFIG_FILE 指定配置文件路径");
  }
  return { path: join(home, USER_DIR_NAME, USER_CONFIG_FILE_NAME), overridden: false };
}

/** 用户级状态目录（项目同步基线等运行时数据），与插件安装目录解耦。 */
export function resolveUserStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = homedir();
  if (!home) {
    throw new Error("无法确定用户主目录；请用 HZ_MCP_STATE_DIR 指定状态目录");
  }
  void env;
  return join(home, USER_DIR_NAME, USER_STATE_DIR_NAME);
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}

/** 读取用户级配置；不存在或读不了都不抛错，由调用方决定如何提示。 */
export function readUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfigSnapshot {
  const info = resolveUserConfigPath(env);
  try {
    const stat = statSync(info.path);
    if (!stat.isFile()) {
      return { ...info, status: "unreadable", values: {}, detail: "路径存在但不是普通文件" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ...info, status: "missing", values: {}, detail: "未找到配置文件" };
    }
    return { ...info, status: "unreadable", values: {}, detail: errorText(error) };
  }
  try {
    const text = readFileSync(info.path, "utf8").replace(/^\uFEFF/, "");
    return { ...info, status: "loaded", values: parseDotenv(text), detail: "已读取" };
  } catch (error) {
    return { ...info, status: "unreadable", values: {}, detail: errorText(error) };
  }
}

/** 敏感键在日志与 show 输出里一律脱敏。 */
export function isSecretKey(key: string): boolean {
  return /secret|token|password/i.test(key);
}

export function maskValue(key: string, value: string): string {
  if (!isSecretKey(key)) return value;
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export interface ExampleEntry {
  key: string;
  value: string;
  /** 该键在模板里的完整块：注释行 + KEY=VALUE 行。 */
  block: string[];
}

/**
 * 解析 config.env.example：按文件顺序取出每个键的注释块与默认值。
 * 同时识别被注释掉的键（# KEY=），用于判断用户文件里"已存在"。
 */
export function parseExampleEntries(text: string): ExampleEntry[] {
  const entries: ExampleEntry[] = [];
  let pending: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) {
      entries.push({ key: match[1], value: match[2], block: [...pending, line] });
      pending = [];
      continue;
    }
    pending.push(line);
  }
  return entries;
}

/** 用户文件里已经出现过的键（有效行或被注释掉的占位行都算）。 */
export function collectPresentKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

export function readExampleTemplate(pluginRoot: string): { path: string; text: string } {
  const templatePath = join(pluginRoot, "config.env.example");
  if (!existsSync(templatePath)) {
    throw new Error(`缺少配置模板：${templatePath}。请确认插件包完整，或改用源码目录运行。`);
  }
  return { path: templatePath, text: readFileSync(templatePath, "utf8").replace(/^\uFEFF/, "") };
}

function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export interface InitResult {
  path: string;
  created: boolean;
  reason: string;
}

/** 首次创建用户级配置：已存在则原样保留，绝不覆盖。 */
export function initUserConfig(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): InitResult {
  const { path } = resolveUserConfigPath(env);
  if (existsSync(path)) {
    return { path, created: false, reason: "已存在，未做任何改动" };
  }
  const template = readExampleTemplate(pluginRoot);
  ensureParentDir(path);
  writeFileSync(path, template.text, { encoding: "utf8", mode: 0o600 });
  return { path, created: true, reason: `已按模板创建：${template.path}` };
}

export interface SyncResult {
  path: string;
  addedKeys: string[];
  created: boolean;
}

/** 新增参数时把模板里缺失的键追加到用户文件；已有键与其值一律不动。 */
export function syncUserConfig(pluginRoot: string, env: NodeJS.ProcessEnv = process.env): SyncResult {
  const template = readExampleTemplate(pluginRoot);
  const entries = parseExampleEntries(template.text);
  const { path } = resolveUserConfigPath(env);
  if (!existsSync(path)) {
    const created = initUserConfig(pluginRoot, env);
    return { path, addedKeys: entries.map(entry => entry.key), created: created.created };
  }
  const current = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const present = collectPresentKeys(current);
  const missing = entries.filter(entry => !present.has(entry.key));
  if (missing.length === 0) {
    return { path, addedKeys: [], created: false };
  }
  const eol = detectEol(current);
  const base = current.endsWith(eol) ? current : current + eol;
  const appended = missing
    .map(entry => entry.block.join(eol))
    .join(eol)
    .replace(/\r?\n/g, eol);
  writeFileSync(path, `${base}${eol}${appended}${eol}`, { encoding: "utf8", mode: 0o600 });
  return { path, addedKeys: missing.map(entry => entry.key), created: false };
}