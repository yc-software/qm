import "./support/auto-fake-sprites.ts";
import { testTenant } from "./support/test-tenant.ts";

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
import { forgetFacts, withProviders, writeFacts } from "../src/memory/provider-outcome.ts";
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
import type { Agent } from "../src/agent/agent.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import type { TurnRequest } from "../src/types.ts";
import { buildApp } from "./support/build-app.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { routedTo, startMcpTestServer, type McpTestServer } from "./support/mcp-test-server.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
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
    tools: ["memory_recall", "memory_write", "forget_fact"].map((name) => ({
      name,
      inputSchema: { type: "object" as const },
    })),
    clients: { "qm-personal": "personal-secret" },
    call: (tool, args) => {
      calls.push({ tool, args });
      if (tool === "forget_fact") return { content: [], structuredContent: { ...args, state: "committed" } };
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

const BRAIN_URL = "https://brain.acme.example/mcp";

function personalBrain(secret: { clientSecret?: string } = { clientSecret: "personal-secret" }, preset = "gbrain-v1") {
  return (record: MemoryRegistry) =>
    putBrain(
      record,
      "acme-personal",
      { preset, url: BRAIN_URL, clientId: "qm-personal", ...secret, label: "Acme personal memory" },
      change,
    );
}

test("two instances racing to bind one member to one brain: exactly one binding lands", async () => {
  const url = testDatabaseUrl();
  const blue = stores(url);
  const green = stores(url);
  await blue.update(personalBrain());
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
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  await memory.capture(
    "personal:U1",
    ["Alice prefers tea."],
    Date.now(),
    { actorId: "U1", context: "conversation" },
    { mode: "explicit" },
  );
  const texts = async () =>
    plain(await memory.recall("personal:U1", { actorId: "U1", audienceScopeId: "personal:U1", query: "codename" }));

  assert.deepEqual(await texts(), ["Alice prefers tea."]);
  await registry.update(personalBrain());
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1", capture: "explicit" }, change),
  );
  const rows = await memory.recall("personal:U1", { actorId: "U1", audienceScopeId: "personal:U1", query: "codename" });
  assert.deepEqual(
    rows.map((row) => [plain([row])[0], row.source?.label]),
    [
      ["Alice prefers tea.", undefined],
      [BRAIN_FACT, "Acme personal memory"],
    ],
  );
  assert.equal(brain.requests.at(-1)?.actor, "U1");

  await memory.capture(
    "personal:U1",
    ["Alice's anchor is HMS-OSPREY-7."],
    Date.now(),
    { actorId: "U1", context: "conversation" },
    { mode: "explicit", audienceScopeId: "personal:U1" },
  );
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
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  for (const [scope, fact] of [
    ["personal:U1", "Alice walks to work."],
    ["personal:U2", "Bob bikes to work."],
    ["group:web-project-1", "The project ships on Fridays."],
  ] as const)
    await memory.capture(scope, [fact], Date.now(), { actorId: "U1", context: "conversation" }, { mode: "automatic" });
  await registry.update(personalBrain());
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );

  const recalled = async (scope: string, actorId: string) =>
    plain(await memory.recall(scope, { actorId, audienceScopeId: scope, query: "work" }));
  assert.deepEqual(await recalled("personal:U1", "U1"), ["Alice walks to work.", BRAIN_FACT]);
  assert.deepEqual(await recalled("personal:U2", "U2"), ["Bob bikes to work."]);
  assert.deepEqual(await recalled("group:web-project-1", "U1"), ["The project ships on Fridays."]);
  assert.equal(
    await memory.capture(
      "personal:U2",
      ["Bob drinks coffee."],
      Date.now(),
      { actorId: "U2", context: "conversation" },
      { mode: "automatic" },
    ),
    1,
  );
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
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  await registry.update(personalBrain());
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );
  assert.ok(
    (await memory.recall("personal:U1", { actorId: "U1", audienceScopeId: "personal:U1" })).some(
      (row) => row.text === BRAIN_FACT,
    ),
  );
  await map.put("org", { schema: 99 } as unknown as MemoryRegistry);
  assert.ok(
    (await memory.recall("personal:U1", { actorId: "U1", audienceScopeId: "personal:U1" })).some(
      (row) => row.text === BRAIN_FACT,
    ),
  );
  const fresh = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  assert.deepEqual(await fresh.recall("personal:U1", { actorId: "U1", audienceScopeId: "personal:U1" }), []);
});

