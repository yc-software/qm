import type { ServerResponse } from "node:http";
import type { App } from "../app-types.ts";
import type { ServerDeps } from "../deps.ts";
import type { SessionStateEvent } from "../../runs/session-state-bus.ts";
import type { OwnedLedgerEvent } from "../../loops/ledger-events.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { reportFailure, swallowAs } from "../../util/errors.ts";
import { createSweeper } from "../../util/sweeper.ts";
import { canAdministerLoop } from "../loop-administration.ts";
import type { ApiCtx, Route } from "./route.ts";
import { sendJson } from "../http.ts";
import { bootTenant, tenancyBooted } from "../../tenants/boot.ts";
import { boundTenant, type Tenant } from "../../tenants/context.ts";
import { claimThenBind } from "../../tenants/claim.ts";
import type { DeliveryStore } from "../../delivery/delivery-store.ts";

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
  stream(user: string, res: ServerResponse, tenant: Tenant | undefined): void;
  start(): void;
  stop(): Promise<void>;
}

function ownerOfWebThread(threadRef: string): string | null {
  if (!threadRef.startsWith("web:")) return null;
  const rest = threadRef.slice("web:".length);
  const i = rest.indexOf(":");
  return i > 0 ? rest.slice(0, i) : null;
}

const laneOf = (tenant: string | undefined): string => tenant ?? bootTenant() ?? "";

export function createWebEvents(
  app: HubApp,
  deps: Pick<ServerDeps, "loops" | "identity"> & { deliveries?: Pick<DeliveryStore, "undeliveredTenants"> },
): WebEvents {
  const lanes = new Map<string, Map<string, Set<ServerResponse>>>();
  const clientsOf = (tenant: string | undefined) => lanes.get(laneOf(tenant)) ?? new Map<string, Set<ServerResponse>>();
  const send = (tenant: string | undefined, user: string, event: string, data: unknown): void => {
    for (const res of clientsOf(tenant).get(canonicalPerson(user)) ?? [])
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const broadcast = (event: string): void => {
    for (const [lane, clients] of lanes) for (const user of clients.keys()) send(lane, user, event, {});
  };

  let draining = false;
  let failing = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    let failure: unknown;
    try {
      const now = Date.now();
      const drainLane = async (_id?: string, bound?: Tenant): Promise<void> => {
        const tenant = bound?.id;
        for (const d of await app.pendingDeliveries("web")) {
          const owner = canonicalPerson(ownerOfWebThread(d.destination.target) ?? "");
          if (clientsOf(tenant).get(owner)?.size) send(tenant, owner, "delivery", { threadRef: d.destination.target });
          else if (now - d.createdAt < GIVEUP_MS) continue;
          await app
            .ackDelivery(d.id)
            .catch((e: unknown) => (failure ??= new Error(`ack delivery ${d.id}`, { cause: e })));
        }
      };
      const deliveries = deps.deliveries;
      if (tenancyBooted() && deliveries) await claimThenBind(() => deliveries.undeliveredTenants("web"), drainLane);
      else await drainLane();
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
    const tenant = boundTenant();
    const owner = ownerOfWebThread(event.threadRef);
    const targets = new Set((participants ?? []).map(canonicalPerson));
    if (targets.size === 0 && owner) targets.add(canonicalPerson(owner));
    for (const user of targets) send(tenant, user, "session_state", visible);
  };

  const viewersOf = async (loopId: string, tenant: string | undefined): Promise<string[] | null> => {
    const loop = await deps.loops?.store.get(loopId);
    if (!loop) return null;
    const identity = deps.identity;
    await identity?.refresh();
    const candidates = [...clientsOf(tenant).keys()];
    const allowed = await Promise.all(
      candidates.map(
        async (id) =>
          (!identity || identity.classify(id).type === "internal") && canAdministerLoop(app, loop, { actorId: id }),
      ),
    );
    return candidates.filter((_, i) => allowed[i]);
  };
  const forwardInboxItem = async (event: OwnedLedgerEvent): Promise<void> => {
    const tenant = boundTenant();
    if (!event.loopId || !event.itemId || !clientsOf(tenant).size) return;
    if (tenancyBooted() && !tenant) return;
    const viewers = await viewersOf(event.loopId, tenant).catch(swallowAs("web: inbox item viewers", undefined));
    if (viewers === undefined) {
      for (const user of clientsOf(tenant).keys()) send(tenant, user, "inbox_resync", {});
      return;
    }
    const frame = { loopId: event.loopId, itemId: event.itemId, op: event.op ?? "" };
    for (const user of viewers ?? []) send(tenant, user, "inbox_item", frame);
  };

  let unsubscribe: Array<() => void> = [];
  return {
    stream(user, res, tenant) {
      const key = canonicalPerson(user);
      const lane = laneOf(tenant?.id);
      const clients = lanes.get(lane) ?? new Map<string, Set<ServerResponse>>();
      lanes.set(lane, clients);
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
        if (!clients.size && lanes.get(lane) === clients) lanes.delete(lane);
      });
    },
    start() {
      if (unsubscribe.length) return;
      unsubscribe = [
        app.subscribeSessionStates(forwardSessionState, { onResync: () => broadcast("session_state_resync") }),
        app.subscribeLedgerEvents(forwardInboxItem, { onResync: () => broadcast("inbox_resync") }),
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
  ctx.deps.web.events.stream(ctx.actor.p, ctx.res, ctx.tenant);
}

export const webEventRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/web/events", browser: true, actor: "person", auth: "source", handle: streamWebEvents },
];
