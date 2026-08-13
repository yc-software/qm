import { createHash } from "node:crypto";
import { type ScopeId, parseScopeId, scopeId as makeScopeId } from "../types.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import { createKeyedQueue } from "../util/async.ts";
import { RECALL_MAX_CHARS, bullets, capTail, dateStr, isBullet, normalize } from "./notebook.ts";

export const MEMORY_FILE = "memory/MEMORY.md";
const MEMORY_HEADER = "# Memory";
const MAX_FACTS = 300;

function revisionToken(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export interface MemoryRevision {
  revision: string;
  content: string;
  operation: string;
  author?: string;
  at: number;
}

interface MemoryHead {
  content: string;
  revision: string;
  updatedAt?: number;
}

export interface MemoryService {
  recall(scopeId: ScopeId): Promise<string>;
  capture(scopeId: ScopeId, facts: string[], at: number, author?: string): Promise<number>;
  query(scopeId: ScopeId, q: string, limit?: number): Promise<string[]>;
  read(scopeId: ScopeId): Promise<string>;
  replace(scopeId: ScopeId, content: string, author?: string): Promise<void>;
  readHead?(scopeId: ScopeId): Promise<MemoryHead>;
  replaceIfRevision?(scopeId: ScopeId, content: string, revision: string, author?: string): Promise<boolean>;
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

  let body = existing.trim()
    ? `${existing.replace(/\s+$/, "")}\n${added.join("\n")}`
    : `${MEMORY_HEADER}\n\n${added.join("\n")}`;

  const lines = body.split("\n");
  const bulletIdx = lines.flatMap((l, i) => (isBullet(l) ? [i] : []));
  const overflow = bulletIdx.length - MAX_FACTS;
  if (overflow > 0) {
    const drop = new Set(bulletIdx.slice(0, overflow));
    body = lines.filter((_, i) => !drop.has(i)).join("\n");
  }
  return { body, added: added.length };
}

export function queryBullets(body: string, q: string, limit: number): string[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return bullets(body)
    .filter((l) => terms.every((t) => l.toLowerCase().includes(t)))
    .slice(0, limit);
}

export function normalizeReplace(content: string): string {
  const trimmed = content.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n` : "";
}

export function createMemoryService(workspace: WorkspaceStore): MemoryService {
  const perScope = createKeyedQueue<ScopeId>();
  return {
    async recall(scopeId) {
      return recallBody((await workspace.read(scopeId, MEMORY_FILE)) ?? "");
    },

    async capture(scopeId, facts, at, author) {
      return perScope(scopeId, async () => {
        const existing = (await workspace.read(scopeId, MEMORY_FILE)) ?? "";
        const { body, added } = foldCapture(existing, facts, at, author?.startsWith("cc:") === true);
        if (!added) return 0;
        await workspace.write(scopeId, MEMORY_FILE, `${body}\n`);
        return added;
      });
    },

    async query(scopeId, q, limit = 20) {
      return queryBullets((await workspace.read(scopeId, MEMORY_FILE)) ?? "", q, limit);
    },

    async read(scopeId) {
      return (await workspace.read(scopeId, MEMORY_FILE)) ?? "";
    },

    async replace(scopeId, content) {
      await perScope(scopeId, async () => {
        const next = normalizeReplace(content);
        if (!next) {
          await workspace.remove(scopeId, MEMORY_FILE);
          return;
        }
        await workspace.write(scopeId, MEMORY_FILE, next);
      });
    },

    async readHead(scopeId) {
      return perScope(scopeId, async () => {
        const content = (await workspace.read(scopeId, MEMORY_FILE)) ?? "";
        return { content, revision: revisionToken(content) };
      });
    },

    async replaceIfRevision(scopeId, content, revision) {
      return perScope(scopeId, async () => {
        const current = (await workspace.read(scopeId, MEMORY_FILE)) ?? "";
        if (revisionToken(current) !== revision) return false;
        const next = normalizeReplace(content);
        if (!next) await workspace.remove(scopeId, MEMORY_FILE);
        else await workspace.write(scopeId, MEMORY_FILE, next);
        return true;
      });
    },
  };
}

export function isSystemActor(actorId: string | undefined): boolean {
  return !!actorId?.startsWith("system:");
}

export function ccTargetFor(origin: ScopeId, actorId: string | undefined): ScopeId | null {
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
): Promise<number> {
  const target = ccTargetFor(origin, actorId);
  if (!target || !facts.length) return 0;
  const { kind } = parseScopeId(origin);
  const clean = sourceLabel
    ?.replace(/[()\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  const source = clean || (kind === "channel" ? "a channel" : "a group conversation");
  const tagged = facts.map((f) => `${f} (said in ${source})`);
  return memory.capture(target, tagged, at, `cc:${origin}`);
}
