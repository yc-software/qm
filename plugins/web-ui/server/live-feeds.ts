import { swallow } from "../../chassis/src/errors.ts";
import { type ServerResponse } from "node:http";

import { coreFetch, fetchCoreGet, tryParse } from "./core-relay.ts";
import { onEdgeTenants, perEdgeTenant, withEdgeTenant } from "../../chassis/src/tenant-hosts.ts";
import type { TenantSettings } from "../../chassis/src/tenant-settings.ts";

export const eventClients = perEdgeTenant(() => new Map<string, Set<ServerResponse>>());

const ownerOfWebThread = (threadRef: string) => /^web:([^:]+):/.exec(threadRef)?.[1];

export const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

function sseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function sendTo(users: Iterable<string>, event: string, data: unknown = {}): void {
  const clients = eventClients();
  for (const user of users) for (const res of clients.get(user) ?? []) sseEvent(res, event, data);
}

export const SSE_HEARTBEAT_MS = 15_000;

const STATE_FEED_RECONNECT_MS = Number(process.env.STATE_FEED_RECONNECT_MS ?? 3_000);

interface SessionStateFrame {
  threadRef?: string;
  state?: string;
  participants?: string[];
  [k: string]: unknown;
}

function forwardSessionState(frame: SessionStateFrame): void {
  const threadRef = typeof frame.threadRef === "string" ? frame.threadRef : "";
  if (!threadRef) return;
  const targets = new Set<string>(
    Array.isArray(frame.participants) ? frame.participants.filter((p): p is string => typeof p === "string") : [],
  );
  if (targets.size === 0) {
    const owner = ownerOfWebThread(threadRef);
    if (owner) targets.add(owner);
  }
  const { participants: _participants, ...visible } = frame;
  sendTo(targets, "session_state", visible);
}

async function consumeCoreFeed(
  path: string,
  eventName: string,
  onEvent: (data: unknown) => void,
  signal: AbortSignal,
  onReconnect?: () => void,
): Promise<void> {
  let dropped = false;
  while (!signal.aborted) {
    try {
      const r = await fetchCoreGet(path, { signal }, {});
      if (r.status === 200 && r.body) {
        if (dropped) {
          dropped = false;
          onReconnect?.();
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const frames = buf.split("\n\n");
          buf = frames.pop() ?? "";
          for (const frame of frames) {
            const lines = frame.split("\n");
            if (lines.some((l) => l === `event: ${eventName}_resync`)) {
              onReconnect?.();
              continue;
            }
            if (!lines.some((l) => l === `event: ${eventName}`)) continue;
            const data = lines.find((l) => l.startsWith("data: "))?.slice("data: ".length);
            if (!data) continue;
            try {
              onEvent(JSON.parse(data));
            } catch (error) {
              swallow(`web-ui: ${eventName} feed dropped a malformed frame`, error);
            }
          }
        }
        console.warn(`[web-ui] ${eventName} feed ended; reconnecting`);
      } else console.warn(`[web-ui] ${eventName} feed returned HTTP ${r.status}; reconnecting`);
      dropped = true;
    } catch (error) {
      if (signal.aborted) return;
      swallow(`web-ui: ${eventName} feed dropped (reconnecting)`, error);
      dropped = true;
    }
    await new Promise((resolve) => setTimeout(resolve, STATE_FEED_RECONNECT_MS).unref());
  }
}

function runFeeds(signal: AbortSignal): void {
  void consumeCoreFeed(
    "/v1/session-state/events",
    "session_state",
    (data) => forwardSessionState(data as SessionStateFrame),
    signal,
    () => sendTo(eventClients().keys(), "session_state_resync"),
  );
  void consumeCoreFeed(
    "/v1/cron-items/events",
    "inbox_item",
    (data) => void forwardInboxItem(data as { cronId?: string; itemId?: string; op?: string }),
    signal,
    resyncInbox,
  );
}

export function startLiveFeeds(): void {
  const running = new Map<string, { feed: AbortController; tenant: TenantSettings | undefined }>();
  onEdgeTenants((tenants) => {
    const wanted = new Map<string, TenantSettings | undefined>(
      tenants.length ? tenants.map((t) => [`${t.id ?? ""}\n${t.hosts[0] ?? ""}`, t]) : [["", undefined]],
    );
    for (const [key, { feed, tenant }] of running)
      if (!wanted.has(key)) {
        feed.abort();
        running.delete(key);
        withEdgeTenant(tenant, () => {
          for (const clients of eventClients().values()) for (const res of clients) res.end();
        });
      }
    for (const [key, tenant] of wanted) {
      if (running.has(key)) continue;
      const feed = new AbortController();
      running.set(key, { feed, tenant });
      withEdgeTenant(tenant, () => runFeeds(feed.signal));
    }
  });
}

const resyncInbox = () => sendTo(eventClients().keys(), "inbox_resync");

async function forwardInboxItem(ev: { cronId?: string; itemId?: string; op?: string }): Promise<void> {
  const clients = eventClients();
  if (!ev.cronId || !ev.itemId || !clients.size) return;
  const r = await coreFetch(
    "POST",
    "/v1/inbox/viewers",
    JSON.stringify({ cronId: ev.cronId, candidates: [...clients.keys()] }),
  ).catch(() => null);
  if (r?.status === 404) return;
  const viewers = r?.status === 200 ? tryParse<{ viewers?: string[] }>(r.text)?.viewers : undefined;
  if (!viewers) return resyncInbox();
  sendTo(viewers, "inbox_item", { cronId: ev.cronId, itemId: ev.itemId, op: ev.op ?? "" });
}
