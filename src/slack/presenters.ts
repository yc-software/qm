import { sleep } from "./util.ts";
import { slackSectionBlocks } from "./mrkdwn.ts";
import { botIdentityArgs } from "./delivery.ts";

export const DEFAULT_ACK_REACTIONS = ["eyes", "mag", "hourglass_flowing_sand", "telescope", "saluting_face"] as const;

export const CURATED_ACK_EMOJI = [
  "bug",
  "hammer_and_wrench",
  "wrench",
  "gear",
  "rocket",
  "package",
  "robot_face",
  "test_tube",
  "computer",
  "floppy_disk",
  "bar_chart",
  "chart_with_upwards_trend",
  "chart_with_downwards_trend",
  "lock",
  "key",
  "shield",
  "closed_lock_with_key",
  "memo",
  "pencil2",
  "page_facing_up",
  "clipboard",
  "books",
  "scroll",
  "bookmark_tabs",
  "email",
  "calendar",
  "speech_balloon",
  "telephone_receiver",
  "bell",
  "brain",
  "thinking_face",
  "bulb",
  "microscope",
  "sleuth_or_spy",
  "moneybag",
  "dollar",
  "credit_card",
  "airplane",
  "world_map",
  "globe_with_meridians",
  "compass",
  "car",
  "crab",
  "pirate_flag",
  "sparkles",
  "fire",
  "zap",
  "sunglasses",
  "wave",
  "art",
  "coffee",
] as const;

export function stripAckPrefix(text: string, ack: string | undefined): string {
  if (!ack) return text;
  const lead = text.trimStart();
  return lead.startsWith(ack) ? lead.slice(ack.length).trimStart() : text;
}

export interface AckPresenter {
  onFirstBlock(text: string): void;
  onSurfacePosted(): void;
  postedAck(): string | undefined;
  drain(): Promise<void>;
  settle(): Promise<void>;
}

export function createAckPresenter(deps: {
  postAck(text: string): Promise<void>;
  addReaction(emoji: string): Promise<void>;
  removeReaction(emoji: string): Promise<void>;
  emojiCandidates?: readonly string[];
  emojiPick?: Promise<string | undefined>;
  reactionDelayMs?: number;
  random?(): number;
}): AckPresenter {
  const candidates = deps.emojiCandidates?.length ? deps.emojiCandidates : DEFAULT_ACK_REACTIONS;
  const random = deps.random ?? Math.random;
  const randomEmoji = (): string =>
    candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
  let pickResult: string | undefined;
  void deps.emojiPick?.then((v) => (pickResult = v)).catch(() => undefined);
  let emoji = "";
  let reactionApplied = false;
  let reactionCancelled = false;
  let settled = false;
  let ackPosted: string | undefined;
  let sawFirstBlock = false;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op).catch(() => {});
  };
  const timer = setTimeout(() => {
    if (settled || ackPosted || reactionCancelled) return;
    emoji = pickResult || randomEmoji();
    reactionApplied = true;
    enqueue(() => deps.addReaction(emoji));
  }, deps.reactionDelayMs ?? 2_000);
  timer.unref?.();
  const clearReaction = (): void => {
    clearTimeout(timer);
    reactionCancelled = true;
    if (!reactionApplied) return;
    reactionApplied = false;
    enqueue(() => deps.removeReaction(emoji));
  };
  return {
    onFirstBlock(text) {
      if (sawFirstBlock || settled) return;
      sawFirstBlock = true;
      const ack = text.trim();
      if (!ack) return;
      clearReaction();
      enqueue(async () => {
        await deps.postAck(ack);
        ackPosted = ack;
      });
    },
    onSurfacePosted() {
      clearReaction();
    },
    postedAck: () => ackPosted,
    async drain() {
      await chain;
    },
    async settle() {
      settled = true;
      clearReaction();
      await chain;
    },
  };
}

type RunTaskStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

export interface RunTaskView {
  id: string;
  title: string;
  status: RunTaskStatus;
}

type NativeAgentSessionStatus = "active" | "processing" | "suspended" | "closed";

export interface NativeAgentPresenter {
  begin(): Promise<boolean>;
  onDelta(delta: string): void;
  onTasks(tasks: RunTaskView[]): Promise<void>;
  finish(text: string, status?: Exclude<NativeAgentSessionStatus, "processing">): Promise<string | undefined>;
  activate(): Promise<void>;
  suspend(): Promise<void>;
}

