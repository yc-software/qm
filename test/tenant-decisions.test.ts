import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresDecisionStore } from "../src/decisions/store.ts";
import { createDecisionHooks } from "../src/decisions/hooks.ts";
import type { DecisionBackend, DecisionRule } from "../src/decisions/decisions.ts";
import type { AuditLog } from "../src/audit/audit-log.ts";
import { withTenant } from "../src/tenants/context.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";
import { nonOwnerLogin } from "./support/non-owner.ts";

const skip = process.env.DATABASE_URL ? false : "set DATABASE_URL (a Postgres) to run the tenancy tests";

const rule = (id: string, provider: string): DecisionRule => ({
  id,
  hook: "turn_start",
  question: "Is this a hard task?",
  options: {
    keep: { description: "ordinary", action: "keep" },
    deep: { description: "hard", action: "use_runtime", runtime: { modelId: "m-deep" } },
  },
  model: { provider, model: "example/decision-model" },
  mode: "enforce",
  onError: "keep",
});

test("each tenant reads and enforces only its own decision providers and rules", { skip }, async () => {
  const databaseUrl = testMigratedDatabaseUrl();
  const [a, b] = [randomUUID(), randomUUID()];
  const owner = new pg.Pool({ connectionString: databaseUrl });
  for (const tenant of [a, b]) await owner.query("INSERT INTO tenants(id) VALUES ($1)", [tenant]);
  await owner.end();
  const store = createPostgresDecisionStore(await nonOwnerLogin(databaseUrl));
  const by = { actorId: "admin@x.com" };
  await withTenant(a, async () => {
    await store.saveProvider(
      { id: "a-cls", protocol: "decisions", baseUrl: "https://a.example", credential: "a-key" },
      by,
    );
    await store.saveRule(rule("a-router", "a-cls"), by);
  });
  await withTenant(b, () => store.saveProvider({ id: "b-gw", protocol: "chat-completions" }, by));

  const seen: { provider: string; state: string }[] = [];
  const backend: DecisionBackend = {
    async choose({ questions, state, model }) {
      seen.push({ provider: model.provider, state });
      return Object.fromEntries(Object.keys(questions).map((k) => [k, { keep: 1, deep: 0 }]));
    },
  };
  const audit = { record() {} } as unknown as AuditLog;
  const decide = createDecisionHooks(store, backend, audit);

  await withTenant(a, async () => {
    assert.deepEqual(
      (await store.providers()).map((p) => p.id),
      ["a-cls"],
    );
    await decide("turn_start", "tenant A input", { scopeLabel: "org:a", sessionId: "sa" });
  });
  assert.deepEqual(seen, [{ provider: "a-cls", state: "tenant A input" }]);

  await withTenant(b, () => decide("turn_start", "tenant B secret", { scopeLabel: "org:b", sessionId: "sb" }));
  assert.deepEqual(seen, [{ provider: "a-cls", state: "tenant A input" }]);
  await withTenant(b, async () => {
    assert.deepEqual(await store.providers(), [{ id: "b-gw", protocol: "chat-completions" }]);
    assert.deepEqual(await store.rules("turn_start"), []);
  });
});
