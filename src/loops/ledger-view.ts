import type {
  Loop,
  LoopItem,
  LoopItemPriority,
  LoopItemTriage,
  LoopProposal,
  LoopSourcePayload,
  LoopThreadMessage,
} from "../types.ts";

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

export function ledgerState(item: Pick<LoopItem, "status">): LedgerState {
  return STATE_BY_STATUS[item.status];
}

export function isLedgerState(value: unknown): value is LedgerState {
  return typeof value === "string" && (LEDGER_STATES as readonly string[]).includes(value);
}

export function isResolved(item: Pick<LoopItem, "status">): boolean {
  const state = ledgerState(item);
  return state === "actioned" || state === "dismissed";
}

export function prioritizes(loop: Pick<Loop, "triage">): boolean {
  return loop.triage?.prioritize?.enabled === true;
}

export function consolidates(loop: Pick<Loop, "triage">): boolean {
  return loop.triage?.consolidate?.enabled === true;
}

function visibleTriage(loop: Pick<Loop, "triage">, triage: LoopItemTriage | undefined): LoopItemTriage | undefined {
  if (!triage) return undefined;
  return {
    at: triage.at,
    ...(prioritizes(loop) && triage.priority ? { priority: triage.priority } : {}),
    ...(prioritizes(loop) && triage.priority && triage.reason ? { reason: triage.reason } : {}),
    ...(consolidates(loop) && triage.groupId ? { groupId: triage.groupId } : {}),
    ...(triage.pinned?.length ? { pinned: triage.pinned } : {}),
  };
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
  triage?: LoopItemTriage;
  outputIds: string[];
  createdAt: number;
  updatedAt: number;
}

export function ledgerItemView(item: LoopItem, loop: Pick<Loop, "triage">): LedgerItemView {
  const triage = visibleTriage(loop, item.triage);
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
    ...(triage ? { triage } : {}),
  };
}

export const PRIORITY_RANK: Record<LoopItemPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

type TriageKey = [number, number, number, string, number, number, number, number, string];

type Triaged = Pick<LoopItem, "id" | "status" | "triage">;

export function triageKeys<T extends Triaged>(
  items: T[],
  loopOf: (item: T) => Pick<Loop, "triage"> | undefined,
  recency: (item: T) => number,
): Map<string, TriageKey> {
  const own = (item: T): [number, number, number] => {
    const loop = loopOf(item);
    const rank = loop && prioritizes(loop) ? PRIORITY_RANK[item.triage?.priority ?? "normal"] : PRIORITY_RANK.normal;
    return [isResolved(item) ? 1 : 0, rank, -recency(item)];
  };
  const groupOf = (item: T): string | undefined => {
    const loop = loopOf(item);
    return loop && consolidates(loop) ? item.triage?.groupId : undefined;
  };
  const leaders = new Map<string, [number, number, number]>();
  for (const item of items) {
    const groupId = groupOf(item);
    if (!groupId) continue;
    const key = own(item);
    const current = leaders.get(groupId);
    if (!current || compareKeys(key, current) < 0) leaders.set(groupId, key);
  }
  return new Map(
    items.map((item) => {
      const key = own(item);
      const groupId = groupOf(item);
      const lead = (groupId && leaders.get(groupId)) || key;
      return [item.id, [...lead, groupId ?? item.id, groupId && groupId !== item.id ? 1 : 0, ...key, item.id]];
    }),
  );
}

export function compareKeys(a: ReadonlyArray<number | string>, b: ReadonlyArray<number | string>): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}

export function sortLedgerItems(items: LoopItem[], loop: Pick<Loop, "triage">): LoopItem[] {
  const keys = triageKeys(
    items,
    () => loop,
    (item) => item.sourceAt ?? item.createdAt,
  );
  return [...items].sort((a, b) => compareKeys(keys.get(a.id)!, keys.get(b.id)!));
}
