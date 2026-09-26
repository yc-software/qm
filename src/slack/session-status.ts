import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isTerminal, leaseLapsed, type RunStore } from "../runs/run-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";

export interface SlackSessionStatusState {
  writer?: string;
  account: string;
  channel: string;
  threadTs: string;
  runIds: string[];
  refreshedAt: number;
  anchorRunId?: string;
  startedAt?: number;
  cardId?: string;
  cardTs?: string;
  cardContent?: string;
  followUrl?: string;
  nativeStatus?: "processing" | "active";
}

interface StatusClient {
  apiCall(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface SlackStatusActivity {
  sessions?: Pick<SessionStore, "getByThread">;
  processes?: Pick<ProcessRegistry, "liveByScope">;
  monitors?: Pick<MonitorStore, "enabled">;
  publicWebUrl?: string;
}

export function createSlackSessionStatus(
  store: DurableMap<SlackSessionStatusState>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get"> & Partial<Pick<RunStore, "inFlightForThread" | "latestForThread">>,
  flags: Pick<FeatureFlagStore, "enabled">,
  now = Date.now,
  activity: SlackStatusActivity = {},
) {
  if (!store.update || !store.deleteIf) throw new Error("Slack status requires atomic durable updates");
  const update = store.update.bind(store);
  const deleteIf = store.deleteIf.bind(store);
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
          const writer = randomUUID();
          if (next && !(await enabled(next.runIds[0]!))) return true;
          if (leaseLost) return true;
          if (next) await store.putIfAbsent(id, { ...next, writer });
          if (leaseLost) {
            await deleteIf(id, (row) => row.writer === writer && !row.cardTs);
            return true;
          }
          let state = await update(id, (row) =>
            leaseLost
              ? row
              : {
                  ...row,
                  writer,
                  ...(next
                    ? { anchorRunId: next.anchorRunId, runIds: [...new Set([...row.runIds, ...next.runIds])] }
                    : {}),
                },
          );
          if (!state || leaseLost || state.writer !== writer) return true;
          const persist = async (patch: Partial<SlackSessionStatusState>) => {
            const saved = await update(id, (row) => (!leaseLost && row.writer === writer ? { ...row, ...patch } : row));
            if (!saved || leaseLost || saved.writer !== writer) return false;
            state = saved;
            return true;
          };
          let anchor = await runs.get(state.anchorRunId ?? state.runIds.at(-1)!);
          const inflight = anchor?.sessionId ? ((await runs.inFlightForThread?.(anchor.sessionId)) ?? []) : [];
          const recent = anchor?.sessionId
            ? await runs.latestForThread?.(anchor.sessionId, { excludePrivateMessages: true, statusUpdatesOnly: true })
            : null;
          const engaged = inflight.filter(
            (run) =>
              run.deliveryState?.replying &&
              !run.request.privateSessionMessage &&
              run.createdAt >= (anchor?.createdAt ?? 0),
          );
          const candidates = [...engaged, ...(recent && recent.createdAt >= (anchor?.createdAt ?? 0) ? [recent] : [])];
          const latest = candidates.sort((a, b) => b.createdAt - a.createdAt)[0];
          if (latest) anchor = latest;
          state = {
            ...state,
            anchorRunId: anchor?.id ?? state.anchorRunId,
            runIds: [...new Set([...state.runIds, ...engaged.map((run) => run.id)])],
          };
          const scope = anchor && conversationScope(anchor.request.conversation, anchor.request.actor.id);
          const optedIn = !!scope && (await flags.enabled("slack_loading_indicator", scope));
          const live = (
            await Promise.all(state.runIds.map(async (runId) => ((await enabled(runId)) ? runId : null)))
          ).filter((runId): runId is string => runId !== null);
          const active = await Promise.all(live.map((runId) => runs.get(runId)));
          const processing = active.some((run) => run?.status === "running" && !leaseLapsed(run, now()));
          const threadRef = anchor?.request.conversation.threadRef;
          const jobs =
            optedIn && threadRef
              ? ((await activity.processes?.liveByScope(scope!, now())) ?? []).filter(
                  (job) => job.kind === "background" && job.sessionRef === threadRef,
                )
              : [];
          const monitors =
            optedIn && threadRef
              ? ((await activity.monitors?.enabled()) ?? []).filter(
                  (monitor) =>
                    monitor.ownerScopeId === scope && monitor.threadRef === threadRef && monitor.expiresAt > now(),
                )
              : [];
          const ongoing = live.length > 0 || jobs.length > 0 || monitors.length > 0;
          const failed = anchor?.status === "failed" || anchor?.result?.status === "failed";
          let title = "Finished";
          if (!optedIn) title = "Status updates disabled";
          else if (processing) title = "Working";
          else if (live.length) title = "Waiting for QM to resume";
          else if (monitors.length) title = "Watching background work";
          else if (jobs.length) title = "Waiting on recorded background jobs";
          else if (anchor?.result?.stopped) title = "Stopped";
          else if (failed) title = "Failed";
          else if (anchor?.result?.status === "pending_approval") title = "Waiting for approval";
          else if (anchor?.result?.status === "refused") title = "Could not proceed";
          else if (!anchor) title = "Work interrupted";
          let cardStatus = "complete";
          if (ongoing) cardStatus = "in_progress";
          else if (failed || !anchor) cardStatus = "error";
          state = {
            ...state,
            runIds: live,
            anchorRunId: state.anchorRunId ?? anchor?.id,
            startedAt: state.startedAt ?? now(),
            cardId: state.cardId ?? randomUUID(),
          };
          if (now() - state.startedAt! > 5 * 60_000 && anchor?.sessionId) {
            const session = await activity.sessions?.getByThread(anchor.sessionId);
            if (session) state.followUrl = conversationWebUrl(activity.publicWebUrl, session.id);
          }
          if (leaseLost) return true;
          if (!(await persist(state))) return true;
          const blocks: Record<string, unknown>[] = [
            { type: "task_card", task_id: `${SLACK_STATUS_TASK_PREFIX}${state.cardId}`, title, status: cardStatus },
          ];
          if (state.followUrl)
            blocks.push({
              type: "context",
              elements: [{ type: "mrkdwn", text: `<${state.followUrl}|Follow via QM Web>` }],
            });
          const content = JSON.stringify(blocks);
          try {
            let cardError: unknown;
            try {
              if (state.cardContent !== content && (state.cardTs || optedIn)) {
                const result = (await client.apiCall(state.cardTs ? "chat.update" : "chat.postMessage", {
                  channel: state.channel,
                  ...(state.cardTs ? { ts: state.cardTs } : { thread_ts: state.threadTs, client_msg_id: state.cardId }),
                  text: title,
                  blocks,
                  unfurl_links: false,
                  unfurl_media: false,
                })) as { ts?: string };
                const cardTs = state.cardTs ?? result.ts;
                if (!cardTs) throw new Error("Slack task card response missing timestamp");
                if (leaseLost) {
                  await update(id, (row) => (row.cardId === state!.cardId && !row.cardTs ? { ...row, cardTs } : row));
                  state = { ...state, cardTs };
                  return true;
                }
                if (!(await persist({ cardTs, cardContent: content }))) return true;
              }
            } catch (error) {
              cardError = error;
            }
            const nativeStatus = processing ? "processing" : "active";
            if (
              !unsupported.has(state.account) &&
              (state.nativeStatus !== nativeStatus ||
                !state.refreshedAt ||
                (processing && now() - state.refreshedAt >= 30 * 60_000))
            ) {
              try {
                await client.apiCall("agents.sessions.setStatus", {
                  channel_id: state.channel,
                  thread_ts: state.threadTs,
                  status: nativeStatus,
                });
              } catch (error) {
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
                )
                  unsupported.add(state.account);
                else throw error;
              }
              if (leaseLost) return true;
              if (!(await persist({ nativeStatus, refreshedAt: now() }))) return true;
            }
            if (cardError) throw cardError;
            if (!ongoing) await deleteIf(id, (row) => !leaseLost && row.writer === writer);
          } catch (error) {
            await persist({ refreshedAt: 0 });
            const code = (error as { data?: { error?: string } }).data?.error;
            if (
              [
                "channel_not_found",
                "not_authorized",
                "no_permission",
                "thread_ts_not_allowed",
                "message_not_found",
              ].includes(code ?? "") &&
              !leaseLost
            )
              await deleteIf(id, (row) => !leaseLost && row.writer === writer);
            throw error;
          } finally {
            if (leaseLost) {
              await store.putIfAbsent(id, state);
              await update(id, (row) => ({ ...row, refreshedAt: 0, cardContent: undefined }));
            }
          }
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
        anchorRunId: runId,
        startedAt: now(),
        cardId: randomUUID(),
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
