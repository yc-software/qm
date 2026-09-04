import { assertSafeSkillName } from "./skill-name.ts";

export interface Frontmatter {
  attrs: Record<string, unknown>;
  body: string;
}

function stripQuotes(value: string): string {
  const t = value.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseFlowArray(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map(stripQuotes)
    .filter((s) => s.length > 0);
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && (line[n] === " " || line[n] === "\t")) n++;
  return n;
}

export function parseFrontmatter(raw: string): Frontmatter {
  const source = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const opening = /^---\r?\n/.exec(source);
  if (!opening) throw new Error("frontmatter: file must start with a --- fence");
  const contentStart = opening[0].length;
  const closing = /\r?\n---/.exec(source.slice(contentStart));
  if (!closing) throw new Error("frontmatter: --- fence is not closed");
  const end = contentStart + closing.index;
  const attrs: Record<string, unknown> = {};
  const lines = source.slice(contentStart, end).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2] ?? "";

    if (rest === ">" || rest === "|" || rest === ">-" || rest === "|-") {
      const literal = rest[0] === "|";
      const baseIndent = indentOf(line);
      const collected: string[] = [];
      while (i + 1 < lines.length) {
        const next = lines[i + 1]!;
        if (next.trim() && indentOf(next) <= baseIndent) break;
        collected.push(next.trim() ? next.slice(Math.min(indentOf(next), baseIndent + 2)) : "");
        i++;
      }
      const joined = literal ? collected.join("\n") : collected.join(" ").replace(/\s+/g, " ");
      attrs[key] = joined.trim();
      continue;
    }

    if (rest) {
      attrs[key] = rest.startsWith("[") && rest.endsWith("]") ? parseFlowArray(rest) : stripQuotes(rest);
      continue;
    }

    const baseIndent = indentOf(line);
    const items: string[] = [];
    while (i + 1 < lines.length) {
      const next = lines[i + 1]!;
      if (!next.trim()) break;
      if (indentOf(next) <= baseIndent) break;
      const item = /^\s*-\s+(.*)$/.exec(next);
      if (!item) break;
      items.push(stripQuotes(item[1]!));
      i++;
    }
    attrs[key] = items;
  }

  return { attrs, body: source.slice(end + closing[0].length).replace(/^\s+/, "") };
}

export function parseSeedSkillFrontmatter(raw: string): {
  name: string;
  description: string;
  requiredCapabilities: string[];
  body: string;
} {
  const { attrs, body } = parseFrontmatter(raw);
  const name = attrs.name;
  const description = attrs.description;
  const requiredCapabilities = attrs.requiredCapabilities ?? [];
  if (typeof name !== "string" || !name.trim()) throw new Error("seed skill requires name");
  assertSafeSkillName(name);
  if (typeof description !== "string" || !description.trim())
    throw new Error(`seed skill ${name} requires description`);
  if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.every((c): c is string => typeof c === "string")) {
    throw new Error(`seed skill ${name} requiredCapabilities must be a list of strings`);
  }
  if (!body.trim()) throw new Error(`seed skill ${name} requires a body`);
  return { name, description, requiredCapabilities, body };
}
