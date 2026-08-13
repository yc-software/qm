import { createPgListener, createPgPool, type PgListener } from "../persistence/pg-pool.ts";
import { swallow, swallowAs } from "../util/errors.ts";
import type { SessionStateBus, SessionStateEvent } from "./session-state-bus.ts";

const CHANNEL = "session_state";
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
  let listener: PgListener | null = null;
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

  function ensureListening(): void {
    if (closed || listener || listeners.size === 0) return;
    listener = createPgListener(pg, CHANNEL, (payload) => {
      try {
        ring(JSON.parse(payload) as SessionStateEvent);
      } catch (e) {
        swallow("session-state notification parse", e);
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
      listener?.close();
      await pg.close();
    },
  };
}
