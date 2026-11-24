import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Opt-in: records are written only when <workspace>/.doctor-unslop/ already exists
// (`doctor-unslop init` creates it). No source code, messages or snippets are stored.
export const TELEMETRY_DIR = ".doctor-unslop";
export const TELEMETRY_FILE = "telemetry.jsonl";

/** Hash of the workspace-relative path, so one file keeps one key while its content changes. */
export const pathHash = (rel) => createHash("sha256").update(rel.split(path.sep).join("/")).digest("hex").slice(0, 16);

/**
 * Creates a recorder for one server process. One process is treated as one agent session,
 * because a stdio MCP server is not told the client's session id.
 */
export function createTelemetry(server, { sessionId = `sess_${randomUUID().slice(0, 8)}`, now = () => new Date() } = {}) {
  const iterations = new Map();
  return {
    sessionId,
    /** Builds one record per scanned file. Pure; exported for tests. */
    records(result) {
      const byFile = new Map();
      for (const f of result.findings ?? []) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file).push(f);
      }
      return (result._scanned ?? []).map((file) => {
        const hash = pathHash(file);
        const iteration = (iterations.get(hash) ?? 0) + 1;
        iterations.set(hash, iteration);
        const found = byFile.get(file) ?? [];
        return {
          ts: now().toISOString(),
          session_id: sessionId,
          server,
          file_hash: hash,
          iteration,
          triggered_rules: [...new Set(found.map((f) => f.rule_id ?? f.rule))].sort(),
          passed: !found.some((f) => f.severity === "ERROR"),
          ...(result._latencyMs !== undefined ? { latency_ms: result._latencyMs } : {}),
        };
      });
    },
    /** Appends records when the workspace opted in. Never throws: telemetry must not break an audit. */
    async record(root, result) {
      try {
        const dir = path.join(root, TELEMETRY_DIR);
        const stat = await fs.stat(dir).catch(() => null);
        if (!stat?.isDirectory()) return 0;
        const lines = this.records(result);
        if (!lines.length) return 0;
        await fs.appendFile(path.join(dir, TELEMETRY_FILE), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        return lines.length;
      } catch {
        return 0;
      }
    },
  };
}
