import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, type McpRuntime } from "../src/core/mcpServer.ts";
import { DeviceLockManager } from "../src/core/deviceLock.ts";

for (const serverName of ["hz-autojs-device-mcp", "hz-autojs-project-mcp", "hz-autojs-authoring-mcp"]) {
  test(`${serverName} leaves skill discovery to the client instead of injecting the memory body`, async () => {
    const runtime = {
      config: {},
      client: {},
      audit: { log: async () => undefined },
      lockManager: new DeviceLockManager(false)
    } as McpRuntime;
    const server = createMcpServer(runtime, { serverName, version: "test", buildTools: () => [] });
    const client = new Client({ name: "memory-instructions-test", version: "test" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      assert.equal(
        client.getInstructions(),
        undefined,
        "MCP 不应固定注入记忆技能正文；客户端通过正式技能目录发现并按需读取"
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
}
