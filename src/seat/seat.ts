import { randomUUID } from "node:crypto";
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
import { tenantTables } from "../tenants/migrations.ts";
import { ambientTenant, type Tenant } from "../tenants/context.ts";
import { buildModelRuntime } from "../model/model-runtime.ts";
import type { ModelRoutes } from "../model/model-route.ts";
import { DEFAULT_AGENT_MODEL_ID, resolveModel } from "../model/pi-models.ts";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  currentModelRequestContext,
  withModelRequestContext,
  type ModelRequestContext,
} from "../model/request-context.ts";
import { SEAT_MODEL_ID } from "../model/seat-model.ts";
import { scopeId } from "../types.ts";
import { isObj } from "../util/objects.ts";
import { waitForClientResult, type RunSignalStore } from "../runs/run-signal-store.ts";
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
  constructor(code: SeatErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

export interface Seat {
  enabled(actorId: string): Promise<boolean>;
  streamSimple(
    model: Model<Api>,
    context: Context,
    options: SimpleStreamOptions | undefined,
    runId: string | undefined,
  ): AssistantMessageEventStream;
  pending(tenant: Tenant, ownerId: string): Promise<SeatStepSummary[]>;
  step(tenant: Tenant, ownerId: string, id: string): Promise<SeatStep | null>;
  move(tenant: Tenant, ownerId: string, id: string, content: unknown): Promise<void>;
  ask(tenant: Tenant, ownerId: string, id: string, signal: AbortSignal): Promise<SeatDraft>;
}

export interface SeatOptions {
  enabled(actorId: string): Promise<boolean>;
  ask(request: Record<string, unknown>, signal: AbortSignal): Promise<SeatDraft>;
  signals: RunSignalStore;
  runLive(runId: string): Promise<boolean>;
}

export const SEAT_OFF =
  "Agent Seat is off for you. An org admin can turn on the agent_seat feature flag for your personal scope.";
export const SEAT_PERSONAL_ONLY = "You (Agent Seat) only plays in your own personal conversations.";
const SEAT_CLOSED = "This step is no longer waiting for a move. It was answered, cancelled, or timed out.";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seat_steps(
    id         TEXT        PRIMARY KEY,
    owner_id   TEXT        NOT NULL,
    session_id TEXT        NOT NULL,
    run_id     TEXT        NOT NULL,
    request    TEXT        NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS seat_steps_owner ON seat_steps (owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS seat_steps_run ON seat_steps (run_id)`,
];

const CREATED_MS = "(extract(epoch FROM created_at) * 1000)::bigint AS created_at";

function parseSeatMove(content: unknown): SeatBlock[] {
  if (!Array.isArray(content) || content.length === 0)
    throw new SeatError("bad_request", "content must be a non-empty list of blocks");
  return content.map((block): SeatBlock => {
    if (isObj(block) && block.type === "text" && typeof block.text === "string" && block.text.trim())
      return { type: "text", text: block.text };
    if (
      isObj(block) &&
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      block.name.trim() &&
      isObj(block.input) &&
      !Array.isArray(block.input)
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

export function seatRuntime(
  runtime: ModelRuntime,
  seat: Pick<Seat, "streamSimple"> | undefined,
  runId: string | undefined,
): ModelRuntime {
  if (!seat) return runtime;
  const streamSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = ((model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    model.provider === SEAT_MODEL_ID
      ? seat.streamSimple(model, context, options, runId)
      : streamSimple(model, context, options)) as typeof runtime.streamSimple;
  return runtime;
}

export function seatAsk(routes: Pick<ModelRoutes, "baseModelId" | "route">): SeatOptions["ask"] {
  return async (request, signal) => {
    const modelId = [routes.baseModelId(), DEFAULT_AGENT_MODEL_ID].find(
      (id) => resolveModel(id)?.api === "anthropic-messages",
    );
    if (!modelId)
      throw new SeatError("ask_failed", "Ask model needs an Anthropic Messages model, and none is configured.");
    const route = await routes.route(modelId);
    const model = route.model;
    const body = Object.fromEntries(Object.entries(request).filter(([key]) => key !== "thinking" && key !== "stream"));
    const result = await buildModelRuntime(route.keys, route.gateway, "turn")
      .then((runtime) =>
        runtime.completeSimple(
          model,
          { messages: [] },
          {
            signal,
            maxRetries: 0,
            onPayload: () => ({ ...body, model: model.id, max_tokens: model.maxTokens }),
          },
        ),
      )
      .catch((error: unknown) => {
        throw new SeatError("ask_failed", errMessage(error), { cause: error });
      });
    if (result.stopReason === "error" || result.stopReason === "aborted")
      throw new SeatError("ask_failed", result.errorMessage || `${model.id} did not answer.`);
    return { model: model.id, content: seatDraftContent(result), stopReason: result.stopReason };
  };
}

export function createSeat(connectionString: string, opts: SeatOptions): Seat {
  const pg = createPgPool(connectionString, [
    { id: "seat/0001", statements: SCHEMA },
    ...tenantTables("seat/0002-tenants", [{ table: "seat_steps", primaryKey: "id" }]),
  ]);

  async function hold(
    tenant: Tenant,
    context: ModelRequestContext,
    runId: string | undefined,
    request: unknown,
    signal: AbortSignal | undefined,
  ) {
    const { actorId, sessionId } = context;
    if (!runId || !actorId || !sessionId || context.scopeId !== scopeId("personal", actorId))
      throw new Error(SEAT_PERSONAL_ONLY);
    if (!(await opts.enabled(actorId))) throw new Error(SEAT_OFF);
    signal?.throwIfAborted();
    const id = randomUUID();
    const db = pg.forTenant(tenant);
    await db.query("DELETE FROM seat_steps WHERE tenant_id = $1 AND run_id = $2", [tenant.id, runId]);
    await db.query(
      "INSERT INTO seat_steps (tenant_id, id, owner_id, session_id, run_id, request) VALUES ($1, $2, $3, $4, $5, $6)",
      [tenant.id, id, actorId, sessionId, runId, JSON.stringify(request)],
    );
    try {
      const outcome = await waitForClientResult(opts.signals, runId, id, signal ? { signal } : {});
      if (typeof outcome === "string") throw new DOMException("The turn was cancelled", "AbortError");
      return seatResponse(outcome.structured as SeatBlock[]);
    } finally {
      await db
        .query("DELETE FROM seat_steps WHERE tenant_id = $1 AND id = $2", [tenant.id, id])
        .catch((e) => swallow("seat: close step", e));
    }
  }

  async function live(tenant: Tenant, rows: Array<Record<string, unknown>>) {
    const alive = await Promise.all(rows.map((row) => opts.runLive(row.run_id as string)));
    const dead = rows.filter((_, index) => !alive[index]).map((row) => row.id);
    if (dead.length)
      await pg
        .forTenant(tenant)
        .query("DELETE FROM seat_steps WHERE tenant_id = $1 AND id = ANY($2)", [tenant.id, dead]);
    return rows.filter((_, index) => alive[index]);
  }

  async function step(tenant: Tenant, ownerId: string, id: string): Promise<SeatStep | null> {
    const [row] = await live(
      tenant,
      await pg
        .forTenant(tenant)
        .q(
          `SELECT id, session_id, run_id, request, ${CREATED_MS} FROM seat_steps WHERE tenant_id = $1 AND id = $2 AND owner_id = $3`,
          [tenant.id, id, ownerId],
        ),
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

    streamSimple(model, context, options, runId) {
      const requestContext = { ...currentModelRequestContext() };
      const tenant = ambientTenant();
      const client = {
        messages: {
          create: (params: unknown, request?: { signal?: AbortSignal }) => ({
            asResponse: () => hold(tenant, requestContext, runId, params, request?.signal),
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

    async pending(tenant, ownerId) {
      await guard(ownerId);
      const rows = await live(
        tenant,
        await pg
          .forTenant(tenant)
          .q(
            `SELECT id, session_id, run_id, ${CREATED_MS} FROM seat_steps WHERE tenant_id = $1 AND owner_id = $2 ORDER BY created_at, id`,
            [tenant.id, ownerId],
          ),
      );
      return rows.map((row) => ({
        id: row.id as string,
        sessionId: row.session_id as string,
        createdAt: Number(row.created_at),
      }));
    },

    async step(tenant, ownerId, id) {
      await guard(ownerId);
      return step(tenant, ownerId, id);
    },

    async move(tenant, ownerId, id, content) {
      await guard(ownerId);
      const blocks = parseSeatMove(content);
      const [row] = await pg
        .forTenant(tenant)
        .q("DELETE FROM seat_steps WHERE tenant_id = $1 AND id = $2 AND owner_id = $3 RETURNING run_id", [
          tenant.id,
          id,
          ownerId,
        ]);
      if (!row || !(await opts.runLive(row.run_id as string))) throw new SeatError("step_closed", SEAT_CLOSED);
      await opts.signals.send(row.run_id as string, {
        kind: "client_result",
        callId: id,
        result: { content: "seat move", structured: blocks },
      });
    },

    async ask(tenant, ownerId, id, signal) {
      await guard(ownerId);
      const found = await step(tenant, ownerId, id);
      if (!found) throw new SeatError("step_closed", SEAT_CLOSED);
      return withModelRequestContext(
        { actorId: ownerId, scopeId: scopeId("personal", ownerId), sessionId: found.sessionId },
        () => opts.ask(found.request, signal),
      );
    },
  };
}
