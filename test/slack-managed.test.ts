import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createManagedSlack } from "../src/surfaces/slack-managed.ts";

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

async function fixture(t: test.TestContext, appId = "A123") {
  const map = createMemoryMap();
  const store = createSlackInstallationStore(
    "company",
    map as Parameters<typeof createSlackInstallationStore>[1],
    "test-encryption-key",
  );
  const bridge = createManagedSlack({
    serviceUrl: "https://slack.example.com",
    token: "company-token",
    appId: appId || undefined,
    store,
  });
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += String(chunk);
    await bridge.handle(req, res, JSON.parse(raw));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    map,
    store,
    bridge,
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

test("managed installation encrypts bot-only credentials and waits for its receiver", async (t) => {
  const { request, map, store, bridge } = await fixture(t);
  assert.equal((await request("installation", installation, "POST", "wrong-company")).status, 401);
  assert.equal(await store.get(), null);
  assert.equal((await request("installation", installation)).status, 202);
  assert.equal((await store.get())?.appToken, undefined);
  assert.equal(JSON.stringify(await map.all()).includes("xoxb-test"), false);
  const receiver = bridge.receiver(installation.installId);
  receiver.init?.({ processEvent: async () => {} } as unknown as BoltApp);
  await receiver.start(0 as never);
  assert.equal((await request("installation", installation)).status, 200);
  await receiver.stop(0 as never);
  assert.equal((await request("installation", installation)).status, 202);
});

test("managed generations cannot overwrite newer installs or revive removed credentials", async (t) => {
  const { request, store } = await fixture(t);
  await request("installation", installation);
  const replacement = { ...installation, installId: "install-2", installedAt: 2000 };
  assert.equal((await request("installation", replacement)).status, 202);
  assert.equal((await request("installation", installation)).status, 409);
  await request("installation", { installId: "install-1" }, "DELETE");
  assert.equal((await store.get())?.installId, "install-2");
  assert.equal(
    (await request("installation", { ...replacement, installId: "install-3", installedAt: 3000, teamId: "TOTHER" }))
      .status,
    409,
  );
  await request("installation", { installId: "install-2" }, "DELETE");
  assert.equal(await store.get(), null);
  assert.equal((await request("installation", replacement)).status, 409);
  assert.equal(
    (await request("installation", { ...replacement, installId: "install-3", installedAt: 3000 })).status,
    202,
  );
  await store.delete("admin");
  assert.equal(
    (await request("installation", { ...replacement, installId: "install-3", installedAt: 3000 })).status,
    409,
  );
});

test("managed delivery isolates workspace, app, generation, and credentials and preserves button responses", async (t) => {
  const { request, bridge } = await fixture(t);
  await request("installation", installation);
  const body = { installId: installation.installId, body: event, retryNum: 1, retryReason: "timeout" };
  assert.equal((await request("events", body)).status, 503);
  const received: ReceiverEvent[] = [];
  const receiver = bridge.receiver(installation.installId);
  receiver.init?.({
    processEvent: async (incoming: ReceiverEvent) => {
      received.push(incoming);
      await incoming.ack({ text: "Accepted" });
    },
  } as unknown as BoltApp);
  await receiver.start(0 as never);
  assert.equal((await request("events", body, "POST", "wrong-company")).status, 401);
  assert.equal((await request("events", { ...body, installId: "old" })).status, 409);
  assert.equal((await request("events", { ...body, body: { ...event, team_id: "TOTHER" } })).status, 400);
  assert.equal((await request("events", { ...body, body: { ...event, api_app_id: "AOTHER" } })).status, 400);
  assert.equal(received.length, 0);
  assert.equal((await request("events", body)).status, 200);
  assert.equal(received[0]?.retryNum, 1);
  const button = {
    type: "block_actions",
    api_app_id: "A123",
    team: { id: "T123" },
    actions: [{ action_id: "approve" }],
  };
  const response = await request("events", { installId: installation.installId, body: button });
  assert.deepEqual(await response.json(), { text: "Accepted" });
  await request("installation", { installId: installation.installId }, "DELETE");
  assert.equal((await request("events", body)).status, 409);
});

test("failed delivery withholds acknowledgment", async (t) => {
  const { request, bridge } = await fixture(t);
  await request("installation", installation);
  const receiver = bridge.receiver(installation.installId);
  receiver.init?.({
    processEvent: async () => {
      throw new Error("database unavailable");
    },
  } as unknown as BoltApp);
  await receiver.start(0 as never);
  assert.equal((await request("events", { installId: installation.installId, body: event })).status, 503);
});

test("installation launch restricts redirect origin and hides service credentials", async () => {
  const store = createSlackInstallationStore("company", createMemoryMap(), "test-key");
  const bridge = createManagedSlack({
    serviceUrl: "https://slack.example.com",
    token: "company-token",
    appId: "A123",
    store,
    fetchImpl: (async (_url: unknown, init?: RequestInit) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer company-token");
      return Response.json({ url: "https://slack.example.com/install/launch?id=opaque" });
    }) as typeof fetch,
  });
  assert.deepEqual(await bridge.start(), { url: "https://slack.example.com/install/launch?id=opaque" });
  const bad = createManagedSlack({
    serviceUrl: "https://slack.example.com",
    token: "company-token",
    appId: "A123",
    store,
    fetchImpl: (async () => Response.json({ url: "https://evil.example" })) as typeof fetch,
  });
  await assert.rejects(bad.start(), /invalid URL/);
});

