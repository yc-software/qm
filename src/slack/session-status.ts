import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isTerminal, leaseLapsed, type Run, type RunStore } from "../runs/run-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import type { DeliveryStore } from "../delivery/delivery-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import type { ScopeId } from "../types.ts";
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
}

interface StatusClient {
  apiCall(method: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface SlackStatusActivity {
  sessions?: Pick<SessionStore, "getByThread" | "childrenOf" | "descendantsOf" | "latestToolSteps">;
  processes?: Pick<ProcessRegistry, "liveByScope">;
  deliveries?: Pick<DeliveryStore, "pending">;
  monitors?: Pick<MonitorStore, "ownedBy">;
  publicWebUrl?: string;
}

export function createSlackSessionStatus(
  store: DurableMap<SlackSessionStatusState>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get" | "inFlightForThread" | "activeForThreads" | "pendingReturns">,
  flags: Pick<FeatureFlagStore, "enabled">,
  now = Date.now,
  activity: SlackStatusActivity = {},
) {
  const update = store.update.bind(store);
  const deleteIf = store.deleteIf.bind(store);
  const queue = createKeyedQueue<string>();
  const key = (account: string, channel: string, threadTs: string) => JSON.stringify([account, channel, threadTs]);
  async function threadWork(anchor: Run | null, scope: ScopeId | undefined): Promise<ThreadWork> {
    const active =
      scope && anchor
        ? (await runs.inFlightForThread(anchor.sessionId)).filter(
            (run) => run.deliveryState?.replying && !run.request.privateSessionMessage,
          )
        : [];
    const threadRef = anchor?.request.conversation.threadRef;
    const session = anchor?.sessionId ? await activity.sessions?.getByThread(anchor.sessionId) : null;
    const children =
      scope && session
        ? ((await activity.sessions?.childrenOf(session.id)) ?? []).filter((child) => child.scopeId === session.scopeId)
        : [];
    const descendants = children.length
      ? ((await activity.sessions?.descendantsOf(children.map((child) => child.id))) ?? [])
      : [];
    const lineageRefs = [...children, ...descendants].map((s) => s.threadRef);
    const threads = new Set([threadRef, ...lineageRefs]);
    const jobs =
      scope && threadRef
        ? ((await activity.processes?.liveByScope(scope, now())) ?? []).filter(
            (job) => job.kind === "background" && threads.has(job.sessionRef),
          )
        : [];
    const monitors =
      scope && threadRef
        ? ((await activity.monitors?.ownedBy(scope)) ?? []).filter(
            (monitor) => monitor.enabled && threads.has(monitor.threadRef) && monitor.expiresAt > now(),
          )
        : [];
    const childRuns = lineageRefs.length ? await runs.activeForThreads(lineageRefs) : new Map<string, Run>();
    const returning = lineageRefs.length > 0 && (await runs.pendingReturns(1, "", lineageRefs)).length > 0;
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
      return step ? [{ id: child.id, title: child.title || "Subagent", step }] : [];
    });
    const background = backgroundOf(threadRef);
    const running = active.find((run) => run.status === "running" && !leaseLapsed(run, now()));
    const base = { session, helpers, ongoing: true, landing: false };
    if (running) return { ...base, title: purposeOf(running) ?? "Thinking it through", phrase: "Working on it" };
    if (active.length) return { ...base, title: purposeOf(active[0]) ?? "Queued", phrase: "Picking back up shortly" };
    if (helpers.length || returning) return { ...base, title: "Waiting on subagents", phrase: "" };
    if (background) return { ...base, title: background[0], phrase: background[1] };
    const landing =
      !!anchor &&
      ((await activity.deliveries?.pending("slack")) ?? []).some(
        (delivery) => delivery.provenance?.sourceThreadRef === anchor.sessionId,
      );
    return { ...base, ongoing: false, landing, title: "", phrase: "" };
  }
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
          const work = await threadWork(anchor, optedIn ? scope : undefined);
          const startedAt = current.startedAt ?? now();
          const cardId = current.cardId ?? randomUUID();
          const elapsed = now() - startedAt;
          if (work.landing) return true;
          const followUrl = work.session ? conversationWebUrl(activity.publicWebUrl, work.session.id) : undefined;
          const { blocks, headline } = renderCard(work, { emoji: current.emoji, cardId, elapsed, followUrl });
          const { ongoing } = work;
          const content = JSON.stringify(blocks);
          const post =
            current.cardContent !== content && (!!current.cardTs || (optedIn && ongoing && elapsed >= SHOW_AFTER_MS));
          if (!next && ongoing && !post && current.startedAt && current.cardId) return true;
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
          if (!(await persist({ startedAt, cardId }))) return true;
          try {
            if (post && ongoing) {
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
            if (!ongoing) {
              if (state.cardTs) await client.apiCall("chat.delete", { channel: state.channel, ts: state.cardTs });
              await deleteIf(id, (row) => !leaseLost && row.writer === writer);
            }
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

interface ThreadWork {
  session: { id: string } | null | undefined;
  helpers: { id: string; title: string; step: string }[];
  ongoing: boolean;
  landing: boolean;
  title: string;
  phrase: string;
}

function renderCard(
  work: ThreadWork,
  card: { emoji?: string | undefined; cardId: string; elapsed: number; followUrl?: string | undefined },
) {
  const title = work.title;
  const icon = card.emoji ? EMOJI_CHAR_BY_NAME[card.emoji] : undefined;
  const headline = icon ? `${icon} ${title}` : title;
  const details = richText(
    icon ? undefined : card.emoji,
    card.elapsed >= 60_000 ? `${work.phrase} · ${minutes(card.elapsed)}` : work.phrase,
  );
  const rows = work.helpers.map(({ id, title, step }) => ({
    task_id: `${SLACK_STATUS_TASK_PREFIX}${card.cardId}:${id}`,
    title,
    status: "in_progress",
    details: richText(undefined, step),
  }));
  const tasks =
    rows.length > PLAN_TASK_LIMIT
      ? [
          ...rows.slice(0, PLAN_TASK_LIMIT - 1),
          {
            task_id: `${SLACK_STATUS_TASK_PREFIX}${card.cardId}:more`,
            title: `${rows.length - PLAN_TASK_LIMIT + 1} more subagents`,
            status: "in_progress",
          },
        ]
      : rows;
  const blocks: Record<string, unknown>[] = [
    rows.length
      ? { type: "plan", title: headline, tasks }
      : {
          type: "task_card",
          task_id: `${SLACK_STATUS_TASK_PREFIX}${card.cardId}`,
          title: headline,
          status: "in_progress",
          ...(details ? { details } : {}),
        },
  ];
  if (card.followUrl)
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `<${card.followUrl}|Follow via QM Web>` }] });
  return { blocks, headline };
}

function minutes(ms: number): string {
  const total = Math.floor(ms / 60_000);
  return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`;
}

function richText(emoji: string | undefined, text: string) {
  const elements = [
    ...(emoji ? [{ type: "emoji", name: emoji }] : []),
    ...(text ? [{ type: "text", text: emoji ? ` ${text}` : text }] : []),
  ];
  return elements.length ? { type: "rich_text", elements: [{ type: "rich_text_section", elements }] } : undefined;
}

export type SlackSessionStatus = ReturnType<typeof createSlackSessionStatus>;
