import { createPgPool, type PoolClient } from "./pg-pool.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

const RECONNECT_DELAY_MS = 1_000;
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

  let listenClient: PoolClient | null = null;
  let connecting = false;
  let closed = false;

  function dropListenClient(): void {
    const client = listenClient;
    listenClient = null;
    if (client) client.release(true);
  }

  function ensureListening(): void {
    if (closed || connecting || listenClient || local.size() === 0) return;
    connecting = true;
    void (async () => {
      const client = await (await pg.sessionPool()).connect();
      client.on("notification", (msg) => {
        if (msg.channel !== channel || !msg.payload) return;
        try {
          local.emit(JSON.parse(msg.payload) as T);
        } catch (e) {
          swallow(`${label} notification parse`, e);
        }
      });
      client.on("error", () => {
        dropListenClient();
        setTimeout(() => ensureListening(), RECONNECT_DELAY_MS).unref?.();
      });
      try {
        await client.query(`LISTEN ${channel}`);
      } catch (e) {
        client.release(true);
        throw e;
      }
      listenClient = client;
      local.resync();
    })()
      .catch(swallowAs(`${label}: listen connect`, undefined))
      .finally(() => {
        connecting = false;
        if (closed) dropListenClient();
        else if (!listenClient && local.size() > 0) {
          setTimeout(() => ensureListening(), RECONNECT_DELAY_MS).unref?.();
        }
      });
  }

  return {
    emit(event) {
      const payload = encode(event);
      if (payload === null) return;
      void pg.query(`SELECT pg_notify('${channel}', $1)`, [payload]).catch(swallowAs(`${label}: notify`, undefined));
    },

    subscribe(cb, opts) {
      const off = local.subscribe(cb, opts);
      ensureListening();
      return off;
    },

    async close() {
      closed = true;
      dropListenClient();
      await pg.close();
    },
  };
}
