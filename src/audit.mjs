import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { maskComments } from "./mask.mjs";

const execFileAsync = promisify(execFile);

export const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".svelte-kit", ".turbo", ".venv", "venv", "__pycache__",
  "dist", "build", "out", "coverage", "target", "vendor", "Pods", "DerivedData", ".gradle", ".dart_tool",
]);
const MAX_BYTES = 1_000_000;
const MAX_FINDINGS = 300;
const SUPPRESS = /unslop-ignore\s+([A-Z0-9_]+(?:\s*,\s*[A-Z0-9_]+)*)(?:\s*(?:--|:)\s*(\S[^\n]*?))?\s*(?:\*\/|-->)?\s*$/;

export const inside = (root, p) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export async function walk(dir, accept, out = [], depth = 0) {
  if (depth > 12) return out;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (SKIP_DIRS.has(e.name) || (e.name.startsWith(".") && e.isDirectory())) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, accept, out, depth + 1);
    else if (accept(p)) out.push(p);
  }
  return out;
}

// Directory expansion honours .gitignore when the dir is inside a git work tree.
async function gitListed(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z", "."], { cwd: dir, maxBuffer: 50 * 1024 * 1024 });
    return stdout.split("\0").filter(Boolean).map((f) => path.join(dir, f));
  } catch {
    return null;
  }
}

const isSkipped = (p) => p.split(path.sep).some((seg) => SKIP_DIRS.has(seg));

async function expandDir(dir, accept) {
  const listed = await gitListed(dir);
  return listed ? listed.filter((p) => accept(p) && !isSkipped(p)) : walk(dir, accept);
}

// Minified/bundled output: a very long line or a very high average line length.
export function looksGenerated(raw, file) {
  if (/\.min\.\w+$|[.-]bundle\.\w+$|\.d\.ts$|\.lock$/.test(file)) return true;
  const lines = raw.split("\n");
  return lines.some((l) => l.length > 3000) || (raw.length > 5000 && raw.length / lines.length > 250);
}

async function gitChanged(root) {
  try {
    const opts = { cwd: root, maxBuffer: 10 * 1024 * 1024 };
    const top = (await execFileAsync("git", ["rev-parse", "--show-toplevel"], opts)).stdout.trim();
    const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall", "--no-renames"], opts);
    return stdout
      .split("\n")
      .filter((l) => l.length > 3 && !l.startsWith(" D") && !l.startsWith("D "))
      .map((l) => path.join(top, l.slice(3).replace(/^"|"$/g, "")));
  } catch {
    return null;
  }
}

/**
 * Resolves files/directories (or, when empty, the git working-tree changes) into auditable paths.
 * @returns {Promise<{files: string[], errors: object[], source: string}>}
 */
export async function collectFiles(inputs, root, accept) {
  const errors = [];
  let source = "input";
  let candidates = inputs;
  if (!candidates.length) {
    const changed = await gitChanged(root);
    if (changed === null) return { files: [], errors: [{ file: ".", line: 0, rule: "NO_FILES", severity: "ERROR", message: "No files given and the workspace is not a git repository. Pass `files` (files or directories)." }], source: "none" };
    candidates = changed;
    source = "git-changes";
  }
  const files = new Set();
  for (const rel of candidates) {
    const full = path.resolve(root, rel);
    if (!inside(root, full)) {
      if (source === "input") errors.push({ file: rel, line: 0, rule: "OUTSIDE_WORKSPACE", severity: "ERROR", message: "Path is outside the workspace." });
      continue;
    }
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) {
      errors.push({ file: rel, line: 0, rule: "FILE_MISSING", severity: "ERROR", message: "File could not be read." });
      continue;
    }
    if (stat.isDirectory()) for (const f of await expandDir(full, accept)) files.add(f);
    else if (source === "input" || accept(full)) files.add(full);
  }
  return { files: [...files], errors, source };
}

const globalize = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

/** Runs one rule against one file's text. Returns [{index, text}] matches. */
export function matchRule(rule, raw, file) {
  if (rule.files && !rule.files.test(file)) return [];
  if (rule.exclude && rule.exclude.test(file)) return [];
  const src = rule.scope === "raw" ? raw : maskComments(raw, file);
  if (rule.check) return rule.check(src, file, raw) ?? [];
  return [...src.matchAll(globalize(rule.regex))].map((m) => ({ index: m.index, text: m[0] }));
}

