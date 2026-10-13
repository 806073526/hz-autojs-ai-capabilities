import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CONFIG_KEYS, describeConfig, loadConfigWithMeta } from "../src/core/config.ts";
import {
  initUserConfig,
  maskValue,
  parseExampleEntries,
  readUserConfig,
  resolveUserConfigPath,
  syncUserConfig
} from "../src/core/configFile.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, "..", "..");
const TEMPLATE_PATH = join(PLUGIN_ROOT, "config.env.example");

function tempConfigPath(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `hz-config-${label}-`));
  return join(dir, "config.env");
}

test("用户级配置路径：默认取用户主目录，可用 HZ_MCP_CONFIG_FILE 覆盖", () => {
  const fallback = resolveUserConfigPath({});
  assert.equal(fallback.path, join(homedir(), ".hz-autojs-mcp", "config.env"));
  assert.equal(fallback.overridden, false);

  const custom = resolveUserConfigPath({ HZ_MCP_CONFIG_FILE: "  D:/tmp/custom.env  " });
  assert.equal(custom.overridden, true);
  assert.ok(custom.path.endsWith("custom.env"));
});

test("用户级配置读取：文件缺失或不可读都不抛错，交给上层提示", () => {
  const missing = readUserConfig({ HZ_MCP_CONFIG_FILE: tempConfigPath("missing") });
  assert.equal(missing.status, "missing");
  assert.deepEqual(missing.values, {});

  const asDirectory = mkdtempSync(join(tmpdir(), "hz-config-dir-"));
  const unreadable = readUserConfig({ HZ_MCP_CONFIG_FILE: asDirectory });
  assert.equal(unreadable.status, "unreadable");
  assert.deepEqual(unreadable.values, {});
});

test("取值优先级：进程环境变量 > 用户级配置 > 代码默认值", () => {
  const path = tempConfigPath("layers");
  writeFileSync(path, "HZ_V5_BASE_URL=http://file-host:1111\nHZ_MCP_READ_ONLY=true\n", "utf8");

  const fromFile = loadConfigWithMeta({ HZ_MCP_CONFIG_FILE: path });
  assert.equal(fromFile.config.v5BaseUrl, "http://file-host:1111");
  assert.equal(fromFile.config.readOnly, true);
  assert.equal(fromFile.keys.find(entry => entry.key === "HZ_V5_BASE_URL")?.source, "config-file");
  assert.equal(fromFile.keys.find(entry => entry.key === "HZ_MCP_READ_ONLY")?.source, "config-file");

  const fromEnv = loadConfigWithMeta({
    HZ_MCP_CONFIG_FILE: path,
    HZ_V5_BASE_URL: "http://env-host:2222",
    HZ_MCP_READ_ONLY: "false"
  });
  assert.equal(fromEnv.config.v5BaseUrl, "http://env-host:2222");
  assert.equal(fromEnv.config.readOnly, false);
  assert.equal(fromEnv.keys.find(entry => entry.key === "HZ_V5_BASE_URL")?.source, "env");
});

test("用户级配置里的空值等于未设置，继续用代码默认值", () => {
  const path = tempConfigPath("empty");
  writeFileSync(path, "HZ_V5_BASE_URL=\nHZ_V5_AUTH_TOKEN=\nHZ_MCP_ENABLE_DEVICE_LOCK=\n", "utf8");
  const result = loadConfigWithMeta({ HZ_MCP_CONFIG_FILE: path });
  assert.equal(result.config.v5BaseUrl, "http://127.0.0.1:9999");
  assert.equal(result.config.v5AuthToken, "");
  assert.equal(result.config.enableDeviceLock, true);
  assert.equal(result.keys.find(entry => entry.key === "HZ_V5_BASE_URL")?.source, "default");
});

test("未知键会被报告，不影响其它键生效", () => {
  const path = tempConfigPath("unknown");
  writeFileSync(path, "HZ_V5_BASE_URL=http://known:9999\nHZ_MCP_NOT_A_KEY=1\n", "utf8");
  const result = loadConfigWithMeta({ HZ_MCP_CONFIG_FILE: path });
  assert.deepEqual(result.unknownKeys, ["HZ_MCP_NOT_A_KEY"]);
  assert.equal(result.config.v5BaseUrl, "http://known:9999");
});

