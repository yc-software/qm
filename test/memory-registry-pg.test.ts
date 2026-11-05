import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { CAPABILITY_TTL_MS, CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createPostgresMemoryService } from "../src/memory/postgres-memory-service.ts";
import { createRegistryMemoryService } from "../src/memory/registry-memory.ts";
import type { MemoryCaptureContext } from "../src/memory/memory-service.ts";
import { withProviders, writeFacts } from "../src/memory/provider-outcome.ts";
import { parseMemoryProviderConfig } from "../src/memory/provider-config.ts";
import {
  MEMORY_REGISTRY_TABLE,
  MemoryRegistryError,
  createMemoryRegistryStore,
  deleteBinding,
  putBinding,
  putBrain,
  type MemoryRegistry,
} from "../src/memory/registry.ts";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import type { TurnRequest } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { startMcpTestServer, type McpTestServer } from "./support/mcp-test-server.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

const change = {
  actor: "admin-alice",
  now: 1_762_128_000_000,
  overlayIds: new Set<string>(),
  key: deriveConnectorKey("test-memory-registry-key", "memory-registry"),
};
const BRAIN_FACT = "Alice's project codename is BLACKBEARD-42.";
const plain = (rows: ReadonlyArray<{ text: string }>) =>
  rows.map(({ text }) => text.replace(/^- \(\d{4}-\d\d-\d\d\) /, ""));

interface BrainCall {
  tool: string;
  args: Record<string, unknown>;
}

async function startBrain(t: {
  after(fn: () => Promise<void>): void;
}): Promise<McpTestServer & { calls: BrainCall[] }> {
  const calls: BrainCall[] = [];
  const server = await startMcpTestServer(t, {
    tools: ["memory_recall", "memory_write"].map((name) => ({ name, inputSchema: { type: "object" as const } })),
    clients: { "qm-personal": "personal-secret" },
    call: (tool, args) => {
      calls.push({ tool, args });
      return { content: [{ type: "text", text: tool === "memory_recall" ? BRAIN_FACT : "stored" }] };
    },
  });
  return Object.assign(server, { calls });
}

function stores(url: string, overlay?: Parameters<typeof createMemoryRegistryStore>[0]["overlay"]) {
  const maps = createPostgresMapFactory(url);
  return createMemoryRegistryStore({
    map: maps.map<MemoryRegistry>(MEMORY_REGISTRY_TABLE),
    key: change.key,
    ...(overlay ? { overlay } : {}),
  });
}

function personalBrain(url: string, secret: { clientSecret?: string } = { clientSecret: "personal-secret" }) {
  return (record: MemoryRegistry) =>
    putBrain(
      record,
      "acme-personal",
      { preset: "gbrain-v1", url, clientId: "qm-personal", ...secret, label: "Acme personal memory" },
      change,
    );
}

test("two instances racing to bind one member to one brain: exactly one binding lands", async () => {
  const url = testDatabaseUrl();
  const blue = stores(url);
  const green = stores(url);
  await blue.update(personalBrain("https://brain.acme.example/mcp"));
  const bind = (store: typeof blue, id: string) =>
    store.update((record) => putBinding(record, id, { brain: "acme-personal", scope: "personal:U1" }, change));
  const results = await Promise.allSettled([bind(blue, "a"), bind(green, "b"), bind(blue, "c"), bind(green, "d")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  for (const result of results)
    if (result.status === "rejected") {
      assert.ok(result.reason instanceof MemoryRegistryError);
      assert.equal(result.reason.status, 409);
    }
  const { record } = await green.current();
  assert.equal((record as MemoryRegistry).bindings.length, 1);
});

test("an already-built memory service serves a new binding, then stops at its revocation", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({ defaultMemory: createPostgresMemoryService(url), registry });
  await memory.capture("personal:U1", ["Alice prefers tea."], Date.now(), "U1", { mode: "explicit" });
  const texts = async () => plain(await memory.recall("personal:U1", { actorId: "U1", query: "codename" }));

  assert.deepEqual(await texts(), ["Alice prefers tea."]);
  await registry.update(personalBrain(brain.url));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1", capture: "explicit" }, change),
  );
  const rows = await memory.recall("personal:U1", { actorId: "U1", query: "codename" });
  assert.deepEqual(
    rows.map((row) => [plain([row])[0], row.source?.label]),
    [
      ["Alice prefers tea.", undefined],
      [BRAIN_FACT, "Acme personal memory"],
    ],
  );
  assert.equal(brain.requests.at(-1)?.actor, "U1");

  await memory.capture("personal:U1", ["Alice's anchor is HMS-OSPREY-7."], Date.now(), "U1", {
    mode: "explicit",
    actorId: "U1",
  });
  assert.equal(brain.calls.filter(({ tool }) => tool === "memory_write").length, 1);

  await registry.update((record) => deleteBinding(record, "alice"));
  const calls = brain.calls.length;
  assert.deepEqual(await texts(), ["Alice's anchor is HMS-OSPREY-7.", "Alice prefers tea."]);
  assert.equal(brain.calls.length, calls);
});

