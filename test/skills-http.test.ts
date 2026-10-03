import "./support/auto-fake-sprites.ts";

import { test, type TestContext } from "node:test";
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

const SECRET = "skills-http-cap-secret".repeat(3);

function start(t: TestContext, secure = false) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "skills-http-")),
      orgId: "acme",
      seedSkills: false,
      ...(secure ? { signingSecret: SECRET } : {}),
    }),
  );
  const server = secure ? createServer(built.app, { signingSecret: SECRET }) : createInsecureTestServer(built.app);
  server.listen(0);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
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
  const req = (method: string, path: string, opts: { body?: unknown; token?: string } = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
        ...(opts.token ? { "x-agent-capability": opts.token } : {}),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
  const list = async (principalId: string, query = "") =>
    ((await (await req("GET", `/v1/skills?principalId=${principalId}${query}`)).json()) as { skills: SkillView[] })
      .skills;
  const detail = async (id: string, principalId: string) =>
    ((await (await req("GET", `/v1/skills/${id}?principalId=${principalId}`)).json()) as { skill: SkillView }).skill;
  return {
    base,
    cap,
    req,
    list,
    detail,
    skills: built.skills,
    directory: built.directory,
    sessions: built.sessions,
  };
}

type Srv = ReturnType<typeof start>;

async function publish(
  skills: Srv["skills"],
  scope: ScopeId,
  name: string,
  description: string,
  opts: {
    createdBy?: string;
    body?: string;
    files?: Array<{ path: string; content: string; executable?: boolean }>;
  } = {},
) {
  const sk = await skills.create({
    scopeId: scope,
    manifest: {
      name,
      description,
      requiredCapabilities: [],
      body: opts.body ?? `# ${name}`,
      ...(opts.files ? { files: opts.files } : {}),
    },
    createdBy: opts.createdBy ?? "author",
  });
  await skills.review(sk.id, "reviewer-1", []);
  await skills.publish(sk.id);
  return sk;
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

async function joinPrivateChannel(srv: Srv, members = ["avery", "jordan"]) {
  await srv.directory.replaceChannels(
    [{ channelId: "C9", name: "avery-jordan", isPrivate: true }],
    members.map((principalId) => ({ channelId: "C9", principalId })),
  );
}

test("GET /v1/skills returns metadata only; authorized detail fetch returns the body", async (t) => {
  const srv = start(t);
  await publish(srv.skills, scopeId("org", "default-org"), "deploy-bot", "ship the bot to prod");
  await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");

  const res = await srv.req("GET", `/v1/skills?principalId=${encodeURIComponent("U1")}`);
  assert.equal(res.status, 200);
  const byName = new Map(((await res.json()) as { skills: SkillView[] }).skills.map((s) => [s.name, s]));

  const mine = byName.get("make-digest")!;
  assert.equal(mine.scope, "personal");
  assert.equal(mine.body, undefined, "list rows do not eagerly expose instruction bodies");
  assert.equal((await srv.detail(mine.id, "U1")).body, "# make-digest");
  assert.equal(mine.editable, true);
  assert.ok(mine.id);
  assert.equal(byName.get("deploy-bot")?.scope, "org");
  assert.equal(byName.get("deploy-bot")?.editable, false);
});

test("GET /v1/skills marks a private-channel skill editable for a member and not for a non-member", async (t) => {
  const srv = start(t);
  await joinPrivateChannel(srv);
  await publish(srv.skills, scopeId("channel", "C9"), "team-thing", "shared in the channel");

  const k = (await srv.list("jordan")).find((s) => s.name === "team-thing");
  assert.ok(k, "the channel skill is visible to a member");
  assert.equal(k!.scope, "channel");
  assert.equal(k!.editable, true, "a member may edit it");
  assert.equal(
    (await srv.list("mallory")).find((s) => s.name === "team-thing"),
    undefined,
    "a non-member doesn't even see it",
  );
});

test("PUT /v1/skills/:id edits an owned personal skill in place and keeps it live", async (t) => {
  const srv = start(t);
  await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
  const id = (await srv.list("U1")).find((s) => s.name === "make-digest")!.id;

  const res = await srv.req("PUT", `/v1/skills/${id}`, {
    body: { principalId: "U1", description: "a better digest", body: "# make-digest v2" },
  });
  assert.equal(res.status, 200);

  const mine = await srv.detail(id, "U1");
  assert.equal(mine.description, "a better digest");
  assert.equal(mine.body, "# make-digest v2");
});

test("PUT/DELETE /v1/skills/:id refuse a skill the caller doesn't own (404/403)", async (t) => {
  const srv = start(t);
  const sk = await publish(srv.skills, scopeId("personal", "U2"), "secret", "theirs", { createdBy: "U2" });

  const edit = await srv.req("PUT", `/v1/skills/${sk.id}`, { body: { principalId: "U1", description: "hijacked" } });
  assert.equal(edit.status, 404);
  const del = await srv.req("DELETE", `/v1/skills/${sk.id}`, { body: { principalId: "U1" } });
  assert.equal(del.status, 403);
  assert.ok(await srv.skills.get(sk.id), "the other owner's skill is untouched");
});

test("DELETE /v1/skills/:id archives an owned personal skill and its manager can restore it", async (t) => {
  const srv = start(t);
  await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "assemble a morning digest");
  const id = (await srv.list("U1")).find((s) => s.name === "make-digest")!.id;

  const res = await srv.req("DELETE", `/v1/skills/${id}`, { body: { principalId: "U1" } });
  assert.equal(res.status, 200);
  assert.equal((await srv.skills.get(id))?.status, "archived", "record remains as a reversible tombstone");
  assert.equal(
    (await srv.list("U1")).find((s) => s.name === "make-digest")?.status,
    "archived",
    "manager can discover and restore it",
  );

  const restored = await srv.req("POST", `/v1/skills/${id}/restore`, { body: { principalId: "U1" } });
  assert.equal(restored.status, 200);
  assert.equal((await srv.skills.get(id))?.status, "published");
});