test("own-app switch blocks stale managed callbacks until explicit restart", async (t) => {
  const { request, store } = await fixture(t);
  await request("installation", installation);
  await store.set({ botToken: "xoxb-own", appToken: "xapp-own", teamId: "T123", updatedBy: "admin" });
  const replacement = { ...installation, installId: "late", installedAt: Date.now() + 1000 };
  assert.equal((await request("installation", replacement)).status, 409);
  assert.equal(await store.enableManaged(), false);
  await request("installation", { installId: installation.installId }, "DELETE");
  assert.equal((await store.get())?.botToken, "xoxb-own");
  assert.equal((await request("events", { installId: installation.installId, body: event })).status, 409);
  await store.delete("admin");
  assert.equal((await request("installation", replacement)).status, 409);
  assert.equal(await store.enableManaged(), true);
  assert.equal((await request("installation", replacement)).status, 202);
});

test("own-app replacement preserves the managed generation watermark across restart", async (t) => {
  const { request, store } = await fixture(t);
  const old = { ...installation, teamId: "TOLD", installedAt: 1000 };
  assert.equal((await request("installation", old)).status, 202);
  await store.set({ botToken: "xoxb-own", appToken: "xapp-own", teamId: "TNEW", updatedBy: "admin" });
  assert.equal((await store.get())?.installedAt, 1000);
  await store.delete("admin");
  assert.equal(await store.enableManaged(), true);
  assert.equal((await request("installation", old)).status, 409);
  const fresh = { ...installation, installId: "fresh", teamId: "TNEW", installedAt: 2000 };
  assert.equal((await request("installation", fresh)).status, 202);
  assert.equal((await store.get())?.teamId, "TNEW");
});

test("service-assigned app identity is persisted and enforced on every delivery", async (t) => {
  const { request, store, bridge } = await fixture(t, "");
  assert.equal((await request("installation", { ...installation, appId: "bad" })).status, 400);
  assert.equal((await request("installation", installation, "POST", "other-company")).status, 401);
  assert.equal(await store.get(), null);
  assert.equal((await request("installation", installation)).status, 202);
  assert.equal((await store.get())?.appId, installation.appId);
  const receiver = bridge.receiver(installation.installId);
  receiver.init?.({
    processEvent: async (incoming: ReceiverEvent) => {
      await incoming.ack();
    },
  } as unknown as BoltApp);
  await receiver.start(0 as never);
  assert.equal((await request("events", { installId: installation.installId, body: event })).status, 200);
  assert.equal(
    (await request("events", { installId: installation.installId, body: { ...event, api_app_id: "AOTHER" } })).status,
    400,
  );
});

test("explicit app pin still rejects another app at installation", async (t) => {
  const { request, store } = await fixture(t);
  assert.equal((await request("installation", { ...installation, appId: "AOTHER" })).status, 400);
  assert.equal(await store.get(), null);
});
