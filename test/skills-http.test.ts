import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer, createServer } from "../src/api/server.ts";
import { buildApp } from "./support/build-app.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import type { ToolContext } from "../src/tools/primitives.ts";
import { createSelfApiCall, type SelfApiCall } from "../src/tools/self-api.ts";
import { SHARED_SKILL_TRIGGER_REFUSAL } from "../src/api/artifact-share.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { SKILL_NAME_RULE } from "../src/skills/skill-name.ts";
import { sleep } from "../src/util/async.ts";

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

test("restoring an archived skill is a 409 when a live skill already has its name", async () => {
  const srv = start();
  try {
    const home = scopeId("personal", "U1");
    const old = await srv.skills.create({
      scopeId: home,
      manifest: { name: "recover-me", description: "old", requiredCapabilities: [], body: "# old" },
      createdBy: "U1",
    });
    await srv.skills.archive(old.id);
    await publish(srv.skills, home, "recover-me", "live");
    const restored = await fetch(`${srv.base}/v1/skills/${old.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1" }),
    });
    assert.equal(restored.status, 409);
    const live = (await srv.skills.list()).filter(
      (s) => s.scopeId === home && s.manifest.name === "recover-me" && s.status !== "archived",
    );
    assert.equal(live.length, 1);
    assert.equal((await srv.skills.get(old.id))?.status, "archived");
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

test("POST /v1/skills is a 409 when the name has a live skill beside an archived one", async () => {
  const srv = start();
  try {
    const home = scopeId("personal", "U1");
    const draft = await srv.skills.create({
      scopeId: home,
      manifest: { name: "watch-ci", description: "old", requiredCapabilities: [], body: "# old" },
      createdBy: "U1",
    });
    await srv.skills.delete(draft.id);
    await srv.skills.restore({ ...draft, id: "00000000-0000-4000-8000-000000000000", status: "archived" });
    await publish(srv.skills, home, "watch-ci", "live");
    const res = await fetch(`${srv.base}/v1/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "U1", name: "watch-ci", description: "dup", body: "# dup" }),
    });
    assert.equal(res.status, 409);
    const live = (await srv.skills.list()).filter(
      (s) => s.scopeId === home && s.manifest.name === "watch-ci" && s.status !== "archived",
    );
    assert.equal(live.length, 1);
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

