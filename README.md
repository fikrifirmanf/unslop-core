# unslop-core

> The shared engine behind the `*-unslop-mcp` servers: comment-aware audits, suppressions with reasons, git-change discovery, toolchain checks, a CLI mode and a skill installer.

[![npm](https://img.shields.io/npm/v/unslop-core?color=cb3837&logo=npm)](https://www.npmjs.com/package/unslop-core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

You only need this package to build a new unslop server. To use one, install a server:

| Server | Audits |
| --- | --- |
| [`frontend-unslop-mcp`](https://github.com/fikrifirmanf/frontend-unslop-mcp) | React, Next.js, Tailwind engineering |
| [`backend-unslop-mcp`](https://github.com/fikrifirmanf/backend-unslop-mcp) | APIs, SQL, security across 9 languages |
| [`ui-unslop-mcp`](https://github.com/fikrifirmanf/ui-unslop-mcp) | Visual craft, WCAG contrast, a11y, design tokens |
| [`mobile-unslop-mcp`](https://github.com/fikrifirmanf/mobile-unslop-mcp) | iOS, Android, React Native, Flutter, app manifests |
| [`copy-unslop-mcp`](https://github.com/fikrifirmanf/copy-unslop-mcp) | Copywriting (EN + ID), readability, length budgets |
| [`test-unslop-mcp`](https://github.com/fikrifirmanf/test-unslop-mcp) | Fake/flaky tests, real test runs |

## Building a server

```js
#!/usr/bin/env node
import { run, byExt } from "unslop-core";

await run({
  packageUrl: new URL("../package.json", import.meta.url), // name + version come from here
  skill: "docs-unslop",                                    // skills/docs-unslop/SKILL.md
  description: "Docs anti-slop rules.",
  auditTool: "audit_docs_slop",
  auditDescription: "Scans docs for ...",
  accept: byExt(".md", ".mdx"),                            // what directory/git discovery picks up
  rules: [
    {
      id: "NO_TODO",
      severity: "ERROR",                 // ERROR fails the audit, WARN reports only
      scope: "raw",                      // default "code" masks comments first
      regex: /\bTODO\b/,                 // or check(src, file) => [{ index, message? }]
      files: /\.mdx?$/,                  // optional include / exclude filters
      message: "Unfinished TODO.",
      examples: [{ file: "a.md", bad: ["TODO: write"], good: ["Done."] }],
    },
  ],
  tools: [{ name, description, inputSchema, handler: async (args, root) => ({ status: "PASS" }) }],
});
```

That one call gives the server:

- an MCP prompt and a `load_<skill>_rules` tool serving the SKILL.md;
- the audit tool, accepting files or directories, or defaulting to git working-tree changes. Directory walks honour `.gitignore` and skip `node_modules`, build output and minified files;
- `unslop-ignore RULE_ID -- reason` suppressions (a missing reason is itself an error), with every honoured suppression echoed in the output;
- a CLI: `audit [paths] [--json]` (exit 1 on ERROR), `rules`, `install-skills [--all]`, `--version`.

Tool handlers return a plain object; set `_failed: true` to mark the MCP result as an error.

## Helpers

| Export | Purpose |
| --- | --- |
| `checkRuleExamples(rules)` | Returns problems where a `bad` example is missed or a `good` one flagged. Use it as your rule test. |
| `maskComments(src, file)` | Blanks comments (keeping offsets and newlines) for 20+ languages |
| `matchBracket`, `indentedBlock` | Extract brace- or indentation-delimited bodies for structural rules |
| `collectFiles`, `walk`, `inside` | Workspace-safe file discovery |
| `runCheck(cmd, args, cwd, opts)` | Runs a toolchain; a missing binary is `SKIPPED`, not `FAIL` |
| `typescriptCheck`, `localBin`, `projectDir`, `summarizeChecks` | Compile-check building blocks |

## License

MIT © Fikri Firman Fadilah

## Violation contract and telemetry (1.1)

Every finding now carries `rule_id` and `fix_hint` next to the existing fields. `rule` stays for existing skills.

- `fix_hint` comes from the rule's optional `fix` field. Without one, it is the rule's message after its first sentence ("Problem. Fix."). It is capped at 200 chars.
- When the workspace has a `.doctor-unslop/` directory, the audit tool appends one privacy-safe line per scanned file to `.doctor-unslop/telemetry.jsonl` for `doctor-unslop loops`. Without that directory, nothing is written.
