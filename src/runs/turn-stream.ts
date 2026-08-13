export interface TurnStream {
  begin(runId: string): void;
  alive(runId: string): boolean;
  replying(runId: string): boolean;
  publish(runId: string, delta: string): void;
  publishBlockStart(runId: string): void;
  noteToolCall(runId: string): void;
  firstBlock(runId: string): { text: string; closed: boolean } | null;
  markSurfacePosted(runId: string): void;
  surfacePosted(runId: string): boolean;
  snapshot(runId: string): string | null;
  drain(runId: string): Promise<void>;
  markReplyDone(runId: string): void;
  isReplyDone(runId: string): boolean;
  end(runId: string): void;
  subscribe(runId: string, listener: TurnStreamListener): () => void;
}

interface TurnStreamListener {
  onDelta?(delta: string): void | Promise<void>;
  onFirstBlock?(text: string): void;
  onSurfacePosted?(): void;
}

interface Entry {
  text: string;
  firstBlock: string;
  firstBlockOpen: boolean;
  firstBlockClosed: boolean;
  surfacePosted: boolean;
  live: boolean;
  replying: boolean;
  replyDone: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

interface ListenerDelivery {
  tail: Promise<void>;
  error?: unknown;
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
    firstBlock: "",
    firstBlockOpen: true,
    firstBlockClosed: false,
    surfacePosted: false,
    live: true,
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
  const deliveries = new Map<string, Map<TurnStreamListener, ListenerDelivery>>();

  const enqueueDelta = (runId: string, listener: TurnStreamListener, delta: string): void => {
    const delivery = deliveries.get(runId)?.get(listener);
    if (!delivery || !listener.onDelta) return;
    delivery.tail = delivery.tail.then(async () => {
      try {
        await listener.onDelta?.(delta);
      } catch (error) {
        delivery.error ??= error;
      }
    });
  };

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
      if (entry) {
        entry.replying = true;
        entry.live = true;
      } else runs.set(runId, makeEntry());
    },

    alive(runId) {
      return runs.get(runId)?.live ?? false;
    },

    replying(runId) {
      return runs.get(runId)?.replying ?? false;
    },

    publish(runId, delta) {
      if (!delta) return;
      const entry = ensure(runId);
      entry.replying = true;
      entry.live = true;
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
      }
      if (entry.firstBlockOpen && entry.firstBlock.length < FIRST_BLOCK_MAX_CHARS)
        entry.firstBlock = (entry.firstBlock + delta).slice(0, FIRST_BLOCK_MAX_CHARS);
      if (entry.text.length < maxChars) entry.text = (entry.text + delta).slice(0, maxChars);
      for (const l of listeners.get(runId) ?? []) enqueueDelta(runId, l, delta);
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

    async drain(runId) {
      const pending = [...(deliveries.get(runId)?.values() ?? [])];
      await Promise.all(pending.map((delivery) => delivery.tail));
      const failed = pending.find((delivery) => delivery.error !== undefined);
      if (failed) throw failed.error;
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
      entry.live = false;
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
      let deliveryMap = deliveries.get(runId);
      if (!deliveryMap) {
        deliveryMap = new Map();
        deliveries.set(runId, deliveryMap);
      }
      deliveryMap.set(listener, { tail: Promise.resolve() });
      const buffered = runs.get(runId)?.text;
      if (buffered) enqueueDelta(runId, listener, buffered);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(runId) === set) listeners.delete(runId);
        const delivery = deliveryMap.get(listener);
        void delivery?.tail.finally(() => {
          if (deliveryMap.get(listener) === delivery) deliveryMap.delete(listener);
          if (deliveryMap.size === 0 && deliveries.get(runId) === deliveryMap) deliveries.delete(runId);
        });
      };
    },
  };
}
