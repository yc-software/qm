import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function fresh() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "resource-search-")), seedSkills: false }));
}

test("resource search filters private data, includes owned drafts, and bounds snippets", async () => {
  const { app, skills } = fresh();
  const owned = await skills.create({
    scopeId: "personal:U1",
    createdBy: "U1",
    manifest: {
      name: "zanzibar-review",
      description: "zanzibar ".repeat(1000),
      body: "not searchable private body",
      requiredCapabilities: [],
    },
  });
  await skills.create({
    scopeId: "personal:U2",
    createdBy: "U2",
    manifest: {
      name: "zanzibar-secret",
      description: "secret",
      body: "secret",
      requiredCapabilities: [],
    },
  });
  const cron = await app.createCron({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1",
    action: "zanzibar ".repeat(200),
    schedule: { everyMs: 60000 },
  });
  await app.createCron({
    owner: "U2",
    createdBy: "U2",
    ownerScopeId: "personal:U2",
    action: "zanzibar private",
    schedule: { everyMs: 60000 },
  });
  const result = await app.searchResources("U1", "zanzibar");
  assert.deepEqual(result.failed, []);
  assert.deepEqual(new Set(result.hits.map((h) => h.id)), new Set([owned.id, cron.id]));
  assert.ok(result.hits.every((h) => h.title.length <= 121 && h.snippet.length <= 242));
  assert.ok(result.hits.every((h) => Object.keys(h).sort().join() === "id,kind,snippet,title"));
  assert.deepEqual(await app.searchResources("U1", " "), { hits: [], failed: [], limited: [] });
  assert.deepEqual(await app.searchResources("U1", "not searchable private body"), {
    hits: [],
    failed: [],
    limited: [],
  });
});

test("revoked project membership removes both project and cron hits, even for the creator", async () => {
  const { app } = fresh();
  await app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await app.createProject("owner", "Zanzibar launch");
  assert.ok(project);
  await app.addProjectMember(project.id, "owner", "member");
  const cron = await app.createCron({
    owner: "member",
    createdBy: "member",
    ownerScopeId: project.scopeId,
    action: "zanzibar work",
    schedule: { everyMs: 60000 },
  });
  let result = await app.searchResources("member", "zanzibar");
  assert.ok(result.hits.some((h) => h.id === cron.id));
  assert.ok(result.hits.some((h) => h.id === project.scopeId));
  await app.removeProjectMember(project.id, "owner", "member");
  result = await app.searchResources("member", "zanzibar");
  assert.equal(result.hits.length, 0);
});

test("private matches within the candidate cap are filtered and authorized hits are bounded", async () => {
  const { app } = fresh();
  for (let i = 0; i < 65; i++)
    await app.createCron({
      owner: "U2",
      createdBy: "U2",
      ownerScopeId: "personal:U2",
      title: `zanzibar private ${i}`,
      action: `zanzibar private ${i}`,
      schedule: { everyMs: 60000 },
    });
  const ids = new Set<string>();
  for (let i = 0; i < 12; i++)
    ids.add(
      (
        await app.createCron({
          owner: "U1",
          createdBy: "U1",
          ownerScopeId: "personal:U1",
          title: `zanzibar own ${i}`,
          action: `zanzibar own ${i}`,
          schedule: { everyMs: 60000 },
        })
      ).id,
    );
  const result = await app.searchResources("U1", "zanzibar");
  assert.equal(result.hits.length, 8);
  assert.ok(result.hits.every((h) => ids.has(h.id)));
});

test("private matches beyond the candidate cap reveal no search metadata", async () => {
  const { app } = fresh();
  const empty = await app.searchResources("U1", "zanzibar");
  for (let i = 0; i < 201; i++)
    await app.createCron({
      owner: `private${Math.floor(i / 100)}`,
      createdBy: `private${Math.floor(i / 100)}`,
      ownerScopeId: `personal:private${Math.floor(i / 100)}`,
      title: `zanzibar private ${i}`,
      action: `zanzibar private ${i}`,
      schedule: { everyMs: 60000 },
    });
  assert.deepEqual(await app.searchResources("U1", "zanzibar"), empty);
});

test("published skill search resolves shadowing without calling the full visible-skills API", async () => {
  const { app, skills } = fresh();
  for (const home of ["org:default-org", "personal:U1"] as const) {
    const skill = await skills.create({
      scopeId: home,
      createdBy: "author",
      manifest: {
        name: "zanzibar",
        description: `release in ${home}`,
        body: "x".repeat(100000),
        requiredCapabilities: [],
      },
    });
    await skills.review(skill.id, "reviewer", []);
    await skills.publish(skill.id);
  }
  app.listVisibleSkills = async () => {
    throw new Error("must not load full registry");
  };
  const result = await app.searchResources("U1", "zanzibar");
  assert.deepEqual(result.failed, []);
  assert.equal(result.hits.length, 1);
  assert.ok(result.hits[0]!.snippet.includes("personal:U1"));
});

test("webhook search uses the existing owner and project controls without exposing verification secrets", async () => {
  const { app } = fresh();
  const own = await app.createWebhook({
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: "personal:U1",
    action: "zanzibar event",
    verification: { scheme: "github", secret: "private-signing-secret" },
  });
  await app.createWebhook({
    owner: "U2",
    createdBy: "U2",
    ownerScopeId: "personal:U2",
    action: "zanzibar hidden",
    verification: { scheme: "github", secret: "another-secret" },
  });
  const result = await app.searchResources("U1", "zanzibar");
  assert.deepEqual(
    result.hits.map((h) => h.id),
    [own.id],
  );
  assert.equal(JSON.stringify(result).includes("secret"), false);
});