test("a disabled binding gives a problem line and never calls the brain", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  await registry.update(personalBrain({}));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );
  const { value, problems } = await withProviders("search", (report) =>
    memory.query("personal:U1", "anything", 5, { actorId: "U1", audienceScopeId: "personal:U1", report }),
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

test("a disabled binding stays quiet in a conversation that would withhold its brain", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  await registry.update(personalBrain({}));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );
  const actor = { id: "U1", type: "internal" as const };
  const problems = async (targetScope: string) =>
    (
      await withProviders("search", (report) =>
        memory.withDisclosure!({
          actor,
          targetScope,
          nativeScopes: [targetScope],
          audience: [actor],
          open: true,
        }).query("personal:U1", "anything", 5, { actorId: "U1", audienceScopeId: targetScope, report }),
      )
    ).problems.map(({ code }) => code);
  assert.deepEqual(await problems("personal:U1"), ["memory_provider_disabled"]);
  assert.deepEqual(await problems("channel:C1"), []);
  assert.deepEqual(brain.calls, []);
});

test("a disabled binding reports a problem only for writes a served binding would send", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  await registry.update(personalBrain({}));
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1", capture: "explicit" }, change),
  );
  const problems = async (actorId: string, context: Omit<MemoryCaptureContext, "report">) =>
    (
      await writeFacts(
        memory,
        "personal:U1",
        ["Prefers aisle seats"],
        { actorId, context: "conversation" },
        context,
        undefined,
      )
    ).problems.map(({ code }) => code);
  assert.deepEqual(await problems("U1", { mode: "explicit", audienceScopeId: "personal:U1" }), [
    "memory_provider_disabled",
  ]);
  assert.deepEqual(await problems("system:personal:U1", { mode: "explicit", audienceScopeId: "personal:U1" }), []);
  assert.deepEqual(
    await problems("U1", { mode: "explicit", audienceScopeId: "channel:C1", conversationScopeId: "channel:C1" }),
    [],
  );
  assert.deepEqual(brain.calls, []);
});

test("a stored brain whose id an env provider took leaves the env provider serving, with no disabled problem", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const credentials = { clientIdEnv: "BRAIN_ID", clientSecretEnv: "BRAIN_SECRET" };
  const overlay = parseMemoryProviderConfig(
    JSON.stringify({
      providers: [
        {
          id: "acme-personal",
          type: "mcp",
          url: brain.url,
          attestActor: true,
          read: { tool: "memory_recall", queryArg: "query", maxCharsArg: "max_chars", ...credentials },
          write: { tool: "memory_write", factsArg: "facts", idempotencyArg: "idempotency_key", ...credentials },
        },
      ],
      routes: [{ provider: "acme-personal", scopes: ["personal"], capture: "explicit", manage: false }],
    }),
    { BRAIN_ID: "qm-personal", BRAIN_SECRET: "personal-secret" },
  )!;
  const registry = stores(url, overlay);
  await registry.update(personalBrain());
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: "personal:U1", capture: "explicit" }, change),
  );
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    overlay,
    registry,
    registryFetch: routedTo(brain.url),
  });
  const searched = await withProviders("search", (report) =>
    memory.query("personal:U1", "codename", 5, { actorId: "U1", audienceScopeId: "personal:U1", report }),
  );
  assert.deepEqual(searched.problems, []);
  assert.ok((searched.value ?? []).some(({ text }) => text.includes(BRAIN_FACT)));
  const written = await writeFacts(
    memory,
    "personal:U1",
    ["Prefers aisle seats"],
    { actorId: "U1", context: "conversation" },
    { mode: "explicit", audienceScopeId: "personal:U1" },
    undefined,
  );
  assert.deepEqual(written.problems, []);
  assert.deepEqual(
    written.outcomes.map(({ provider, outcome }) => [provider, outcome]),
    [["acme-personal", "committed"]],
  );
});

