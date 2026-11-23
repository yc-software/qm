import type { ModelUtilities } from "../../agent/agent.ts";
import type { MemoryService, MemoryCaptureContext } from "../memory-service.ts";
import type { MemoryStrategy } from "../strategy.ts";
import type { ScopeId } from "../../types.ts";
import { parseSensitivity, SENSITIVITY_PROMPT } from "../classification.ts";
import type { MemoryCaptureMetadata, MemorySensitivity } from "../facts.ts";
import { fencedCodeBlocks } from "../../util/markdown.ts";
import { swallow } from "../../util/errors.ts";

export const DEFAULT_CAPTURE_QUIET_MS = 180_000;
const DEFAULT_CAPTURE_MAX_TURNS = 10;

export const MEMORY_EXTRACTION_PROMPT = [
  "You extract durable facts worth remembering about the user across FUTURE conversations.",
  "Given one or more consecutive exchanges (user message + assistant reply), output ONLY a JSON array of objects",
  '(`[{"text": "...", "sensitivity": "ordinary" | "sensitive"}]`), one concise standalone fact per item, written in the third person',
  '(e.g. `[{"text": "Prefers terse replies", "sensitivity": "ordinary"}, {"text": "Salary band is L5", "sensitivity": "sensitive"}]`).',
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
  '(e.g. `Directive (user\'s words): "always run the linter before pushing"`), not a paraphrase.',
  "If nothing is worth remembering, output: []",
  SENSITIVITY_PROMPT,
].join("\n");

interface ExtractedFact {
  text: string;
  sensitivity: MemorySensitivity;
}

function parseExtractedFacts(out: string): ExtractedFact[] {
  const trimmed = out.trim();
  if (!trimmed) return [];
  const body = (fencedCodeBlocks(trimmed)[0]?.body ?? trimmed).trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (!Array.isArray(parsed)) {
      swallow("memory extraction", new Error(`expected JSON array, got ${typeof parsed}: ${body.slice(0, 200)}`));
      return [];
    }
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        swallow(
          "memory extraction",
          new Error(`invalid extracted fact entry: ${(JSON.stringify(entry) ?? "undefined").slice(0, 120)}`),
        );
        return [];
      }
      const record = entry as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) {
        swallow(
          "memory extraction",
          new Error(`missing fact text in entry: ${(JSON.stringify(entry) ?? "undefined").slice(0, 120)}`),
        );
        return [];
      }
      return [{ text, sensitivity: parseSensitivity(record.sensitivity, "memory extraction") }];
    });
  } catch (e) {
    swallow("memory extraction", new Error(`invalid JSON output: ${body.slice(0, 200)}`, { cause: e }));
    return [];
  }
}

export function parseFacts(out: string): string[] {
  return parseExtractedFacts(out).map((entry) => entry.text);
}

async function extractFacts(
  agent: ModelUtilities,
  turns: Array<{ input: string; reply: string }>,
): Promise<ExtractedFact[]> {
  if (!agent.oneShot) return [];
  try {
    const transcript = turns.map((t) => `User said:\n${t.input}\n\nAssistant replied:\n${t.reply}`).join("\n\n---\n\n");
    const out = await agent.oneShot(MEMORY_EXTRACTION_PROMPT, transcript, "memory_capture");
    return parseExtractedFacts(out ?? "");
  } catch (e) {
    swallow("memory extraction", e);
    return [];
  }
}

interface Burst extends MemoryCaptureMetadata {
  scopeId: ScopeId;
  actorId?: string;
  audienceScopeId?: ScopeId;
  conversationScopeId: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
  turns: Array<{ input: string; reply: string }>;
  timer?: NodeJS.Timeout;
}

type TurnEndCtx = MemoryCaptureMetadata & {
  scopeId: ScopeId;
  input: string;
  reply: string;
  actorId?: string;
  audienceScopeId?: ScopeId;
  conversationScopeId?: ScopeId;
  sessionId?: string;
  idempotencyKey?: string;
};

function createBurstBuffer(
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
    audienceScopeId,
    conversationScopeId,
    sessionId,
    idempotencyKey,
  }) => {
    const burst: Burst = {
      scopeId,
      conversationScopeId: conversationScopeId ?? scopeId,
      turns: [{ input, reply }],
      ...(actorId !== undefined ? { actorId } : {}),
      ...(audienceScopeId !== undefined ? { audienceScopeId } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    };
    if (quietMs <= 0) return flush(burst);

    const key = `${scopeId}\0${burst.conversationScopeId}\0${actorId ?? ""}\0${sessionId ?? ""}\0${audienceScopeId ?? ""}`;
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
    ...(burst.audienceScopeId ? { audienceScopeId: burst.audienceScopeId } : {}),
    conversationScopeId: burst.conversationScopeId,
    input: burst.turns.map((turn) => turn.input).join("\n\n"),
    reply: burst.turns.map((turn) => turn.reply).join("\n\n"),
    ...(burst.sessionId ? { sessionId: burst.sessionId } : {}),
    ...(burst.idempotencyKey ? { idempotencyKey: burst.idempotencyKey } : {}),
  };
}

export function createPerTurnStrategy(deps: {
  agent: ModelUtilities;
  memory: MemoryService;
  captureQuietMs?: number;
  captureMaxTurns?: number;
  onCaptureError?: (e: unknown, scopeId: ScopeId) => void;
}): MemoryStrategy {
  async function flush(burst: Burst): Promise<void> {
    const extracted = await extractFacts(deps.agent, burst.turns);
    if (!extracted.length) return;
    const at = Date.now();
    await deps.memory.capture(
      burst.scopeId,
      extracted.map((entry) => entry.text),
      at,
      burst.actorId ? { actorId: burst.actorId, context: "conversation" } : undefined,
      {
        ...burstCaptureContext(burst),
        sensitivities: extracted.map((entry) => entry.sensitivity),
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
  };
}
