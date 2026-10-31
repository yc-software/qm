import { escapeSlackText } from "./mrkdwn.ts";

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

export interface GoalNoticeView {
  objective: string;
  status: "active" | "paused" | "complete" | "cancelled";
  floor?: string;
}

export function renderGoalNotice(goal: GoalNoticeView): string {
  const oneLine = goal.objective
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const bounded = oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
  const objective = escapeSlackText(bounded);
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
