import test from "node:test";
import { testTenant } from "./support/test-tenant.ts";
import assert from "node:assert/strict";
import {
  createDeploymentLayerStore,
  DeploymentLayerPersistedError,
  DeploymentLayerValidationError,
  LAYER_CREATED_BY,
  type DeploymentLayerBundle,
  type DeploymentLayerStore,
  type StoredDeploymentLayer,
} from "../src/deployment/deployment-layer-store.ts";
import { emptyDeploymentLayer, resolvedDeploymentLayer } from "../src/deployment/load-layer.ts";
import { type DurableMap } from "../src/persistence/durable-map.ts";
import { createSkillStore, type Skill } from "../src/skills/skill-store.ts";
import { scopeId } from "../src/types.ts";
import { createPostgresAuditLog } from "../src/admin/postgres-audit-log.ts";
import { testDatabaseUrl, testMap, testAdvisoryLock } from "./support/test-database.ts";

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

const org = scopeId("org", "default-org");

const catalogStore = (layer: DeploymentLayerStore, backing = testMap<Skill>()) =>
  createSkillStore({
    advisoryLock: testAdvisoryLock(),
    backing,
    signingSecret: "layer-test",
    catalog: { scopeId: org, skills: () => layer.skills() },
  });

const publicRuntime = (runtime: ReturnType<typeof resolvedDeploymentLayer>) => {
  const { dir: _dir, ...resolved } = runtime;
  return resolved;
};

test("the durable layer versions by content, updates the runtime, and replaces its skills in the shared catalog", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const runtime = emptyDeploymentLayer();
  let now = 100;
  const store = createDeploymentLayerStore({ backing, runtime, now: () => now++ });
  const skills = catalogStore(store);

  const first = await store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "test");
  assert.equal(first.version, 1);
  assert.equal(runtime.advertisedTools[0], "acme CLI");
  assert.deepEqual(runtime.hints, ["Use acme for company data."]);
  assert.deepEqual(runtime.credentialPaths, [{ path: ".config/acme", kind: "directory" }]);
  assert.equal(runtime.commandRules[0]?.decision, "deny");
  assert.equal((await skills.resolve("acme", [org])).skill?.createdBy, LAYER_CREATED_BY);

  const unchanged = await store.put({ contract: 1, tools: [tool("acme CLI")], skills: skill }, "other");
  assert.equal(unchanged.version, 1);
  assert.equal(unchanged.updatedBy, "test");

  const second = await store.put({ contract: 1, tools: [tool("acme v2")], skills: [] }, "test-2");
  assert.equal(second.version, 2);
  assert.equal((await skills.resolve("acme", [org])).skill, null);

  const hydratedRuntime = emptyDeploymentLayer();
  const hydrated = createDeploymentLayerStore({ backing, runtime: hydratedRuntime });
  assert.equal((await hydrated.get())?.version, 2);
  assert.equal(hydratedRuntime.advertisedTools[0], "acme v2");
});

test("each tenant sees the shared catalog with its own archive and edit overrides merged on top", async () => {
  const builtin = { name: "notes", description: "Built in.", requiredCapabilities: [], body: "seed body" };
  const store = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
    builtinSkills: [
      { manifest: builtin, createdBy: "system:skills-seed", reviewer: "system:skills-reviewer" },
      { manifest: { ...builtin, name: "acme" }, createdBy: "system:skills-seed", reviewer: "system:skills-reviewer" },
    ],
  });
  await store.put({ contract: 1, tools: [], skills: skill }, "api");
  const aRows = testMap<Skill>();
  const a = catalogStore(store, aRows);
  const b = catalogStore(store);
  assert.equal((await a.resolve("acme", [org])).skill?.createdBy, LAYER_CREATED_BY, "the layer wins a name clash");

  const notes = (await a.resolve("notes", [org])).skill!;
  await a.archive(notes.id);
  assert.equal((await a.resolve("notes", [org])).skill, null);
  assert.equal((await b.resolve("notes", [org])).skill?.manifest.body, "seed body");

  await a.review(notes.id, "admin", []);
  assert.equal((await a.publish(notes.id)).manifest.body, "seed body");
  assert.deepEqual(await aRows.all(), [], "restoring an unedited built-in drops the override row");

  await a.update(notes.id, { ...builtin, body: "edited" });
  await a.review(notes.id, "admin", []);
  await a.publish(notes.id);
  assert.equal((await a.resolve("notes", [org])).skill?.manifest.body, "edited");
  assert.equal((await b.resolve("notes", [org])).skill?.manifest.body, "seed body");
  assert.equal((await a.list()).filter((s) => s.manifest.name === "notes").length, 1);
});

