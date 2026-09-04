const CODE_SENTINEL = "\u0000";

export function escapeLoneDollars(text: string): string {
  const codeSpans: string[] = [];
  const stashed = text.replace(/```[\s\S]*?```|`[^`\n]+`/g, (match) => {
    codeSpans.push(match);
    return `${CODE_SENTINEL}${codeSpans.length - 1}${CODE_SENTINEL}`;
  });
  const escaped = stashed.replace(/(?<!\$)\$(?!\$)/g, "&#36;");
  return escaped.replace(
    new RegExp(`${CODE_SENTINEL}(\\d+)${CODE_SENTINEL}`, "g"),
    (_, i: string) => codeSpans[Number(i)] ?? "",
  );
}