test("an archived skill name can be reused for a replacement", async (t) => {
  const srv = start(t);
  await publish(srv.skills, scopeId("personal", "U1"), "replace-me", "old version");
  const oldId = (await srv.list("U1")).find((skill) => skill.name === "replace-me")!.id;
  await srv.req("DELETE", `/v1/skills/${oldId}`, { body: { principalId: "U1" } });

  const replacement = await srv.req("POST", "/v1/skills", {
    body: { principalId: "U1", name: "replace-me", description: "new version", body: "# replacement" },
  });
  assert.equal(replacement.status, 201);
  const created = (await replacement.json()) as { skill: SkillView };
  assert.notEqual(created.skill.id, oldId);
  assert.equal(await srv.skills.get(oldId), null, "the reused name retires its archived tombstone");
});

test("the skills routes reject a missing principal, an unknown id, and blank required fields", async (t) => {
  const srv = start(t);
  assert.equal((await srv.req("GET", "/v1/skills")).status, 400);
  assert.equal((await srv.req("DELETE", "/v1/skills/no-such-id", { body: { principalId: "U1" } })).status, 404);
  for (const bad of [
    { principalId: "U1", name: "x", description: "d" },
    { principalId: "U1", name: "  ", description: "d", body: "b" },
    { name: "x", description: "d", body: "b" },
  ]) {
    const res = await srv.req("POST", "/v1/skills", { body: bad });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
  }
});