function serve(built: ReturnType<typeof buildApp>) {
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    memory: built.memory,
    memoryRegistry: built.memoryRegistry,
    capabilitySecret: TEST_CAPABILITY_SECRET,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, actor: string, body?: unknown, auth = "x-admin-actor") => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { [auth]: actor, ...(body ? { "content-type": "application/json" } : {}) },
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
  const config = testConfig(overlay ? { memoryProviderConfig: overlay } : {});
  const built = buildApp(config);
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
  await createPostgresMapFactory(config.databaseUrl!)
    .map<MemoryRegistry>(MEMORY_REGISTRY_TABLE)
    .put("org", { schema: 99 } as unknown as MemoryRegistry);
  const unreadable = await api.call("GET", "/v1/admin/memory-registry", "admin-alice@default-org");
  assert.equal(unreadable.status, 409);
  assert.equal(JSON.parse(unreadable.text).error, "conflict");
  const rows = JSON.stringify(await built.auditLog.events(testTenant));
  assert.match(rows, /memory-registry\.brain\.update/);
  assert.match(rows, /memory-registry\.binding\.delete/);
  assert.match(rows, /memory-registry\.member-brains\.update/);
  assert.doesNotMatch(rows, /never-shown-secret/);
});

test("an admin's agent can register and bind a brain but never carries its secret, moves its url, deletes an entry or reaches the brain before its secret is set", async (t) => {
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
  const agent = (method: string, path: string, body?: unknown) =>
    fetch(`http://localhost:${(server.address() as AddressInfo).port}/v1/admin/memory-registry/${path}`, {
      method,
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const put = (body: Record<string, unknown> | null) => agent("PUT", "brains/acme-personal", body);
  const live = await startBrain(t);
  const brain = {
    preset: "gbrain-v1",
    url: BRAIN_URL,
    clientId: "qm-personal",
    label: "Acme personal memory",
  };
  const carried = await put({ ...brain, clientSecret: "pasted-in-chat" });
  assert.equal(carried.status, 400);
  assert.match(await carried.text(), /never goes through the agent/);
  assert.equal((await put(brain)).status, 200);
  const moved = await put({ ...brain, url: "https://elsewhere.acme.example/mcp" });
  assert.equal(moved.status, 400);
  assert.match(await moved.text(), /url never changes through the agent/);
  assert.equal((await put({ label: "Acme memory" })).status, 200);
  assert.equal((await put(null)).status, 400);
  const stored = (await built.memoryRegistry.current()).record as MemoryRegistry;
  assert.deepEqual(stored.brains[0]!.auth, { clientId: "qm-personal" });
  assert.equal(stored.brains[0]!.url, brain.url);
  assert.equal(stored.brains[0]!.label, "Acme memory");
  const binding = { brain: "acme-personal", scope: "personal:U1", capture: "explicit" };
  assert.equal((await agent("PUT", "bindings/alice", binding)).status, 200);
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(testDatabaseUrl()),
    registry: built.memoryRegistry,
    registryFetch: routedTo(live.url),
  });
  const recall = () =>
    memory.recall("personal:U1", { actorId: "U1", audienceScopeId: "personal:U1", query: "codename" });
  await recall();
  await memory.query("personal:U1", "codename", 5, { actorId: "U1", audienceScopeId: "personal:U1" });
  await memory.capture(
    "personal:U1",
    ["Alice's anchor is HMS-OSPREY-7."],
    Date.now(),
    { actorId: "U1", context: "conversation" },
    { mode: "explicit", audienceScopeId: "personal:U1" },
  );
  assert.deepEqual(live.calls, []);
  await built.memoryRegistry.update((record) =>
    putBrain(
      record,
      "acme-personal",
      { clientSecret: "personal-secret", url: BRAIN_URL },
      {
        actor: "admin-alice",
        now: Date.now(),
        overlayIds: built.memoryRegistry.overlayIds,
        key: built.memoryRegistry.key,
      },
    ),
  );
  await recall();
  assert.deepEqual(
    live.calls.map(({ tool }) => tool),
    ["memory_recall"],
  );
  for (const path of ["bindings/alice", "brains/acme-personal"]) {
    const refused = await agent("DELETE", path);
    assert.equal(refused.status, 403);
    assert.match(await refused.text(), /never goes through the agent/);
  }
  const movedWithSecret = await put({ ...brain, url: "https://elsewhere.acme.example/mcp" });
  assert.equal(movedWithSecret.status, 400);
  assert.match(await movedWithSecret.text(), /url never changes through the agent/);
  assert.equal((await agent("PUT", "bindings/alice", binding)).status, 200);
  const kept = (await built.memoryRegistry.current()).record as MemoryRegistry;
  assert.equal(kept.brains[0]!.url, brain.url);
  assert.ok(kept.brains[0]!.auth.clientSecretEnc);
  assert.deepEqual(
    kept.bindings.map((entry) => [entry.id, entry.brain]),
    [["alice", "acme-personal"]],
  );
});

