import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();

// [client, skills dir, dir whose existence means the client is installed]
const TARGETS = [
  ["claude-code", path.join(home, ".claude", "skills"), path.join(home, ".claude")],
  ["codex", path.join(home, ".codex", "skills"), path.join(home, ".codex")],
  ["antigravity", path.join(home, ".gemini", "config", "skills"), path.join(home, ".gemini")],
  ["antigravity-legacy", path.join(home, ".gemini", "antigravity", "skills"), path.join(home, ".gemini", "antigravity")],
];

/** Copies every skill folder in `skillsDir` into each installed client. `all` installs everywhere. */
export async function installSkills(skillsDir, { all = false } = {}) {
  const names = (await fs.readdir(skillsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  const targets = TARGETS.filter(([, , marker]) => all || existsSync(marker));
  if (!targets.length) targets.push(TARGETS[0]);
  for (const [client, dir] of targets) {
    for (const name of names) {
      const dest = path.join(dir, name);
      await fs.rm(dest, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
      await fs.cp(path.join(skillsDir, name), dest, { recursive: true });
      console.log(`[${client}] skill installed -> ${dest}`);
    }
  }
  const skipped = TARGETS.filter((t) => !targets.includes(t)).map(([c]) => c);
  if (skipped.length) console.log(`Skipped (not installed): ${skipped.join(", ")}. Use --all to install anyway.`);
  console.log("Claude Desktop: upload the skill folder via Settings > Capabilities > Skills (zip), or use the MCP prompt/tool instead.");
}
