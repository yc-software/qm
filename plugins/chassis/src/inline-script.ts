import { createHash } from "node:crypto";

export function inlineScript(source: string): { text: string; hash: string } {
  const text = source.replace(/\r\n?/g, "\n");
  const hash = `sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`;
  return { text, hash };
}
