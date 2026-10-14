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
  taskManaged?: boolean;
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
    if (deps.taskManaged || settled || ackPosted || reactionCancelled) return;
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

export interface GoalNoticeView {
  objective: string;
  status: "active" | "paused" | "complete" | "blocked";
  floor?: string;
}

export function renderGoalNotice(goal: GoalNoticeView): string {
  const oneLine = goal.objective
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
  const objective = bounded.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (goal.status === "complete") return `✓ Goal complete: ${objective}`;
  if (goal.status === "blocked") return `✕ Goal blocked: ${objective}`;
  if (goal.status === "paused") return `⏸ Goal paused: ${objective}`;
  return `◐ Pursuing goal: ${objective}${goal.floor ? ` · at least ${goal.floor}` : ""}`;
}

export interface GoalNoticePresenter {
  onGoal(goal: GoalNoticeView): Promise<void>;
  settle(): Promise<void>;
}

export function createGoalNoticePresenter(deps: {
  post(text: string, blocks: Array<Record<string, unknown>>): Promise<string | undefined>;
  update(ts: string, text: string, blocks: Array<Record<string, unknown>>): Promise<void>;
  onError?(error: unknown): void;
}): GoalNoticePresenter {
  let messageTs: string | undefined;
  let lastText = "";
  let chain = Promise.resolve();
  const blocksFor = (text: string): Array<Record<string, unknown>> => [
    { type: "context", elements: [{ type: "mrkdwn", text }] },
  ];
  return {
    async onGoal(goal) {
      chain = chain.then(async () => {
        const text = renderGoalNotice(goal);
        if (text === lastText) return;
        try {
          if (messageTs) {
            await deps.update(messageTs, text, blocksFor(text));
          } else {
            messageTs = await deps.post(text, blocksFor(text));
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
