import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";

function start() {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "skills-http-")),
      orgId: "acme",
      seedSkills: false,
    }),
  );
  const server = createInsecureTestServer(built.app);
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  return {
    base,
    skills: built.skills,
    directory: built.directory,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function publish(
  skills: ReturnType<typeof buildApp>["skills"],
  scope: ScopeId,
  name: string,
  description: string,
) {
  const sk = await skills.create({
    scopeId: scope,
    manifest: { name, description, requiredCapabilities: [], body: `# ${name}` },
    createdBy: "author",
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
}

interface SkillView {
  id: string;
  name: string;
  description: string;
  body?: string;
  scope: string;
  shadowed: boolean;
  editable: boolean;
  status?: string;
  version?: number;
}

test("GET /v1/skills returns metadata only; authorized detail fetch returns the body", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("org", "default-org"), "deploy-bot", "ship the bot to prod");
    await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");

    const res = await fetch(`${srv.base}/v1/skills?principalId=${encodeURIComponent("U1")}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { skills: SkillView[] };
    const byName = new Map(body.skills.map((s) => [s.name, s]));

    const mine = byName.get("make-digest")!;
    assert.equal(mine.scope, "personal");
    assert.equal(mine.body, undefined, "list rows do not eagerly expose instruction bodies");
    const detail = (await (await fetch(`${srv.base}/v1/skills/${mine.id}?principalId=U1`)).json()) as {
      skill: SkillView;
    };
    assert.equal(detail.skill.body, "# make-digest");
    assert.equal(mine.editable, true);
    assert.ok(mine.id);
    assert.equal(byName.get("deploy-bot")?.scope, "org");
    assert.equal(byName.get("deploy-bot")?.editable, false);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills marks a private-channel skill editable for a member and not for a non-member", async () => {
  const srv = start();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [
        { channelId: "C9", principalId: "avery" },
        { channelId: "C9", principalId: "jordan" },
      ],
    );
    await publish(srv.skills, scopeId("channel", "C9"), "team-thing", "shared in the channel");

    const forJordan = (await (await fetch(`${srv.base}/v1/skills?principalId=jordan`)).json()) as {
      skills: SkillView[];
    };
    const k = forJordan.skills.find((s) => s.name === "team-thing");
    assert.ok(k, "the channel skill is visible to a member");
    assert.equal(k!.scope, "channel");
    assert.equal(k!.editable, true, "a member may edit it");

    const forMallory = (await (await fetch(`${srv.base}/v1/skills?principalId=mallory`)).json()) as {
      skills: SkillView[];
    };
    assert.equal(
      forMallory.skills.find((s) => s.name === "team-thing"),
      undefined,
      "a non-member doesn't even see it",
    );
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id edits an owned personal skill in place and keeps it live", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
    const before = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const id = before.skills.find((s) => s.name === "make-digest")!.id;

    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", description: "a better digest", body: "# make-digest v2" }),
    });
    assert.equal(res.status, 200);

    const after = (await (await fetch(`${srv.base}/v1/skills/${id}?principalId=U1`)).json()) as { skill: SkillView };
    const mine = after.skill;
    assert.equal(mine.description, "a better digest");
    assert.equal(mine.body, "# make-digest v2");
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id refuses to edit a skill the caller doesn't own", async () => {
  const srv = start();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "secret", description: "theirs", requiredCapabilities: [], body: "# secret" },
      createdBy: "U2",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", description: "hijacked" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id archives an owned personal skill", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
    const before = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const id = before.skills.find((s) => s.name === "make-digest")!.id;

    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(res.status, 200);

    assert.equal((await srv.skills.get(id))?.status, "archived", "record remains as a reversible tombstone");
    const after = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    assert.equal(
      after.skills.find((s) => s.name === "make-digest")?.status,
      "archived",
      "manager can discover and restore it",
    );
  } finally {
    await srv.close();
  }
});

test("an archived skill can be restored by its manager", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "recover-me", "recoverable");
    const listed = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const id = listed.skills.find((skill) => skill.name === "recover-me")!.id;
    await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    const restored = await fetch(`${srv.base}/v1/skills/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await srv.skills.get(id))?.status, "published");
  } finally {
    await srv.close();
  }
});

