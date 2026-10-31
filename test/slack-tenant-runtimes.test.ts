import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { SlackCoreClient, SurfaceContextRequest } from "../src/api/slack-core-client.ts";
import type { SlackPluginConfig } from "../src/slack/config.ts";
import { createDeferredAckReceiver } from "../src/slack/deferred-ack.ts";
import type { SlackAccountRuntime } from "../src/slack/index.ts";
import { createSlackTenants, type SlackTenantConfig } from "../src/slack/tenant-runtimes.ts";
import type { DueEnvelope } from "../src/slack/slack-tables.ts";
import { boundTenant, currentTenant, withTenant } from "../src/tenants/context.ts";
import type { Delivery } from "../src/types.ts";
import type { App as BoltApp } from "@slack/bolt";
import type { SocketModeClient } from "@slack/socket-mode";

const A = randomUUID();
const B = randomUUID();
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function fakeCore(rows: Delivery[]) {
  const listeners = {
    delivery: [] as Array<() => void>,
    context: [] as Array<{ tenant: string | undefined; fn: (r: SurfaceContextRequest) => void }>,
    model: [] as Array<(scope: string) => void>,
    pin: [] as Array<(scope: string) => void>,
  };
  const acked: Array<[string, string | undefined]> = [];
  const claimedUnder: Array<string | undefined> = [];
  const core = {
    holdDeliveryDispatch: (fn: (lost: Promise<void>) => Promise<unknown>) => fn(new Promise<void>(() => {})),
    claimDeliveries: async (type: string) => {
      claimedUnder.push(boundTenant());
      return type === "slack" ? rows.splice(0) : [];
    },
    ackDelivery: async (id: string) => {
      acked.push([id, boundTenant()]);
    },
    onDeliveryEnqueued: (fn: () => void) => {
      listeners.delivery.push(fn);
      return () => {};
    },
    onContextRequest: (fn: (r: SurfaceContextRequest) => void) => {
      const listener = { tenant: boundTenant(), fn };
      listeners.context.push(listener);
      return () => void listeners.context.splice(listeners.context.indexOf(listener), 1);
    },
    onScopeModelChanged: (fn: (scope: string) => void) => void listeners.model.push(fn),
    onChannelHeaderPinChanged: (fn: (scope: string) => void) => void listeners.pin.push(fn),
  };
  return { core: core as unknown as SlackCoreClient, listeners, acked, claimedUnder };
}

function harness(rows: Delivery[] = []) {
  const { core, listeners, acked, claimedUnder } = fakeCore(rows);
  const versions = new Map<string, string | null>([
    [A, "a1"],
    [B, "b1"],
  ]);
  const calls: Array<[string, string, string | undefined]> = [];
  const posts: Array<[string, string | undefined]> = [];
  const started: Array<[string, string]> = [];
  const stopped: Array<[string, string]> = [];
  const due: DueEnvelope[] = [];
  const statuses: Array<{ tenant_id: string; account: string }> = [];
  const acks: Array<{ tenant_id: string }> = [];
  const account = (config: SlackPluginConfig): SlackAccountRuntime => {
    const tenant = currentTenant();
    const team = config.botToken;
    const record = (name: string): void => void calls.push([tenant, name, boundTenant()]);
    const client = {
      chat: {
        postMessage: async (args: { text: string }) => {
          posts.push([`${team}:${args.text}`, boundTenant()]);
          return { ok: true, ts: "9.9" };
        },
      },
    };
    started.push([tenant, team]);
    return {
      accountId: "default",
      coreSingleton: true,
      stagingAccount: "default",
      statusAccount: `${team}:UBOT`,
      delivery: {
        clientForAccount: () => client,
        flow: { inFlightRuns: new Set<string>() } as never,
        threads: { mark: () => {} },
        clientForIdentity: () => client,
      },
      staging: {} as never,
      receive: async () => record("receive"),
      replay: async (row: DueEnvelope) => record(`replay:${row.key}`),
      reconcileStatus: async () => record("status"),
      reconcileAcks: async () => record("acks"),
      refreshEmoji: () => record("emoji"),
      serviceContextRequest: (r: SurfaceContextRequest) => record(`context:${r.id}`),
      scopeModelChanged: (scope: string) => record(`model:${scope}`),
      channelHeaderPinChanged: (scope: string) => record(`pin:${scope}`),
      stop: async () => {
        stopped.push([tenant, team]);
      },
    } as unknown as SlackAccountRuntime;
  };
  const tenants = createSlackTenants({
    core,
    claims: {
      installedTenants: async () => [...versions].filter(([, v]) => v).map(([t]) => t),
      dueEnvelopes: async (accounts) => due.filter((d) => accounts.some((a) => a.tenantId === d.tenantId)),
      statusAccounts: async () => statuses,
      ackTenants: async () => acks,
    },
    load: async (): Promise<SlackTenantConfig | null> => {
      const version = versions.get(currentTenant());
      return version
        ? { version, accounts: [{ botToken: currentTenant() === A ? "TA" : "TB" } as SlackPluginConfig] }
        : null;
    },
    start: async (config) => account(config),
    intervalMs: 60_000,
    sweepMs: 0,
  });
  return { tenants, listeners, versions, calls, posts, started, stopped, due, statuses, acks, acked, claimedUnder };
}

