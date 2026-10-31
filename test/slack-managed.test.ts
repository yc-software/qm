import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { ReceiverEvent } from "@slack/bolt";
import type { SlackAccountRuntime } from "../src/slack/index.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createManagedSlack } from "../src/surfaces/slack-managed.ts";
import { bindTestTenant } from "./support/tenant.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { skipWithoutPg, withSlackDb, type SlackDb } from "./support/slack-db.ts";

bindTestTenant();

const skip = skipWithoutPg;
const installation = {
  botToken: "xoxb-test",
  appId: "A123",
  teamId: "T123",
  installId: "install-1",
  installedAt: 1000,
};
const event = {
  type: "event_callback",
  api_app_id: "A123",
  team_id: "T123",
  event_id: "Ev123",
  event: { type: "message", channel: "C123", user: "U123", ts: "1.0", text: "hello" },
};

type Db = SlackDb;

async function fixture(t: test.TestContext, db: Db, opts: { appId?: string } = {}) {
  const store = createSlackInstallationStore(db.store.installation, "test-encryption-key");
  const teams: Record<string, string> = { T123: db.tenant, T456: db.otherTenant };
  const received: Array<{ tenant: string | undefined; event: ReceiverEvent }> = [];
  const runtimes = new Map<string, SlackAccountRuntime[]>();
  let handler = async (incoming: ReceiverEvent) => {
    await incoming.ack({ text: "Accepted" });
  };
  const sent: Array<Record<string, unknown>> = [];
  const bridge = createManagedSlack({
    serviceUrl: "https://slack.example.com",
    token: "company-token",
    stateSecret: "state-secret",
    ...(opts.appId === "" ? {} : { appId: opts.appId ?? "A123" }),
    store,
    resolver: { forHost: async () => null, forSlackTeam: async (team) => teams[team] ?? null },
    runtimes: {
      current: () => runtimes.get(boundTenant()!) ?? [],
      accounts: async () => runtimes.get(boundTenant()!) ?? [],
      refresh: async () => {},
    },
    fetchImpl: (async (url: URL, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return url.pathname === "/install/start"
        ? Response.json({ url: "https://slack.example.com/install/launch?id=opaque" })
        : Response.json({ companyOwned: false, appReady: true, connected: false });
    }) as typeof fetch,
  });
  const runtime = (installId: string) =>
    ({
      installationId: installId,
      receive: async (incoming: ReceiverEvent) => {
        received.push({ tenant: boundTenant(), event: incoming });
        await handler(incoming);
      },
    }) as unknown as SlackAccountRuntime;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    await bridge.handle(req, res, JSON.parse(raw));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  const stateFor = async (tenant: string) => {
    await withTenant(tenant, () => bridge.start());
    return sent.at(-1)!.state as string;
  };
  return {
    store,
    bridge,
    received,
    stateFor,
    sent,
    ready: (tenant: string, installId: string) => runtimes.set(tenant, [runtime(installId)]),
    fail: () => {
      handler = async () => {
        throw new Error("database unavailable");
      };
    },
    inTenant: <T>(tenant: string, fn: () => Promise<T>) => withTenant(tenant, fn),
    request: (
      path: "installation" | "events",
      body: unknown,
      method: "POST" | "DELETE" = "POST",
      token = "company-token",
    ) =>
      fetch(`http://127.0.0.1:${address.port}/v1/slack/managed/${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

const withDb = (fn: (db: Db) => Promise<void>) => withSlackDb(fn);

test("installation needs a state this deployment signed and lands only in that tenant", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    const state = await f.stateFor(db.tenant);
    assert.equal((await f.request("installation", { ...installation, state }, "POST", "wrong")).status, 401);
    assert.equal((await f.request("installation", installation)).status, 403);
    assert.equal((await f.request("installation", { ...installation, state: `${state}x` })).status, 403);
    assert.equal((await f.request("installation", { ...installation, state })).status, 202);
    assert.equal((await f.inTenant(db.tenant, () => f.store.get()))?.teamId, "T123");
    assert.equal(await f.inTenant(db.otherTenant, () => f.store.get()), null);
    const otherState = await f.stateFor(db.otherTenant);
    assert.equal((await f.request("installation", { ...installation, state: otherState })).status, 409);
    assert.equal(await f.inTenant(db.otherTenant, () => f.store.get()), null);
    const rows = await db.admin.query(`SELECT tenant_id::text AS tenant, bot_token_enc FROM slack_installation`);
    assert.deepEqual(
      rows.rows.map((row) => row.tenant),
      [db.tenant],
    );
    assert.equal(JSON.stringify(rows.rows).includes("xoxb-test"), false);
  });
});

test("an expired installation state is refused", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    const state = await f.stateFor(db.tenant);
    const parts = state.split(".");
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString()) as { exp: number };
    assert.ok(claims.exp > Date.now());
    const expired = {
      ...installation,
      state: [parts[0], Buffer.from(JSON.stringify({ ...claims, exp: 1 })).toString("base64url"), parts[2]].join("."),
    };
    assert.equal((await f.request("installation", expired)).status, 403);
  });
});

test("events bind the tenant of their verified workspace and an unknown workspace is refused", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    assert.equal(
      (await f.request("installation", { ...installation, state: await f.stateFor(db.tenant) })).status,
      202,
    );
    const other = { ...installation, teamId: "T456", installId: "install-b" };
    assert.equal((await f.request("installation", { ...other, state: await f.stateFor(db.otherTenant) })).status, 202);
    const body = { installId: installation.installId, body: event, retryNum: 1, retryReason: "timeout" };
    assert.equal((await f.request("events", body)).status, 503);
    f.ready(db.tenant, installation.installId);
    f.ready(db.otherTenant, other.installId);
    assert.equal((await f.request("events", { ...body, body: { ...event, team_id: "TUNKNOWN" } })).status, 403);
    assert.equal((await f.request("events", { ...body, body: { ...event, team_id: undefined } })).status, 403);
    assert.equal((await f.request("events", { ...body, installId: other.installId })).status, 409);
    assert.equal((await f.request("events", { ...body, body: { ...event, api_app_id: "AOTHER" } })).status, 400);
    assert.equal(f.received.length, 0);
    assert.equal((await f.request("events", body)).status, 200);
    const button = {
      type: "block_actions",
      api_app_id: "A123",
      team: { id: "T456" },
      actions: [{ action_id: "approve" }],
    };
    const response = await f.request("events", { installId: other.installId, body: button });
    assert.deepEqual(await response.json(), { text: "Accepted" });
    assert.deepEqual(
      f.received.map((r) => [r.tenant, r.event.body.type]),
      [
        [db.tenant, "event_callback"],
        [db.otherTenant, "block_actions"],
      ],
    );
    assert.equal(f.received[0]?.event.retryNum, 1);
  });
});

test("uninstall needs the workspace and disables only that tenant's installation", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    await f.request("installation", { ...installation, state: await f.stateFor(db.tenant) });
    const other = { ...installation, teamId: "T456", installId: "install-b" };
    await f.request("installation", { ...other, state: await f.stateFor(db.otherTenant) });
    assert.equal((await f.request("installation", { installId: installation.installId }, "DELETE")).status, 400);
    assert.equal(
      (await f.request("installation", { installId: installation.installId, teamId: "TUNKNOWN" }, "DELETE")).status,
      403,
    );
    assert.equal(
      (await f.request("installation", { installId: installation.installId, teamId: "T456" }, "DELETE")).status,
      200,
    );
    assert.equal((await f.inTenant(db.otherTenant, () => f.store.get()))?.installId, "install-b");
    assert.equal(
      (await f.request("installation", { installId: installation.installId, teamId: "T123" }, "DELETE")).status,
      200,
    );
    assert.equal(await f.inTenant(db.tenant, () => f.store.get()), null);
    assert.equal((await f.inTenant(db.otherTenant, () => f.store.get()))?.installId, "install-b");
  });
});

test("managed generations cannot overwrite newer installs or revive removed credentials", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    const state = await f.stateFor(db.tenant);
    const install = (body: Record<string, unknown>) => f.request("installation", { ...body, state });
    const remove = (installId: string) => f.request("installation", { installId, teamId: "T123" }, "DELETE");
    await install(installation);
    const replacement = { ...installation, installId: "install-2", installedAt: 2000 };
    assert.equal((await install(replacement)).status, 202);
    assert.equal((await install(installation)).status, 409);
    await remove("install-1");
    assert.equal((await f.inTenant(db.tenant, () => f.store.get()))?.installId, "install-2");
    await remove("install-2");
    assert.equal(await f.inTenant(db.tenant, () => f.store.get()), null);
    assert.equal((await install(replacement)).status, 409);
    assert.equal((await install({ ...replacement, installId: "install-3", installedAt: 3000 })).status, 202);
    await f.inTenant(db.tenant, () => f.store.delete("admin"));
    assert.equal((await install({ ...replacement, installId: "install-3", installedAt: 3000 })).status, 409);
  });
});

test("own-app switch blocks stale managed callbacks until explicit restart", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    const state = await f.stateFor(db.tenant);
    await f.request("installation", { ...installation, state });
    await f.inTenant(db.tenant, () =>
      f.store.set({ botToken: "xoxb-own", appToken: "xapp-own", teamId: "T123", updatedBy: "admin" }),
    );
    const replacement = { ...installation, installId: "late", installedAt: Date.now() + 1000, state };
    assert.equal((await f.request("installation", replacement)).status, 409);
    assert.equal(await f.inTenant(db.tenant, () => f.store.enableManaged()), false);
    await f.request("installation", { installId: installation.installId, teamId: "T123" }, "DELETE");
    assert.equal((await f.inTenant(db.tenant, () => f.store.get()))?.botToken, "xoxb-own");
    assert.equal((await f.request("events", { installId: installation.installId, body: event })).status, 409);
    await f.inTenant(db.tenant, () => f.store.delete("admin"));
    assert.equal((await f.request("installation", replacement)).status, 409);
    assert.equal(await f.inTenant(db.tenant, () => f.store.enableManaged()), true);
    assert.equal((await f.request("installation", replacement)).status, 202);
  });
});

test("failed delivery withholds acknowledgment", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    await f.request("installation", { ...installation, state: await f.stateFor(db.tenant) });
    f.ready(db.tenant, installation.installId);
    f.fail();
    assert.equal((await f.request("events", { installId: installation.installId, body: event })).status, 503);
  });
});

test("service-assigned app identity is persisted and enforced on every delivery", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db, { appId: "" });
    const state = await f.stateFor(db.tenant);
    assert.equal((await f.request("installation", { ...installation, appId: "bad", state })).status, 400);
    assert.equal((await f.request("installation", { ...installation, state })).status, 202);
    assert.equal((await f.inTenant(db.tenant, () => f.store.get()))?.appId, installation.appId);
    f.ready(db.tenant, installation.installId);
    assert.equal((await f.request("events", { installId: installation.installId, body: event })).status, 200);
    assert.equal(
      (await f.request("events", { installId: installation.installId, body: { ...event, api_app_id: "AOTHER" } }))
        .status,
      400,
    );
  });
});

test("installation launch restricts redirect origin and hides service credentials", { skip }, async (t) => {
  await withDb(async (db) => {
    const f = await fixture(t, db);
    assert.deepEqual(await f.inTenant(db.tenant, () => f.bridge.start()), {
      url: "https://slack.example.com/install/launch?id=opaque",
    });
    const bad = createManagedSlack({
      serviceUrl: "https://slack.example.com",
      token: "company-token",
      stateSecret: "state-secret",
      appId: "A123",
      store: f.store,
      resolver: { forHost: async () => null, forSlackTeam: async () => null },
      runtimes: { current: () => [], accounts: async () => [], refresh: async () => {} },
      fetchImpl: (async () => Response.json({ url: "https://evil.example" })) as typeof fetch,
    });
    await assert.rejects(
      f.inTenant(db.tenant, () => bad.start()),
      /invalid URL/,
    );
  });
});

test("managed Slack refuses a service credential that a bearer header cannot carry or a missing state key", () => {
  const base = {
    serviceUrl: "https://slack.example.com",
    stateSecret: "state-secret",
    store: {} as never,
    resolver: { forHost: async () => null, forSlackTeam: async () => null },
    runtimes: { current: () => [], accounts: async () => [], refresh: async () => {} },
  };
  for (const token of ["", "company-token\n", " company-token"]) {
    assert.throws(() => createManagedSlack({ ...base, token }), /credential/);
  }
  assert.throws(() => createManagedSlack({ ...base, token: "company-token", stateSecret: "" }), /signing secret/);
});