test("an archived skill name can be reused for a replacement", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "replace-me", "old version");
    const listed = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const oldId = listed.skills.find((skill) => skill.name === "replace-me")!.id;
    await fetch(`${srv.base}/v1/skills/${oldId}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });

    const replacement = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "U1",
        name: "replace-me",
        description: "new version",
        body: "# replacement",
      }),
    });
    assert.equal(replacement.status, 201);
    const created = (await replacement.json()) as { skill: SkillView };
    assert.notEqual(created.skill.id, oldId);
    assert.equal(await srv.skills.get(oldId), null, "the reused name retires its archived tombstone");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id refuses a skill the caller doesn't own with 403", async () => {
  const srv = start();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "secret", description: "theirs", requiredCapabilities: [], body: "# secret" },
      createdBy: "U2",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(res.status, 403);
    assert.ok(await srv.skills.get(sk.id), "the other owner's skill is untouched");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id is a 404 for a skill that doesn't exist", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/skills/no-such-id`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills without principalId is a 400", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/skills`);
    assert.equal(res.status, 400);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills surfaces the shadowed flag when a personal skill overrides an org one", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("org", "default-org"), "notes", "org notes");
    await publish(srv.skills, scopeId("personal", "U1"), "notes", "U1 notes");

    const res = await fetch(`${srv.base}/v1/skills?principalId=U1`);
    const body = (await res.json()) as { skills: Array<{ name: string; scope: string; shadowed: boolean }> };
    const notes = body.skills.filter((s) => s.name === "notes");
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.scope, "personal");
    assert.equal(notes[0]!.shadowed, true);
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills can include every active scope variant without changing the default projection", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("org", "default-org"), "notes", "org notes");
    await publish(srv.skills, scopeId("personal", "U1"), "notes", "personal notes");

    const normal = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    assert.equal(normal.skills.filter((skill) => skill.name === "notes").length, 1);

    const expanded = (await (await fetch(`${srv.base}/v1/skills?principalId=U1&includeShadowed=1`)).json()) as {
      skills: SkillView[];
    };
    const notes = expanded.skills.filter((skill) => skill.name === "notes");
    assert.deepEqual(
      notes.map((skill) => skill.scope),
      ["personal", "org"],
    );
    assert.equal(notes[0]!.shadowed, true);
    assert.equal(notes[1]!.shadowed, false);
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills creates a personal skill that is then visible and editable", async () => {
  const srv = start();
  try {
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        principalId: "U1",
        name: "watch-ci",
        description: "watch the CI pipeline",
        body: "# watch-ci\nPoll the pipeline and report.",
      }),
    });
    assert.equal(res.status, 201);
    const created = (await res.json()) as { skill: SkillView };
    assert.equal(created.skill.name, "watch-ci");
    assert.equal(created.skill.status, "published");
    assert.ok(created.skill.id);

    const list = (await (await fetch(`${srv.base}/v1/skills?principalId=U1`)).json()) as { skills: SkillView[] };
    const mine = list.skills.find((s) => s.name === "watch-ci")!;
    assert.equal(mine.scope, "personal");
    assert.equal(mine.editable, true);
    assert.equal(mine.body, undefined);
    const detail = (await (await fetch(`${srv.base}/v1/skills/${mine.id}?principalId=U1`)).json()) as {
      skill: SkillView;
    };
    assert.equal(detail.skill.body, "# watch-ci\nPoll the pipeline and report.");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills rejects a duplicate name in the caller's personal scope with 409", async () => {
  const srv = start();
  try {
    await publish(srv.skills, scopeId("personal", "U1"), "watch-ci", "first one");
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", name: "watch-ci", description: "dup", body: "# dup" }),
    });
    assert.equal(res.status, 409);
    const err = (await res.json()) as { error: string };
    assert.equal(err.error, "exists");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills is a 400 when a required field is missing or blank", async () => {
  const srv = start();
  try {
    for (const bad of [
      { principalId: "U1", name: "x", description: "d" },
      { principalId: "U1", name: "  ", description: "d", body: "b" },
      { name: "x", description: "d", body: "b" },
    ]) {
      const res = await fetch(`${srv.base}/v1/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bad),
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
  } finally {
    await srv.close();
  }
});

test("a personal skill of the same name does NOT collide across principals", async () => {
  const srv = start();
  try {
    const mk = (pid: string) =>
      fetch(`${srv.base}/v1/skills`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ principalId: pid, name: "shared-name", description: `${pid} skill`, body: `# ${pid}` }),
      });
    assert.equal((await mk("U1")).status, 201);
    assert.equal((await mk("U2")).status, 201);
  } finally {
    await srv.close();
  }
});

