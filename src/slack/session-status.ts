import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isTerminal, leaseLapsed, type RunStore } from "../runs/run-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

export interface SlackSessionStatusState {
  account: string;
  channel: string;
  threadTs: string;
  runIds: string[];
  refreshedAt: number;
}

interface StatusClient {
  apiCall(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export function createSlackSessionStatus(
  store: DurableMap<SlackSessionStatusState>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get">,
  flags: Pick<FeatureFlagStore, "enabled">,
  now = Date.now,
) {
  const queue = createKeyedQueue<string>();
  const unsupported = new Set<string>();
  const key = (account: string, channel: string, threadTs: string) => JSON.stringify([account, channel, threadTs]);
  const enabled = async (runId: string) => {
    const run = await runs.get(runId);
    return (
      run &&
      !isTerminal(run.status) &&
      (await flags.enabled(
        "slack_loading_indicator",
        conversationScope(run.request.conversation, run.request.actor.id),
      ))
    );
  };
  async function sync(client: StatusClient, id: string, next?: SlackSessionStatusState) {
    await queue(id, async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const applied = await lease.hold(`slack:session-status:${id}`, async (lost) => {
          let leaseLost = false;
          void lost.then(() => {
            leaseLost = true;
          });
          let state = await store.get(id);
          if (unsupported.has(next?.account ?? state?.account ?? "")) return true;
          if (next) {
            if (!(await enabled(next.runIds[0]!)) || leaseLost) return true;
            state = state
              ? {
                  ...state,
                  runIds: [...new Set([...state.runIds, ...next.runIds])],
                  refreshedAt: state.runIds.length ? state.refreshedAt : 0,
                }
              : next;
            await store.put(id, state);
          }
          if (!state || leaseLost) return true;
          const live = (
            await Promise.all(state.runIds.map(async (runId) => ((await enabled(runId)) ? runId : null)))
          ).filter((runId): runId is string => runId !== null);
          if (leaseLost) return true;
          state = { ...state, runIds: live };
          await store.put(id, state);
          if (live.length && state.refreshedAt && now() - state.refreshedAt < 30 * 60_000) return true;
          if (leaseLost) return true;
          if (live.length) {
            const active = await Promise.all(live.map((runId) => runs.get(runId)));
            if (!active.some((run) => run?.status === "running" && !leaseLapsed(run, now()))) return true;
          }
          try {
            await client.apiCall("agents.sessions.setStatus", {
              channel_id: state.channel,
              thread_ts: state.threadTs,
              status: live.length ? "processing" : "active",
            });
          } catch (error) {
            await store.merge(id, { refreshedAt: 0 });
            const code = (error as { data?: { error?: string } }).data?.error;
            if (
              [
                "feature_disabled",
                "missing_scope",
                "not_allowed_token_type",
                "unknown_method",
                "invalid_auth",
                "account_inactive",
                "token_revoked",
                "token_expired",
              ].includes(code ?? "")
            ) {
              unsupported.add(state.account);
              if (!leaseLost) await store.delete(id);
            } else if (
              ["channel_not_found", "not_authorized", "no_permission", "thread_ts_not_allowed"].includes(code ?? "")
            ) {
              if (!leaseLost) await store.delete(id);
            }
            throw error;
          } finally {
            if (leaseLost) {
              await store.putIfAbsent(id, state);
              await store.merge(id, { refreshedAt: 0 });
            }
          }
          if (leaseLost) return true;
          if (live.length) await store.put(id, { ...state, refreshedAt: now() });
          else await store.delete(id);
          return true;
        });
        if (applied) return;
        await sleep(50);
      }
      throw new Error("Slack session status lock timed out");
    });
  }
  return {
    async start(client: StatusClient, account: string, runId: string, channel: string, threadTs?: string) {
      if (!threadTs) return;
      await sync(client, key(account, channel, threadTs), {
        account,
        channel,
        threadTs,
        runIds: [runId],
        refreshedAt: 0,
      }).catch(swallowAs("slack: start session status", undefined));
    },
    async reconcile(client: StatusClient, account: string) {
      for (const [id, state] of await store.entries()) {
        if (state.account !== account) continue;
        await sync(client, id).catch(swallowAs("slack: reconcile session status", undefined));
      }
    },
  };
}

export type SlackSessionStatus = ReturnType<typeof createSlackSessionStatus>;
