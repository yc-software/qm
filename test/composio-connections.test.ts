import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap, createPostgresMapFactory, type DurableMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryAdvisoryLock,
  createPostgresAdvisoryLock,
  type AdvisoryLock,
} from "../src/persistence/advisory-lock.ts";
import { createComposioConnections, type ComposioConnectionRecord } from "../src/connectors/composio-connections.ts";
import type { ComposioClient, ComposioProxyRequest } from "../src/connectors/composio-client.ts";

const actor = { tenantId: "tenant-a", principalId: "person@example.com", scopeId: "personal:person@example.com" };
const toolkit = {
  slug: "googlecalendar",
  name: "Calendar",
  description: "Calendar",
  enabled: true,
  managedAuthSchemes: ["OAUTH2"],
  authSchemes: ["OAUTH2"],
  noAuth: false,
  native: true,
  baseUrl: "https://www.googleapis.com/calendar/v3",
};
const input: ComposioProxyRequest = {
  url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  method: "GET",
};

function fixture(backing?: { records: DurableMap<ComposioConnectionRecord>; lock: AdvisoryLock }) {
  const records = backing?.records ?? createMemoryMap<ComposioConnectionRecord>();
  const lock = backing?.lock ?? createMemoryAdvisoryLock();
  const users = new Map<string, string>();
  const sessions = new Map<string, string>();
  const calls: string[] = [];
  let time = 1000;
  let nextAccount = 0;
  const client: ComposioClient = {
    configured: async () => true,
    listToolkits: async () => ({ items: [toolkit] }),
    toolkit: async () => toolkit,
    createSession: async (userId) => {
      const id = `ts_${sessions.size}`;
      sessions.set(id, userId);
      calls.push("session");
      return id;
    },
    authorizeSession: async (sessionId) => {
      const id = `ca_${nextAccount++}`;
      users.set(id, sessions.get(sessionId)!);
      calls.push("link");
      return { connectedAccountId: id, redirectUrl: "https://connect.composio.dev/link" };
    },
    completeAuth: async (sessionUri, userId) => {
      calls.push("complete");
      assert.equal(users.get(sessionUri), userId);
      return { connectedAccountId: sessionUri, toolkit: toolkit.slug };
    },
    getAccount: async (id) => {
      calls.push("account");
      return {
        id,
        userId: users.get(id),
        toolkit: toolkit.slug,
        authConfigId: "ac_1",
        status: "ACTIVE",
        private: true,
        disabled: false,
      };
    },
    deleteAccount: async () => {
      calls.push("delete");
    },
    proxy: async () => {
      calls.push("proxy");
      return { status: 200, data: { ok: true }, headers: {} };
    },
  };
  const options = {
    client,
    records,
    lock,
    now: () => time,
    authorizeRequest: async (_actor: typeof actor, _connection: unknown, _request: ComposioProxyRequest) => {
      calls.push("authorize");
    },
    audit: async () => {
      calls.push("audit");
    },
  };
  const service = createComposioConnections(options);
  async function active() {
    const start = await service.start(actor, toolkit.slug);
    const record = (await records.get(start.id))!;
    await service.complete(actor, start.id, record.accountId!);
    calls.length = 0;
    return record;
  }
  return {
    service,
    options,
    client,
    records,
    calls,
    users,
    active,
    setTime: (value: number) => {
      time = value;
    },
  };
}

test("Composio starts private durable connections without exposing vendor identifiers", async () => {
  const f = fixture();
  const start = await f.service.start(actor, toolkit.slug);
  assert.deepEqual(Object.keys(start).sort(), ["connectUrl", "expiresAt", "id", "state", "toolkit"]);
  const stored = (await f.records.get(start.id))!;
  assert.equal(stored.state, "pending");
  assert.equal(stored.accountId, "ca_0");
  assert.ok(stored.sessionId);
  assert.equal(stored.userId.includes(actor.principalId), false);
  assert.equal(stored.apiBaseUrl, toolkit.baseUrl);
});

test("the same person in separate tenants gets separate vendor identities", async () => {
  const f = fixture();
  const a = await f.service.start(actor, toolkit.slug);
  const b = await f.service.start({ ...actor, tenantId: "tenant-b" }, toolkit.slug);
  assert.notEqual((await f.records.get(a.id))?.userId, (await f.records.get(b.id))?.userId);
});

