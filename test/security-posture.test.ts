import assert from "node:assert/strict";
import test from "node:test";
import { scopeId } from "../src/types.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import {
  createMemoryConfigStore,
  type PersistedApprovalGrantModes,
  type PersistedSecurityPosture,
} from "../src/resolution/config-store.ts";
import {
  composeSecurityPosture,
  parseSecurityPosture,
  resolveSecurityPolicy,
} from "../src/security/security-posture.ts";

test("security posture parses only the three named modes", () => {
  assert.equal(parseSecurityPosture("dangerous"), "dangerous");
  assert.equal(parseSecurityPosture("AUTO"), "auto");
  assert.equal(parseSecurityPosture(" strict "), "strict");
  assert.equal(parseSecurityPosture("default"), null);
});

test("narrower scopes may tighten but cannot weaken the org posture", () => {
  assert.equal(composeSecurityPosture("dangerous", "auto"), "auto");
  assert.equal(composeSecurityPosture("auto", "dangerous"), "auto");
  assert.equal(composeSecurityPosture("auto", "strict"), "strict");
  assert.equal(composeSecurityPosture("strict", "dangerous"), "strict");
});

test("each posture resolves to exactly one mechanism", () => {
  assert.deepEqual(resolveSecurityPolicy("dangerous"), {
    posture: "dangerous",
    denyPrivateNetworks: false,
    toolApprovals: "none",
  });
  assert.deepEqual(resolveSecurityPolicy("auto"), {
    posture: "auto",
    denyPrivateNetworks: true,
    toolApprovals: "none",
  });
  assert.deepEqual(resolveSecurityPolicy("strict"), {
    posture: "strict",
    denyPrivateNetworks: false,
    toolApprovals: "all",
  });
});

test("scoped postures persist and resolve against the org floor", async () => {
  const backing = createMemoryMap<PersistedSecurityPosture>();
  const org = scopeId("org", "default-org");
  const channel = scopeId("channel", "C1");
  const first = createMemoryConfigStore("default-org", {
    securityPostures: backing,
    defaultSecurityPosture: "dangerous",
  });
  await first.setSecurityPosture(org, "auto");
  await first.setSecurityPosture(channel, "strict");

  const restarted = createMemoryConfigStore("default-org", {
    securityPostures: backing,
    defaultSecurityPosture: "dangerous",
  });
  await restarted.hydrate?.();
  assert.equal(await restarted.getSecurityPostureDurable(org), "auto");
  assert.equal(await restarted.getSecurityPostureDurable(channel), "strict");

  await restarted.setSecurityPosture(channel, "dangerous");
  assert.equal(await restarted.getSecurityPostureDurable(channel), "auto", "a scope cannot weaken the org floor");
  assert.equal((await backing.get(channel))?.posture, "auto", "the store does not retain a latent weaker preference");
});

test("approval grant modes default to all-on and compose tighten-only", async () => {
  const backing = createMemoryMap<PersistedApprovalGrantModes>();
  const org = scopeId("org", "acme");
  const channel = scopeId("channel", "C1");
  const store = createMemoryConfigStore("acme", { approvalGrantModes: backing });

  assert.deepEqual(await store.getApprovalGrantModesDurable(org), { session: true, always: true });
  assert.deepEqual(store.getApprovalGrantModes(channel), { session: true, always: true });

  await store.setApprovalGrantModes(org, { session: true, always: false });
  assert.deepEqual(
    await store.getApprovalGrantModesDurable(channel),
    { session: true, always: false },
    "an org removal reaches every scope",
  );

  await store.setApprovalGrantModes(channel, { session: false, always: true });
  assert.deepEqual(
    await store.getApprovalGrantModesDurable(channel),
    { session: false, always: false },
    "a scope may tighten but cannot re-enable what the org removed",
  );
  assert.deepEqual(
    await store.getApprovalGrantModesDurable(org),
    { session: true, always: false },
    "the scope's tightening never leaks back to the org",
  );

  const restarted = createMemoryConfigStore("acme", { approvalGrantModes: backing });
  await restarted.hydrate?.();
  assert.deepEqual(
    restarted.getApprovalGrantModes(channel),
    { session: false, always: false },
    "modes survive a restart",
  );

  await restarted.setApprovalGrantModes(org, { session: true, always: true });
});
