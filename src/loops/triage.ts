import { hashId } from "../util/crypto.ts";
import { canonicalJson } from "../util/objects.ts";
import type { Loop, LoopItem, LoopItemPriority } from "../types.ts";
import type { LoopItemLedger, TriagePatch } from "./item-ledger.ts";
import { consolidates, isResolved, prioritizes, PRIORITY_RANK } from "./ledger-view.ts";

export const LOOP_ITEM_PRIORITIES: readonly LoopItemPriority[] = ["urgent", "high", "normal", "low"];

export const DEFAULT_PRIORITIZE_INSTRUCTIONS =
  "Rank by how soon a person needs to act: production outages, security issues, and customers blocked right now are urgent; real user-facing breakage or a person waiting on a decision is high; routine work is normal; noise, FYIs, and anything that can wait a week is low.";

export const DEFAULT_CONSOLIDATE_INSTRUCTIONS =
  "Group items only when one piece of work would resolve all of them: the same error or root cause, the same request asked by several people, or duplicate reports of one problem. Items that merely share a topic stay separate.";

const TRIAGE_CONTEXT = 200;
const REASON_MAX = 200;

export interface TriageDecision {
  id: string;
  priority?: LoopItemPriority;
  reason?: string;
  groupWith?: string;
}

export function triageInputHash(loop: Pick<Loop, "triage">, item: LoopItem): string {
  return hashId([canonicalJson(loop.triage ?? {}), triageSourceHash(item)]);
}

export function triageSourceHash(item: LoopItem): string {
  return hashId([
    canonicalJson({
      sourceAt: item.sourceAt ?? item.createdAt,
      sourceKey: item.sourceKey,
      sourceSummary: item.sourceSummary,
      sourcePayload: item.sourcePayload,
      inboxPreview: item.inboxPreview,
    }),
  ]);
}

export interface TriageWork {
  open: LoopItem[];
  pending: LoopItem[];
  context: LoopItem[];
}

function sourceVersion(item: LoopItem): number {
  return item.sourceAt ?? item.createdAt;
}

function openById(items: LoopItem[]): Map<string, LoopItem> {
  return new Map(items.filter((item) => !isResolved(item)).map((item) => [item.id, item]));
}

function liveGroup(item: LoopItem, open: Map<string, LoopItem>): string | undefined {
  const groupId = item.triage?.groupId;
  return groupId && open.get(groupId)?.loopId === item.loopId ? groupId : undefined;
}

export function heldMembers(loop: Loop, items: LoopItem[]): Set<string> {
  if (!consolidates(loop)) return new Set();
  const open = openById(items);
  return new Set(
    [...open.values()].filter((item) => (liveGroup(item, open) ?? item.id) !== item.id).map((item) => item.id),
  );
}

export function workOrder(loop: Loop, queued: LoopItem[], items: LoopItem[]): LoopItem[] {
  const held = heldMembers(loop, items);
  const rank = (item: LoopItem): number => (prioritizes(loop) ? PRIORITY_RANK[item.triage?.priority ?? "normal"] : 0);
  return queued.filter((item) => !held.has(item.id)).sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
}

export function triageWork(loop: Loop, items: LoopItem[]): TriageWork | null {
  if (!prioritizes(loop) && !consolidates(loop)) return null;
  const byId = openById(items);
  const open = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  const pending = open.filter(
    (item) =>
      !item.triage ||
      item.triage.inputHash !== triageInputHash(loop, item) ||
      item.triage.at < sourceVersion(item) ||
      (item.triage.groupId !== undefined && liveGroup(item, byId) === undefined),
  );
  if (pending.length === 0) return null;
  return { open, pending, context: open };
}

