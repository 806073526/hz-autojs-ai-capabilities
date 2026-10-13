import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AppConfig } from "./config.js";

export interface HttpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  touchedAt: number;
}

export interface HttpRunner {
  close: () => Promise<void>;
}

export type ServerFactory = () => Server;

export async function startStdio(factory: ServerFactory): Promise<void> {
  const server = factory();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function startHttp(
  factory: ServerFactory,
  config: AppConfig,
  serverName: string
): Promise<HttpRunner> {
  const sessions = new Map<string, HttpSession>();
  const httpServer = createServer((req, res) => {
    void handleHttpRequest(factory, config, serverName, sessions, req, res).catch(error => {
      writeJson(res, 500, {
        ok: false,
        code: "MCP_HTTP_ERROR",
        message: error instanceof Error ? error.message : String(error)
      });
    });
  });

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.touchedAt > config.httpSessionIdleMs) {
        sessions.delete(sessionId);
        void session.server.close().catch(error => {
          writeStderr(serverName, `HTTP MCP session cleanup failed: ${errorMessage(error)}`);
        });
      }
    }
  }, Math.min(config.httpSessionIdleMs, 60000));
  cleanupTimer.unref();

  await listen(httpServer, config.httpPort, config.httpHost);
  warnIfHttpExposedWithoutToken(config, serverName);
  writeStderr(serverName, `HTTP MCP listening on http://${config.httpHost}:${config.httpPort}${config.httpPath}`);

  return {
    close: async () => {
      clearInterval(cleanupTimer);
      await Promise.allSettled([...sessions.values()].map(session => session.server.close()));
      sessions.clear();
      await closeHttpServer(httpServer);
    }
  };
}

async function handleHttpRequest(
  factory: ServerFactory,
  config: AppConfig,
  serverName: string,
  sessions: Map<string, HttpSession>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = requestUrl(req);
  if (url.pathname === "/health") {
    writeJson(res, 200, {
      ok: true,
      name: serverName,
      transport: "http",
      path: config.httpPath,
      sessions: sessions.size
    });
    return;
  }

  if (url.pathname !== config.httpPath) {
    writeJson(res, 404, {
      ok: false,
      code: "NOT_FOUND",
      message: `HTTP MCP endpoint is ${config.httpPath}`
    });
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, { Allow: "GET, POST, DELETE, OPTIONS" });
    res.end();
    return;
  }

  if (!isAuthorized(config, req)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": "Bearer"
    });
    res.end(JSON.stringify({
      ok: false,
      code: "UNAUTHORIZED",
      message: "HTTP MCP 需要 Authorization: Bearer <HZ_MCP_HTTP_AUTH_TOKEN>"
    }));
    return;
  }

  const sessionId = headerText(req, "mcp-session-id");
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session) {
    writeJson(res, 404, {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null
    });
    return;
  }

  if (session) {
    session.touchedAt = Date.now();
    await session.transport.handleRequest(req, res);
    return;
  }

  await handleNewHttpSession(factory, config, serverName, sessions, req, res);
}

async function handleNewHttpSession(
  factory: ServerFactory,
  config: AppConfig,
  serverName: string,
  sessions: Map<string, HttpSession>,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let sessionId: string | undefined;
  let server: Server;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: config.httpJsonResponse,
    onsessioninitialized: initializedSessionId => {
      sessionId = initializedSessionId;
      sessions.set(initializedSessionId, { server, transport, touchedAt: Date.now() });
    },
    onsessionclosed: closedSessionId => {
      sessions.delete(closedSessionId);
    }
  });
  transport.onerror = error => {
    writeStderr(serverName, `HTTP MCP transport error: ${error.message}`);
  };

  server = factory();
  await server.connect(transport);
  await transport.handleRequest(req, res);

  if (!sessionId) {
    await server.close().catch(error => {
      writeStderr(serverName, `HTTP MCP temporary session close failed: ${errorMessage(error)}`);
    });
  }
}

/**
 * 按配置启动传输层。
 *
 * stdio 是插件场景的主通道，失败必须致命，客户端需要立即感知。
 * HTTP 是独立部署的附加通道；端口被占用时只降级为警告，不能拖垮已经建立的 stdio 通道。
 * 纯 http 模式下 HTTP 失败仍然是致命的。
 */
export async function startTransports(
  factory: ServerFactory,
  config: AppConfig,
  serverName: string
): Promise<HttpRunner[]> {
  const runners: HttpRunner[] = [];
  const wantsStdio = config.transportMode === "stdio" || config.transportMode === "both";
  const wantsHttp = config.transportMode === "http" || config.transportMode === "both";

  if (wantsStdio) {
    await startStdio(factory);
  }
  if (wantsHttp) {
    try {
      runners.push(await startHttp(factory, config, serverName));
    } catch (error) {
      if (!wantsStdio) {
        throw error;
      }
      writeStderr(serverName, `HTTP transport 启动失败，已降级为 stdio-only: ${errorMessage(error)}`);
    }
  }
  installShutdownHandlers(runners, serverName);
  return runners;
}

export function installShutdownHandlers(runners: HttpRunner[], serverName: string): void {
  const shutdown = (signal: NodeJS.Signals) => {
    void (async () => {
      writeStderr(serverName, `Received ${signal}, shutting down MCP server`);
      await Promise.allSettled(runners.map(runner => runner.close()));
      process.exit(0);
    })();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export function writeStderr(serverName: string, message: string): void {
  process.stderr.write(`[${serverName}] ${message}\n`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestUrl(req: IncomingMessage): URL {
  const host = headerText(req, "host") || "127.0.0.1";
  return new URL(req.url || "/", `http://${host}`);
}

function isAuthorized(config: AppConfig, req: IncomingMessage): boolean {
  if (!config.httpAuthToken) return true;
  return headerText(req, "authorization") === `Bearer ${config.httpAuthToken}`;
}

function headerText(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" && value ? value : undefined;
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function listen(server: NodeHttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeHttpServer(server: NodeHttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function warnIfHttpExposedWithoutToken(config: AppConfig, serverName: string): void {
  if (!config.httpAuthToken && !isLoopbackHost(config.httpHost)) {
    writeStderr(serverName, "WARNING: HTTP MCP is not bound to loopback and HZ_MCP_HTTP_AUTH_TOKEN is empty.");
  }
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}
