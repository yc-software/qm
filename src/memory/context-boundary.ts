import { createHash } from "node:crypto";
import type { Principal, ScopeId, SessionEntry } from "../types.ts";

export interface MemoryContextSnapshot {
  audience: string;
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
    typeof p.snapshot?.audience === "string"
    ? (p as MemoryContext)
    : null;
}

export function memoryContextFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function buildMemoryContextSnapshot(input: {
  targetScope: ScopeId;
  audience: readonly Principal[];
}): MemoryContextSnapshot {
  return {
    audience: memoryContextFingerprint({
      scope: input.targetScope,
      audience: input.audience.map((person) => [person.id, person.type]).sort(),
    }),
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
  const compatible = payload && payload.snapshot.audience === snapshot.audience;
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
