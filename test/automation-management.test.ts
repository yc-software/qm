import { test } from "node:test";
import assert from "node:assert/strict";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createAutomationService, canManageAutomation } from "../src/triggers/automation-service.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { scopeId } from "../src/types.ts";

const base = {
  owner: "owner",
  createdBy: "owner",
  ownerScopeId: scopeId("personal", "owner"),
  action: "Review events",
};

for (const kind of ["cron", "webhook"] as const) {
  test(`${kind} shares audited management without losing trigger configuration`, async () => {
    const audit = createAuditLog();
    const service =
      kind === "cron"
        ? createAutomationService(kind, createCronStore(), audit)
        : createAutomationService(kind, createWebhookStore(), audit);
    const original = await service.create({
      ...base,
      schedule: { everyMs: 60_000 },
      verification: { scheme: "github", secret: "test-secret" },
    });
    await service.update(
      original.id,
      { title: "  Daily   review ", action: "Review new events", archived: true },
      "editor",
    );
    const archived = await service.get(original.id);
    assert.equal(archived?.title, "Daily review");
    assert.equal(archived?.action, "Review new events");
    assert.equal(archived?.enabled, false);
    await service.setEnabled(original.id, true, "editor");
    const restored = await service.get(original.id);
    assert.equal(restored?.archived, false);
    assert.equal(restored?.enabled, true);
    assert.equal(restored?.owner, original.owner);
    if (restored && "schedule" in restored && "schedule" in original)
      assert.deepEqual(restored.schedule, original.schedule);
    if (restored && "verification" in restored && "verification" in original)
      assert.deepEqual(restored.verification, original.verification);
    await service.setDestination(original.id, undefined, "editor");
    await service.delete(original.id, "editor");
    assert.equal(await service.get(original.id), null);
    const events = await audit.events();
    assert.deepEqual(
      events.map((e) => e.action),
      ["create", "update", "enable", "retarget", "delete"].map((operation) => `${kind}_${operation}`),
    );
    assert.deepEqual(
      events.map((e) => e.principalId),
      ["owner", "editor", "editor", "editor", "editor"],
    );
    await service.update(original.id, { title: "missing" }, "editor");
    await service.setEnabled(original.id, true, "editor");
    await service.delete(original.id, "editor");
    assert.equal((await audit.events()).length, events.length);
  });
}

test("membership-controlled management cannot fall through to owner or extra access", async () => {
  const access = {
    membershipControlsScope: async () => true,
    managesScope: async () => false,
    samePerson: async () => true,
  };
  assert.equal(await canManageAutomation(access, base, "owner", undefined, async () => true), false);
  access.membershipControlsScope = async () => false;
  assert.equal(await canManageAutomation(access, base, "owner"), true);
  access.samePerson = async () => false;
  assert.equal(await canManageAutomation(access, base, "other"), false);
  assert.equal(await canManageAutomation(access, base, "other", undefined, async () => true), true);
});

test("rejected management rules leave state and audit untouched", async () => {
  const audit = createAuditLog();
  const service = createAutomationService("cron", createCronStore(), audit, {
    update: async () => {
      throw new Error("denied");
    },
  });
  const cron = await service.create({ ...base, schedule: { everyMs: 60_000 } });
  await assert.rejects(service.update(cron.id, { archived: true }, "editor"), /denied/);
  assert.equal((await service.get(cron.id))?.enabled, true);
  assert.equal((await audit.events()).length, 1);
});