test("an agent reaches every registry route only where the registry may be shown", async (t) => {
  const secret = "memory-registry-private-read-secret".repeat(2);
  const config = testConfig({
    signingSecret: secret,
    capabilitySecret: secret,
    apiBaseUrl: "http://core.example.test",
  });
  const built = buildApp(config);
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "registry-admin", isPrivate: false }],
    [{ channelId: "C1", principalId: "admin-alice" }],
  );
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    admin: built.admin,
    config: built.config,
    auditLog: built.auditLog,
    memoryRegistry: built.memoryRegistry,
    capabilitySecret: secret,
    signingSecret: secret,
  });
  server.listen(0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await built.memoryRegistry.update((record) =>
    putBinding(personalBrain()(record), "alice", { brain: "acme-personal", scope: "personal:U1" }, change),
  );
  const capabilityIn = (scopeId: string) =>
    mintCapabilityToken(
      { actorId: "admin-alice", scopeId, aud: CONTROL_PLANE_AUD, liveActor: true, exp: Date.now() + CAPABILITY_TTL_MS },
      secret,
    );
  const call = async (cap: string, method: string, path: string, body: unknown) => {
    const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}${path}`, {
      method,
      headers: { "x-agent-capability": cap, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, text: await res.text() };
  };
  const routes = [
    ["GET", "/v1/admin/memory-registry", undefined, 200],
    ["GET", "/v1/admin/memory-registry/brains/acme-personal", undefined, 200],
    ["GET", "/v1/admin/memory-registry/bindings/alice", undefined, 200],
    ["PUT", "/v1/admin/memory-registry/brains/acme-personal", { label: "Acme memory" }, 200],
    ["PUT", "/v1/admin/memory-registry/bindings/alice", {}, 200],
    ["PUT", "/v1/admin/memory-registry/bindings/everyone", { brain: "acme-personal", scope: "personal" }, 409],
    ["PUT", "/v1/admin/memory-registry/member-brains", { enabled: true }, 200],
    ["DELETE", "/v1/admin/memory-registry/bindings/alice", undefined, 403],
    ["DELETE", "/v1/admin/memory-registry/brains/acme-personal", undefined, 403],
    ["GET", "/v1/memory/brain", undefined, 200],
    ["PUT", "/v1/memory/brain", { url: "https://brain.alice.example/mcp", clientId: "alice-qm" }, 200],
    ["DELETE", "/v1/memory/brain", undefined, 200],
  ] as const;
  const record = async () => JSON.stringify((await built.memoryRegistry.current()).record);
  const before = await record();
  const channel = await capabilityIn("channel:C1");
  for (const [method, path, body] of routes) {
    const refused = await call(channel, method, path, body);
    assert.equal(refused.status, 403, `${method} ${path}`);
    assert.match(
      refused.text,
      method === "DELETE" && path.startsWith("/v1/admin/") ? /never goes through the agent/ : /ask the agent in a DM/,
      `${method} ${path}`,
    );
    assert.doesNotMatch(refused.text, /personal:U1|brain\.acme\.example|qm-personal|alice/, `${method} ${path}`);
  }
  assert.equal(await record(), before);
  const dm = await capabilityIn("personal:admin-alice");
  for (const [method, path, body, status] of routes)
    assert.equal((await call(dm, method, path, body)).status, status, `${method} ${path}`);
  await createPostgresMapFactory(config.databaseUrl!)
    .map<MemoryRegistry>(MEMORY_REGISTRY_TABLE)
    .put("org", { schema: 99 } as unknown as MemoryRegistry);
  const unreadable = await call(dm, "GET", "/v1/memory/brain", undefined);
  assert.equal(unreadable.status, 409);
  assert.equal(JSON.parse(unreadable.text).error, "conflict");
});

test("blue-green: a binding written through one instance serves turns on the other, in both directions", async (t) => {
  const brain = await startBrain(t);
  const databaseUrl = testDatabaseUrl();
  const reach = { memoryRegistryFetch: routedTo(brain.url) };
  const blue = buildApp(testConfig({ databaseUrl }), reach);
  const green = buildApp(testConfig({ databaseUrl }), reach);
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
        url: BRAIN_URL,
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
  const restarted = buildApp(testConfig({ databaseUrl }), reach);
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

const ALICE_SCOPE = "personal:U1";
const writes = (brain: { calls: BrainCall[] }) => brain.calls.filter(({ tool }) => tool === "memory_write").length;
const forgets = (brain: { calls: BrainCall[] }) => brain.calls.filter(({ tool }) => tool === "forget_fact");
const BRAIN_REF = { ids: ["acme-personal:42"] };
const notebook = async (built: ReturnType<typeof buildApp>) =>
  ((await built.memory.facts!(ALICE_SCOPE)) ?? []).map(({ text }) => text);

async function boundToBrain(t: { after(fn: () => Promise<void>): void }, agent?: Agent) {
  const brain = await startBrain(t);
  const built = buildApp(
    testConfig({ signingSecret: "memory-authority-signing-secret", apiBaseUrl: "http://core.example.test" }),
    { memoryRegistryFetch: routedTo(brain.url), ...(agent ? { agent } : {}) },
  );
  const api = serve(built);
  t.after(api.close);
  const bind = async () => {
    const admin = "admin-alice@default-org";
    const brainBody = {
      preset: "gbrain-v3",
      url: BRAIN_URL,
      clientId: "qm-personal",
      clientSecret: "personal-secret",
      label: "Acme personal memory",
    };
    assert.equal(
      (await api.call("PUT", "/v1/admin/memory-registry/brains/acme-personal", admin, brainBody)).status,
      200,
    );
    const binding = { brain: "acme-personal", scope: ALICE_SCOPE, capture: "explicit" };
    assert.equal((await api.call("PUT", "/v1/admin/memory-registry/bindings/alice", admin, binding)).status, 200);
  };
  return { brain, built, api, bind };
}

test("a brain forgets by ref only while a binding serves it on gbrain-v3: an update, a rollback and a revocation apply at once", async (t) => {
  const brain = await startBrain(t);
  const url = testDatabaseUrl();
  const registry = stores(url);
  const memory = createRegistryMemoryService({
    defaultMemory: createPostgresMemoryService(url),
    registry,
    registryFetch: routedTo(brain.url),
  });
  const forget = () =>
    forgetFacts(
      memory,
      ALICE_SCOPE,
      BRAIN_REF.ids,
      { actorId: "U1", context: "conversation" },
      { audienceScopeId: ALICE_SCOPE },
      "session:call",
    );
  await registry.update(personalBrain());
  await registry.update((record) =>
    putBinding(record, "alice", { brain: "acme-personal", scope: ALICE_SCOPE, capture: "explicit" }, change),
  );
  await assert.rejects(forget(), /can't forget facts .* its preset has no forget\. Nothing was changed/);
  await registry.update(personalBrain(undefined, "gbrain-v3"));
  assert.equal((await forget()).forgotten, 1);
  await registry.update(personalBrain(undefined, "gbrain-v1"));
  await assert.rejects(forget(), /Nothing was changed/);
  await registry.update(personalBrain(undefined, "gbrain-v3"));
  await registry.update((record) => deleteBinding(record, "alice"));
  await assert.rejects(forget(), /Nothing was changed/);

  const [sent, ...more] = forgets(brain);
  assert.deepEqual(more, []);
  assert.deepEqual(Object.keys(sent!.args).sort(), ["id", "request_id"]);
  assert.equal(sent!.args.id, 42);
  assert.match(String(sent!.args.request_id), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(brain.requests.filter(({ rpc }) => rpc === "tools/call").at(-1)?.actor, "U1");
});

test("only Alice's own conversation writes to her brain; admin, onboarding and self-service change her notebook alone", async (t) => {
  const { brain, built, api, bind } = await boundToBrain(t);
  await bind();
  const dm: TurnRequest = {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:own" },
    text: "!memoryremember Alice drinks rooibos.",
  };
  assert.equal((await built.app.turn(dm)).reply, "remembered 1");
  assert.equal(writes(brain), 1);
  assert.equal(brain.requests.at(-1)?.actor, "U1");

  const admin = "admin-alice@default-org";
  const scoped = `/v1/admin/memory?scope=${encodeURIComponent(ALICE_SCOPE)}`;
  assert.equal((await api.call("POST", scoped, admin, { facts: ["Alice sits at desk 4B."] })).status, 200);
  assert.equal((await api.call("PUT", "/v1/admin/users/U1/onboarding", admin, { status: "completed" })).status, 200);
  const desk = (await built.memory.facts!(ALICE_SCOPE)).find(({ text }) => text.includes("desk 4B"))!;
  assert.equal(
    (await api.call("PATCH", scoped, admin, { facts: [{ id: desk.id, text: "Alice sits at desk 5C." }] })).status,
    200,
  );
  const rooibos = (await built.memory.facts!(ALICE_SCOPE)).find(({ text }) => text.includes("rooibos"))!;
  const self = { principalId: "U1" };
  assert.equal(
    (
      await api.call("PATCH", "/v1/memory", "U1", {
        ...self,
        facts: [{ id: rooibos.id, text: "Alice drinks mint tea." }],
      })
    ).status,
    200,
  );
  const mint = (await built.memory.facts!(ALICE_SCOPE)).find(({ text }) => text.includes("mint"))!;
  assert.equal((await api.call("DELETE", "/v1/memory", "U1", { ...self, ids: [mint.id] })).status, 200);
  assert.equal((await api.call("DELETE", scoped, admin, BRAIN_REF)).status, 403);
  assert.equal((await api.call("DELETE", "/v1/memory", "U1", { ...self, ...BRAIN_REF })).status, 403);

  assert.deepEqual(
    (await notebook(built)).map((text) => text.replace(/ on \d{4}-\d\d-\d\d\.$/, ".")),
    ["Alice sits at desk 5C.", "Onboarding: completed v2."],
  );
  assert.equal(writes(brain), 1);
  assert.deepEqual(forgets(brain), []);
  assert.ok(brain.requests.every(({ actor }) => actor === "U1"));
});

test("the nightly tidy changes the notebook alone, through its tools and its agent API token, with a brain bound", async (t) => {
  const mock = createMockAgent();
  const seen = { prompt: "", search: [] as string[], tools: [] as string[], forget: "" };
  let ids: Record<string, string> = {};
  const agent: Agent = {
    ...mock,
    async runTurn(input) {
      if (!input.input.includes("Stored cron task:")) return mock.runTurn(input);
      seen.prompt = [input.systemPrompt, input.environment, input.input].join("\n");
      seen.tools = createAgentTools(
        { current: input.tools },
        { controlTools: true, ...(input.memoryNotebookOnly ? { memoryNotebookOnly: true } : {}) },
      ).map(({ name }) => name);
      seen.search = (await input.tools.memorySearch("Alice"))?.hits ?? [];
      await input.tools.memoryEdit([{ id: ids.tea!, text: "Alice drinks tea every morning." }]);
      await input.tools.memoryDelete([ids.daily!, ids.desk!], "call-1");
      seen.forget = await input.tools.memoryDelete(BRAIN_REF.ids, "call-2").then(
        () => "forgot",
        (error: Error) => error.message,
      );
      await input.tools.memoryAdd(["Alice sits at desk 4B."]);
      return mock.runTurn({ ...input, input: "!run echo tidied" });
    },
  };
  const { brain, built, api, bind } = await boundToBrain(t, agent);
  await built.memory.capture(
    ALICE_SCOPE,
    ["Alice drinks tea.", "Alice drinks tea daily.", "Alice sat at desk 3A."],
    Date.now(),
    { actorId: "U1", context: "conversation" },
    { mode: "explicit" },
  );
  const facts = await built.memory.facts!(ALICE_SCOPE);
  const id = (needle: string) => facts.find(({ text }) => text.includes(needle))!.id;
  ids = { tea: id("tea."), daily: id("daily"), desk: id("3A") };
  await bind();
  const ordinary = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:before-tidy" },
    text: "!sysprompt",
  });
  assert.match(ordinary.reply ?? "", /BLACKBEARD-42/);
  const before = brain.calls.length;

  await selectDefaultSandbox(built, "U1", ALICE_SCOPE);
  let token: string | undefined;
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (layers, opts) => {
    token = opts?.env?.AGENT_API_TOKEN;
    return provision(layers, opts);
  };
  const tidy = (await built.crons.list()).find((cron) => cron.ownerScopeId === ALICE_SCOPE)!;
  const fired = await built.scheduler.runNow(tidy.id);
  assert.ok(fired.started);
  await fired.settled;
  assert.equal((await built.crons.listFires(tidy.id, { limit: 1 })).runs[0]?.status, "ok");

  assert.doesNotMatch(seen.prompt, /BLACKBEARD-42/);
  assert.ok(seen.search.length > 0);
  assert.ok(seen.search.every((hit) => !hit.includes("BLACKBEARD-42")));
  assert.deepEqual(await notebook(built), ["Alice drinks tea every morning.", "Alice sits at desk 4B."]);

  assert.ok(token);
  const agentApi = (method: string, path: string, body: unknown) =>
    api.call(method, path, token!, body, "x-agent-capability");
  const searched = await agentApi("POST", "/v1/memory/search", { query: "Alice" });
  assert.equal(searched.status, 200);
  assert.doesNotMatch(searched.text, /BLACKBEARD-42/);
  assert.equal((await agentApi("POST", "/v1/memory/facts", { facts: ["Alice parks in bay 7."] })).status, 200);
  assert.match(seen.forget, /can't forget .* Nothing was changed/);
  assert.equal((await agentApi("DELETE", "/v1/memory/facts", BRAIN_REF)).status, 403);
  assert.ok((await notebook(built)).includes("Alice parks in bay 7."));
  assert.ok(seen.tools.includes("memory"));
  assert.deepEqual(
    seen.tools.filter((name) => ["cron", "webhook", "goal"].includes(name)),
    [],
  );
  for (const path of ["/v1/crons", "/v1/loops", "/v1/webhooks"]) {
    const refused = await agentApi("POST", path, {});
    assert.equal(refused.status, 403, path);
    assert.match(refused.text, /notebook-only turn/, path);
  }
  const [fire] = (await built.crons.listFires(tidy.id, { limit: 1 })).runs;
  const woken = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: fire!.threadRef },
    text: "!sysprompt",
  });
  assert.doesNotMatch(woken.reply ?? "", /BLACKBEARD-42/);
  assert.equal(brain.calls.length, before);
});

test("Alice's own turn into a notebook-only subagent leaves her brain alone, and so does the subagent it opens", async (t) => {
  const mock = createMockAgent();
  const subagent = "agent:main:subagent:tidy-follow-up";
  const agent: Agent = {
    ...mock,
    async runTurn(input) {
      if (input.session.threadRef === subagent) await input.tools.sessionSyscalls!.open({ task: "check the notebook" });
      return mock.runTurn(input);
    },
  };
  const { brain, built, bind } = await boundToBrain(t, agent);
  await bind();
  const alice = { id: "U1", type: "internal" as const };
  const session = await built.sessions.getOrCreateByThread(subagent, "dm", ALICE_SCOPE);
  await built.sessions.addParticipant(session.id, alice.id);
  await built.sessions.setSpawnMeta(session.id, {
    surface: "test",
    actor: alice,
    conversation: { kind: "dm", threadRef: "dm:U1:tidy", audience: [alice] },
    memoryNotebookOnly: true,
  });
  const prompt = async (threadRef: string) =>
    (
      await built.app.turn({
        surface: "test",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef },
        text: "!sysprompt",
      })
    ).reply ?? "";
  assert.match(await prompt("dm:U1:ordinary"), /BLACKBEARD-42/);
  const before = brain.calls.length;

  assert.doesNotMatch(await prompt(subagent), /BLACKBEARD-42/);
  const [helper] = await built.sessions.childrenOf(session.id);
  assert.equal(helper?.spawnMeta?.memoryNotebookOnly, true);
  assert.equal(brain.calls.length, before);
});
