import test from "node:test";
import assert from "node:assert/strict";
import { createCanManageScope, createManagesArtifactHome } from "../src/resolution/scope-membership.ts";
import { canAdministerCron, canAdministerWebhook, cronTaskRewrite } from "../src/api/control-service.ts";
import type { Cron, Webhook } from "../src/triggers/types.ts";
import { scopeId } from "../src/types.ts";

const identity = { classify: () => ({ type: "internal" }) };
const isOrgAdmin = async (id: string) => id === "admin@x.com";

test("org admins manage every scope and artifact home", async () => {
  const manage = createCanManageScope({ identity, isOrgAdmin });
  const home = createManagesArtifactHome({ identity, isOrgAdmin }, manage);
  const bobs = scopeId("personal", "bob@x.com");
  assert.equal(await manage("admin@x.com", bobs), true);
  assert.equal(await manage("carol@x.com", bobs), false);
  assert.equal(await home(bobs, "bob@x.com", "admin@x.com"), true);
  assert.equal(await home(bobs, "bob@x.com", "carol@x.com"), false);
});

const app = {
  isCurrentSharedScopeMember: async () => false,
  artifactGrantPermission: async () => null,
  membershipControlsScope: async () => false,
  managesScope: async () => false,
  samePerson: async (a: string, b: string) => a === b,
  isOrgAdmin,
};

test("org admins administer anyone's crons and webhooks, and task edits keep the owner", async () => {
  const cron = {
    id: "c1",
    owner: "bob@x.com",
    createdBy: "bob@x.com",
    ownerScopeId: scopeId("personal", "bob@x.com"),
  } as Cron;
  assert.equal(await canAdministerCron(app, cron, { actorId: "admin@x.com" }), true);
  assert.equal(await canAdministerCron(app, cron, { actorId: "carol@x.com" }), false);
  assert.equal(await canAdministerCron(app, cron, { actorId: "admin@x.com", botActor: true }), false);
  assert.equal((await cronTaskRewrite(app, cron, "admin@x.com", true)).owner, undefined);
  const hook = { owner: "bob@x.com", ownerScopeId: scopeId("personal", "bob@x.com") } as Webhook;
  assert.equal(await canAdministerWebhook(app, hook, { actorId: "admin@x.com" }), true);
  assert.equal(await canAdministerWebhook(app, hook, { actorId: "carol@x.com" }), false);
});