test("a stored record that no longer applies keeps the filesystem fallback instead of failing boot", async (t) => {
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  const backing = testMap<StoredDeploymentLayer>();
  await backing.put("current", {
    contentHash: "poisoned",
    version: 1,
    updatedAt: 1,
    updatedBy: "old-cli",
    bundle: { contract: 1, tools: [], skills: [{ path: "skills/broken/README.md", content: "no SKILL.md here" }] },
    resolved: publicRuntime(emptyDeploymentLayer()),
  });
  const runtime = resolvedDeploymentLayer("/fallback", []);
  const store = createDeploymentLayerStore({
    backing,
    runtime,
    fallbackSkills: [{ name: "acme", description: "Baked in.", requiredCapabilities: [], body: "fs body" }],
  });
  assert.equal((await store.hydrate())?.contentHash, "poisoned", "hydrate resolves, so boot is not bricked");
  const logged = errors.length;
  assert.equal(store.live().source, "filesystem");
  assert.equal((await catalogStore(store).resolve("acme", [org])).skill?.manifest.body, "fs body");
  await store.hydrate();
  assert.equal(errors.length, logged, "later refreshes do not repeat the failure log");
});
test("invalid descriptors never replace the durable current layer", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const store = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  });
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

test("hydrate retries a transient backing read instead of failing boot", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  let flaked = 0;
  const flaky = {
    ...backing,
    get: async (key: string) => {
      if (flaked++ === 0) throw new Error("connection reset");
      return backing.get(key);
    },
  } as DurableMap<StoredDeploymentLayer>;
  const runtime = emptyDeploymentLayer();
  await createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  }).put({ contract: 1, tools: [tool("acme CLI")], skills: [] }, "api");
  const store = createDeploymentLayerStore({
    backing: flaky,
    runtime,
    retryDelaysMs: [1],
  });
  assert.equal((await store.hydrate())?.version, 1);
  assert.equal(runtime.advertisedTools[0], "acme CLI");
  assert.ok(flaked > 1, "the failed read was retried");
});

test("misplaced tool files are rejected, not silently ignored", async () => {
  const store = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
  });
  for (const path of ["tools/a/b/tool.json", "tools/loose.json", "tools/a/extra.txt"]) {
    await assert.rejects(
      store.put({ contract: 1, tools: [{ path, content: JSON.stringify({ id: "a" }) }], skills: [] }, "api"),
      /tool path must be tools\/<id>\/tool\.json/,
      path,
    );
  }
});

test("live() reports the runtime source and durable reflects the backing", async () => {
  const none = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
  });
  assert.deepEqual(none.live(), { source: "none", contentHash: null, resolved: null });

  const fsRuntime = resolvedDeploymentLayer("/layer", []);
  const fs = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: fsRuntime,
  });
  assert.equal(fs.live().source, "filesystem");
  await fs.put({ contract: 1, tools: [tool("acme CLI")], skills: [] }, "api");
  assert.equal(fs.live().source, "durable");
  assert.ok(fs.live().contentHash);
  assert.equal(await fs.isApplied(fs.live().contentHash!), true);
  assert.deepEqual(fs.live().resolved?.advertisedTools, ["acme CLI"]);
});

test("duplicate skill names across layer skill dirs are rejected at validation", async () => {
  const store = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
  });
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [
          { path: "skills/a/SKILL.md", content: "---\nname: same\ndescription: One.\n---\nbody a\n" },
          { path: "skills/b/SKILL.md", content: "---\nname: same\ndescription: Two.\n---\nbody b\n" },
        ],
      },
      "api",
    ),
    /duplicate deployment skill name: same/,
  );
});

test("a NUL byte in the bundle is rejected at validation (Postgres JSONB would 500 on it later)", async () => {
  const store = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
  });
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [{ path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: x\n---\nbad\u0000body\n" }],
      },
      "api",
    ),
    /NUL character/,
  );
});

test("unpaired Unicode surrogates are rejected before the JSONB write", async () => {
  const store = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime: emptyDeploymentLayer(),
  });
  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [{ path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: x\n---\nbad\ud800body\n" }],
      },
      "api",
    ),
    /unpaired Unicode surrogate/,
  );
});