export function setNativeAgentSessionStatus(client: any, args: Record<string, unknown>): Promise<unknown> {
  if (typeof client?.agents?.sessions?.setStatus === "function") {
    return client.agents.sessions.setStatus(args);
  }
  if (typeof client?.apiCall === "function") return client.apiCall("agents.sessions.setStatus", args);
  return Promise.reject(new Error("Slack client does not support agent session status"));
}

function supportsNativeAgentPresentation(client: any): boolean {
  return Boolean(
    (client?.agents?.sessions?.setStatus || client?.apiCall) &&
    client?.chat?.startStream &&
    client?.chat?.appendStream &&
    client?.chat?.stopStream,
  );
}

function nativeTaskStatus(status: RunTaskView["status"]): "in_progress" | "complete" | "error" {
  if (status === "failed") return "error";
  if (status === "completed" || status === "skipped") return "complete";
  return "in_progress";
}

function nativeTaskChunk(task: RunTaskView): Record<string, unknown> {
  const oneLine = task.title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    type: "task_update",
    id: task.id.slice(0, 255),
    title: (oneLine || "Working").slice(0, 256),
    status: nativeTaskStatus(task.status),
  };
}

function nativeMarkdownChunks(text: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(offset + 12_000, text.length);
    if (end < text.length) {
      const before = text.charCodeAt(end - 1);
      const after = text.charCodeAt(end);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
    }
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function createNativeAgentPresenter(deps: {
  client: any;
  channel: string;
  threadTs: string;
  initiatorUserId: string;
  recipientTeamId?: string;
  title: string;
  sanitize(text: string): string;
  checkpoint(ts: string): Promise<void>;
  onSurfacePosted(): void;
  isCancelled?(): boolean;
  onError?(error: unknown): void;
}): NativeAgentPresenter {
  const { client } = deps;
  let streamTs: string | undefined;
  let rawText = "";
  let emittedText = "";
  let tasks: RunTaskView[] = [];
  let taskSnapshot = "";
  let failure: unknown;
  let chain = Promise.resolve();
  let finished = false;
  const isCancelled = (): boolean => deps.isCancelled?.() === true;

  const statusArgs = (status: NativeAgentSessionStatus): Record<string, unknown> => ({
    channel_id: deps.channel,
    thread_ts: deps.threadTs,
    status,
    ...botIdentityArgs(),
  });
  const startArgs = (): Record<string, unknown> => ({
    channel: deps.channel,
    thread_ts: deps.threadTs,
    ...(!deps.channel.startsWith("D")
      ? {
          recipient_user_id: deps.initiatorUserId,
          ...(deps.recipientTeamId ? { recipient_team_id: deps.recipientTeamId } : {}),
        }
      : {}),
    task_display_mode: "plan",
    ...botIdentityArgs(),
  });
  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(async () => {
      if (failure || finished || isCancelled()) return;
      try {
        await op();
      } catch (error) {
        failure = error;
        deps.onError?.(error);
      }
    });
  };
  const drain = async (): Promise<void> => {
    await chain;
    if (failure) throw failure;
  };
  const discardCancelledStream = async (): Promise<void> => {
    if (!streamTs || !isCancelled()) return;
    const ts = streamTs;
    streamTs = undefined;
    await client.chat.stopStream({ channel: deps.channel, ts, session_status: "active" }).catch(() => undefined);
    await client.chat.delete?.({ channel: deps.channel, ts }).catch(() => undefined);
  };
  const start = async (chunks: Array<Record<string, unknown>>): Promise<void> => {
    if (isCancelled()) return;
    const response = (await client.chat.startStream({ ...startArgs(), chunks })) as {
      ts?: unknown;
      message?: { ts?: unknown };
    };
    const ts = response?.ts ?? response?.message?.ts;
    if (!ts) throw new Error("Slack started a stream without returning its message timestamp");
    streamTs = String(ts);
    if (isCancelled()) {
      await discardCancelledStream();
      return;
    }
    try {
      await deps.checkpoint(streamTs);
    } catch (error) {
      await client.chat
        .stopStream({ channel: deps.channel, ts: streamTs, session_status: "active" })
        .catch(() => undefined);
      await client.chat.delete?.({ channel: deps.channel, ts: streamTs }).catch(() => undefined);
      streamTs = undefined;
      throw error;
    }
    deps.onSurfacePosted();
  };
  const append = async (chunks: Array<Record<string, unknown>>): Promise<void> => {
    if (!chunks.length || isCancelled()) return;
    if (!streamTs) await start(chunks);
    else {
      await client.chat.appendStream({ channel: deps.channel, ts: streamTs, chunks });
      await discardCancelledStream();
    }
  };
  const appendMarkdown = async (text: string): Promise<void> => {
    for (const chunk of nativeMarkdownChunks(text)) await append([{ type: "markdown_text", text: chunk }]);
  };
  const safeStreamingText = (): string => {
    const open = rawText.lastIndexOf("[[");
    const close = rawText.lastIndexOf("]]");
    const source = open > close ? rawText.slice(0, open) : rawText;
    const clean = deps.sanitize(source);
    return clean.slice(0, Math.max(0, clean.length - 64));
  };
  const flushText = (force = false): void => {
    const next = force ? deps.sanitize(rawText) : safeStreamingText();
    if (!next.startsWith(emittedText)) return;
    const delta = next.slice(emittedText.length);
    if (!delta || (!force && delta.length < 256)) return;
    emittedText = next;
    enqueue(() => appendMarkdown(delta));
  };
  const setStatus = (status: NativeAgentSessionStatus): Promise<unknown> =>
    setNativeAgentSessionStatus(client, statusArgs(status));

  return {
    async begin() {
      if (!supportsNativeAgentPresentation(client)) return false;
      try {
        await setNativeAgentSessionStatus(client, {
          ...statusArgs("processing"),
          initiator_user_id: deps.initiatorUserId,
          title: deps.title.replace(/\s+/g, " ").trim().slice(0, 200) || "New request",
        });
        return true;
      } catch (error) {
        deps.onError?.(error);
        return false;
      }
    },
    onDelta(delta) {
      if (!delta || finished) return;
      rawText += delta;
      flushText();
    },
    async onTasks(nextTasks) {
      tasks = nextTasks.map((task) => ({ ...task }));
      const next = JSON.stringify(tasks);
      if (!tasks.length || next === taskSnapshot) return;
      taskSnapshot = next;
      enqueue(() => append(tasks.slice(0, 20).map(nativeTaskChunk)));
      await chain;
    },
    async finish(text, status = "active") {
      if (finished) return streamTs;
      const finalText = text.trim();
      try {
        if (isCancelled()) {
          finished = true;
          return streamTs;
        }
        flushText(true);
        await drain();
        if (isCancelled()) {
          finished = true;
          return streamTs;
        }
        if (!streamTs && finalText) {
          emittedText = finalText;
          await appendMarkdown(finalText);
          if (isCancelled()) {
            finished = true;
            return streamTs;
          }
        }
        if (!streamTs) {
          await setStatus(status);
          finished = true;
          return undefined;
        }
        if (finalText.startsWith(emittedText)) {
          const suffix = finalText.slice(emittedText.length);
          if (suffix) await appendMarkdown(suffix);
          if (isCancelled()) {
            await discardCancelledStream();
            finished = true;
            return streamTs;
          }
          await client.chat.stopStream({
            channel: deps.channel,
            ts: streamTs,
            session_status: status,
          });
        } else {
          await client.chat.stopStream({ channel: deps.channel, ts: streamTs, session_status: status });
          if (finalText && client.chat.update) {
            await client.chat.update({ channel: deps.channel, ts: streamTs, text: finalText, ...botIdentityArgs() });
          }
        }
        if (isCancelled()) await discardCancelledStream();
        finished = true;
        return streamTs;
      } catch (error) {
        if (streamTs) {
          await client.chat
            .stopStream({ channel: deps.channel, ts: streamTs, session_status: status })
            .catch(() => undefined);
          await client.chat.delete?.({ channel: deps.channel, ts: streamTs }).catch(() => undefined);
          streamTs = undefined;
        }
        await setStatus(status).catch(() => undefined);
        throw error;
      }
    },
    async activate() {
      await this.finish("", "active");
    },
    async suspend() {
      await this.finish("", "suspended");
    },
  };
}

