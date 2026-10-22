import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { inside } from "./audit.mjs";

const execFileAsync = promisify(execFile);

/**
 * Runs a toolchain command. A missing binary is SKIPPED (not FAIL) so agents do not loop on
 * environment problems they cannot fix.
 * @returns {Promise<{status: "PASS"|"FAIL"|"SKIPPED", cmd: string, output?: string}>}
 */
export async function runCheck(cmd, args, cwd, { timeout = 180_000, label, env } = {}) {
  const shown = label || `${cmd} ${args.join(" ")}`.slice(0, 300);
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { cwd, timeout, maxBuffer: 20 * 1024 * 1024, ...(env ? { env } : {}) });
    return { status: "PASS", cmd: shown, output: `${stdout}\n${stderr}`.trim().slice(-4000) || undefined };
  } catch (err) {
    if (err.code === "ENOENT") return { status: "SKIPPED", cmd: shown, output: `\`${cmd}\` is not installed or not on PATH.` };
    const output = `${err.stdout || ""}\n${err.stderr || ""}`.trim() || err.message;
    return { status: "FAIL", cmd: shown, output: (err.killed ? `Timed out after ${timeout / 1000}s.\n` : "") + output.slice(-20000) };
  }
}

/** Resolves a workspace-relative project dir; returns null if it escapes the workspace. */
export function projectDir(root, projectRoot) {
  const cwd = path.resolve(root, projectRoot || ".");
  return inside(root, cwd) ? cwd : null;
}

/** Locally installed binary in node_modules/.bin, searched upward to the workspace root. */
export function localBin(cwd, root, name) {
  for (let dir = cwd; inside(root, dir); dir = path.dirname(dir)) {
    const p = path.join(dir, "node_modules", ".bin", name);
    if (existsSync(p)) return p;
    if (dir === path.dirname(dir)) break;
  }
  return null;
}

export async function typescriptCheck(cwd, root) {
  const tsc = localBin(cwd, root, "tsc");
  if (!tsc) return { lang: "typescript", status: "SKIPPED", cmd: "tsc --noEmit", output: "typescript is not installed in this project (npm i -D typescript)." };
  return { lang: "typescript", ...(await runCheck(tsc, ["--noEmit", "--pretty", "false"], cwd, { label: "tsc --noEmit" })) };
}

/** Folds check results into one tool response. SKIPPED never fails, but is reported. */
export function summarizeChecks(checks, { none = "No toolchain detected in projectRoot; nothing to verify." } = {}) {
  if (!checks.length) return { status: "PASS", message: none, _failed: false };
  const failed = checks.filter((c) => c.status === "FAIL");
  const ran = checks.filter((c) => c.status !== "SKIPPED");
  return {
    status: failed.length ? "FAIL" : ran.length ? "PASS" : "SKIPPED",
    checks: checks.map((c) => (c.status === "PASS" ? { ...c, output: undefined } : c)),
    instruction: failed.length
      ? "Fix every reported error and re-run until PASS."
      : ran.length
        ? "All available checks passed."
        : "No check could run because the toolchain is missing. Tell the user verification was skipped; do not claim it passed.",
    _failed: failed.length > 0,
  };
}
