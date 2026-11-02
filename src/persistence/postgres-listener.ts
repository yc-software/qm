import { createPgPool, type Sql } from "./pg-pool.ts";
import { swallow } from "../util/errors.ts";

type Subscription = { channel: string; receive: (payload: string) => void; resync: () => void };
const listeners = new Map<string, ReturnType<typeof createListener>>();

function createListener(connectionString: string) {
  const pg = createPgPool(connectionString);
  const subscriptions = new Set<Subscription>();
  const ready = new Set<Subscription>();
  const channels = new Map<string, () => Promise<void>>();
  let connection: Promise<Sql> | null = null;
  let pending = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function drop() {
    const previous = connection;
    connection = null;
    channels.clear();
    ready.clear();
    void previous?.then((sql) => sql.end({ timeout: 0 })).catch(() => undefined);
  }

  function scheduleRetry() {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      sync();
    }, 1_000);
    retry.unref();
  }

  function invoke(callback: () => void) {
    try {
      callback();
    } catch (error) {
      swallow("postgres listener callback", error);
    }
  }

  function receive(channel: string, payload: string) {
    if (!payload || !channels.has(channel)) return;
    for (const subscription of subscriptions) {
      if (subscription.channel === channel) invoke(() => subscription.receive(payload));
    }
  }

  function relisten(channel: string) {
    if (!channels.has(channel)) return;
    for (const subscription of subscriptions) {
      if (subscription.channel === channel) {
        ready.add(subscription);
        invoke(subscription.resync);
      }
    }
  }

  async function reconcile() {
    if (closed) {
      drop();
      await pg.close();
      return;
    }
    const current = (connection ??= pg.dedicated({ pinned: true }));
    const sql = await current;
    const wanted = new Set([...subscriptions].map(({ channel }) => channel));
    for (const [channel, unlisten] of channels) {
      if (!wanted.has(channel)) {
        await unlisten();
        if (closed || connection !== current) return;
        channels.delete(channel);
      }
    }
    for (const channel of wanted) {
      if (!channels.has(channel)) {
        const { unlisten } = await sql.listen(
          channel,
          (payload) => receive(channel, payload),
          () => relisten(channel),
        );
        if (closed || connection !== current) return;
        channels.set(channel, unlisten);
      }
    }
    for (const subscription of subscriptions) {
      if (channels.has(subscription.channel) && !ready.has(subscription)) {
        ready.add(subscription);
        invoke(subscription.resync);
      }
    }
  }

  function sync() {
    pending = pending.then(reconcile).catch((error) => {
      swallow("postgres listener connection", error);
      drop();
      scheduleRetry();
    });
    return pending;
  }

  return {
    subscribe(subscription: Subscription) {
      subscriptions.add(subscription);
      sync();
      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        subscriptions.delete(subscription);
        ready.delete(subscription);
        if (subscriptions.size === 0) {
          closed = true;
          listeners.delete(connectionString);
          clearTimeout(retry);
        }
        await sync();
      };
    },
  };
}

export function subscribePostgresChannel(
  connectionString: string,
  channel: string,
  receive: (payload: string) => void,
  resync: () => void,
): () => Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(channel)) throw new Error(`invalid NOTIFY channel name: ${channel}`);
  let listener = listeners.get(connectionString);
  if (!listener) {
    listener = createListener(connectionString);
    listeners.set(connectionString, listener);
  }
  return listener.subscribe({ channel, receive, resync });
}
