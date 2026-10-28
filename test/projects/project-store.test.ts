import "../support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectStore, projectGroupRef, projectScopeId } from "../../src/projects/project-store.ts";
import {
  createCanManageScope,
  createCanReadScope,
  createCurrentScopeMembers,
  createIsCurrentSharedScopeMember,
  createMembershipControlsScope,
} from "../../src/resolution/scope-membership.ts";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { createNoopAdvisoryLock } from "../support/in-process-stores.ts";

const projectStore = (opts: { id: () => string; now?: () => number }) =>
  createProjectStore(testDatabaseUrl(), { advisoryLock: createNoopAdvisoryLock(), ...opts });

test("ProjectStore atomically maintains a managed-group roster", async () => {
  let at = 10;
  const projects = projectStore({ id: () => "p1", now: () => at++ });
  const project = await projects.create({ name: "  Launch Cohort  ", ownerId: "owner" });
  const initialVersion = await projects.version(projectGroupRef(project.id));
  assert.equal(project.name, "Launch Cohort");
  assert.equal(projectScopeId(project.id), "group:web-project-p1");

  await Promise.all([projects.addMember(project.id, "owner", "alice"), projects.addMember(project.id, "owner", "bob")]);
  assert.deepEqual(new Set((await projects.get(project.id))!.memberIds), new Set(["owner", "alice", "bob"]));
  assert.notEqual(await projects.version(projectGroupRef(project.id)), initialVersion);
  assert.equal((await projects.addMember(project.id, "alice", "mallory")).status, "ok");
  assert.equal((await projects.addMember(project.id, "outsider", "eve")).status, "forbidden");
  assert.equal((await projects.removeMember(project.id, "bob", "mallory")).status, "forbidden");
  assert.equal((await projects.removeMember(project.id, "owner", "owner")).status, "invalid_member");
  assert.equal(await projects.membership(projectGroupRef(project.id), "alice"), true);
  assert.deepEqual(await projects.members(projectGroupRef(project.id)), ["owner", "alice", "bob", "mallory"]);
  assert.equal(await projects.name(projectGroupRef(project.id)), "Launch Cohort");
});

test("session lists check each project once per request and observe membership changes", async () => {
  const built = buildApp(testConfig());
  try {
    const project = await built.projects.create({ name: "Shared history", ownerId: "owner" });
    await built.projects.addMember(project.id, "owner", "member");
    for (let i = 0; i < 50; i++) {
      const session = await built.sessions.getOrCreateByThread(
        `web:member:history-${i}`,
        "group",
        projectScopeId(project.id),
      );
      await built.sessions.addParticipant(session.id, "member", undefined, { includeHistory: true });
      await built.sessions.updateTitle(session.id, `History ${i}`);
    }
    const get = built.projects.get.bind(built.projects);
    const membership = built.projects.membership.bind(built.projects);
    let gets = 0;
    let memberships = 0;
    built.projects.get = async (id) => {
      gets++;
      return get(id);
    };
    built.projects.membership = async (ref, principal) => {
      memberships++;
      return membership(ref, principal);
    };
    assert.equal((await built.app.listSessions("member")).length, 50);
    assert.equal(gets, 1);
    assert.equal(memberships, 1);
    await built.projects.removeMember(project.id, "owner", "member");
    assert.deepEqual(await built.app.listSessions("member"), []);
    assert.equal(gets, 2);
    assert.equal(memberships, 2);
  } finally {
    await built.runtime.stop();
  }
});

test("ProjectStore rename is owner-only and cleans the name", async () => {
  let at = 100;
  const projects = projectStore({ id: () => "pr", now: () => at++ });
  const project = await projects.create({ name: "Before", ownerId: "owner" });
  const versionBefore = await projects.version(projectGroupRef(project.id));
  assert.equal((await projects.rename(project.id, "mallory", "Hijacked")).status, "forbidden");
  assert.equal((await projects.rename("missing", "owner", "After")).status, "not_found");
  assert.equal((await projects.rename(project.id, "owner", "   ")).status, "invalid_name");
  assert.equal(await projects.name(projectGroupRef(project.id)), "Before");
  const renamed = await projects.rename(project.id, "owner", "  After   Hours  ");
  assert.equal(renamed.status, "ok");
  assert.ok(renamed.status === "ok" && renamed.project.name === "After Hours" && renamed.changed);
  assert.equal(await projects.name(projectGroupRef(project.id)), "After Hours");
  assert.equal(
    await projects.version(projectGroupRef(project.id)),
    versionBefore,
    "rename is not a roster change: in-flight turns and approvals stay current",
  );
  const same = await projects.rename(project.id, "owner", "After Hours");
  assert.ok(same.status === "ok" && !same.changed);
});

