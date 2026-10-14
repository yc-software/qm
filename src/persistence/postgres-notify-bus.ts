import { createPgPool } from "./pg-pool.ts";
import { swallowAs } from "../util/errors.ts";
import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

import { subscribePostgresChannel } from "./postgres-listener.ts";
export const MAX_NOTIFY_PAYLOAD_BYTES = 7_500;

function encodeCapped<T>(event: T): string | null {
  const payload = JSON.stringify(event);
  return Buffer.byteLength(payload, "utf8") <= MAX_NOTIFY_PAYLOAD_BYTES ? payload : null;
}

export function createPostgresNotifyBus<T>(
  connectionString: string,
  channel: string,
  label: string,
  encode: (event: T) => string | null = encodeCapped,
): EventBus<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(channel)) throw new Error(`invalid NOTIFY channel name: ${channel}`);
  const pg = createPgPool(connectionString, []);
  const local = createMemoryEventBus<T>(label);

  let stopListening: (() => Promise<void>) | null = null;
  let closed = false;
  let cleanup = Promise.resolve();
  let publishing: Promise<void> | null = null;
  let pending: string[] = [];

  const flush = async (): Promise<void> => {
    try {
      while (pending.length) {
        const batch = pending;
        pending = [];
        await pg
          .query(
            `SELECT pg_notify('${channel}', payload) FROM unnest($1::text[]) WITH ORDINALITY AS events(payload, ordinal) ORDER BY ordinal`,
            [batch],
          )
          .catch(swallowAs(`${label}: notify`, undefined));
      }
    } finally {
      publishing = null;
    }
  };

  function dropListenClient() {
    const stop = stopListening;
    stopListening = null;
    if (stop) cleanup = Promise.all([cleanup, stop()]).then(() => {});
  }

  function ensureListening() {
    if (closed || stopListening || local.size() === 0) return;
    stopListening = subscribePostgresChannel(
      connectionString,
      channel,
      (payload) => local.emit(JSON.parse(payload) as T),
      () => local.resync(),
    );
  }

  return {
    emit(event) {
      if (closed) return;
      const payload = encode(event);
      if (payload === null) return;
      pending.push(payload);
      publishing ??= Promise.resolve().then(flush);
    },

    subscribe(cb, opts) {
      const off = local.subscribe(cb, opts);
      ensureListening();
      return () => {
        off();
        if (local.size() === 0) dropListenClient();
      };
    },

    async close() {
      closed = true;
      dropListenClient();
      await Promise.all([cleanup, publishing]);
      await pg.close();
    },
  };
}