test("each tenant's Slack is built once in its own tenant and rebuilt only when its installation changes", async () => {
  const h = harness();
  h.tenants.start();
  await h.tenants.reconcile();
  assert.deepEqual(
    h.started.sort(),
    [
      [A, "TA"],
      [B, "TB"],
    ].sort(),
  );
  await h.tenants.reconcile();
  assert.equal(h.started.length, 2, "an unchanged installation keeps its runtime");
  h.versions.set(A, "a2");
  h.versions.set(B, null);
  await h.tenants.reconcile();
  assert.deepEqual(
    h.stopped.sort(),
    [
      [A, "TA"],
      [B, "TB"],
    ].sort(),
  );
  assert.deepEqual(h.started.at(-1), [A, "TA"]);
  assert.deepEqual(await withTenant(B, () => h.tenants.accounts()), []);
  await h.tenants.stop();
  assert.equal(h.stopped.length, 3);
});

test("ingress and core notifications reach only the bound tenant's accounts", async () => {
  const h = harness();
  h.tenants.start();
  await h.tenants.reconcile();
  h.calls.length = 0;
  await withTenant(A, async () => {
    for (const { tenant, fn } of h.listeners.context) if (tenant === A) fn({ id: "ctx-a" } as SurfaceContextRequest);
    for (const fn of h.listeners.model) fn("channel:C1");
  });
  await withTenant(B, async () => {
    for (const fn of h.listeners.pin) fn("channel:C2");
    const [account] = await h.tenants.accounts();
    await account!.receive({} as never);
  });
  for (const fn of h.listeners.model) fn("channel:unbound");
  assert.deepEqual(h.calls, [
    [A, "context:ctx-a", A],
    [A, "model:channel:C1", A],
    [B, "pin:channel:C2", B],
    [B, "receive", B],
  ]);
  await h.tenants.stop();
});

test("claimed sweep rows run in their own tenant on the matching account", async () => {
  const h = harness();
  h.tenants.start();
  await h.tenants.reconcile();
  h.calls.length = 0;
  h.due.push(
    { tenantId: A, key: "ka", body: {}, account: "default", attempts: 1 },
    { tenantId: B, key: "kb", body: {}, account: "default", attempts: 1 },
    { tenantId: B, key: "orphan", body: {}, account: "retired", attempts: 1 },
  );
  h.statuses.push({ tenant_id: B, account: "TB:UBOT" }, { tenant_id: A, account: "TB:UBOT" });
  h.acks.push({ tenant_id: A });
  await h.tenants.reconcile();
  const sweepCalls = h.calls.filter(([, name]) => name !== "emoji");
  assert.deepEqual(
    sweepCalls.sort(),
    [
      [A, "acks", A],
      [A, "replay:ka", A],
      [B, "replay:kb", B],
      [B, "status", B],
    ].sort(),
  );
  await h.tenants.stop();
});