test("ProjectStore slack-channel link is member-managed and not a roster change", async () => {
  let at = 500;
  const projects = projectStore({ id: () => "sl", now: () => at++ });
  const project = await projects.create({ name: "Linked", ownerId: "owner" });
  await projects.addMember(project.id, "owner", "member");
  const groupRef = projectGroupRef(project.id);
  const versionBefore = await projects.version(groupRef);

  assert.equal(
    (await projects.setSlackChannel(project.id, "outsider", { channelId: "C1", channelName: "eng" })).status,
    "forbidden",
  );
  assert.equal(await projects.slackChannel(groupRef), undefined);

  const linked = await projects.setSlackChannel(project.id, "member", { channelId: "C1", channelName: "eng" });
  assert.ok(linked.status === "ok" && linked.changed);
  const link = await projects.slackChannel(groupRef);
  assert.equal(link?.channelId, "C1");
  assert.equal(link?.channelName, "eng");
  assert.equal(link?.linkedBy, "member");
  assert.equal((await projects.get(project.id))?.slackChannel?.channelId, "C1");

  const same = await projects.setSlackChannel(project.id, "owner", { channelId: "C1", channelName: "eng" });
  assert.ok(same.status === "ok" && !same.changed);
  assert.equal(
    await projects.version(groupRef),
    versionBefore,
    "linking is not a roster change: in-flight turns and approvals stay current",
  );

  const relinked = await projects.setSlackChannel(project.id, "owner", { channelId: "C2", channelName: "ops" });
  assert.ok(relinked.status === "ok" && relinked.changed);
  assert.equal((await projects.slackChannel(groupRef))?.linkedBy, "owner");

  assert.equal((await projects.setSlackChannel(project.id, "outsider", null)).status, "forbidden");
  const unlinked = await projects.setSlackChannel(project.id, "member", null);
  assert.ok(unlinked.status === "ok" && unlinked.changed);
  assert.equal(await projects.slackChannel(groupRef), undefined);
  const noop = await projects.setSlackChannel(project.id, "member", null);
  assert.ok(noop.status === "ok" && !noop.changed);
  assert.equal((await projects.setSlackChannel("missing", "owner", null)).status, "not_found");
});

test("ProjectStore derives membership from the linked channel roster", async () => {
  let at = 900;
  const projects = projectStore({ id: () => "dr", now: () => at++ });
  const project = await projects.create({ name: "Derived", ownerId: "owner" });
  const groupRef = projectGroupRef(project.id);

  // no link yet: sync is refused
  assert.equal((await projects.syncChannelMembers(project.id, ["chan-pal"])).status, "forbidden");

  await projects.setSlackChannel(project.id, "owner", { channelId: "C1", channelName: "eng" });
  const versionLinked = await projects.version(groupRef);
  const synced = await projects.syncChannelMembers(project.id, ["chan-pal", "owner"]);
  assert.ok(synced.status === "ok" && synced.changed);
  assert.notEqual(await projects.version(groupRef), versionLinked, "derived roster change bumps the scope version");

  // union semantics: manual + derived, deduped
  assert.deepEqual(await projects.members(groupRef), ["owner", "chan-pal"]);
  assert.equal(await projects.membership(groupRef, "chan-pal"), true);
  assert.ok((await projects.listForMember("chan-pal")).some((candidate) => candidate.id === project.id));

  // idempotent re-sync: no version churn
  const versionAfter = await projects.version(groupRef);
  const again = await projects.syncChannelMembers(project.id, ["owner", "chan-pal"]);
  assert.ok(again.status === "ok" && !again.changed);
  assert.equal(await projects.version(groupRef), versionAfter);

  // channel rename flows through without a roster-version bump
  const renamed = await projects.syncChannelMembers(project.id, ["owner", "chan-pal"], "eng-renamed");
  assert.ok(renamed.status === "ok" && renamed.changed);
  assert.equal((await projects.slackChannel(groupRef))?.channelName, "eng-renamed");
  assert.equal(await projects.version(groupRef), versionAfter);

  // unlink drops the derived members with the link
  await projects.setSlackChannel(project.id, "owner", null);
  assert.deepEqual(await projects.members(groupRef), ["owner"]);
  assert.equal(await projects.membership(groupRef, "chan-pal"), false);
});

