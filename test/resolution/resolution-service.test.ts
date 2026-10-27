import { test } from "node:test";
import assert from "node:assert/strict";
import { composeInstructions, createResolutionService } from "../../src/resolution/resolution-service.ts";
import { createAclStore } from "../../src/acl/acl-store.ts";
import { scopeId, type Conversation, type Principal } from "../../src/types.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { testConfigStore, testDatabaseUrl } from "../support/test-database.ts";
import { createPostgresGrantStore } from "../../src/acl/postgres-grant-store.ts";

const actor: Principal = { id: "U1", type: "internal" };

async function setup() {
  const config = testConfigStore();
  await config.setInstructions(scopeId("personal", "U1"), "PERSONAL_INSTRUCTIONS");
  await config.setInstructions(scopeId("channel", "C1"), "CHANNEL_INSTRUCTIONS");
  return createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
}

test("DM mounts global + personal (the user's own workspace)", async () => {
  const res = await setup();
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  const mounts = r.layers.map((l) => l.scopeId);
  assert.deepEqual(mounts, [scopeId("org", "default-org"), scopeId("personal", "U1")]);
  assert.match(r.systemPrompt, /PERSONAL_INSTRUCTIONS/);
});

test("channel mounts ONLY global + that channel — never personal (spec §9)", async () => {
  const res = await setup();
  const conv: Conversation = {
    kind: "channel",
    threadRef: "C1:thread9",
    channelRef: "C1",
    audience: [actor],
  };
  const r = await res.resolve(conv, actor);
  const mounts = r.layers.map((l) => l.scopeId);
  assert.deepEqual(mounts, [scopeId("org", "default-org"), scopeId("channel", "C1")]);
  assert.equal(mounts.includes(scopeId("personal", "U1")), false);
  assert.match(r.systemPrompt, /CHANNEL_INSTRUCTIONS/);
  assert.doesNotMatch(r.systemPrompt, /PERSONAL_INSTRUCTIONS/);
});

test("resolution.systemPrompt is the org/scope policy layer only — protocol guidance moved to the orchestrator", async () => {
  const res = await setup();
  const dm: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const channel: Conversation = { kind: "channel", threadRef: "C1:thread9", channelRef: "C1", audience: [actor] };
  for (const conv of [dm, channel]) {
    const r = await res.resolve(conv, actor);
    assert.doesNotMatch(r.systemPrompt, /source code|GitHub/);
    assert.doesNotMatch(r.systemPrompt, /## Your computer/);
    assert.doesNotMatch(r.systemPrompt, /## Scheduling & self-configuration/);
    assert.doesNotMatch(r.systemPrompt, /v1\/crons/);
  }
});

test("egress floor includes the actor's team-scope denylist (resolved to the per-turn token)", async () => {
  const config = testConfigStore();
  await config.setSetting("egress", { allowedHosts: [], deniedHosts: ["org-bad.test"] }, scopeId("org", "default-org"));
  await config.setSetting("egress", { allowedHosts: [], deniedHosts: ["team-bad.test"] }, scopeId("team", "T1"));
  await config.setSetting("egress", { allowedHosts: [], deniedHosts: ["me-bad.test"] }, scopeId("personal", "U1"));
  const res = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const teamActor: Principal = { id: "U1", type: "internal", teamIds: ["T1"] };
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [teamActor] };
  const r = await res.resolve(conv, teamActor);
  assert.deepEqual((r.egress.deniedHosts ?? []).sort(), ["me-bad.test", "org-bad.test", "team-bad.test"]);
});

test("egress floor includes the conversation scope policy for shared rooms", async () => {
  const config = testConfigStore();
  await config.setSetting(
    "egress",
    {
      allowedHosts: ["channel-api.test"],
      deniedHosts: ["channel-bad.test"],
    },
    scopeId("channel", "C1"),
  );
  const res = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conv: Conversation = { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  assert.deepEqual(r.egress.allowedHosts, ["channel-api.test"]);
  assert.deepEqual(r.egress.deniedHosts, ["channel-bad.test"]);
});

test("the writable layer is the scope, global is read-only", async () => {
  const res = await setup();
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  const org = r.layers.find((l) => l.scopeId === scopeId("org", "default-org"));
  const personal = r.layers.find((l) => l.scopeId === scopeId("personal", "U1"));
  assert.equal(org?.mode, "ro");
  assert.equal(personal?.mode, "rw");
});

test("resolution refreshes security config written by another instance", async () => {
  const databaseUrl = testDatabaseUrl();
  const reader = testConfigStore({ databaseUrl });
  const personal = scopeId("personal", "U1");
  const db = createPgPool(databaseUrl);
  await db.q("INSERT INTO soul_configs (scope_id, content, version) VALUES ($1, 'FLEET_LIVE', 1)", [personal]);
  await db.q("INSERT INTO egress_policies (scope_id, policy) VALUES ($1, $2)", [
    personal,
    { allowedHosts: [], deniedHosts: ["blocked.example"] },
  ]);
  const res = createResolutionService(reader, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const resolved = await res.resolve(conv, actor);
  assert.match(resolved.systemPrompt, /FLEET_LIVE/);
  assert.deepEqual(resolved.egress.deniedHosts, ["blocked.example"]);
});

test("SOUL composition keeps organization precedence without duplicating identical policy", () => {
  assert.equal(composeInstructions(null, null), "");
  assert.equal(composeInstructions("  ", "\n"), "");
  assert.equal(composeInstructions("Org policy", " Org policy "), "## Organization instructions\nOrg policy");
  assert.equal(composeInstructions(null, "Scope policy"), "## Conversation instructions\nScope policy");
  const composed = composeInstructions("Org policy", "Scope policy");
  assert.ok(composed.indexOf("Org policy") < composed.indexOf("Scope policy"));
  assert.ok(composed.includes("organization instructions take precedence"));
});

test("external audiences receive no organization or scope policy", async () => {
  const config = testConfigStore();
  await config.setInstructions(scopeId("org", "default-org"), "PRIVATE_ORG");
  await config.setInstructions(scopeId("channel", "C1"), "PRIVATE_SCOPE");
  const resolution = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conversation: Conversation = { kind: "channel", channelRef: "C1", threadRef: "C1:t", audience: [actor] };
  assert.equal((await resolution.resolve(conversation, actor, true)).systemPrompt, "");
});
