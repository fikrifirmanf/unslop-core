// Comment masking: replaces comment text with spaces (newlines kept) so line numbers stay exact
// and rules scoped to "code" never fire on prose inside comments.

const C_LIKE = { line: ["//"], block: [["/*", "*/"]] };
const HASH = { line: ["#"], block: [] };
const HTML = { line: [], block: [["<!--", "-->"]] };

const SYNTAX = [
  [/\.(?:[cm]?[jt]sx?|java|kts?|cs|go|swift|scala|dart|c|cc|cpp|h|hpp|m|mm|scss|less)$/, { ...C_LIKE, quotes: "\"'`" }],
  [/\.css$/, { line: [], block: [["/*", "*/"]], quotes: "\"'" }],
  [/\.rs$/, { ...C_LIKE, quotes: "\"" }],
  [/\.php$/, { line: ["//", "#"], block: [["/*", "*/"]], quotes: "\"'" }],
  [/\.(?:py|rb|sh|bash|zsh|ya?ml|toml|r|ex|exs|tf)$/, { ...HASH, quotes: "\"'" }],
  [/\.sql$/, { line: ["--"], block: [["/*", "*/"]], quotes: "'\"" }],
  [/\.(?:html?|xml|plist|svg|md|mdx)$/, { ...HTML, quotes: "" }],
  [/\.(?:vue|svelte|astro)$/, { line: ["//"], block: [["/*", "*/"], ["<!--", "-->"]], quotes: "\"'`" }],
];

export function syntaxFor(file) {
  return SYNTAX.find(([re]) => re.test(file))?.[1] ?? null;
}

const blank = (s) => s.replace(/[^\n]/g, " ");

export function maskComments(src, file) {
  const syn = syntaxFor(file);
  if (!syn) return src;
  let out = "";
  let quote = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      // Unterminated single-line strings (apostrophes in JSX text, Rust lifetimes) end at the newline.
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      out += c;
      i++;
      continue;
    }
    if (syn.quotes.includes(c)) {
      quote = c;
      out += c;
      i++;
      continue;
    }
    const blk = syn.block.find(([open]) => src.startsWith(open, i));
    if (blk) {
      const end = src.indexOf(blk[1], i + blk[0].length);
      const stop = end === -1 ? src.length : end + blk[1].length;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    if (syn.line.some((open) => src.startsWith(open, i))) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += blank(src.slice(i, stop));
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Returns the index just past the matching close bracket for the opener at `open`, or -1.
export function matchBracket(src, open, pair = "{}") {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === pair[0]) depth++;
    else if (src[i] === pair[1] && --depth === 0) return i + 1;
  }
  return -1;
}

// Returns the body of the indentation block that starts on the line after `index` (Python, YAML).
export function indentedBlock(src, index) {
  const lineEnd = src.indexOf("\n", index);
  if (lineEnd === -1) return "";
  const head = src.slice(src.lastIndexOf("\n", index) + 1, lineEnd);
  const baseIndent = head.match(/^[ \t]*/)[0].length;
  const lines = [];
  for (const line of src.slice(lineEnd + 1).split("\n")) {
    if (line.trim() === "") {
      lines.push(line);
      continue;
    }
    if (line.match(/^[ \t]*/)[0].length <= baseIndent) break;
    lines.push(line);
  }
  return lines.join("\n");
}
