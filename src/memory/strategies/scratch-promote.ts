import { relative } from "node:path";
import type { ScopeId } from "../../types.ts";
import type { HarnessModelUtilities } from "../../harness/harness.ts";
import type { WorkspaceStore } from "../../workspace/workspace-store.ts";
import { type MemoryService, ccCaptureToPersonal, ccTargetFor } from "../memory-service.ts";
import type { MemoryStrategy } from "../strategy.ts";
import { bullets, capTail, dateStr, normalize } from "../notebook.ts";
import {
  type Burst,
  createBurstBuffer,
  DEFAULT_CAPTURE_MAX_TURNS,
  extractFacts,
  isAutonomousBurst,
} from "./per-turn.ts";
import { createKeyedQueue } from "../../util/async.ts";

const LOG_DIR = "memory/log";
const LOG_RETENTION_DAYS = 14;
const LOG_RECALL_MAX_CHARS = 3_000;

const MARKER_RE = /^<!-- captures-since-promote: (\d+) -->$/m;

export const PROMOTION_PROMPT = [
  "You maintain an agent's long-term memory notebook (MEMORY.md).",
  "You are given the current notebook and a scratch log of recent automatic captures.",
  "Output the COMPLETE new notebook as markdown: keep the existing `# Memory` header style,",
  "keep every still-true long-term fact, and graduate from the scratch log only what proved",
  "durable — stable preferences, identifiers, ongoing projects, how the person likes to work.",
  "Drop one-off trivia, transient task state, and anything stale or contradicted. Drop pure",
  "system mechanics that can be looked up when needed (API endpoints, credential plumbing,",
  "state-file paths) — keep user-stated conventions and the existence of standing systems.",
  "Keep facts as concise `- (YYYY-MM-DD) fact` bullets. Never include secrets or credentials.",
  "Preserve any `(said in …)` suffix on a fact verbatim — it scopes where the fact was stated.",
  "Output ONLY the new notebook content. If nothing should change, output exactly: NONE",
].join("\n");

const SCRATCH_PROMOTE_PROMPT_LINES = [
  "Your memory has two tiers: a curated long-term notebook, and dated scratch logs of recent",
  'captures that age out after a couple of weeks. Facts you save with `memory` action "remember"',
  "land in the scratch tier alongside the automatic captures; recent scratch entries are",
  "periodically reviewed and the durable ones promoted into the notebook. To pin or fix a",
  'long-term fact immediately, curate the notebook itself (action "read", then "rewrite").',
];

export function logPath(at: number): string {
  return `${LOG_DIR}/${dateStr(at)}.md`;
}

