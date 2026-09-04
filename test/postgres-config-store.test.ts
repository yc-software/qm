import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryConfigStore,
  type PersistedSoul,
  type PersistedSoulRevision,
  type PersistedCommandPolicy,
  type PersistedSecurityPosture,
  type PersistedApprovalGrantModes,
  type PersistedEgressPolicy,
  type PersistedBaseModel,
  type PersistedPeopleDirectoryUrl,
  type PersistedBrowseMaxSteps,
  type PersistedBrowseModel,
  type PersistedTurnWallClock,
  type PersistedDeploymentIdentity,
} from "../src/resolution/config-store.ts";
import { settle } from "./support/settle.ts";
import {
  createMemoryMap,
  createPostgresMapFactory,
  type DurableMap,
  type PostgresArtifactMaps,
} from "../src/persistence/durable-map.ts";
import { defaultOrgPolicy } from "../src/policy/command-policy.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the Postgres config-store tests";

const TABLES = [
  "soul_configs",
  "soul_history",
  "command_policies",
  "security_postures",
  "egress_policies",
  "deploy_auth_split",
  "publish_member_grants",
  "slack_quiet_status_flag",
  "base_model_configs",
  "browse_provider_configs",
  "people_directory_urls",
  "browse_max_steps_configs",
  "browse_model_configs",
  "turn_wall_clock_configs",
  "deployment_identity",
];

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  for (const t of TABLES) await p.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await p.end();
});

const maps = (f: PostgresArtifactMaps) => ({
  souls: f.map<PersistedSoul>("soul_configs"),
  soulHistory: f.map<PersistedSoulRevision>("soul_history"),
  commandPolicies: f.map<PersistedCommandPolicy>("command_policies"),
  securityPostures: f.map<PersistedSecurityPosture>("security_postures"),
  approvalGrantModes: f.map<PersistedApprovalGrantModes>("approval_grant_modes"),
  egressPolicies: f.map<PersistedEgressPolicy>("egress_policies"),
  baseModels: f.map<PersistedBaseModel>("base_model_configs"),
  peopleDirectoryUrls: f.map<PersistedPeopleDirectoryUrl>("people_directory_urls"),
  browseMaxSteps: f.map<PersistedBrowseMaxSteps>("browse_max_steps_configs"),
  browseModels: f.map<PersistedBrowseModel>("browse_model_configs"),
  turnWallClocks: f.map<PersistedTurnWallClock>("turn_wall_clock_configs"),
  deploymentIdentity: f.map<PersistedDeploymentIdentity>("deployment_identity"),
});

test("turn wall-clock config hydrates after restart and a clear remains cleared", async () => {
  const turnWallClocks = createMemoryMap<PersistedTurnWallClock>();
  const writer = createMemoryConfigStore("default-org", { turnWallClocks });
  const org = scopeId("org", "default-org");
  await writer.setTurnWallClockSec(org, 600);
  const restarted = createMemoryConfigStore("default-org", { turnWallClocks });
  await restarted.hydrate?.();
  assert.equal(await restarted.getTurnWallClockSecDurable(org), 600);
  await restarted.setTurnWallClockSec(org, null);
  const cleared = createMemoryConfigStore("default-org", { turnWallClocks });
  await cleared.hydrate?.();
  assert.equal(await cleared.getTurnWallClockSecDurable(org), null);
});

test("SOUL compare-and-set permits only one writer and keeps current plus history in one durable row", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const legacyHistory = createMemoryMap<PersistedSoulRevision>();
  const left = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });
  const right = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });
  const channel = scopeId("channel", "CAS");

  const results = await Promise.all([
    left.setSoulIfVersion(channel, 0, "left", "alice"),
    right.setSoulIfVersion(channel, 0, "right", "bob"),
  ]);
  assert.deepEqual(
    results.sort((a, b) => (a ?? 99) - (b ?? 99)),
    [1, null],
  );

  const durable = await souls.get(channel);
  assert.equal(durable?.history?.length, 1);
  assert.equal(durable?.history?.[0]?.content, durable?.content);
  for (let version = 1; version < 30; version++) {
    assert.equal(await left.setSoulIfVersion(channel, version, `revision ${version + 1}`, "alice"), version + 1);
  }
  assert.equal((await souls.get(channel))?.history?.length, 30, "the canonical row retains the full durable history");
  assert.equal(left.soulHistory(channel).length, 25, "the operator view remains bounded");
  const fresh = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });
  await fresh.hydrate?.();
  assert.equal(fresh.soulHistory(channel)[0]?.content, fresh.getSoul(channel));
  await right.refreshScope(channel);
  assert.equal(
    right.soulHistory(channel)[0]?.content,
    right.getSoul(channel),
    "a cross-instance refresh advances current SOUL and history together",
  );
  right.clearSoul(channel);
  await right.flushScope(channel);
  assert.equal(await souls.get(channel), null);
  assert.equal(right.soulHistory(channel).length, 0);
});

