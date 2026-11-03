import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AnthropicOptions,
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { createPgPool } from "../persistence/pg-pool.ts";
import { buildModelRuntime, type ProviderKeys } from "../model/model-runtime.ts";
import { DEFAULT_AGENT_MODEL_ID, resolveModel } from "../model/pi-models.ts";
import type { ModelGatewayTransportConfig } from "../model/provider-endpoints.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  currentModelRequestContext,
  withModelRequestContext,
  type ModelRequestContext,
} from "../model/request-context.ts";
import { SEAT_MODEL_ID } from "../model/seat-model.ts";
import { scopeId } from "../types.ts";
import { errMessage, swallow } from "../util/errors.ts";

type SeatBlock = { type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown> };

interface SeatStepSummary {
  id: string;
  sessionId: string;
  createdAt: number;
}

interface SeatStep extends SeatStepSummary {
  request: Record<string, unknown>;
}

interface SeatDraft {
  model: string;
  content: SeatBlock[];
  stopReason: string;
}

export type SeatErrorCode = "feature_disabled" | "step_closed" | "bad_request" | "ask_failed";

export class SeatError extends Error {
  readonly code: SeatErrorCode;
  constructor(code: SeatErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface Seat {
  enabled(actorId: string): Promise<boolean>;
  streamSimple(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream;
  pending(ownerId: string): Promise<SeatStepSummary[]>;
  step(ownerId: string, id: string): Promise<SeatStep | null>;
  move(ownerId: string, id: string, content: unknown): Promise<void>;
  ask(ownerId: string, id: string, signal: AbortSignal): Promise<SeatDraft>;
}

export interface SeatOptions {
  enabled(actorId: string): Promise<boolean>;
  ask(request: Record<string, unknown>, signal: AbortSignal): Promise<SeatDraft>;
  timeoutMs?: number;
  pollMs?: number;
  leaseMs?: number;
}

export const SEAT_OFF =
  "Agent Seat is off for you. An org admin can turn on the agent_seat feature flag for your personal scope.";
export const SEAT_PERSONAL_ONLY = "You (Agent Seat) only plays in your own personal conversations.";
const SEAT_CLOSED = "This step is no longer waiting for a move. It was answered, cancelled, or timed out.";
const TIMEOUT_MS = 30 * 60_000;
const POLL_MS = 1_000;
const LEASE_MS = 60_000;
const MAX_BLOCKS = 64;
const ASK_MAX_TOKENS = 16_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seat_steps(
    id         TEXT        PRIMARY KEY,
    owner_id   TEXT        NOT NULL,
    session_id TEXT        NOT NULL,
    request    TEXT        NOT NULL,
    move       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    held_until TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS seat_steps_owner ON seat_steps (owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS seat_steps_held_until ON seat_steps (held_until)`,
];

const OPEN = "move IS NULL AND held_until > now()";
const LEASED = "now() + $2 * interval '1 millisecond'";
const CREATED_MS = "(extract(epoch FROM created_at) * 1000)::bigint AS created_at";

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSeatMove(content: unknown): SeatBlock[] {
  if (!Array.isArray(content) || content.length === 0 || content.length > MAX_BLOCKS)
    throw new SeatError("bad_request", `content must be a list of 1 to ${MAX_BLOCKS} blocks`);
  return content.map((block): SeatBlock => {
    if (plainObject(block) && block.type === "text" && typeof block.text === "string" && block.text.trim())
      return { type: "text", text: block.text };
    if (
      plainObject(block) &&
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      block.name.trim() &&
      plainObject(block.input)
    )
      return { type: "tool_use", name: block.name.trim(), input: block.input };
    throw new SeatError(
      "bad_request",
      "each block must be non-empty text or a tool_use with a name and an object input",
    );
  });
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function seatResponse(blocks: readonly SeatBlock[]): Response {
  const events = [
    event("message_start", {
      message: {
        id: `msg_seat_${randomUUID()}`,
        type: "message",
        role: "assistant",
        model: SEAT_MODEL_ID,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  ];
  blocks.forEach((block, index) => {
    if (block.type === "text") {
      events.push(event("content_block_start", { index, content_block: { type: "text", text: "" } }));
      events.push(event("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }));
    } else {
      const id = `toolu_seat_${randomUUID().replaceAll("-", "")}`;
      events.push(
        event("content_block_start", { index, content_block: { type: "tool_use", id, name: block.name, input: {} } }),
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        }),
      );
    }
    events.push(event("content_block_stop", { index }));
  });
  events.push(
    event("message_delta", {
      delta: {
        stop_reason: blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 0 },
    }),
    event("message_stop", {}),
  );
  return new Response(events.join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
}

function seatDraftContent(message: Pick<AssistantMessage, "content">): SeatBlock[] {
  return message.content.flatMap((part): SeatBlock[] => {
    if (part.type === "text" && part.text.trim()) return [{ type: "text", text: part.text }];
    if (part.type === "toolCall") return [{ type: "tool_use", name: part.name, input: part.arguments ?? {} }];
    return [];
  });
}

export function seatRuntime(runtime: ModelRuntime, seat: Pick<Seat, "streamSimple"> | undefined): ModelRuntime {
  if (!seat) return runtime;
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    model.provider === SEAT_MODEL_ID
      ? seat.streamSimple(model, context, options)
      : streamSimple(model, context, options)) as typeof runtime.streamSimple;
  const hasConfiguredAuth = runtime.hasConfiguredAuth.bind(runtime);
  runtime.hasConfiguredAuth = (provider) => provider === SEAT_MODEL_ID || hasConfiguredAuth(provider);
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (async (model, overrides) => {
    if (typeof model === "string") return getAuth(model, overrides);
    if (model.provider === SEAT_MODEL_ID) return { auth: { apiKey: SEAT_MODEL_ID }, source: SEAT_MODEL_ID };
    return getAuth(model, overrides);
  }) as typeof runtime.getAuth;
  return runtime;
}

export function seatAsk(deps: {
  modelId: () => string;
  providerKeys: () => Promise<ProviderKeys>;
  modelGateway?: ModelGatewayTransportConfig;
}): SeatOptions["ask"] {
  return async (request, signal) => {
    const model = [deps.modelId(), DEFAULT_AGENT_MODEL_ID]
      .map((id) => resolveModel(id))
      .find((candidate) => candidate?.api === "anthropic-messages");
    if (!model)
      throw new SeatError("ask_failed", "Ask model needs an Anthropic Messages model, and none is configured.");
    const body = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "thinking" && key !== "stream"));
    const result = await buildModelRuntime(await deps.providerKeys(), deps.modelGateway, "turn")
      .then((runtime) =>
        runtime.completeSimple(
          model,
          { messages: [] },
          {
            signal,
            maxTokens: ASK_MAX_TOKENS,
            maxRetries: 0,
            onPayload: () => ({ ...body, model: model.id, max_tokens: ASK_MAX_TOKENS }),
          },
        ),
      )
      .catch((error: unknown) => {
        throw new SeatError("ask_failed", errMessage(error));
      });
    if (result.stopReason === "error" || result.stopReason === "aborted")
      throw new SeatError("ask_failed", result.errorMessage || `${model.id} did not answer.`);
    return { model: model.id, content: seatDraftContent(result), stopReason: result.stopReason };
  };
}

export function createSeat(connectionString: string, opts: SeatOptions): Seat {
  const { q, query } = createPgPool(connectionString, [{ id: "seat/0001", statements: SCHEMA }]);
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const pollMs = opts.pollMs ?? POLL_MS;
  const leaseMs = opts.leaseMs ?? LEASE_MS;

  const purge = () => query("DELETE FROM seat_steps WHERE held_until < now()");

  async function hold(context: ModelRequestContext, request: unknown, signal: AbortSignal | undefined) {
    const { actorId, sessionId } = context;
    if (!actorId || !sessionId || context.scopeId !== scopeId("personal", actorId)) throw new Error(SEAT_PERSONAL_ONLY);
    if (!(await opts.enabled(actorId))) throw new Error(SEAT_OFF);
    signal?.throwIfAborted();
    const id = randomUUID();
    await purge();
    await query(
      `INSERT INTO seat_steps (id, owner_id, session_id, request, held_until)
       VALUES ($1, $3, $4, $5, ${LEASED})`,
      [id, leaseMs, actorId, sessionId, JSON.stringify(request)],
    );
    const deadline = Date.now() + timeoutMs;
    let renewAt = Date.now() + leaseMs / 3;
    let open = true;
    const take = (move: unknown) => seatResponse(JSON.parse(move as string) as SeatBlock[]);
    try {
      for (;;) {
        await delay(pollMs, undefined, signal ? { signal } : undefined);
        const now = Date.now();
        if (now >= deadline) {
          open = false;
          const [row] = await q("DELETE FROM seat_steps WHERE id = $1 RETURNING move", [id]);
          if (typeof row?.move === "string") return take(row.move);
          throw new Error(`No move was made at the Agent Seat within ${Math.round(timeoutMs / 60_000)} minutes.`);
        }
        const renew = now >= renewAt;
        if (renew) {
          renewAt = now + leaseMs / 3;
          if (!(await opts.enabled(actorId))) throw new Error(SEAT_OFF);
        }
        const [row] = renew
          ? await q(`UPDATE seat_steps SET held_until = ${LEASED} WHERE id = $1 RETURNING move`, [id, leaseMs])
          : await q("SELECT move FROM seat_steps WHERE id = $1", [id]);
        if (!row) {
          open = false;
          throw new Error("This Agent Seat step was removed before a move was made.");
        }
        if (typeof row.move === "string") return take(row.move);
      }
    } finally {
      if (open) await query("DELETE FROM seat_steps WHERE id = $1", [id]).catch((e) => swallow("seat: close step", e));
    }
  }

  async function step(ownerId: string, id: string): Promise<SeatStep | null> {
    const [row] = await q(
      `SELECT id, session_id, request, ${CREATED_MS} FROM seat_steps WHERE id = $1 AND owner_id = $2 AND ${OPEN}`,
      [id, ownerId],
    );
    if (!row) return null;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      createdAt: Number(row.created_at),
      request: JSON.parse(row.request as string) as Record<string, unknown>,
    };
  }

  const guard = async (ownerId: string) => {
    if (!(await opts.enabled(ownerId))) throw new SeatError("feature_disabled", SEAT_OFF);
  };

  return {
    enabled: opts.enabled,

    streamSimple(model, context, options) {
      const requestContext = { ...currentModelRequestContext() };
      const client = {
        messages: {
          create: (params: unknown, request?: { signal?: AbortSignal }) => ({
            asResponse: () => hold(requestContext, params, request?.signal),
          }),
        },
      };
      return anthropicStream(model as Model<"anthropic-messages">, context, {
        ...options,
        maxTokens: options?.maxTokens ?? model.maxTokens,
        thinkingEnabled: false,
        client: client as unknown as AnthropicOptions["client"],
      });
    },

    async pending(ownerId) {
      await guard(ownerId);
      await purge();
      const rows = await q(
        `SELECT id, session_id, ${CREATED_MS} FROM seat_steps WHERE owner_id = $1 AND ${OPEN} ORDER BY created_at, id`,
        [ownerId],
      );
      return rows.map((row) => ({
        id: row.id as string,
        sessionId: row.session_id as string,
        createdAt: Number(row.created_at),
      }));
    },

    async step(ownerId, id) {
      await guard(ownerId);
      return step(ownerId, id);
    },

    async move(ownerId, id, content) {
      await guard(ownerId);
      const blocks = parseSeatMove(content);
      const result = await query(`UPDATE seat_steps SET move = $3 WHERE id = $1 AND owner_id = $2 AND ${OPEN}`, [
        id,
        ownerId,
        JSON.stringify(blocks),
      ]);
      if (result.rowCount !== 1) throw new SeatError("step_closed", SEAT_CLOSED);
    },

    async ask(ownerId, id, signal) {
      await guard(ownerId);
      const found = await step(ownerId, id);
      if (!found) throw new SeatError("step_closed", SEAT_CLOSED);
      return withModelRequestContext(
        { actorId: ownerId, scopeId: scopeId("personal", ownerId), sessionId: found.sessionId },
        () => opts.ask(found.request, signal),
      );
    },
  };
}