test("敏感值脱敏：show 与日志都不输出完整令牌", () => {
  assert.equal(maskValue("HZ_V5_AUTH_TOKEN", "hzv5abcdefghijFnK8"), "hzv5****FnK8");
  assert.equal(maskValue("HZ_V5_AUTH_TOKEN", "short"), "****");
  assert.equal(maskValue("HZ_V5_BASE_URL", "http://127.0.0.1:9999"), "http://127.0.0.1:9999");

  const path = tempConfigPath("secret");
  writeFileSync(path, "HZ_V5_AUTH_TOKEN=hzv5abcdefghijFnK8\n", "utf8");
  const described = describeConfig({ HZ_MCP_CONFIG_FILE: path });
  const token = described.keys.find(entry => entry.key === "HZ_V5_AUTH_TOKEN");
  assert.equal(token?.value, "hzv5****FnK8");
  assert.equal(token?.secret, true);
  assert.equal(token?.source, "config-file");
  assert.ok(!JSON.stringify(described).includes("hzv5abcdefghijFnK8"));
});

test("config.env.example 覆盖全部配置键，且非空值会被当作配置值使用", () => {
  const text = readFileSync(TEMPLATE_PATH, "utf8");
  const entries = parseExampleEntries(text);
  const keys = entries.map(entry => entry.key);
  assert.equal(new Set(keys).size, keys.length, "模板里不允许出现重复键");
  for (const key of CONFIG_KEYS) {
    assert.ok(keys.includes(key), `模板里缺少配置键：${key}`);
  }
  assert.deepEqual([...keys].sort(), [...CONFIG_KEYS].sort());

  const copyPath = tempConfigPath("template");
  writeFileSync(copyPath, text, "utf8");
  const result = loadConfigWithMeta({ HZ_MCP_CONFIG_FILE: copyPath });
  assert.deepEqual(result.unknownKeys, []);
  for (const entry of entries) {
    if (!entry.value.trim()) continue;
    const report = result.keys.find(item => item.key === entry.key);
    assert.equal(report?.source, "config-file", `模板里的 ${entry.key} 没有生效`);
  }
  assert.equal(result.config.v5BaseUrl, "http://127.0.0.1:9999");
  assert.equal(result.config.mcpClientId, "hz-autojs-device-mcp");
});

test("init 只创建一次，已存在的用户配置不会被覆盖", () => {
  const path = tempConfigPath("init");
  const created = initUserConfig(PLUGIN_ROOT, { HZ_MCP_CONFIG_FILE: path });
  assert.equal(created.created, true);
  assert.equal(readFileSync(path, "utf8"), readFileSync(TEMPLATE_PATH, "utf8"));

  writeFileSync(path, "HZ_V5_BASE_URL=http://mine:9999\n", "utf8");
  const again = initUserConfig(PLUGIN_ROOT, { HZ_MCP_CONFIG_FILE: path });
  assert.equal(again.created, false);
  assert.equal(readFileSync(path, "utf8"), "HZ_V5_BASE_URL=http://mine:9999\n");
});

test("sync 只补缺失参数，已有键与取值保持原样", () => {
  const path = tempConfigPath("sync");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "HZ_V5_BASE_URL=http://mine:9999\n", "utf8");
  const result = syncUserConfig(PLUGIN_ROOT, { HZ_MCP_CONFIG_FILE: path });
  assert.ok(result.addedKeys.includes("HZ_MCP_READ_ONLY"));
  assert.ok(!result.addedKeys.includes("HZ_V5_BASE_URL"));

  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith("HZ_V5_BASE_URL=http://mine:9999"));
  assert.ok(after.includes("HZ_MCP_READ_ONLY=false"));

  const reloaded = loadConfigWithMeta({ HZ_MCP_CONFIG_FILE: path });
  assert.equal(reloaded.config.v5BaseUrl, "http://mine:9999");
  assert.deepEqual(reloaded.unknownKeys, []);

  const second = syncUserConfig(PLUGIN_ROOT, { HZ_MCP_CONFIG_FILE: path });
  assert.deepEqual(second.addedKeys, []);
  assert.equal(readFileSync(path, "utf8"), after);
});

test("sync 遇到尚不存在的用户配置时直接按模板创建", () => {
  const path = tempConfigPath("sync-create");
  assert.equal(existsSync(path), false);
  const result = syncUserConfig(PLUGIN_ROOT, { HZ_MCP_CONFIG_FILE: path });
  assert.equal(result.created, true);
  assert.equal(readFileSync(path, "utf8"), readFileSync(TEMPLATE_PATH, "utf8"));
});