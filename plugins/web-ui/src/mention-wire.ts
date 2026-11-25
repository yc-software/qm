export function mentionToken(value: string, caret: number): { start: number; end: number; query: string } | null {
  let start = caret;
  while (start > 0 && /[\p{L}\p{N}_.-]/u.test(value[start - 1]!)) start--;
  if (value[start - 1] !== "@") return null;
  start--;
  if (start > 0 && !" \n\t([{\"'".includes(value[start - 1]!)) return null;
  return { start, end: caret, query: value.slice(start + 1, caret) };
}

export function toSlackWire(text: string, wires: Map<string, string>): string {
  const labels = [...wires.keys()].sort((a, b) => b.length - a.length);
  if (!labels.length) return text;
  const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return text.replace(
    new RegExp(`(^|[\\s([{"'])@(${escaped})(?![\\p{L}\\p{N}_])`, "gu"),
    (_m, lead: string, label: string) => `${lead}${wires.get(label)}`,
  );
}
