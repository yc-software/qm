import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, typedTable, type TableSpec } from "../persistence/typed-table.ts";
import { holdUntilDone, type LeaderLease } from "../persistence/leader-lease.ts";
import type { FeatureFlagStore } from "../feature-flags.ts";
import { isTerminal, type RunStore } from "../runs/run-store.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import type { MonitorStore } from "../monitors/monitor-store.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { conversationWebUrl } from "../util/conversation-links.ts";
import { createKeyedQueue } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import { slackErrorCode } from "./payloads.ts";
import { EXIT_ONLY_PATTERN } from "../monitors/monitor-broker.ts";

const CARD_GONE_ERRORS = new Set([
  "channel_not_found",
  "not_authorized",
  "no_permission",
  "thread_ts_not_allowed",
  "message_not_found",
]);

export interface SlackSessionStatusState {
  writer?: string;
  account: string;
  channel: string;
  threadTs: string;
  anchorRunId: string;
  startedAt?: number;
  cardId?: string;
  cardTs?: string;
  cardContent?: string;
  followUrl?: string;
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

const SESSION_STATUS: TableSpec = {
  table: "slack_session_status",
  key: "id",
  columns: cols(`writer text, account text!, channel text!, threadTs text!, anchorRunId text!, startedAt bigint,
    cardId text, cardTs text, cardContent text, followUrl text`),
};

export const SESSION_STATUS_MIGRATION = mapToTableMigration("slack/session-status/0001-typed", SESSION_STATUS);

export function createSessionStatusStore(databaseUrl: string) {
  const pg = createPgPool(databaseUrl, [SESSION_STATUS_MIGRATION]);
  const { get, insert, modify } = typedTable<SlackSessionStatusState>(pg, SESSION_STATUS);
  return {
    get,
    putIfAbsent: insert,
    update: (id: string, fn: (row: SlackSessionStatusState) => SlackSessionStatusState) =>
      modify(id, (row) => row && fn(row)),
    async deleteIf(id: string, predicate: (row: SlackSessionStatusState) => boolean): Promise<void> {
      await modify(id, (row) => (row && predicate(row) ? null : row));
    },
    async forAccount(account: string): Promise<string[]> {
      const rows = await pg.q(`SELECT id FROM slack_session_status WHERE account = $1 ORDER BY id`, [account]);
      return rows.map((r) => String(r.id));
    },
  };
}

export type SessionStatusStore = ReturnType<typeof createSessionStatusStore>;

export function createSlackSessionStatus(
  store: SessionStatusStore,
  lease: LeaderLease,
  runs: Pick<RunStore, "get" | "inFlightForThread">,
  flags: Pick<FeatureFlagStore, "enabled">,
  now = Date.now,
  activity: SlackStatusActivity = {},
) {
  const { update, deleteIf } = store;
  const queue = createKeyedQueue<string>();
  const key = (account: string, channel: string, threadTs: string) => JSON.stringify([account, channel, threadTs]);
  async function sync(client: StatusClient, id: string, next?: SlackSessionStatusState) {
    await queue(id, () =>
      holdUntilDone(lease, `slack:session-status:${id}`, "Slack session status lock timed out", async (lost) => {
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
        if (lost()) return true;
        if (next) await store.putIfAbsent(id, { ...next, writer });
        if (lost()) {
          await deleteIf(id, (row) => row.writer === writer && !row.cardTs);
          return true;
        }
        let state = await update(id, (row) =>
          lost() ? row : { ...row, writer, ...(next ? { anchorRunId: next.anchorRunId } : {}) },
        );
        if (!state || lost() || state.writer !== writer) return true;
        const persist = async (patch: Partial<SlackSessionStatusState>) => {
          const saved = await update(id, (row) => (!lost() && row.writer === writer ? { ...row, ...patch } : row));
          if (!saved || lost() || saved.writer !== writer) return false;
          state = saved;
          return true;
        };
        const active =
          optedIn && anchor
            ? (await runs.inFlightForThread(anchor.sessionId)).filter(
                (run) => run.deliveryState?.replying && !run.request.privateSessionMessage,
              )
            : [];
        const processing = active.some((run) => run.status === "running");
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
                  monitor.ownerScopeId === scope &&
                  monitor.threadRef === threadRef &&
                  monitor.expiresAt > now() &&
                  monitor.pattern !== EXIT_ONLY_PATTERN,
              )
            : [];
        const ongoing = active.length > 0 || jobs.length > 0 || monitors.length > 0;
        let title = "No active work";
        if (processing) title = "Working";
        else if (active.length) title = "Waiting to resume";
        else if (monitors.length) title = "Monitoring";
        else if (jobs.length) title = "Background work";
        state = {
          ...state,
          startedAt: state.startedAt ?? now(),
          cardId: state.cardId ?? randomUUID(),
        };
        if (now() - state.startedAt! > 5 * 60_000 && anchor?.sessionId) {
          const session = await activity.sessions?.getByThread(anchor.sessionId);
          if (session) state.followUrl = conversationWebUrl(activity.publicWebUrl, session.id);
        }
        if (lost()) return true;
        if (!(await persist(state))) return true;
        const blocks: Record<string, unknown>[] = [
          {
            type: "task_card",
            task_id: `${SLACK_STATUS_TASK_PREFIX}${state.cardId}`,
            title,
            status: ongoing ? "in_progress" : "complete",
          },
        ];
        if (state.followUrl)
          blocks.push({
            type: "context",
            elements: [{ type: "mrkdwn", text: `<${state.followUrl}|Follow via QM Web>` }],
          });
        const content = JSON.stringify(blocks);
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
            if (lost()) {
              await update(id, (row) => (row.cardId === state!.cardId && !row.cardTs ? { ...row, cardTs } : row));
              state = { ...state, cardTs };
              return true;
            }
            if (!(await persist({ cardTs, cardContent: content }))) return true;
          }
          if (!ongoing) await deleteIf(id, (row) => !lost() && row.writer === writer);
        } catch (error) {
          if (CARD_GONE_ERRORS.has(slackErrorCode(error) ?? "") && !lost())
            await deleteIf(id, (row) => !lost() && row.writer === writer);
          throw error;
        } finally {
          if (lost()) {
            await store.putIfAbsent(id, state);
            await update(id, (row) => ({ ...row, cardContent: undefined }));
          }
        }
        return true;
      }),
    );
  }
  return {
    async start(client: StatusClient, account: string, runId: string, channel: string, threadTs?: string) {
      if (!threadTs) return;
      await sync(client, key(account, channel, threadTs), {
        account,
        channel,
        threadTs,
        anchorRunId: runId,
        startedAt: now(),
        cardId: randomUUID(),
      }).catch(swallowAs("slack: start session status", undefined));
    },
    async reconcile(client: StatusClient, account: string) {
      for (const id of await store.forAccount(account)) {
        await sync(client, id).catch(swallowAs("slack: reconcile session status", undefined));
      }
    },
  };
}

export type SlackSessionStatus = ReturnType<typeof createSlackSessionStatus>;
