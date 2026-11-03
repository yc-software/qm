import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import type { SpawnMeta } from "../src/types.ts";
import { assertLateJoinerScopes, assertLeanListing } from "./support/participant-scopes.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("listed sessions leave out spawn metadata; scopes count only sessions with content", async () => {
  await assertLeanListing(createPostgresSessionStore(testDatabaseUrl()), "mem");
});

test("participantScopes leaves out sessions whose content predates the participant", async () => {
  await assertLateJoinerScopes(createPostgresSessionStore(testDatabaseUrl()), "mem");
});

test("GET /v1/sessions rows carry no spawn metadata, client tools or entry flag", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "lean-list-")) }));
  const child = await built.sessions.getOrCreateByThread("subagent:root:2", "dm", "personal:U1", undefined, "web", [
    { name: "screenshot", description: "Take a screenshot", inputSchema: { type: "object" } },
  ]);
  await built.sessions.setSpawnMeta(child.id, {
    surface: "web",
    conversation: { kind: "dm", threadRef: "web:U1:root", audience: [] },
    actor: { id: "U1", type: "internal" },
  } as unknown as SpawnMeta);
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
    await built.runtime.stop();
  }
});
