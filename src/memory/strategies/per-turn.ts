import { randomUUID } from "node:crypto";
import type { HarnessModelUtilities } from "../../harness/harness.ts";
import { createPgPool, tenantCols } from "../../persistence/pg-pool.ts";
import { perTenant, tenant, withTenant } from "../../tenant.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../../persistence/typed-table.ts";
import { jsonbStringify } from "../../util/text.ts";
import { type MemoryService, type MemoryCaptureContext, isSystemActor } from "../memory-service.ts";
import type { MemoryStrategy } from "../strategy.ts";
import type { ScopeId } from "../../types.ts";
import { bullets } from "../notebook.ts";
import { parseSensitivity, SENSITIVITY_PROMPT } from "../classification.ts";
import { UNTRACKED_PROVENANCE, type MemoryCaptureMetadata } from "../facts.ts";

export const DEFAULT_CAPTURE_QUIET_MS = 180_000;
const DEFAULT_CAPTURE_MAX_TURNS = 10;

export const MEMORY_EXTRACTION_PROMPT = [
  "You extract durable facts worth remembering about the user across FUTURE conversations.",
  "Given one or more consecutive exchanges (user message + assistant reply), output a markdown bullet list",
  "(`- fact`), one concise standalone fact per line, written in the third person",
  "(e.g. `- Prefers terse replies`, `- Owns the billing service`, `- Working on the Q3 launch`).",
  "Include preferences, identifiers, ongoing projects, and how they like to work.",
  "PROVENANCE: a preference, intent, or instruction is a valid fact ONLY when the user's own",
  "message in these exchanges states it. Never derive one from the assistant's reply — an",
  'assistant saying "per X\'s preference" or describing its own strategy ("queued silently to',
  'avoid spam") is NOT evidence that anyone holds that preference. Likewise EXCLUDE second-hand',
  "claims about a person who did not speak in these exchanges.",
  "EXCLUDE secrets/credentials, one-off trivia, and anything already obvious.",
  "EXCLUDE system mechanics you can look up when needed: API endpoints/headers, credential or",
  "broker plumbing, state-file paths, tool invocation details, schemas. For a standing system",
  "the user relies on (a cron, a watcher, an integration), record its EXISTENCE and purpose as",
  'one fact — not its internals. A user-stated convention ("always via the broker, never raw',
  'tokens") is a preference and belongs in memory; how the broker works does not.',
  "When the user's own message states an instruction, rule, or directive to the assistant about",
  "how future work should be done, record it VERBATIM as a quoted fact",
  '(e.g. `- Directive (user\'s words): "always run the linter before pushing"`), not a paraphrase.',
  'Facts listed under "Already remembered" are saved already: never output them again, reworded or quoted.',
  "If nothing is worth remembering, output exactly: NONE",
  SENSITIVITY_PROMPT,
  "Prepend exactly SENSITIVITY: <label> on its own first line, classifying the entire extracted list.",
].join("\n");

export function parseFacts(out: string): string[] {
  const trimmed = out.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return bullets(trimmed).filter(Boolean);
}

const KNOWN_FACTS_SHOWN = 20;

async function knownFacts(memory: MemoryService, scopeId: ScopeId): Promise<string[]> {
  const facts = (await memory.facts?.(scopeId)) ?? [];
  return facts
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, KNOWN_FACTS_SHOWN)
    .map((fact) => fact.text);
}

async function extractFacts(
  harness: HarnessModelUtilities,
  turns: Array<{ input: string; reply: string }>,
  known: readonly string[],
): Promise<{ facts: string[]; sensitivity: NonNullable<MemoryCaptureMetadata["sensitivity"]> }> {
  if (!harness.oneShot) return { facts: [], sensitivity: "unknown" };
  const exchanges = turns.map((t) => `User said:\n${t.input}\n\nAssistant replied:\n${t.reply}`).join("\n\n---\n\n");
  const transcript = known.length
    ? `Already remembered:\n${known.map((fact) => `- ${fact}`).join("\n")}\n\n---\n\n${exchanges}`
    : exchanges;
  const out = await harness.oneShot(MEMORY_EXTRACTION_PROMPT, transcript);
  return {
    facts: parseFacts(out ?? ""),
    sensitivity: parseSensitivity(/^SENSITIVITY: (ordinary|unknown|sensitive|restricted)\n/.exec(out ?? "")?.[1]),
  };
}

interface PendingCapture extends MemoryCaptureMetadata {
  scopeId: ScopeId;
  actorId?: string;
  conversationScopeId: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
  turns: Array<{ input: string; reply: string }>;
  token: string;
  at: number;
}
type Burst = Omit<PendingCapture, "token" | "at">;

type TurnEndCtx = MemoryCaptureMetadata & {
  scopeId: ScopeId;
  input: string;
  reply: string;
  actorId?: string;
  autonomous?: boolean;
  conversationScopeId?: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
};

const MEMORY_CAPTURE_PENDING: TableSpec = {
  table: "memory_capture_pending",
  key: "id",
  columns: cols(`scopeId text!, actorId text, conversationScopeId text!, sessionId text, idempotencyKey text,
    sensitivity text, inheritedFacts jsonb, turns jsonb!, token text!, at bigint!`),
};

const MEMORY_CAPTURE_PENDING_MIGRATION = mapToTableMigration(
  "memory/capture-pending/0001-typed",
  MEMORY_CAPTURE_PENDING,
);

const codec = tableCodec<PendingCapture>(MEMORY_CAPTURE_PENDING);