test("SOUL snapshot restore preserves the canonical version and history byte-for-byte across cores", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const left = createMemoryConfigStore("default-org", { souls });
  const right = createMemoryConfigStore("default-org", { souls });
  const channel = scopeId("channel", "snapshot");
  left.setSoul(channel, "one", "alice");
  left.setSoul(channel, "two", "bob");
  await left.flushScope(channel);
  const snapshot = await left.captureSoulSnapshot(channel);

  await right.refreshScope(channel);
  right.setSoul(channel, "attempted import", "importer");
  await right.flushScope(channel);
  assert.equal(await left.restoreSoulSnapshot(channel, snapshot), true);
  await right.refreshScope(channel);

  assert.deepEqual(await right.captureSoulSnapshot(channel), snapshot);
  assert.equal(right.getSoul(channel), "two");
  assert.equal(right.soulVersion(channel), 2);
  assert.deepEqual(right.soulHistory(channel), snapshot?.history);
});

test("setSoulLatest advances the canonical row without trusting a stale instance cache", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const left = createMemoryConfigStore("default-org", { souls });
  const right = createMemoryConfigStore("default-org", { souls });
  const channel = scopeId("channel", "latest");

  assert.equal(await left.setSoulLatest(channel, "left", "alice"), 1);
  assert.equal(right.soulVersion(channel), 0);
  assert.equal(await right.setSoulLatest(channel, "right", "bob"), 2);

  const durable = await souls.get(channel);
  assert.equal(durable?.version, 2);
  assert.deepEqual(
    durable?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "right" },
      { version: 1, content: "left" },
    ],
  );
});

test("the first write after upgrade retains a canonical revision that predates embedded history", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const channel = scopeId("channel", "pre-history-upgrade");
  await souls.put(channel, { scopeId: channel, content: "pre-upgrade", version: 8 });
  const store = createMemoryConfigStore("default-org", { souls });

  assert.equal(await store.setSoulLatest(channel, "post-upgrade", "alice"), 9);
  assert.deepEqual(
    (await souls.get(channel))?.history?.map(({ version, content, updatedAt }) => ({ version, content, updatedAt })),
    [
      { version: 9, content: "post-upgrade", updatedAt: (await souls.get(channel))!.updatedAt },
      { version: 8, content: "pre-upgrade", updatedAt: 0 },
    ],
  );
});

test("refreshScope merges legacy SOUL history into a canonical row and migrates it safely", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const legacyBacking = createMemoryMap<PersistedSoulRevision>();
  let legacyScans = 0;
  const legacyHistory: DurableMap<PersistedSoulRevision> = {
    ...legacyBacking,
    async all() {
      legacyScans++;
      return legacyBacking.all();
    },
  };
  const channel = scopeId("channel", "legacy-refresh");
  const revision: PersistedSoulRevision = {
    scopeId: channel,
    content: "legacy current",
    version: 4,
    updatedAt: 40,
    updatedBy: "alice",
  };
  await souls.put(channel, { ...revision });
  await legacyHistory.put(`${channel}:4`, revision);
  await legacyHistory.put(`${channel}:3`, {
    scopeId: channel,
    content: "legacy prior",
    version: 3,
    updatedAt: 30,
    updatedBy: "bob",
  });
  const store = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });

  await store.hydrate?.();
  await store.refreshScope(channel);
  await store.refreshScope(channel);

  assert.deepEqual(
    store.soulHistory(channel).map(({ version, content }) => ({ version, content })),
    [
      { version: 4, content: "legacy current" },
      { version: 3, content: "legacy prior" },
    ],
  );
  assert.deepEqual(
    (await souls.get(channel))?.history,
    store.soulHistory(channel),
    "refresh atomically migrates legacy revisions into the canonical row",
  );
  assert.equal(legacyScans, 1, "legacy history is scanned once at hydration, never per scope refresh or write");
});