test("wrong tenant or actor cannot inspect, complete, execute or revoke a connection", async () => {
  const f = fixture();
  const record = await f.active();
  for (const wrong of [
    { ...actor, tenantId: "tenant-b" },
    { ...actor, principalId: "other@example.com" },
  ]) {
    await assert.rejects(f.service.status(wrong, record.id), /not found/);
    await assert.rejects(f.service.complete(wrong, record.id, "ca_0"), /not found/);
    await assert.rejects(f.service.request(wrong, record.id, input), /not found/);
    await assert.rejects(f.service.disconnect(wrong, record.id), /not found/);
  }
  assert.deepEqual(f.calls, []);
});

test("wrong callback actor does not consume the intended actor's pending flow", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  f.calls.length = 0;
  await assert.rejects(f.service.complete({ ...actor, principalId: "wrong" }, started.id, "ca_0"));
  assert.deepEqual(f.calls, []);
  assert.equal((await f.records.get(started.id))?.state, "pending");
  assert.equal((await f.service.complete(actor, started.id, "ca_0")).state, "active");
});

test("an ACTIVE vendor account is not usable without verified completion", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  f.calls.length = 0;
  assert.equal((await f.service.status(actor, started.id)).state, "pending");
  await assert.rejects(f.service.request(actor, started.id, input), /not active/);
  assert.deepEqual(f.calls, []);
});

test("completion checks both toolkit and exact account, rejecting substitution", async () => {
  for (const result of [
    { connectedAccountId: "ca_other", toolkit: toolkit.slug },
    { connectedAccountId: "ca_0", toolkit: "gmail" },
  ]) {
    const f = fixture();
    const started = await f.service.start(actor, toolkit.slug);
    f.client.completeAuth = async () => result;
    await assert.rejects(f.service.complete(actor, started.id, "opaque"), /Could not verify/);
    assert.equal((await f.records.get(started.id))?.state, "failed");
    assert.equal(f.calls.includes("proxy"), false);
  }
});

test("expired and replayed callbacks cannot activate connections", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  f.setTime(started.expiresAt);
  f.calls.length = 0;
  await assert.rejects(f.service.complete(actor, started.id, "ca_0"), /expired/);
  assert.deepEqual(f.calls, []);
  f.setTime(1000);
  await f.service.complete(actor, started.id, "ca_0");
  f.calls.length = 0;
  await assert.rejects(f.service.complete(actor, started.id, "ca_0"), /not pending/);
  assert.deepEqual(f.calls, []);
});

test("concurrent completion across service instances redeems the vendor session only once", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  const other = createComposioConnections(f.options);
  const results = await Promise.allSettled([
    f.service.complete(actor, started.id, "ca_0"),
    other.complete(actor, started.id, "ca_0"),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter((call) => call === "complete").length, 1);
});

test("ambiguous completion failure is durable and never retried automatically", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  let attempts = 0;
  f.client.completeAuth = async () => {
    attempts++;
    throw new Error("uncertain exchange");
  };
  await assert.rejects(f.service.complete(actor, started.id, "ca_0"));
  const restarted = createComposioConnections(f.options);
  await assert.rejects(restarted.complete(actor, started.id, "ca_0"));
  assert.equal(attempts, 1);
  assert.equal((await f.records.get(started.id))?.state, "failed");
});

test("a service restart preserves active account binding", async () => {
  const f = fixture();
  const record = await f.active();
  const restarted = createComposioConnections(f.options);
  assert.deepEqual(await restarted.request(actor, record.id, input), { status: 200, data: { ok: true }, headers: {} });
});

test("request policy sees the final provider URL and body before any provider call", async () => {
  const f = fixture();
  const record = await f.active();
  f.options.authorizeRequest = async (seenActor, connection, request) => {
    assert.deepEqual(seenActor, actor);
    assert.deepEqual(connection, { id: record.id, toolkit: toolkit.slug, state: "active" });
    assert.equal(request.url, input.url + "?sendUpdates=all");
    assert.deepEqual(request.body, { summary: "Meeting" });
    throw new Error("approval required");
  };
  await assert.rejects(
    f.service.request(actor, record.id, {
      ...input,
      method: "POST",
      query: { sendUpdates: "all" },
      body: { summary: "Meeting" },
    }),
    /approval required/,
  );
  assert.deepEqual(f.calls, []);
});

