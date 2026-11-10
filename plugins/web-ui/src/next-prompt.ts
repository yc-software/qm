import { suggestNextPrompt } from "./core-bridge.ts";
import { reportHandledError } from "./browser-errors.ts";

let disabled = false;
const suggestions = new Map<string, string | null>();
const pending = new Set<string>();

export function nextPromptSuggestion(sessionId: string, replyKey: string, redraw: () => void): string | null {
  if (disabled) return null;
  const key = `${sessionId}\n${replyKey}`;
  if (suggestions.has(key)) return suggestions.get(key) ?? null;
  if (!pending.has(key)) {
    pending.add(key);
    suggestNextPrompt(sessionId)
      .then((out) => {
        if (!out.enabled) disabled = true;
        suggestions.set(key, out.suggestion);
        if (out.suggestion) redraw();
      })
      .catch((error: unknown) => {
        suggestions.set(key, null);
        reportHandledError("next_prompt_suggestion", error);
      })
      .finally(() => pending.delete(key));
  }
  return null;
}
