import type { ServerResponse } from "node:http";
import type { App } from "../app-types.ts";
import type { ServerDeps } from "../deps.ts";
import type { SessionStateEvent } from "../../runs/session-state-bus.ts";
import type { OwnedLedgerEvent } from "../../loops/ledger-events.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { reportFailure, swallow } from "../../util/errors.ts";
import { createSweeper } from "../../util/sweeper.ts";
import { canAdministerLoop } from "./loops.ts";
import type { ApiCtx, Route } from "./route.ts";
import { sendJson } from "../http.ts";

const POLL_MS = 2_500;
const GIVEUP_MS = 60_000;
const HEARTBEAT_MS = 15_000;

type HubApp = Pick<
  App,
  | "pendingDeliveries"
  | "ackDelivery"
  | "subscribeSessionStates"
  | "subscribeLedgerEvents"
  | "membershipControlsScope"
  | "managesScope"
  | "samePerson"
>;

export interface WebEvents {
  stream(user: string, res: ServerResponse): void;
  start(): void;
  stop(): Promise<void>;
}

function ownerOfWebThread(threadRef: string): string | null {
  if (!threadRef.startsWith("web:")) return null;
  const rest = threadRef.slice("web:".length);
  const i = rest.indexOf(":");
  return i > 0 ? rest.slice(0, i) : null;
}

export function createWebEvents(app: HubApp, deps: Pick<ServerDeps, "loops" | "identity">): WebEvents {
  const clients = new Map<string, Set<ServerResponse>>();
  const send = (user: string, event: string, data: unknown): void => {
    for (const res of clients.get(canonicalPerson(user)) ?? [])
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string): void => {
    for (const user of clients.keys()) send(user, event, {});
  };

  let draining = false;
  let failing = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    let failure: unknown;
    try {
      const now = Date.now();
      for (const d of await app.pendingDeliveries("web")) {
        const owner = canonicalPerson(ownerOfWebThread(d.destination.target) ?? "");
        if (clients.get(owner)?.size) send(owner, "delivery", { threadRef: d.destination.target });
        else if (now - d.createdAt < GIVEUP_MS) continue;
        await app
          .ackDelivery(d.id)
          .catch((e: unknown) => (failure ??= new Error(`ack delivery ${d.id}`, { cause: e })));
      }
    } catch (e) {
      failure = e;
    } finally {
      draining = false;
    }
    if (failure === undefined) {
      if (failing) console.log("[web] web delivery poll recovered");
      failing = false;
      return;
    }
    if (!failing) reportFailure("web: web delivery poll (further failures quiet until recovery)", failure);
    failing = true;
  };
  const sweeper = createSweeper(drain, POLL_MS, { label: "web deliveries" });

  const forwardSessionState = (event: SessionStateEvent): void => {
    if (typeof event.threadRef !== "string" || !event.threadRef) return;
    const { participants, ...visible } = event;
    const owner = ownerOfWebThread(event.threadRef);
    const targets = new Set((participants ?? []).map(canonicalPerson));
    if (targets.size === 0 && owner) targets.add(canonicalPerson(owner));
    for (const user of targets) send(user, "session_state", visible);
  };

  const viewersOf = async (loopId: string): Promise<string[] | null> => {
    const loop = await deps.loops?.store.get(loopId);
    if (!loop) return null;
    const identity = deps.identity;
    await identity?.refresh();
    const candidates = [...clients.keys()];
    const allowed = await Promise.all(
      candidates.map(
        async (id) => (!identity || identity.classify(id).type === "internal") && canAdministerLoop(app, loop, id),
      ),
    );
    return candidates.filter((_, i) => allowed[i]);
  };
  const forwardInboxItem = async (event: OwnedLedgerEvent): Promise<void> => {
    if (!event.loopId || !event.itemId || !clients.size) return;
    const viewers = await viewersOf(event.loopId).catch((e: unknown) => {
      swallow("web: inbox item viewers", e);
      return undefined;
    });
    if (viewers === undefined) return broadcast("inbox_resync");
    const frame = { loopId: event.loopId, itemId: event.itemId, op: event.op ?? "" };
    for (const user of viewers ?? []) send(user, "inbox_item", frame);
  };

  let unsubscribe: Array<() => void> = [];
  return {
    stream(user, res) {
      const key = canonicalPerson(user);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": open\n\n");
      const set = clients.get(key) ?? new Set();
      clients.set(key, set.add(res));
      const beat = setInterval(() => res.write(": ping\n\n"), HEARTBEAT_MS);
      beat.unref?.();
      res.on("close", () => {
        clearInterval(beat);
        set.delete(res);
        if (!set.size && clients.get(key) === set) clients.delete(key);
      });
    },
    start() {
      if (unsubscribe.length) return;
      unsubscribe = [
        app.subscribeSessionStates(forwardSessionState, { onResync: () => broadcast("session_state_resync") }),
        app.subscribeLedgerEvents((event) => void forwardInboxItem(event), {
          onResync: () => broadcast("inbox_resync"),
        }),
      ];
      sweeper.start();
    },
    async stop() {
      for (const off of unsubscribe) off();
      unsubscribe = [];
      await sweeper.stop();
    },
  };
}

function streamWebEvents(ctx: ApiCtx): void {
  if (!ctx.deps.web || !ctx.actor) return sendJson(ctx.res, 404, { error: "not_found" });
  ctx.deps.web.events.stream(ctx.actor.p, ctx.res);
}

export const webEventRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/events", browser: true, actor: "person", auth: "source", handle: streamWebEvents },
];
