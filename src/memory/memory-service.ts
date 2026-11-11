import type { McpRemoteTool } from "../mcp/mcp-client.ts";
import { ownPrivateConversation } from "../directory/person.ts";
import type { ScopeId } from "../types.ts";
import type { MemoryDisclosure } from "./disclosure.ts";
import {
  MemoryFactsMissing,
  captureProvenance,
  factCandidate,
  fromOtherSession,
  factLine,
  mergeProvenance,
  normalizeClaim,
  parseFactId,
  recentCandidates,
  renderFacts,
  type MemoryCandidate,
  type MemoryCaptureMetadata,
  type MemoryFact,
  type MemoryProvenance,
} from "./facts.ts";

export const MEMORY_FILE = "memory/MEMORY.md";

export interface MemoryProviderOutcome {
  provider: string;
  scope: ScopeId;
  outcome: "ok" | "empty" | "committed" | "pending" | "unknown" | "denied" | "timed_out" | "failed" | "disabled";
  ref?: string;
  ms: number;
  code?: string;
  added?: number;
}

interface MemoryOutcomeSink {
  report?: (outcome: MemoryProviderOutcome) => void;
}

export interface MemoryRecallContext extends MemoryOutcomeSink {
  query?: string;
  input?: string;
  disclosedFacts?: Promise<ReadonlyMap<ScopeId, readonly MemoryFact[]>>;
  actorId?: string;
  audienceScopeId?: ScopeId;
  sessionId?: string;
  maxChars?: number;
}

export interface MemoryCaptureContext extends MemoryCaptureMetadata, MemoryOutcomeSink {
  mode: "explicit" | "automatic";
  audienceScopeId?: ScopeId;
  input?: string;
  reply?: string;
  idempotencyKey?: string;
}

export interface MemoryForgetContext extends MemoryOutcomeSink {
  audienceScopeId?: ScopeId;
  idempotencyKey?: string;
}

export interface MemoryEdit {
  id: string;
  text: string;
}

export interface MemoryAuthority {
  actorId: string;
  context: "conversation" | "self" | "admin" | "maintenance";
  personTurn?: true;
}

export function changesNotebookOnly(by: MemoryAuthority | undefined): boolean {
  return by?.context !== "conversation" || !by.actorId.trim();
}

export function brainActsAsPerson(
  by: MemoryAuthority | undefined,
  scopeId: ScopeId,
  audienceScopeId: ScopeId | undefined,
): boolean {
  return (
    !changesNotebookOnly(by) && by!.personTurn === true && ownPrivateConversation(by!.actorId, scopeId, audienceScopeId)
  );
}

export function turnAuthority(
  actorId: string,
  access: { notebookOnly?: true } | undefined,
  personTurn?: boolean,
): MemoryAuthority {
  return {
    actorId,
    context: access?.notebookOnly ? "maintenance" : "conversation",
    ...(personTurn ? { personTurn: true } : {}),
  };
}

interface MemoryReader {
  actorId: string;
  audienceScopeId?: ScopeId;
}

interface BoundBrain {
  id: string;
  label: string;
  tools: McpRemoteTool[];
}

export interface MemoryService {
  attestActor?: boolean;
  lookupTools?(scopeId: ScopeId, reader: MemoryReader): Promise<McpRemoteTool[]>;
  brains?(scopeId: ScopeId, reader: MemoryReader): Promise<BoundBrain[]>;
  lookup?(
    scopeId: ScopeId,
    tool: string,
    args: Record<string, unknown>,
    by: MemoryAuthority | undefined,
    context?: { audienceScopeId?: ScopeId },
  ): Promise<string>;
  withDisclosure?(access: MemoryDisclosure): MemoryService;
  recall(scopeId: ScopeId, context?: MemoryRecallContext): Promise<MemoryCandidate[]>;
  capture(
    scopeId: ScopeId,
    facts: string[],
    at: number,
    by?: MemoryAuthority,
    context?: MemoryCaptureContext,
  ): Promise<number>;
  query(scopeId: ScopeId, q: string, limit?: number, context?: MemoryRecallContext): Promise<MemoryCandidate[]>;
  read(scopeId: ScopeId): Promise<string>;
  facts?(scopeId: ScopeId): Promise<MemoryFact[]>;
  edit?(scopeId: ScopeId, edits: MemoryEdit[], by?: MemoryAuthority, context?: MemoryCaptureMetadata): Promise<void>;
  delete?(scopeId: ScopeId, ids: string[], by?: MemoryAuthority, context?: MemoryForgetContext): Promise<void>;
  metadata?(): Promise<Map<ScopeId, { bytes: number; updatedAt?: number }>>;
}

