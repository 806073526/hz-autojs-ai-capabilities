import { appendFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import type { AuditLogger, JsonObject } from "./types.js";

export function createAuditLogger(config: AppConfig): AuditLogger {
  return {
    async log(event: string, payload: JsonObject): Promise<void> {
      if (!config.auditLogPath) {
        return;
      }
      const record = {
        timestamp: new Date().toISOString(),
        event,
        payload
      };
      await appendFile(config.auditLogPath, `${JSON.stringify(record)}\n`, "utf8");
    }
  };
}
