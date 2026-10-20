import type { GoalRecord } from "../harness/goal.ts";
import type { TurnRuntime } from "../types.ts";

export interface GoalView {
  objective: string;
  status: "active" | "paused" | "complete" | "cancelled";

  floor?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReasoningBlock {
  step: string;
  index: number;
  text: string;
}

export interface TurnStream {
  begin(runId: string): void;
  replying(runId: string): boolean;
  publish(runId: string, delta: string): void;
  publishBlockStart(runId: string): void;
  publishReasoning(runId: string, step: string, index: number, delta: string): void;
  settleReasoning(runId: string, step: string, index: number): void;
  reasoning(runId: string): ReasoningBlock[];
  noteToolCall(runId: string): void;
  noteGoal(runId: string, goal: GoalView): void;
  goal(runId: string): GoalView | null;
  noteRuntime(runId: string, runtime: TurnRuntime): void;
  runtime(runId: string): TurnRuntime | null;
  firstBlock(runId: string): { text: string; closed: boolean } | null;
  markSurfacePosted(runId: string): void;
  surfacePosted(runId: string): boolean;
  snapshot(runId: string): string | null;
  startOffset(runId: string): number;
  markReplyDone(runId: string): void;
  isReplyDone(runId: string): boolean;
  end(runId: string): void;
  subscribe(runId: string, listener: TurnStreamListener): () => void;
}

interface TurnStreamListener {
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
}

interface Entry {
  text: string;
  totalChars: number;
  goal: GoalView | null;
  runtime: TurnRuntime | null;
  firstBlock: string;
  firstBlockOpen: boolean;
  firstBlockClosed: boolean;
  reasoning: ReasoningBlock[];
  surfacePosted: boolean;
  replying: boolean;
  replyDone: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TurnStreamOptions {
  maxChars?: number;
  graceMs?: number;
  onDelta?(runId: string, text: string, offset: number, startOffset: number): void;
  onReasoning?(runId: string, block: Omit<ReasoningBlock, "text">, text: string, offset: number): void;
  onChange?(runId: string): void;
}

const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_GRACE_MS = 30_000;
const FIRST_BLOCK_MAX_CHARS = 20_000;
const BLOCK_JOIN = "\n\n";
const REASONING_MAX_BLOCKS = 8;
const REASONING_MAX_CHARS = 20_000;

function makeEntry(partial: Partial<Entry> = {}): Entry {
  return {
    text: "",
    totalChars: 0,
    goal: null,
    runtime: null,
    firstBlock: "",
    firstBlockOpen: true,
    firstBlockClosed: false,
    reasoning: [],
    surfacePosted: false,
    replying: true,
    replyDone: false,
    timer: null,
    ...partial,
  };
}

export function createTurnStream(opts: TurnStreamOptions = {}): TurnStream {
  const maxChars = Math.max(2, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const runs = new Map<string, Entry>();
  const listeners = new Map<string, Set<TurnStreamListener>>();

  const ensure = (runId: string): Entry => {
    let entry = runs.get(runId);
    if (!entry) {
      entry = makeEntry();
      runs.set(runId, entry);
    }
    return entry;
  };

  const append = (runId: string, entry: Entry, delta: string): void => {
    const offset = entry.totalChars;
    entry.totalChars += delta.length;
    entry.text += delta;
    if (entry.text.length > maxChars)
      entry.text = entry.text.slice(-Math.max(BLOCK_JOIN.length, Math.floor(maxChars / 2)));
    opts.onDelta?.(runId, delta, offset, entry.totalChars - entry.text.length);
  };

  return {
    begin(runId) {
      const entry = runs.get(runId);
      if (entry) {
        entry.replying = true;
        entry.reasoning = [];
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
      } else runs.set(runId, makeEntry());
      opts.onChange?.(runId);
    },

    replying(runId) {
      return runs.get(runId)?.replying ?? false;
    },

    publish(runId, delta) {
      if (!delta) return;
      const entry = ensure(runId);
      entry.replying = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.firstBlockOpen && entry.firstBlock.length < FIRST_BLOCK_MAX_CHARS)
        entry.firstBlock = (entry.firstBlock + delta).slice(0, FIRST_BLOCK_MAX_CHARS);
      append(runId, entry, delta);
    },

    publishBlockStart(runId) {
      const entry = runs.get(runId);
      if (!entry) return;
      if (entry.firstBlock) entry.firstBlockOpen = false;
      if (!entry.text || entry.text.endsWith(BLOCK_JOIN)) return;
      append(runId, entry, BLOCK_JOIN);
    },

    publishReasoning(runId, step, index, delta) {
      const entry = ensure(runId);
      let block = entry.reasoning.find((b) => b.step === step && b.index === index);
      if (!block) {
        block = { step, index, text: "" };
        entry.reasoning = [...entry.reasoning, block].slice(-REASONING_MAX_BLOCKS);
      }
      const piece = delta.slice(0, Math.max(0, REASONING_MAX_CHARS - block.text.length));
      if (!piece) return;
      const offset = block.text.length;
      block.text += piece;
      opts.onReasoning?.(runId, { step, index }, piece, offset);
    },

    settleReasoning(runId, step, index) {
      const entry = runs.get(runId);
      if (entry) entry.reasoning = entry.reasoning.filter((b) => b.step !== step || b.index !== index);
    },

    reasoning(runId) {
      return (runs.get(runId)?.reasoning ?? []).map((b) => ({ ...b }));
    },

    noteToolCall(runId) {
      const entry = ensure(runId);
      if (!entry.firstBlockOpen) return;
      entry.firstBlockOpen = false;
      entry.firstBlockClosed = entry.firstBlock.trim().length > 0;
      if (entry.firstBlockClosed) {
        for (const l of listeners.get(runId) ?? []) l.onFirstBlock?.(entry.firstBlock);
      }
    },

    noteGoal(runId, goal) {
      ensure(runId).goal = goal;
    },

    goal(runId) {
      return runs.get(runId)?.goal ?? null;
    },

    noteRuntime(runId, runtime) {
      ensure(runId).runtime = runtime;
      opts.onChange?.(runId);
    },

    runtime(runId) {
      return runs.get(runId)?.runtime ?? null;
    },

    firstBlock(runId) {
      const entry = runs.get(runId);
      if (!entry || !entry.firstBlock.trim()) return null;
      return { text: entry.firstBlock, closed: entry.firstBlockClosed };
    },

    markSurfacePosted(runId) {
      const entry = ensure(runId);
      if (entry.surfacePosted) return;
      entry.surfacePosted = true;
      for (const l of listeners.get(runId) ?? []) l.onSurfacePosted?.();
    },

    surfacePosted(runId) {
      return runs.get(runId)?.surfacePosted ?? false;
    },

    snapshot(runId) {
      const text = runs.get(runId)?.text;
      return text ? text : null;
    },

    startOffset(runId) {
      const entry = runs.get(runId);
      return entry ? entry.totalChars - entry.text.length : 0;
    },

    markReplyDone(runId) {
      const entry = runs.get(runId);
      if (entry) entry.replyDone = true;
      else runs.set(runId, makeEntry({ replyDone: true }));
      opts.onChange?.(runId);
    },

    isReplyDone(runId) {
      return runs.get(runId)?.replyDone ?? false;
    },

    end(runId) {
      const entry = runs.get(runId);
      if (!entry) return;
      if (entry.timer) return;
      const timer = setTimeout(() => runs.delete(runId), graceMs);
      timer.unref?.();
      entry.timer = timer;
    },

    subscribe(runId, listener) {
      let set = listeners.get(runId);
      if (!set) {
        set = new Set();
        listeners.set(runId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
      };
    },
  };
}

export function goalView(goal: GoalRecord): GoalView {
  const floor = formatFloor((goal.floor as Record<string, unknown> | undefined) ?? null);
  return {
    objective: goal.objective,
    status: goal.status,
    ...(floor ? { floor } : {}),
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
  };
}

function formatFloor(floor: Record<string, unknown> | null): string | undefined {
  if (!floor || typeof floor !== "object") return undefined;
  const parts: string[] = [];
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const ms = num(floor.minMs);
  if (ms !== null) {
    if (ms >= 3_600_000) parts.push(`${+(ms / 3_600_000).toFixed(1)}h`);
    else if (ms >= 60_000) parts.push(`${+(ms / 60_000).toFixed(1)}m`);
    else parts.push(`${Math.round(ms / 1000)}s`);
  }
  const turns = num(floor.minTurns);
  if (turns !== null) parts.push(`${turns} turns`);
  const tokens = num(floor.minTokens);
  if (tokens !== null) parts.push(`${tokens} tokens`);
  const usd = num(floor.minUsd);
  if (usd !== null) parts.push(`$${usd}`);
  return parts.length ? parts.join(", ") : undefined;
}