async function startSecure() {
  const SECRET = "skills-http-cap-secret".repeat(3);
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "skills-http-cap-")),
      orgId: "acme",
      seedSkills: false,
      signingSecret: SECRET,
    }),
  );
  const server = createServer(built.app, { signingSecret: SECRET });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const cap = (actorId: string, scope: ScopeId = scopeId("personal", actorId), liveActor = true) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scope,
        aud: CONTROL_PLANE_AUD,
        ...(liveActor ? { liveActor: true } : {}),
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );
  return {
    base,
    cap,
    skills: built.skills,
    directory: built.directory,
    sessions: built.sessions,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("POST /v1/skills via a capability token authors as the token's own principal (body principalId ignored)", async () => {
  const srv = await startSecure();
  try {
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("U1") },
      body: JSON.stringify({
        principalId: "U2",
        name: "watch-ci",
        description: "watch the pipeline",
        body: "# watch-ci",
      }),
    });
    assert.equal(res.status, 201);

    const all = await srv.skills.list();
    const watch = all.find((sk) => sk.manifest.name === "watch-ci");
    assert.ok(watch, "the skill was created");
    assert.equal(
      watch!.scopeId,
      scopeId("personal", "U1"),
      "authored as the token's actor, not the spoofed body principalId",
    );
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills via a capability token from a private-channel scope homes the skill there, authored by the actor", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [
        { channelId: "C9", principalId: "avery" },
        { channelId: "C9", principalId: "jordan" },
      ],
    );
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("avery", scopeId("channel", "C9")),
      },
      body: JSON.stringify({ name: "team-thing", description: "d", body: "# b" }),
    });
    assert.equal(res.status, 201);
    const all = await srv.skills.list();
    const sk = all.find((s) => s.manifest.name === "team-thing");
    assert.ok(sk, "the skill was created");
    assert.equal(sk!.scopeId, scopeId("channel", "C9"), "homed in the channel, not avery's personal scope");
    assert.equal(sk!.createdBy, "avery", "provenance is the real author, never the scope");
    assert.equal(sk!.status, "published", "a membership-managed shared skill auto review+publishes");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills with a signing secret set rejects an unauthenticated (unsigned, no-token) request", async () => {
  const srv = await startSecure();
  try {
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", name: "x", description: "d", body: "# b" }),
    });
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id via a capability token edits the token-actor's own skill (body principalId ignored)", async () => {
  const srv = await startSecure();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U1"),
      manifest: { name: "make-digest", description: "v1", requiredCapabilities: [], body: "# v1" },
      createdBy: "U1",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("U1") },
      body: JSON.stringify({ principalId: "U2", description: "v2", body: "# v2" }),
    });
    assert.equal(res.status, 200);
    const after = await srv.skills.get(sk.id);
    assert.equal(after!.manifest.body, "# v2");
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id via a capability token cannot edit another scope's skill (404)", async () => {
  const srv = await startSecure();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "secret", description: "theirs", requiredCapabilities: [], body: "# secret" },
      createdBy: "U2",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);

    const res = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("U1") },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(res.status, 404);
    assert.equal((await srv.skills.get(sk.id))!.manifest.description, "theirs");
  } finally {
    await srv.close();
  }
});

async function seedChannelSkill(srv: Awaited<ReturnType<typeof startSecure>>) {
  await srv.directory.replaceChannels(
    [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
    [
      { channelId: "C9", principalId: "avery" },
      { channelId: "C9", principalId: "jordan" },
    ],
  );
  const res = await fetch(`${srv.base}/v1/skills`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-capability": await srv.cap("avery", scopeId("channel", "C9")),
    },
    body: JSON.stringify({ name: "team-thing", description: "v1", body: "# v1" }),
  });
  assert.equal(res.status, 201);
  return ((await res.json()) as { skill: { id: string } }).skill.id;
}