export function renderTaskList(tasks: RunTaskView[]): string {
  const title = (value: string) => {
    const oneLine = value
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const bounded = oneLine.length > 120 ? `${oneLine.slice(0, 119)}…` : oneLine;
    return bounded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  };
  const noun = tasks.length === 1 ? "task" : "tasks";
  const shown = tasks.slice(0, 20);
  const rows = shown.map((task) => {
    const label = title(task.title);
    if (task.status === "completed") return `✓ ~${label}~`;
    if (task.status === "skipped") return `– ~${label}~`;
    if (task.status === "failed") return `✕ ~${label}~`;
    return `${task.status === "in_progress" ? "◐" : "○"} ${label}`;
  });
  if (shown.length < tasks.length) rows.push(`… ${tasks.length - shown.length} more`);
  return `*${tasks.length} ${noun}*\n${rows.join("\n")}`;
}

export interface TaskListPresenter {
  attach(ts: string, leadText: string): Promise<void>;
  addLead(leadText: string): Promise<boolean>;
  onTasks(tasks: RunTaskView[]): Promise<void>;
  finalize(text: string): Promise<boolean>;
  settle(): Promise<void>;
}

export function createTaskListPresenter(deps: {
  post(text: string, blocks: Array<Record<string, unknown>>): Promise<string | undefined>;
  update(ts: string, text: string, blocks: Array<Record<string, unknown>>): Promise<void>;
  checkpoint(ts: string): Promise<void>;
  remove(ts: string): Promise<void>;
  onSurfacePosted(): void;
  sleep?(ms: number): Promise<void>;
  onError?(error: unknown): void;
}): TaskListPresenter {
  let messageTs: string | undefined;
  let leadText = "";
  let tasks: RunTaskView[] = [];
  let chain = Promise.resolve();
  const sleepFor = deps.sleep ?? sleep;
  const taskBlocks = (taskText: string): Array<Record<string, unknown>> => [
    ...(leadText ? [{ type: "section", text: { type: "mrkdwn", text: leadText } }] : []),
    { type: "section", text: { type: "mrkdwn", text: taskText } },
  ];
  const updateWithRetry = async (
    ts: string,
    text: string,
    blocks: Array<Record<string, unknown>>,
  ): Promise<boolean> => {
    for (const delay of [0, 250, 750]) {
      if (delay) await sleepFor(delay);
      try {
        await deps.update(ts, text, blocks);
        return true;
      } catch (error) {
        if (delay === 750) deps.onError?.(error);
      }
    }
    return false;
  };
  const render = async (): Promise<boolean> => {
    if (!tasks.length) return false;
    const taskText = renderTaskList(tasks);
    const fallback = leadText ? `${leadText}\n\n${taskText}` : taskText;
    if (messageTs) {
      return updateWithRetry(messageTs, fallback, taskBlocks(taskText));
    }
    try {
      const ts = await deps.post(fallback, taskBlocks(taskText));
      if (!ts) return false;
      try {
        await deps.checkpoint(ts);
      } catch (error) {
        await deps.remove(ts).catch(() => {});
        throw error;
      }
      messageTs = ts;
      deps.onSurfacePosted();
      return true;
    } catch (error) {
      deps.onError?.(error);
      return false;
    }
  };
  return {
    async attach(ts, text) {
      try {
        await deps.checkpoint(ts);
      } catch (error) {
        await deps.remove(ts).catch(() => {});
        throw error;
      }
      messageTs = ts;
      leadText = text;
    },
    async addLead(text) {
      await chain;
      if (!messageTs) return false;
      leadText = text;
      const updated = await render();
      if (updated) return true;
      const staleTs = messageTs;
      messageTs = undefined;
      await deps.remove(staleTs).catch(() => {});
      return false;
    },
    async onTasks(nextTasks) {
      tasks = nextTasks.map((task) => ({ ...task }));
      chain = chain.then(async () => {
        await render();
      });
      await chain;
    },
    async finalize(text) {
      await chain;
      if (!messageTs || !tasks.length) return false;
      const taskText = renderTaskList(tasks);
      const finalBlocks = [...slackSectionBlocks(text), { type: "section", text: { type: "mrkdwn", text: taskText } }];
      return updateWithRetry(messageTs, text || taskText, finalBlocks);
    },
    async settle() {
      await chain;
    },
  };
}