test("GET /v1/skills flags a personal skill that shadows an org one, and can include every scope variant", async (t) => {
  const srv = start(t);
  await publish(srv.skills, scopeId("org", "default-org"), "notes", "org notes");
  await publish(srv.skills, scopeId("personal", "U1"), "notes", "U1 notes");

  const notes = (await srv.list("U1")).filter((s) => s.name === "notes");
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.scope, "personal");
  assert.equal(notes[0]!.shadowed, true);

  const expanded = (await srv.list("U1", "&includeShadowed=1")).filter((skill) => skill.name === "notes");
  assert.deepEqual(
    expanded.map((skill) => skill.scope),
    ["personal", "org"],
  );
  assert.equal(expanded[0]!.shadowed, true);
  assert.equal(expanded[1]!.shadowed, false);
});

test("POST /v1/skills creates a personal skill that is then visible and editable", async (t) => {
  const srv = start(t);
  const res = await srv.req("POST", "/v1/skills", {
    body: {
      principalId: "U1",
      name: "watch-ci",
      description: "watch the CI pipeline",
      body: "# watch-ci\nPoll the pipeline and report.",
    },
  });
  assert.equal(res.status, 201);
  const created = (await res.json()) as { skill: SkillView };
  assert.equal(created.skill.name, "watch-ci");
  assert.equal(created.skill.status, "published");
  assert.ok(created.skill.id);

  const mine = (await srv.list("U1")).find((s) => s.name === "watch-ci")!;
  assert.equal(mine.scope, "personal");
  assert.equal(mine.editable, true);
  assert.equal(mine.body, undefined);
  assert.equal((await srv.detail(mine.id, "U1")).body, "# watch-ci\nPoll the pipeline and report.");
});

test("POST /v1/skills rejects a duplicate name in the caller's personal scope but not across principals", async (t) => {
  const srv = start(t);
  await publish(srv.skills, scopeId("personal", "U1"), "watch-ci", "first one");
  const res = await srv.req("POST", "/v1/skills", {
    body: { principalId: "U1", name: "watch-ci", description: "dup", body: "# dup" },
  });
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { error: string }).error, "exists");

  const mk = (pid: string) =>
    srv.req("POST", "/v1/skills", {
      body: { principalId: pid, name: "shared-name", description: `${pid} skill`, body: `# ${pid}` },
    });
  assert.equal((await mk("U1")).status, 201);
  assert.equal((await mk("U2")).status, 201);
});

test("GET /v1/skills shows a group-DM skill to a member known only via directory membership", async (t) => {
  const srv = start(t);
  await srv.directory.replaceGroups([
    { groupId: "G7", principalId: "ann" },
    { groupId: "G7", principalId: "bob" },
  ]);
  await publish(srv.skills, scopeId("group", "G7"), "grouped", "shared in the group DM");
  const g = (await srv.list("bob")).find((s) => s.name === "grouped");
  assert.ok(g, "the group skill shows up for a directory-only group member");
  assert.equal(g!.editable, true, "and a group member may edit it");
  assert.equal(
    (await srv.list("carol")).find((s) => s.name === "grouped"),
    undefined,
  );
});

test("POST /v1/skills via a capability token authors as the token's own principal (body principalId ignored)", async (t) => {
  const srv = start(t, true);
  const res = await srv.req("POST", "/v1/skills", {
    token: await srv.cap("U1"),
    body: { principalId: "U2", name: "watch-ci", description: "watch the pipeline", body: "# watch-ci" },
  });
  assert.equal(res.status, 201);

  const watch = (await srv.skills.list()).find((sk) => sk.manifest.name === "watch-ci");
  assert.ok(watch, "the skill was created");
  assert.equal(
    watch!.scopeId,
    scopeId("personal", "U1"),
    "authored as the token's actor, not the spoofed body principalId",
  );
});

async function seedChannelSkill(srv: Srv) {
  await joinPrivateChannel(srv);
  const res = await srv.req("POST", "/v1/skills", {
    token: await srv.cap("avery", scopeId("channel", "C9")),
    body: { name: "team-thing", description: "v1", body: "# v1" },
  });
  assert.equal(res.status, 201);
  const id = ((await res.json()) as { skill: { id: string } }).skill.id;
  const sk = await srv.skills.get(id);
  assert.ok(sk, "the skill was created");
  assert.equal(sk!.scopeId, scopeId("channel", "C9"), "homed in the channel, not avery's personal scope");
  assert.equal(sk!.createdBy, "avery", "provenance is the real author, never the scope");
  assert.equal(sk!.status, "published", "a membership-managed shared skill auto review+publishes");
  return id;
}