test("PUT /v1/skills/:id lets a DIFFERENT member of the home channel edit it, preserving provenance and staying live", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("jordan", scopeId("channel", "C9")),
      },
      body: JSON.stringify({ body: "# v2 by jordan" }),
    });
    assert.equal(res.status, 200);
    const after = await srv.skills.get(id);
    assert.equal(after!.manifest.body, "# v2 by jordan");
    assert.equal(after!.createdBy, "avery", "edit by a member never rewrites provenance");
    assert.equal(after!.status, "published", "a membership-managed edit re-publishes — no org review needed");
  } finally {
    await srv.close();
  }
});

test("PUT /v1/skills/:id from a member's own DM (not the channel) still edits — management follows membership, not the turn's scope", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("jordan") },
      body: JSON.stringify({ description: "from jordan's DM" }),
    });
    assert.equal(res.status, 200);
    assert.equal((await srv.skills.get(id))!.manifest.description, "from jordan's DM");
  } finally {
    await srv.close();
  }
});

test("PUT/DELETE /v1/skills/:id refuse a NON-member of the home channel (404/403)", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("mallory") },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(edit.status, 404);
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("mallory") },
    });
    assert.equal(del.status, 403);
    assert.ok(await srv.skills.get(id), "the channel's skill is untouched by a non-member");
    assert.equal((await srv.skills.get(id))!.manifest.description, "v1");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id lets any member of the home channel archive it", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const res = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("jordan") },
    });
    assert.equal(res.status, 200);
    assert.equal((await srv.skills.get(id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("an author who LEAVES a private channel loses inline CRUD on its skill (membership, not authorship, decides)", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [{ channelId: "C9", principalId: "jordan" }],
    );
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("avery") },
      body: JSON.stringify({ description: "ex-member edit" }),
    });
    assert.equal(edit.status, 404, "an ex-member author cannot edit a private-channel skill");
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("avery") },
    });
    assert.equal(del.status, 403, "an ex-member author cannot delete it either");
    const k = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("jordan") },
      body: JSON.stringify({ description: "still managed by the remaining member" }),
    });
    assert.equal(k.status, 200);
  } finally {
    await srv.close();
  }
});

test("management tracks CURRENT directory membership, not a stale session — a session-only non-member cannot edit", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const sess = await srv.sessions.getOrCreateByThread("C9:t1", "channel", scopeId("channel", "C9"), "avery-jordan");
    await srv.sessions.addParticipant(sess.id, "dana");
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("dana") },
      body: JSON.stringify({ description: "stale-session edit" }),
    });
    assert.equal(edit.status, 404, "a session-only non-member cannot manage — management reads current membership");
    assert.equal((await srv.skills.get(id))!.manifest.description, "v1", "untouched");
  } finally {
    await srv.close();
  }
});

test("a shared-scope skill cannot be created/edited/deleted by an automated trigger (no liveActor)", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [{ channelId: "C9", principalId: "avery" }],
    );
    const triggerTok = await srv.cap("avery", scopeId("channel", "C9"), false);
    const create = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": triggerTok },
      body: JSON.stringify({ name: "auto-thing", description: "d", body: "# b" }),
    });
    assert.equal(create.status, 403, "an automated trigger cannot create a shared skill");
    assert.equal(
      (await srv.skills.list()).find((s) => s.manifest.name === "auto-thing"),
      undefined,
    );

    const id = await seedChannelSkill(srv);
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": triggerTok },
      body: JSON.stringify({ description: "auto edit" }),
    });
    assert.equal(edit.status, 403);
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": triggerTok },
    });
    assert.equal(del.status, 403);
    assert.ok(await srv.skills.get(id), "the shared skill survives an automated trigger");

    const personalTrigger = await srv.cap("solo", scopeId("personal", "solo"), false);
    const own = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": personalTrigger },
      body: JSON.stringify({ name: "solo-skill", description: "d", body: "# b" }),
    });
    assert.equal(own.status, 201, "a trigger in its owner's own DM may still save a personal skill");
  } finally {
    await srv.close();
  }
});

