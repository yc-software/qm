import { createHash } from "node:crypto";
import type { Principal, ScopeId, SessionEntry } from "../types.ts";
import type { MemoryService } from "./memory-service.ts";
import type { SharingPosture } from "../resolution/sharing-posture.ts";

export interface MemoryContextSnapshot {
  audience: string;
  facts: string[];
  readEpoch?: number;
}

interface MemoryContext {
  kind: "memory_context";
  fingerprint: string;
  snapshot: MemoryContextSnapshot;
  throughSeq: number;
}

export function memoryContextPayload(entry: SessionEntry): MemoryContext | null {
  let value = entry.type === "system" ? entry.payload : null;
  if (entry.type === "user") value = (entry.payload as { memoryContext?: unknown } | null)?.memoryContext;
  const p = value as Partial<MemoryContext> | null;
  return p?.kind === "memory_context" &&
    typeof p.fingerprint === "string" &&
    Number.isSafeInteger(p.throughSeq) &&
    p.throughSeq! >= -1 &&
    (p.snapshot?.readEpoch === undefined ||
      (Number.isSafeInteger(p.snapshot.readEpoch) && p.snapshot.readEpoch >= 0)) &&
    typeof p.snapshot?.audience === "string" &&
    Array.isArray(p.snapshot.facts) &&
    p.snapshot.facts.every((fact) => typeof fact === "string")
    ? (p as MemoryContext)
    : null;
}

export function memoryContextFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildMemoryContextSnapshot(input: {
  actorId: string;
  readEpoch?: number;
  audience: readonly Principal[];
  posture: SharingPosture | undefined;
  heads: { scope: ScopeId; head: Awaited<ReturnType<NonNullable<MemoryService["readHead"]>>> }[];
}): MemoryContextSnapshot {
  return {
    readEpoch: input.readEpoch ?? 0,
    audience: memoryContextFingerprint({
      actor: input.actorId,
      audience: input.audience.map((person) => [person.id, person.type, person.teamIds]).sort(),
      posture: input.posture,
    }),
    facts: input.heads
      .flatMap(({ scope, head }) => {
        if (head.records) return head.records.records.map((record) => memoryContextFingerprint([scope, record]));
        return head.content ? [memoryContextFingerprint([scope, head.content])] : [];
      })
      .sort(),
  };
}

export function memoryBoundedEntries(entries: SessionEntry[]): SessionEntry[] {
  const boundary = entries.findLast((entry) => memoryContextPayload(entry));
  const through = boundary ? memoryContextPayload(boundary)!.throughSeq : -1;
  return entries.filter((entry) => entry.seq > through && !(entry.type === "system" && memoryContextPayload(entry)));
}

export function nextMemoryContext(
  entries: SessionEntry[],
  snapshot: MemoryContextSnapshot,
  latestSeq: number,
): MemoryContext {
  const previous = entries.findLast((entry) => memoryContextPayload(entry));
  const payload = previous && memoryContextPayload(previous);
  const allowed = new Set(snapshot.facts);
  const compatible =
    payload &&
    (!payload.snapshot.facts.length || payload.snapshot.audience === snapshot.audience) &&
    (payload.snapshot.readEpoch ?? 0) === (snapshot.readEpoch ?? 0) &&
    payload.snapshot.facts.every((fact) => allowed.has(fact));
  const hasPriorContext =
    !!payload ||
    entries.some(
      (entry) =>
        entry.type === "assistant" ||
        entry.type === "tool_result" ||
        !!(entry.payload as { environment?: unknown } | null)?.environment ||
        (entry.type === "system" && (entry.payload as { kind?: string })?.kind === "context_summary"),
    );
  let throughSeq = hasPriorContext ? latestSeq : -1;
  if (compatible) throughSeq = payload.throughSeq;
  return { kind: "memory_context", fingerprint: memoryContextFingerprint(snapshot), snapshot, throughSeq };
}