test("PUT validates cross-tool credential paths before persisting", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const store = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  });
  await assert.rejects(
    store.put(
      {
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
      "api",
    ),
    (error: unknown) =>
      error instanceof DeploymentLayerValidationError && /incompatible credential paths/.test(error.message),
  );
  assert.equal(await backing.get("current"), null);
});

test("hydrate reparses bundle descriptors instead of trusting stored resolved fields", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const backing = testMap<StoredDeploymentLayer>();
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
  const runtime = resolvedDeploymentLayer("/fallback", []);
  const store = createDeploymentLayerStore({
    backing,
    runtime,
    retryDelaysMs: [],
  });
  assert.equal((await store.hydrate())?.version, 7);
  assert.equal(await store.isApplied("legacy-unvalidated"), false);
  assert.equal(store.live().source, "filesystem");
  assert.deepEqual(runtime.advertisedTools, []);
});

test("hydrate derives runtime fields from the stored bundle, not the resolved cache", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const bundle = { contract: 1 as const, tools: [tool("bundle truth")], skills: [] };
  const writer = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  });
  const record = await writer.put(bundle, "writer");
  await backing.put("current", {
    ...record,
    resolved: { ...record.resolved, advertisedTools: ["tampered cache"] },
  });
  const runtime = emptyDeploymentLayer();
  const reader = createDeploymentLayerStore({
    backing,
    runtime,
  });
  await reader.hydrate();
  assert.deepEqual(runtime.advertisedTools, ["bundle truth"]);
});

test("a concurrent delete during put surfaces a conflict error, not a TypeError", async () => {
  const backing = {
    get: async () => null,
    put: async () => {},
    putIfAbsent: async (_k: string, v: StoredDeploymentLayer) => ({ ...v, contentHash: "different-hash" }),
    update: async () => null,
  } as unknown as DurableMap<StoredDeploymentLayer>;
  const store = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  });
  await assert.rejects(store.put({ contract: 1, tools: [], skills: [] }, "api"), /concurrent delete/);
});

test("concurrent writes serialize into monotonic durable versions", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const runtime = emptyDeploymentLayer();
  const store = createDeploymentLayerStore({
    backing,
    runtime,
  });
  await store.put({ contract: 1, tools: [tool("v1")], skills: [] }, "one");
  const [two, three] = await Promise.all([
    store.put({ contract: 1, tools: [tool("v2")], skills: [] }, "two"),
    store.put({ contract: 1, tools: [tool("v3")], skills: [] }, "three"),
  ]);
  assert.deepEqual([two.version, three.version], [2, 3]);
  assert.equal((await store.get())?.version, 3);
  assert.deepEqual(runtime.advertisedTools, ["v3"]);
});

test("a later read reconciles a persisted layer audit exactly once", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const record = await createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  }).put({ contract: 1, tools: [tool("persisted before crash")], skills: [] }, "source-cli");
  const audit = createPostgresAuditLog(testDatabaseUrl());
  const auditPersisted = (stored: StoredDeploymentLayer) =>
    audit.recordOnce!(testTenant, `deployment-layer:${org}:${stored.version}`, {
      at: stored.updatedAt,
      principalId: stored.updatedBy,
      action: "deployment_layer.updated",
      resource: stored.contentHash,
      scopeLabel: org,
    });
  const recovered = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
    auditPersisted,
  });
  await recovered.get();
  await recovered.get();

  const events = await audit.events(testTenant);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.resource, record.contentHash);
  assert.equal(events[0]?.principalId, "source-cli");
});

test("a failed audit remains recoverable after a later revision replaces the durable head", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const audited: number[] = [];
  let auditAvailable = false;
  const store = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
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

test("deployment skill names cannot contain path separators", async () => {
  const backing = testMap<StoredDeploymentLayer>();
  const store = createDeploymentLayerStore({
    backing,
    runtime: emptyDeploymentLayer(),
  });
  const markdown = (name: string) => `---\nname: ${name}\ndescription: Test.\n---\n${name}\n`;

  await assert.rejects(
    store.put(
      {
        contract: 1,
        tools: [],
        skills: [{ path: "skills/one/SKILL.md", content: markdown("foo/bar") }],
      },
      "test",
    ),
    (error: unknown) => error instanceof DeploymentLayerValidationError && /skill name must/.test(error.message),
  );
  assert.equal(await backing.get("current"), null);
});

test("a bundle may carry the files a tool declares under install.files, and nothing else", async () => {
  const runtime = emptyDeploymentLayer();
  const store = createDeploymentLayerStore({
    backing: testMap<StoredDeploymentLayer>(),
    runtime,
  });
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