test("embedded history prevents a stale core from re-injecting legacy revisions after restore or clear", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const legacyHistory = createMemoryMap<PersistedSoulRevision>();
  const restored = scopeId("channel", "legacy-restored");
  const cleared = scopeId("channel", "legacy-cleared");
  for (const channel of [restored, cleared]) {
    await souls.put(channel, { scopeId: channel, content: "legacy current", version: 4, updatedAt: 40 });
    await legacyHistory.put(`${channel}:4`, { scopeId: channel, content: "legacy current", version: 4, updatedAt: 40 });
    await legacyHistory.put(`${channel}:3`, { scopeId: channel, content: "legacy prior", version: 3, updatedAt: 30 });
  }
  const left = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });
  const stale = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });
  await Promise.all([left.hydrate?.(), stale.hydrate?.()]);

  const restoredSnapshot: PersistedSoul = {
    scopeId: restored,
    content: "restored canonical",
    version: 1,
    updatedAt: 50,
    history: [],
  };
  assert.equal(await left.restoreSoulSnapshot(restored, restoredSnapshot), true);
  await stale.refreshScope(restored);
  assert.deepEqual((await souls.get(restored))?.history, []);
  assert.equal(await stale.setSoulLatest(restored, "after restore", "bob"), 2);
  assert.deepEqual(
    (await souls.get(restored))?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "after restore" },
      { version: 1, content: "restored canonical" },
    ],
  );

  left.clearSoul(cleared);
  await left.flushScope(cleared);
  assert.equal(await left.setSoulLatest(cleared, "new canonical", "alice"), 1);
  assert.equal(await stale.setSoulLatest(cleared, "after clear", "bob"), 2);
  assert.deepEqual(
    (await souls.get(cleared))?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "after clear" },
      { version: 1, content: "new canonical" },
    ],
  );
});

test("legacy migration rechecks the canonical marker inside the atomic update", async () => {
  const backing = createMemoryMap<PersistedSoul>();
  const legacyHistory = createMemoryMap<PersistedSoulRevision>();
  const channel = scopeId("channel", "legacy-interleaving-restore");
  const restored: PersistedSoul = {
    scopeId: channel,
    content: "restored while refreshing",
    version: 1,
    updatedAt: 50,
    history: [],
  };
  let restoreBeforeUpdate = false;
  const souls: DurableMap<PersistedSoul> = {
    ...backing,
    async update(id, fn) {
      if (restoreBeforeUpdate) {
        restoreBeforeUpdate = false;
        await backing.put(id, restored);
      }
      return backing.update!(id, fn);
    },
  };
  await souls.put(channel, { scopeId: channel, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${channel}:4`, { scopeId: channel, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${channel}:3`, { scopeId: channel, content: "legacy prior", version: 3, updatedAt: 30 });
  const stale = createMemoryConfigStore("default-org", { souls, soulHistory: legacyHistory });
  await stale.hydrate?.();

  restoreBeforeUpdate = true;
  await stale.refreshScope(channel);

  assert.deepEqual(await souls.get(channel), restored);
  assert.equal(stale.getSoul(channel), restored.content);
  assert.deepEqual(stale.soulHistory(channel), []);
});

test(
  "pg config store: scoped soul/policy/egress/flags survive a restart (write-through + hydrate)",
  { skip },
  async () => {
    const f = createPostgresMapFactory(URL!);
    const ch = scopeId("channel", "C1");
    const org = scopeId("org", "default-org");
    const policy = defaultOrgPolicy();

    const m = maps(f);
    const a = createMemoryConfigStore("default-org", m);
    const version = a.setSoul(ch, "a channel-specific soul");
    a.setCommandPolicy(ch, policy);
    await a.setSecurityPosture(ch, "strict");
    await a.setApprovalGrantModes(ch, { session: false, always: true });
    a.setEgress(ch, { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] });
    a.setBaseModel(ch, "claude-opus-4-8");
    a.setPeopleDirectoryUrl(ch, "https://www.example.com/people");
    a.setBrowseMaxSteps(ch, 120);
    a.setBrowseModel(ch, "claude-sonnet-4-6");
    await a.setTurnWallClockSec(org, 600);
    await settle(
      async () =>
        (await m.souls.get(ch))?.version === version &&
        !!(await m.commandPolicies.get(ch)) &&
        (await m.securityPostures.get(ch))?.posture === "strict" &&
        (await m.approvalGrantModes.get(ch))?.modes.session === false &&
        (await m.egressPolicies.get(ch))?.policy.allowedHosts[0] === "api.example.com" &&
        (await m.baseModels.get(ch))?.modelId === "claude-opus-4-8" &&
        (await m.peopleDirectoryUrls.get(ch))?.url === "https://www.example.com/people" &&
        (await m.browseMaxSteps.get(ch))?.steps === 120 &&
        (await m.browseModels.get(ch))?.modelId === "claude-sonnet-4-6" &&
        (await m.turnWallClocks.get(org))?.sec === 600,
    );

    const b = createMemoryConfigStore("default-org", maps(f));
    assert.equal(b.getSoul(ch), null, "a cold instance has no scoped soul until it hydrates");
    await b.hydrate?.();

    assert.equal(b.getSoul(ch), "a channel-specific soul", "the scoped soul survived the restart");
    assert.equal(b.soulVersion(ch), version, "the soul version round-trips (monotonic across restart)");
    assert.equal(b.soulHistory(ch)[0]?.content, "a channel-specific soul", "the revision history survives a restart");
    assert.deepEqual(b.getCommandPolicy(ch), policy, "the command policy survived");
    assert.equal(await b.getSecurityPostureDurable(ch), "strict", "the security posture survived");
    assert.deepEqual(
      b.getEgress(ch),
      { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] },
      "the egress policy survived",
    );
    assert.equal(b.getBaseModel(ch), "claude-opus-4-8", "the base model survived");
    assert.equal(b.getPeopleDirectoryUrl(ch), "https://www.example.com/people", "the people-directory url survived");
    assert.equal(b.getBrowseMaxSteps(ch), 120, "the browse step limit survived");
    assert.equal(b.getBrowseModel(ch), "claude-sonnet-4-6", "the browse model survived");
    assert.equal(await b.getTurnWallClockSecDurable(org), 600, "the turn wall-clock limit survived");
  },
);