test("one drain claims deliveries across tenants and posts each with its own tenant's client", async () => {
  const delivery = (id: string, tenantId: string | undefined): Delivery =>
    ({
      id,
      ...(tenantId ? { tenantId } : {}),
      text: `hello ${id}`,
      destination: { type: "slack", target: "C1" },
      createdAt: Date.now(),
    }) as Delivery;
  const h = harness([
    delivery("d-a", A),
    delivery("d-b", B),
    delivery("d-x", randomUUID()),
    delivery("d-none", undefined),
  ]);
  h.tenants.start();
  await h.tenants.reconcile();
  for (let i = 0; i < 50 && h.acked.length < 2; i++) await tick(10);
  assert.deepEqual(
    h.posts.sort(),
    [
      ["TA:hello d-a", A],
      ["TB:hello d-b", B],
    ].sort(),
  );
  assert.deepEqual(
    h.acked.sort(),
    [
      ["d-a", A],
      ["d-b", B],
    ].sort(),
  );
  assert.ok(
    h.claimedUnder.every((t) => t === undefined),
    "the claim itself runs across tenants",
  );
  await h.tenants.stop();
});

test("a Socket Mode envelope from a workspace outside the tenant is acknowledged and never processed", async () => {
  const processed: Array<string | undefined> = [];
  const receiver = createDeferredAckReceiver({
    appToken: "xapp-test",
    tenantFor: async (body) => (body.team_id === "TA" ? A : null),
  }) as ReturnType<typeof createDeferredAckReceiver> & { client: SocketModeClient };
  receiver.init?.({
    processEvent: async (event: { ack(): Promise<void> }) => {
      processed.push(boundTenant());
      await event.ack();
    },
  } as unknown as BoltApp);
  let acks = 0;
  const emit = (team: string) =>
    new Promise<void>((resolve) => {
      receiver.client.emit("slack_event", {
        body: { type: "event_callback", team_id: team, event: { type: "reaction_added" } },
        ack: async () => {
          acks++;
          resolve();
        },
      });
    });
  await emit("TOTHER");
  assert.deepEqual(processed, []);
  await emit("TA");
  assert.deepEqual(processed, [A]);
  assert.equal(acks, 2);
});

test("a failed rebuild keeps the previous installation running and retries with backoff", async () => {
  const { core } = fakeCore([]);
  let version = "v1";
  let failing = false;
  let at = 0;
  const started: string[] = [];
  const stopped: string[] = [];
  const tenants = createSlackTenants({
    core,
    claims: {
      installedTenants: async () => [A],
      dueEnvelopes: async () => [],
      statusAccounts: async () => [],
      ackTenants: async () => [],
    },
    load: async () => ({ version, accounts: [{ botToken: version } as SlackPluginConfig] }),
    start: async (config) => {
      if (failing && config.botToken !== "v1") throw new Error("auth.test timed out");
      started.push(config.botToken);
      return {
        coreSingleton: true,
        stop: async () => void stopped.push(config.botToken),
      } as unknown as SlackAccountRuntime;
    },
    intervalMs: 60_000,
    sweepMs: 60_000,
    retryMs: 1_000,
    now: () => at,
  });
  tenants.start();
  await tenants.reconcile();
  version = "v2";
  failing = true;
  await tenants.reconcile();
  assert.deepEqual(started, ["v1", "v1"], "the previous installation is started again after the new one fails");
  assert.equal((await withTenant(A, () => tenants.accounts())).length, 1);
  at = 500;
  await tenants.reconcile();
  assert.deepEqual(started, ["v1", "v1"], "no retry inside the backoff window");
  failing = false;
  at = 1_500;
  await tenants.reconcile();
  assert.deepEqual(started, ["v1", "v1", "v2"]);
  assert.deepEqual(stopped, ["v1", "v1"]);
  await tenants.stop();
});
