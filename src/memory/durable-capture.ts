import { isDurableControlFlow, type DurableTasks } from "../durable/tasks.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import { hashId } from "../util/crypto.ts";
import { isSystemActor } from "./memory-service.ts";
import { DEFAULT_CAPTURE_MAX_TURNS } from "./strategies/per-turn.ts";
import type { MemoryStrategy } from "./strategy.ts";
import type { MetricsSink } from "../admin/metrics-sink.ts";

type Capture = Omit<Parameters<NonNullable<MemoryStrategy["onTurnEnd"]>>[0], "signal" | "checkpoint">;
type CaptureEvent = { params: Capture; acceptedAt: number; id: string };
export interface MemoryCaptureBurst {
  accepted: Record<string, true>;
  pending: CaptureEvent[];
  active: Record<string, CaptureEvent[]>;
}

export function withDurableMemoryCapture(
  strategy: MemoryStrategy,
  tasks: DurableTasks,
  bursts: DurableMap<MemoryCaptureBurst>,
  quietMs: number,
  maxTurns = DEFAULT_CAPTURE_MAX_TURNS,
  telemetry: { metrics?: MetricsSink; onError?: (error: unknown, capture: Capture) => void } = {},
): MemoryStrategy {
  const capture = strategy.onTurnEnd?.bind(strategy);
  if (!capture) return strategy;
  if (!bursts.update) throw new Error("Memory capture requires atomic burst updates");
  const size = Math.max(1, maxTurns);
  tasks.register<CaptureEvent, void>("memory.capture", async (context, event) => {
    const params = event.params;
    const group = hashId([params.scopeId, params.conversationScopeId ?? params.scopeId, params.actorId ?? ""], 48);
    await context.step("admit", async () => {
      await bursts.putIfAbsent(group, { accepted: {}, pending: [], active: {} });
      await bursts.update!(group, (state) =>
        state.accepted[event.id]
          ? state
          : {
              ...state,
              accepted: { ...state.accepted, [event.id]: true },
              pending: [...state.pending, event].sort((a, b) => a.acceptedAt - b.acceptedAt),
            },
      );
    });
    const batch = await context.step("selected-batch", async () => {
      let selected: CaptureEvent[] | undefined;
      for (;;) {
        let waitUntil: number | undefined;
        await bursts.update!(group, (state) => {
          selected = state.active[context.taskID];
          if (selected || !state.pending.length) return state;
          const last = state.pending.at(-1)!;
          const readyAt = last.acceptedAt + Math.max(0, quietMs);
          if (state.pending.length < size && Date.now() < readyAt) {
            waitUntil = readyAt;
            return state;
          }
          selected = state.pending.slice(0, size);
          return {
            ...state,
            pending: state.pending.slice(size),
            active: { ...state.active, [context.taskID]: selected },
          };
        });
        if (waitUntil === undefined) return selected ?? null;
        await context.sleepUntil(`quiet:${waitUntil}`, new Date(waitUntil));
      }
    });
    if (!batch?.length) return;
    const accepted = batch;
    await context.step("capture", async () => {
      const startedAt = Date.now();
      try {
        const first = accepted[0]!.params;
        const idempotencyKey = `memory-batch:${context.taskID}`;
        if (strategy.captureBurst) {
          await strategy.captureBurst({
            ...first,
            conversationScopeId: first.conversationScopeId ?? first.scopeId,
            idempotencyKey,
            signal: context.signal,
            checkpoint: (name, run) => context.step(`capture:${name}`, run),
            turns: accepted.map(({ params: turn }) => ({ input: turn.input, reply: turn.reply })),
          });
        } else {
          for (const { params: turn, id } of accepted) {
            await context.step(`capture:turn:${id}`, () =>
              capture({
                ...turn,
                signal: context.signal,
                checkpoint: (name, run) => context.step(`capture:turn:${id}:${name}`, run),
              }),
            );
          }
        }
      } catch (error) {
        if (!isDurableControlFlow(error) && !context.signal.aborted) telemetry.onError?.(error, params);
        throw error;
      } finally {
        telemetry.metrics?.record({
          totalMs: 0,
          status: "capture",
          scopeLabel: params.conversationScopeId ?? params.scopeId,
          captureMs: Date.now() - startedAt,
        });
      }
    });
    await context.step("complete", async () => {
      await bursts.update!(group, (state) => {
        const active = { ...state.active };
        delete active[context.taskID];
        return { ...state, active };
      });
    });
  });
  return {
    ...strategy,
    async onTurnEnd({ signal: _signal, checkpoint: _checkpoint, ...params }) {
      if (!params.idempotencyKey) throw new Error("Memory capture requires a durable turn identity");
      if (params.autonomous || isSystemActor(params.actorId)) return;
      const id = hashId([params.scopeId, params.idempotencyKey], 48);
      await tasks.spawn(
        "memory.capture",
        { params, acceptedAt: Date.now(), id },
        {
          idempotencyKey: `memory:${id}`,
          maxAttempts: null,
        },
      );
    },
  };
}
