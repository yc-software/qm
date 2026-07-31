import { test } from "node:test";
import assert from "node:assert/strict";
import { createCanManageScope, createManagesArtifactHome } from "../src/resolution/scope-membership.ts";
import { scopeId } from "../src/types.ts";

const admin = { adminStatusOf: async (p: { id: string }) => ({ isAdmin: p.id === "root" }) };

test("team/org artifact homes are managed by org admins, not by their creator", async () => {
  const manages = createManagesArtifactHome({ admin }, createCanManageScope({}));
  const org = scopeId("org", "default-org");
  const team = scopeId("team", "eng");
  assert.equal(await manages(org, "U1", "root"), true, "an org admin manages org-homed artifacts");
  assert.equal(await manages(team, "U1", "root"), true, "an org admin manages team-homed artifacts");
  assert.equal(await manages(org, "U1", "U1"), false, "the creator alone does not manage an org home");
  assert.equal(await manages(team, "U1", "U1"), false, "the creator alone does not manage a team home");
});

test("without an admin service, team/org homes fail closed for everyone", async () => {
  const manages = createManagesArtifactHome({}, createCanManageScope({}));
  assert.equal(await manages(scopeId("org", "default-org"), "U1", "U1"), false);
  assert.equal(await manages(scopeId("team", "eng"), "U1", "root"), false);
});

test("an admin service error fails closed rather than opening the door", async () => {
  const broken = {
    adminStatusOf: async () => {
      throw new Error("store down");
    },
  };
  const manages = createManagesArtifactHome({ admin: broken }, createCanManageScope({}));
  assert.equal(await manages(scopeId("org", "default-org"), "U1", "root"), false);
});

test("the admin door does not reach personal or shared homes", async () => {
  const manages = createManagesArtifactHome({ admin }, createCanManageScope({}));
  assert.equal(await manages(scopeId("personal", "U1"), "U1", "U1"), true, "personal owner unchanged");
  assert.equal(await manages(scopeId("personal", "U1"), "U1", "root"), false, "admins get no door into personal homes");
  assert.equal(
    await manages(scopeId("channel", "C1"), "U1", "root"),
    false,
    "channel homes stay membership-gated, not admin-gated",
  );
});
