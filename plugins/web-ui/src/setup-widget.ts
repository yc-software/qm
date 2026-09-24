import { marked } from "marked";

export type SetupContent = { type: "text"; text: string } | { type: "setup" | "slack" | "slack-account" };

export function setupContent(text: string): SetupContent[] {
  const parts: SetupContent[] = [];
  for (const token of marked.lexer(text)) {
    if (
      token.type === "paragraph" &&
      ["::connect-apps{}", "::add-to-slack{}", "::link-slack-account{}"].includes(token.raw.trim())
    ) {
      const type = {
        "::connect-apps{}": "setup",
        "::add-to-slack{}": "slack",
        "::link-slack-account{}": "slack-account",
      } as const;
      parts.push({ type: type[token.raw.trim() as keyof typeof type] });
    } else {
      const last = parts.at(-1);
      if (last?.type === "text") last.text += token.raw;
      else parts.push({ type: "text", text: token.raw });
    }
  }
  return parts;
}
