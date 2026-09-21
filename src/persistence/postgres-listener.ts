import { createPgPool, type PoolClient } from "./pg-pool.ts";
import { swallow } from "../util/errors.ts";
import { currentTenant, runWithTenant } from "../tenancy/context.ts";

type Subscription = { channel: string; receive: (payload: string) => void; resync: () => void };
const listeners = new Map<string, ReturnType<typeof createListener>>();

function createListener(connectionString: string) {
  const pg = createPgPool(connectionString, []);
  const subscriptions = new Set<Subscription>();
  const ready = new Set<Subscription>();
  const channels = new Set<string>();
  let client: PoolClient | null = null;
  let pending = Promise.resolve();
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function drop() {
    const previous = client;
    client = null;
    channels.clear();
    ready.clear();
    previous?.release(true);
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

  async function reconcile() {
    if (closed) {
      drop();
      await pg.close();
      return;
    }
    if (!client) {
      const acquired = await (await pg.sessionPool()).connect();
      if (closed) {
        acquired.release(true);
        return;
      }
      client = acquired;
      const disconnected = () => {
        if (client !== acquired) return;
        drop();
        scheduleRetry();
      };
      acquired.on("error", disconnected);
      acquired.on("end", disconnected);
      acquired.on("notification", (message) => {
        if (client !== acquired || !message.payload) return;
        for (const subscription of subscriptions) {
          if (subscription.channel === message.channel) invoke(() => subscription.receive(message.payload!));
        }
      });
    }
    const current = client;
    const wanted = new Set([...subscriptions].map(({ channel }) => channel));
    for (const channel of channels) {
      if (!wanted.has(channel)) {
        await current.query(`UNLISTEN ${channel}`);
        if (closed || client !== current) return;
        channels.delete(channel);
      }
    }
    for (const channel of wanted) {
      if (!channels.has(channel)) {
        await current.query(`LISTEN ${channel}`);
        if (closed || client !== current) return;
        channels.add(channel);
      }
    }
    if (closed || client !== current) return;
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
  const tenant = currentTenant();
  return listener.subscribe({
    channel,
    receive: tenant ? (payload) => runWithTenant(tenant, () => receive(payload)) : receive,
    resync: tenant ? () => runWithTenant(tenant, resync) : resync,
  });
}
