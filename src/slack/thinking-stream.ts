import type { DurableMap } from "../persistence/durable-map.ts";
import type { LeaderLease } from "../persistence/leader-lease.ts";
import type { Run, RunStore } from "../runs/run-store.ts";
import type { RunActivityStore } from "../runs/run-activity-store.ts";
import type { SessionWork } from "../sessions/session-work.ts";
import { createKeyedQueue, sleep } from "../util/async.ts";
import { swallowAs } from "../util/errors.ts";
import {
  buildPlanBlock,
  buildPlanFromActivity,
  planTitleForState,
  taskToStreamChunk,
  type PlanTaskSnapshot,
  type StepDetailMode,
} from "./step-labels.ts";
import { SLACK_STATUS_TASK_PREFIX } from "./message-gating.ts";
import { toSlackMrkdwn } from "./mrkdwn.ts";
import { createSlackAgentSession, type AgentSessionThreadRow, type SlackApiClient } from "./agent-session.ts";

export type ThinkingStreamClient = SlackApiClient;

export type QueuedStreamOp =
  { kind: "react"; emoji: string } | { kind: "edit"; text: string; blocks?: unknown[] } | { kind: "delete" };

export interface SlackThinkingStreamRunRow {
  kind: "run";
  account: string;
  teamId: string;
  runId: string;
  sessionId: string;
  channel: string;
  threadTs: string;
  detailMode: StepDetailMode;
  unprompted?: boolean;
  surfacePosted?: boolean;
  recipientUserId?: string;
  recipientTeamId?: string;
  personaIdentity?: { username?: string; icon_emoji?: string; icon_url?: string };
  initialTitle?: string;
  state: "pending" | "streaming" | "updating" | "stopped";
  streamTs?: string;
  openedAt?: number;
  lastFlushedAt?: number;
  lastPlanTitle?: string;
  lastPlanTasks?: PlanTaskSnapshot[];
  lastRenderedJson?: string;
  queuedOps?: QueuedStreamOp[];
  updatedAt: number;
}

interface SlackThinkingStreamRefRow {
  kind: "ref";
  runId: string;
}

interface SlackThinkingStreamSessionRow {
  kind: "session";
  channel: string;
  threadTs: string;
}

export type SlackThinkingStreamRecord =
  SlackThinkingStreamRunRow | AgentSessionThreadRow | SlackThinkingStreamRefRow | SlackThinkingStreamSessionRow;

export interface ThinkingStreamOptions {
  now?: () => number;
  work?: { of(sessionId: string, surface: string): Promise<SessionWork> };
  getSessionTitle?: (sessionId: string) => Promise<string | undefined>;
  reportEditRef?: (runId: string, editRef: string) => void;
  hasSurfacePosted?: (runId: string) => boolean;
  rolloverMs?: number;
  minFlushIntervalMs?: number;
}

export interface RegisterTurnInput {
  account: string;
  teamId?: string;
  runId: string;
  sessionId: string;
  channel: string;
  threadTs?: string;
  detailMode: StepDetailMode;
  unprompted?: boolean;
  recipientUserId?: string;
  recipientTeamId?: string;
  personaIdentity?: { username?: string; icon_emoji?: string; icon_url?: string };
  initialTitle?: string;
}

export interface StreamDeliverInput {
  runId?: string;
  editRef?: string;
  channel: string;
  threadTs?: string;
  rawMarkdown: string;
  footerBlocks?: unknown[];
  mrkdwnFallback?: string;
  unfurlLinks?: boolean;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  finalize?: boolean;
}

export interface StreamDeliverResult {
  handled: boolean;
  messageTs?: string;
  closedStreamTs?: string;
}

const STREAM_ROLLOVER_MS = 9 * 60_000;
const STREAM_KEEPALIVE_MS = 45 * 60_000;
const MAX_STREAM_REPLY_CHARS = 11_000;
const DEFAULT_FLUSH_MS = 500;

function runKey(runId: string): string {
  return `run:${runId}`;
}

function refKey(channel: string, ts: string): string {
  return `ref:${channel}:${ts}`;
}

function sessionKey(account: string, sessionId: string): string {
  return `session:${account}:${sessionId}`;
}