test("the first binding keeps notebook memory for other members, projects and existing facts", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({ defaultMemory: createPostgresMemoryService(url), registry });
  for (const [scope, fact] of [
    ["personal:U1", "Alice walks to work."],
    ["personal:U2", "Bob bikes to work."],
    ["group:web-project-1", "The project ships on Fridays."],
  ] as const)
    await memory.capture(scope, [fact], Date.now(), "U1", { mode: "automatic" });
  await registry.update(personalBrain(brain.url));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );

  const recalled = async (scope: string, actorId: string) =>
    plain(await memory.recall(scope, { actorId, query: "work" }));
  assert.deepEqual(await recalled("personal:U1", "U1"), ["Alice walks to work.", BRAIN_FACT]);
  assert.deepEqual(await recalled("personal:U2", "U2"), ["Bob bikes to work."]);
  assert.deepEqual(await recalled("group:web-project-1", "U1"), ["The project ships on Fridays."]);
  assert.equal(await memory.capture("personal:U2", ["Bob drinks coffee."], Date.now(), "U2", { mode: "automatic" }), 1);
  assert.deepEqual(
    (await memory.facts!("personal:U1")).map((fact) => fact.text),
    ["Alice walks to work."],
  );
  assert.equal(brain.calls.filter(({ tool }) => tool === "memory_write").length, 0);
});

test("an invalid registry version leaves the last valid one serving", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const maps = createPostgresMapFactory(url);
  const map = maps.map<MemoryRegistry>(MEMORY_REGISTRY_TABLE);
  const registry = createMemoryRegistryStore({ map, key: change.key });
  const memory = createRegistryMemoryService({ defaultMemory: createPostgresMemoryService(url), registry });
  await registry.update(personalBrain(brain.url));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );
  assert.ok((await memory.recall("personal:U1", { actorId: "U1" })).some((row) => row.text === BRAIN_FACT));
  await map.put("org", { schema: 99 } as unknown as MemoryRegistry);
  assert.ok((await memory.recall("personal:U1", { actorId: "U1" })).some((row) => row.text === BRAIN_FACT));
  const fresh = createRegistryMemoryService({ defaultMemory: createPostgresMemoryService(url), registry });
  assert.deepEqual(await fresh.recall("personal:U1", { actorId: "U1" }), []);
});

test("a disabled binding gives a problem line and never calls the brain", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({ defaultMemory: createPostgresMemoryService(url), registry });
  await registry.update(personalBrain(brain.url, {}));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );
  const { value, problems } = await withProviders("search", (report) =>
    memory.query("personal:U1", "anything", 5, { actorId: "U1", report }),
  );
  assert.deepEqual(value, []);
  assert.deepEqual(
    problems.map(({ code, provider, detail }) => [code, provider, detail]),
    [
      [
        "memory_provider_disabled",
        "acme-personal",
        "Memory provider acme-personal is registered for this scope but not serving it (secret_missing), so QM didn't call it.",
      ],
    ],
  );
  assert.deepEqual(brain.calls, []);
});

test("a disabled binding reports a problem only for writes a served binding would send", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({ defaultMemory: createPostgresMemoryService(url), registry });
  await registry.update(personalBrain(brain.url, {}));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1", capture: "explicit" }, change),
  );
  const problems = async (context: Omit<MemoryCaptureContext, "report">) =>
    (await writeFacts(memory, "personal:U1", ["Prefers aisle seats"], "U1", context, undefined)).problems.map(
      ({ code }) => code,
    );
  assert.deepEqual(await problems({ mode: "explicit", actorId: "U1" }), ["memory_provider_disabled"]);
  assert.deepEqual(await problems({ mode: "explicit", actorId: "system:personal:U1" }), []);
  assert.deepEqual(await problems({ mode: "explicit", actorId: "U1", conversationScopeId: "channel:C1" }), []);
  assert.deepEqual(brain.calls, []);
});

