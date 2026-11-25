import test from "node:test";
import assert from "node:assert/strict";
import { createCanManageScope } from "../src/resolution/scope-membership.ts";
import { administersCron, administersWebhook, canAdministerCron, cronTaskRewrite } from "../src/api/control-service.ts";
import type { Cron, Webhook } from "../src/triggers/types.ts";
import { scopeId } from "../src/types.ts";

const identity = { classify: () => ({ type: "internal" }) };

const app = {
  isCurrentSharedScopeMember: async () => false,
  artifactGrantPermission: async () => null,
  membershipControlsScope: async () => false,
  managesScope: createCanManageScope({ identity }),
  isOrgAdmin: async (id: string) => id === "admin@x.com",
  samePerson: async (a: string, b: string) => a === b,
};

test("org admins act on anyone's crons and webhooks by id, lists keep the shared check, task edits keep the owner", async () => {
  const cron = {
    id: "c1",
    owner: "bob@x.com",
    createdBy: "bob@x.com",
    ownerScopeId: scopeId("personal", "bob@x.com"),
  } as Cron;
  assert.equal(await administersCron(app, cron, { actorId: "admin@x.com" }), true);
  assert.equal(await administersCron(app, cron, { actorId: "carol@x.com" }), false);
  assert.equal(await administersCron(app, cron, { actorId: "admin@x.com", botActor: true }), false);
  assert.equal(await canAdministerCron(app, cron, { actorId: "admin@x.com" }), false, "lists show only their own");
  assert.equal((await cronTaskRewrite(app, cron, "admin@x.com")).owner, undefined);
  const hook = { owner: "bob@x.com", ownerScopeId: scopeId("personal", "bob@x.com") } as Webhook;
  assert.equal(await administersWebhook(app, hook, { actorId: "admin@x.com" }), true);
  assert.equal(await administersWebhook(app, hook, { actorId: "carol@x.com" }), false);
});
