import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createMonitorStore } from "../src/monitors/monitor-store.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import type { SpawnMeta } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const spawnMeta = {
  surface: "web",
  conversation: { kind: "dm", threadRef: "web:U1:root", audience: [{ id: "U1", type: "internal" }] },
  actor: { id: "U1", type: "internal" },
  unattendedGrants: ["grant-1"],
} as unknown as SpawnMeta;
const clientTools = [{ name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } }];

test("listed sessions leave out spawn metadata and client tools; a single session keeps them", async () => {
  const sessions = createMemorySessionStore();
  const child = await sessions.getOrCreateByThread(
    "subagent:root:1",
    "dm",
    "personal:U1",
    undefined,
    "web",
    clientTools,
  );
  await sessions.setSpawnMeta(child.id, spawnMeta);
  await sessions.addParticipant(child.id, "U1");

  const [listed] = await sessions.listByParticipant("U1");
  assert.equal(listed?.id, child.id);
  assert.equal("spawnMeta" in listed!, false);
  assert.equal("clientTools" in listed!, false);
  assert.deepEqual((await sessions.getForParticipant(child.id, "U1"))?.spawnMeta, spawnMeta);
});

test("participantScopes counts sessions with content per scope and keeps scopes with none", async () => {
  const sessions = createMemorySessionStore();
  const titled = await sessions.getOrCreateByThread("web:U1:a", "dm", "personal:U1");
  await sessions.addParticipant(titled.id, "U1", "Planning");
  const empty = await sessions.getOrCreateByThread("web:U1:b", "dm", "personal:U1");
  await sessions.addParticipant(empty.id, "U1");
  const channel = await sessions.getOrCreateByThread("slack:C1:1", "channel", "channel:C1", "eng");
  await sessions.addParticipant(channel.id, "U1");
  const someoneElse = await sessions.getOrCreateByThread("web:U2:a", "dm", "personal:U2");
  await sessions.addParticipant(someoneElse.id, "U2", "Theirs");

  const scopes = new Map((await sessions.participantScopes("U1")).map((scope) => [scope.scopeId, scope]));
  assert.deepEqual([...scopes.keys()].sort(), ["channel:C1", "personal:U1"]);
  assert.equal(scopes.get("personal:U1")?.sessionCount, 1);
  assert.equal(scopes.get("personal:U1")?.lastActivityAt, titled.createdAt);
  assert.equal(scopes.get("channel:C1")?.sessionCount, 0);
  assert.equal(scopes.get("channel:C1")?.lastActivityAt, null);
  assert.equal(scopes.get("channel:C1")?.channelName, "eng");
});

test("GET /v1/sessions rows carry no spawn metadata, client tools or entry flag", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "lean-list-")) }));
  const child = await built.sessions.getOrCreateByThread(
    "subagent:root:2",
    "dm",
    "personal:U1",
    undefined,
    "web",
    clientTools,
  );
  await built.sessions.setSpawnMeta(child.id, spawnMeta);
  await built.sessions.addParticipant(child.id, "U1", "Research task");
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  try {
    const port = (server.address() as AddressInfo).port;
    const res = await fetch(`http://localhost:${port}/v1/sessions?principalId=U1`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    const row = body.sessions.find((session) => session.id === child.id);
    assert.ok(row);
    assert.equal(row.title, "Research task");
    for (const field of ["spawnMeta", "clientTools", "hasEntries"]) assert.equal(field in row, false, field);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("background lookups return only work tied to the listed threads", async () => {
  const now = Date.now();
  const processes = createMemoryProcessRegistry();
  for (const [processId, sessionRef] of [
    ["p1", "web:U1:a"],
    ["p2", "web:U9:z"],
  ] as const)
    await processes.register({
      processId,
      scopeId: "personal:U1",
      sandboxId: "sb",
      kind: "background",
      command: "sleep 100",
      ttlMs: 60_000,
      sessionRef,
    });
  assert.deepEqual(
    (await processes.liveForSessions(["web:U1:a"], now)).map((p) => p.processId),
    ["p1"],
  );
  assert.deepEqual(await processes.liveForSessions([], now), []);

  const monitors = createMonitorStore(createMemoryMap());
  const base = { owner: "U1", createdBy: "U1", ownerScopeId: "personal:U1" as const, processId: "p1", command: "tail" };
  await monitors.create({ ...base, threadRef: "web:U1:a", expiresAt: now + 60_000 });
  await monitors.create({ ...base, threadRef: "web:U1:a", expiresAt: now - 1 });
  await monitors.create({ ...base, threadRef: "web:U9:z", expiresAt: now + 60_000 });
  assert.equal((await monitors.enabledFor(["web:U1:a"], now)).length, 1);

  const crons = createCronStore(createMemoryMap());
  const cron = {
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1" as const,
    schedule: { everyMs: 3_600_000 },
    message: "hi",
  };
  await crons.create({ ...cron, sessionRef: "web:U1:a" });
  await crons.create({ ...cron, message: "post", destination: { type: "web", target: "web:U1:b" } });
  await crons.create({ ...cron, message: "elsewhere", sessionRef: "web:U9:z" });
  const tied = await crons.tiedTo(["web:U1:a", "web:U1:b"]);
  assert.deepEqual(tied.map((c) => c.message).sort(), ["hi", "post"]);
});

test("allMatching returns only the matching values", async () => {
  const map = createMemoryMap<{ n: number; tags: string[] }>();
  await map.put("a", { n: 1, tags: [] });
  await map.put("b", { n: 2, tags: [] });
  const [match] = await map.allMatching!((value) => value.n === 2);
  assert.equal(match?.n, 2);
  assert.equal((await map.allMatching!(() => false)).length, 0);
});
