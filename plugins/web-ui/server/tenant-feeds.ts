import type { ServerResponse } from "node:http";
import { mintPortalIdentity, portalIdentityTenant } from "../../chassis/src/portal-identity.ts";

type CoreText = { status: number; text: string };

export interface TenantFeedDeps {
  identitySecret: string | undefined;
  currentToken(): string | undefined;
  asToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T>;
  coreFetch(method: "GET" | "POST", path: string, body?: string): Promise<CoreText>;
  openFeed(path: string, signal: AbortSignal): Promise<Response>;
  sseEvent(res: ServerResponse, event: string, data: unknown): void;
  ownerOfWebThread(threadRef: string): string | null;
  noteDeliveries(failure: unknown): void;
  reconnectMs: number;
  giveupMs: number;
}

interface Lane {
  tenant: string | undefined;
  clients: Map<string, Set<ServerResponse>>;
  stop: AbortController;
  polling: boolean;
  running: boolean;
}

interface SessionStateFrame {
  threadRef?: string;
  participants?: string[];
  [k: string]: unknown;
}

interface PendingWebDelivery {
  id: string;
  createdAt: number;
  destination?: { target?: string };
}

export function createTenantFeeds(deps: TenantFeedDeps) {
  const lanes = new Map<string, Lane>();

  function laneToken(lane: Lane): string | undefined | null {
    if (!lane.tenant) return undefined;
    const p = lane.clients.keys().next().value;
    if (!p || !deps.identitySecret) return null;
    return mintPortalIdentity({ p, t: lane.tenant, exp: Date.now() + 60_000 }, deps.identitySecret);
  }

  function inLane<T>(lane: Lane, fn: () => Promise<T>): Promise<T | null> {
    const token = laneToken(lane);
    return token === null ? Promise.resolve(null) : deps.asToken(token, fn);
  }

  function broadcast(lane: Lane, event: string): void {
    for (const conns of lane.clients.values()) for (const res of conns) deps.sseEvent(res, event, {});
  }

  function forwardSessionState(lane: Lane, frame: SessionStateFrame): void {
    const threadRef = typeof frame.threadRef === "string" ? frame.threadRef : "";
    if (!threadRef) return;
    const targets = new Set<string>(
      Array.isArray(frame.participants) ? frame.participants.filter((p): p is string => typeof p === "string") : [],
    );
    if (targets.size === 0) {
      const owner = deps.ownerOfWebThread(threadRef);
      if (owner) targets.add(owner);
    }
    const { participants: _participants, ...visible } = frame;
    for (const user of targets) {
      for (const res of lane.clients.get(user) ?? []) deps.sseEvent(res, "session_state", visible);
    }
  }

  async function forwardInboxItem(lane: Lane, ev: { loopId?: string; itemId?: string; op?: string }): Promise<void> {
    if (!ev.loopId || !ev.itemId || !lane.clients.size) return;
    const r = await inLane(lane, () =>
      deps.coreFetch(
        "POST",
        "/v1/inbox/viewers",
        JSON.stringify({ loopId: ev.loopId, candidates: [...lane.clients.keys()] }),
      ),
    ).catch(() => null);
    if (r?.status === 404) return;
    let viewers: string[] | undefined;
    try {
      viewers = r?.status === 200 ? (JSON.parse(r.text) as { viewers?: string[] }).viewers : undefined;
    } catch {
      viewers = undefined;
    }
    if (!viewers) return broadcast(lane, "inbox_resync");
    const frame = { loopId: ev.loopId, itemId: ev.itemId, op: ev.op ?? "" };
    for (const user of viewers) for (const res of lane.clients.get(user) ?? []) deps.sseEvent(res, "inbox_item", frame);
  }

  async function readFrames(body: ReadableStream<Uint8Array>, eventName: string, on: (frame: string[]) => void) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame.split("\n");
        if (lines.some((l) => l === `event: ${eventName}_resync` || l === `event: ${eventName}`)) on(lines);
      }
    }
  }

  async function consume(lane: Lane, path: string, eventName: string, onEvent: (data: unknown) => void) {
    const onReconnect = () => broadcast(lane, `${eventName === "loop_item" ? "inbox" : eventName}_resync`);
    let dropped = false;
    while (!lane.stop.signal.aborted) {
      try {
        const r = await inLane(lane, () => deps.openFeed(path, lane.stop.signal));
        if (r?.status === 200 && r.body) {
          if (dropped) {
            dropped = false;
            onReconnect();
          }
          await readFrames(r.body, eventName, (lines) => {
            if (lines.includes(`event: ${eventName}_resync`)) return onReconnect();
            const data = lines.find((l) => l.startsWith("data: "))?.slice("data: ".length);
            if (!data) return;
            try {
              onEvent(JSON.parse(data));
            } catch {
              void 0;
            }
          });
        }
        dropped = true;
      } catch {
        dropped = true;
      }
      if (lane.stop.signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, deps.reconnectMs).unref?.());
    }
  }

  function openLane(tenant: string | undefined): Lane {
    const lane: Lane = { tenant, clients: new Map(), stop: new AbortController(), polling: false, running: false };
    lanes.set(tenant ?? "", lane);
    return lane;
  }

  function runLane(lane: Lane): void {
    lane.running = true;
    void consume(lane, "/v1/session-state/events", "session_state", (data) =>
      forwardSessionState(lane, data as SessionStateFrame),
    );
    void consume(
      lane,
      "/v1/loop-items/events",
      "loop_item",
      (data) => void forwardInboxItem(lane, data as { loopId?: string; itemId?: string; op?: string }),
    );
  }

  async function pollLane(lane: Lane): Promise<unknown> {
    const r = await inLane(lane, () => deps.coreFetch("GET", "/v1/deliveries?type=web"));
    if (!r) return undefined;
    if (r.status !== 200) return new Error(`GET /v1/deliveries http ${r.status}: ${r.text.slice(0, 200)}`);
    const pending = (JSON.parse(r.text) as { deliveries?: PendingWebDelivery[] }).deliveries ?? [];
    const now = Date.now();
    let failure: unknown;
    for (const d of pending) {
      const target = d.destination?.target ?? "";
      const conns = lane.clients.get(deps.ownerOfWebThread(target) ?? "");
      if (conns && conns.size) {
        for (const res of conns) deps.sseEvent(res, "delivery", { threadRef: target });
      } else if (now - (d.createdAt ?? 0) < deps.giveupMs) {
        continue;
      }
      try {
        const ack = await inLane(lane, () => deps.coreFetch("POST", `/v1/deliveries/${encodeURIComponent(d.id)}/ack`));
        if (ack && ack.status !== 200)
          failure ??= new Error(`ack delivery ${d.id} http ${ack.status}: ${ack.text.slice(0, 200)}`);
      } catch (e) {
        failure ??= e;
      }
    }
    return failure;
  }

  async function drainLane(lane: Lane): Promise<unknown> {
    if (lane.polling) return undefined;
    lane.polling = true;
    try {
      return await pollLane(lane);
    } catch (e) {
      return e;
    } finally {
      lane.polling = false;
    }
  }

  return {
    requestTenant: (): string | undefined => portalIdentityTenant(deps.currentToken(), deps.identitySecret),
    start: () => {
      const lane = lanes.get("") ?? openLane(undefined);
      if (!lane.running) runLane(lane);
    },
    async drain(): Promise<void> {
      if (!lanes.has("")) openLane(undefined);
      const failures = await Promise.all([...lanes.values()].map(drainLane));
      deps.noteDeliveries(failures.find((f) => f !== undefined));
    },
    attach(user: string, res: ServerResponse): () => void {
      const tenant = portalIdentityTenant(deps.currentToken(), deps.identitySecret);
      const lane = lanes.get(tenant ?? "") ?? openLane(tenant);
      let set = lane.clients.get(user);
      if (!set) lane.clients.set(user, (set = new Set()));
      set.add(res);
      if (!lane.running && lane.tenant) runLane(lane);
      return () => {
        set.delete(res);
        if (!set.size) lane.clients.delete(user);
        if (!lane.tenant || lane.clients.size) return;
        lane.stop.abort();
        lanes.delete(tenant ?? "");
      };
    },
  };
}
