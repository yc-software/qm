import { createHash } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { dateStr } from "./notebook.ts";

export type MemorySensitivity = "ordinary" | "unknown" | "sensitive" | "restricted";

export interface MemoryProvenance {
  sensitivity: MemorySensitivity;
  sources: ScopeId[];
  sourceUnknown: boolean;
}

export interface MemoryFact extends MemoryProvenance {
  id: string;
  text: string;
  author?: string;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryCaptureMetadata {
  conversationScopeId?: ScopeId;
  sessionId?: string;
  sensitivity?: MemorySensitivity;
  inheritedFacts?: readonly MemoryProvenance[];
}

export const UNTRACKED_PROVENANCE: MemoryProvenance = { sensitivity: "unknown", sources: [], sourceUnknown: true };

export class MemoryFactsMissing extends Error {
  readonly ids: readonly string[];
  constructor(ids: readonly string[]) {
    super(
      `No fact ${ids.map((id) => `#${id}`).join(", ")} in a notebook this conversation can edit. Nothing was changed; search again for current ids.`,
    );
    this.ids = ids;
  }
}

const sensitivityOrder: MemorySensitivity[] = ["ordinary", "unknown", "sensitive", "restricted"];

export function isMemorySensitivity(value: unknown): value is MemorySensitivity {
  return sensitivityOrder.includes(value as MemorySensitivity);
}

export function mergeProvenance(
  items: readonly MemoryProvenance[],
  sensitivity: MemorySensitivity = "ordinary",
): MemoryProvenance {
  const sources = new Set<ScopeId>();
  for (const item of items) {
    if (sensitivityOrder.indexOf(item.sensitivity) > sensitivityOrder.indexOf(sensitivity))
      sensitivity = item.sensitivity;
    for (const source of item.sources) sources.add(source);
  }
  return { sensitivity, sources: [...sources], sourceUnknown: items.some((item) => item.sourceUnknown) };
}

export function captureProvenance(scope: ScopeId, context: MemoryCaptureMetadata | undefined): MemoryProvenance {
  const merged = mergeProvenance(context?.inheritedFacts ?? [], context?.sensitivity ?? "unknown");
  const source = context?.conversationScopeId ?? scope;
  return {
    sensitivity: merged.sensitivity,
    sources: merged.sources.includes(source) ? merged.sources : [...merged.sources, source],
    sourceUnknown: merged.sourceUnknown || context?.inheritedFacts === undefined,
  };
}

type Shown = Pick<MemoryFact, "text" | "createdAt">;

export function renderFacts(facts: readonly Shown[]): string {
  return facts.map((fact) => `- (${dateStr(fact.createdAt)}) ${fact.text}`).join("\n");
}

export function factHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export interface MemorySource {
  provider: string;
  label: string;
}

export interface MemoryCandidate {
  id?: string;
  ref?: string;
  claim?: string;
  text: string;
  source?: MemorySource;
}

export const normalizeClaim = (text: string) => text.trim().toLowerCase();

export function takeTurns<T>(lists: Iterable<readonly T[]>): T[] {
  const queues = [...lists];
  const rounds = Math.max(0, ...queues.map((list) => list.length));
  return Array.from({ length: rounds }, (_, i) => queues.flatMap((list) => (i < list.length ? [list[i]!] : []))).flat();
}

export function recentCandidates(facts: readonly MemoryFact[]): MemoryCandidate[] {
  return facts.map(factCandidate).reverse();
}

export function factCandidate(fact: MemoryFact): MemoryCandidate {
  return { id: fact.id, claim: fact.text, text: renderFacts([fact]) };
}

export function factLine(fact: Shown & Pick<MemoryFact, "id">): string {
  return `#${fact.id} (${dateStr(fact.createdAt)}) ${fact.text}`;
}

export function parseFactId(value: string): string {
  const id = value.trim();
  return id.startsWith("#") ? id.slice(1) : id;
}
