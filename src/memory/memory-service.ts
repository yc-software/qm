import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { type ScopeId, parseScopeId, scopeId as makeScopeId } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue } from "../util/async.ts";
import { RECALL_MAX_CHARS, bullets, capTail, dateStr, isBullet, normalize } from "./notebook.ts";

import type { MemoryDisclosure } from "./disclosure.ts";
import {
  parseMemoryRecords,
  renderMemoryRecords,
  updateMemoryRecords,
  type MemoryCaptureMetadata,
  type MemoryRecords,
} from "./records.ts";

export const MEMORY_FILE = "memory/MEMORY.md";
const MEMORY_HEADER = "# Memory";

function revisionToken(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface MemoryRevision {
  revision: string;
  content: string;
  operation: string;
  records?: MemoryRecords;
  author?: string;
  at: number;
}

interface MemoryHead {
  content: string;
  revision: string;
  updatedAt?: number;
  records?: MemoryRecords;
}

export interface MemoryRecallContext {
  query?: string;
  actorId?: string;
  sessionId?: string;
  conversationScopeId?: ScopeId;
  maxChars?: number;
  autonomous?: boolean;
}

export interface MemoryCaptureContext extends MemoryCaptureMetadata {
  mode: "explicit" | "automatic";
  actorId?: string;
  input?: string;
  reply?: string;
  autonomous?: boolean;
  idempotencyKey?: string;
}

export interface MemoryService {
  withDisclosure?(access: MemoryDisclosure): MemoryService;
  recall(scopeId: ScopeId, context?: MemoryRecallContext): Promise<string>;
  capture(
    scopeId: ScopeId,
    facts: string[],
    at: number,
    author?: string,
    context?: MemoryCaptureContext,
  ): Promise<number>;
  query(scopeId: ScopeId, q: string, limit?: number, context?: MemoryRecallContext): Promise<string[]>;
  read(scopeId: ScopeId): Promise<string>;
  replace(scopeId: ScopeId, content: string, author?: string): Promise<void>;
  readHead?(scopeId: ScopeId): Promise<MemoryHead>;
  replaceIfRevision?(scopeId: ScopeId, content: string, revision: string, author?: string): Promise<boolean>;
  replaceRecordsIfRevision?(
    scopeId: ScopeId,
    records: MemoryRecords,
    revision: string,
    author?: string,
  ): Promise<boolean>;
  history?(scopeId: ScopeId, limit?: number): Promise<MemoryRevision[]>;
  restore?(scopeId: ScopeId, revision: string, expectedRevision: string, author?: string): Promise<boolean>;
  updatedAt?(scopeId: ScopeId): Promise<number | undefined>;
  metadata?(): Promise<Map<ScopeId, { bytes: number; updatedAt?: number }>>;
}

export function recallBody(body: string): string {
  const trimmed = body.trim();
  return trimmed ? capTail(trimmed, RECALL_MAX_CHARS) : "";
}

export function foldCapture(
  existing: string,
  facts: string[],
  at: number,
  trustedProvenance = false,
): { body: string; added: number } {
  const clean = facts
    .map((f) => {
      let text = f
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^[-*]\s+/, "");
      if (!trustedProvenance) {
        text = text
          .replace(/^\((\d{4}-\d\d-\d\d)\)\s*/, "on $1: ")
          .replace(/\s+\(said in ([^)]+)\)\s*$/i, " [claimed source: $1]");
      }
      return text;
    })
    .filter(Boolean);
  if (!clean.length) return { body: existing, added: 0 };

  const seen = new Set(existing.split("\n").filter(isBullet).map(normalize));
  const date = dateStr(at);
  const added: string[] = [];
  for (const f of clean) {
    const key = normalize(f);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    added.push(`- (${date}) ${f}`);
  }
  if (!added.length) return { body: existing, added: 0 };

  const body = existing.trim()
    ? `${existing.replace(/\s+$/, "")}\n${added.join("\n")}`
    : `${MEMORY_HEADER}\n\n${added.join("\n")}`;
  return { body, added: added.length };
}

export function queryBullets(body: string, q: string, limit: number): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return bullets(body)
    .filter((l) => terms.every((t) => l.toLowerCase().includes(t)))
    .slice(0, limit);
}

