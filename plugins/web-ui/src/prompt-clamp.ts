const PINNED_BUBBLE = ".message-stack .user-row:not(:has(~ .user-row)) .user-bubble";

export function markClampedPrompts(root: ParentNode | null): void {
  if (!root) return;
  for (const bubble of root.querySelectorAll<HTMLElement>(PINNED_BUBBLE)) {
    if (bubble.dataset.expanded === "true") continue;
    const body = bubble.querySelector<HTMLElement>(":scope > markdown-block, :scope > .slack-wire-text");
    if (!body) continue;
    bubble.dataset.clamped = String(body.scrollHeight - body.clientHeight > 1);
  }
}
