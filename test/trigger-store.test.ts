import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoEscalation } from "../src/triggers/trigger-store.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { scopeId } from "../src/types.ts";

test("assertNoEscalation: owner == createdBy is always allowed (no consent needed)", () => {
  assert.doesNotThrow(() => assertNoEscalation({ owner: "U1", createdBy: "U1" }));
});

test("assertNoEscalation: a different owner WITHOUT consent is rejected", () => {
  assert.throws(() => assertNoEscalation({ owner: "U2", createdBy: "U1" }), /consent/);
});

test("assertNoEscalation: a different owner WITH consent is allowed", () => {
  assert.doesNotThrow(() => assertNoEscalation({ owner: "U2", createdBy: "U1", ownerConsentedAt: 123 }));
});

test("assertNoEscalation: a falsy/zero consent timestamp does NOT satisfy consent", () => {
  assert.throws(() => assertNoEscalation({ owner: "U2", createdBy: "U1", ownerConsentedAt: 0 }), /consent/);
});

test("cron store enforces the shared anti-escalation guard at create time", async () => {
  const store = createCronStore();
  const base = { action: "x", ownerScopeId: scopeId("personal", "U1"), schedule: { everyMs: 60_000 } };
  await assert.rejects(store.create({ ...base, owner: "U2", createdBy: "U1" }), /consent/);
  const cron = await store.create({ ...base, owner: "U2", createdBy: "U1", ownerConsentedAt: Date.now() });
  assert.equal(cron.owner, "U2");
});

test("webhook store enforces the shared anti-escalation guard at create time", async () => {
  const store = createWebhookStore();
  const base = {
    ownerScopeId: scopeId("personal", "U1"),
    action: "triage",
    verification: { scheme: "github" as const, secret: "s" },
  };
  await assert.rejects(store.create({ ...base, owner: "U2", createdBy: "U1" }), /consent/);
  const wh = await store.create({ ...base, owner: "U2", createdBy: "U1", ownerConsentedAt: Date.now() });
  assert.equal(wh.owner, "U2");
});
