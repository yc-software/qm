import { createPgPool, type PoolClient } from "../persistence/pg-pool.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import type { SessionStateBus, SessionStateEvent } from "./session-state-bus.ts";

const CHANNEL = "session_state";
const RECONNECT_DELAY_MS = 1_000;
const MAX_PAYLOAD_BYTES = 7_500;

export function encodeWirePayload(event: SessionStateEvent, maxBytes = MAX_PAYLOAD_BYTES): string | null {
  const full = JSON.stringify(event);
  if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;
  const { participants: _participants, ...bare } = event;
  const shed = JSON.stringify(bare);
  return Buffer.byteLength(shed, "utf8") <= maxBytes ? shed : null;
}

export function createPostgresSessionStateBus(connectionString: string): SessionStateBus {
  const pg = createPgPool(connectionString, []);

  const listeners = new Set<(e: SessionStateEvent) => void>();
  let listenClient: PoolClient | null = null;
  let connecting = false;
  let closed = false;

  function ring(event: SessionStateEvent): void {
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (e) {
        swallow("session-state listener", e);
      }
    }
  }

  function dropListenClient(): void {
    const client = listenClient;
    listenClient = null;
    if (client) client.release(true);
  }

  function ensureListening(): void {
    if (closed || connecting || listenClient || listeners.size === 0) return;
    connecting = true;
    void (async () => {
      const client = await (await pg.pool()).connect();
      client.on("notification", (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        try {
          ring(JSON.parse(msg.payload) as SessionStateEvent);
        } catch (e) {
          swallow("session-state notification parse", e);
        }
      });
      client.on("error", () => {
        dropListenClient();
        setTimeout(() => ensureListening(), RECONNECT_DELAY_MS).unref?.();
      });
      await client.query(`LISTEN ${CHANNEL}`);
      listenClient = client;
    })()
      .catch(swallowAs("session-state: listen connect", undefined))
      .finally(() => {
        connecting = false;
        if (closed) dropListenClient();
        else if (!listenClient && listeners.size > 0) {
          setTimeout(() => ensureListening(), RECONNECT_DELAY_MS).unref?.();
        }
      });
  }

  return {
    emit(event) {
      const payload = encodeWirePayload(event);
      if (payload === null) return;
      void pg
        .query(`SELECT pg_notify('${CHANNEL}', $1)`, [payload])
        .catch(swallowAs("session-state: notify", undefined));
    },

    subscribe(cb) {
      listeners.add(cb);
      ensureListening();
      return () => {
        listeners.delete(cb);
      };
    },

    async close() {
      closed = true;
      dropListenClient();
      await pg.close();
    },
  };
}