test("POST /v1/skills with a signing secret set rejects an unauthenticated (unsigned, no-token) request", async (t) => {
  const srv = start(t, true);
  const res = await srv.req("POST", "/v1/skills", {
    body: { principalId: "U1", name: "x", description: "d", body: "# b" },
  });
  assert.equal(res.status, 401);
});

test("PUT /v1/skills/:id via a capability token edits only the token-actor's own skill (body principalId ignored)", async (t) => {
  const srv = start(t, true);
  const mine = await publish(srv.skills, scopeId("personal", "U1"), "make-digest", "v1", {
    createdBy: "U1",
    body: "# v1",
  });
  const res = await srv.req("PUT", `/v1/skills/${mine.id}`, {
    token: await srv.cap("U1"),
    body: { principalId: "U2", description: "v2", body: "# v2" },
  });
  assert.equal(res.status, 200);
  assert.equal((await srv.skills.get(mine.id))!.manifest.body, "# v2");

  const theirs = await publish(srv.skills, scopeId("personal", "U2"), "secret", "theirs", { createdBy: "U2" });
  const cross = await srv.req("PUT", `/v1/skills/${theirs.id}`, {
    token: await srv.cap("U1"),
    body: { description: "hijacked" },
  });
  assert.equal(cross.status, 404);
  assert.equal((await srv.skills.get(theirs.id))!.manifest.description, "theirs");
});

test("PUT /v1/skills/:id lets a DIFFERENT member of the home channel edit it, preserving provenance and staying live", async (t) => {
  const srv = start(t, true);
  const id = await seedChannelSkill(srv);
  const res = await srv.req("PUT", `/v1/skills/${id}`, {
    token: await srv.cap("jordan", scopeId("channel", "C9")),
    body: { body: "# v2 by jordan" },
  });
  assert.equal(res.status, 200);
  const after = await srv.skills.get(id);
  assert.equal(after!.manifest.body, "# v2 by jordan");
  assert.equal(after!.createdBy, "avery", "edit by a member never rewrites provenance");
  assert.equal(after!.status, "published", "a membership-managed edit re-publishes — no org review needed");
});

test("PUT/DELETE /v1/skills/:id refuse a NON-member of the home channel (404/403)", async (t) => {
  const srv = start(t, true);
  const id = await seedChannelSkill(srv);
  const token = await srv.cap("mallory");
  assert.equal((await srv.req("PUT", `/v1/skills/${id}`, { token, body: { description: "hijacked" } })).status, 404);
  assert.equal((await srv.req("DELETE", `/v1/skills/${id}`, { token })).status, 403);
  assert.ok(await srv.skills.get(id), "the channel's skill is untouched by a non-member");
  assert.equal((await srv.skills.get(id))!.manifest.description, "v1");
});

test("an author who LEAVES a private channel loses inline CRUD on its skill (membership, not authorship, decides)", async (t) => {
  const srv = start(t, true);
  const id = await seedChannelSkill(srv);
  await joinPrivateChannel(srv, ["jordan"]);
  const avery = await srv.cap("avery");
  const edit = await srv.req("PUT", `/v1/skills/${id}`, { token: avery, body: { description: "ex-member edit" } });
  assert.equal(edit.status, 404, "an ex-member author cannot edit a private-channel skill");
  assert.equal(
    (await srv.req("DELETE", `/v1/skills/${id}`, { token: avery })).status,
    403,
    "an ex-member author cannot delete it either",
  );
  const k = await srv.req("PUT", `/v1/skills/${id}`, {
    token: await srv.cap("jordan"),
    body: { description: "still managed by the remaining member" },
  });
  assert.equal(k.status, 200);
});

