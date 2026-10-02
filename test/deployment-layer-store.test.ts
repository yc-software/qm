import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeploymentLayerStore,
  DeploymentLayerPersistedError,
  DeploymentLayerValidationError,
  type DeploymentLayerBundle,
  type StoredDeploymentLayer,
} from "../src/deployment/deployment-layer-store.ts";
import { emptyDeploymentLayer, resolvedDeploymentLayer } from "../src/deployment/load-layer.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";
import type { AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { computeBundleHash, createSkillBundleStore } from "../src/skills/skill-bundle-store.ts";

const tool = (advertise: string): DeploymentLayerBundle["tools"][number] => ({
  path: "tools/acme/tool.json",
  content: JSON.stringify({
    id: "acme",
    advertise,
    hints: ["Use acme for company data."],
    auth: {
      check: "acme auth status",
      reauth: "acme auth login",
      credentialPaths: [{ path: ".config/acme", kind: "directory" }],
    },
    approvals: [{ command: "deploy", decision: "deny" }],
  }),
});

const skill: DeploymentLayerBundle["skills"] = [
  {
    path: "skills/acme/SKILL.md",
    content: "---\nname: acme\ndescription: Use Acme systems.\n---\nRun the acme tool.\n",
  },
];

const publicRuntime = (runtime: ReturnType<typeof resolvedDeploymentLayer>) => {
  const { dir: _dir, ...resolved } = runtime;
  return resolved;
};

const org = scopeId("org", "default-org");
const md = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
const durableAcme: DeploymentLayerBundle["skills"] = [
  { path: "skills/acme/SKILL.md", content: md("acme", "Durable.", "durable body") },
];
type LayerOptions = Parameters<typeof createDeploymentLayerStore>[0];
type Skills = ReturnType<typeof createSkillStore>;

function layer(over: Partial<LayerOptions> = {}) {
  const opts = {
    backing: createMemoryMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
    skills: createSkillStore({ signingSecret: "layer-test" }),
    scopeId: org,
    ...over,
  };
  return { ...opts, store: createDeploymentLayerStore(opts) };
}

async function publishSkill(
  skills: Skills,
  name: string,
  description: string,
  body: string,
  createdBy: string,
  reviewer = createdBy,
) {
  const created = await skills.create({
    scopeId: org,
    manifest: { name, description, requiredCapabilities: [], body },
    createdBy,
  });
  await skills.review(created.id, reviewer, []);
  await skills.publish(created.id);
  return created;
}

const publishStale = (skills: Skills) =>
  publishSkill(skills, "removed", "stale", "stale", "system:deployment-layer", "system:deployment-layer-reviewer");

const unappliable = (
  contentHash: string,
  updatedBy: string,
  skills: DeploymentLayerBundle["skills"] = [{ path: "skills/broken/README.md", content: "no SKILL.md here" }],
): StoredDeploymentLayer => ({
  contentHash,
  version: 1,
  updatedAt: 1,
  updatedBy,
  bundle: { contract: 1, tools: [], skills },
  resolved: publicRuntime(emptyDeploymentLayer()),
});

const logErrors = (t: { mock: { method: (o: object, m: string, f: (...args: unknown[]) => void) => unknown } }) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  return errors;
};

test("the durable deployment layer versions by content, hydrates runtime state, and archives removed skills", async () => {
  let now = 100;
  const { backing, runtime, skills, store } = layer({ now: () => now++ });

  const first = await store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "test");
  assert.equal(first.version, 1);
  assert.equal(runtime.advertisedTools[0], "acme CLI");
  assert.deepEqual(runtime.hints, ["Use acme for company data."]);
  assert.deepEqual(runtime.credentialPaths, [{ path: ".config/acme", kind: "directory" }]);
  assert.equal(runtime.commandRules[0]?.decision, "deny");
  assert.equal((await skills.resolve("acme", [org])).skill?.status, "published");

  const unchanged = await store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "other");
  assert.equal(unchanged.version, 1);
  assert.equal(unchanged.updatedBy, "test");

  const second = await store.put({ contract: 1, tools: [tool("acme v2")], skills: [] }, "test-2");
  assert.equal(second.version, 2);
  assert.equal(runtime.advertisedTools[0], "acme v2");
  assert.equal((await skills.resolve("acme", [org])).skill, null);

  const hydrated = layer({ backing, skills });
  assert.equal(
    (await hydrated.store.get())?.version,
    2,
    "get() applies the durable record it reads — no denial window during propagation",
  );
  assert.equal(hydrated.runtime.advertisedTools[0], "acme v2");
  assert.equal((await hydrated.store.hydrate())?.version, 2);
});

