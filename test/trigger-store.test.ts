import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoEscalation } from "../src/triggers/trigger-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresCronFireStore } from "../src/cron/fire-store.ts";
import { testDatabaseUrl, testMap } from "./support/test-database.ts";

test("assertNoEscalation: owner == createdBy is always allowed (no consent needed)", () => {
  assert.doesNotThrow(() => assertNoEscalation({ owner: "U1", createdBy: "U1" }));
});

test("assertNoEscalation: a different owner is rejected", () => {
  assert.throws(() => assertNoEscalation({ owner: "U2", createdBy: "U1" }), /owner must be/);
});

test("cron store enforces the shared anti-escalation guard at create time", async () => {
  const store = createCronStore(testMap(), { fires: createPostgresCronFireStore(testDatabaseUrl()) });
  const base = { action: "x", ownerScopeId: scopeId("personal", "U1"), schedule: { everyMs: 60_000 } };
  await assert.rejects(store.create({ ...base, owner: "U2", createdBy: "U1" }), /owner must be/);
});

test("webhook store enforces the shared anti-escalation guard at create time", async () => {
  const store = createWebhookStore(testMap(), testMap());
  const base = {
    ownerScopeId: scopeId("personal", "U1"),
    action: "triage",
    verification: { scheme: "github" as const, secret: "s" },
  };
  await assert.rejects(store.create({ ...base, owner: "U2", createdBy: "U1" }), /owner must be/);
});