function serve(built: ReturnType<typeof buildApp>) {
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    memoryRegistry: built.memoryRegistry,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, actor: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "x-admin-actor": actor, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  };
  return { call, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("org-admin routes: admins only, secrets write-only, env providers read-only, audited", async (t) => {
  const overlay = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [
        {
          id: "gbrain",
          type: "mcp",
          url: "https://brain.acme.example/mcp",
          attestActor: true,
          read: { tool: "memory_recall", clientIdEnv: "GBRAIN_ID", clientSecretEnv: "GBRAIN_SECRET" },
        },
      ],
      routes: [{ provider: "gbrain", scopes: ["personal"], manage: false }],
    }),
    { GBRAIN_ID: "id", GBRAIN_SECRET: "env-secret" },
  );
  const built = buildApp(testConfig(overlay ? { memoryProviderConfig: overlay } : {}));
  const api = serve(built);
  t.after(api.close);
  const brain = {
    preset: "gbrain-v1",
    url: "https://brain2.acme.example/mcp",
    clientId: "qm-personal",
    clientSecret: "never-shown-secret",
    label: "Acme personal memory",
  };

  assert.equal(
    (await api.call("PUT", "/v1/admin/memory-registry/brains/acme-personal", "U-nobody@default-org", brain)).status,
    403,
  );
  assert.equal((await api.call("GET", "/v1/admin/memory-registry", "U-nobody@default-org")).status, 403);
  const put = await api.call("PUT", "/v1/admin/memory-registry/brains/acme-personal", "admin-alice@default-org", brain);
  assert.equal(put.status, 200);
  assert.doesNotMatch(put.text, /never-shown-secret/);
  assert.equal(JSON.parse(put.text).brains[0].auth.hasClientSecret, true);
  assert.doesNotMatch(JSON.stringify((await built.memoryRegistry.current()).record), /never-shown-secret/);
  const read = await api.call("GET", "/v1/admin/memory-registry/brains/acme-personal", "admin-alice@default-org");
  assert.equal(read.status, 200);
  assert.doesNotMatch(read.text, /never-shown-secret/);
  assert.deepEqual(JSON.parse(read.text).auth, { clientId: "qm-personal", hasClientSecret: true });
  await built.memoryRegistry.update((record) => ({
    ...record,
    brains: record.brains.map((entry) => ({ ...entry, auth: { ...entry.auth, clientSecret: "older-row-plaintext" } })),
  }));
  const older = await api.call("GET", "/v1/admin/memory-registry", "admin-alice@default-org");
  assert.doesNotMatch(older.text, /older-row-plaintext/);
  const overlayWrite = await api.call(
    "PUT",
    "/v1/admin/memory-registry/brains/gbrain",
    "admin-alice@default-org",
    brain,
  );
  assert.equal(overlayWrite.status, 409);
  assert.match(overlayWrite.text, /MEMORY_PROVIDER_CONFIG/);
  assert.deepEqual(
    JSON.parse((await api.call("GET", "/v1/admin/memory-registry", "admin-alice@default-org")).text).overlay,
    ["gbrain"],
  );
  const bound = await api.call("PUT", "/v1/admin/memory-registry/bindings/alice", "admin-alice@default-org", {
    brain: "acme-personal",
    scope: "personal:U1",
  });
  assert.equal(bound.status, 200);
  assert.equal(
    (await api.call("DELETE", "/v1/admin/memory-registry/brains/acme-personal", "admin-alice@default-org")).status,
    409,
  );
  assert.equal(
    (await api.call("DELETE", "/v1/admin/memory-registry/bindings/alice", "admin-alice@default-org")).status,
    200,
  );
  const switchOff = { enabled: false };
  assert.equal(
    (await api.call("PUT", "/v1/admin/memory-registry/member-brains", "U-nobody@default-org", switchOff)).status,
    403,
  );
  const off = await api.call("PUT", "/v1/admin/memory-registry/member-brains", "admin-alice@default-org", switchOff);
  assert.equal(JSON.parse(off.text).memberBrains, false);
  assert.equal(
    JSON.parse((await api.call("GET", "/v1/admin/memory-registry", "admin-alice@default-org")).text).memberBrains,
    false,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const rows = JSON.stringify(await built.auditLog.events());
  assert.match(rows, /memory-registry\.brain\.update/);
  assert.match(rows, /memory-registry\.binding\.delete/);
  assert.match(rows, /memory-registry\.member-brains\.update/);
  assert.doesNotMatch(rows, /never-shown-secret/);
});