test("invalid descriptors never replace the durable current layer", async () => {
  const { store } = layer();
  const first = await store.put({ contract: 1, tools: [tool("acme")], skills: [] }, "test");
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [
          {
            path: "tools/bad/tool.json",
            content: JSON.stringify({ id: "bad", approvals: [{ pattern: "acme deploy" }] }),
          },
        ],
        skills: [],
      },
      "bad",
    ),
    /must refer to its own tool binary/,
  );
  assert.equal((await store.get())?.contentHash, first.contentHash);
  assert.equal((await store.get())?.version, 1);
});

const rejectedBundles: Array<{ name: string; bundle: DeploymentLayerBundle; error: RegExp; validation?: true }> = [
  ...["tools/a/b/tool.json", "tools/loose.json", "tools/a/extra.txt"].map((path) => ({
    name: `misplaced tool file ${path} is rejected, not silently ignored`,
    bundle: { contract: 1 as const, tools: [{ path, content: JSON.stringify({ id: "a" }) }], skills: [] },
    error: /tool path must be tools\/<id>\/tool\.json/,
  })),
  {
    name: "duplicate skill names across layer skill dirs are rejected at validation",
    bundle: {
      contract: 1,
      tools: [],
      skills: [
        { path: "skills/a/SKILL.md", content: md("same", "One.", "body a") },
        { path: "skills/b/SKILL.md", content: md("same", "Two.", "body b") },
      ],
    },
    error: /duplicate deployment skill name: same/,
  },
  {
    name: "a NUL byte in the bundle is rejected at validation (Postgres JSONB would 500 on it later)",
    bundle: {
      contract: 1,
      tools: [],
      skills: [{ path: "skills/acme/SKILL.md", content: md("acme", "x", "bad\u0000body") }],
    },
    error: /NUL character/,
  },
  {
    name: "unpaired Unicode surrogates are rejected before the JSONB write",
    bundle: {
      contract: 1,
      tools: [],
      skills: [{ path: "skills/acme/SKILL.md", content: md("acme", "x", "bad\ud800body") }],
    },
    error: /unpaired Unicode surrogate/,
  },
  {
    name: "PUT validates cross-tool credential paths before persisting",
    bundle: {
      contract: 1,
      tools: [
        {
          path: "tools/a/tool.json",
          content: JSON.stringify({
            id: "a",
            auth: { check: "c", reauth: "r", credentialPaths: [{ path: ".acme", kind: "directory" }] },
          }),
        },
        {
          path: "tools/b/tool.json",
          content: JSON.stringify({
            id: "b",
            auth: { check: "c", reauth: "r", credentialPaths: [{ path: ".acme/sub/key", kind: "file" }] },
          }),
        },
      ],
      skills: [],
    },
    error: /incompatible credential paths/,
    validation: true,
  },
  {
    name: "deployment skill names cannot contain path separators",
    bundle: {
      contract: 1,
      tools: [],
      skills: [{ path: "skills/one/SKILL.md", content: md("foo/bar", "Test.", "foo/bar") }],
    },
    error: /skill name must/,
    validation: true,
  },
];

for (const { name, bundle, error, validation } of rejectedBundles) {
  test(name, async () => {
    const { backing, store } = layer();
    await assert.rejects(
      store.put(bundle, "api"),
      (e: unknown) => (!validation || e instanceof DeploymentLayerValidationError) && error.test((e as Error).message),
    );
    assert.equal(await backing.get("current"), null);
  });
}

test("a legacy published skill with an unsafe name is quarantined without blocking layer replacement", async () => {
  const skillBacking = createMemoryMap<Skill>();
  await skillBacking.put("legacy", {
    id: "legacy",
    scopeId: org,
    manifest: { name: "My Skill", description: "legacy", requiredCapabilities: [], body: "legacy" },
    signature: "legacy",
    status: "published",
    createdBy: "legacy-import",
    version: 1,
    grantedCapabilities: [],
    approvals: [],
  });
  const { skills, store } = layer({ skills: createSkillStore({ signingSecret: "layer-test", backing: skillBacking }) });

  await store.put({ contract: 1, tools: [], skills: [] }, "test");
  assert.deepEqual(await skills.visibleFor([org]), []);
  assert.equal(
    (await skills.get("legacy"))?.status,
    "published",
    "quarantine does not silently rename or mutate the legacy row",
  );
});

