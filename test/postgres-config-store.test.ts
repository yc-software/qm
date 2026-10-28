import { test, before } from "node:test";
import assert from "node:assert/strict";
import {
  configStoreMaps,
  createMemoryConfigStore,
  type PersistedSoul,
  type PersistedSoulRevision,
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
  "sharing_postures",
  "egress_policies",
  "deploy_auth_split",
  "publish_member_grants",
  "slack_quiet_status_flag",
  "base_model_configs",
  "browse_provider_configs",
  "browse_max_steps_configs",
  "browse_model_configs",
  "deployment_identity",
];

before(async () => {
  if (!URL) return;
  const pg = (await import("pg")).default;
  const p = new pg.Pool({ connectionString: URL });
  await p.query("DROP TABLE IF EXISTS qm_schema_migrations CASCADE");
  for (const t of TABLES) await p.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
  await p.end();
});

const maps = (f: PostgresArtifactMaps) => configStoreMaps(f.map);

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
});

test("SOUL snapshot restore preserves the canonical version and history byte-for-byte across cores", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const left = createMemoryConfigStore("default-org", { souls });
  const right = createMemoryConfigStore("default-org", { souls });
  const channel = scopeId("channel", "snapshot");
  await left.setSoul(channel, "one", "alice");
  await left.setSoul(channel, "two", "bob");
  const snapshot = await left.captureSoulSnapshot(channel);

  await right.refreshScope(channel);
  await right.setSoul(channel, "attempted import", "importer");
  assert.equal(await left.restoreSoulSnapshot(channel, snapshot), true);
  await right.refreshScope(channel);

  assert.deepEqual(await right.captureSoulSnapshot(channel), snapshot);
  assert.equal(right.getSoul(channel), "two");
  assert.equal(right.soulVersion(channel), 2);
  assert.deepEqual(right.soulHistory(channel), snapshot?.history);
});

