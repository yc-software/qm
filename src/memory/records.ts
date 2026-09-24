import { createHash, randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { isBullet, memoryBlocks, normalize } from "./notebook.ts";

type MemorySensitivity = "ordinary" | "unknown" | "sensitive" | "restricted";

interface MemorySource {
  scopeId: ScopeId;
  sessionId?: string;
}

interface MemoryRecord {
  id: string;
  text: string;
  sensitivity: MemorySensitivity;
  sources: MemorySource[];
  sourceUnknown: boolean;
}

export interface MemoryRecords {
  version: 1;
  records: MemoryRecord[];
}

export interface MemoryCaptureMetadata {
  conversationScopeId?: ScopeId;
  sessionId?: string;
  sensitivity?: MemorySensitivity;
  inheritedRecords?: readonly MemoryRecord[];
}

const sensitivityOrder: MemorySensitivity[] = ["ordinary", "unknown", "sensitive", "restricted"];

function inherit(
  records: readonly Pick<MemoryRecord, "sensitivity" | "sources" | "sourceUnknown">[],
  sensitivity: MemorySensitivity,
) {
  const sources = new Map<string, MemorySource>();
  for (const record of records) {
    if (sensitivityOrder.indexOf(record.sensitivity) > sensitivityOrder.indexOf(sensitivity))
      sensitivity = record.sensitivity;
    for (const source of record.sources) sources.set(`${source.scopeId}\0${source.sessionId ?? ""}`, source);
  }
  return { sensitivity, sources: [...sources.values()], sourceUnknown: records.some((record) => record.sourceUnknown) };
}

export function legacyMemoryRecords(scope: ScopeId, body: string): MemoryRecords {
  return {
    version: 1,
    records: memoryBlocks(body).map((text, index) => ({
      id: createHash("sha256").update(`${scope}\0${index}\0${text}`).digest("hex"),
      text,
      sensitivity: "unknown",
      sources: [],
      sourceUnknown: true,
    })),
  };
}

export function updateMemoryRecords(
  scope: ScopeId,
  previous: MemoryRecords,
  body: string,
  capture?: MemoryCaptureMetadata,
  capturedBody = body,
): MemoryRecords {
  const existing = new Map<string, MemoryRecord[]>();
  for (const record of previous.records) {
    const matches = existing.get(record.text) ?? [];
    matches.push(record);
    existing.set(record.text, matches);
  }
  const inherited = inherit(
    capture ? (capture.inheritedRecords ?? []) : previous.records,
    capture?.sensitivity ?? "unknown",
  );
  if (capture) {
    const source: MemorySource = {
      scopeId: capture.conversationScopeId ?? scope,
      ...(capture.sessionId ? { sessionId: capture.sessionId } : {}),
    };
    if (!inherited.sources.some((item) => item.scopeId === source.scopeId && item.sessionId === source.sessionId))
      inherited.sources.push(source);
  }
  const captured = new Set(memoryBlocks(capturedBody).filter(isBullet).map(normalize));
  const next = memoryBlocks(body);
  const rewritten =
    !capture &&
    (next.length !== previous.records.length || next.some((text, index) => text !== previous.records[index]?.text));
  return {
    version: 1,
    records: next.map((text) => {
      const unchanged = existing.get(text)?.shift();
      if (unchanged && !rewritten && (!capture || !captured.has(normalize(text)))) return unchanged;
      const metadata = unchanged ? inherit([unchanged, inherited], inherited.sensitivity) : inherited;
      return {
        id: unchanged?.id ?? randomUUID(),
        text,
        ...metadata,
        sourceUnknown: metadata.sourceUnknown || !capture || capture.inheritedRecords === undefined,
      };
    }),
  };
}

export function restoreMemoryRecords(current: MemoryRecords, restored: MemoryRecords): MemoryRecords {
  const floor = inherit(current.records, "ordinary");
  return {
    version: 1,
    records: restored.records.map((record) => ({
      ...record,
      ...inherit([record, floor], record.sensitivity),
    })),
  };
}
