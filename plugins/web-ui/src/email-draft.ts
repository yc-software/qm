import type { ToolActivity } from "./core-bridge";

export interface EmailDraftRef {
  loopId: string;
  itemId: string;
}

export type EmailDraftActivity = Pick<ToolActivity, "type" | "payload">;

function emailDraftFromPayload(payload: unknown): EmailDraftRef | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  if (value.tool !== "send_email" || value.isError === true) return null;
  const display = value.display;
  if (!display || typeof display !== "object") return null;
  const draft = (display as Record<string, unknown>).emailDraft;
  if (!draft || typeof draft !== "object") return null;
  const { loopId, itemId } = draft as Record<string, unknown>;
  if (typeof loopId !== "string" || !loopId || typeof itemId !== "string" || !itemId) return null;
  return { loopId, itemId };
}

export function emailDraftsIn(activity: readonly EmailDraftActivity[] | undefined): EmailDraftRef[] {
  const seen = new Set<string>();
  const drafts: EmailDraftRef[] = [];
  for (const entry of activity ?? []) {
    if (entry.type !== "tool_result") continue;
    const draft = emailDraftFromPayload(entry.payload);
    if (!draft || seen.has(draft.itemId)) continue;
    seen.add(draft.itemId);
    drafts.push(draft);
  }
  return drafts;
}