test("an admin's agent can register a brain but never carries its client secret", async (t) => {
  const secret = "memory-registry-capability-secret".repeat(2);
  const built = buildApp(
    testConfig({ signingSecret: secret, capabilitySecret: secret, apiBaseUrl: "http://core.example.test" }),
  );
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    admin: built.admin,
    auditLog: built.auditLog,
    memoryRegistry: built.memoryRegistry,
    capabilitySecret: secret,
    signingSecret: secret,
  });
  server.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const cap = await mintCapabilityToken(
    {
      actorId: "admin-alice",
      scopeId: "personal:admin-alice",
      aud: CONTROL_PLANE_AUD,
      liveActor: true,
      exp: Date.now() + CAPABILITY_TTL_MS,
    },
    secret,
  );
  const put = (body: Record<string, unknown>) =>
    fetch(`http://localhost:${(server.address() as AddressInfo).port}/v1/admin/memory-registry/brains/acme-personal`, {
      method: "PUT",
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const brain = {
    preset: "gbrain-v1",
    url: "https://brain.acme.example/mcp",
    clientId: "qm-personal",
    label: "Acme personal memory",
  };
  const carried = await put({ ...brain, clientSecret: "pasted-in-chat" });
  assert.equal(carried.status, 400);
  assert.match(await carried.text(), /never goes through the agent/);
  assert.equal((await put(brain)).status, 200);
  const stored = (await built.memoryRegistry.current()).record as MemoryRegistry;
  assert.deepEqual(stored.brains[0]!.auth, { clientId: "qm-personal" });
});

test("blue-green: a binding written through one instance serves turns on the other, in both directions", async (t) => {
  const brain = await startBrain(t);
  const databaseUrl = testDatabaseUrl();
  const blue = buildApp(testConfig({ databaseUrl }));
  const green = buildApp(testConfig({ databaseUrl }));
  const blueApi = serve(blue);
  const greenApi = serve(green);
  t.after(blueApi.close);
  t.after(greenApi.close);
  const dm = (text: string, thread: string): TurnRequest => ({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: thread },
    text,
  });
  const prompt = async (app: typeof blue, thread: string) => (await app.app.turn(dm("!sysprompt", thread))).reply ?? "";

  assert.doesNotMatch(await prompt(green, "dm:U1:t0"), /BLACKBEARD-42/);
  assert.equal(
    (
      await blueApi.call("PUT", "/v1/admin/memory-registry/brains/acme-personal", "admin-alice@default-org", {
        preset: "gbrain-v1",
        url: brain.url,
        clientId: "qm-personal",
        clientSecret: "personal-secret",
        label: "Acme personal memory",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await blueApi.call("PUT", "/v1/admin/memory-registry/bindings/alice", "admin-alice@default-org", {
        brain: "acme-personal",
        scope: "personal:U1",
      })
    ).status,
    200,
  );
  assert.match(await prompt(green, "dm:U1:t1"), /BLACKBEARD-42/);
  assert.ok(brain.requests.some(({ actor }) => actor === "U1"));
  const restarted = buildApp(testConfig({ databaseUrl }));
  assert.match(await prompt(restarted, "dm:U1:t2"), /BLACKBEARD-42/);

  assert.equal(
    (await greenApi.call("DELETE", "/v1/admin/memory-registry/bindings/alice", "admin-alice@default-org")).status,
    200,
  );
  const recalls = brain.calls.length;
  assert.doesNotMatch(await prompt(blue, "dm:U1:t3"), /BLACKBEARD-42/);
  assert.doesNotMatch(await prompt(restarted, "dm:U1:t4"), /BLACKBEARD-42/);
  assert.equal(brain.calls.length, recalls);
});
