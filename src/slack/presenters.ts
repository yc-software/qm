import { sleep } from "./util.ts";
import { slackSectionBlocks } from "./mrkdwn.ts";

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