test("a stale baked-in filesystem seed never downgrades or resurrects the durable layer", async () => {
  const { backing, skills, store: writer } = layer();
  await writer.put({ contract: 1, tools: [], skills: durableAcme }, "api");

  let seeded = 0;
  const { store: booted } = layer({
    backing,
    skills,
    seedFallback: async () => {
      seeded++;
      await publishStale(skills);
    },
  });
  await booted.hydrate();
  assert.equal(seeded, 0, "a durable record suppresses the filesystem seed entirely");
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "durable body\n");
  assert.equal((await skills.resolve("removed", [org])).skill, null);
});

test("with no durable record the filesystem seed applies once, and a later durable layer overrides it", async () => {
  let seeded = 0;
  const skills = createSkillStore({ signingSecret: "layer-test" });
  const { store } = layer({
    skills,
    seedFallback: async () => {
      seeded++;
      await publishSkill(
        skills,
        "acme",
        "Baked in.",
        "fs body",
        "system:deployment-layer",
        "system:deployment-layer-reviewer",
      );
    },
  });
  assert.equal(await store.hydrate(), null);
  await store.hydrate();
  assert.equal(seeded, 1, "the sweeper's re-hydrate never re-runs the seed");
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "fs body");

  await store.put({ contract: 1, tools: [], skills: durableAcme }, "api");
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "durable body\n");
});

test("hydrate retries a transient backing read instead of failing boot", async () => {
  const { backing, skills, store: writer } = layer();
  await writer.put({ contract: 1, tools: [tool("acme CLI")], skills: [] }, "api");
  let flaked = 0;
  const flaky = {
    ...backing,
    get: async (key: string) => {
      if (flaked++ === 0) throw new Error("connection reset");
      return backing.get(key);
    },
  } as DurableMap<StoredDeploymentLayer>;
  const { runtime, store } = layer({ backing: flaky, skills, retryDelaysMs: [1] });
  assert.equal((await store.hydrate())?.version, 1);
  assert.equal(runtime.advertisedTools[0], "acme CLI");
  assert.ok(flaked > 1, "the failed read was retried");
});

test("a stored record that no longer applies degrades to the seed instead of failing boot", async (t) => {
  const errors = logErrors(t);
  const backing = createMemoryMap<StoredDeploymentLayer>();
  await backing.put("current", unappliable("poisoned", "old-cli"));
  let seeded = 0;
  const { store } = layer({
    backing,
    runtime: resolvedDeploymentLayer("/fallback", []),
    retryDelaysMs: [1],
    seedFallback: async () => {
      seeded++;
    },
  });
  const record = await store.hydrate();
  const logged = errors.length;
  assert.equal(record?.contentHash, "poisoned", "hydrate resolves — boot is not bricked");
  assert.equal(seeded, 1, "the baked-in seed serves until a valid layer is PUT");
  assert.equal((await store.get())?.contentHash, "poisoned", "status reads do not retry the failed apply as a 500");
  assert.equal(store.live().source, "filesystem", "status reads leave the fallback runtime in place");
  await store.hydrate();
  assert.equal(errors.length, logged, "later sweeps retry once without repeating the backoff or failure logs");
});

test("a failed seed is retried on the next hydrate (seeded only latches on success)", async () => {
  let attempts = 0;
  const { store } = layer({
    seedFallback: async () => {
      attempts++;
      if (attempts === 1) throw new Error("skill store hiccup");
    },
  });
  await assert.rejects(store.hydrate(), /skill store hiccup/);
  await store.hydrate();
  await store.hydrate();
  assert.equal(attempts, 2, "the failed seed retried once, then latched");
});

