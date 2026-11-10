import { suggestNextPrompt } from "./core-bridge.ts";

// One prediction per finished reply, fetched once and kept for the page's lifetime. A response
// saying the feature is off for this person stops all further requests until the next page load.
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
      .catch(() => suggestions.set(key, null))
      .finally(() => pending.delete(key));
  }
  return null;
}
