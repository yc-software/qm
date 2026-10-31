import { swallow } from "../util/errors.ts";

export const DEFAULT_ACK_REACTIONS = ["eyes", "mag", "hourglass_flowing_sand", "telescope", "saluting_face"] as const;

export interface AckPresenter {
  onFirstBlock(text: string): void;
  onSurfacePosted(): void;
  postedAck(): string | undefined;
  drain(): Promise<void>;
  settle(): Promise<void>;
}

export const ACK_REACTION_DELAY_MS = 2_000;

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
  void deps.emojiPick?.then((v) => (pickResult = v)).catch((e) => swallow("ack: pick emoji", e));
  let emoji = "";
  let reactionApplied = false;
  let reactionCancelled = false;
  let settled = false;
  let ackPosted: string | undefined;
  let sawFirstBlock = false;
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (op: () => Promise<void>): void => {
    chain = chain.then(op).catch((e) => swallow("ack: presenter step", e));
  };
  const timer = setTimeout(() => {
    if (deps.taskManaged || settled || ackPosted || reactionCancelled) return;
    emoji = pickResult || randomEmoji();
    reactionApplied = true;
    enqueue(() => deps.addReaction(emoji));
  }, deps.reactionDelayMs ?? ACK_REACTION_DELAY_MS);
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
