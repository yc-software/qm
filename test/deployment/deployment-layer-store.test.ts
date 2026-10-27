import test from "node:test";
import assert from "node:assert/strict";
import {
  createDeploymentLayerStore,
  DeploymentLayerValidationError,
} from "../../src/deployment/deployment-layer-store.ts";
import { emptyDeploymentLayer, resolvedDeploymentLayer } from "../../src/deployment/load-layer.ts";
import { createPgPool } from "../../src/persistence/pg-pool.ts";
import { createSkillStore } from "../../src/skills/skill-store.ts";
import { scopeId } from "../../src/types.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { tool, skill, readLayer, putLayer } from "../support/deployment-layer.ts";
import { createNoopAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { createPostgresAdvisoryLock } from "../../src/persistence/advisory-lock.ts";
import { tenantFor, withTenant } from "../../src/tenant.ts";

const org = scopeId("org", "default-org");

function fixture() {
  const databaseUrl = testDatabaseUrl();
  const skills = createSkillStore({ advisoryLock: createPostgresAdvisoryLock(createPgPool(databaseUrl)), databaseUrl });
  const layer = (opts: Partial<Parameters<typeof createDeploymentLayerStore>[0]> = {}) =>
    createDeploymentLayerStore({
      advisoryLock: createNoopAdvisoryLock(),
      databaseUrl,
      runtime: emptyDeploymentLayer(),
      skills,
      ...opts,
    });
  return { databaseUrl, skills, layer };
}

const publicRuntime = (runtime: ReturnType<typeof resolvedDeploymentLayer>) => {
  const { dir: _dir, ...resolved } = runtime;
  return resolved;
};

test("the durable deployment layer versions by content, hydrates runtime state, and archives removed skills", async () => {
  const { skills, layer } = fixture();
  const runtime = emptyDeploymentLayer();
  let now = 100;
  const store = layer({
    runtime,
    now: () => now++,
  });

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

  const hydratedRuntime = emptyDeploymentLayer();
  const hydrated = layer({
    runtime: hydratedRuntime,
  });
  assert.equal(
    (await hydrated.get())?.version,
    2,
    "get() applies the durable record it reads — no denial window during propagation",
  );
  assert.equal(hydratedRuntime.advertisedTools[0], "acme v2");
  assert.equal((await hydrated.hydrate())?.version, 2);
});

test("invalid descriptors never replace the durable current layer", async () => {
  const { layer } = fixture();
  const store = layer();
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

test("a legacy published skill with an unsafe name is quarantined without blocking layer replacement", async () => {
  const { databaseUrl, skills, layer } = fixture();
  const legacyTenant = tenantFor("legacy-org");
  await createPgPool(databaseUrl).q(
    `INSERT INTO skills (id, scope_id, manifest, status, created_by, version, granted_capabilities, approvals)
     VALUES ('legacy', $1, $2, 'published', 'legacy-import', 1, '{}', '{}')`,
    [legacyTenant.orgScope, { name: "My Skill", description: "legacy", requiredCapabilities: [], body: "legacy" }],
  );
  const store = layer();

  await withTenant(legacyTenant, () => store.put({ contract: 1, tools: [], skills: [] }, "test"));
  assert.deepEqual(await skills.visibleFor([legacyTenant.orgScope]), []);
  assert.equal(
    (await skills.get("legacy"))?.status,
    "published",
    "quarantine does not silently rename or mutate the legacy row",
  );
});

test("a stale baked-in filesystem seed never downgrades or resurrects the durable layer", async () => {
  const { skills, layer } = fixture();
  const writer = layer();
  await writer.put(
    {
      contract: 1,
      tools: [],
      skills: [
        { path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: Durable.\n---\ndurable body\n" },
      ],
    },
    "api",
  );

  let seeded = 0;
  const booted = layer({
    seedFallback: async () => {
      seeded++;
      const stale = await skills.create({
        scopeId: org,
        manifest: { name: "removed", description: "stale", requiredCapabilities: [], body: "stale" },
        createdBy: "system:deployment-layer",
      });
      await skills.review(stale.id, "system:deployment-layer-reviewer", []);
      await skills.publish(stale.id);
    },
  });
  await booted.hydrate();
  assert.equal(seeded, 0, "a durable record suppresses the filesystem seed entirely");
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "durable body\n");
  assert.equal((await skills.resolve("removed", [org])).skill, null);
});

test("with no durable record the filesystem seed applies once, and a later durable layer overrides it", async () => {
  const { skills, layer } = fixture();
  let seeded = 0;
  const store = layer({
    seedFallback: async () => {
      seeded++;
      const fs = await skills.create({
        scopeId: org,
        manifest: { name: "acme", description: "Baked in.", requiredCapabilities: [], body: "fs body" },
        createdBy: "system:deployment-layer",
      });
      await skills.review(fs.id, "system:deployment-layer-reviewer", []);
      await skills.publish(fs.id);
    },
  });
  assert.equal(await store.hydrate(), null);
  await store.hydrate();
  assert.equal(seeded, 1, "the sweeper's re-hydrate never re-runs the seed");
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "fs body");

  await store.put(
    {
      contract: 1,
      tools: [],
      skills: [
        { path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: Durable.\n---\ndurable body\n" },
      ],
    },
    "api",
  );
  assert.equal((await skills.resolve("acme", [org])).skill?.manifest.body, "durable body\n");
});

test("hydrate retries a transient backing read instead of failing boot", async (t) => {
  const { databaseUrl, layer } = fixture();
  const runtime = emptyDeploymentLayer();
  await layer().put({ contract: 1, tools: [tool("acme CLI")], skills: [] }, "api");
  const { q } = createPgPool(databaseUrl);
  await q(`ALTER TABLE deployment_layer RENAME TO deployment_layer_away`);
  let flaked = 0;
  let restored: Promise<unknown> | undefined;
  t.mock.method(console, "error", () => {
    flaked++;
    restored ??= q(`ALTER TABLE deployment_layer_away RENAME TO deployment_layer`);
  });
  const store = layer({
    runtime,
    retryDelaysMs: [200],
  });
  assert.equal((await store.hydrate())?.version, 1);
  assert.equal(runtime.advertisedTools[0], "acme CLI");
  assert.equal(flaked, 1, "the failed read was retried");
});

test("a stored record that no longer applies degrades to the seed instead of failing boot", async (t) => {
  const { databaseUrl, layer } = fixture();
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  await putLayer(databaseUrl, {
    contentHash: "poisoned",
    version: 1,
    updatedAt: 1,
    updatedBy: "old-cli",
    bundle: { contract: 1, tools: [], skills: [{ path: "skills/broken/README.md", content: "no SKILL.md here" }] },
    resolved: publicRuntime(emptyDeploymentLayer()),
  });
  const runtime = resolvedDeploymentLayer("/fallback", []);
  let seeded = 0;
  const store = layer({
    runtime,
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
  const { layer } = fixture();
  let attempts = 0;
  const store = layer({
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
  const { databaseUrl, layer } = fixture();
  t.mock.method(console, "error", () => undefined);
  await putLayer(databaseUrl, {
    contentHash: "poisoned-seed",
    version: 1,
    updatedAt: 1,
    updatedBy: "old-cli",
    bundle: { contract: 1, tools: [], skills: [{ path: "skills/broken/README.md", content: "no SKILL.md here" }] },
    resolved: publicRuntime(emptyDeploymentLayer()),
  });
  let attempts = 0;
  const store = layer({
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
  const { skills, layer } = fixture();
  const writer = layer();
  const booted = layer({
    seedFallback: async () => {
      const stale = await skills.create({
        scopeId: org,
        manifest: { name: "removed", description: "stale", requiredCapabilities: [], body: "stale" },
        createdBy: "system:deployment-layer",
      });
      await skills.review(stale.id, "system:deployment-layer-reviewer", []);
      await skills.publish(stale.id);
      await writer.put(
        {
          contract: 1,
          tools: [],
          skills: [
            { path: "skills/acme/SKILL.md", content: "---\nname: acme\ndescription: Durable.\n---\ndurable body\n" },
          ],
        },
        "api",
      );
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
  const { databaseUrl, layer } = fixture();
  const errors: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args.map(String).join(" ")));
  const runtime = resolvedDeploymentLayer("/fallback", []);
  const store = layer({
    runtime,
    retryDelaysMs: [],
    seedFallback: async () => {
      await putLayer(databaseUrl, {
        contentHash: "appeared-poisoned",
        version: 1,
        updatedAt: 1,
        updatedBy: "other-instance",
        bundle: { contract: 1, tools: [], skills: [{ path: "skills/broken/README.md", content: "no SKILL.md here" }] },
        resolved: publicRuntime(emptyDeploymentLayer()),
      });
    },
  });

  assert.equal((await store.hydrate())?.contentHash, "appeared-poisoned");
  assert.equal(store.live().source, "filesystem");
  assert.equal((await store.get())?.contentHash, "appeared-poisoned");
  assert.ok(errors.some((line) => line.includes("appeared-poisoned failed to apply")));
});

test("a mid-seed layer that fails during skill mutation keeps the fallback live and retries later", async () => {
  const { databaseUrl, skills: baseSkills, layer } = fixture();
  let creates = 0;
  const skills = {
    ...baseSkills,
    create: async (input: Parameters<typeof baseSkills.create>[0]) => {
      if (++creates === 2) throw new Error("skill write failed");
      return baseSkills.create(input);
    },
  };
  const runtime = resolvedDeploymentLayer("/fallback", []);
  const store = layer({
    runtime,
    skills,
    retryDelaysMs: [],
    seedFallback: async () => {
      await putLayer(databaseUrl, {
        contentHash: "appeared-partial",
        version: 1,
        updatedAt: 1,
        updatedBy: "other-instance",
        bundle: {
          contract: 1,
          tools: [],
          skills: [
            { path: "skills/a/SKILL.md", content: "---\nname: a\ndescription: A.\n---\na\n" },
            { path: "skills/b/SKILL.md", content: "---\nname: b\ndescription: B.\n---\nb\n" },
          ],
        },
        resolved: publicRuntime(emptyDeploymentLayer()),
      });
    },
  });

  assert.equal((await store.hydrate())?.contentHash, "appeared-partial");
  assert.equal(store.live().source, "filesystem");
  assert.equal((await store.hydrate())?.contentHash, "appeared-partial");
  assert.equal(store.live().source, "durable", "the refresh retry applies once the transient skill-store error clears");
});

test("misplaced tool files are rejected, not silently ignored", async () => {
  const { layer } = fixture();
  const store = layer();
  for (const path of ["tools/a/b/tool.json", "tools/loose.json", "tools/a/extra.txt"]) {
    await assert.rejects(
      store.put({ contract: 1, tools: [{ path, content: JSON.stringify({ id: "a" }) }], skills: [] }, "api"),
      /tool path must be tools\/<id>\/tool\.json/,
      path,
    );
  }
});

test("live() reports the runtime source and durable reflects the backing", async () => {
  const { layer } = fixture();
  const none = layer();
  assert.deepEqual(none.live(), { source: "none", contentHash: null, resolved: null });

  const fsRuntime = resolvedDeploymentLayer("/layer", []);
  const fs = layer({
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
  const { layer } = fixture();
  const store = layer();
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
  const { layer } = fixture();
  const store = layer();
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
  const { layer } = fixture();
  const store = layer();
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
  const { databaseUrl, layer } = fixture();
  const store = layer();
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
  assert.equal(await readLayer(databaseUrl), null);
});

test("hydrate reparses bundle descriptors instead of trusting stored resolved fields", async (t) => {
  const { databaseUrl, layer } = fixture();
  t.mock.method(console, "error", () => undefined);
  await putLayer(databaseUrl, {
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
  const store = layer({
    runtime,
    retryDelaysMs: [],
  });
  assert.equal((await store.hydrate())?.version, 7);
  assert.equal(await store.isApplied("legacy-unvalidated"), false);
  assert.equal(store.live().source, "filesystem");
  assert.deepEqual(runtime.advertisedTools, []);
});

test("hydrate derives runtime fields from the stored bundle, not the resolved cache", async () => {
  const { databaseUrl, layer } = fixture();
  const bundle = { contract: 1 as const, tools: [tool("bundle truth")], skills: [] };
  const writer = layer();
  const record = await writer.put(bundle, "writer");
  await putLayer(databaseUrl, {
    ...record,
    resolved: { ...record.resolved, advertisedTools: ["tampered cache"] },
  });
  const runtime = emptyDeploymentLayer();
  const reader = layer({
    runtime,
  });
  await reader.hydrate();
  assert.deepEqual(runtime.advertisedTools, ["bundle truth"]);
});