test("a failed fallback seed after an incompatible stored layer fails boot and retries", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const backing = createMemoryMap<StoredDeploymentLayer>();
  await backing.put("current", unappliable("poisoned-seed", "old-cli"));
  let attempts = 0;
  const { store } = layer({
    backing,
    runtime: resolvedDeploymentLayer("/fallback", []),
    retryDelaysMs: [],
    seedFallback: async () => {
      if (++attempts === 1) throw new Error("fallback write failed");
    },
  });

  await assert.rejects(store.hydrate(), /fallback write failed/);
  assert.equal((await store.hydrate())?.contentHash, "poisoned-seed");
  assert.equal(attempts, 2);
});

test("a PUT landing on another instance mid-seed is applied right after seeding (no 30s stale window)", async () => {
  const { backing, skills, store: writer } = layer();
  const { store: booted } = layer({
    backing,
    skills,
    seedFallback: async () => {
      await publishStale(skills);
      await writer.put({ contract: 1, tools: [], skills: durableAcme }, "api");
    },
  });
  const record = await booted.hydrate();
  assert.equal(record?.version, 1, "hydrate returns the layer that appeared during seeding");
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "durable body\n");
  assert.equal(
    (await skills.resolve("removed", [org])).skill,
    null,
    "the resurrected stale skill is archived immediately",
  );
});

test("a layer that appears mid-seed but fails to apply leaves the fallback live instead of failing boot", async (t) => {
  const errors = logErrors(t);
  const backing = createMemoryMap<StoredDeploymentLayer>();
  const { store } = layer({
    backing,
    runtime: resolvedDeploymentLayer("/fallback", []),
    retryDelaysMs: [],
    seedFallback: () => backing.put("current", unappliable("appeared-poisoned", "other-instance")),
  });

  assert.equal((await store.hydrate())?.contentHash, "appeared-poisoned");
  assert.equal(store.live().source, "filesystem");
  assert.equal((await store.get())?.contentHash, "appeared-poisoned");
  assert.ok(errors.some((line) => line.includes("appeared-poisoned failed to apply")));
});

test("a mid-seed layer that fails during skill mutation keeps the fallback live and retries later", async () => {
  const backing = createMemoryMap<StoredDeploymentLayer>();
  const baseSkills = createSkillStore({ signingSecret: "layer-test" });
  let creates = 0;
  const skills = {
    ...baseSkills,
    create: async (input: Parameters<typeof baseSkills.create>[0]) => {
      if (++creates === 2) throw new Error("skill write failed");
      return baseSkills.create(input);
    },
  };
  const { store } = layer({
    backing,
    runtime: resolvedDeploymentLayer("/fallback", []),
    skills,
    retryDelaysMs: [],
    seedFallback: () =>
      backing.put(
        "current",
        unappliable("appeared-partial", "other-instance", [
          { path: "skills/a/SKILL.md", content: md("a", "A.", "a") },
          { path: "skills/b/SKILL.md", content: md("b", "B.", "b") },
        ]),
      ),
  });

  assert.equal((await store.hydrate())?.contentHash, "appeared-partial");
  assert.equal(store.live().source, "filesystem");
  assert.equal((await store.hydrate())?.contentHash, "appeared-partial");
  assert.equal(store.live().source, "durable", "the refresh retry applies once the transient skill-store error clears");
});

test("live() reports the runtime source and durable reflects the backing", async () => {
  const { store: none } = layer();
  assert.equal(none.durable, false);
  assert.deepEqual(none.live(), { source: "none", contentHash: null, resolved: null });

  const { store: fs } = layer({ runtime: resolvedDeploymentLayer("/layer", []), durable: true });
  assert.equal(fs.durable, true);
  assert.equal(fs.live().source, "filesystem");
  await fs.put({ contract: 1, tools: [tool("acme CLI")], skills: [] }, "api");
  assert.equal(fs.live().source, "durable");
  assert.ok(fs.live().contentHash);
  assert.equal(await fs.isApplied(fs.live().contentHash!), true);
  assert.deepEqual(fs.live().resolved?.advertisedTools, ["acme CLI"]);
});

