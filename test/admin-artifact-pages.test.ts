import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function start() {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-artifacts-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    errors: built.errors,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return { base, built, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const ALICE_ADMIN = { "x-admin-actor": "admin-alice@default-org" };
const json = async (r: Response): Promise<any> => r.json();

test("per-kind artifact reads are scope-filtered, authz-gated, and audited", async () => {
  const s = start();
  try {
    await s.built.app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
      destination: { type: "slack", target: "D1", audienceScopeId: "personal:U1" },
    });
    await s.built.app.createCron({
      ownerScopeId: "personal:OTHER",
      owner: "U9",
      createdBy: "U9",
      schedule: { everyMs: 60_000 },
      action: "noise",
    });
    const madeSkill = await s.built.skills.create({
      scopeId: "personal:U1",
      manifest: { name: "summarize", description: "sum it up", requiredCapabilities: [], body: "..." },
      createdBy: "U1",
    });
    await s.built.skills.recordUse(madeSkill.id, 777);

    const crons = await json(await fetch(`${s.base}/v1/admin/crons?scope=personal:U1`, { headers: ALICE_ADMIN }));
    assert.equal(crons.crons.length, 1, "crons from other scopes are filtered out");
    assert.equal(crons.crons[0].action, "ping");
    assert.equal(crons.crons[0].createdBy, "U1");
    assert.equal(crons.crons[0].schedule.everyMs, 60_000);
    assert.deepEqual(crons.crons[0].destination, { type: "slack", target: "D1", audienceScopeId: "personal:U1" });
    assert.ok(crons.crons[0].createdAt > 0, "rows carry createdAt for the dashboard");

    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=personal:U1`, { headers: ALICE_ADMIN }));
    assert.equal(skills.skills.length, 1);
    assert.equal(skills.skills[0].name, "summarize");
    assert.equal(skills.skills[0].description, "sum it up");
    assert.equal(skills.skills[0].status, "draft");
    assert.equal(skills.skills[0].lastUsedAt, 777, "rows carry lastUsedAt for the recency sort");

    const deployments = await json(
      await fetch(`${s.base}/v1/admin/deployments?scope=personal:U1`, { headers: ALICE_ADMIN }),
    );
    assert.deepEqual(
      deployments,
      { scopeId: "personal:U1", deployments: [] },
      "a scope with no deployments answers an honest empty list",
    );

    for (const kind of ["crons", "deployments", "skills"]) {
      assert.equal(
        (await fetch(`${s.base}/v1/admin/${kind}`, { headers: ALICE_ADMIN })).status,
        400,
        `${kind}: scope is required`,
      );
      assert.equal(
        (
          await fetch(`${s.base}/v1/admin/${kind}?scope=personal:U1`, {
            headers: { "x-admin-actor": "nobody@default-org" },
          })
        ).status,
        403,
        `${kind}: admin-only`,
      );
      assert.ok(
        (await s.built.auditLog.events()).some((e) => e.action === `${kind}.read` && e.scopeLabel === "personal:U1"),
        `${kind}: the read is audited`,
      );
    }
  } finally {
    await s.close();
  }
});

test("an admin can edit and clear a cron destination inside the administered scope", async () => {
  const s = start();
  try {
    const cron = await s.built.app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
    });

    const set = await fetch(`${s.base}/v1/admin/crons/${encodeURIComponent(cron.id)}/destination?scope=personal:U1`, {
      method: "PUT",
      headers: { ...ALICE_ADMIN, "content-type": "application/json" },
      body: JSON.stringify({
        destination: { type: "principal", target: "U2", audienceScopeId: "personal:U2", onBehalfOf: "U1" },
      }),
    });
    assert.equal(set.status, 200);
    assert.equal((await s.built.app.getCron(cron.id))?.destination?.target, "U2");

    const invalid = await fetch(
      `${s.base}/v1/admin/crons/${encodeURIComponent(cron.id)}/destination?scope=personal:U1`,
      {
        method: "PUT",
        headers: { ...ALICE_ADMIN, "content-type": "application/json" },
        body: JSON.stringify({ destination: { type: "email", target: "ops@example.com" } }),
      },
    );
    assert.equal(invalid.status, 400, "admin destination edits stay limited to current destination shapes");

    const outsideScope = await fetch(
      `${s.base}/v1/admin/crons/${encodeURIComponent(cron.id)}/destination?scope=channel:C9`,
      {
        method: "PUT",
        headers: { ...ALICE_ADMIN, "content-type": "application/json" },
        body: JSON.stringify({ destination: { type: "slack", target: "C9", audienceScopeId: "channel:C9" } }),
      },
    );
    assert.equal(outsideScope.status, 403, "a scoped admin route cannot edit another scope's cron");

    const clear = await fetch(`${s.base}/v1/admin/crons/${encodeURIComponent(cron.id)}/destination?scope=personal:U1`, {
      method: "PUT",
      headers: { ...ALICE_ADMIN, "content-type": "application/json" },
      body: JSON.stringify({ destination: null }),
    });
    assert.equal(clear.status, 200);
    assert.equal((await s.built.app.getCron(cron.id))?.destination, undefined);
    assert.ok(
      (await s.built.auditLog.events()).some(
        (e) => e.action === "cron.destination.update" && e.scopeLabel === "personal:U1",
      ),
      "the admin edit is audited",
    );
  } finally {
    await s.close();
  }
});

test("a single skill drills in to its body, capabilities, and approvals — scope-pinned and audited", async () => {
  const s = start();
  try {
    const made = await s.built.skills.create({
      scopeId: "personal:U1",
      manifest: {
        name: "summarize",
        description: "sum it up",
        requiredCapabilities: ["egress:example.com"],
        body: "# Summarize\nDo the thing.",
      },
      createdBy: "U1",
    });

    const got = await json(
      await fetch(`${s.base}/v1/admin/skills/${made.id}?scope=personal:U1`, { headers: ALICE_ADMIN }),
    );
    assert.equal(got.name, "summarize");
    assert.equal(got.body, "# Summarize\nDo the thing.", "the full SKILL.md body comes back for the drill-in");
    assert.deepEqual(got.requiredCapabilities, ["egress:example.com"]);
    assert.ok(
      (await s.built.auditLog.events()).some((e) => e.action === "skill.read" && e.scopeLabel === "personal:U1"),
      "the read is audited",
    );

    assert.equal(
      (await fetch(`${s.base}/v1/admin/skills/${made.id}?scope=channel:C9`, { headers: ALICE_ADMIN })).status,
      403,
      "a narrower scope can't read another scope's skill",
    );
    const orgGot = await json(
      await fetch(`${s.base}/v1/admin/skills/${made.id}?scope=org:default-org`, { headers: ALICE_ADMIN }),
    );
    assert.equal(orgGot.id, made.id, "an org scope reads any skill");
    assert.equal(
      (await fetch(`${s.base}/v1/admin/skills/does-not-exist?scope=org:default-org`, { headers: ALICE_ADMIN })).status,
      404,
    );
    assert.equal(
      (
        await fetch(`${s.base}/v1/admin/skills/${made.id}?scope=personal:U1`, {
          headers: { "x-admin-actor": "nobody@default-org" },
        })
      ).status,
      403,
      "admin-only",
    );
  } finally {
    await s.close();
  }
});

test('an org scope reads everything — the dashboard\'s default "All scopes" view', async () => {
  const s = start();
  try {
    await s.built.app.createCron({
      ownerScopeId: "personal:U1",
      owner: "U1",
      createdBy: "U1",
      schedule: { everyMs: 60_000 },
      action: "ping",
    });
    await s.built.app.createCron({
      ownerScopeId: "channel:C9",
      owner: "U2",
      createdBy: "U2",
      schedule: { everyMs: 60_000 },
      action: "digest",
    });
    await s.built.skills.create({
      scopeId: "personal:U1",
      manifest: { name: "summarize", description: "sum it up", requiredCapabilities: [], body: "..." },
      createdBy: "U1",
    });
    s.built.errors.record({
      category: "turn",
      code: "boom",
      message: "redacted",
      scopeLabel: "personal:U1",
      sessionId: "sess-1",
    });
    s.built.errors.record({ category: "turn", code: "bang", message: "redacted", scopeLabel: "channel:C9" });

    const crons = await json(await fetch(`${s.base}/v1/admin/crons?scope=org:default-org`, { headers: ALICE_ADMIN }));
    assert.deepEqual(
      crons.crons.map((c: any) => c.ownerScopeId).sort(),
      ["channel:C9", "personal:U1"],
      "org scope lists every scope's crons, labelled with their owner scope",
    );

    const skills = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ALICE_ADMIN }));
    assert.ok(
      skills.skills.some((k: any) => k.ownerScopeId === "personal:U1"),
      "org scope includes other scopes' skills (alongside the seeded org ones)",
    );

    const errors = await json(await fetch(`${s.base}/v1/admin/errors?scope=org:default-org`, { headers: ALICE_ADMIN }));
    assert.deepEqual(
      errors.errors.map((e: any) => e.scopeLabel).sort(),
      ["channel:C9", "personal:U1"],
      "org scope sees every scope's errors",
    );
    const scoped = await json(await fetch(`${s.base}/v1/admin/errors?scope=personal:U1`, { headers: ALICE_ADMIN }));
    assert.deepEqual(
      scoped.errors.map((e: any) => e.scopeLabel),
      ["personal:U1"],
      "a non-org scope still filters",
    );
    const bySession = await json(
      await fetch(`${s.base}/v1/admin/errors?scope=org:default-org&sessionId=sess-1`, { headers: ALICE_ADMIN }),
    );
    assert.deepEqual(
      bySession.errors.map((e: any) => e.code),
      ["boom"],
      "sessionId narrows to that session's errors (the transcript error strip)",
    );
    const noSession = await json(
      await fetch(`${s.base}/v1/admin/errors?scope=org:default-org&sessionId=sess-none`, { headers: ALICE_ADMIN }),
    );
    assert.deepEqual(noSession.errors, [], "an unknown sessionId matches nothing");

    const audit = await json(await fetch(`${s.base}/v1/admin/audit?scope=org:default-org`, { headers: ALICE_ADMIN }));
    assert.ok(
      audit.events.some((e: any) => e.scopeLabel !== "org:default-org"),
      "org scope sees admin activity on every scope, not just org-labelled events",
    );
  } finally {
    await s.close();
  }
});

test("the skills list + detail link an imported skill to its pack; built-in/personal skills don't", async () => {
  const s = start();
  try {
    const pack = await s.built.app.registerSkillPack({
      kind: "git",
      url: "https://github.com/acme/skills-pack.git",
      ref: "main",
      syncMode: "pinned",
      trustTier: "third-party",
      targetScopeId: "org:default-org",
      subset: "all",
      createdBy: "admin-alice",
    });
    const imported = await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "from-pack", description: "imported", requiredCapabilities: [], body: "..." },
      createdBy: `pack:${pack.id}`,
      pack: { packId: pack.id, commit: "abc123", upstreamName: "from-pack" },
    });
    await s.built.skills.create({
      scopeId: "org:default-org",
      manifest: { name: "homegrown", description: "local", requiredCapabilities: [], body: "..." },
      createdBy: "system:plugin-skills",
    });

    const list = await json(await fetch(`${s.base}/v1/admin/skills?scope=org:default-org`, { headers: ALICE_ADMIN }));
    const listImported = list.skills.find((k: any) => k.name === "from-pack");
    assert.deepEqual(
      listImported.pack,
      { id: pack.id, url: "https://github.com/acme/skills-pack.git" },
      "an imported skill carries its pack {id,url} so Created-by can link to it",
    );
    const listSeeded = list.skills.find((k: any) => k.name === "homegrown");
    assert.equal(
      listSeeded.pack,
      undefined,
      "a built-in/personal skill has no pack — the column falls back to createdBy",
    );

    const detail = await json(
      await fetch(`${s.base}/v1/admin/skills/${imported.id}?scope=org:default-org`, { headers: ALICE_ADMIN }),
    );
    assert.deepEqual(
      detail.pack,
      { id: pack.id, url: "https://github.com/acme/skills-pack.git" },
      "the drill-in detail carries the same pack provenance",
    );
  } finally {
    await s.close();
  }
});
