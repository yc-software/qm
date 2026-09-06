import type { LoopItem, LoopProposal, LoopSourcePayload, LoopThreadMessage } from "../types.ts";

export type LedgerState = "pending" | "processed" | "held" | "actioned" | "dismissed" | "failed";

const STATE_BY_STATUS: Record<LoopItem["status"], LedgerState> = {
  queued: "pending",
  in_progress: "processed",
  ready: "held",
  shipped: "actioned",
  skipped: "dismissed",
  failed: "failed",
};

const LEDGER_STATES: readonly LedgerState[] = ["pending", "processed", "held", "actioned", "dismissed", "failed"];

export function ledgerState(item: LoopItem): LedgerState {
  return STATE_BY_STATUS[item.status];
}

export function isLedgerState(value: unknown): value is LedgerState {
  return typeof value === "string" && (LEDGER_STATES as readonly string[]).includes(value);
}

export function isResolved(item: LoopItem): boolean {
  const state = ledgerState(item);
  return state === "actioned" || state === "dismissed";
}

export interface LedgerItemView {
  id: string;
  loopId: string;
  dedupeKey: string;
  state: LedgerState;
  source?: string;
  summary?: string;
  sourcePayload: LoopSourcePayload;
  sourceAt?: number;
  proposal?: LoopProposal;
  thread: LoopThreadMessage[];
  attempts: number;
  parkedReason?: string;
  guidance?: string;
  actedAt?: number;
  actionKind?: string;
  actionResult?: string;
  outputIds: string[];
  createdAt: number;
  updatedAt: number;
}

export function ledgerItemView(item: LoopItem): LedgerItemView {
  return {
    id: item.id,
    loopId: item.loopId,
    dedupeKey: item.sourceKey,
    state: ledgerState(item),
    sourcePayload: item.sourcePayload ?? {},
    thread: item.thread ?? [],
    attempts: item.attempts,
    outputIds: item.outputIds,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(item.source !== undefined ? { source: item.source } : {}),
    ...(item.sourceSummary !== undefined ? { summary: item.sourceSummary } : {}),
    ...(item.sourceAt !== undefined ? { sourceAt: item.sourceAt } : {}),
    ...(item.proposal !== undefined ? { proposal: item.proposal } : {}),
    ...(item.parkedReason !== undefined ? { parkedReason: item.parkedReason } : {}),
    ...(item.guidance !== undefined ? { guidance: item.guidance } : {}),
    ...(item.actedAt !== undefined ? { actedAt: item.actedAt } : {}),
    ...(item.actionKind !== undefined ? { actionKind: item.actionKind } : {}),
    ...(item.actionResult !== undefined ? { actionResult: item.actionResult } : {}),
  };
}

export function sortLedgerItems(items: LoopItem[]): LoopItem[] {
  return [...items].sort((a, b) => {
    const aOpen = isResolved(a) ? 1 : 0;
    const bOpen = isResolved(b) ? 1 : 0;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return (b.sourceAt ?? b.createdAt) - (a.sourceAt ?? a.createdAt);
  });
}
