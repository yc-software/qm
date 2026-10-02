const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface MarkdownFence {
  marker: "`" | "~";
  length: number;
  info: string;
}

export function markdownFence(line: string): MarkdownFence | null {
  const match = FENCE_LINE.exec(line);
  const run = match?.[1];
  const suffix = match?.[2] ?? "";
  if (!run || (run.startsWith("`") && suffix.includes("`"))) return null;
  return {
    marker: run.charAt(0) as MarkdownFence["marker"],
    length: run.length,
    info: suffix.trim(),
  };
}

export function fenceDelimiter(line: string): string | null {
  return markdownFence(line)?.marker ?? null;
}
