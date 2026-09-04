import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryConfigStore } from "../src/resolution/config-store.ts";
import { createResolutionService } from "../src/resolution/resolution-service.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId, type Conversation, type Principal } from "../src/types.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { PersistedEgressPolicy, PersistedSoul } from "../src/resolution/config-store.ts";

const actor: Principal = { id: "U1", type: "internal" };

function setup() {
  const config = createMemoryConfigStore("default-org");
  config.setSoul(scopeId("personal", "U1"), "PERSONAL_SOUL");
  config.setSoul(scopeId("channel", "C1"), "CHANNEL_SOUL");
  return createResolutionService("default-org", config, createAclStore());
}

test("DM mounts global + personal (the user's own workspace)", async () => {
  const res = setup();
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  const mounts = r.layers.map((l) => l.scopeId);
  assert.deepEqual(mounts, [scopeId("org", "default-org"), scopeId("personal", "U1")]);
  assert.match(r.systemPrompt, /PERSONAL_SOUL/);
});

test("channel mounts ONLY global + that channel — never personal (spec §9)", async () => {
  const res = setup();
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
  assert.match(r.systemPrompt, /CHANNEL_SOUL/);
  assert.doesNotMatch(r.systemPrompt, /PERSONAL_SOUL/);
});

test("resolution.systemPrompt is the org/scope policy layer only — protocol guidance moved to the orchestrator", async () => {
  const res = setup();
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
  const config = createMemoryConfigStore("default-org");
  config.setEgress(scopeId("org", "default-org"), { allowedHosts: [], deniedHosts: ["org-bad.test"] });
  config.setEgress(scopeId("team", "T1"), { allowedHosts: [], deniedHosts: ["team-bad.test"] });
  config.setEgress(scopeId("personal", "U1"), { allowedHosts: [], deniedHosts: ["me-bad.test"] });
  const res = createResolutionService("default-org", config, createAclStore());
  const teamActor: Principal = { id: "U1", type: "internal", teamIds: ["T1"] };
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [teamActor] };
  const r = await res.resolve(conv, teamActor);
  assert.deepEqual((r.egress.deniedHosts ?? []).sort(), ["me-bad.test", "org-bad.test", "team-bad.test"]);
});

test("egress floor includes the conversation scope policy for shared rooms", async () => {
  const config = createMemoryConfigStore("default-org");
  config.setEgress(scopeId("channel", "C1"), { allowedHosts: ["channel-api.test"], deniedHosts: ["channel-bad.test"] });
  const res = createResolutionService("default-org", config, createAclStore());
  const conv: Conversation = { kind: "channel", threadRef: "C1:t1", channelRef: "C1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  assert.deepEqual(r.egress.allowedHosts, ["channel-api.test"]);
  assert.deepEqual(r.egress.deniedHosts, ["channel-bad.test"]);
});

test("the writable layer is the scope, global is read-only", async () => {
  const res = setup();
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const r = await res.resolve(conv, actor);
  const org = r.layers.find((l) => l.scopeId === scopeId("org", "default-org"));
  const personal = r.layers.find((l) => l.scopeId === scopeId("personal", "U1"));
  assert.equal(org?.mode, "ro");
  assert.equal(personal?.mode, "rw");
});

test("resolution carries the durable effective security posture", async () => {
  const config = createMemoryConfigStore("default-org", { defaultSecurityPosture: "dangerous" });
  await config.setSecurityPosture(scopeId("org", "default-org"), "auto");
  await config.setSecurityPosture(scopeId("personal", "U1"), "strict");
  const res = createResolutionService("default-org", config, createAclStore());
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const resolved = await res.resolve(conv, actor);
  assert.deepEqual(resolved.securityPolicy, {
    inboundScreening: "off",
    toolApprovals: "all",
  });
  assert.deepEqual(resolved.approvalGrantModes, { session: true, always: true }, "grant modes default to all-on");
});

test("resolution refreshes security config written by another instance", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const egressPolicies = createMemoryMap<PersistedEgressPolicy>();
  const reader = createMemoryConfigStore("default-org", { souls, egressPolicies });
  const personal = scopeId("personal", "U1");
  await souls.put(personal, { scopeId: personal, content: "FLEET_LIVE", version: 1 });
  await egressPolicies.put(personal, {
    scopeId: personal,
    policy: { allowedHosts: [], deniedHosts: ["blocked.example"] },
  });
  const res = createResolutionService("default-org", reader, createAclStore());
  const conv: Conversation = { kind: "dm", threadRef: "dm:U1:t1", audience: [actor] };
  const resolved = await res.resolve(conv, actor);
  assert.match(resolved.systemPrompt, /FLEET_LIVE/);
  assert.deepEqual(resolved.egress.deniedHosts, ["blocked.example"]);
});