test("concurrent POST /v1/skills of one name in one scope save it once and 409 the rest", async () => {
  const srv = start();
  const list = srv.skills.list;
  srv.skills.list = async () => {
    const rows = await list();
    await sleep(50);
    return rows;
  };
  try {
    const statuses = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        fetch(`${srv.base}/v1/skills`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            principalId: "U1",
            name: "watch-ci",
            description: `attempt ${i}`,
            body: "# watch-ci",
          }),
        }).then((res) => res.status),
      ),
    );
    assert.deepEqual(
      statuses.toSorted((a, b) => a - b),
      [201, 409, 409, 409, 409],
    );
    const rows = (await srv.skills.list()).filter(
      (s) => s.scopeId === scopeId("personal", "U1") && s.manifest.name === "watch-ci",
    );
    assert.equal(rows.length, 1);
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
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    config: built.config,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const cap = (actorId: string, scope: ScopeId = scopeId("personal", actorId), liveActor = true, botActor = false) =>
    mintCapabilityToken(
      {
        actorId,
        scopeId: scope,
        aud: CONTROL_PLANE_AUD,
        ...(liveActor ? { liveActor: true } : {}),
        ...(botActor ? { botActor: true } : {}),
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
    config: built.config,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function skillsDefinition(selfApi?: SelfApiCall) {
  return createAgentTools(
    { current: (selfApi ? { selfApi } : {}) as unknown as ToolContext },
    {
      controlTools: true,
    },
  ).find((t) => t.name === "skills")!;
}

function skillsActions(selfApi?: SelfApiCall) {
  const { parameters } = skillsDefinition(selfApi) as unknown as {
    parameters: { properties: { action: { anyOf: Array<{ const: string }> } } };
  };
  return parameters.properties.action.anyOf.map((a) => a.const);
}

function skillsTool(selfApi?: SelfApiCall) {
  const tool = skillsDefinition(selfApi);
  return async (args: Record<string, unknown>) => {
    const result = await tool.execute("call", args, undefined, undefined, {} as never);
    return (result.content[0] as { text: string }).text;
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
    await srv.directory.replaceChannels(
      [{ channelId: "CPUB", name: "general", isPrivate: false }],
      ["owner", "rando"].map((principalId) => ({ channelId: "CPUB", principalId })),
    );
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

test("a capability token reads and restores its archived skill without losing identity, files, or version", async () => {
  const srv = await startSecure();
  try {
    const created = await srv.skills.create({
      scopeId: scopeId("personal", "U1"),
      manifest: {
        name: "recover-me",
        description: "recoverable",
        requiredCapabilities: [],
        body: "# recover-me",
        files: [{ path: "scripts/run.sh", content: "exit 0", executable: true }],
      },
      createdBy: "U1",
    });
    await srv.skills.review(created.id, "reviewer-1", []);
    await srv.skills.publish(created.id);
    const before = (await srv.skills.get(created.id))!;
    const token = await srv.cap("U1");

    const archived = await fetch(`${srv.base}/v1/skills/${created.id}`, {
      method: "DELETE",
      headers: { "x-agent-capability": token },
    });
    assert.equal(archived.status, 200);

    const detail = await fetch(`${srv.base}/v1/skills/${created.id}`, {
      headers: { "x-agent-capability": token },
    });
    assert.equal(detail.status, 200);
    const detailBody = (await detail.json()) as {
      skill: { id: string; body: string; status: string; version: number; files: Array<{ path: string }> };
    };
    assert.equal(detailBody.skill.id, before.id);
    assert.equal(detailBody.skill.body, before.manifest.body);
    assert.equal(detailBody.skill.status, "archived");
    assert.equal(detailBody.skill.version, before.version);
    assert.deepEqual(detailBody.skill.files, [{ path: "scripts/run.sh", executable: true }]);

    const restored = await fetch(`${srv.base}/v1/skills/${created.id}/restore`, {
      method: "POST",
      headers: { "x-agent-capability": token },
    });
    assert.equal(restored.status, 200);
    const after = (await srv.skills.get(created.id))!;
    assert.equal(after.id, before.id);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.manifest.files, before.manifest.files);
    assert.equal(after.status, "published");
  } finally {
    await srv.close();
  }
});

test("skill detail and restore capability calls hide other principals' skills and require identity", async () => {
  const srv = await startSecure();
  try {
    const skill = await srv.skills.create({
      scopeId: scopeId("personal", "U2"),
      manifest: { name: "private", description: "theirs", requiredCapabilities: [], body: "# private" },
      createdBy: "U2",
    });
    await srv.skills.review(skill.id, "reviewer-1", []);
    await srv.skills.publish(skill.id);
    await srv.skills.archive(skill.id);

    const headers = { "x-agent-capability": await srv.cap("U1") };
    assert.equal((await fetch(`${srv.base}/v1/skills/${skill.id}`, { headers })).status, 404);
    assert.equal((await fetch(`${srv.base}/v1/skills/${skill.id}/restore`, { method: "POST", headers })).status, 404);
    assert.equal((await fetch(`${srv.base}/v1/skills/${skill.id}?principalId=U2`)).status, 401);
    assert.equal(
      (
        await fetch(`${srv.base}/v1/skills/${skill.id}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ principalId: "U2" }),
        })
      ).status,
      401,
    );
    assert.equal((await srv.skills.get(skill.id))?.status, "archived");
  } finally {
    await srv.close();
  }
});

test("only a live person can restore an archived channel skill, not a Slack bot's turn or a trigger", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "eng", isPrivate: true }],
      ["U1", "U2", "release-bot"].map((principalId) => ({ channelId: "C9", principalId })),
    );
    const skill = await srv.skills.create({
      scopeId: scopeId("channel", "C9"),
      manifest: { name: "retired", description: "theirs", requiredCapabilities: [], body: "# retired" },
      createdBy: "U1",
    });
    await srv.skills.review(skill.id, "reviewer-1", []);
    await srv.skills.publish(skill.id);
    await srv.skills.archive(skill.id);
    const restore = async (token: string) =>
      (
        await fetch(`${srv.base}/v1/skills/${skill.id}/restore`, {
          method: "POST",
          headers: { "x-agent-capability": token },
        })
      ).status;
    assert.equal(await restore(await srv.cap("release-bot", scopeId("channel", "C9"), true, true)), 403);
    assert.equal(await restore(await srv.cap("U2", scopeId("channel", "C9"), false)), 403);
    assert.equal((await srv.skills.get(skill.id))?.status, "archived");
    assert.equal(await restore(await srv.cap("U2", scopeId("channel", "C9"))), 200);
  } finally {
    await srv.close();
  }
});

test("the skills tool saves a skill into the turn's scope and edits it through the skill API", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [
        { channelId: "C9", principalId: "avery" },
        { channelId: "C9", principalId: "jordan" },
      ],
    );
    const skills = skillsTool(createSelfApiCall(srv.base, await srv.cap("avery", scopeId("channel", "C9"))));
    const saved = await skills({
      action: "save",
      name: "investor-update",
      description: "draft the weekly investor update",
      body: "# investor-update",
    });
    const sk = (await srv.skills.list()).find((s) => s.manifest.name === "investor-update");
    assert.ok(sk, saved);
    assert.equal(sk.scopeId, scopeId("channel", "C9"));
    assert.equal(sk.createdBy, "avery");
    assert.equal(sk.status, "published");
    assert.match(saved, new RegExp(`Saved skill investor-update \\(id ${sk.id}`));

    const jordan = skillsTool(createSelfApiCall(srv.base, await srv.cap("jordan", scopeId("channel", "C9"))));
    const edited = await jordan({ action: "edit", id: sk.id, body: "# investor-update v2" });
    assert.match(edited, /^Updated skill investor-update/);
    assert.equal((await srv.skills.get(sk.id))!.manifest.body, "# investor-update v2");
    const version = (await srv.skills.get(sk.id))!.version;
    assert.match(await jordan({ action: "edit", id: sk.id }), /^\[error\] description or body required \(HTTP 400/);
    assert.match(
      await jordan({ action: "edit", id: sk.id, description: " ", body: "# investor-update v3" }),
      /^\[error\] description and body can't be blank \(HTTP 400/,
    );
    assert.equal(await jordan({ action: "edit", id: ".." }), "[error] Invalid API path: /v1/skills/..");
    assert.equal((await srv.skills.get(sk.id))!.version, version);

    assert.match(
      await skills({ action: "save", name: " padded-name\n", description: "d", body: "# b" }),
      /^Saved skill padded-name \(/,
    );
    const again = await skills({ action: "save", name: "investor-update", description: "d", body: "# b" });
    assert.match(again, /already exists here/);
  } finally {
    await srv.close();
  }
});

test("the skills tool cannot save or edit where the skill API refuses", async () => {
  const srv = await startSecure();
  try {
    await srv.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [{ channelId: "C9", principalId: "avery" }],
    );
    const trigger = skillsTool(createSelfApiCall(srv.base, await srv.cap("avery", scopeId("channel", "C9"), false)));
    assert.ok(
      (await trigger({ action: "save", name: "auto-thing", description: "d", body: "# b" })).startsWith(
        `[error] ${SHARED_SKILL_TRIGGER_REFUSAL} (HTTP 403`,
      ),
    );

    await srv.config.setSecurityPosture(scopeId("personal", "strict-user"), "strict");
    const strict = skillsTool(createSelfApiCall(srv.base, await srv.cap("strict-user")));
    assert.match(
      await strict({ action: "save", name: "strict-thing", description: "d", body: "# b" }),
      /^\[error\] Strict posture blocks direct control-plane mutations \(HTTP 403/,
    );

    const id = await seedChannelSkill(srv);
    const outsider = skillsTool(createSelfApiCall(srv.base, await srv.cap("mallory")));
    assert.match(await outsider({ action: "edit", id, description: "taken over" }), /isn't yours to edit/);

    assert.ok(
      (
        await skillsTool(createSelfApiCall(srv.base, await srv.cap("namer")))({
          action: "save",
          name: "Weekly Investor Update",
          description: "d",
          body: "# b",
        })
      ).startsWith(`[error] ${SKILL_NAME_RULE} (HTTP 400`),
    );
    assert.deepEqual(skillsActions(), ["list", "search", "read", "share"]);
    assert.equal(
      await skillsTool(async () => {
        throw new Error("connect ECONNREFUSED");
      })({ action: "save", name: "unreachable", description: "d", body: "# b" }),
      "[error] connect ECONNREFUSED",
    );
    assert.equal(
      await skillsTool(async () => ({ status: 502, body: "<html>bad gateway</html>", requestId: "r1" }))({
        action: "edit",
        id,
        body: "# b",
      }),
      "[error] <html>bad gateway</html> (HTTP 502, request r1)",
    );
    const names = (await srv.skills.list()).map((s) => s.manifest.name);
    for (const name of ["auto-thing", "strict-thing", "Weekly Investor Update"]) assert.ok(!names.includes(name), name);
    assert.notEqual((await srv.skills.get(id))!.manifest.description, "taken over");
  } finally {
    await srv.close();
  }
});

test("a turn's skills tool saves with that turn's own capability, and read-only and strict-posture turns get no save", async () => {
  const SECRET = "skills-turn-cap-secret".repeat(3);
  const mock = createMockAgent();
  const seen: ToolContext[] = [];
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "skills-turn-")),
      orgId: "acme",
      seedSkills: false,
      signingSecret: SECRET,
      capabilitySecret: SECRET,
      apiBaseUrl: "http://core.example.test",
    }),
    {
      agent: {
        ...mock,
        runTurn: (input) => {
          seen.push(input.tools);
          return mock.runTurn(input);
        },
      },
    },
  );
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    capabilitySecret: SECRET,
    config: built.config,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(String(input).replace("http://core.example.test", base), init);
  try {
    await built.directory.replaceChannels(
      [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
      [{ channelId: "C9", principalId: "avery" }],
    );
    const avery = { externalId: "avery" };
    const turn = (readOnly: boolean, label = readOnly ? "read" : "live") =>
      built.app.turn({
        surface: "test",
        actor: avery,
        conversation: {
          kind: "channel",
          threadRef: `ch:C9:${label}`,
          channelRef: "C9",
          audience: [avery],
          publishMembers: [avery],
        },
        text: "hello",
        origin: { kind: "human" },
        ...(readOnly ? { readOnly: true } : {}),
      });
    assert.equal((await turn(false)).status, "ok");
    assert.equal((await turn(true)).status, "ok");
    const [live, readOnly] = seen;
    assert.equal(readOnly!.selfApi, undefined);
    assert.match(
      await skillsTool(live!.selfApi)({ action: "save", name: "from-a-turn", description: "d", body: "# b" }),
      /^Saved skill from-a-turn/,
    );
    const sk = (await built.skills.list()).find((s) => s.manifest.name === "from-a-turn");
    assert.equal(sk?.scopeId, scopeId("channel", "C9"));
    assert.equal(sk?.createdBy, "avery");
    await built.config.setSecurityPosture(scopeId("channel", "C9"), "strict");
    assert.equal((await turn(false, "strict")).status, "ok");
    assert.equal(seen[2]!.selfApi, undefined);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise<void>((r) => server.close(() => r()));
  }
});