function lineOf(src, index) {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function suppression(lines, line, ruleId) {
  for (const l of [lines[line - 1], lines[line - 2]]) {
    const m = l && l.match(SUPPRESS);
    if (m && m[1].split(/\s*,\s*/).includes(ruleId)) return { reason: m[2]?.trim() || null };
  }
  return null;
}

export function auditSource(raw, file, rules) {
  const findings = [];
  const suppressed = [];
  const lines = raw.split("\n");
  for (const rule of rules) {
    for (const m of matchRule(rule, raw, file)) {
      const line = lineOf(raw, m.index);
      const finding = {
        file,
        line,
        rule: rule.id,
        severity: rule.severity,
        message: m.message || rule.message,
        snippet: (lines[line - 1] ?? m.text ?? "").trim().slice(0, 140),
      };
      const s = suppression(lines, line, rule.id);
      if (s?.reason) suppressed.push({ file, line, rule: rule.id, reason: s.reason });
      else if (s) findings.push({ ...finding, severity: "ERROR", rule: "SUPPRESSION_WITHOUT_REASON", message: `unslop-ignore ${rule.id} needs a reason: \`unslop-ignore ${rule.id} -- why this is safe\`.` });
      else findings.push(finding);
    }
  }
  return { findings, suppressed };
}

/**
 * @param {{files?: string[]}} args
 * @param {string} root workspace root; paths cannot escape it
 * @param {{rules: object[], accept: (p: string) => boolean}} cfg
 */
export async function audit(args, root, cfg) {
  const inputs = Array.isArray(args.files) ? args.files.filter((f) => typeof f === "string" && f) : [];
  const { files, errors, source } = await collectFiles(inputs, root, cfg.accept);
  const findings = [...errors];
  const suppressed = [];
  const skippedGenerated = [];
  const explicit = new Set(inputs.map((f) => path.resolve(root, f)));
  for (const full of files) {
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || stat.size > MAX_BYTES) continue;
    const raw = await fs.readFile(full, "utf8").catch(() => null);
    if (raw === null || raw.includes("\u0000")) continue;
    if (!explicit.has(full) && looksGenerated(raw, full)) {
      skippedGenerated.push(path.relative(root, full));
      continue;
    }
    const r = auditSource(raw, path.relative(root, full) || path.basename(full), cfg.rules);
    findings.push(...r.findings);
    suppressed.push(...r.suppressed);
  }
  findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "ERROR" ? -1 : 1));
  const errorCount = findings.filter((f) => f.severity === "ERROR").length;
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  const failed = errorCount > 0;
  return {
    status: failed ? "FAIL" : "PASS",
    filesScanned: files.length - skippedGenerated.length,
    ...(skippedGenerated.length ? { skippedGenerated: skippedGenerated.slice(0, 20) } : {}),
    fileSource: source,
    errors: errorCount,
    warnings: findings.length - errorCount,
    byRule,
    findings: findings.slice(0, MAX_FINDINGS),
    ...(findings.length > MAX_FINDINGS ? { truncated: findings.length - MAX_FINDINGS } : {}),
    ...(suppressed.length ? { suppressed } : {}),
    instruction: failed
      ? "Fix every ERROR finding at its root cause and re-run the audit. Use `unslop-ignore RULE_ID -- reason` only for verified false positives."
      : files.length - skippedGenerated.length === 0
        ? "No matching files were scanned. Pass the modified files or directories explicitly."
        : "All anti-slop checks passed. Review WARN findings before finishing.",
    _failed: failed,
  };
}

/** Verifies every rule's `examples`: each `bad` snippet must trigger the rule and each `good` must not. */
export function checkRuleExamples(rules) {
  const problems = [];
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) problems.push(`${rule.id}: duplicate rule id`);
    ids.add(rule.id);
    if (!rule.examples?.length) problems.push(`${rule.id}: no examples`);
    for (const ex of rule.examples ?? []) {
      for (const bad of ex.bad ?? []) if (!matchRule(rule, bad, ex.file).length) problems.push(`${rule.id}: missed bad example in ${ex.file}: ${JSON.stringify(bad)}`);
      for (const good of ex.good ?? []) if (matchRule(rule, good, ex.file).length) problems.push(`${rule.id}: flagged good example in ${ex.file}: ${JSON.stringify(good)}`);
    }
  }
  return problems;
}
