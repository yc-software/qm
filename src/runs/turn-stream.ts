export interface GoalView {
  objective: string;
  status: "active" | "paused" | "complete" | "blocked";

  floor?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TurnStream {
  begin(runId: string): void;
  replying(runId: string): boolean;
  publish(runId: string, delta: string): void;
  publishBlockStart(runId: string): void;
  noteToolCall(runId: string): void;
  noteGoal(runId: string, goal: GoalView): void;
  goal(runId: string): GoalView | null;
  firstBlock(runId: string): { text: string; closed: boolean } | null;
  markSurfacePosted(runId: string): void;
  surfacePosted(runId: string): boolean;
  snapshot(runId: string): string | null;
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
  goal: GoalView | null;
  firstBlock: string;
  firstBlockOpen: boolean;
  firstBlockClosed: boolean;
  surfacePosted: boolean;
  replying: boolean;
  replyDone: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface TurnStreamOptions {
  maxChars?: number;
  graceMs?: number;
}

const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_GRACE_MS = 30_000;
const FIRST_BLOCK_MAX_CHARS = 20_000;
const BLOCK_JOIN = "\n\n";

function makeEntry(partial: Partial<Entry> = {}): Entry {
  return {
    text: "",
    goal: null,
    firstBlock: "",
    firstBlockOpen: true,
    firstBlockClosed: false,
    surfacePosted: false,
    replying: true,
    replyDone: false,
    timer: null,
    ...partial,
  };
}

export function createTurnStream(opts: TurnStreamOptions = {}): TurnStream {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
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

  return {
    begin(runId) {
      const entry = runs.get(runId);
      if (entry) entry.replying = true;
      else runs.set(runId, makeEntry());
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
      if (entry.text.length < maxChars) entry.text = (entry.text + delta).slice(0, maxChars);
    },

    publishBlockStart(runId) {
      const entry = runs.get(runId);
      if (!entry) return;
      if (entry.firstBlock) entry.firstBlockOpen = false;
      if (!entry.text || entry.text.endsWith(BLOCK_JOIN)) return;
      if (entry.text.length < maxChars) entry.text = (entry.text + BLOCK_JOIN).slice(0, maxChars);
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

    markReplyDone(runId) {
      const entry = runs.get(runId);
      if (entry) entry.replyDone = true;
      else runs.set(runId, makeEntry({ replyDone: true }));
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

export function goalViewFromEntry(type: string, payload: unknown): GoalView | null {
  if (type !== "tool_result" && type !== "system") return null;
  const p = payload as { tool?: unknown; kind?: unknown; goal?: unknown } | null;
  if (!p || typeof p !== "object") return null;
  const carrier =
    type === "system"
      ? p.kind === "goal"
      : p.tool === "create_goal" || p.tool === "update_goal" || p.tool === "get_goal";
  if (!carrier) return null;
  const goal = p.goal as
    | {
        objective?: unknown;
        status?: unknown;
        floor?: Record<string, unknown> | null;
        createdAt?: unknown;
        updatedAt?: unknown;
      }
    | null
    | undefined;
  if (!goal || typeof goal !== "object") return null;
  if (typeof goal.objective !== "string" || !goal.objective.trim()) return null;
  const status = goal.status;
  if (status !== "active" && status !== "paused" && status !== "complete" && status !== "blocked") return null;
  const floor = formatFloor(goal.floor ?? null);
  return {
    objective: goal.objective,
    status,
    ...(floor ? { floor } : {}),
    createdAt: typeof goal.createdAt === "number" ? goal.createdAt : Date.now(),
    updatedAt: typeof goal.updatedAt === "number" ? goal.updatedAt : Date.now(),
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