test("management tracks CURRENT directory membership, not a stale session — a session-only non-member cannot edit", async (t) => {
  const srv = start(t, true);
  const id = await seedChannelSkill(srv);
  const sess = await srv.sessions.getOrCreateByThread("C9:t1", "channel", scopeId("channel", "C9"), "avery-jordan");
  await srv.sessions.addParticipant(sess.id, "dana");
  const edit = await srv.req("PUT", `/v1/skills/${id}`, {
    token: await srv.cap("dana"),
    body: { description: "stale-session edit" },
  });
  assert.equal(edit.status, 404, "a session-only non-member cannot manage — management reads current membership");
  assert.equal((await srv.skills.get(id))!.manifest.description, "v1", "untouched");
});

test("a shared-scope skill cannot be created/edited/deleted by an automated trigger (no liveActor)", async (t) => {
  const srv = start(t, true);
  await joinPrivateChannel(srv, ["avery"]);
  const triggerTok = await srv.cap("avery", scopeId("channel", "C9"), false);
  const create = await srv.req("POST", "/v1/skills", {
    token: triggerTok,
    body: { name: "auto-thing", description: "d", body: "# b" },
  });
  assert.equal(create.status, 403, "an automated trigger cannot create a shared skill");
  assert.equal(
    (await srv.skills.list()).find((s) => s.manifest.name === "auto-thing"),
    undefined,
  );

  const id = await seedChannelSkill(srv);
  assert.equal(
    (await srv.req("PUT", `/v1/skills/${id}`, { token: triggerTok, body: { description: "auto edit" } })).status,
    403,
  );
  assert.equal((await srv.req("DELETE", `/v1/skills/${id}`, { token: triggerTok })).status, 403);
  assert.ok(await srv.skills.get(id), "the shared skill survives an automated trigger");

  const own = await srv.req("POST", "/v1/skills", {
    token: await srv.cap("solo", scopeId("personal", "solo"), false),
    body: { name: "solo-skill", description: "d", body: "# b" },
  });
  assert.equal(own.status, 201, "a trigger in its owner's own DM may still save a personal skill");
});

test("a PERSONAL-scope trigger (no liveActor) cannot edit or delete a skill homed in a private channel it is a member of", async (t) => {
  const srv = start(t, true);
  const id = await seedChannelSkill(srv);
  const token = await srv.cap("avery", scopeId("personal", "avery"), false);
  const edit = await srv.req("PUT", `/v1/skills/${id}`, {
    token,
    body: { body: "# rewritten by a personal-scope trigger" },
  });
  assert.equal(edit.status, 403, "a personal-scope trigger cannot rewrite a shared skill");
  assert.equal(
    (await srv.req("DELETE", `/v1/skills/${id}`, { token })).status,
    403,
    "a personal-scope trigger cannot delete a shared skill",
  );
  const survivor = await srv.skills.get(id);
  assert.ok(survivor, "the shared skill survives the personal-scope trigger");
  assert.equal(survivor!.manifest.body, "# v1", "and its body is untouched");
});

test("a LIVE member of a private channel may edit + delete its skill from their own DM (personal token, liveActor)", async (t) => {
  const srv = start(t, true);
  const id = await seedChannelSkill(srv);
  const liveJordan = await srv.cap("jordan");
  const edit = await srv.req("PUT", `/v1/skills/${id}`, {
    token: liveJordan,
    body: { description: "edited live by a member" },
  });
  assert.equal(edit.status, 200, "a live member may edit the shared skill");
  assert.equal((await srv.skills.get(id))!.manifest.description, "edited live by a member");
  assert.equal((await srv.req("DELETE", `/v1/skills/${id}`, { token: liveJordan })).status, 200, "and delete it");
  assert.equal((await srv.skills.get(id))?.status, "archived");
});

