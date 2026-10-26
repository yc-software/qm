import type { InboxItem, InboxProposal, InboxPayload, InboxThreadMessage } from "../types.ts";

export type LedgerState = "pending" | "held" | "actioned" | "dismissed" | "failed";

const STATE_BY_STATUS: Record<InboxItem["status"], LedgerState> = {
  queued: "pending",
  ready: "held",
  shipped: "actioned",
  skipped: "dismissed",
  failed: "failed",
};

const LEDGER_STATES: readonly LedgerState[] = ["pending", "held", "actioned", "dismissed", "failed"];

export function ledgerState(item: Pick<InboxItem, "status">): LedgerState {
  return STATE_BY_STATUS[item.status];
}

export function isLedgerState(value: unknown): value is LedgerState {
  return typeof value === "string" && (LEDGER_STATES as readonly string[]).includes(value);
}

export function isResolved(item: Pick<InboxItem, "status">): boolean {
  const state = ledgerState(item);
  return state === "actioned" || state === "dismissed";
}

export interface LedgerItemView {
  id: string;
  cronId: string;
  dedupeKey: string;
  state: LedgerState;
  source?: string;
  summary?: string;
  sourcePayload: InboxPayload;
  sourceAt?: number;
  proposal?: InboxProposal;
  thread: InboxThreadMessage[];
  parkedReason?: string;
  actedAt?: number;
  actionKind?: string;
  actionResult?: string;
  createdAt: number;
  updatedAt: number;
}

export function agentSourcePayload(payload: InboxPayload, source?: string): InboxPayload {
  if ((source ?? payload.source) !== "slack") return payload;
  const result = { ...payload };
  delete result.slackAvatarsRefreshAt;
  for (const key of ["participants", "context"]) {
    if (Array.isArray(result[key]))
      result[key] = result[key].map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
        const copy = { ...entry } as Record<string, unknown>;
        delete copy.avatarUrl;
        return copy;
      });
  }
  return result;
}

export function ledgerItemView(item: InboxItem, forAgent = false): LedgerItemView {
  return {
    id: item.id,
    cronId: item.cronId,
    dedupeKey: item.sourceKey,
    state: ledgerState(item),
    sourcePayload: forAgent ? agentSourcePayload(item.sourcePayload ?? {}, item.source) : (item.sourcePayload ?? {}),
    thread: item.thread ?? [],
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.sourceSummary !== undefined ? { summary: item.sourceSummary } : {}),
    ...(item.sourceAt !== undefined ? { sourceAt: item.sourceAt } : {}),
    ...(item.proposal !== undefined ? { proposal: item.proposal } : {}),
    ...(item.parkedReason !== undefined ? { parkedReason: item.parkedReason } : {}),
    ...(item.actedAt !== undefined ? { actedAt: item.actedAt } : {}),
    ...(item.actionKind !== undefined ? { actionKind: item.actionKind } : {}),
    ...(item.actionResult !== undefined ? { actionResult: item.actionResult } : {}),
  };
}

export function sortLedgerItems<T extends Pick<InboxItem, "id" | "status" | "createdAt" | "sourceAt">>(
  items: T[],
): T[] {
  const rank = (item: T): number => (isResolved(item) ? 1 : 0);
  return [...items].sort(
    (a, b) =>
      rank(a) - rank(b) || (b.sourceAt ?? b.createdAt) - (a.sourceAt ?? a.createdAt) || a.id.localeCompare(b.id),
  );
}
