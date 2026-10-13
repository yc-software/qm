import type { ScopeId } from "../types.ts";
import { bulletText, isBullet } from "./notebook.ts";

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

/** Provenance stamped on a fact written by a turn: what the turn had seen, plus where it was written from. */
export function captureProvenance(scope: ScopeId, context: MemoryCaptureMetadata | undefined): MemoryProvenance {
  const merged = mergeProvenance(context?.inheritedFacts ?? [], context?.sensitivity ?? "unknown");
  const source = context?.conversationScopeId ?? scope;
  return {
    sensitivity: merged.sensitivity,
    sources: merged.sources.includes(source) ? merged.sources : [...merged.sources, source],
    sourceUnknown: merged.sourceUnknown || context?.inheritedFacts === undefined,
  };
}

export function renderFacts(facts: readonly Pick<MemoryFact, "text">[]): string {
  return facts.reduce((body, fact, index) => {
    if (index === 0) return fact.text;
    return body + (isBullet(fact.text) && isBullet(facts[index - 1]!.text) ? "\n" : "\n\n") + fact.text;
  }, "");
}

export function factLine(fact: Pick<MemoryFact, "id" | "text">): string {
  return `#${fact.id} ${isBullet(fact.text) ? bulletText(fact.text) : fact.text}`;
}

export function parseFactId(value: string): string {
  return value.trim().replace(/^#/, "");
}
