import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import pg from "pg";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { createApp } from "../src/api/app.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { createMemoryBlobTransferStore } from "../src/persistence/blob-transfer.ts";
import { createPostgresRunActivityStore } from "../src/runs/postgres-run-activity-store.ts";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { ambientTenant } from "../src/tenants/context.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("ephemeral tools expose read-only memory/files/skills, scratch-only execute, and omit durable tools", () => {
  const tools = createAgentTools({ current: null }, { ephemeral: true, controlTools: true });
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const omitted of [
    "apps",
    "background",
    "subagents",
    "sessions",
    "sandbox",
    "cron",
    "webhook",
    "admin",
    "guidance",
    "goal",
  ]) {
    assert.equal(byName.has(omitted), false, `expected ${omitted} to be omitted`);
  }
  const memSchema = byName.get("memory")?.parameters as {
    properties: { action: { anyOf: Array<{ const: string }> } };
  };
  assert.deepEqual(
    memSchema.properties.action.anyOf.map((v) => v.const),
    ["search", "read"],
  );
  const fileSchema = byName.get("files")?.parameters as {
    properties: { action: { const?: string; anyOf?: Array<{ const: string }> } };
  };
  const fileActions = fileSchema.properties.action.anyOf?.map((v) => v.const) ?? [fileSchema.properties.action.const];
  assert.deepEqual(fileActions, ["read"]);
  const execTool = byName.get("execute");
  assert.ok(execTool);
  const execProps = (execTool.parameters as { properties: Record<string, unknown> }).properties;
  assert.equal("scope" in execProps, false);
  assert.equal("background" in execProps, false);
  assert.equal("sandbox_id" in execProps, false);
});

test("ephemeral sessions stay out of listings/search and hard-delete on clear and TTL", async () => {
  const url = testDatabaseUrl();
  const sessions = createPostgresSessionStore(url);
  const { runs } = createPostgresRunStore(url);
  const runActivity = createPostgresRunActivityStore(url);
  const pool = new pg.Pool({ connectionString: url });
  try {
    const user = "alice@example.com";
    const personal = scopeId("personal", user);
    const threadRef = `web:${user}:eph-1`;
    const session = await sessions.getOrCreateByThread(threadRef, "dm", personal, undefined, "web", {
      ephemeral: true,
    });
    assert.equal(session.ephemeral, true);
    await sessions.addParticipant(session.id, user);
    await sessions.append(
      { sessionId: session.id },
      { kind: "UserMessage", text: "secret token NEBULA_42", author: user },
    );
    await sessions.append({ sessionId: session.id }, { kind: "AgentMessage", text: "ack NEBULA_42" });

    assert.deepEqual(await sessions.listByParticipant(user), []);
    assert.deepEqual((await sessions.listParticipantPage(user, { limit: 20 })).sessions, []);
    assert.deepEqual(await sessions.searchEntries(user, "NEBULA_42"), []);
    assert.deepEqual(await sessions.scopeSessionSummaries(personal, false, { limit: 20 }), []);

    const enqueued = await runs.enqueue({
      sessionId: threadRef,
      request: {
        surface: "web",
        actor: { id: user, type: "internal" },
        conversation: { kind: "dm", threadRef, audience: [{ id: user, type: "internal" }] },
        origin: { kind: "human" },
        text: "secret token NEBULA_42",
        ephemeral: true,
      },
      maxAttempts: 1,
    });
    const claimed = await runs.claim("w-1", 60_000, 1);
    assert.equal(claimed.length, 1);
    await runActivity.append(claimed[0]!.id, { marker: "text_start", seq: 0, createdAt: Date.now() });
    await runs.complete(claimed[0]!.id, claimed[0]!.leaseToken!, { status: "ok", sessionId: session.id, reply: "ok" });

    const app = createApp({
      sessions,
      runs,
      runActivity,
      orchestrator: { handleTurn: async () => ({ status: "ok", sessionId: session.id, reply: "ok" }) } as never,
      surfaces: new Map(),
      directory: {
        resolve: async () => ({ id: user, type: "internal" }),
        list: async () => [],
        get: async () => null,
      } as never,
      config: {
        getSpendLimitDurable: async () => null,
        getSecurityPostureDurable: async () => "standard",
      } as never,
      blobTransfer: createMemoryBlobTransferStore(),
    } as never);

    assert.deepEqual(await app.deleteEphemeralSession(ambientTenant(), threadRef, user), { deleted: true });
    const leftSessions = await pool.query("SELECT count(*)::int AS c FROM sessions WHERE id = $1", [session.id]);
    const leftItems = await pool.query("SELECT count(*)::int AS c FROM items WHERE session_id = $1", [session.id]);
    const leftRuns = await pool.query("SELECT count(*)::int AS c FROM runs WHERE session_id = $1", [threadRef]);
    const leftAct = await pool.query("SELECT count(*)::int AS c FROM run_activity WHERE run_id = $1", [
      enqueued.run.id,
    ]);
    assert.equal(leftSessions.rows[0].c, 0);
    assert.equal(leftItems.rows[0].c, 0);
    assert.equal(leftRuns.rows[0].c, 0);
    assert.equal(leftAct.rows[0].c, 0);

    const stuckRef = `web:${user}:eph-stuck`;
    const stuck = await sessions.getOrCreateByThread(stuckRef, "dm", personal, undefined, "web", {
      ephemeral: true,
    });
    await sessions.addParticipant(stuck.id, user);
    await runs.enqueue({
      sessionId: stuckRef,
      request: {
        surface: "web",
        actor: { id: user, type: "internal" },
        conversation: { kind: "dm", threadRef: stuckRef, audience: [{ id: user, type: "internal" }] },
        origin: { kind: "human" },
        text: "still running",
        ephemeral: true,
      },
      maxAttempts: 1,
    });
    const expiredRef = `web:${user}:eph-expired`;
    const expired = await sessions.getOrCreateByThread(expiredRef, "dm", personal, undefined, "web", {
      ephemeral: true,
    });
    await sessions.addParticipant(expired.id, user);
    assert.equal(await app.purgeExpiredEphemeralSessions(Date.now() + 10_000), 1);
    assert.equal(await sessions.get(expired.id), null);
    assert.ok(await sessions.get(stuck.id), "in-flight ephemeral session must not be purged while active");
  } finally {
    await pool.end();
    await runActivity.close?.();
    await runs.close?.();
  }
});

test("ephemeral capability tokens block control-plane writes", async () => {
  const secret = "test-ephemeral-secret-0123456789";
  const server = createInsecureTestServer(
    {
      authorizesCapabilityScope: async () => true,
      listMemoryFacts: async () => [],
    } as never,
    {
      capabilitySecret: secret,
      runs: { get: async () => null } as never,
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const token = await mintCapabilityToken(
      {
        aud: CONTROL_PLANE_AUD,
        actorId: "alice@example.com",
        scopeId: scopeId("personal", "alice@example.com"),
        ephemeral: true,
        exp: Date.now() + 60_000,
      },
      secret,
    );
    const res = await fetch(`${url}/v1/memory/facts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": token,
      },
      body: JSON.stringify({ facts: [{ text: "should not save" }] }),
    });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "ephemeral_read_only");
    const projRes = await fetch(`${url}/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": token },
      body: JSON.stringify({ name: "should not create" }),
    });
    assert.equal(projRes.status, 403);
    assert.equal(((await projRes.json()) as { error: string }).error, "ephemeral_read_only");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
