import { createHash, randomUUID } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { isBullet, isMemoryBookkeeping, memoryBlocks, normalize } from "./notebook.ts";

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
  capturesSinceConsolidation?: number;
  pendingScratchCaptures?: number;
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

export function renderMemoryRecords(snapshot: MemoryRecords): string {
  return (
    snapshot.records
      .reduce((body, record, index) => {
        let separator = "";
        if (index > 0) separator = isBullet(record.text) && isBullet(snapshot.records[index - 1]!.text) ? "\n" : "\n\n";
        return body + separator + record.text;
      }, "")
      .replace(/\s+$/, "") + (snapshot.records.length ? "\n" : "")
  );
}

export function parseMemoryRecords(scope: ScopeId, body: string, value?: unknown): MemoryRecords {
  if (value == null) return legacyMemoryRecords(scope, body);
  const snapshot = value as MemoryRecords;
  if (
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.records) ||
    (snapshot.capturesSinceConsolidation !== undefined &&
      (!Number.isSafeInteger(snapshot.capturesSinceConsolidation) || snapshot.capturesSinceConsolidation < 0)) ||
    (snapshot.pendingScratchCaptures !== undefined &&
      (!Number.isSafeInteger(snapshot.pendingScratchCaptures) || snapshot.pendingScratchCaptures < 0)) ||
    !snapshot.records.every(
      (record) =>
        record &&
        typeof record.id === "string" &&
        record.id.length > 0 &&
        typeof record.text === "string" &&
        sensitivityOrder.includes(record.sensitivity) &&
        typeof record.sourceUnknown === "boolean" &&
        Array.isArray(record.sources) &&
        record.sources.every(
          (source) =>
            source &&
            typeof source.scopeId === "string" &&
            source.scopeId.length > 0 &&
            (source.sessionId === undefined || typeof source.sessionId === "string"),
        ),
    ) ||
    new Set(snapshot.records.map((record) => record.id)).size !== snapshot.records.length
  )
    throw new Error("Invalid memory records");
  const pending = snapshot.records
    .find((record) => /^<!-- captures-since-promote: \d+ -->$/.test(record.text))
    ?.text.match(/: (\d+)/)?.[1];
  return {
    ...snapshot,
    ...(snapshot.pendingScratchCaptures === undefined && pending !== undefined
      ? { pendingScratchCaptures: Number(pending) }
      : {}),
    records: snapshot.records.filter((record) => !isMemoryBookkeeping(record.text)),
  };
}

export function legacyMemoryRecords(scope: ScopeId, body: string): MemoryRecords {
  const lines = body.split("\n");
  const pending = body.match(/^<!-- captures-since-promote: (\d+) -->$/m)?.[1];
  const marker = lines.findLastIndex((line) => /^<!-- consolidated:.*-->$/.test(line.trim()));
  return {
    version: 1,
    ...(marker >= 0 ? { capturesSinceConsolidation: lines.slice(marker + 1).filter(isBullet).length } : {}),
    ...(pending !== undefined ? { pendingScratchCaptures: Number(pending) } : {}),
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
  let capturesSinceConsolidation =
    previous.capturesSinceConsolidation ?? previous.records.filter((record) => isBullet(record.text)).length;
  if (capture) capturesSinceConsolidation += next.filter((text) => isBullet(text) && !existing.has(text)).length;
  else if (rewritten) capturesSinceConsolidation = next.filter(isBullet).length;
  return {
    version: 1,
    capturesSinceConsolidation,
    ...(previous.pendingScratchCaptures !== undefined
      ? { pendingScratchCaptures: previous.pendingScratchCaptures }
      : {}),
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
    ...(restored.capturesSinceConsolidation !== undefined
      ? { capturesSinceConsolidation: restored.capturesSinceConsolidation }
      : {}),
    ...(restored.pendingScratchCaptures !== undefined
      ? { pendingScratchCaptures: restored.pendingScratchCaptures }
      : {}),
    records: restored.records.map((record) => ({
      ...record,
      ...inherit([record, floor], record.sensitivity),
    })),
  };
}
