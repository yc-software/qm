import { marked } from "marked";

export type SetupContent =
  { type: "text"; text: string } | { type: "setup"; toolkit?: string } | { type: "slack" | "slack-account" };

const DIRECTIVES = {
  "::connect-apps{}": "setup",
  "::add-to-slack{}": "slack",
  "::link-slack-account{}": "slack-account",
} as const;
const APP_DIRECTIVE = /^::connect-apps\{toolkit=("?)([a-z0-9_-]{1,100})\1\}$/;

export function setupContent(text: string): SetupContent[] {
  const parts: SetupContent[] = [];
  for (const token of marked.lexer(text)) {
    const raw = token.raw.trim();
    const app = token.type === "paragraph" ? APP_DIRECTIVE.exec(raw) : null;
    if (app) parts.push({ type: "setup", toolkit: app[2]! });
    else if (token.type === "paragraph" && Object.hasOwn(DIRECTIVES, raw))
      parts.push({ type: DIRECTIVES[raw as keyof typeof DIRECTIVES] });
    else {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += token.raw;
      else parts.push({ type: "text", text: token.raw });
    }
  }
  return parts;
}
