import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import * as prettier from "prettier";
import ts from "typescript";

interface Range {
  pos: number;
  end: number;
  replacement?: string;
}

const DIRECTIVES = [
  "eslint-disable",
  "eslint-enable",
  "@ts-expect-error",
  "@ts-ignore",
  "@ts-nocheck",
  "@ts-check",
  "#__PURE__",
  "@__PURE__",
  "prettier-ignore",
  "# sourceMappingURL",
  "@vite-ignore",
];
const VENDORED = ["src/turns/absurd.sql", "src/persistence/schema-baseline.sql"];

export const isProduction = (path: string) =>
  /\.(ts|tsx|mts|cts|js|mjs|cjs|css|sql)$/.test(path) &&
  !/(^|\/)(test|tests|__tests__|vendor)\/|\.test\.|^(docs|adrs)\//.test(path) &&
  !VENDORED.includes(path);

const isDirective = (text: string) =>
  text.startsWith("/// <reference") || DIRECTIVES.some((d) => text.replace(/^(\/\/|\/\*|--)\s*/, "").startsWith(d));

function scriptComments(path: string, text: string): Range[] {
  const kinds: Record<string, ts.ScriptKind> = { ts: ts.ScriptKind.TS, tsx: ts.ScriptKind.TSX };
  const kind = kinds[path.replace(/^.*\.[cm]?/, "")] ?? ts.ScriptKind.JSX;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const found = new Map<number, Range>();
  const jsxText: Range[] = [];
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push({ pos: node.pos, end: node.end });
    if (ts.isJsxExpression(node) && !node.expression && /^\{\s*\/[*/]/.test(text.slice(node.getStart(file)))) {
      found.set(node.getStart(file), { pos: node.getStart(file), end: node.end, replacement: "{}" });
      return;
    }
    if (node.kind !== ts.SyntaxKind.JsxText)
      for (const range of [
        ...(ts.getLeadingCommentRanges(text, node.pos) ?? []),
        ...(ts.getTrailingCommentRanges(text, node.end) ?? []),
      ])
        found.set(range.pos, range);
    node.getChildren(file).forEach(visit);
  };
  visit(file);
  return [...found.values()].filter((c) => !jsxText.some((t) => c.pos >= t.pos && c.pos < t.end));
}

function lexedComments(text: string, sql: boolean): Range[] {
  const found: Range[] = [];
  let i = 0;
  while (i < text.length) {
    const start = i;
    if (text.startsWith("/*", i)) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth) {
        if (sql && text.startsWith("/*", i)) depth++;
        else if (text.startsWith("*/", i)) depth--;
        else {
          i++;
          continue;
        }
        i += 2;
      }
      found.push({ pos: start, end: i });
    } else if (sql && text.startsWith("--", i)) {
      i = text.indexOf("\n", i) < 0 ? text.length : text.indexOf("\n", i);
      found.push({ pos: start, end: i });
    } else if (text[i] === "'" || text[i] === '"') {
      const quote = text[i];
      const escapes = !sql || /[eE]/.test(text[i - 1] ?? "");
      i++;
      while (i < text.length && text[i] !== quote) i += text[i] === "\\" && escapes ? 2 : 1;
      i++;
    } else if (sql && text[i] === "$" && /^\$\w*\$/.test(text.slice(i, i + 64))) {
      const tag = /^\$\w*\$/.exec(text.slice(i, i + 64))![0];
      const close = text.indexOf(tag, i + tag.length);
      i = close < 0 ? text.length : close + tag.length;
    } else i++;
  }
  return found;
}

export function comments(path: string, text: string): Range[] {
  const all = /\.(css|sql)$/.test(path) ? lexedComments(text, path.endsWith(".sql")) : scriptComments(path, text);
  return all.filter((r) => !isDirective(text.slice(r.pos, r.end)));
}

export function stripComments(path: string, text: string) {
  let out = text;
  for (const { pos, end, replacement } of comments(path, text).sort((a, b) => b.pos - a.pos)) {
    if (replacement !== undefined) {
      out = out.slice(0, pos) + replacement + out.slice(end);
      continue;
    }
    const lineStart = out.lastIndexOf("\n", pos - 1) + 1;
    const newline = out.indexOf("\n", end);
    const lineEnd = newline < 0 ? out.length : newline;
    const before = out.slice(lineStart, pos);
    const after = out.slice(end, lineEnd);
    if (!before.trim() && !after.trim()) out = out.slice(0, lineStart) + out.slice(Math.min(lineEnd + 1, out.length));
    else if (!after.trim()) out = out.slice(0, lineStart + before.trimEnd().length) + out.slice(end);
    else if (/\s$/.test(before)) out = out.slice(0, pos) + out.slice(end).trimStart();
    else out = out.slice(0, pos) + (/^\s/.test(after) ? "" : " ") + out.slice(end);
  }
  return out;
}

async function main() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(isProduction);
  let changed = 0;
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    let out = stripComments(path, text);
    if (out === text) continue;
    const info = await prettier.getFileInfo(path, { ignorePath: ".prettierignore" });
    if (!info.ignored && info.inferredParser)
      out = await prettier.format(out, { ...(await prettier.resolveConfig(path)), filepath: path });
    writeFileSync(path, out);
    changed++;
  }
  console.log(`Stripped comments from ${changed} of ${files.length} production files.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
