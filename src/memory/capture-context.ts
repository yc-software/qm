import { UNTRACKED_PROVENANCE, type MemoryCaptureMetadata } from "./facts.ts";
import type { ScopeId } from "../types.ts";

export interface MemoryCaptureTurn extends MemoryCaptureMetadata {
  scopeId: ScopeId;
  input: string;
  reply: string;
  actorId?: string;
  audienceScopeId?: ScopeId;
  conversationScopeId?: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
}

export interface MemoryCaptureBurst extends MemoryCaptureMetadata {
  scopeId: ScopeId;
  actorId?: string;
  audienceScopeId?: ScopeId;
  conversationScopeId: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
  turns: Array<{ input: string; reply: string }>;
}

export function memoryCaptureGroup(turn: MemoryCaptureTurn): string {
  return JSON.stringify([
    turn.scopeId,
    turn.conversationScopeId ?? turn.scopeId,
    turn.actorId ?? "",
    turn.sessionId ?? "",
    turn.audienceScopeId ?? "",
    turn.document?.teamScopeId ?? "",
    turn.document?.documentScopeId ?? "",
    turn.document?.mode ?? "",
  ]);
}

export function memoryCaptureBurst(turns: readonly MemoryCaptureTurn[], id?: string): MemoryCaptureBurst {
  const first = turns[0];
  if (!first) throw new Error("A memory capture burst must contain a turn");
  const group = memoryCaptureGroup(first);
  if (turns.some((turn) => memoryCaptureGroup(turn) !== group))
    throw new Error("Memory capture burst contains different conversations");
  return {
    scopeId: first.scopeId,
    actorId: first.actorId,
    audienceScopeId: first.audienceScopeId,
    conversationScopeId: first.conversationScopeId ?? first.scopeId,
    sessionId: first.sessionId,
    idempotencyKey: id ?? first.idempotencyKey,
    document: first.document,
    ...(turns.some((turn) => turn.personalOnly) ? { personalOnly: true } : {}),
    inheritedFacts:
      turns.length === 1
        ? first.inheritedFacts
        : turns.flatMap((turn) => turn.inheritedFacts ?? [UNTRACKED_PROVENANCE]),
    turns: turns.map(({ input, reply }) => ({ input, reply })),
  };
}
