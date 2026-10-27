import { AsyncResource } from "node:async_hooks";
import { createPgPool } from "./pg-pool.ts";
import { registeredTenant, scopedTenant, tenant, withTenant } from "../tenant.ts";
import { swallowAs } from "../util/errors.ts";
import { createMemoryEventBus, type EventBus } from "../util/event-bus.ts";

import { subscribePostgresChannel } from "./postgres-listener.ts";
export const MAX_NOTIFY_PAYLOAD_BYTES = 7_500;

function encodeCapped<T>(event: T, label: string): string | null {
  const payload = JSON.stringify(event);
  const bytes = Buffer.byteLength(payload, "utf8");
  if (bytes <= MAX_NOTIFY_PAYLOAD_BYTES) return payload;
  console.warn(
    `[${label}] event of ${bytes} bytes exceeds the ${MAX_NOTIFY_PAYLOAD_BYTES}-byte NOTIFY limit; other instances will not see it`,
  );
  return null;
}

interface Notice<T> {
  t: string | null;
  e: T;
}

export function noticePayload(encoded: string): string {
  return `{"t":${JSON.stringify(tenant().id ?? null)},"e":${encoded}}`;
}

function parseNotice<T>(payload: string): Notice<T> | undefined {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null || !("e" in parsed) || !("t" in parsed)) return undefined;
    const { t } = parsed as { t: unknown };
    return t === null || typeof t === "string" ? (parsed as Notice<T>) : undefined;
  } catch {
    return undefined;
  }
}

function deliverTo<T>(cb: (event: T) => void): (notice: Notice<T>) => void {
  const own = scopedTenant();
  const here = AsyncResource.bind((fn: () => void) => fn());
  if (own)
    return (notice) => {
      if (notice.t === (own.id ?? null)) here(() => cb(notice.e));
    };
  return (notice) => {
    if (notice.t === null) return here(() => cb(notice.e));
    const t = registeredTenant(notice.t);
    if (t) here(() => withTenant(t, () => cb(notice.e)));
  };
}

export function createPostgresNotifyBus<T>(
  connectionString: string,
  channel: string,
  label: string,
  encode: (event: T) => string | null = (event) => encodeCapped(event, label),
): EventBus<T> {
  if (!/^[a-z][a-z0-9_]*$/.test(channel)) throw new Error(`invalid NOTIFY channel name: ${channel}`);
  const pg = createPgPool(connectionString);
  const local = createMemoryEventBus<Notice<T>>(label);

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
      (payload) => {
        const notice = parseNotice<T>(payload);
        if (notice) local.emit(notice);
      },
      () => local.resync(),
    );
  }

  return {
    emit(event) {
      if (closed) return;
      const payload = encode(event);
      if (payload === null) return;
      pending.push(noticePayload(payload));
      publishing ??= Promise.resolve().then(flush);
    },

    subscribe(cb, opts) {
      const onResync = opts?.onResync;
      const off = local.subscribe(deliverTo(cb), {
        ...opts,
        ...(onResync ? { onResync: AsyncResource.bind(onResync) } : {}),
      });
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
