import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maskComments, auditSource, audit, checkRuleExamples, byExt, matchBracket, indentedBlock, runCheck, fixHint, createTelemetry, pathHash, TELEMETRY_DIR, TELEMETRY_FILE } from "../src/index.mjs";

test("maskComments blanks comments, keeps strings and line numbers", () => {
  const src = 'const a = "http://x"; // any\n/* :any\n */ const b: any = 1;';
  const out = maskComments(src, "a.ts");
  assert.equal(out.length, src.length);
  assert.equal(out.split("\n").length, 3);
  assert.match(out, /"http:\/\/x"/);
  assert.doesNotMatch(out, /\/\/ any/);
  assert.match(out, /const b: any/);
  assert.equal(maskComments("x = 1  # TODO\ny = '#no'", "a.py"), "x = 1        \ny = '#no'");
  assert.equal(maskComments("SELECT 1 -- hi", "q.sql"), "SELECT 1      ");
  assert.equal(maskComments("a { background: url(http://x) }", "a.css"), "a { background: url(http://x) }");
});

test("apostrophes in JSX text do not swallow later lines", () => {
  const out = maskComments("<p>Don't</p>\n// gone\nconst x: any = 1;", "a.tsx");
  assert.doesNotMatch(out, /gone/);
  assert.match(out, /const x: any/);
});

test("bracket and indent helpers", () => {
  const s = "for (x) { if (y) { a() } b() } c()";
  assert.equal(s.slice(s.indexOf("{"), matchBracket(s, s.indexOf("{"))), "{ if (y) { a() } b() }");
  assert.equal(indentedBlock("for x in y:\n    a()\n    b()\nc()", 0), "    a()\n    b()");
});

const RULE = { id: "NO_ANY", severity: "ERROR", regex: /:\s*any\b/, message: "no any", examples: [{ file: "a.ts", bad: ["let a: any"], good: ["// a: any"] }] };

test("suppressions need a reason", () => {
  const ok = auditSource("// unslop-ignore NO_ANY -- third-party d.ts\nlet a: any;", "a.ts", [RULE]);
  assert.equal(ok.findings.length, 0);
  assert.equal(ok.suppressed[0].reason, "third-party d.ts");
  const bare = auditSource("let a: any; // unslop-ignore NO_ANY", "a.ts", [RULE]);
  assert.equal(bare.findings[0].rule, "SUPPRESSION_WITHOUT_REASON");
});

test("rules respect file filters and examples self-check", () => {
  assert.deepEqual(checkRuleExamples([RULE]), []);
  assert.equal(auditSource("let a: any", "a.py", [{ ...RULE, files: /\.ts$/ }]).findings.length, 0);
  assert.equal(checkRuleExamples([{ ...RULE, examples: [{ file: "a.ts", bad: ["let a = 1"] }] }]).length, 1);
});

test("audit walks directories and refuses paths outside the workspace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unslop-"));
  await fs.mkdir(path.join(dir, "src", "node_modules"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "let a: any;\n");
  await fs.writeFile(path.join(dir, "src", "b.md"), "let a: any;\n");
  await fs.writeFile(path.join(dir, "src", "node_modules", "c.ts"), "let a: any;\n");
  const cfg = { rules: [RULE], accept: byExt(".ts") };
  const r = await audit({ files: ["src"] }, dir, cfg);
  assert.equal(r.status, "FAIL");
  assert.equal(r.filesScanned, 1);
  assert.equal(r.findings[0].file, path.join("src", "a.ts"));
  const out = await audit({ files: ["../etc/passwd"] }, dir, cfg);
  assert.equal(out.findings[0].rule, "OUTSIDE_WORKSPACE");
});

test("missing toolchain is SKIPPED, not FAIL", async () => {
  const r = await runCheck("definitely-not-a-binary-xyz", [], os.tmpdir());
  assert.equal(r.status, "SKIPPED");
});

test("findings carry the shared violation contract fields", async () => {
  const rule = { id: "NO_ANY", severity: "ERROR", regex: /:\s*any\b/, message: "Type escape (': any'). Define explicit types and fix the root cause." };
  const [f] = auditSource("let a: any;", "a.ts", [rule]).findings;
  assert.equal(f.rule_id, "NO_ANY");
  assert.equal(f.rule, "NO_ANY", "legacy field stays for existing skills");
  assert.equal(f.fix_hint, "Define explicit types and fix the root cause.");
  assert.equal(f.line, 1);
  assert.equal(f.file, "a.ts");

  const [bare] = auditSource("let a: any; // unslop-ignore NO_ANY", "a.ts", [rule]).findings;
  assert.equal(bare.rule_id, "SUPPRESSION_WITHOUT_REASON");
  assert.match(bare.fix_hint, /unslop-ignore NO_ANY -- why this is safe/);

  const out = await audit({ files: ["../nope"] }, os.tmpdir(), { rules: [rule], accept: byExt(".ts") });
  assert.equal(out.findings[0].rule_id, "OUTSIDE_WORKSPACE");
  assert.equal(typeof out.findings[0].fix_hint, "string");
});

test("fixHint prefers rule.fix, skips abbreviations, caps length", () => {
  assert.equal(fixHint({ fix: "Use tokens." }, "Bad colour. Something else."), "Use tokens.");
  assert.equal(fixHint(null, "Avoid filler, e.g. Lorem. Write real copy."), "Write real copy.");
  assert.equal(fixHint(null, "Too many mocks."), "Too many mocks.");
  const long = fixHint(null, `Bad. ${"word ".repeat(80)}`);
  assert.ok(long.length <= 200, `got ${long.length}`);
  assert.ok(long.endsWith("…"));
});

test("telemetry keys by path, counts iterations, and stays off unless opted in", async () => {
  const t = createTelemetry("x-unslop", { sessionId: "sess_t", now: () => new Date("2026-11-24T00:00:00Z") });
  const fail = { _scanned: ["a.ts", "b.ts"], findings: [{ file: "a.ts", rule_id: "R1", severity: "ERROR" }, { file: "a.ts", rule_id: "R2", severity: "WARN" }] };
  const [a1, b1] = t.records(fail);
  assert.deepEqual(a1.triggered_rules, ["R1", "R2"]);
  assert.equal(a1.passed, false);
  assert.equal(b1.passed, true);
  assert.equal(a1.file_hash, pathHash("a.ts"));
  const [a2] = t.records({ _scanned: ["a.ts"], findings: [{ file: "a.ts", rule_id: "R2", severity: "WARN" }] });
  assert.equal(a2.iteration, 2);
  assert.equal(a2.passed, true, "WARN-only file passes");
  assert.equal(a2.file_hash, a1.file_hash);

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "unslop-tel-"));
  assert.equal(await t.record(dir, fail), 0);
  await assert.rejects(fs.access(path.join(dir, TELEMETRY_DIR)));
  await fs.mkdir(path.join(dir, TELEMETRY_DIR));
  assert.equal(await t.record(dir, fail), 2);
  const lines = (await fs.readFile(path.join(dir, TELEMETRY_DIR, TELEMETRY_FILE), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.ok(!JSON.stringify(lines).includes("a.ts"), "raw paths are not stored");
});
