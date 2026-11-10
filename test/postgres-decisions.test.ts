import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createPostgresDecisionStore } from "../src/decisions/store.ts";
import type { DecisionRule } from "../src/decisions/decisions.ts";
import { testTenant as tenant } from "./support/test-tenant.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres decision tests";

beforeEach(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations, decision_rules, decision_providers CASCADE");
  await p.end();
});

const rule = (id: string, over: Partial<DecisionRule> = {}): DecisionRule => ({
  id,
  hook: "turn_start",
  question: "Is this a hard task?",
  options: {
    keep: { description: "ordinary", action: "keep" },
    deep: { description: "hard", action: "use_runtime", runtime: { modelId: "m-deep" } },
  },
  model: { provider: "gw", model: "example/decision-model" },
  mode: "enforce",
  onError: "keep",
  ...over,
});

test("pg decisions: providers and rules are rows; hooks load active rules only", { skip }, async () => {
  const store = createPostgresDecisionStore(URL!);
  const a = { actorId: "admin@x.com" };
  await store.saveProvider(tenant, { id: "gw", protocol: "chat-completions" }, a);
  await store.saveProvider(
    tenant,
    { id: "oa", protocol: "decisions", baseUrl: "https://dec.example", credential: "dec" },
    a,
  );
  assert.deepEqual(await store.providers(tenant), [
    { id: "gw", protocol: "chat-completions" },
    { id: "oa", protocol: "decisions", baseUrl: "https://dec.example", credential: "dec" },
  ]);

  await store.saveRule(tenant, rule("router"), a);
  await store.saveRule(tenant, rule("shadow", { mode: "observe" }), a);
  await store.saveRule(tenant, rule("off", { mode: "off" }), a);
  assert.deepEqual(
    (await store.rules(tenant)).map((r) => r.id),
    ["off", "router", "shadow"],
  );
  assert.deepEqual(await store.rules(tenant, "turn_start"), [rule("router"), rule("shadow", { mode: "observe" })]);

  await assert.rejects(store.saveRule(tenant, rule("second"), a), /allows one enforcing rule/);
  await assert.rejects(store.removeProvider(tenant, "gw"), /still used by a rule/);

  await store.saveRule(tenant, rule("router", { question: "Changed?" }), a);
  assert.equal((await store.rules(tenant, "turn_start")).find((r) => r.id === "router")?.question, "Changed?");

  assert.deepEqual(await store.providers(tenant, ["oa"]), [
    { id: "oa", protocol: "decisions", baseUrl: "https://dec.example", credential: "dec" },
  ]);

  for (const r of await store.rules(tenant)) await store.removeRule(tenant, r.id);
  await store.removeProvider(tenant, "gw");
  assert.deepEqual(
    (await store.providers(tenant)).map((p) => p.id),
    ["oa"],
  );
});
