import type { HarnessModelUtilities } from "../../harness/harness.ts";
import {
  type MemoryService,
  type MemoryCaptureContext,
  ccCaptureToPersonal,
  isSystemActor,
} from "../memory-service.ts";
import type { MemoryStrategy } from "../strategy.ts";
import type { ScopeId } from "../../types.ts";
import { bullets } from "../notebook.ts";

export const DEFAULT_CAPTURE_QUIET_MS = 180_000;
export const DEFAULT_CAPTURE_MAX_TURNS = 10;

export const MEMORY_EXTRACTION_PROMPT = [
  "You extract durable facts worth remembering about the user across FUTURE conversations.",
  "Given one or more consecutive exchanges (user message + assistant reply), output ONLY a markdown bullet list",
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
  "If nothing is worth remembering, output exactly: NONE",
].join("\n");

export function parseFacts(out: string): string[] {
  const trimmed = out.trim();
  if (!trimmed || /^none$/i.test(trimmed)) return [];
  return bullets(trimmed).filter(Boolean);
}

export async function extractFacts(
  harness: HarnessModelUtilities,
  turns: Array<{ input: string; reply: string }>,
): Promise<string[]> {
  if (!harness.oneShot) return [];
  try {
    const transcript = turns.map((t) => `User said:\n${t.input}\n\nAssistant replied:\n${t.reply}`).join("\n\n---\n\n");
    const out = await harness.oneShot(MEMORY_EXTRACTION_PROMPT, transcript);
    return parseFacts(out ?? "");
  } catch {
    return [];
  }
}

export interface Burst {
  scopeId: ScopeId;
  actorId?: string;
  conversationScopeId: ScopeId;
  conversationLabel?: string;
  sessionId?: string;
  idempotencyKey?: string;
  turns: Array<{ input: string; reply: string }>;
  timer?: NodeJS.Timeout;
}

export type TurnEndCtx = {
  scopeId: ScopeId;
  input: string;
  reply: string;
  actorId?: string;
  autonomous?: boolean;
  conversationScopeId?: ScopeId;
  conversationLabel?: string;
  sessionId?: string;
  idempotencyKey?: string;
};

export function createBurstBuffer(
  quietMs: number,
  maxTurns: number,
  flush: (burst: Burst) => Promise<void>,
  onError?: (e: unknown, burst: Burst) => void,
): (ctx: TurnEndCtx) => Promise<void> {
  const bursts = new Map<string, Burst>();
  return async ({
    scopeId,
    input,
    reply,
    actorId,
    autonomous,
    conversationScopeId,
    conversationLabel,
    sessionId,
    idempotencyKey,
  }) => {
    if (autonomous === true || isSystemActor(actorId)) return;
    const burst: Burst = {
      scopeId,
      conversationScopeId: conversationScopeId ?? scopeId,
      turns: [{ input, reply }],
      ...(actorId !== undefined ? { actorId } : {}),
      ...(conversationLabel !== undefined ? { conversationLabel } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
    if (quietMs <= 0) return flush(burst);

    const key = `${scopeId}\0${burst.conversationScopeId}\0${actorId ?? ""}`;
    const pending = bursts.get(key);
    if (pending) {
      pending.turns.push({ input, reply });
      clearTimeout(pending.timer);
    } else {
      bursts.set(key, burst);
    }
    const active = bursts.get(key)!;
    if (active.turns.length >= maxTurns) {
      bursts.delete(key);
      return flush(active);
    }
    const timer = setTimeout(() => {
      bursts.delete(key);
      flush(active).catch((e) => onError?.(e, active));
    }, quietMs);
    timer.unref?.();
    active.timer = timer;
  };
}

function burstCaptureContext(burst: Burst): MemoryCaptureContext {
  return {
    mode: "automatic",
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
  maintain?: (scopeId: ScopeId) => Promise<void>;
  captureQuietMs?: number;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}): MemoryStrategy {
  async function flush(burst: Burst): Promise<void> {
    const facts = await extractFacts(deps.harness, burst.turns);
    if (!facts.length) return;
    const at = Date.now();
    await deps.memory.capture(burst.scopeId, facts, at, burst.actorId, burstCaptureContext(burst));
    await ccCaptureToPersonal(
      deps.memory,
      burst.conversationScopeId,
      burst.actorId,
      facts,
      at,
      burst.conversationLabel,
      {
        ...burstCaptureContext(burst),
        ...(burst.idempotencyKey ? { idempotencyKey: `${burst.idempotencyKey}:personal` } : {}),
      },
    );
  }

  return {
    onTurnEnd: createBurstBuffer(
      deps.captureQuietMs ?? 0,
      deps.captureMaxTurns ?? DEFAULT_CAPTURE_MAX_TURNS,
      flush,
      (e, burst) => deps.onCaptureError?.(e, burst.scopeId),
    ),
    ...(deps.maintain ? { maintain: deps.maintain } : {}),
  };
}