test("a PERSONAL-scope trigger (no liveActor) may still edit + delete its OWNER'S OWN personal skill", async (t) => {
  const srv = start(t, true);
  const sk = await publish(srv.skills, scopeId("personal", "solo"), "solo-skill", "v1", {
    createdBy: "solo",
    body: "# v1",
  });
  const token = await srv.cap("solo", scopeId("personal", "solo"), false);
  const edit = await srv.req("PUT", `/v1/skills/${sk.id}`, { token, body: { body: "# v2 by the owner's trigger" } });
  assert.equal(edit.status, 200, "an owner's trigger may edit its own personal skill");
  assert.equal((await srv.skills.get(sk.id))!.manifest.body, "# v2 by the owner's trigger");
  assert.equal((await srv.req("DELETE", `/v1/skills/${sk.id}`, { token })).status, 200, "and delete it");
  assert.equal((await srv.skills.get(sk.id))?.status, "archived");
});

test("a group-DM skill is editable by any group member (the group-DM analog of a private channel)", async (t) => {
  const srv = start(t, true);
  await srv.directory.replaceGroups([
    { groupId: "G7", principalId: "ann" },
    { groupId: "G7", principalId: "bob" },
  ]);
  const created = await srv.req("POST", "/v1/skills", {
    token: await srv.cap("ann", scopeId("group", "G7")),
    body: { name: "grouped", description: "v1", body: "# v1" },
  });
  assert.equal(created.status, 201);
  const id = ((await created.json()) as { skill: { id: string } }).skill.id;
  assert.equal((await srv.skills.get(id))!.scopeId, scopeId("group", "G7"));

  const edit = await srv.req("PUT", `/v1/skills/${id}`, { token: await srv.cap("bob"), body: { body: "# v2 by bob" } });
  assert.equal(edit.status, 200);
  assert.equal((await srv.skills.get(id))!.manifest.body, "# v2 by bob");
});

test("POST /v1/skills refuses to home a skill directly in an org or team scope (promotion path only)", async (t) => {
  const srv = start(t, true);
  for (const home of [scopeId("org", "default-org"), scopeId("team", "T1")]) {
    const res = await srv.req("POST", "/v1/skills", {
      token: await srv.cap("author", home),
      body: { name: `wide-${home}`, description: "d", body: "# b" },
    });
    assert.equal(res.status, 403, `${home}: must refuse inline create into a promotion-gated scope`);
    assert.equal(
      (await srv.skills.list()).find((s) => s.manifest.name === `wide-${home}`),
      undefined,
      `${home}: nothing created`,
    );
  }
});

test("an ORG- or TEAM-homed skill is never inline-managed, even by its author (promotion/admin only)", async (t) => {
  const srv = start(t, true);
  for (const home of [scopeId("org", "default-org"), scopeId("team", "T1")]) {
    const sk = await publish(srv.skills, home, `wide-${home.replace(":", "-")}`, "v1", { body: "# v1" });
    const token = await srv.cap("author");
    const edit = await srv.req("PUT", `/v1/skills/${sk.id}`, { token, body: { description: "inline edit" } });
    assert.equal(edit.status, 404, `${home}: author cannot inline-edit a wide-scope skill`);
    const after = await srv.skills.get(sk.id);
    assert.equal(after!.manifest.description, "v1", `${home}: untouched`);
    assert.equal(after!.status, "published", `${home}: still published, not silently demoted`);

    const del = await srv.req("DELETE", `/v1/skills/${sk.id}`, { token });
    assert.equal(del.status, 403, `${home}: author cannot inline-delete a wide-scope skill`);
    assert.ok(await srv.skills.get(sk.id), `${home}: the org/team copy survives`);
  }
});

