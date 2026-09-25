import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import { sleep, createKeyedQueue } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { isTerminal, type RunStore } from "../runs/run-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { runResultDelivery } from "../delivery/run-result-delivery.ts";

export interface TaskAckState {
  channel: string;
  emoji: string;
  target: string;
  previous: string[];
  finished: boolean;
  synced?: boolean;
}

interface ReactionClient {
  reactions: {
    add(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(input: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
}

export function createTaskAcknowledgements(
  store: DurableMap<TaskAckState>,
  lease: LeaderLease,
  recovery?: { runs: Pick<RunStore, "get">; deliveries: Pick<DeliveryStore, "pending"> },
) {
  if (!store.update) throw new Error("Task acknowledgements require atomic updates");
  const update = store.update.bind(store);
  const queue = createKeyedQueue<string>();
  const change = (
    client: ReactionClient,
    runId: string,
    next?: { channel: string; ts: string; pick?: () => Promise<string | undefined>; existing?: boolean },
  ) => queue(runId, () => apply(client, runId, next));
  async function apply(
    client: ReactionClient,
    runId: string,
    next?: { channel: string; ts: string; pick?: () => Promise<string | undefined>; existing?: boolean },
  ) {
    const started = Date.now();
    while (Date.now() - started < 15_000) {
      const result = await lease.hold(`slack:task-ack:${runId}`, async (lost) => {
        let leaseLost = false;
        void lost.then(() => {
          leaseLost = true;
        });
        let state = await store.get(runId);
        if (!state) {
          if (next?.existing) return true;
          const emoji = next?.pick
            ? await Promise.race([next.pick().catch(() => undefined), sleep(1500).then(() => undefined)])
            : undefined;
          if (leaseLost) return false;
          await store.putIfAbsent(runId, {
            channel: next?.channel ?? "",
            emoji: emoji || "eyes",
            target: next?.ts ?? "",
            previous: [],
            finished: !next,
          });
        }
        if (leaseLost) return false;
        state = await update(runId, (current) => {
          if (!next && !current.finished)
            return {
              ...current,
              finished: true,
              synced: false,
              previous: [...new Set([...current.previous, current.target])].filter(Boolean),
            };
          if (next && !current.finished && current.channel === next.channel && Number(next.ts) > Number(current.target))
            return {
              ...current,
              target: next.ts,
              synced: false,
              previous: [...new Set([...current.previous, current.target])].filter(Boolean),
            };
          return current;
        });
        if (!state || leaseLost) return false;
        const snapshot = state;
        const reaction = async (action: "add" | "remove", ts: string) => {
          try {
            await client.reactions[action]({ channel: snapshot.channel, timestamp: ts, name: snapshot.emoji });
          } catch (error) {
            const code = (error as { data?: { error?: string } }).data?.error;
            if (
              !(action === "add" ? code === "already_reacted" : code === "no_reaction" || code === "message_not_found")
            )
              throw error;
          }
        };
        if (!state.finished) {
          await reaction("add", state.target);
          const current = await store.get(runId);
          if (current?.finished || current?.target !== state.target) {
            await update(runId, (value) => ({
              ...value,
              previous: [...new Set([...value.previous, snapshot.target])],
              synced: false,
            }));
            await reaction("remove", state.target);
          }
        }
        if (leaseLost) return false;
        for (const ts of state.previous) {
          if (leaseLost) return false;
          await reaction("remove", ts);
          await update(runId, (current) => ({ ...current, previous: current.previous.filter((old) => old !== ts) }));
        }
        await update(runId, (current) =>
          current.target === snapshot.target && current.finished === snapshot.finished && current.previous.length === 0
            ? { ...current, synced: true }
            : current,
        );
        return true;
      });
      if (result) return;
      await sleep(50);
    }
    throw new Error("Task acknowledgement lock timed out");
  }
  return {
    reconcile: async (client: ReactionClient) => {
      for (const [runId, state] of await store.entries()) {
        if (!state.finished && recovery) {
          const run = await recovery.runs.get(runId);
          if (run && isTerminal(run.status) && !runResultDelivery(run)) {
            const pending = await recovery.deliveries.pending("slack");
            if (
              !pending.some(
                (delivery) =>
                  delivery.idempotencyKey === `ack:${runId}` || delivery.idempotencyKey?.startsWith(`post:${runId}:`),
              )
            ) {
              await change(client, runId).catch(swallowAs("slack: finish recovered task acknowledgement", undefined));
              continue;
            }
          }
        }
        if (!state.synced)
          await change(client, runId, { channel: state.channel, ts: state.target, existing: true }).catch(
            swallowAs("slack: reconcile task acknowledgement", undefined),
          );
      }
    },
    move: (
      client: ReactionClient,
      runId: string,
      channel: string,
      ts: string,
      pick?: () => Promise<string | undefined>,
    ) => change(client, runId, { channel, ts, pick }),
    finish: (client: ReactionClient, runId: string) => change(client, runId),
  };
}

export type TaskAcknowledgements = ReturnType<typeof createTaskAcknowledgements>;
