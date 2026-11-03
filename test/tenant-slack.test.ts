import "./support/auto-fake-sprites.ts";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import pg from "pg";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createManagedSlack } from "../src/surfaces/slack-managed.ts";
import { boundTenant } from "../src/tenants/context.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { hostRequest } from "./support/host-request.ts";
import { nonOwnerLogin } from "./support/non-owner.ts";
import { useOwnerDatabase } from "../src/tenants/owner-pool.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";
const a: string = randomUUID();
const b: string = randomUUID();
const install = (tenant: string) => ({
  botToken: "xoxb-test",
  appId: "A123",
  teamId: tenant === a ? "TAAA" : "TBBB",
  installId: `install-${tenant}`,
  installedAt: 1000,
});
let server: Server;
let base = "";
let owner: pg.Pool;
const seen: { tenant: string | undefined; type: unknown }[] = [];

before(async () => {
  if (skip) return;
  const databaseUrl = testMigratedDatabaseUrl();
  owner = new pg.Pool({ connectionString: databaseUrl });
  await owner.query("INSERT INTO tenants(id) VALUES ($1), ($2)", [a, b]);
  useOwnerDatabase(databaseUrl);
  const built = buildApp(
    testConfig({
      databaseUrl: await nonOwnerLogin(databaseUrl),
      dataDir: mkdtempSync(join(tmpdir(), "tenant-slack-")),
    }),
  );
  await built.tenancy.mapHost(a, "a.example.test");
  await built.tenancy.mapHost(b, "b.example.test");
  await built.tenancy.updateSettings(a, { slackBridgeToken: "bridge-token-for-tenant-a-0123456789" });
  await built.tenancy.updateSettings(b, { slackBridgeToken: "bridge-token-for-tenant-b-0123456789" });
  const managedSlack = createManagedSlack({
    serviceUrl: "https://slack.example.com",
    token: "bridge-token-from-environment-0123456789",
    store: built.slackInstallation,
  });
  for (const tenant of [a, b]) {
    const receiver = managedSlack.receiver(`install-${tenant}`);
    receiver.init?.({
      processEvent: async (incoming: ReceiverEvent) => {
        seen.push({ tenant: boundTenant(), type: incoming.body.type ?? incoming.body.command });
        await incoming.ack();
      },
    } as unknown as BoltApp);
    await receiver.start(0 as never);
  }
  server = createInsecureTestServer(built.app, { managedSlack, tenancy: built.tenancy });
  server.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await owner?.end();
});

function post(host: string, tenant: string, path: "installation" | "events", body: unknown) {
  return hostRequest(`${base}/v1/slack/managed/${path}`, host, {
    method: "POST",
    headers: {
      authorization: `Bearer bridge-token-for-tenant-${tenant === a ? "a" : "b"}-0123456789`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test(
  "the shared Slack forwarder's events, interactions and commands run under the tenant of the host they reach",
  { skip },
  async () => {
    for (const tenant of [a, b]) {
      const host = tenant === a ? "a.example.test" : "b.example.test";
      assert.equal((await post(host, tenant, "installation", install(tenant))).status, 200);
      const team = install(tenant).teamId;
      const envelopes = [
        {
          type: "event_callback",
          api_app_id: "A123",
          team_id: team,
          event_id: `Ev${team}`,
          event: { type: "app_mention" },
        },
        { type: "block_actions", api_app_id: "A123", team: { id: team }, actions: [] },
        { command: "/qm", api_app_id: "A123", team_id: team, text: "hello" },
      ];
      for (const body of envelopes)
        assert.equal((await post(host, tenant, "events", { installId: `install-${tenant}`, body })).status, 200);
    }
    assert.deepEqual(seen, [
      { tenant: a, type: "event_callback" },
      { tenant: a, type: "block_actions" },
      { tenant: a, type: "/qm" },
      { tenant: b, type: "event_callback" },
      { tenant: b, type: "block_actions" },
      { tenant: b, type: "/qm" },
    ]);
  },
);

test("one tenant's Slack bridge token is refused on another tenant's host and on unknown hosts", { skip }, async () => {
  const body = { installId: `install-${a}`, body: { type: "event_callback", api_app_id: "A123", team_id: "TAAA" } };
  const before = seen.length;
  assert.equal((await post("b.example.test", a, "events", body)).status, 401);
  assert.equal((await post("stranger.example.test", a, "events", body)).status, 421);
  assert.equal(seen.length, before);
});
