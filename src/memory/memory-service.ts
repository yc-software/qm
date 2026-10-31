import type { ScopeId } from "../types.ts";
import type { MemoryDisclosure } from "./disclosure.ts";
import {
  MemoryFactsMissing,
  captureProvenance,
  factLine,
  mergeProvenance,
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
  outcome: "ok" | "empty" | "committed" | "pending" | "unknown" | "denied" | "timed_out" | "failed";
  ms: number;
  code?: string;
  added?: number;
}

interface MemoryOutcomeSink {
  report?: (outcome: MemoryProviderOutcome) => void;
}

export interface MemoryRecallContext extends MemoryOutcomeSink {
  query?: string;
  disclosedFacts?: ReadonlyMap<ScopeId, readonly MemoryFact[]>;
  actorId?: string;
  sessionId?: string;
  maxChars?: number;
  autonomous?: boolean;
}

export interface MemoryCaptureContext extends MemoryCaptureMetadata, MemoryOutcomeSink {
  mode: "explicit" | "automatic";
  actorId?: string;
  input?: string;
  reply?: string;
  autonomous?: boolean;
  idempotencyKey?: string;
}

export interface MemoryEdit {
  id: string;
  text: string;
}

export interface MemoryService {
  withDisclosure?(access: MemoryDisclosure): MemoryService;
  recall(scopeId: ScopeId, context?: MemoryRecallContext): Promise<MemoryCandidate[]>;
  capture(
    scopeId: ScopeId,
    facts: string[],
    at: number,
    author?: string,
    context?: MemoryCaptureContext,
  ): Promise<number>;
  query(scopeId: ScopeId, q: string, limit?: number, context?: MemoryRecallContext): Promise<string[]>;
  read(scopeId: ScopeId): Promise<string>;
  facts?(scopeId: ScopeId): Promise<MemoryFact[]>;
  edit?(scopeId: ScopeId, edits: MemoryEdit[], author?: string, context?: MemoryCaptureMetadata): Promise<void>;
  delete?(scopeId: ScopeId, ids: string[], author?: string): Promise<void>;
  metadata?(): Promise<Map<ScopeId, { bytes: number; updatedAt?: number }>>;
}

export function queryFacts(facts: readonly MemoryFact[], q: string, limit: number): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return facts
    .filter((fact) => terms.every((term) => fact.text.toLowerCase().includes(term)))
    .slice(0, limit)
    .map(factLine);
}

const normalize = (text: string) => text.trim().toLowerCase();

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

    async capture(scopeId, facts, at, author, context) {
      const lines = cleanCapturedFacts(facts);
      if (!lines.length) return 0;
      const provenance = captureProvenance(scopeId, context);
      return store.transact(scopeId, async (tx) => {
        const existing = new Map((await tx.list()).map((fact) => [normalize(fact.text), fact]));
        let added = 0;
        for (const text of lines) {
          const key = normalize(text);
          const duplicate = existing.get(key);
          if (duplicate) {
            const merged = mergeProvenance([duplicate, provenance], duplicate.sensitivity);
            if (!sameProvenance(merged, duplicate)) {
              await tx.update(duplicate.id, merged, at);
              existing.set(key, { ...duplicate, ...merged });
            }
            continue;
          }
          const fact = { text, ...provenance, ...(author ? { author } : {}), createdAt: at, updatedAt: at };
          await tx.insert(fact);
          existing.set(key, { ...fact, id: "" });
          added++;
        }
        return added;
      });
    },

    async query(scopeId, q, limit = 20) {
      return queryFacts(await store.list(scopeId), q, limit);
    },

    async read(scopeId) {
      return renderFacts(await store.list(scopeId));
    },

    facts: (scopeId) => store.list(scopeId),

    async edit(scopeId, edits, _author, context) {
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

export function isSystemActor(actorId: string | undefined): boolean {
  return !!actorId?.startsWith("system:");
}