export function previewWork(items: LoopItem[]): TriageWork {
  const open = [...openById(items).values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((item) => {
      const { proposal: _proposal, thread: _thread, agentDrafts: _drafts, sourcePayload: _payload, ...rest } = item;
      return {
        ...rest,
        triage: item.triage
          ? {
              at: item.triage.at,
              pinned: item.triage.pinned,
              ...(pinned(item, "priority") ? { priority: item.triage.priority, reason: item.triage.reason } : {}),
              ...(pinned(item, "group") ? { groupId: item.triage.groupId } : {}),
            }
          : undefined,
      };
    });
  return { open, pending: open, context: open };
}

export function triageContext(items: LoopItem[], pending: LoopItem[]): LoopItem[] {
  const ids = new Set(pending.map((item) => item.id));
  const others = items.filter((item) => !ids.has(item.id));
  others.sort((a, b) => Number(b.triage?.groupId === b.id) - Number(a.triage?.groupId === a.id));
  return [...pending, ...others].slice(0, TRIAGE_CONTEXT);
}

export function parseTriageDecisions(list: unknown[]): TriageDecision[] {
  const decisions: TriageDecision[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    const priority = LOOP_ITEM_PRIORITIES.find((value) => value === record.priority);
    const reason = typeof record.reason === "string" ? record.reason.trim().slice(0, REASON_MAX) : "";
    decisions.push({
      id: record.id,
      ...(priority ? { priority } : {}),
      ...(priority && reason ? { reason } : {}),
      ...(typeof record.groupWith === "string" && record.groupWith ? { groupWith: record.groupWith } : {}),
    });
  }
  return decisions;
}

function pinned(item: LoopItem, field: "priority" | "group"): boolean {
  return item.triage?.pinned?.includes(field) === true;
}

export function planTriage(
  loop: Pick<Loop, "triage">,
  open: LoopItem[],
  pending: LoopItem[],
  decisions: TriageDecision[],
): Map<string, TriagePatch> {
  const byId = new Map(open.map((item) => [item.id, item]));
  const decided = new Map(decisions.map((decision) => [decision.id, decision]));
  const patches = new Map<string, TriagePatch>();
  const patch = (id: string, fields: TriagePatch): void => {
    patches.set(id, { ...patches.get(id), ...fields });
  };
  for (const item of pending) {
    const decision = decided.get(item.id);
    if (!decision) continue;
    patch(item.id, { at: sourceVersion(item), inputHash: triageInputHash(loop, item) });
    if (prioritizes(loop) && decision?.priority && !pinned(item, "priority"))
      patch(item.id, { priority: decision.priority, reason: decision.reason });
  }
  if (!consolidates(loop)) return patches;
  const groups = new Map(open.map((item) => [item.id, liveGroup(item, byId)]));
  const leave = (id: string): void => {
    const rest = [...groups].filter(([other, groupId]) => other !== id && groupId === id).map(([other]) => other);
    const successor = rest.map((other) => byId.get(other)!).sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
    for (const other of rest) groups.set(other, successor);
    groups.set(id, undefined);
  };
  for (const item of pending) {
    if (decided.has(item.id) && !pinned(item, "group")) leave(item.id);
  }
  for (const item of pending) {
    const other = byId.get(decided.get(item.id)?.groupWith ?? "");
    if (!other || other.id === item.id || pinned(item, "group") || pinned(other, "group")) continue;
    const source = groups.get(item.id);
    const target = groups.get(other.id);
    if (target !== undefined && target === source) continue;
    const members = open.filter(
      (candidate) =>
        candidate.id === item.id ||
        candidate.id === other.id ||
        (source !== undefined && groups.get(candidate.id) === source) ||
        (target !== undefined && groups.get(candidate.id) === target),
    );
    const representative = members.sort((a, b) => a.createdAt - b.createdAt)[0]!;
    for (const member of members) groups.set(member.id, representative.id);
  }
  const sizes = new Map<string, number>();
  for (const groupId of groups.values()) if (groupId) sizes.set(groupId, (sizes.get(groupId) ?? 0) + 1);
  for (const [id, groupId] of groups) {
    const next = groupId && (sizes.get(groupId) ?? 0) > 1 ? groupId : undefined;
    if (next !== byId.get(id)?.triage?.groupId) patch(id, { groupId: next });
  }
  return patches;
}

async function openMembers(ledger: LoopItemLedger, item: LoopItem, groupId: string): Promise<LoopItem[]> {
  return (await ledger.byLoop(item.loopId))
    .filter((member) => member.id !== item.id && member.triage?.groupId === groupId && !isResolved(member))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function removeFromGroup(ledger: LoopItemLedger, item: LoopItem): Promise<LoopItem | null> {
  const groupId = item.triage?.groupId;
  if (groupId) {
    const members = await openMembers(ledger, item, groupId);
    const successor = groupId === item.id ? members[0]?.id : groupId;
    const regroup = members.length > 1 ? successor : undefined;
    for (const member of members)
      if (member.triage?.groupId !== regroup) await ledger.setTriage(member.id, { groupId: regroup }, "agent");
  }
  return ledger.setTriage(item.id, { groupId: undefined }, "human");
}

export async function settleGroup(ledger: LoopItemLedger, representative: LoopItem): Promise<void> {
  if (representative.triage?.groupId !== representative.id || !isResolved(representative)) return;
  const preview = representative.inboxPreview?.title;
  const title =
    typeof preview === "string" && preview ? preview : (representative.sourceSummary ?? representative.sourceKey);
  for (const member of await openMembers(ledger, representative, representative.id)) {
    if (member.status === "in_progress" || (member.status === "ready" && member.outputIds.length > 0)) continue;
    await ledger.recordAction(member.id, {
      kind: "consolidated",
      outcome: "dismissed",
      result: `Resolved with ${title}`,
    });
  }
}
