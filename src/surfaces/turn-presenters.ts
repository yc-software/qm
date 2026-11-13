import { swallow } from "../util/errors.ts";

export interface AckPresenter {
  onFirstBlock(text: string): void;
  onSurfacePosted(): void;
  postedAck(): string | undefined;
  emoji(): Promise<string>;
  drain(): Promise<void>;
  settle(): Promise<void>;
}

export function createAckPresenter(deps: {
  postAck(text: string): Promise<void>;
  addReaction(emoji: string): Promise<void>;
  removeReaction(emoji: string): Promise<void>;
  emojiCandidates: readonly string[];
  emojiPick?: Promise<string | undefined>;
  reactionDelayMs?: number;
  taskManaged?: boolean;
  random?(): number;
}): AckPresenter {
  const candidates = deps.emojiCandidates;
  const random = deps.random ?? Math.random;
  const randomEmoji = (): string =>
    candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))]!;
  let pickResult: string | undefined;
  void deps.emojiPick?.then((v) => (pickResult = v)).catch((e) => swallow("turn: pick ack emoji", e));
  let emoji = "";
  let reactionApplied = false;
  let reactionCancelled = false;
  let settled = false;
  let ackPosted: string | undefined;
  let sawFirstBlock = false;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op).catch((e) => swallow("turn: ack presenter step", e));
  };
  const choose = (): string => (emoji ||= pickResult || randomEmoji());
  const delayMs = deps.reactionDelayMs ?? 2_000;
  const timer = setTimeout(() => {
    if (deps.taskManaged || settled || ackPosted || reactionCancelled) return;
    choose();
    reactionApplied = true;
    enqueue(() => deps.addReaction(emoji));
  }, delayMs);
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
    async emoji() {
      await Promise.race([deps.emojiPick, new Promise((done) => setTimeout(done, delayMs))]);
      return choose();
    },
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

export interface GoalNoticeView {
  objective: string;
  status: "active" | "paused" | "complete" | "cancelled";
  floor?: string;
}

export function renderGoalNotice(goal: GoalNoticeView, escape: (text: string) => string): string {
  const oneLine = goal.objective
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
  const objective = escape(bounded);
  if (goal.status === "complete") return `✓ Goal complete: ${objective}`;
  if (goal.status === "cancelled") return `✕ Goal cancelled: ${objective}`;
  if (goal.status === "paused") return `⏸ Goal paused: ${objective}`;
  return `◐ Pursuing goal: ${objective}${goal.floor ? ` · at least ${goal.floor}` : ""}`;
}

export interface GoalNoticePresenter {
  onGoal(goal: GoalNoticeView): Promise<void>;
  settle(): Promise<void>;
}

export function createGoalNoticePresenter(deps: {
  escape(text: string): string;
  post(text: string): Promise<string | undefined>;
  update(ref: string, text: string): Promise<void>;
  onError?(error: unknown): void;
}): GoalNoticePresenter {
  let messageTs: string | undefined;
  let lastText = "";
  let chain = Promise.resolve();
  return {
    async onGoal(goal) {
      chain = chain.then(async () => {
        const text = renderGoalNotice(goal, deps.escape);
        if (text === lastText) return;
        try {
          if (messageTs) {
            await deps.update(messageTs, text);
          } else {
            messageTs = await deps.post(text);
          }
          if (messageTs) lastText = text;
        } catch (error) {
          deps.onError?.(error);
        }
      });
      await chain;
    },
    async settle() {
      await chain;
    },
  };
}