test(
  "pg config store: rapid overlapping writes to one scope converge to the last value (serialized write-through)",
  { skip },
  async () => {
    const f = createPostgresMapFactory(URL!);
    const ch = scopeId("channel", "C2");
    const m = maps(f);
    const a = createMemoryConfigStore("default-org", m);

    let lastVersion = 0;
    for (let i = 1; i <= 8; i++) {
      lastVersion = a.setSoul(ch, `soul v${i}`);
      a.setEgress(ch, { allowedHosts: [`host${i}.example`], deniedHosts: [] });
    }
    a.setBaseModel(ch, "claude-opus-4-8");
    a.setBaseModel(ch, null);
    a.setPeopleDirectoryUrl(ch, "https://example.com/people");
    a.setPeopleDirectoryUrl(ch, null);
    a.setBrowseMaxSteps(ch, 60);
    a.setBrowseMaxSteps(ch, null);
    a.setBrowseModel(ch, "claude-sonnet-4-6");
    a.setBrowseModel(ch, null);
    await a.setTurnWallClockSec(scopeId("org", "default-org"), 600);
    await a.setTurnWallClockSec(scopeId("org", "default-org"), null);
    await settle(
      async () =>
        (await m.souls.get(ch))?.content === "soul v8" &&
        (await m.egressPolicies.get(ch))?.policy.allowedHosts[0] === "host8.example" &&
        !(await m.baseModels.get(ch)) &&
        !(await m.peopleDirectoryUrls.get(ch)) &&
        !(await m.browseMaxSteps.get(ch)) &&
        !(await m.browseModels.get(ch)) &&
        !(await m.turnWallClocks.get(scopeId("org", "default-org"))),
    );

    const b = createMemoryConfigStore("default-org", maps(f));
    await b.hydrate?.();
    assert.equal(b.getSoul(ch), "soul v8", "the durable soul ends on the last write, not a reordered earlier one");
    assert.equal(b.soulVersion(ch), lastVersion);
    assert.deepEqual(
      b.getEgress(ch),
      { allowedHosts: ["host8.example"], deniedHosts: [] },
      "the durable egress ends on the last write",
    );
    assert.equal(b.getBaseModel(ch), null, "a cleared base model stays cleared after restart");
    assert.equal(b.getPeopleDirectoryUrl(ch), null, "a cleared people-directory url stays cleared after restart");
    assert.equal(b.getBrowseMaxSteps(ch), null, "a cleared browse step limit stays cleared after restart");
    assert.equal(b.getBrowseModel(ch), null, "a cleared browse model stays cleared after restart");
  },
);
