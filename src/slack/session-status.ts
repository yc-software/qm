import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import type { RunStore } from "../runs/run-store.ts";
import type { SessionWork, SessionWorkReader } from "../sessions/session-work.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { EMOJI_CHAR_BY_NAME } from "./emoji-map.ts";
import { SLACK_PERMANENT_POST_ERRORS, slackErrorCode } from "./payloads.ts";

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
  work?: Pick<SessionWorkReader, "of">;
  publicWebUrl?: string;
}

export function createSlackSessionStatus(
  store: DurableMap<SlackSessionStatusState>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get">,
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
          if (next && (!optedIn || !anchor?.deliveryState?.replying || anchor.request.privateSessionMessage))
            return true;
          if (leaseLost) return true;
          if (next) await store.putIfAbsent(id, { ...next, writer });
          if (leaseLost) {
            await deleteIf(id, (row) => row.writer === writer && !row.cardTs);
            return true;
          }
          const current = await store.get(id);
          if (!current || leaseLost) return true;
          const work = optedIn && anchor ? await activity.work?.of(anchor.sessionId, "slack") : undefined;
          if (work?.delivering) return true;
          const startedAt = current.startedAt ?? now();
          const cardId = current.cardId ?? randomUUID();
          const elapsed = now() - startedAt;
          const followUrl = work?.sessionId ? conversationWebUrl(activity.publicWebUrl, work.sessionId) : undefined;
          const { blocks, headline } = renderCard(work, { emoji: current.emoji, cardId, elapsed, followUrl });
          const ongoing = !!work?.busy;
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
            const code = slackErrorCode(error) ?? "";
            if (
              (SLACK_PERMANENT_POST_ERRORS.has(code) ||
                ["not_authorized", "no_permission", "thread_ts_not_allowed"].includes(code)) &&
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
const BACKGROUND_STEP = { watch: "Watching for updates", job: "Background job" } as const;

function headlineOf(work: SessionWork | undefined): [string, string] {
  if (work?.running) return [work.running.purpose ?? "Thinking it through", "Working on it"];
  if (work?.queued) return [work.queued.purpose ?? "Queued", "Picking back up shortly"];
  if (work?.branches.length || work?.returning) return ["Waiting on subagents", ""];
  if (work?.background?.kind === "watch") return [work.background.purpose ?? BACKGROUND_STEP.watch, "Keeping watch"];
  if (work?.background) return [work.background.purpose ?? BACKGROUND_STEP.job, "Running in the background"];
  return ["", ""];
}

function renderCard(
  work: SessionWork | undefined,
  card: { emoji?: string | undefined; cardId: string; elapsed: number; followUrl?: string | undefined },
) {
  const [title, phrase] = headlineOf(work);
  const icon = card.emoji ? EMOJI_CHAR_BY_NAME[card.emoji] : undefined;
  const headline = icon ? `${icon} ${title}` : title;
  const details = richText(
    icon ? undefined : card.emoji,
    card.elapsed >= 60_000 ? `${phrase} · ${minutes(card.elapsed)}` : phrase,
  );
  const rows = (work?.branches ?? []).map(({ id, title, step, background }) => ({
    task_id: `${SLACK_STATUS_TASK_PREFIX}${card.cardId}:${id}`,
    title,
    status: "in_progress",
    details: richText(undefined, step ?? (background ? BACKGROUND_STEP[background] : "Thinking it through")),
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
