import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPgPool, migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testTenant } from "./support/test-tenant.ts";

test("a deploy clears a default computer only while a bot-marked turn's set is still in force", async () => {
  const url = testDatabaseUrl();
  const { app, sessions, sandboxResources, auditLog } = buildApp(testConfig({ databaseUrl: url }));
  await migrateRegisteredPgSchemas(url);
  const scoped = (scopeId: string) => sandboxResources.forTurn({ actorId: "U1", scopeId, isCurrent: async () => true });
  const computer = async (scope: string) => (await scoped(scope).create("U1", scope, "sprites")).id;
  const wake = { surface: "slack", origin: { kind: "human" }, text: "go", async: true } as const;
  const set = async (scope: string, sandboxId: string, bot?: "admitted" | "refused") => {
    const conversation = { kind: "channel", threadRef: `slack:${scope.slice(8)}:${bot ?? "person"}` } as const;
    const { runId } = await app.turn({ ...wake, actor: { externalId: "U1" }, botActor: !!bot, conversation });
    const items: never[] = [];
    const put = (_: string, input: { sandboxId: string }) => scoped(scope).setDefault("U1", scope, input.sandboxId);
    const current = bot === "refused" ? {} : { sandboxResources: put };
    const ref = { current, emit: async (item: never) => void items.push(item), scopeLabel: scope };
    const sandbox = createAgentTools(ref as never, { sandboxResources: true }).find((t) => t.name === "sandbox")!;
    const args = { action: "set_default", sandbox_id: sandboxId, purpose: "go" };
    await sandbox.execute(conversation.threadRef, args as never, undefined, undefined, undefined as never);
    const session = await sessions.getOrCreateByThread(conversation.threadRef, "channel", scope, "c", "slack");
    await sessions.appendMany({ sessionId: session.id, turnId: runId }, items);
    return { runId, threadRef: conversation.threadRef };
  };
  const [a, b, c, d] = ["channel:C1", "channel:C2", "channel:C3", "channel:C4"] as const;
  const from = await set(a, await computer(a), "admitted");
  const kept = await computer(b);
  await set(b, kept, "admitted");
  const admin = { at: Date.now(), principalId: "U1", action: "sandbox.default", resource: kept, scopeLabel: b };
  await auditLog.recordOnce!(testTenant, "admin", admin);
  await set(c, await computer(c), "admitted");
  await scoped(c).setDefault("U1", c, await computer(c));
  await set(d, await computer(d));
  await set(d, (await sandboxResources.resolve(d))!.id, "refused");
  const resolve = () => Promise.all([a, b, c, d].map((scope) => sandboxResources.resolve(scope)));
  const [before, pg] = [await resolve(), createPgPool(url)];
  await pg.q("DELETE FROM qm_schema_migrations WHERE id = 'durable-map/sandbox_defaults/0040-clear-bot-set-defaults'");
  await migrateRegisteredPgSchemas(url);
  await pg.close();
  assert.deepEqual(await resolve(), [null, ...before.slice(1)]);
  const audit = await auditLog.tail(testTenant, { limit: 10, action: "sandbox.default" });
  const rows = audit.map((e) => [e.principalId, e.resource, e.scopeLabel, e.detail && JSON.parse(e.detail)]);
  assert.deepEqual(rows, [
    ["system:migration", "null", a, { ...from, previousSandboxId: before[0]!.id, botActor: true }],
    ["U1", kept, b, undefined],
  ]);
});
