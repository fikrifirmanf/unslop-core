export { run } from "./server.mjs";
export { audit, auditSource, matchRule, collectFiles, walk, inside, checkRuleExamples, SKIP_DIRS } from "./audit.mjs";
export { maskComments, syntaxFor, matchBracket, indentedBlock } from "./mask.mjs";
export { runCheck, projectDir, localBin, typescriptCheck, summarizeChecks } from "./exec.mjs";
export { installSkills } from "./install.mjs";

/** Builds an `accept` predicate from a list of extensions, e.g. byExt(".ts", ".py"). */
export const byExt = (...exts) => {
  const set = new Set(exts.map((e) => e.toLowerCase()));
  return (p) => set.has(p.slice(p.lastIndexOf(".")).toLowerCase());
};