test("setSoul advances the canonical row without trusting a stale instance cache", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const left = createMemoryConfigStore("default-org", { souls });
  const right = createMemoryConfigStore("default-org", { souls });
  const channel = scopeId("channel", "latest");

  assert.equal(await left.setSoul(channel, "left", "alice"), 1);
  assert.equal(right.soulVersion(channel), 0);
  assert.equal(await right.setSoul(channel, "right", "bob"), 2);

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

  assert.equal(await store.setSoul(channel, "post-upgrade", "alice"), 9);
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

test("embedded history prevents a stale core from re-injecting legacy revisions after restore", async () => {
  const souls = createMemoryMap<PersistedSoul>();
  const legacyHistory = createMemoryMap<PersistedSoulRevision>();
  const restored = scopeId("channel", "legacy-restored");
  await souls.put(restored, { scopeId: restored, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${restored}:4`, { scopeId: restored, content: "legacy current", version: 4, updatedAt: 40 });
  await legacyHistory.put(`${restored}:3`, { scopeId: restored, content: "legacy prior", version: 3, updatedAt: 30 });
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
  assert.equal(await stale.setSoul(restored, "after restore", "bob"), 2);
  assert.deepEqual(
    (await souls.get(restored))?.history?.map(({ version, content }) => ({ version, content })),
    [
      { version: 2, content: "after restore" },
      { version: 1, content: "restored canonical" },
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
    const version = await a.setSoul(ch, "a channel-specific soul");
    await a.setCommandPolicy(ch, policy);
    await a.setSecurityPosture(ch, "strict");
    await a.setSharingPosture(org, "open");
    await a.setSharingPosture(ch, "open");
    await a.setApprovalGrantModes(ch, { session: false, always: true });
    await a.setEgress(ch, { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] });
    await a.setBaseModel(ch, "claude-opus-4-8");
    await a.setBrowseMaxSteps(ch, 120);
    await a.setBrowseModel(ch, "claude-sonnet-4-6");
    await settle(
      async () =>
        (await m.souls.get(ch))?.version === version &&
        !!(await m.commandPolicies.get(ch)) &&
        (await m.securityPostures.get(ch))?.posture === "strict" &&
        (await m.sharingPostures.get(ch))?.posture === "open" &&
        (await m.approvalGrantModes.get(ch))?.modes.session === false &&
        (await m.egressPolicies.get(ch))?.policy.allowedHosts[0] === "api.example.com" &&
        (await m.baseModels.get(ch))?.modelId === "claude-opus-4-8" &&
        (await m.browseMaxSteps.get(ch))?.steps === 120 &&
        (await m.browseModels.get(ch))?.modelId === "claude-sonnet-4-6",
    );

    const b = createMemoryConfigStore("default-org", maps(f));
    assert.equal(b.getSoul(ch), null, "a cold instance has no scoped soul until it hydrates");
    await b.hydrate?.();

    assert.equal(b.getSoul(ch), "a channel-specific soul", "the scoped soul survived the restart");
    assert.equal(b.soulVersion(ch), version, "the soul version round-trips (monotonic across restart)");
    assert.equal(b.soulHistory(ch)[0]?.content, "a channel-specific soul", "the revision history survives a restart");
    assert.deepEqual(b.getCommandPolicy(ch), policy, "the command policy survived");
    assert.equal(await b.getSecurityPostureDurable(ch), "strict", "the security posture survived");
    assert.equal(await b.resolveSharingPostureDurable(scopeId("personal", "U1"), ch), "open");
    assert.deepEqual(
      b.getEgress(ch),
      { allowedHosts: ["api.example.com"], deniedHosts: ["evil.example"] },
      "the egress policy survived",
    );
    assert.equal(b.getBaseModel(ch), "claude-opus-4-8", "the base model survived");
    assert.equal(b.getBrowseMaxSteps(ch), 120, "the browse step limit survived");
    assert.equal(b.getBrowseModel(ch), "claude-sonnet-4-6", "the browse model survived");
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
      lastVersion = await a.setSoul(ch, `soul v${i}`);
      await a.setEgress(ch, { allowedHosts: [`host${i}.example`], deniedHosts: [] });
    }
    await a.setBaseModel(ch, "claude-opus-4-8");
    await a.setBaseModel(ch, null);
    await a.setBrowseMaxSteps(ch, 60);
    await a.setBrowseMaxSteps(ch, null);
    await a.setBrowseModel(ch, "claude-sonnet-4-6");
    await a.setBrowseModel(ch, null);
    await settle(
      async () =>
        (await m.souls.get(ch))?.content === "soul v8" &&
        (await m.egressPolicies.get(ch))?.policy.allowedHosts[0] === "host8.example" &&
        !(await m.baseModels.get(ch)) &&
        !(await m.browseMaxSteps.get(ch)) &&
        !(await m.browseModels.get(ch)),
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
    assert.equal(b.getBrowseMaxSteps(ch), null, "a cleared browse step limit stays cleared after restart");
    assert.equal(b.getBrowseModel(ch), null, "a cleared browse model stays cleared after restart");
  },
);

test("pg config store: settings written on one core reach another core through refreshScope", { skip }, async () => {
  const f = createPostgresMapFactory(URL!);
  const ch = scopeId("channel", "C4");
  const org = scopeId("org", "default-org");
  const a = createMemoryConfigStore("default-org", maps(f));
  const b = createMemoryConfigStore("default-org", maps(f));
  await a.hydrate?.();
  await b.hydrate?.();

  await a.setWebuiModels(ch, ["claude-opus-4-8"]);
  await a.setAckEmoji(ch, ["eyes"]);
  await a.setBrowseMaxSteps(ch, 77);
  await a.setBrowseModel(ch, "claude-sonnet-4-6");
  await a.setBranding(ch, { accent: "#123456" });
  await a.setChannelHeaderPin(ch, true);
  await a.setApprovalGrantModes(ch, { session: false, always: true });
  await a.setOrgAmbient(false);
  await a.setApprovedHarnesses(["pi"]);
  await a.setAutoFlaggerConfig({ harnessId: "pi", modelId: "claude-opus-4-8", rubric: "flag it" });
  await b.refreshScope(ch);
  await b.refreshScope(org);

  assert.deepEqual(b.getWebuiModels(ch), ["claude-opus-4-8"]);
  assert.deepEqual(b.getAckEmoji(ch), ["eyes"]);
  assert.equal(b.getBrowseMaxSteps(ch), 77);
  assert.equal(b.getBrowseModel(ch), "claude-sonnet-4-6");
  assert.deepEqual(b.getBranding(ch), { accent: "#123456" });
  assert.equal(b.getChannelHeaderPin(ch), true);
  assert.deepEqual(b.getApprovalGrantModes(ch), { session: false, always: true });
  assert.equal(b.getOrgAmbient(), false);
  assert.deepEqual(b.getApprovedHarnesses(), ["pi"]);
  assert.equal(b.getAutoFlaggerConfig()?.rubric, "flag it");

  await a.setWebuiModels(ch, null);
  await a.setAckEmoji(ch, null);
  await a.setBrowseMaxSteps(ch, null);
  await a.setBrowseModel(ch, null);
  await a.setApprovedHarnesses(null);
  await b.refreshScope(ch);
  await b.refreshScope(org);

  assert.equal(b.getWebuiModels(ch), null);
  assert.equal(b.getAckEmoji(ch), null);
  assert.equal(b.getBrowseMaxSteps(ch), null);
  assert.equal(b.getBrowseModel(ch), null);
  assert.equal(b.getApprovedHarnesses(), null);
});
