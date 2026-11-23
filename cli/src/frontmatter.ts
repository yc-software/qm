import { parse } from "yaml";

export interface Frontmatter {
  attrs: Record<string, unknown>;
  body: string;
}

export class FrontmatterFenceError extends Error {}

function lineText(source: string, start: number, end: number): string {
  const raw = source.slice(start, end);
  return (raw.endsWith("\r") ? raw.slice(0, -1) : raw).trimEnd();
}

export function parseFrontmatter(raw: string): Frontmatter {
  const source = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  const firstNl = source.indexOf("\n");
  if (firstNl < 0 || lineText(source, 0, firstNl) !== "---") {
    throw new FrontmatterFenceError("frontmatter: file must start with a --- fence");
  }
  let lineStart = firstNl + 1;
  while (lineStart <= source.length) {
    const nextNl = source.indexOf("\n", lineStart);
    const lineEnd = nextNl < 0 ? source.length : nextNl;
    if (lineText(source, lineStart, lineEnd) === "---") {
      const yamlText = source.slice(firstNl + 1, lineStart);
      const afterFence = nextNl < 0 ? source.length : nextNl + 1;
      const parsed: unknown = yamlText.trim() ? parse(yamlText) : {};
      if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
        throw new Error("frontmatter: expected a YAML mapping");
      }
      return {
        attrs: (parsed ?? {}) as Record<string, unknown>,
        body: source.slice(afterFence).trimStart(),
      };
    }
    if (nextNl < 0) break;
    lineStart = nextNl + 1;
  }
  throw new FrontmatterFenceError("frontmatter: --- fence is not closed");
}
