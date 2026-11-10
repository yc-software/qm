import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import { managedSlackEvent, managedSlackRequest } from "../src/api/routes/admin/slack-installation.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createManagedSlack } from "../src/surfaces/slack-managed.ts";
import { bindBootTenant } from "../src/tenants/boot.ts";
import { onTenantLoad } from "../src/tenants/cache.ts";
import { inTenant } from "../src/tenants/claim.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { loadTenantSettings } from "../src/tenants/settings.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

const RELAY = "relay-token-for-the-shared-host";
const TEAMS = ["TRAA", "TRBB"] as const;
const event = (i: number) => ({
  type: "event_callback",
  api_app_id: "A123",
  team_id: TEAMS[i],
  event_id: `Ev${i}`,
  event: { type: "message", channel: "C1", user: "U1", ts: "1.0", text: "hello" },
});

describe("managed Slack relayed to a shared host without per-company credentials", () => {
  let db: TwoTenants;
  let stopLoad: () => void;
  let port = 0;
  const starts: unknown[] = [];
  const received: string[] = [];
  let store: ReturnType<typeof createSlackInstallationStore>;
  let slack: ReturnType<typeof createManagedSlack>;
  let close: () => Promise<void> = async () => {};

  before(async () => {
    await bindBootTenant(async () => undefined);
    db = await twoTenants();
    stopLoad = onTenantLoad(() => loadTenantSettings(db.app));
    const lookup = tenantLookup(db.app);
    store = createSlackInstallationStore(
      "org",
      createPostgresMapFactory(db.appDatabaseUrl).map("slack_installation"),
      "test-key",
    );
    slack = createManagedSlack({
      serviceUrl: "https://bridge.example",
      token: RELAY,
      appId: "A123",
      store: { ...store, enableManaged: async () => true },
      fetchImpl: (async (_url: URL, init: RequestInit) => {
        starts.push(JSON.parse(String(init.body)));
        return Response.json({ url: "https://bridge.example/install/launch?ticket=x" });
      }) as typeof fetch,
    });
    const deps = { managedSlack: slack, slackInstallation: store };
    const app = { tenantFor: lookup.tenantFor };
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const ctx = { req, res, deps, app, body: raw ? JSON.parse(raw) : {} } as unknown as ApiCtx;
      await (req.url === "/v1/slack/managed/events" ? managedSlackEvent : managedSlackRequest)(ctx);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address === "object");
    port = address.port;
    close = () => new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [i, tenant] of db.tenants.entries())
      await inTenant(tenant, async () => {
        const receiver = slack.receiver(`relay-${i}`);
        receiver.init?.({
          processEvent: async (incoming: ReceiverEvent) => {
            received.push(tenant);
            await incoming.ack();
          },
        } as unknown as BoltApp);
        await receiver.start(0 as never);
      });
  });

  after(async () => {
    await close();
    stopLoad?.();
    await db?.close();
  });

  const call = (path: string, body: unknown, method: "POST" | "DELETE" = "POST", token = RELAY) =>
    fetch(`http://127.0.0.1:${port}/v1/slack/managed/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const install = (i: number) => ({
    tenant: db.tenants[i],
    botToken: `xoxb-${i}`,
    appId: "A123",
    teamId: TEAMS[i],
    installId: `relay-${i}`,
    installedAt: 1000,
  });

  it("installs into the tenant the relay names and records the workspace there", async () => {
    assert.equal((await call("installation", install(0), "POST", "wrong-token")).status, 401);
    assert.equal((await call("installation", install(0))).status, 200);
    assert.equal((await call("installation", install(1))).status, 200);
    const lookup = tenantLookup(db.app);
    assert.equal(await lookup.tenantFor("slack_team", TEAMS[0]), db.tenants[0]);
    assert.equal(await lookup.tenantFor("slack_team", TEAMS[1]), db.tenants[1]);
    assert.equal(
      (await call("installation", { ...install(0), tenant: db.tenants[1], installId: "steal" })).status,
      409,
    );
  });

  it("routes relayed events by workspace without an installation id", async () => {
    assert.equal((await call("events", { teamId: TEAMS[0], body: event(0) })).status, 200);
    assert.equal((await call("events", { teamId: TEAMS[1], body: event(1) })).status, 200);
    assert.deepEqual(received, [db.tenants[0], db.tenants[1]]);
    assert.equal((await call("events", { teamId: TEAMS[0], body: event(1) })).status, 400);
    assert.equal((await call("events", { teamId: "TNONE", body: { ...event(0), team_id: "TNONE" } })).status, 401);
    assert.equal(received.length, 2);
  });

  it("removes a relayed installation only for uninstalls newer than it", async () => {
    assert.equal((await call("installation", { teamId: TEAMS[0], eventTime: 0.5 }, "DELETE")).status, 200);
    assert.equal((await inTenant(db.tenants[0], () => store.get()))?.installId, "relay-0");
    assert.equal((await call("installation", { teamId: TEAMS[0], eventTime: 5 }, "DELETE")).status, 200);
    assert.equal((await inTenant(db.tenants[0], () => store.get()))?.installId, undefined);
    assert.equal((await inTenant(db.tenants[1], () => store.get()))?.installId, "relay-1");
  });

  it("tells the relay which tenant and page origin started an install", async () => {
    await inTenant(db.tenants[1], () => slack.start("install", "https://one.example"));
    assert.deepEqual(starts, [{ step: "install", tenant: db.tenants[1], origin: "https://one.example" }]);
  });
});