test("hydrate reparses bundle descriptors instead of trusting stored resolved fields", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const backing = createMemoryMap<StoredDeploymentLayer>();
  await backing.put("current", {
    contentHash: "legacy-unvalidated",
    version: 7,
    updatedAt: 1,
    updatedBy: "legacy",
    bundle: {
      contract: 1,
      tools: [
        { path: "tools/bad/tool.json", content: JSON.stringify({ id: "BAD; touch /tmp/pwned", advertise: "unsafe" }) },
      ],
      skills: [],
    },
    resolved: {
      ...publicRuntime(resolvedDeploymentLayer("legacy", [{ id: "safe", advertise: "tampered cache" }])),
    },
  });
  const { runtime, store } = layer({ backing, runtime: resolvedDeploymentLayer("/fallback", []), retryDelaysMs: [] });
  assert.equal((await store.hydrate())?.version, 7);
  assert.equal(await store.isApplied("legacy-unvalidated"), false);
  assert.equal(store.live().source, "filesystem");
  assert.deepEqual(runtime.advertisedTools, []);
});

test("hydrate derives runtime fields from the stored bundle, not the resolved cache", async () => {
  const { backing, store: writer } = layer();
  const record = await writer.put({ contract: 1, tools: [tool("bundle truth")], skills: [] }, "writer");
  await backing.put("current", {
    ...record,
    resolved: { ...record.resolved, advertisedTools: ["tampered cache"] },
  });
  const reader = layer({ backing });
  await reader.store.hydrate();
  assert.deepEqual(reader.runtime.advertisedTools, ["bundle truth"]);
});

test("a concurrent delete during put surfaces a conflict error, not a TypeError", async () => {
  const backing = {
    get: async () => null,
    put: async () => {},
    putIfAbsent: async (_k: string, v: StoredDeploymentLayer) => ({ ...v, contentHash: "different-hash" }),
    update: async () => null,
  } as unknown as DurableMap<StoredDeploymentLayer>;
  const { store } = layer({ backing });
  await assert.rejects(store.put({ contract: 1, tools: [], skills: [] }, "api"), /concurrent delete/);
});

test("concurrent writes serialize into monotonic durable versions", async () => {
  const { runtime, store } = layer();
  await store.put({ contract: 1, tools: [tool("v1")], skills: [] }, "one");
  const [two, three] = await Promise.all([
    store.put({ contract: 1, tools: [tool("v2")], skills: [] }, "two"),
    store.put({ contract: 1, tools: [tool("v3")], skills: [] }, "three"),
  ]);
  assert.deepEqual([two.version, three.version], [2, 3]);
  assert.equal((await store.get())?.version, 3);
  assert.deepEqual(runtime.advertisedTools, ["v3"]);
});

test("two stores serialize the durable head and shared skill projection under one fleet lock", async () => {
  let tail = Promise.resolve();
  let active = 0;
  let maxActive = 0;
  const advisoryLock: AdvisoryLock = {
    async withLock<T>(_key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        return await fn();
      } finally {
        active--;
        release();
      }
    },
  };
  const first = layer({ advisoryLock });
  const { backing, skills } = first;
  const second = layer({ backing, skills, advisoryLock });
  const v1 = first.store.put(
    { contract: 1, tools: [tool("v1")], skills: [{ path: "skills/acme/SKILL.md", content: md("acme", "V1.", "v1") }] },
    "one",
  );
  const v2 = second.store.put(
    { contract: 1, tools: [tool("v2")], skills: [{ path: "skills/acme/SKILL.md", content: md("acme", "V2.", "v2") }] },
    "two",
  );
  const [one, two] = await Promise.all([v1, v2]);

  assert.equal(maxActive, 1);
  assert.deepEqual([one.version, two.version], [1, 2]);
  assert.equal((await backing.get("current"))?.contentHash, two.contentHash);
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "v2\n");
  assert.deepEqual(second.runtime.advertisedTools, ["v2"]);
  await first.store.get();
  assert.deepEqual(first.runtime.advertisedTools, ["v2"], "a stale instance re-reads the fleet head before projecting");
});

