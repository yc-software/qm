import { test } from "node:test";
import assert from "node:assert/strict";
import { composeSoul, createResolutionService } from "../src/resolution/resolution-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import { testConfigStore, testConfigTables, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresGrantStore } from "../src/acl/postgres-grant-store.ts";
import { TEST_ROOT_SCOPE } from "./support/tenant.ts";

const actor: Principal = { id: "U1", type: "internal" };

async function setup() {
  const config = testConfigStore();
  await config.setSoul(scopeId("personal", "U1"), "PERSONAL_SOUL");
  await config.setSoul(scopeId("channel", "C1"), "CHANNEL_SOUL");
  return createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
}

test("DM mounts only personal (the user's own workspace)", async () => {
  const res = await setup();
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  const mounts = r.layers.map((l) => l.scopeId);
  assert.deepEqual(mounts, [scopeId("personal", "U1")]);
  assert.match(r.systemPrompt, /PERSONAL_SOUL/);
});

test("channel mounts ONLY that channel — never personal (spec §9)", async () => {
  const res = await setup();
  const conv: Conversation = {
    kind: "channel",
    threadRef: "C1:thread9",
    channelRef: "C1",
    audience: [actor],
  };
  const r = await res.resolve(conv, actor);
  const mounts = r.layers.map((l) => l.scopeId);
  assert.deepEqual(mounts, [scopeId("channel", "C1")]);
  assert.equal(mounts.includes(scopeId("personal", "U1")), false);
  assert.match(r.systemPrompt, /CHANNEL_SOUL/);
  assert.doesNotMatch(r.systemPrompt, /PERSONAL_SOUL/);
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
  await config.setEgress(TEST_ROOT_SCOPE, { allowedHosts: [], deniedHosts: ["org-bad.test"] });
  await config.setEgress(scopeId("team", "T1"), { allowedHosts: [], deniedHosts: ["team-bad.test"] });
  await config.setEgress(scopeId("personal", "U1"), { allowedHosts: [], deniedHosts: ["me-bad.test"] });
  const res = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const teamActor: Principal = { id: "U1", type: "internal", teamIds: ["T1"] };
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [teamActor] };
  const r = await res.resolve(conv, teamActor);
  assert.deepEqual((r.egress.deniedHosts ?? []).sort(), ["me-bad.test", "org-bad.test", "team-bad.test"]);
});

test("egress floor includes the conversation scope policy for shared rooms", async () => {
  const config = testConfigStore();
  await config.setEgress(scopeId("channel", "C1"), {
    allowedHosts: ["channel-api.test"],
    deniedHosts: ["channel-bad.test"],
  });
  const res = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conv: Conversation = { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  assert.deepEqual(r.egress.allowedHosts, ["channel-api.test"]);
  assert.deepEqual(r.egress.deniedHosts, ["channel-bad.test"]);
});

test("the writable layer is the scope and the tenant root is the org scope, not a mount", async () => {
  const res = await setup();
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  const personal = r.layers.find((l) => l.scopeId === scopeId("personal", "U1"));
  assert.equal(personal?.mode, "rw");
  assert.equal(r.orgScopeId, TEST_ROOT_SCOPE);
});

test("resolution carries the durable effective security posture", async () => {
  const config = testConfigStore({ defaultSecurityPosture: "dangerous" });
  await config.setSecurityPosture(TEST_ROOT_SCOPE, "auto");
  await config.setSecurityPosture(scopeId("personal", "U1"), "strict");
  const res = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const resolved = await res.resolve(conv, actor);
  assert.deepEqual(resolved.securityPolicy, {
    posture: "strict",
    screening: "enforce",
    denyPrivateNetworks: false,
    toolApprovals: "all",
  });
  assert.deepEqual(resolved.approvalGrantModes, { session: true, always: true }, "grant modes default to all-on");
});

test("resolution refreshes security config written by another instance", async () => {
  const tables = testConfigTables();
  const reader = testConfigStore({ tables });
  const personal = scopeId("personal", "U1");
  await tables.appendSoul({ scopeId: personal, content: "FLEET_LIVE", version: 1, updatedAt: 1 }, 0, 0);
  await tables.updateScopeSetting(personal, (row) => ({
    ...row,
    egress: { allowedHosts: [], deniedHosts: ["blocked.example"] },
  }));
  const res = createResolutionService(reader, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const resolved = await res.resolve(conv, actor);
  assert.match(resolved.systemPrompt, /FLEET_LIVE/);
  assert.deepEqual(resolved.egress.deniedHosts, ["blocked.example"]);
});

test("deployment screening mode is capped only by dangerous posture", async () => {
  const config = testConfigStore({ defaultSecurityPosture: "dangerous" });
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const expected = {
    off: { dangerous: "off", auto: "off", strict: "off" },
    observe: { dangerous: "observe", auto: "observe", strict: "observe" },
    enforce: { dangerous: "observe", auto: "enforce", strict: "enforce" },
  } as const;
  for (const mode of ["off", "observe", "enforce"] as const) {
    const res = createResolutionService(
      config,
      createAclStore(createPostgresGrantStore(testDatabaseUrl())),
      async () => mode,
    );
    for (const posture of ["dangerous", "auto", "strict"] as const) {
      await config.setSecurityPosture(scopeId("personal", "U1"), posture);
      const policy = (await res.resolve(conv, actor)).securityPolicy;
      assert.equal(policy.screening, expected[mode][posture], `${mode}/${posture}`);
      assert.equal(policy.toolApprovals, posture === "strict" ? "all" : "none");
    }
  }
});

test("SOUL composition keeps organization precedence without duplicating identical policy", () => {
  assert.equal(composeSoul(null, null), "");
  assert.equal(composeSoul("  ", "\n"), "");
  assert.equal(composeSoul("Org policy", " Org policy "), "## Organization instructions\nOrg policy");
  assert.equal(composeSoul(null, "Scope policy"), "## Conversation instructions\nScope policy");
  const composed = composeSoul("Org policy", "Scope policy");
  assert.ok(composed.indexOf("Org policy") < composed.indexOf("Scope policy"));
  assert.ok(composed.includes("organization instructions take precedence"));
});

test("external audiences receive no organization or scope policy", async () => {
  const config = testConfigStore();
  await config.setSoul(TEST_ROOT_SCOPE, "PRIVATE_ORG");
  await config.setSoul(scopeId("channel", "C1"), "PRIVATE_SCOPE");
  const resolution = createResolutionService(config, createAclStore(createPostgresGrantStore(testDatabaseUrl())));
  const conversation: Conversation = { kind: "channel", channelRef: "C1", threadRef: "C1:t", audience: [actor] };
  assert.equal((await resolution.resolve(conversation, actor, true)).systemPrompt, "");
});