test("a PERSONAL-scope trigger (no liveActor) cannot edit or delete a skill homed in a private channel it is a member of", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const personalTrigger = await srv.cap("avery", scopeId("personal", "avery"), false);
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": personalTrigger },
      body: JSON.stringify({ body: "# rewritten by a personal-scope trigger" }),
    });
    assert.equal(edit.status, 403, "a personal-scope trigger cannot rewrite a shared skill");
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": personalTrigger },
    });
    assert.equal(del.status, 403, "a personal-scope trigger cannot delete a shared skill");
    const survivor = await srv.skills.get(id);
    assert.ok(survivor, "the shared skill survives the personal-scope trigger");
    assert.equal(survivor!.manifest.body, "# v1", "and its body is untouched");
  } finally {
    await srv.close();
  }
});

test("a LIVE member of a private channel may edit + delete its skill from their own DM (personal token, liveActor)", async () => {
  const srv = await startSecure();
  try {
    const id = await seedChannelSkill(srv);
    const liveJordan = await srv.cap("jordan");
    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": liveJordan },
      body: JSON.stringify({ description: "edited live by a member" }),
    });
    assert.equal(edit.status, 200, "a live member may edit the shared skill");
    assert.equal((await srv.skills.get(id))!.manifest.description, "edited live by a member");
    const del = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": liveJordan },
    });
    assert.equal(del.status, 200, "and delete it");
    assert.equal((await srv.skills.get(id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("a PERSONAL-scope trigger (no liveActor) may still edit + delete its OWNER'S OWN personal skill", async () => {
  const srv = await startSecure();
  try {
    const sk = await srv.skills.create({
      scopeId: scopeId("personal", "solo"),
      manifest: { name: "solo-skill", description: "v1", requiredCapabilities: [], body: "# v1" },
      createdBy: "solo",
    });
    await srv.skills.review(sk.id, "reviewer-1", []);
    await srv.skills.publish(sk.id);
    const personalTrigger = await srv.cap("solo", scopeId("personal", "solo"), false);
    const edit = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": personalTrigger },
      body: JSON.stringify({ body: "# v2 by the owner's trigger" }),
    });
    assert.equal(edit.status, 200, "an owner's trigger may edit its own personal skill");
    assert.equal((await srv.skills.get(sk.id))!.manifest.body, "# v2 by the owner's trigger");
    const del = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": personalTrigger },
    });
    assert.equal(del.status, 200, "and delete it");
    assert.equal((await srv.skills.get(sk.id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("a group-DM skill is editable by any group member (the group-DM analog of a private channel)", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceGroups([
      { groupId: "G7", principalId: "ann" },
      { groupId: "G7", principalId: "bob" },
    ]);
    const created = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("ann", scopeId("group", "G7")),
      },
      body: JSON.stringify({ name: "grouped", description: "v1", body: "# v1" }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { skill: { id: string } }).skill.id;
    assert.equal((await srv.skills.get(id))!.scopeId, scopeId("group", "G7"));

    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("bob") },
      body: JSON.stringify({ body: "# v2 by bob" }),
    });
    assert.equal(edit.status, 200);
    assert.equal((await srv.skills.get(id))!.manifest.body, "# v2 by bob");
  } finally {
    await srv.close();
  }
});

test("POST /v1/skills refuses to home a skill directly in an org or team scope (promotion path only)", async () => {
  const srv = await startSecure();
  try {
    for (const home of [scopeId("org", "default-org"), scopeId("team", "T1")]) {
      const res = await fetch(`${srv.base}/v1/skills`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("author", home) },
        body: JSON.stringify({ name: `wide-${home}`, description: "d", body: "# b" }),
      });
      assert.equal(res.status, 403, `${home}: must refuse inline create into a promotion-gated scope`);
      assert.equal(
        (await srv.skills.list()).find((s) => s.manifest.name === `wide-${home}`),
        undefined,
        `${home}: nothing created`,
      );
    }
  } finally {
    await srv.close();
  }
});