test("a failed multi-skill apply rolls every deployment-owned skill back before reporting degraded", async () => {
  const baseSkills = createSkillStore({ signingSecret: "layer-test" });
  let failB = false;
  const skills = {
    ...baseSkills,
    create: async (input: Parameters<typeof baseSkills.create>[0]) => {
      if (failB && input.manifest.name === "b") throw new Error("b write failed");
      return baseSkills.create(input);
    },
  };
  const { backing, runtime, store } = layer({ skills, retryDelaysMs: [] });
  await store.put(
    {
      contract: 1,
      tools: [tool("old tools")],
      skills: [
        { path: "skills/a/SKILL.md", content: md("a", "Old A.", "old a") },
        { path: "skills/removed/SKILL.md", content: md("removed", "Kept on failure.", "old removed") },
      ],
    },
    "one",
  );
  failB = true;
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [tool("new tools")],
        skills: [
          { path: "skills/a/SKILL.md", content: md("a", "New A.", "new a") },
          { path: "skills/b/SKILL.md", content: md("b", "B.", "b") },
        ],
      },
      "two",
    ),
    (error: unknown) => error instanceof DeploymentLayerPersistedError && /b write failed/.test(error.message),
  );

  assert.equal((await skills.resolve("a", [org])).skill?.manifest.body, "old a\n");
  assert.equal((await skills.resolve("removed", [org])).skill?.manifest.body, "old removed\n");
  assert.equal((await skills.resolve("b", [org])).skill, null);
  assert.deepEqual(runtime.advertisedTools, ["old tools"]);
  const head = await backing.get("current");
  assert.ok(head);
  assert.equal(await store.isApplied(head.contentHash), false);
});

test("applied status detects and repairs deployment-skill drift", async () => {
  const { skills, store } = layer();
  const record = await store.put({ contract: 1, tools: [], skills: skill }, "api");
  const deployed = (await skills.resolve("acme", [org])).skill!;
  await skills.archive(deployed.id);

  assert.equal(
    await store.isApplied(record.contentHash),
    false,
    "an externally archived skill invalidates applied status",
  );
  await store.get();
  assert.equal(await store.isApplied(record.contentHash), true);
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "Run the acme tool.\n");
});

test("a later hydrate reconciles a persisted layer audit exactly once", async () => {
  const { backing, store: writer } = layer();
  const record = await writer.put({ contract: 1, tools: [tool("persisted before crash")], skills: [] }, "source-cli");
  const audit = createAuditLog();
  const { store: recovered } = layer({
    backing,
    auditPersisted: (stored: StoredDeploymentLayer) =>
      audit.recordOnce!(`deployment-layer:${org}:${stored.version}`, {
        at: stored.updatedAt,
        principalId: stored.updatedBy,
        action: "deployment_layer.updated",
        resource: stored.contentHash,
        scopeLabel: org,
      }),
  });
  await recovered.hydrate();
  await recovered.hydrate();

  const events = await audit.events();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.resource, record.contentHash);
  assert.equal(events[0]?.principalId, "source-cli");
});

test("a failed audit remains recoverable after a later revision replaces the durable head", async () => {
  const audited: number[] = [];
  let auditAvailable = false;
  const { backing, store } = layer({
    retryDelaysMs: [],
    auditPersisted: async (record) => {
      if (!auditAvailable) throw new Error("audit unavailable");
      if (!audited.includes(record.version)) audited.push(record.version);
    },
  });

  await assert.rejects(
    store.put({ contract: 1, tools: [], skills: [] }, "one"),
    (error: unknown) => error instanceof DeploymentLayerPersistedError && error.record.version === 1,
  );
  auditAvailable = true;
  const second = await store.put({ contract: 1, tools: [tool("v2")], skills: [] }, "two");
  await store.hydrate();

  assert.equal(second.version, 2);
  assert.deepEqual(audited, [1, 2]);
  assert.deepEqual((await backing.get("current"))?.pendingAudits, []);
});

test("a foreign same-name skill rejects the PUT before anything persists", async () => {
  const { backing, skills, store } = layer();
  await skills.create({
    scopeId: org,
    manifest: { name: "acme", description: "user authored", requiredCapabilities: [], body: "mine" },
    createdBy: "user:alice",
  });
  await assert.rejects(
    store.put({ contract: 1, tools: [], skills: skill }, "test"),
    (e: unknown) => e instanceof DeploymentLayerValidationError && /created by user:alice/.test((e as Error).message),
  );
  assert.ok(!(await backing.get("current")), "the colliding layer was never persisted");
});