function stripMarker(body: string): string {
  return body
    .replace(MARKER_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function recentDates(now: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) out.push(dateStr(now - i * 86_400_000));
  return out;
}

export interface ScratchPromoteDeps {
  harness: HarnessModelUtilities;
  memory: MemoryService;
  workspace: WorkspaceStore;
  consolidateAfter: number;
  captureQuietMs?: number;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}

export function createScratchPromote(deps: ScratchPromoteDeps): { strategy: MemoryStrategy; memory: MemoryService } {
  const base = deps.memory;
  const workspace = deps.workspace;
  const perScope = createKeyedQueue<ScopeId>();

  async function rewriteMarker(scopeId: ScopeId, edit: (body: string) => string | null): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const head = base.readHead && base.replaceIfRevision ? await base.readHead(scopeId) : null;
      const body = head ? head.content : await base.read(scopeId);
      const next = edit(body);
      if (next === null) return null;
      if (!head) {
        await base.replace(scopeId, next);
        return next;
      }
      if (await base.replaceIfRevision!(scopeId, next, head.revision)) return next;
    }
    return null;
  }

  async function bumpMarker(scopeId: ScopeId, by: number): Promise<number> {
    let count = 0;
    const committed = await rewriteMarker(scopeId, (body) => {
      const m = body.match(MARKER_RE);
      count = (m ? Number(m[1]) : 0) + by;
      const marker = `<!-- captures-since-promote: ${count} -->`;
      return m ? body.replace(MARKER_RE, marker) : `${body.trim() || "# Memory"}\n\n${marker}`;
    });
    if (committed !== null) return count;
    const body = await base.read(scopeId);
    const m = body.match(MARKER_RE);
    return m ? Number(m[1]) : 0;
  }

  async function resetMarker(scopeId: ScopeId): Promise<void> {
    await rewriteMarker(scopeId, (body) =>
      MARKER_RE.test(body) ? body.replace(MARKER_RE, "<!-- captures-since-promote: 0 -->") : null,
    );
  }

  async function readLogWindow(
    scopeId: ScopeId,
    now: number,
    days: number,
  ): Promise<Array<{ date: string; body: string }>> {
    const out: Array<{ date: string; body: string }> = [];
    for (const date of recentDates(now, days)) {
      const body = ((await workspace.read(scopeId, `${LOG_DIR}/${date}.md`)) ?? "").trim();
      if (body) out.push({ date, body });
    }
    return out;
  }

  const memory: MemoryService = {
    ...base,
    async recall(scopeId) {
      const longTerm = stripMarker(await base.recall(scopeId));
      const parts = longTerm ? [longTerm] : [];
      for (const { date, body } of await readLogWindow(scopeId, Date.now(), 2)) {
        parts.push(`### Scratch log ${date}\n${capTail(body, LOG_RECALL_MAX_CHARS)}`);
      }
      return parts.join("\n\n");
    },

    async capture(scopeId, facts, at) {
      return perScope(scopeId, async () => {
        const clean = facts.map((f) => f.replace(/\s+/g, " ").trim()).filter(Boolean);
        if (!clean.length) return 0;
        const path = logPath(at);
        const existing = (await workspace.read(scopeId, path)) ?? "";
        const seen = new Set(bullets(existing).map(normalize));
        const date = dateStr(at);
        const added: string[] = [];
        for (const f of clean) {
          const key = normalize(f);
          if (!key || seen.has(key)) continue;
          seen.add(key);
          added.push(`- (${date}) ${f}`);
        }
        if (!added.length) return 0;
        const body = existing.trim()
          ? `${existing.replace(/\s+$/, "")}\n${added.join("\n")}`
          : `# Scratch log ${date}\n\n${added.join("\n")}`;
        await workspace.write(scopeId, path, `${body}\n`);

        const count = await bumpMarker(scopeId, added.length);
        if (deps.consolidateAfter > 0 && count >= deps.consolidateAfter) {
          await resetMarker(scopeId);
          await strategy.maintain!(scopeId).catch(() => {});
        }
        return added.length;
      });
    },

    async query(scopeId, q, limit = 20) {
      const fromNotebook = await base.query(scopeId, q, limit);
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return fromNotebook;
      const fromLogs: string[] = [];
      for (const { body } of await readLogWindow(scopeId, Date.now(), LOG_RETENTION_DAYS)) {
        for (const line of bullets(body)) {
          if (terms.every((t) => line.toLowerCase().includes(t))) fromLogs.push(line);
        }
      }
      const seen = new Set<string>();
      return [...fromNotebook, ...fromLogs].filter((l) => !seen.has(l) && (seen.add(l), true)).slice(0, limit);
    },
  };

  async function flushBurst(burst: Burst): Promise<void> {
    const autonomous = isAutonomousBurst(burst);
    const facts = await extractFacts(deps.harness, burst.turns, { autonomous });
    if (!facts.length) return;
    const at = Date.now();
    await memory.capture(burst.scopeId, facts, at);
    const ccTarget = autonomous ? null : ccTargetFor(burst.conversationScopeId, burst.actorId);
    if (!ccTarget) return;
    await ccCaptureToPersonal(memory, burst.conversationScopeId, burst.actorId, facts, at, burst.conversationLabel);
  }

  const strategy: MemoryStrategy = {
    onTurnEnd: createBurstBuffer(
      deps.captureQuietMs ?? 0,
      deps.captureMaxTurns ?? DEFAULT_CAPTURE_MAX_TURNS,
      flushBurst,
      (e, burst) => deps.onCaptureError?.(e, burst.scopeId),
    ),

    async maintain(scopeId) {
      const now = Date.now();
      const window = await readLogWindow(scopeId, now, LOG_RETENTION_DAYS);
      if (window.length && deps.harness.oneShot) {
        // Promotion is a read → model round-trip → write. A save that lands
        // during the round-trip must not be silently reverted by the write,
        // so the write is compare-and-set against the revision we read; on a
        // lost race we skip — the next promotion pass will pick everything up.
        const head = base.readHead && base.replaceIfRevision ? await base.readHead(scopeId) : null;
        const raw = head ? head.content : await base.read(scopeId);
        const longTerm = stripMarker(raw);
        const scratch = window.map(({ date, body }) => `## ${date}\n${body}`).join("\n\n");
        const out = (
          (await deps.harness.oneShot(
            PROMOTION_PROMPT,
            `Current notebook:\n${longTerm || "(empty)"}\n\nScratch log:\n${scratch}`,
          )) ?? ""
        ).trim();
        if (out && !/^none$/i.test(out)) {
          if (head) {
            await base.replaceIfRevision!(scopeId, out, head.revision);
          } else {
            await base.replace(scopeId, out);
          }
        }
      }
      const cutoff = dateStr(now - LOG_RETENTION_DAYS * 86_400_000);
      for (const abs of await workspace.list(scopeId)) {
        const rel = relative(workspace.scopeDir(scopeId), abs);
        const m = rel.match(/^memory\/log\/(\d{4}-\d\d-\d\d)\.md$/);
        if (m && m[1]! < cutoff) await workspace.remove(scopeId, rel);
      }
    },

    promptLines() {
      return SCRATCH_PROMOTE_PROMPT_LINES;
    },
  };

  return { strategy, memory };
}
