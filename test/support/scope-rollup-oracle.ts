import type { ScopeSessionRollup, SessionSummary } from "../../src/sessions/session-store.ts";
import { parseSessionWakeRef } from "../../src/api/routes/admin/origins.ts";

export function rollupsFromSummaries(summaries: SessionSummary[]): ScopeSessionRollup[] {
  const out = new Map<string, ScopeSessionRollup>();
  const previewAt = new Map<string, number>();
  for (const s of summaries) {
    const r = out.get(s.scopeId) ?? {
      scopeId: s.scopeId,
      sessions: 0,
      backgroundSessions: 0,
      lastActivity: 0,
      lastConversationActivity: 0,
      previewSessionId: null,
    };
    out.set(s.scopeId, r);
    r.lastActivity = Math.max(r.lastActivity, s.lastActivity);
    if (parseSessionWakeRef(s.threadRef)) {
      r.backgroundSessions += 1;
      continue;
    }
    r.sessions += 1;
    r.lastConversationActivity = Math.max(r.lastConversationActivity, s.lastActivity);
    if (s.turns > 0 && (!previewAt.has(s.scopeId) || s.lastActivity > previewAt.get(s.scopeId)!)) {
      previewAt.set(s.scopeId, s.lastActivity);
      r.previewSessionId = s.id;
    }
  }
  return [...out.values()].sort((a, b) => a.scopeId.localeCompare(b.scopeId));
}

export const byScopeId = (rollups: ScopeSessionRollup[]): ScopeSessionRollup[] =>
  [...rollups].sort((a, b) => a.scopeId.localeCompare(b.scopeId));
