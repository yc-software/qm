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

const TOKENS = ["bridge-token-company-a", "bridge-token-company-b"] as const;
const TEAMS = ["TAAA", "TBBB"] as const;
const install = (i: number) => ({
  botToken: `xoxb-${i}`,
  appId: "A123",
  teamId: TEAMS[i],
  installId: `install-${i}`,
  installedAt: 1000,
});
const event = (i: number) => ({
  type: "event_callback",
  api_app_id: "A123",
  team_id: TEAMS[i],
  event_id: `Ev${i}`,
  event: { type: "message", channel: "C1", user: "U1", ts: "1.0", text: "hello" },
});

describe("managed Slack on a shared host", () => {
  let db: TwoTenants;
  let stopLoad: () => void;
  let port = 0;
  const calls: { path: string; authorization: string | null }[] = [];
  const received: { tenant: string; event: ReceiverEvent }[] = [];
  let slack: ReturnType<typeof createManagedSlack>;
  let close: () => Promise<void> = async () => {};

  before(async () => {
    await bindBootTenant(async () => undefined);
    db = await twoTenants();
    stopLoad = onTenantLoad(() => loadTenantSettings(db.app));
    for (const [i, tenant] of db.tenants.entries())
      await db.owner.q("UPDATE tenants SET settings = $2 WHERE id = $1", [
        tenant,
        JSON.stringify({ slackBridgeToken: TOKENS[i] }),
      ]);
    const lookup = tenantLookup(db.app);
    const store = createSlackInstallationStore(
      "org",
      createPostgresMapFactory(db.appDatabaseUrl).map("slack_installation"),
      "test-key",
    );
    slack = createManagedSlack({
      serviceUrl: "https://bridge.example",
      appId: "A123",
      store,
      fetchImpl: (async (url: URL, init: RequestInit) => {
        calls.push({ path: url.pathname, authorization: new Headers(init.headers).get("authorization") });
        return Response.json({ companyOwned: false, appReady: true, connected: true });
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
  });

  after(async () => {
    await close();
    stopLoad?.();
    await db?.close();
  });

  const post = (path: string, token: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/v1/slack/managed/${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("binds each installation handoff to the tenant named by its own bridge token", async () => {
    assert.equal((await post("installation", "unknown-bridge-token", install(0))).status, 401);
    assert.equal((await post("installation", TOKENS[0], install(0))).status, 202);
    assert.equal((await post("installation", TOKENS[1], install(1))).status, 202);
    const lookup = tenantLookup(db.app);
    assert.equal(await lookup.tenantFor("slack_team", TEAMS[0]), db.tenants[0]);
    assert.equal(await lookup.tenantFor("slack_team", TEAMS[1]), db.tenants[1]);
  });

  it("refuses to let one tenant's token claim another tenant's workspace", async () => {
    const stolen = { ...install(0), installId: "steal", installedAt: 2000 };
    assert.equal((await post("installation", TOKENS[1], stolen)).status, 409);
    assert.equal(await tenantLookup(db.app).tenantFor("slack_team", TEAMS[0]), db.tenants[0]);
  });

  it("delivers each tenant's events only to that tenant's own listener", async () => {
    for (const [i, tenant] of db.tenants.entries())
      await inTenant(tenant, async () => {
        const receiver = slack.receiver(`install-${i}`);
        receiver.init?.({
          processEvent: async (incoming: ReceiverEvent) => {
            received.push({ tenant, event: incoming });
            await incoming.ack();
          },
        } as unknown as BoltApp);
        await receiver.start(0 as never);
      });
    assert.equal((await post("events", TOKENS[0], { installId: "install-0", body: event(0) })).status, 200);
    assert.equal((await post("events", TOKENS[1], { installId: "install-1", body: event(1) })).status, 200);
    assert.deepEqual(
      received.map((r) => r.tenant),
      [db.tenants[0], db.tenants[1]],
    );
    assert.equal((await post("events", TOKENS[1], { installId: "install-0", body: event(0) })).status, 409);
    assert.equal((await post("events", TOKENS[0], { installId: "install-1", body: event(1) })).status, 409);
    assert.equal(
      (await post("events", "unknown-bridge-token", { installId: "install-0", body: event(0) })).status,
      401,
    );
    assert.equal(received.length, 2);
  });

  it("calls the Slack service with the bound tenant's own bridge token", async () => {
    for (const tenant of db.tenants) await inTenant(tenant, () => slack.setupStatus());
    assert.deepEqual(
      calls.map((c) => c.authorization),
      TOKENS.map((t) => `Bearer ${t}`),
    );
  });
});
