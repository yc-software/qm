export const MAX_RENDERED_FORWARDS = 5;

export function bracketedLine(label: string, body: string): string {
  return body ? `[${label}] ${body}` : `[${label}]`;
}

export function forwardLabel(origin: { author?: string; channel?: string }): string {
  return `forwarded message${origin.author ? ` from ${origin.author}` : ""}${origin.channel ? ` in ${origin.channel}` : ""}`;
}

export function appendRenderedLines(base: string, lines: readonly string[]): string {
  if (!lines.length) return base;
  return base ? `${base}\n${lines.join("\n")}` : lines.join("\n");
}