export function queryFacts(
  facts: readonly MemoryFact[],
  q: string,
  limit: number,
  sessionId?: string,
): MemoryCandidate[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return facts
    .filter((fact) => fromOtherSession(fact, sessionId))
    .filter((fact) => terms.every((term) => fact.text.toLowerCase().includes(term)))
    .slice(0, limit)
    .map((fact) => ({ ...factCandidate(fact), text: factLine(fact) }));
}

function cleanCapturedFacts(facts: string[]): string[] {
  return facts.flatMap((f) => {
    const text = f
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\((\d{4}-\d\d-\d\d)\)\s*/, "on $1: ")
      .replace(/\s+\(said in ([^()]+)\)\s*$/i, " [claimed source: $1]");
    return text ? [text] : [];
  });
}

function editedText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^\(\d{4}-\d\d-\d\d\)\s*/, "");
}

function sameProvenance(a: MemoryProvenance, b: MemoryProvenance): boolean {
  return (
    a.sensitivity === b.sensitivity &&
    a.sourceUnknown === b.sourceUnknown &&
    a.sources.length === b.sources.length &&
    a.sources.every((source) => b.sources.includes(source))
  );
}

function resolveIds(facts: readonly MemoryFact[], ids: readonly string[]): MemoryFact[] {
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  const wanted = ids.map(parseFactId);
  const missing = [...new Set(wanted.filter((id) => !byId.has(id)))];
  if (missing.length) throw new MemoryFactsMissing(missing);
  return wanted.map((id) => byId.get(id)!);
}

export interface FactStoreTx {
  list(): Promise<MemoryFact[]>;
  insert(fact: Omit<MemoryFact, "id">): Promise<void>;
  update(id: string, patch: Partial<Pick<MemoryFact, "text" | keyof MemoryProvenance>>, at: number): Promise<void>;
  remove(ids: readonly string[], at: number): Promise<void>;
}

export interface FactStore {
  list(scopeId: ScopeId): Promise<MemoryFact[]>;
  transact<T>(scopeId: ScopeId, fn: (tx: FactStoreTx) => Promise<T>): Promise<T>;
  metadata?(): Promise<Map<ScopeId, { bytes: number; updatedAt?: number }>>;
}

export function createNotebookMemory(store: FactStore): MemoryService {
  return {
    async recall(scopeId) {
      return recentCandidates(await store.list(scopeId));
    },

    async capture(scopeId, facts, at, by, context) {
      const lines = cleanCapturedFacts(facts);
      if (!lines.length) return 0;
      const provenance = captureProvenance(scopeId, context);
      return store.transact(scopeId, async (tx) => {
        const existing = new Map((await tx.list()).map((fact) => [normalizeClaim(fact.text), fact]));
        let added = 0;
        for (const text of lines) {
          const key = normalizeClaim(text);
          const duplicate = existing.get(key);
          if (duplicate) {
            const merged = mergeProvenance([duplicate, provenance], duplicate.sensitivity);
            if (!sameProvenance(merged, duplicate)) {
              await tx.update(duplicate.id, merged, at);
              existing.set(key, { ...duplicate, ...merged });
            }
            continue;
          }
          const fact = {
            text,
            ...provenance,
            ...(by?.actorId ? { author: by.actorId } : {}),
            ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
            createdAt: at,
            updatedAt: at,
          };
          await tx.insert(fact);
          existing.set(key, { ...fact, id: "" });
          added++;
        }
        return added;
      });
    },

    async query(scopeId, q, limit = 20, context) {
      return queryFacts(await store.list(scopeId), q, limit, context?.sessionId);
    },

    async read(scopeId) {
      return renderFacts(await store.list(scopeId));
    },

    facts: (scopeId) => store.list(scopeId),

    async edit(scopeId, edits, _by, context) {
      const at = Date.now();
      const exposure = context ? captureProvenance(scopeId, context) : undefined;
      await store.transact(scopeId, async (tx) => {
        const targets = resolveIds(
          await tx.list(),
          edits.map((edit) => edit.id),
        );
        for (const [index, fact] of targets.entries()) {
          const text = editedText(edits[index]!.text);
          await tx.update(
            fact.id,
            { text, ...(exposure ? mergeProvenance([fact, exposure], fact.sensitivity) : {}) },
            at,
          );
        }
      });
    },

    async delete(scopeId, ids) {
      await store.transact(scopeId, async (tx) => {
        const targets = resolveIds(await tx.list(), ids);
        await tx.remove(
          targets.map((fact) => fact.id),
          Date.now(),
        );
      });
    },

    ...(store.metadata ? { metadata: () => store.metadata!() } : {}),
  };
}