test("a deployment skill cannot materialize over an active pack's shared bundle", async () => {
  const skills = createSkillStore({ signingSecret: "layer-test" });
  const skillBundles = createSkillBundleStore();
  const packed = await skills.create({
    scopeId: org,
    manifest: { name: "packed", description: "Packed skill.", requiredCapabilities: [], body: "packed" },
    createdBy: "pack:one",
    pack: { packId: "one", commit: "abc", upstreamName: "packed" },
  });
  await skills.review(packed.id, "system:pack-reviewer", []);
  await skills.publish(packed.id);
  const files = [{ path: "skills/acme/helpers/run.ts", content: "from pack" }];
  await skillBundles.put({ packId: "one", commit: "abc", files, hash: computeBundleHash(files) });
  const { backing, store } = layer({ skills, skillBundles });

  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [...skill, { path: "skills/acme/helpers/run.ts", content: "from deployment" }],
      },
      "test",
    ),
    (error: unknown) =>
      error instanceof DeploymentLayerValidationError &&
      /skills\/acme\/helpers\/run\.ts, already claimed by pack:one/.test(error.message),
  );
  assert.equal(await backing.get("current"), null);
});

test("a foreign skill racing after validation reports the revision as persisted and degraded", async () => {
  const baseSkills = createSkillStore({ signingSecret: "layer-test" });
  const realList = baseSkills.list.bind(baseSkills);
  let calls = 0;
  const skills = {
    ...baseSkills,
    list: async () => {
      if (++calls === 1) return realList();
      if (calls === 2) {
        await baseSkills.create({
          scopeId: org,
          manifest: { name: "acme", description: "user authored", requiredCapabilities: [], body: "mine" },
          createdBy: "user:alice",
        });
      }
      return realList();
    },
  };
  const { backing, runtime, store } = layer({ skills });
  await assert.rejects(
    store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "test"),
    (error: unknown) =>
      error instanceof DeploymentLayerPersistedError && /collides with an existing non-layer skill/.test(error.message),
  );
  const record = await backing.get("current");
  assert.ok(record, "the accepted durable revision remains current");
  assert.equal(await store.isApplied(record.contentHash), false);
  assert.deepEqual(runtime.advertisedTools, [], "a failed skill projection does not expose the revision's tools");
});

test("an archived foreign skill does not block the layer; a later live collision leaves the new revision unapplied", async () => {
  const { backing, skills, store } = layer();
  const archived = await publishSkill(skills, "acme", "retired", "old", "user:alice");
  await skills.archive(archived.id);

  const record = await store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "test");
  assert.equal(
    (await skills.resolve("acme", [org])).skill?.createdBy,
    "system:deployment-layer",
    "archived skills never collide",
  );

  for (const s of await skills.list()) {
    if (s.createdBy === "system:deployment-layer") await skills.delete(s.id);
  }
  await publishSkill(skills, "acme", "user authored", "mine", "user:alice");
  const rehydrated = layer({ backing, skills });
  assert.equal(
    (await rehydrated.store.hydrate())?.contentHash,
    record.contentHash,
    "hydrate returns the record despite the collision",
  );
  assert.deepEqual(rehydrated.runtime.advertisedTools, [], "the colliding revision is not partially projected");
  assert.equal(
    (await skills.resolve("acme", [org])).skill?.createdBy,
    "user:alice",
    "the user's skill was not clobbered",
  );
  await rehydrated.store.get();
});

test("a bundle may carry the files a tool declares under install.files, and nothing else", async () => {
  const { runtime, store } = layer();
  const descriptor = {
    path: "tools/acme/tool.json",
    content: JSON.stringify({
      id: "acme",
      install: { binary: "acme", files: [{ from: "acme", to: "/usr/local/bin/acme" }] },
    }),
  };
  const executable = { path: "tools/acme/acme", content: "#!/bin/sh\necho acme\n", executable: true };
  await store.put({ contract: 1, tools: [descriptor, executable], skills: [] }, "api");
  assert.deepEqual(runtime.installFiles, [
    { to: "/usr/local/bin/acme", mode: "0755", content: "#!/bin/sh\necho acme\n" },
  ]);
  await assert.rejects(
    store.put({ contract: 1, tools: [descriptor], skills: [] }, "api"),
    /declares install file acme but the bundle does not carry tools\/acme\/acme/,
  );
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [descriptor, executable, { path: "tools/acme/notes.txt", content: "stray\n" }],
        skills: [],
      },
      "api",
    ),
    /tool path must be tools\/<id>\/tool\.json: tools\/acme\/notes\.txt/,
  );
});
