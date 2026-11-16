const CODE_REGION = /```[\s\S]*?```|`[^`\n]*`/g;
const CODE_PLACEHOLDER = /\u0000CODE(\d+)\u0000/g;

export function extractDirectives<T>(
  reply: string,
  directiveRe: RegExp,
  trailing: RegExp | ((text: string) => string),
  onMatch: (groups: string[]) => T | undefined,
): { text: string; matches: T[] } {
  if (!reply) return { text: reply ?? "", matches: [] };
  const code: string[] = [];
  const masked = reply.replace(CODE_REGION, (m) => `\u0000CODE${code.push(m) - 1}\u0000`);
  const matches: T[] = [];
  let changed = false;
  let text = masked.replace(directiveRe, (_m: string, ...rest: unknown[]) => {
    changed = true;
    const parsed = onMatch(rest.slice(0, -2) as string[]);
    if (parsed !== undefined) matches.push(parsed);
    return "";
  });
  const stripped = typeof trailing === "function" ? trailing(text) : text.replace(trailing, "");
  if (stripped !== text) {
    changed = true;
    text = stripped;
  }
  if (!changed) return { text: reply, matches };
  text = text
    .replace(CODE_PLACEHOLDER, (_m, i: string) => code[Number(i)] ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, matches };
}