test("managed groups override Slack membership and historical sessions grant no access", async () => {
  const projects = projectStore({ id: () => "managed" });
  const project = await projects.create({ name: "Managed", ownerId: "owner" });
  const managedScope = projectScopeId(project.id);
  const deps = {
    managedGroups: projects,
    directory: {
      channelMember: async (_channelId: string, principalId: string) => principalId === "owner",
      groupMember: async (_groupId: string, principalId: string) => principalId === "outsider",
      channelPrivacy: async (channelId: string) => channelId !== "public-channel",
      conversationMembers: async (kind: "channel" | "group", id: string) => {
        if (kind === "group" && id === "slack-group") return [{ principalId: "outsider", type: "internal" }];
        if (kind === "channel" && id === "private-channel") return [{ principalId: "owner", type: "internal" }];
        return undefined;
      },
      channelMembership: async (channelId: string, principalId: string) =>
        channelId === "private-channel" ? principalId === "owner" : undefined,
      groupMembership: async (groupId: string, principalId: string) =>
        groupId === "slack-group" ? principalId === "outsider" : undefined,
    },
  };
  const canRead = createCanReadScope(deps);
  const canManage = createCanManageScope(deps);
  const isCurrentMember = createIsCurrentSharedScopeMember(deps);
  const membershipControls = createMembershipControlsScope(deps);
  const currentMembers = createCurrentScopeMembers(deps);

  assert.equal(await canRead("owner", managedScope), true);
  assert.equal(await canRead("outsider", managedScope), false);
  assert.equal(await canManage("outsider", managedScope), false);
  assert.equal(await canRead("outsider", "group:slack-group"), true);
  assert.equal(await canRead("historical", "group:slack-group"), false);
  assert.equal(await isCurrentMember("historical", "group:slack-group"), false);
  assert.equal(await membershipControls("group:slack-group"), true);
  assert.equal(await membershipControls("channel:private-channel"), true);
  assert.equal(await membershipControls("channel:public-channel"), false);
  assert.deepEqual(
    (await currentMembers(managedScope))?.map((member) => member.id),
    ["owner"],
  );
  assert.deepEqual(
    (await currentMembers("group:slack-group"))?.map((member) => member.id),
    ["outsider"],
  );
  assert.deepEqual(
    (await currentMembers("channel:private-channel"))?.map((member) => member.id),
    ["owner"],
  );
});

test("capability scope checks follow current shared rosters", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([{ principalId: "member", displayName: "Member", type: "internal" }]);
  await built.directory.replaceChannels(
    [
      { channelId: "C-public", name: "public" },
      { channelId: "C-private", name: "private", isPrivate: true },
    ],
    [
      { channelId: "C-public", principalId: "member" },
      { channelId: "C-private", principalId: "member" },
      { channelId: "C-private", principalId: "B1" },
    ],
    1,
  );
  await built.directory.replaceGroups([{ groupId: "G1", principalId: "member" }], 1);

  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "channel:C-private" }), true);
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "B1", scopeId: "channel:C-private" }), true);
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "group:G1" }), true);
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "channel:C-public" }), true);

  await built.directory.replaceChannels(
    [
      { channelId: "C-public", name: "public" },
      { channelId: "C-private", name: "private", isPrivate: true },
    ],
    [],
    2,
  );
  await built.directory.replaceGroups([], 2);

  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "channel:C-private" }), false);
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "group:G1" }), false);
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "channel:C-public" }), true);
});

test("capability scope checks honor a linked identity's room membership", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([
    { principalId: "slack-person@example.com", displayName: "Person", type: "internal" },
  ]);
  await built.directory.replaceChannels(
    [{ channelId: "C-private", name: "private", isPrivate: true }],
    [{ channelId: "C-private", principalId: "slack-person@example.com" }],
    1,
  );
  await built.directory.replaceGroups([{ groupId: "G1", principalId: "slack-person@example.com" }], 1);
  const check = (actorId: string, scopeId: string) => built.app.authorizesCapabilityScope({ actorId, scopeId });

  assert.equal(await check("web-person", "channel:C-private"), false);
  await built.principalLinks.link({
    principalId: "slack-person@example.com",
    canonicalId: "web-person",

    linkedBy: "web-person",
  });
  assert.equal(await check("web-person", "channel:C-private"), true);
  assert.equal(await check("web-person", "group:G1"), true);
  assert.equal(await check("someone-else", "channel:C-private"), false);

  await built.directory.replaceChannels([{ channelId: "C-private", name: "private", isPrivate: true }], [], 2);
  assert.equal(await check("web-person", "channel:C-private"), false);
  await built.principalLinks.unlink("slack-person@example.com");
  assert.equal(await check("web-person", "group:G1"), false);
});

test("channel capabilities bridge legacy public rosters but still honor deactivation", async () => {
  const built = buildApp(testConfig());
  await built.app.upsertDirectory([{ principalId: "member", displayName: "Member", type: "internal" }]);
  await built.directory.replaceChannels([{ channelId: "C-public", name: "public" }], []);
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "channel:C-public" }), true);
  await built.identity.deactivate("member");
  assert.equal(await built.app.authorizesCapabilityScope({ actorId: "member", scopeId: "channel:C-public" }), false);
});