test("GET /v1/skills shows a group-DM skill to a member known only via directory membership", async () => {
  const srv = start();
  try {
    await srv.directory.replaceGroups([
      { groupId: "G7", principalId: "ann" },
      { groupId: "G7", principalId: "bob" },
    ]);
    await publish(srv.skills, scopeId("group", "G7"), "grouped", "shared in the group DM");
    const forBob = (await (await fetch(`${srv.base}/v1/skills?principalId=bob`)).json()) as { skills: SkillView[] };
    const g = forBob.skills.find((s) => s.name === "grouped");
    assert.ok(g, "the group skill shows up for a directory-only group member");
    assert.equal(g!.editable, true, "and a group member may edit it");
    const forCarol = (await (await fetch(`${srv.base}/v1/skills?principalId=carol`)).json()) as { skills: SkillView[] };
    assert.equal(
      forCarol.skills.find((s) => s.name === "grouped"),
      undefined,
    );
  } finally {
    await srv.close();
  }
});

test("an ORG- or TEAM-homed skill is never inline-managed, even by its author (promotion/admin only)", async () => {
  const srv = await startSecure();
  try {
    for (const home of [scopeId("org", "default-org"), scopeId("team", "T1")]) {
      const sk = await srv.skills.create({
        scopeId: home,
        manifest: { name: `wide-${home.replace(":", "-")}`, description: "v1", requiredCapabilities: [], body: "# v1" },
        createdBy: "author",
      });
      await srv.skills.review(sk.id, "reviewer-1", []);
      await srv.skills.publish(sk.id);

      const edit = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-agent-capability": await srv.cap("author") },
        body: JSON.stringify({ description: "inline edit" }),
      });
      assert.equal(edit.status, 404, `${home}: author cannot inline-edit a wide-scope skill`);
      const after = await srv.skills.get(sk.id);
      assert.equal(after!.manifest.description, "v1", `${home}: untouched`);
      assert.equal(after!.status, "published", `${home}: still published, not silently demoted`);

      const del = await fetch(`${srv.base}/v1/skills/${sk.id}`, {
        method: "DELETE",
        headers: { "x-agent-capability": await srv.cap("author") },
      });
      assert.equal(del.status, 403, `${home}: author cannot inline-delete a wide-scope skill`);
      assert.ok(await srv.skills.get(sk.id), `${home}: the org/team copy survives`);
    }
  } finally {
    await srv.close();
  }
});

test("a PUBLIC channel (self-joinable) stays owner-only — a non-author member cannot edit it", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels([{ channelId: "CPUB", name: "general", isPrivate: false }], []);
    const created = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("owner", scopeId("channel", "CPUB")),
      },
      body: JSON.stringify({ name: "pub-skill", description: "v1", body: "# v1" }),
    });
    assert.equal(created.status, 201);
    const id = ((await created.json()) as { skill: { id: string } }).skill.id;

    const edit = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("rando", scopeId("channel", "CPUB")),
      },
      body: JSON.stringify({ description: "hijacked" }),
    });
    assert.equal(edit.status, 404);
    const own = await fetch(`${srv.base}/v1/skills/${id}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await srv.cap("owner", scopeId("channel", "CPUB")),
      },
      body: JSON.stringify({ description: "owner edit" }),
    });
    assert.equal(own.status, 200);
    assert.equal((await srv.skills.get(id))!.manifest.description, "owner edit");
  } finally {
    await srv.close();
  }
});

test("DELETE /v1/skills/:id via a capability token archives the token-actor's own skill; cannot cross scopes", async () => {
  const srv = await startSecure();
  try {
    const mine = await srv.skills.create({
      scopeId: scopeId("personal", "U1"),
      manifest: { name: "mine", description: "d", requiredCapabilities: [], body: "# mine" },
      createdBy: "U1",
    });
    const theirs = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "theirs", description: "d", requiredCapabilities: [], body: "# theirs" },
      createdBy: "U2",
    });

    const cross = await fetch(`${srv.base}/v1/skills/${theirs.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("U1") },
    });
    assert.equal(cross.status, 403);
    assert.ok(await srv.skills.get(theirs.id), "another principal's skill survives");

    const own = await fetch(`${srv.base}/v1/skills/${mine.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": await srv.cap("U1") },
    });
    assert.equal(own.status, 200);
    assert.equal((await srv.skills.get(mine.id))?.status, "archived");
  } finally {
    await srv.close();
  }
});
