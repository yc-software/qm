export const RECALL_MAX_CHARS = 6_000;

export function isBullet(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("- ") || t.startsWith("* ");
}

export function bulletText(line: string): string {
  return line
    .trimStart()
    .replace(/^[-*]\s*/, "")
    .trim();
}

export function captureDate(text: string): string | undefined {
  return /^\((\d{4}-\d\d-\d\d)\)/.exec(text)?.[1];
}

export function bullets(body: string): string[] {
  return body.split("\n").filter(isBullet).map(bulletText);
}

export function normalize(line: string): string {
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/^\(\d{4}-\d\d-\d\d\)\s*/, "")
    .trim()
    .toLowerCase();
}

export function dateStr(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export function capTail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(text.length - maxChars) : text;
}

export function memoryBlocks(body: string): string[] {
  const result: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    const text = pending.join("\n").trim();
    if (text) result.push(text);
    pending = [];
  };
  for (const line of body.split("\n")) {
    if (!line.trim() || /^(?:[-*] |#{1,6} )/.test(line)) flush();
    if (line.trim()) pending.push(line);
  }
  flush();
  return result;
}