function normalizeReplace(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n` : "";
}

export function captureRecords(
  scopeId: ScopeId,
  current: MemoryRecords,
  facts: string[],
  at: number,
  author: string | undefined,
  context: MemoryCaptureMetadata | undefined,
): { records: MemoryRecords; added: number } {
  const trusted = author?.startsWith("cc:") === true;
  const body = renderMemoryRecords(current);
  const folded = foldCapture(body, facts, at, trusted);
  if (!facts.length) return { records: current, added: 0 };
  return {
    records: updateMemoryRecords(
      scopeId,
      current,
      folded.added ? `${folded.body}\n` : body,
      context ?? {},
      foldCapture("", facts, at, trusted).body,
    ),
    added: folded.added,
  };
}

export function replaceRecords(scopeId: ScopeId, current: MemoryRecords, content: string): MemoryRecords {
  return updateMemoryRecords(scopeId, current, normalizeReplace(content));
}

function parseMemoryFile(scopeId: ScopeId, raw: string): MemoryRecords {
  if (!raw.trimStart().startsWith("{")) return parseMemoryRecords(scopeId, raw);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Malformed memory records file");
  }
  return parseMemoryRecords(scopeId, "", value);
}

export async function readMemory(workspace: WorkspaceStore, scopeId: ScopeId): Promise<string | null> {
  const raw = await workspace.read(scopeId, MEMORY_FILE);
  return raw === null ? null : renderMemoryRecords(parseMemoryFile(scopeId, raw));
}

export function createMemoryService(workspace: WorkspaceStore): MemoryService {
  const perScope = createKeyedQueue<ScopeId>();
  async function load(scopeId: ScopeId) {
    const raw = (await workspace.read(scopeId, MEMORY_FILE)) ?? "";
    const records = parseMemoryFile(scopeId, raw);
    return { raw, records, body: renderMemoryRecords(records), revision: revisionToken(raw) };
  }
  async function save(scopeId: ScopeId, raw: string, records: MemoryRecords) {
    const next =
      records.records.length || records.capturesSinceConsolidation || records.pendingScratchCaptures
        ? `${JSON.stringify(records)}\n`
        : "";
    if (next === raw) return;
    if (next) await workspace.write(scopeId, MEMORY_FILE, next);
    else await workspace.remove(scopeId, MEMORY_FILE);
  }
  return {
    async recall(scopeId) {
      return recallBody((await load(scopeId)).body);
    },

    async capture(scopeId, facts, at, author, context) {
      return perScope(scopeId, async () => {
        const head = await load(scopeId);
        const next = captureRecords(scopeId, head.records, facts, at, author, context);
        if (!isDeepStrictEqual(next.records, head.records)) await save(scopeId, head.raw, next.records);
        return next.added;
      });
    },

    async query(scopeId, q, limit = 20) {
      return queryBullets((await load(scopeId)).body, q, limit);
    },

    async read(scopeId) {
      return (await load(scopeId)).body;
    },

    async replace(scopeId, content) {
      await perScope(scopeId, async () => {
        const head = await load(scopeId);
        await save(scopeId, head.raw, replaceRecords(scopeId, head.records, content));
      });
    },

    async readHead(scopeId) {
      return perScope(scopeId, async () => {
        const head = await load(scopeId);
        return { content: head.body, revision: head.revision, records: head.records };
      });
    },

    async replaceIfRevision(scopeId, content, revision) {
      return perScope(scopeId, async () => {
        const head = await load(scopeId);
        if (head.revision !== revision) return false;
        await save(scopeId, head.raw, replaceRecords(scopeId, head.records, content));
        return true;
      });
    },

    async replaceRecordsIfRevision(scopeId, records, revision) {
      return perScope(scopeId, async () => {
        const head = await load(scopeId);
        if (head.revision !== revision) return false;
        await save(scopeId, head.raw, parseMemoryRecords(scopeId, "", records));
        return true;
      });
    },
  };
}

export function isSystemActor(actorId: string | undefined): boolean {
  return !!actorId?.startsWith("system:");
}

function ccTargetFor(origin: ScopeId, actorId: string | undefined): ScopeId | null {
  if (!actorId || isSystemActor(actorId)) return null;
  const { kind } = parseScopeId(origin);
  if (kind !== "channel" && kind !== "group") return null;
  const target = makeScopeId("personal", actorId);
  return target === origin ? null : target;
}

export async function ccCaptureToPersonal(
  memory: MemoryService,
  origin: ScopeId,
  actorId: string | undefined,
  facts: string[],
  at: number,
  sourceLabel?: string,
  context?: MemoryCaptureContext,
): Promise<number> {
  const target = ccTargetFor(origin, actorId);
  if (!target || !facts.length) return 0;
  if (!(await memory.readHead?.(target))?.records) return 0;
  const { kind } = parseScopeId(origin);
  const clean = sourceLabel
    ?.replace(/[()\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const source = clean || (kind === "channel" ? "a channel" : "a group conversation");
  const tagged = facts.map((f) => `${f} (said in ${source})`);
  return memory.capture(target, tagged, at, `cc:${origin}`, {
    ...context,
    mode: context?.mode ?? "automatic",
    conversationScopeId: origin,
  });
}