function isStreamEndedError(err: unknown): boolean {
  const code = (err as { data?: { error?: string } })?.data?.error;
  return code === "message_not_in_streaming_state" || code === "stream_not_found" || code === "already_stopped";
}

function isNonStreamableRun(run: Run): boolean {
  return !!run.request.privateSessionMessage;
}

function diffTaskChunks(
  prev: readonly PlanTaskSnapshot[] | undefined,
  next: readonly PlanTaskSnapshot[],
): Record<string, unknown>[] {
  const prevById = new Map((prev ?? []).map((t) => [t.taskId, t]));
  const chunks: Record<string, unknown>[] = [];
  for (const task of next) {
    const old = prevById.get(task.taskId);
    if (
      !old ||
      old.title !== task.title ||
      old.status !== task.status ||
      old.details !== task.details ||
      old.output !== task.output ||
      JSON.stringify(old.sources ?? null) !== JSON.stringify(task.sources ?? null)
    ) {
      chunks.push(taskToStreamChunk(task));
    }
  }
  return chunks;
}

export function createSlackThinkingStream(
  store: DurableMap<SlackThinkingStreamRecord>,
  lease: LeaderLease,
  runs: Pick<RunStore, "get">,
  runActivity: Pick<RunActivityStore, "list">,
  opts: ThinkingStreamOptions = {},
) {
  const now = opts.now ?? Date.now;
  const rolloverMs = opts.rolloverMs ?? STREAM_ROLLOVER_MS;
  const minFlushMs = opts.minFlushIntervalMs ?? DEFAULT_FLUSH_MS;
  const agentSession = createSlackAgentSession(
    store as unknown as DurableMap<AgentSessionThreadRow | Record<string, unknown>>,
    now,
  );

  const runQueue = createKeyedQueue<string>();

  const getRunRow = async (runId: string): Promise<SlackThinkingStreamRunRow | undefined> => {
    const row = await store.get(runKey(runId));
    return row && row.kind === "run" ? row : undefined;
  };

  const findRunIdByEditRef = async (channel: string, ts: string): Promise<string | undefined> => {
    const ref = await store.get(refKey(channel, ts));
    return ref && ref.kind === "ref" ? ref.runId : undefined;
  };

  const putRunRow = async (row: SlackThinkingStreamRunRow, writeIndexes = false): Promise<void> => {
    await store.put(runKey(row.runId), { ...row, updatedAt: now() });
    if (writeIndexes) {
      await store.put(sessionKey(row.account, row.sessionId), {
        kind: "session",
        channel: row.channel,
        threadTs: row.threadTs,
      });
      if (row.streamTs) {
        await store.put(refKey(row.channel, row.streamTs), { kind: "ref", runId: row.runId });
      }
    }
  };

  const removeRunRow = async (row: SlackThinkingStreamRunRow): Promise<void> => {
    await store.delete(runKey(row.runId));
    await store.delete(sessionKey(row.account, row.sessionId));
    if (row.streamTs) {
      await store.delete(refKey(row.channel, row.streamTs));
    }
    const thread = await agentSession.getThread(row.account, row.channel, row.threadTs);
    if (thread?.activeRunId === row.runId) {
      await agentSession.setActiveRun(row.account, row.channel, row.threadTs, undefined);
    }
  };

  const readWork = async (sessionId: string): Promise<SessionWork | undefined> => {
    if (!opts.work) return undefined;
    try {
      return await opts.work.of(sessionId, "slack");
    } catch (err) {
      swallowAs("slack: thinking stream read work", undefined)(err);
      return undefined;
    }
  };

  const drainQueuedOps = async (
    client: ThinkingStreamClient,
    channel: string,
    ts: string,
    ops: readonly QueuedStreamOp[] | undefined,
  ): Promise<void> => {
    if (!ops || ops.length === 0) return;
    for (const op of ops) {
      try {
        if (op.kind === "react") {
          await client.apiCall("reactions.add", { channel, timestamp: ts, name: op.emoji });
        } else if (op.kind === "edit") {
          await client.apiCall("chat.update", {
            channel,
            ts,
            text: op.text,
            ...(op.blocks ? { blocks: op.blocks } : {}),
          });
        } else if (op.kind === "delete") {
          await client.apiCall("chat.delete", { channel, ts });
        }
      } catch (err) {
        swallowAs(`slack: drain queued ${op.kind}`, undefined)(err);
      }
    }
  };

  const renderFallbackPlan = async (
    client: ThinkingStreamClient,
    row: SlackThinkingStreamRunRow,
    title: string,
    tasks: readonly PlanTaskSnapshot[],
    optsRender: {
      replyText?: string;
      footerBlocks?: unknown[];
      metadata?: Record<string, unknown>;
      throwOnError?: boolean;
    } = {},
  ): Promise<string | undefined> => {
    const planBlock = buildPlanBlock(title, tasks, `${SLACK_STATUS_TASK_PREFIX}plan:${row.runId}`);
    const blocks: unknown[] = [planBlock];
    const text = optsRender.replyText ? toSlackMrkdwn(optsRender.replyText) : title;
    if (optsRender.replyText) {
      blocks.push({ type: "markdown", text: optsRender.replyText });
    }
    if (optsRender.footerBlocks?.length) blocks.push(...optsRender.footerBlocks);
    const json = JSON.stringify(blocks);
    if (row.streamTs && row.lastRenderedJson === json && !optsRender.replyText) return row.streamTs;
    try {
      const res = await client.apiCall(row.streamTs ? "chat.update" : "chat.postMessage", {
        channel: row.channel,
        ...(row.streamTs ? { ts: row.streamTs } : { thread_ts: row.threadTs }),
        text,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
        ...(optsRender.metadata ? { metadata: optsRender.metadata } : {}),
        ...(!row.streamTs && row.personaIdentity ? row.personaIdentity : {}),
      });
      const ts =
        row.streamTs ?? (typeof (res as { ts?: unknown })?.ts === "string" ? (res as { ts: string }).ts : undefined);
      if (!row.streamTs && ts) opts.reportEditRef?.(row.runId, ts);
      row.lastRenderedJson = json;
      return ts;
    } catch (err) {
      if (optsRender.throwOnError) throw err;
      swallowAs("slack: thinking stream fallback render", undefined)(err);
      return row.streamTs;
    }
  };

  const openStream = async (
    client: ThinkingStreamClient,
    row: SlackThinkingStreamRunRow,
    run: Run,
    tasks: readonly PlanTaskSnapshot[],
  ): Promise<SlackThinkingStreamRunRow> => {
    const currentStep = tasks.find((t) => t.status === "in_progress")?.title ?? tasks[tasks.length - 1]?.title;
    const title = planTitleForState("working", { currentStep });
    const chunks: Record<string, unknown>[] = [{ type: "plan_update", title }, ...tasks.map(taskToStreamChunk)];

    const fallbackToUpdating = async (): Promise<SlackThinkingStreamRunRow> => {
      const ts = await renderFallbackPlan(client, row, title, tasks);
      const next: SlackThinkingStreamRunRow = {
        ...row,
        state: "updating",
        streamTs: ts,
        openedAt: row.openedAt ?? now(),
        lastFlushedAt: now(),
        lastPlanTitle: title,
        lastPlanTasks: [...tasks],
        updatedAt: now(),
      };
      await putRunRow(next);
      return next;
    };

    let ts: string | undefined;
    try {
      const res = await client.apiCall("chat.startStream", {
        channel: row.channel,
        thread_ts: row.threadTs,
        task_display_mode: "plan",
        chunks,
        ...(row.recipientUserId ? { recipient_user_id: row.recipientUserId } : {}),
        ...(row.recipientTeamId ? { recipient_team_id: row.recipientTeamId } : {}),
        ...(row.personaIdentity ? row.personaIdentity : {}),
      });
      ts = typeof (res as { ts?: unknown })?.ts === "string" ? (res as { ts: string }).ts : undefined;
      if (!ts) throw new Error("chat.startStream missing ts");
    } catch (err) {
      swallowAs("slack: chat.startStream", undefined)(err);
      return fallbackToUpdating();
    }

    opts.reportEditRef?.(row.runId, ts);
    await agentSession.setStatus(client, row.account, row.channel, row.threadTs, "processing");
    if (row.initialTitle) {
      await agentSession.rename(client, row.account, row.channel, row.threadTs, row.initialTitle, "initial");
    }
    const generated = opts.getSessionTitle ? await opts.getSessionTitle(run.sessionId) : undefined;
    if (generated) {
      await agentSession.rename(client, row.account, row.channel, row.threadTs, generated, "generated");
    }

    const next: SlackThinkingStreamRunRow = {
      ...row,
      state: "streaming",
      streamTs: ts,
      openedAt: now(),
      lastFlushedAt: now(),
      lastPlanTitle: title,
      lastPlanTasks: [...tasks],
      updatedAt: now(),
    };
    await putRunRow(next, true);
    return next;
  };

  const rolloverStream = async (
    client: ThinkingStreamClient,
    row: SlackThinkingStreamRunRow,
    tasks: readonly PlanTaskSnapshot[],
  ): Promise<SlackThinkingStreamRunRow> => {
    const rolloverTitle = planTitleForState("rolled_over");
    const chunks: Record<string, unknown>[] = [
      { type: "plan_update", title: rolloverTitle },
      ...diffTaskChunks(row.lastPlanTasks, tasks),
    ];
    try {
      await client.apiCall("chat.stopStream", {
        channel: row.channel,
        ts: row.streamTs,
        chunks,
        session_status: "processing",
      });
    } catch (err) {
      if (!isStreamEndedError(err)) {
        swallowAs("slack: thinking stream rollover stopStream", undefined)(err);
      }
    }
    const workingTitle = planTitleForState("working", {
      currentStep: tasks.find((t) => t.status === "in_progress")?.title ?? tasks[tasks.length - 1]?.title,
    });
    const next: SlackThinkingStreamRunRow = {
      ...row,
      state: "updating",
      lastFlushedAt: now(),
      lastPlanTitle: workingTitle,
      lastPlanTasks: [...tasks],
      updatedAt: now(),
    };
    await renderFallbackPlan(client, next, workingTitle, tasks);
    await putRunRow(next, true);
    return next;
  };

  const finalizeStreamUnlocked = async (
    client: ThinkingStreamClient,
    row: SlackThinkingStreamRunRow,
    optsFinalize: {
      outcome: "done" | "stopped" | "failed";
      replyMarkdown?: string;
      footerBlocks?: unknown[];
      metadata?: Record<string, unknown>;
      deleteIfEmpty?: boolean;
      keepSessionProcessing?: boolean;
    },
  ): Promise<string | undefined> => {
    const entries = await runActivity.list(row.runId);
    const work = await readWork(row.sessionId);
    const built = buildPlanFromActivity(entries, {
      mode: row.detailMode,
      branches: work?.branches,
      replyText: optsFinalize.replyMarkdown,
      finalize: true,
    });
    const elapsedMs = row.openedAt ? now() - row.openedAt : 0;
    const title = planTitleForState(optsFinalize.outcome, { elapsedMs });

    if (row.streamTs) {
      if (optsFinalize.deleteIfEmpty && !optsFinalize.replyMarkdown) {
        if (row.state === "streaming") {
          try {
            await client.apiCall("chat.stopStream", {
              channel: row.channel,
              ts: row.streamTs,
              chunks: [{ type: "plan_update", title }],
            });
          } catch (err) {
            if (!isStreamEndedError(err)) {
              swallowAs("slack: stop empty stream", undefined)(err);
            }
          }
        }
        try {
          await client.apiCall("chat.delete", { channel: row.channel, ts: row.streamTs });
        } catch (err) {
          swallowAs("slack: delete empty stream", undefined)(err);
        }
      } else if (row.state === "streaming") {
        const chunks: Record<string, unknown>[] = [
          { type: "plan_update", title },
          ...diffTaskChunks(row.lastPlanTasks, built.tasks),
        ];
        if (optsFinalize.replyMarkdown) {
          chunks.push({ type: "markdown_text", text: optsFinalize.replyMarkdown });
        }
        try {
          await client.apiCall("chat.stopStream", {
            channel: row.channel,
            ts: row.streamTs,
            chunks,
            ...(optsFinalize.footerBlocks?.length ? { blocks: optsFinalize.footerBlocks } : {}),
            ...(optsFinalize.metadata ? { metadata: optsFinalize.metadata } : {}),
            ...(optsFinalize.keepSessionProcessing ? { session_status: "processing" } : {}),
          });
        } catch (err) {
          if (!isStreamEndedError(err)) {
            swallowAs("slack: chat.stopStream", undefined)(err);
          }
          await renderFallbackPlan(client, row, title, built.tasks, {
            replyText: optsFinalize.replyMarkdown,
            footerBlocks: optsFinalize.footerBlocks,
            metadata: optsFinalize.metadata,
            throwOnError: !!optsFinalize.replyMarkdown,
          });
        }
      } else if (row.state === "updating") {
        await renderFallbackPlan(client, row, title, built.tasks, {
          replyText: optsFinalize.replyMarkdown,
          footerBlocks: optsFinalize.footerBlocks,
          metadata: optsFinalize.metadata,
          throwOnError: !!optsFinalize.replyMarkdown,
        });
      }
      if (!optsFinalize.deleteIfEmpty || optsFinalize.replyMarkdown) {
        await drainQueuedOps(client, row.channel, row.streamTs, row.queuedOps);
      }
    }

    const closedTs = row.streamTs;
    await removeRunRow(row);
    if (!optsFinalize.keepSessionProcessing) {
      const afterWork = await readWork(row.sessionId);
      const nextStatus = afterWork?.busy ? "processing" : "active";
      await agentSession.setStatus(client, row.account, row.channel, row.threadTs, nextStatus);
    }
    return closedTs;
  };

  const syncRunUnlocked = async (
    client: ThinkingStreamClient,
    runId: string,
    optsSync: { force?: boolean } = {},
  ): Promise<void> => {
    const row = await getRunRow(runId);
    if (!row || row.state === "stopped") return;

    const dueRollover = row.state === "streaming" && !!row.openedAt && now() - row.openedAt >= rolloverMs;
    if (!optsSync.force && !dueRollover && row.lastFlushedAt && now() - row.lastFlushedAt < minFlushMs) {
      return;
    }

    const run = await runs.get(runId);
    if (!run || isNonStreamableRun(run)) {
      if (row.streamTs) {
        await finalizeStreamUnlocked(client, row, { outcome: "done", deleteIfEmpty: true });
      } else {
        await removeRunRow(row);
      }
      return;
    }

    const posted = row.surfacePosted || (opts.hasSurfacePosted?.(runId) ?? false);
    if (row.unprompted && !posted) return;
    if (posted && !row.surfacePosted) row.surfacePosted = true;

    const entries = await runActivity.list(runId);
    const work = await readWork(run.sessionId);
    const built = buildPlanFromActivity(entries, { mode: row.detailMode, branches: work?.branches });
    if (!built.hasVisibleActivity) return;

    if (row.state === "pending") {
      await openStream(client, row, run, built.tasks);
      return;
    }

    if (dueRollover) {
      await rolloverStream(client, row, built.tasks);
      return;
    }

    const currentStep =
      built.tasks.find((t) => t.status === "in_progress")?.title ?? built.tasks[built.tasks.length - 1]?.title;
    const title = planTitleForState("working", { currentStep });
    const titleChanged = title !== row.lastPlanTitle;
    const taskDiff = diffTaskChunks(row.lastPlanTasks, built.tasks);
    const tasksChanged = taskDiff.length > 0;
    if (!titleChanged && !tasksChanged) return;

    if (row.state === "streaming" && row.streamTs) {
      const chunks: Record<string, unknown>[] = [];
      if (titleChanged) chunks.push({ type: "plan_update", title });
      chunks.push(...taskDiff);
      if (chunks.length === 0) return;

      try {
        await client.apiCall("chat.appendStream", {
          channel: row.channel,
          ts: row.streamTs,
          chunks,
        });
        await putRunRow({
          ...row,
          lastFlushedAt: now(),
          lastPlanTitle: title,
          lastPlanTasks: built.tasks,
          updatedAt: now(),
        });
      } catch (err) {
        if (isStreamEndedError(err)) {
          const next: SlackThinkingStreamRunRow = {
            ...row,
            state: "updating",
            lastFlushedAt: now(),
            lastPlanTitle: title,
            lastPlanTasks: built.tasks,
            updatedAt: now(),
          };
          await renderFallbackPlan(client, next, title, built.tasks);
          await putRunRow(next);
          return;
        }
        swallowAs("slack: chat.appendStream", undefined)(err);
      }
      return;
    }

    if (row.state === "updating") {
      const next: SlackThinkingStreamRunRow = {
        ...row,
        lastFlushedAt: now(),
        lastPlanTitle: title,
        lastPlanTasks: built.tasks,
        updatedAt: now(),
      };
      await renderFallbackPlan(client, next, title, built.tasks);
      await putRunRow(next);
    }
  };

  const withRunLock = async <T>(runId: string, fn: () => Promise<T>): Promise<T | undefined> =>
    runQueue(runId, async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        let ran = false;
        let result: T | undefined;
        await lease.hold(`slack-thinking-stream:${runId}`, async () => {
          ran = true;
          result = await fn();
        });
        if (ran) return result;
        await sleep(50);
      }
      swallowAs("slack: thinking stream lock timeout", undefined)(new Error(`lock timeout for ${runId}`));
      return undefined;
    });

  return {
    async registerTurn(input: RegisterTurnInput): Promise<boolean> {
      const run = await runs.get(input.runId);
      if (!input.threadTs || !run || isNonStreamableRun(run)) return false;
      const threadTs = input.threadTs;
      const row: SlackThinkingStreamRunRow = {
        kind: "run",
        account: input.account,
        teamId: input.teamId ?? input.account.split(":")[0] ?? "default",
        runId: input.runId,
        sessionId: run.sessionId,
        channel: input.channel,
        threadTs,
        detailMode: input.detailMode,
        unprompted: input.unprompted,
        surfacePosted: !input.unprompted,
        recipientUserId: input.recipientUserId,
        recipientTeamId: input.recipientTeamId,
        personaIdentity: input.personaIdentity,
        initialTitle: input.initialTitle,
        state: "pending",
        updatedAt: now(),
      };
      await putRunRow(row, true);
      await agentSession.setActiveRun(input.account, input.channel, input.threadTs, input.runId);
      return true;
    },

    async hasOpenStream(runId: string): Promise<boolean> {
      const row = await getRunRow(runId);
      return !!row && !!row.streamTs && (row.state === "streaming" || row.state === "updating");
    },

    async onActivity(client: ThinkingStreamClient, runId: string): Promise<void> {
      await withRunLock(runId, async () => {
        await syncRunUnlocked(client, runId);
      });
    },

    async deliver(client: ThinkingStreamClient, input: StreamDeliverInput): Promise<StreamDeliverResult> {
      const resolvedRunId =
        input.runId ?? (input.editRef ? await findRunIdByEditRef(input.channel, input.editRef) : undefined);
      if (!resolvedRunId) return { handled: false };

      const result = await withRunLock(resolvedRunId, async (): Promise<StreamDeliverResult> => {
        const row = await getRunRow(resolvedRunId);
        if (!row || row.state === "stopped") return { handled: false };
        if (row.state === "pending" || !row.streamTs) {
          if (input.finalize !== false) await removeRunRow(row);
          return { handled: false };
        }

        const cannotStreamBody = input.rawMarkdown.length > MAX_STREAM_REPLY_CHARS;
        if (cannotStreamBody || input.finalize === false) {
          const closedStreamTs = await finalizeStreamUnlocked(client, row, {
            outcome: "done",
            keepSessionProcessing: input.finalize === false,
          });
          return { handled: false, closedStreamTs };
        }

        try {
          const messageTs = await finalizeStreamUnlocked(client, row, {
            outcome: "done",
            replyMarkdown: input.rawMarkdown,
            footerBlocks: input.footerBlocks,
            metadata: input.metadata,
          });
          return { handled: true, messageTs };
        } catch (err) {
          swallowAs("slack: thinking stream final delivery", undefined)(err);
          return { handled: false };
        }
      });
      return result ?? { handled: false };
    },

    async finishRun(
      client: ThinkingStreamClient,
      runId: string,
      optsFinish: { outcome: "completed" | "silent" | "done" | "stopped" | "failed"; note?: string },
    ): Promise<boolean> {
      const handled = await withRunLock(runId, async (): Promise<boolean> => {
        const row = await getRunRow(runId);
        if (!row) return false;
        if (!row.streamTs) {
          await removeRunRow(row);
          return false;
        }
        const mappedOutcome =
          optsFinish.outcome === "stopped" || optsFinish.outcome === "failed" ? optsFinish.outcome : "done";
        await finalizeStreamUnlocked(client, row, {
          outcome: mappedOutcome,
          replyMarkdown: optsFinish.note,
          deleteIfEmpty: !optsFinish.note,
        });
        return !!optsFinish.note;
      });
      return handled ?? false;
    },

    async queueIfStreaming(channel: string, ts: string, op: QueuedStreamOp): Promise<boolean> {
      const runId = await findRunIdByEditRef(channel, ts);
      if (!runId) return false;
      const queued = await withRunLock(runId, async (): Promise<boolean> => {
        const row = await getRunRow(runId);
        if (!row || row.state !== "streaming" || row.streamTs !== ts) return false;
        await putRunRow({ ...row, queuedOps: [...(row.queuedOps ?? []), op] });
        return true;
      });
      return queued ?? false;
    },

    async handleSessionStopped(
      client: ThinkingStreamClient,
      account: string,
      channel: string,
      threadTs: string,
    ): Promise<void> {
      const thread = await agentSession.getThread(account, channel, threadTs);
      if (thread?.activeRunId) {
        await withRunLock(thread.activeRunId, async () => {
          const row = await getRunRow(thread.activeRunId!);
          if (!row) return;
          if (!row.streamTs) {
            await removeRunRow(row);
            return;
          }
          await finalizeStreamUnlocked(client, row, { outcome: "stopped" });
        });
      }
      await agentSession.setStatus(client, account, channel, threadTs, "active");
    },

    async handleSessionTitleChanged(account: string, channel: string, threadTs: string): Promise<void> {
      await agentSession.markUserRenamed(account, channel, threadTs);
    },

    async onSessionState(
      client: ThinkingStreamClient,
      account: string,
      _teamId: string,
      event: {
        sessionId?: string;
        threadRef?: string;
        state?: string;
        title?: string;
        channel?: string;
        threadTs?: string;
      },
    ): Promise<void> {
      let channel = event.channel;
      let threadTs = event.threadTs;
      if ((!channel || !threadTs) && event.sessionId) {
        const mapped = await store.get(sessionKey(account, event.sessionId));
        if (mapped && mapped.kind === "session") {
          channel = mapped.channel;
          threadTs = mapped.threadTs;
        }
      }
      if (!channel || !threadTs) return;
      if (event.state === "awaiting_approval" || event.state === "working" || event.state === "idle") {
        const statusMap = { awaiting_approval: "suspended", working: "processing", idle: "active" } as const;
        await agentSession.setStatus(client, account, channel, threadTs, statusMap[event.state]);
      }
      const nextTitle =
        event.title ??
        (event.state === "metadata" && event.sessionId ? await opts.getSessionTitle?.(event.sessionId) : undefined);
      if (nextTitle) {
        await agentSession.rename(client, account, channel, threadTs, nextTitle, "generated");
      }
    },

    async reconcile(client: ThinkingStreamClient, account: string): Promise<void> {
      const rows = await store.all();
      const threads: AgentSessionThreadRow[] = [];
      for (const row of rows) {
        if (row.kind === "run" && row.account === account) {
          await withRunLock(row.runId, async () => {
            await syncRunUnlocked(client, row.runId);
          });
        } else if (row.kind === "thread" && row.account === account) {
          threads.push(row);
          if (
            row.lastSessionStatus === "processing" &&
            row.lastKeepaliveAt &&
            now() - row.lastKeepaliveAt >= STREAM_KEEPALIVE_MS
          ) {
            await agentSession.setStatus(client, account, row.channel, row.threadTs, "processing", true);
          }
        }
      }
      await agentSession.pruneStaleThreads(threads);
    },
  };
}

export type SlackThinkingStream = ReturnType<typeof createSlackThinkingStream>;
