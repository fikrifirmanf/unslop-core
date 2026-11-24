import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { audit } from "./audit.mjs";
import { installSkills } from "./install.mjs";
import { createTelemetry } from "./telemetry.mjs";

const respond = (obj) => {
  if (typeof obj === "string") return { content: [{ type: "text", text: obj }], isError: false };
  const { _failed, _scanned, _latencyMs, ...rest } = obj;
  return { content: [{ type: "text", text: JSON.stringify(rest, null, 2) }], isError: Boolean(_failed) };
};

/**
 * @typedef {{name: string, description: string, inputSchema: object, handler: (args: object, root: string) => Promise<object|string>}} Tool
 * @param {{
 *   packageUrl: URL,          // the server package's package.json
 *   skill: string,            // skill folder name under skills/
 *   description: string,
 *   auditTool: string,
 *   auditDescription: string,
 *   rules: object[],
 *   accept: (p: string) => boolean,  // which files directory/git discovery picks up
 *   tools?: Tool[],
 * }} cfg
 */
export async function run(cfg) {
  const pkg = JSON.parse(readFileSync(fileURLToPath(cfg.packageUrl), "utf8"));
  const pkgDir = path.dirname(fileURLToPath(cfg.packageUrl));
  const skillsDir = path.join(pkgDir, "skills");
  const loadSkill = () => fs.readFile(path.join(skillsDir, cfg.skill, "SKILL.md"), "utf8");
  const loadTool = `load_${cfg.skill.replace(/-/g, "_")}_rules`;
  const tools = cfg.tools ?? [];
  const root = process.cwd();

  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "install-skills") return installSkills(skillsDir, { all: rest.includes("--all") });
  if (cmd === "audit") return cliAudit(rest, root, cfg);
  if (cmd === "rules") {
    for (const r of cfg.rules) console.log(`${r.severity.padEnd(5)} ${r.id.padEnd(32)} ${r.message}`);
    return;
  }
  if (cmd === "--version" || cmd === "-v") return console.log(pkg.version);
  if (cmd === "--help" || cmd === "-h") {
    console.log(`${pkg.name} ${pkg.version}\n\nUsage:\n  ${pkg.name}                     start the MCP server (stdio)\n  ${pkg.name} audit [paths] [--json]  audit files/dirs (default: git changes); exit 1 on FAIL\n  ${pkg.name} rules               list rules\n  ${pkg.name} install-skills [--all]  copy the skill into Claude Code / Codex / Antigravity`);
    return;
  }

  const telemetry = createTelemetry(pkg.name.replace(/-mcp$/, ""));
  const server = new Server({ name: pkg.name, version: pkg.version }, { capabilities: { tools: {}, prompts: {} } });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [{ name: cfg.skill, description: cfg.description }] }));
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== cfg.skill) throw new Error(`Unknown prompt: ${req.params.name}`);
    return { messages: [{ role: "user", content: { type: "text", text: await loadSkill() } }] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: loadTool, description: `Returns the full ${cfg.skill} ruleset. Call before writing code if the ${cfg.skill} skill is not already loaded.`, inputSchema: { type: "object", properties: {} } },
      {
        name: cfg.auditTool,
        description: `${cfg.auditDescription} Accepts files or directories; with no files it audits the git working-tree changes. Suppress a verified false positive with a \`unslop-ignore RULE_ID -- reason\` comment on or above the line.`,
        inputSchema: {
          type: "object",
          properties: { files: { type: "array", items: { type: "string" }, description: "Workspace-relative files or directories. Omit to audit git changes." } },
        },
      },
      ...tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    if (name === loadTool) return respond(await loadSkill());
    if (name === cfg.auditTool) {
      const started = Date.now();
      const result = await audit(args, root, cfg);
      await telemetry.record(root, { ...result, _latencyMs: Date.now() - started });
      return respond(result);
    }
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    try {
      return respond(await tool.handler(args, root));
    } catch (err) {
      return respond({ status: "FAIL", message: `${name} crashed: ${err.message}`, _failed: true });
    }
  });

  await server.connect(new StdioServerTransport());
}

async function cliAudit(argv, root, cfg) {
  const json = argv.includes("--json");
  const result = await audit({ files: argv.filter((a) => !a.startsWith("--")) }, root, cfg);
  const { _failed, _scanned, ...rest } = result;
  if (json) console.log(JSON.stringify(rest, null, 2));
  else {
    for (const f of result.findings) console.log(`${f.file}:${f.line}  ${f.severity.padEnd(5)} ${f.rule}  ${f.message}${f.snippet ? `\n    ${f.snippet}` : ""}`);
    if (result.truncated) console.log(`... ${result.truncated} more findings`);
    console.log(`\n${result.status}: ${result.errors} error(s), ${result.warnings} warning(s) in ${result.filesScanned} file(s) [${result.fileSource}]`);
  }
  process.exitCode = _failed ? 1 : 0;
}