test("a PUBLIC channel (self-joinable) stays owner-only — a non-author member cannot edit it", async (t) => {
  const srv = start(t, true);
  await srv.directory.replaceChannels(
    [{ channelId: "CPUB", name: "general", isPrivate: false }],
    ["owner", "rando"].map((principalId) => ({ channelId: "CPUB", principalId })),
  );
  const owner = await srv.cap("owner", scopeId("channel", "CPUB"));
  const created = await srv.req("POST", "/v1/skills", {
    token: owner,
    body: { name: "pub-skill", description: "v1", body: "# v1" },
  });
  assert.equal(created.status, 201);
  const id = ((await created.json()) as { skill: { id: string } }).skill.id;

  const edit = await srv.req("PUT", `/v1/skills/${id}`, {
    token: await srv.cap("rando", scopeId("channel", "CPUB")),
    body: { description: "hijacked" },
  });
  assert.equal(edit.status, 404);
  assert.equal(
    (await srv.req("PUT", `/v1/skills/${id}`, { token: owner, body: { description: "owner edit" } })).status,
    200,
  );
  assert.equal((await srv.skills.get(id))!.manifest.description, "owner edit");
});

test("DELETE /v1/skills/:id via a capability token archives the token-actor's own skill; cannot cross scopes", async (t) => {
  const srv = start(t, true);
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
  const token = await srv.cap("U1");

  assert.equal((await srv.req("DELETE", `/v1/skills/${theirs.id}`, { token })).status, 403);
  assert.ok(await srv.skills.get(theirs.id), "another principal's skill survives");
  assert.equal((await srv.req("DELETE", `/v1/skills/${mine.id}`, { token })).status, 200);
  assert.equal((await srv.skills.get(mine.id))?.status, "archived");
});

test("a capability token reads and restores its archived skill without losing identity, files, or version", async (t) => {
  const srv = start(t, true);
  const created = await publish(srv.skills, scopeId("personal", "U1"), "recover-me", "recoverable", {
    createdBy: "U1",
    files: [{ path: "scripts/run.sh", content: "exit 0", executable: true }],
  });
  const before = (await srv.skills.get(created.id))!;
  const token = await srv.cap("U1");

  assert.equal((await srv.req("DELETE", `/v1/skills/${created.id}`, { token })).status, 200);

  const detail = await srv.req("GET", `/v1/skills/${created.id}`, { token });
  assert.equal(detail.status, 200);
  const detailBody = (await detail.json()) as {
    skill: { id: string; body: string; status: string; version: number; files: Array<{ path: string }> };
  };
  assert.equal(detailBody.skill.id, before.id);
  assert.equal(detailBody.skill.body, before.manifest.body);
  assert.equal(detailBody.skill.status, "archived");
  assert.equal(detailBody.skill.version, before.version);
  assert.deepEqual(detailBody.skill.files, [{ path: "scripts/run.sh", executable: true }]);

  assert.equal((await srv.req("POST", `/v1/skills/${created.id}/restore`, { token })).status, 200);
  const after = (await srv.skills.get(created.id))!;
  assert.equal(after.id, before.id);
  assert.equal(after.version, before.version);
  assert.deepEqual(after.manifest.files, before.manifest.files);
  assert.equal(after.status, "published");
});

test("skill detail and restore capability calls hide other principals' skills and require identity", async (t) => {
  const srv = start(t, true);
  const skill = await publish(srv.skills, scopeId("personal", "U2"), "private", "theirs", { createdBy: "U2" });
  await srv.skills.archive(skill.id);

  const token = await srv.cap("U1");
  assert.equal((await srv.req("GET", `/v1/skills/${skill.id}`, { token })).status, 404);
  assert.equal((await srv.req("POST", `/v1/skills/${skill.id}/restore`, { token })).status, 404);
  assert.equal((await srv.req("GET", `/v1/skills/${skill.id}?principalId=U2`)).status, 401);
  assert.equal((await srv.req("POST", `/v1/skills/${skill.id}/restore`, { body: { principalId: "U2" } })).status, 401);
  assert.equal((await srv.skills.get(skill.id))?.status, "archived");
});
