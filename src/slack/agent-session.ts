import type { DurableMap } from "../persistence/durable-map.ts";
import { swallowAs } from "../util/errors.ts";
import { scrubStepText } from "./step-labels.ts";

export interface SlackApiClient {
  apiCall(method: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface AgentSessionThreadRow {
  kind: "thread";
  account: string;
  channel: string;
  threadTs: string;
  activeRunId?: string;
  userRenamedTitle?: boolean;
  initialRenamed?: boolean;
  generatedRenamed?: boolean;
  lastSessionStatus?: "processing" | "suspended" | "active";
  lastKeepaliveAt?: number;
  updatedAt: number;
}

const MAX_SESSION_TITLE_CHARS = 80;
const THREAD_TTL_MS = 24 * 60 * 60_000;

function threadKey(account: string, channel: string, threadTs: string): string {
  return `thread:${account}:${channel}:${threadTs}`;
}

export function createSlackAgentSession(
  store: DurableMap<AgentSessionThreadRow | Record<string, unknown>>,
  now: () => number = Date.now,
) {
  const getThread = async (
    account: string,
    channel: string,
    threadTs: string,
  ): Promise<AgentSessionThreadRow | undefined> => {
    const row = await store.get(threadKey(account, channel, threadTs));
    return row && (row as { kind?: unknown }).kind === "thread" ? (row as AgentSessionThreadRow) : undefined;
  };

  const upsertThread = async (
    account: string,
    channel: string,
    threadTs: string,
    patch: Partial<AgentSessionThreadRow>,
  ): Promise<AgentSessionThreadRow> => {
    const existing = await getThread(account, channel, threadTs);
    const next: AgentSessionThreadRow = {
      kind: "thread",
      account,
      channel,
      threadTs,
      ...existing,
      ...patch,
      updatedAt: now(),
    };
    await store.put(threadKey(account, channel, threadTs), next);
    return next;
  };

  const setStatus = async (
    client: SlackApiClient,
    account: string,
    channel: string,
    threadTs: string,
    status: "processing" | "suspended" | "active",
    force = false,
  ): Promise<void> => {
    const existing = await getThread(account, channel, threadTs);
    if (!force && existing?.lastSessionStatus === status) return;
    try {
      await client.apiCall("agents.sessions.setStatus", {
        channel_id: channel,
        thread_ts: threadTs,
        status,
      });
    } catch (err) {
      {
        swallowAs("slack: agent session setStatus", undefined)(err);
      }
      return;
    }
    if (status === "active" && !existing?.userRenamedTitle) {
      await store.delete(threadKey(account, channel, threadTs));
      return;
    }
    await upsertThread(account, channel, threadTs, {
      lastSessionStatus: status,
      lastKeepaliveAt: now(),
      ...(status === "active" ? { activeRunId: undefined } : {}),
    });
  };

  const rename = async (
    client: SlackApiClient,
    account: string,
    channel: string,
    threadTs: string,
    title: string,
    source: "initial" | "generated",
  ): Promise<void> => {
    const clean = scrubStepText(title.replaceAll(":", " "), MAX_SESSION_TITLE_CHARS);
    if (!clean) return;
    const existing = await getThread(account, channel, threadTs);
    if (existing?.userRenamedTitle || existing?.generatedRenamed) return;
    if (source === "initial" && existing?.initialRenamed) return;
    try {
      await client.apiCall("agents.sessions.rename", {
        channel_id: channel,
        thread_ts: threadTs,
        title: clean,
      });
    } catch (err) {
      {
        swallowAs("slack: agent session rename", undefined)(err);
      }
      return;
    }
    await upsertThread(account, channel, threadTs, {
      initialRenamed: true,
      generatedRenamed: source === "generated" ? true : existing?.generatedRenamed,
    });
  };

  const markUserRenamed = async (account: string, channel: string, threadTs: string): Promise<void> => {
    await upsertThread(account, channel, threadTs, { userRenamedTitle: true });
  };

  const setActiveRun = async (
    account: string,
    channel: string,
    threadTs: string,
    runId: string | undefined,
  ): Promise<void> => {
    const existing = await getThread(account, channel, threadTs);
    if (!runId && existing && !existing.userRenamedTitle && existing.lastSessionStatus === "active") {
      await store.delete(threadKey(account, channel, threadTs));
      return;
    }
    await upsertThread(account, channel, threadTs, { activeRunId: runId });
  };

  const pruneStaleThreads = async (rows: readonly AgentSessionThreadRow[]): Promise<void> => {
    const cutoff = now() - THREAD_TTL_MS;
    for (const row of rows) {
      if (!row.activeRunId && row.updatedAt < cutoff) {
        await store.delete(threadKey(row.account, row.channel, row.threadTs));
      }
    }
  };

  return {
    getThread,
    setStatus,
    rename,
    markUserRenamed,
    setActiveRun,
    pruneStaleThreads,
  };
}