test("policy mutations cannot change the operation sent to the provider", async () => {
  const f = fixture();
  const record = await f.active();
  f.options.authorizeRequest = async (_actor, _connection, request) => {
    request.method = "DELETE";
  };
  f.client.proxy = async (_id, request) => {
    assert.equal(request.method, "GET");
    return { status: 200, data: null, headers: {} };
  };
  await f.service.request(actor, record.id, input);
});

test("HTTP proxy rejects cross-integration targets, auth headers and authority escapes", async () => {
  const f = fixture();
  const record = await f.active();
  for (const url of [
    "https://www.googleapis.com/drive/v3/files",
    "https://www.googleapis.com.evil.example/calendar/v3/events",
    "http://www.googleapis.com/calendar/v3/events",
    "https://user:pass@www.googleapis.com/calendar/v3/events",
    "https://www.googleapis.com:444/calendar/v3/events",
    "https://www.googleapis.com/calendar/v3/%2e%2e/drive",
    "https://www.googleapis.com/calendar/v3/events#fragment",
    "https://www.googleapis.com/calendar/v3/foo\\bar",
  ]) {
    await assert.rejects(f.service.request(actor, record.id, { ...input, url }));
  }
  for (const name of ["Authorization", "Cookie", "Host", "X-HTTP-Method-Override"]) {
    await assert.rejects(f.service.request(actor, record.id, { ...input, headers: { [name]: "value" } }));
  }
  assert.deepEqual(f.calls, []);
});

test("unknown and custom toolkit origins do not open an unrestricted HTTP proxy", async () => {
  for (const metadata of [
    { ...toolkit, baseUrl: undefined },
    { ...toolkit, native: false },
    { ...toolkit, baseUrl: "https://{domain}/api" },
  ]) {
    const f = fixture();
    f.client.toolkit = async () => metadata;
    const record = await f.active();
    await assert.rejects(f.service.request(actor, record.id, input), /verified HTTP target/);
    assert.deepEqual(f.calls, []);
  }
});

test("disconnect blocks locally even when provider cleanup fails", async () => {
  const f = fixture();
  const record = await f.active();
  f.client.deleteAccount = async () => {
    throw new Error("remote unavailable");
  };
  await assert.rejects(f.service.disconnect(actor, record.id));
  assert.equal((await f.records.get(record.id))?.state, "disconnected");
  f.calls.length = 0;
  await assert.rejects(f.service.request(actor, record.id, input), /not active/);
  assert.deepEqual(f.calls, []);
});

test("request rechecks remote private status and does not fallback to another account", async () => {
  for (const patch of [
    { private: false },
    { disabled: true },
    { userId: "another-user" },
    { toolkit: "gmail" },
    { authConfigId: "ac_changed" },
    { status: "EXPIRED" },
  ]) {
    const f = fixture();
    const record = await f.active();
    const original = f.client.getAccount;
    f.client.getAccount = async (id) => ({ ...(await original(id)), ...patch });
    await assert.rejects(f.service.request(actor, record.id, input));
    assert.equal(f.calls.includes("proxy"), false);
  }
});

test("audit failure before dispatch prevents the upstream operation", async () => {
  const f = fixture();
  const record = await f.active();
  f.options.audit = async () => {
    throw new Error("audit unavailable");
  };
  await assert.rejects(f.service.request(actor, record.id, input), /audit unavailable/);
  assert.equal(f.calls.includes("proxy"), false);
});

test("a verified redemption survives a transient metadata failure without reusing the OAuth URI", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  const original = f.client.getAccount;
  let reads = 0;
  f.client.getAccount = async (id) => {
    if (reads++ === 0) throw new Error("temporary failure");
    return original(id);
  };
  await assert.rejects(f.service.complete(actor, started.id, "ca_0"), /temporary failure/);
  assert.equal((await f.records.get(started.id))?.state, "redeemed");
  const restarted = createComposioConnections(f.options);
  assert.equal((await restarted.complete(actor, started.id, "do-not-redeem-this")).state, "active");
  assert.equal(f.calls.filter((call) => call === "complete").length, 1);
});

