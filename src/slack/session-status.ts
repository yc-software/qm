import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isTerminal, leaseLapsed, type Run, type RunStore } from "../runs/run-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { EMOJI_CHAR_BY_NAME } from "./emoji-map.ts";

export interface SlackSessionStatusState {
  writer?: string;
  account: string;
  channel: string;
  threadTs: string;
  anchorRunId: string;
  startedAt?: number;
  emoji?: string;
  cardId?: string;
  cardTs?: string;
  cardContent?: string;
  followUrl?: string;
}

interface StatusClient {
  apiCall(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface SlackStatusActivity {
  sessions?: Pick<SessionStore, "getByThread" | "childrenOf" | "descendantsOf" | "latestToolSteps">;
  processes?: Pick<ProcessRegistry, "liveByScope">;
  monitors?: Pick<MonitorStore, "ownedBy">;
  publicWebUrl?: string;
}

export function createSlackSessionStatus(
  store: DurableMap<SlackSessionStatusState>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get" | "inFlightForThread" | "activeForThreads" | "lastFinishedForThreads">,
  flags: Pick<FeatureFlagStore, "enabled">,
  now = Date.now,
  activity: SlackStatusActivity = {},
) {
  const update = store.update.bind(store);
  const deleteIf = store.deleteIf.bind(store);
  const queue = createKeyedQueue<string>();
  const key = (account: string, channel: string, threadTs: string) => JSON.stringify([account, channel, threadTs]);
  async function sync(client: StatusClient, id: string, next?: SlackSessionStatusState) {
    await queue(id, async () => {
      for (let attempt = 0; attempt < 300; attempt++) {
        const applied = await lease.hold(`slack:session-status:${id}`, async (lost) => {
          let leaseLost = false;
          void lost.then(() => {
            leaseLost = true;
          });
          const writer = randomUUID();
          const anchor = await runs.get((next ?? (await store.get(id)))?.anchorRunId ?? "");
          const scope = anchor && conversationScope(anchor.request.conversation, anchor.request.actor.id);
          const optedIn = !!scope && (await flags.enabled("slack_loading_indicator", scope));
          if (
            next &&
            (!optedIn ||
              !anchor?.deliveryState?.replying ||
              anchor.request.privateSessionMessage ||
              isTerminal(anchor.status))
          )
            return true;
          if (leaseLost) return true;
          if (next) await store.putIfAbsent(id, { ...next, writer });
          if (leaseLost) {
            await deleteIf(id, (row) => row.writer === writer && !row.cardTs);
            return true;
          }
          const current = await store.get(id);
          if (!current || leaseLost) return true;
          const active =
            optedIn && anchor
              ? (await runs.inFlightForThread(anchor.sessionId)).filter(
                  (run) => run.deliveryState?.replying && !run.request.privateSessionMessage,
                )
              : [];
          const threadRef = anchor?.request.conversation.threadRef;
          const session = anchor?.sessionId ? await activity.sessions?.getByThread(anchor.sessionId) : null;
          const children =
            optedIn && session
              ? ((await activity.sessions?.childrenOf(session.id)) ?? []).filter(
                  (child) => child.scopeId === session.scopeId,
                )
              : [];
          const descendants = children.length
            ? ((await activity.sessions?.descendantsOf(children.map((child) => child.id))) ?? [])
            : [];
          const threads = new Set([threadRef, ...[...children, ...descendants].map((s) => s.threadRef)]);
          const jobs =
            optedIn && threadRef
              ? ((await activity.processes?.liveByScope(scope!, now())) ?? []).filter(
                  (job) => job.kind === "background" && threads.has(job.sessionRef),
                )
              : [];
          const monitors =
            optedIn && threadRef
              ? ((await activity.monitors?.ownedBy(scope!)) ?? []).filter(
                  (monitor) => monitor.enabled && threads.has(monitor.threadRef) && monitor.expiresAt > now(),
                )
              : [];
          const childRuns = children.length
            ? await runs.activeForThreads([...children, ...descendants].map((s) => s.threadRef))
            : new Map<string, Run>();
          const steps =
            (await activity.sessions?.latestToolSteps([...active, ...childRuns.values()].map((run) => run.id))) ??
            new Map<string, { purpose?: string }>();
          const purposeOf = (run: Run | undefined) => (run ? steps.get(run.id.toLowerCase())?.purpose : undefined);
          const backgroundOf = (ref: string | undefined): [string, string] | undefined => {
            const monitor = monitors.find((m) => m.threadRef === ref);
            if (monitor) return [monitor.purpose ?? "Watching for updates", "Keeping watch"];
            const job = jobs.find((j) => j.sessionRef === ref);
            return job && [job.purpose ?? "Background job", "Running in the background"];
          };
          const stepOf = (ref: string) => {
            const run = childRuns.get(ref);
            return run ? (purposeOf(run) ?? "Thinking it through") : backgroundOf(ref)?.[0];
          };
          const helpers = children.flatMap((child) => {
            const lineage = [child, ...descendants.filter((d) => d.rootId === child.id)];
            const step = lineage.map((s) => stepOf(s.threadRef)).find(Boolean);
            return step ? [{ child, step }] : [];
          });
          const background = backgroundOf(threadRef);
          const startedAt = current.startedAt ?? now();
          const cardId = current.cardId ?? randomUUID();
          const elapsed = now() - startedAt;
          const ongoing = active.length > 0 || helpers.length > 0 || !!background;
          const failed =
            !ongoing &&
            !!anchor &&
            (await runs.lastFinishedForThreads([anchor.sessionId])).get(anchor.sessionId)?.status === "failed";
          const running = active.find((run) => run.status === "running" && !leaseLapsed(run, now()));
          const [title, phrase] = ((): [string, string] => {
            if (running) return [purposeOf(running) ?? "Thinking it through", "Working on it"];
            if (active.length) return [purposeOf(active[0]) ?? "Queued", "Picking back up shortly"];
            if (helpers.length) return ["Waiting on subagents", ""];
            if (background) return background;
            return [`${failed ? "Stopped after" : "Done in"} ${duration(elapsed)}`, ""];
          })();
          const followUrl =
            elapsed > 5 * 60_000 && session ? conversationWebUrl(activity.publicWebUrl, session.id) : current.followUrl;
          const icon = current.emoji ? EMOJI_CHAR_BY_NAME[current.emoji] : undefined;
          const details = richText(
            icon ? undefined : current.emoji,
            ongoing && elapsed >= 60_000 ? `${phrase} · ${duration(elapsed, false)}` : phrase,
          );
          const headline = icon ? `${icon} ${title}` : title;
          const status = (failed && "error") || (ongoing && "in_progress") || "complete";
          const rows = helpers.map(({ child, step }) => ({
            task_id: `${SLACK_STATUS_TASK_PREFIX}${cardId}:${child.id}`,
            title: child.title || "Subagent",
            status: "in_progress",
            details: richText(undefined, step),
          }));
          const blocks: Record<string, unknown>[] = [
            rows.length
              ? {
                  type: "plan",
                  title: headline,
                  tasks:
                    rows.length > PLAN_TASK_LIMIT
                      ? [
                          ...rows.slice(0, PLAN_TASK_LIMIT - 1),
                          {
                            task_id: `${SLACK_STATUS_TASK_PREFIX}${cardId}:more`,
                            title: `${rows.length - PLAN_TASK_LIMIT + 1} more subagents`,
                            status: "in_progress",
                          },
                        ]
                      : rows,
                }
              : {
                  type: "task_card",
                  task_id: `${SLACK_STATUS_TASK_PREFIX}${cardId}`,
                  title: headline,
                  status,
                  ...(details ? { details } : {}),
                },
          ];
          if (followUrl)
            blocks.push({
              type: "context",
              elements: [{ type: "mrkdwn", text: `<${followUrl}|Follow via QM Web>` }],
            });
          const content = JSON.stringify(blocks);
          const post =
            current.cardContent !== content && (!!current.cardTs || (optedIn && ongoing && elapsed >= SHOW_AFTER_MS));
          if (!next && ongoing && !post && current.startedAt && current.cardId && current.followUrl === followUrl)
            return true;
          let state = await update(id, (row) =>
            leaseLost ? row : { ...row, writer, ...(next ? { anchorRunId: next.anchorRunId } : {}) },
          );
          if (!state || leaseLost || state.writer !== writer) return true;
          const persist = async (patch: Partial<SlackSessionStatusState>) => {
            const saved = await update(id, (row) => (!leaseLost && row.writer === writer ? { ...row, ...patch } : row));
            if (!saved || leaseLost || saved.writer !== writer) return false;
            state = saved;
            return true;
          };
          if (!(await persist({ startedAt, cardId, ...(followUrl ? { followUrl } : {}) }))) return true;
          try {
            if (post) {
              const result = (await client.apiCall(state.cardTs ? "chat.update" : "chat.postMessage", {
                channel: state.channel,
                ...(state.cardTs ? { ts: state.cardTs } : { thread_ts: state.threadTs, client_msg_id: state.cardId }),
                text: headline,
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
            if (!ongoing) await deleteIf(id, (row) => !leaseLost && row.writer === writer);
          } catch (error) {
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
              await update(id, (row) => ({ ...row, cardContent: undefined }));
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
    async start(
      client: StatusClient,
      account: string,
      runId: string,
      channel: string,
      threadTs?: string,
      emoji?: Promise<string | undefined>,
    ) {
      if (!threadTs) return;
      const startedAt = now();
      const picked = await emoji?.catch(swallowAs("slack: session status emoji", undefined));
      await sync(client, key(account, channel, threadTs), {
        account,
        channel,
        threadTs,
        anchorRunId: runId,
        startedAt,
        ...(picked ? { emoji: picked } : {}),
        cardId: randomUUID(),
      }).catch(swallowAs("slack: start session status", undefined));
    },
    async reconcile(client: StatusClient, account: string) {
      for (const [id, state] of await store.entries())
        if (state.account === account)
          await sync(client, id).catch(swallowAs("slack: reconcile session status", undefined));
    },
  };
}

const SHOW_AFTER_MS = 10_000;
const PLAN_TASK_LIMIT = 50;

function duration(ms: number, seconds = true): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const [h, m, sec] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  if (h) return `${h}h ${m}m`;
  if (!seconds) return `${m}m`;
  return m ? `${m}m ${sec}s` : `${sec}s`;
}

function richText(emoji: string | undefined, text: string) {
  const elements = [
    ...(emoji ? [{ type: "emoji", name: emoji }] : []),
    ...(text ? [{ type: "text", text: emoji ? ` ${text}` : text }] : []),
  ];
  return elements.length ? { type: "rich_text", elements: [{ type: "rich_text_section", elements }] } : undefined;
}

export type SlackSessionStatus = ReturnType<typeof createSlackSessionStatus>;