function createPendingCaptures(databaseUrl: string) {
  const { q, query } = createPgPool(databaseUrl, [MEMORY_CAPTURE_PENDING_MIGRATION]);
  const untracked = jsonbStringify([UNTRACKED_PROVENANCE]);
  return {
    async append(key: string, burst: PendingCapture): Promise<PendingCapture> {
      const values = codec.values(key, burst);
      const rows = await q(
        `INSERT INTO memory_capture_pending AS p (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET
           turns = p.turns || EXCLUDED.turns,
           inherited_facts = coalesce(p.inherited_facts, $${values.length + 1}::jsonb)
             || coalesce(EXCLUDED.inherited_facts, $${values.length + 1}::jsonb),
           token = EXCLUDED.token,
           at = EXCLUDED.at
         RETURNING ${codec.columns}`,
        [...values, untracked],
      );
      return codec.row(rows[0]!);
    },
    async take(key: string, token: string): Promise<boolean> {
      const { rowCount } = await query(`DELETE FROM memory_capture_pending WHERE id = $1 AND token = $2`, [key, token]);
      return rowCount > 0;
    },
    async orphans(cutoff: number): Promise<Array<[string, PendingCapture]>> {
      const rows = await q(`SELECT ${codec.columns} FROM memory_capture_pending WHERE at <= $1 ORDER BY id`, [cutoff]);
      return rows.map((r) => [String(r.id), codec.row(r)]);
    },
  };
}

const ORPHAN_GRACE_MS = 60_000;

function createBurstBuffer(
  quietMs: number,
  maxTurns: number,
  pending: ReturnType<typeof createPendingCaptures> | undefined,
  flush: (burst: Burst) => Promise<void>,
  onError?: (e: unknown, burst: Burst) => void,
): { add(ctx: TurnEndCtx): Promise<void>; sweep(): Promise<void> } {
  const timers = perTenant(() => new Map<string, NodeJS.Timeout>());
  return {
    async add({
      scopeId,
      input,
      reply,
      actorId,
      autonomous,
      conversationScopeId,
      sessionId,
      idempotencyKey,
      inheritedFacts,
    }) {
      if (autonomous === true || isSystemActor(actorId)) return;
      const burst: Burst = {
        scopeId,
        conversationScopeId: conversationScopeId ?? scopeId,
        turns: [{ input, reply }],
        ...(inheritedFacts !== undefined ? { inheritedFacts: structuredClone(inheritedFacts) } : {}),
        ...(actorId !== undefined ? { actorId } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      };
      if (!pending) return flush(burst);

      const key = JSON.stringify([scopeId, burst.conversationScopeId, actorId ?? "", sessionId ?? ""]);
      const active = await pending.append(key, { ...burst, token: randomUUID(), at: Date.now() });
      const owner = tenant();
      const scheduled = timers();
      clearTimeout(scheduled.get(key));
      const timer = setTimeout(
        () => {
          scheduled.delete(key);
          void withTenant(owner, async () => {
            if (await pending.take(key, active.token)) await flush(active);
          }).catch((e) => onError?.(e, active));
        },
        active.turns.length >= maxTurns ? 0 : quietMs,
      );
      timer.unref?.();
      scheduled.set(key, timer);
    },
    async sweep() {
      if (!pending) return;
      const cutoff = Date.now() - quietMs - ORPHAN_GRACE_MS;
      for (const [key, burst] of await pending.orphans(cutoff)) {
        if (!(await pending.take(key, burst.token))) continue;
        await flush(burst).catch((e) => onError?.(e, burst));
      }
    },
  };
}

function burstCaptureContext(burst: Burst): MemoryCaptureContext {
  return {
    mode: "automatic",
    ...(burst.inheritedFacts !== undefined ? { inheritedFacts: burst.inheritedFacts } : {}),
    ...(burst.actorId ? { actorId: burst.actorId } : {}),
    conversationScopeId: burst.conversationScopeId,
    input: burst.turns.map((turn) => turn.input).join("\n\n"),
    reply: burst.turns.map((turn) => turn.reply).join("\n\n"),
    ...(burst.sessionId ? { sessionId: burst.sessionId } : {}),
    ...(burst.idempotencyKey ? { idempotencyKey: burst.idempotencyKey } : {}),
  };
}

export function createPerTurnStrategy(deps: {
  harness: HarnessModelUtilities;
  memory: MemoryService;
  captureQuietMs?: number;
  databaseUrl?: string;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}): MemoryStrategy & { sweep(): Promise<void> } {
  const quietMs = deps.captureQuietMs ?? 0;
  if (quietMs > 0 && !deps.databaseUrl) throw new Error("a memory capture quiet window needs a pending-capture store");
  async function flush(burst: Burst): Promise<void> {
    const known = await knownFacts(deps.memory, burst.scopeId);
    const { facts, sensitivity } = await extractFacts(deps.harness, burst.turns, known);
    if (!facts.length) return;
    const at = Date.now();
    await deps.memory.capture(burst.scopeId, facts, at, burst.actorId, { ...burstCaptureContext(burst), sensitivity });
  }
  const buffer = createBurstBuffer(
    quietMs,
    deps.captureMaxTurns ?? DEFAULT_CAPTURE_MAX_TURNS,
    deps.databaseUrl ? createPendingCaptures(deps.databaseUrl) : undefined,
    flush,
    (e, burst) => deps.onCaptureError?.(e, burst.scopeId),
  );
  return { onTurnEnd: buffer.add, sweep: buffer.sweep };
}