test("post-execution audit failure preserves a known successful write result", async () => {
  const f = fixture();
  const record = await f.active();
  let audits = 0;
  f.options.audit = async () => {
    if (++audits === 2) throw new Error("outcome sink failed");
  };
  const response = await f.service.request(actor, record.id, {
    ...input,
    method: "POST",
    body: { summary: "Meeting" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { ok: true });
  assert.ok("auditWarning" in response);
  assert.equal(f.calls.filter((call) => call === "proxy").length, 1);
});

test("disabled connections surface reconnect status but remain unusable", async () => {
  const f = fixture();
  const record = await f.active();
  const original = f.client.getAccount;
  f.client.getAccount = async (id) => ({ ...(await original(id)), disabled: true });
  const status = await f.service.status(actor, record.id);
  assert.equal("needsReconnect" in status && status.needsReconnect, true);
  await assert.rejects(f.service.request(actor, record.id, input), /reconnecting/);
});

test("interrupted verification becomes restart-required without replaying the vendor exchange", async () => {
  const f = fixture();
  const started = await f.service.start(actor, toolkit.slug);
  await f.records.merge(started.id, { state: "verifying", verificationExpiresAt: 2000 });
  f.setTime(2001);
  f.calls.length = 0;
  const restarted = createComposioConnections(f.options);
  const status = await restarted.status(actor, started.id);
  assert.equal(status.state, "failed");
  assert.ok("restartRequired" in status && status.restartRequired);
  await assert.rejects(restarted.complete(actor, started.id, "ca_0"), /not pending/);
  assert.deepEqual(f.calls, []);
});

test("disconnect waits for account creation and revokes the resulting account", async () => {
  const f = fixture();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const original = f.client.authorizeSession;
  f.client.authorizeSession = async (sessionId, slug) => {
    entered.resolve();
    await resume.promise;
    return original(sessionId, slug);
  };
  const starting = f.service.start(actor, toolkit.slug);
  await entered.promise;
  const record = (await f.records.all())[0]!;
  const disconnecting = f.service.disconnect(actor, record.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.calls.includes("delete"), false);
  resume.resolve();
  await starting;
  await disconnecting;
  assert.equal((await f.records.get(record.id))?.state, "disconnected");
  assert.ok(f.calls.indexOf("delete") > f.calls.indexOf("link"));
});

test("canceling a persisted attempt before start takes its lock prevents remote creation", async () => {
  const f = fixture();
  const persisted = Promise.withResolvers<string>();
  const resume = Promise.withResolvers<void>();
  const put = f.records.put;
  f.records.put = async (id, record) => {
    await put(id, record);
    persisted.resolve(id);
    await resume.promise;
  };
  const starting = f.service.start(actor, toolkit.slug);
  const connectionId = await persisted.promise;
  await f.service.disconnect(actor, connectionId);
  f.calls.length = 0;
  resume.resolve();
  await assert.rejects(starting, /canceled/);
  assert.equal((await f.records.get(connectionId))?.state, "disconnected");
  assert.deepEqual(f.calls, []);
});

test(
  "Postgres preserves connection binding and serializes completion across separate service pools",
  { skip: !process.env.COMPOSIO_TEST_DATABASE_URL },
  async () => {
    const databaseUrl = process.env.COMPOSIO_TEST_DATABASE_URL!;
    const first = createPostgresMapFactory(databaseUrl);
    const second = createPostgresMapFactory(databaseUrl);
    const table = `composio_connections_${Date.now()}`;
    const f = fixture({
      records: first.map<ComposioConnectionRecord>(table),
      lock: createPostgresAdvisoryLock(first.pool),
    });
    try {
      const started = await f.service.start(actor, toolkit.slug);
      const other = createComposioConnections({
        ...f.options,
        records: second.map<ComposioConnectionRecord>(table),
        lock: createPostgresAdvisoryLock(second.pool),
      });
      const results = await Promise.allSettled([
        f.service.complete(actor, started.id, "ca_0"),
        other.complete(actor, started.id, "ca_0"),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(f.calls.filter((call) => call === "complete").length, 1);
      await first.pool.close();
      assert.equal((await other.request(actor, started.id, input)).status, 200);
      await assert.rejects(other.request({ ...actor, tenantId: "tenant-b" }, started.id, input), /not found/);
      await other.disconnect(actor, started.id);
      await assert.rejects(other.request(actor, started.id, input), /not active/);
    } finally {
      await first.pool.close();
      await second.pool.close();
    }
  },
);
