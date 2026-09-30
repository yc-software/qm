import { test } from "node:test";
import assert from "node:assert/strict";
import { createControlService } from "../src/api/control-service.ts";
import { AdminError } from "../src/admin/admin-service.ts";
import type { App } from "../src/api/app.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import type { Grant, ScopeId } from "../src/types.ts";
import { parseScopeId, scopeId } from "../src/types.ts";
import type { ArtifactHome, ArtifactType } from "../src/api/artifact-share.ts";
import type { RecipientResolution } from "../src/directory/directory-store.ts";
import { shareArtifact as shareRoute } from "../src/api/routes/surface.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { splitToScope } from "../src/api/artifact-share.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { ManagesArtifactHome } from "../src/resolution/scope-membership.ts";

const ORG = "default-org";

interface FakeState {
  artifacts: Record<string, ArtifactHome & { type: ArtifactType }>;
  scopesByPrincipal: Record<string, ScopeId[]>;
  moves: Array<{ type: ArtifactType; id: string; toScope: ScopeId; movedBy: string }>;
  promotes: Array<{ id: string; targetScopeId: ScopeId; actorId: string }>;
  admins: Set<string>;
  recipients: Record<string, RecipientResolution>;
  privateChannels: Set<string>;
  acl: ReturnType<typeof createAclStore>;
}

function fakeManages(state: FakeState): ManagesArtifactHome {
  return async (homeScopeId, createdBy, principalId) => {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(homeScopeId);
    const memberManaged = kind === "group" || (kind === "channel" && state.privateChannels.has(ref));
    if (memberManaged && (state.scopesByPrincipal[principalId] ?? []).includes(homeScopeId)) return true;
    if (createdBy !== principalId) return false;
    if (kind === "personal") return ref === principalId;
    if (kind === "channel") return !state.privateChannels.has(ref);
    return false;
  };
}

function authorOfGrant(state: FakeState, ownerScopeId: ScopeId, ref: string): string | undefined {
  const { kind } = parseScopeId(ownerScopeId);
  if (kind !== "channel" && kind !== "group") return undefined;
  return Object.values(state.artifacts).find((a) => a.ownerScopeId === ownerScopeId && a.grantRef === ref)?.createdBy;
}

function fakeApp(state: FakeState): App {
  return {
    async getArtifactHome(type: ArtifactType, idOrName: string) {
      return state.artifacts[`${type}:${idOrName}`] ?? null;
    },
    async belongsToScope(principalId: string, scope: ScopeId) {
      if (parseScopeId(scope).kind === "org") return true;
      if (scope === scopeId("personal", principalId)) return true;
      const mine = state.scopesByPrincipal[principalId] ?? [scopeId("personal", principalId), scopeId("org", ORG)];
      return mine.includes(scope);
    },
    canManageArtifactHome(homeScopeId: ScopeId, createdBy: string, principalId: string) {
      return fakeManages(state)(homeScopeId, createdBy, principalId);
    },
    async grant(g: Grant) {
      await state.acl.grant(g, authorOfGrant(state, g.ownerScopeId, g.ref));
    },
    async revokeGrant(ownerScopeId: ScopeId, ref: string, granteeScopeId: ScopeId, revokedBy: string) {
      await state.acl.revoke(ownerScopeId, ref, granteeScopeId, revokedBy, authorOfGrant(state, ownerScopeId, ref));
    },
    async moveArtifactHome(type: ArtifactType, id: string, toScope: ScopeId, movedBy: string) {
      if (type !== "skill" && type !== "deploy")
        throw new Error(`moving a ${type}'s home isn't supported — share it instead (add a grant)`);
      state.moves.push({ type, id, toScope, movedBy });
    },
    async promoteSkill(id: string, targetScopeId: ScopeId, actorId: string, liveActor: boolean) {
      if (liveActor !== true)
        throw new AdminError(403, "promoting a skill org-wide takes a live person, never an autonomous trigger");
      if (!state.admins.has(actorId)) throw new AdminError(403, "only an org admin can promote a skill org-wide");
      state.promotes.push({ id, targetScopeId, actorId });
      return { id: `org-${id}` } as never;
    },
    async resolveRecipient(query: string) {
      return state.recipients[query.toLowerCase()] ?? { kind: "none" };
    },
  } as unknown as App;
}

const cap = (actorId: string, scope?: ScopeId, liveActor = true): CapabilityClaims =>
  ({
    actorId,
    scopeId: scope ?? scopeId("personal", actorId),
    exp: 9_999_999_999,
    ...(liveActor ? { liveActor: true } : {}),
  }) as CapabilityClaims;

function baseState(over: Partial<FakeState> = {}): FakeState {
  const state: FakeState = {
    artifacts: {},
    scopesByPrincipal: {},
    moves: [],
    promotes: [],
    admins: new Set(),
    recipients: {},
    privateChannels: new Set(),
    acl: createAclStore(undefined, { manages: (p, s, a) => manages(s, a ?? "", p) }),
    ...over,
  };
  const manages = fakeManages(state);
  return state;
}

async function grantsOf(state: FakeState): Promise<Grant[]> {
  return [...(await state.acl.list())];
}

function ownerState(): FakeState {
  const home = (type: ArtifactType, id: string): ArtifactHome & { type: ArtifactType } => ({
    type,
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    grantRef: type === "file" ? `artifacts/${id}/doc.md` : `${type === "deploy" ? "deployment" : type}:${id}`,
  });
  return baseState({
    artifacts: {
      "file:F1": home("file", "F1"),
      "skill:S1": home("skill", "S1"),
      "deploy:D1": home("deploy", "D1"),
      "cron:K1": home("cron", "K1"),
    },
    scopesByPrincipal: {
      U1: [scopeId("personal", "U1"), scopeId("org", ORG), scopeId("channel", "C1")],
      U2: [scopeId("personal", "U2"), scopeId("org", ORG)],
    },
    recipients: { carol: { kind: "one", member: { principalId: "U-carol", displayName: "Carol", type: "internal" } } },
  });
}

function addArtifact(state: FakeState, type: ArtifactType, id: string, ownerScopeId: ScopeId): FakeState {
  const grantRef = `${type === "deploy" ? "deployment" : type}:${id}`;
  state.artifacts[`${type}:${id}`] = { type, id, ownerScopeId, createdBy: "U1", grantRef };
  return state;
}

const share = (state: FakeState, input: ShareInput, claims: CapabilityClaims) =>
  createControlService(fakeApp(state)).shareArtifact(input, claims);

type ShareInput = Parameters<ReturnType<typeof createControlService>["shareArtifact"]>[0];

test("share adds a grant for EVERY artifact type — one verb, one store, uniform across file/skill/deploy/cron", async () => {
  for (const type of ["file", "skill", "deploy", "cron"] as const) {
    const state = ownerState();
    const id = { file: "F1", skill: "S1", deploy: "D1", cron: "K1" }[type];
    const r = await share(state, { type, id, scope: scopeId("channel", "C1") }, cap("U1"));
    assert.ok(r.ok, `${type}: ${JSON.stringify(r)}`);
    assert.equal(r.verb, "share");
    const grants = await grantsOf(state);
    assert.equal(grants.length, 1, `${type}: exactly one grant`);
    const g = grants[0]!;
    assert.equal(g.ownerScopeId, scopeId("personal", "U1"), `${type}: home scope unchanged`);
    assert.equal(g.granteeScopeId, scopeId("channel", "C1"));
    assert.equal(g.grantedBy, "U1");
    assert.equal(g.permission, "read");
    const expectedPath =
      type === "file" ? `artifacts/${id}/doc.md` : `${type === "deploy" ? "deployment" : type}:${id}`;
    assert.equal(g.ref, expectedPath, `${type}: keyed on the consumer's path`);
  }
});

test("share resolves a teammate by name → a frictionless person grant (the person-follows model, §3)", async () => {
  const state = ownerState();
  const r = await share(state, { type: "file", id: "F1", recipient: "carol" }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.target.scope, scopeId("personal", "U-carol"));
  assert.equal(r.target.label, "Carol");
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("personal", "U-carol"));
});

test("share into a scope you belong to is frictionless; permission:write is honored", async () => {
  const state = ownerState();
  const r = await share(
    state,
    { type: "deploy", id: "D1", scope: scopeId("channel", "C1"), permission: "write" },
    cap("U1"),
  );
  assert.ok(r.ok);
  assert.equal(r.permission, "write");
  assert.equal((await grantsOf(state))[0]!.permission, "write");
});

test("move changes the home scope (skills); the creator is untouched; no grant is written", async () => {
  const state = ownerState();
  const r = await share(state, { type: "skill", id: "S1", scope: scopeId("channel", "C1"), move: true }, cap("U1"));
  assert.ok(r.ok);
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "skill", id: "S1", toScope: scopeId("channel", "C1"), movedBy: "U1" }]);
  assert.equal((await grantsOf(state)).length, 0, "a move adds no grant");
});

test("moving a DEPLOY to a teammate's personal scope is an ownership transfer — allowed for a live actor", async () => {
  const state = ownerState();
  const r = await share(state, { type: "deploy", id: "D1", recipient: "carol", move: true }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "deploy", id: "D1", toScope: scopeId("personal", "U-carol"), movedBy: "U1" }]);
  assert.equal((await grantsOf(state)).length, 0, "a move adds no grant at this layer");
});

test("moving a deploy into a channel you belong to re-homes it there (group ownership)", async () => {
  const state = ownerState();
  const r = await share(state, { type: "deploy", id: "D1", scope: scopeId("channel", "C1"), move: true }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "deploy", id: "D1", toScope: scopeId("channel", "C1"), movedBy: "U1" }]);
});

test("an org admin CAN cede a skill to the org — share to org promotes", async () => {
  const state = ownerState();
  state.admins.add("U1");
  const r = await share(state, { type: "skill", id: "S1", scope: "org" }, cap("U1"));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.verb, "promote");
    assert.equal(r.id, "org-S1", "the promoted org record's id is returned, not the source's");
  }
  assert.deepEqual(state.promotes, [{ id: "S1", targetScopeId: scopeId("org", ORG), actorId: "U1" }]);
});

test("an org admin can promote a TEAMMATE'S skill org-wide — admin-ness, not ownership, is the authority", async () => {
  const state = ownerState();
  state.admins.add("U9");
  const r = await share(state, { type: "skill", id: "S1", scope: "org" }, cap("U9"));
  assert.equal(r.ok, true);
  assert.deepEqual(state.promotes, [{ id: "S1", targetScopeId: scopeId("org", ORG), actorId: "U9" }]);
});

const refusals: Array<[string, (state: FakeState) => void, ShareInput, CapabilityClaims, string, RegExp?]> = [
  [
    "a move into a teammate's personal scope (a move re-homes only into a context you belong to)",
    () => {},
    { type: "skill", id: "S1", recipient: "carol", move: true },
    cap("U1"),
    "forbidden",
  ],
  [
    "a deploy ownership transfer to a person from an autonomous trigger",
    () => {},
    { type: "deploy", id: "D1", recipient: "carol", move: true },
    cap("U1", undefined, false),
    "forbidden",
  ],
  [
    "a move of a type whose home isn't movable (file), directed to share",
    () => {},
    { type: "file", id: "F1", scope: scopeId("channel", "C1"), move: true },
    cap("U1"),
    "share_failed",
    /isn't supported/,
  ],
  [
    "a non-admin ceding a skill to the org (never a silent grant)",
    () => {},
    { type: "skill", id: "S1", scope: "org" },
    cap("U1"),
    "forbidden",
  ],
  [
    "an autonomous trigger ceding a skill to the org, even as an admin",
    (state) => state.admins.add("U1"),
    { type: "skill", id: "S1", scope: "org" },
    cap("U1", undefined, false),
    "forbidden",
  ],
  [
    "a non-admin ceding a skill to the org via MOVE",
    () => {},
    { type: "skill", id: "S1", scope: "org", move: true },
    cap("U1"),
    "forbidden",
  ],
  [
    "a non-member sharing into a scope they're not in",
    () => {},
    { type: "file", id: "F1", scope: scopeId("channel", "C9") },
    cap("U1"),
    "forbidden",
  ],
  [
    "a non-creator re-sharing a personal-homed artifact",
    (state) => {
      state.scopesByPrincipal["U2"] = [scopeId("personal", "U2"), scopeId("org", ORG), scopeId("channel", "C1")];
    },
    { type: "file", id: "F1", scope: scopeId("channel", "C1") },
    cap("U2"),
    "forbidden",
  ],
  [
    "an author who LEFT a private channel (membership, not authorship)",
    (state) => {
      state.privateChannels.add("C1");
      addArtifact(state, "skill", "CS", scopeId("channel", "C1"));
      state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG)];
    },
    { type: "skill", id: "CS", scope: "org" },
    cap("U1"),
    "forbidden",
  ],
  [
    "a non-author member of a PUBLIC channel (the author door is author-only)",
    (state) => {
      addArtifact(state, "cron", "PK", scopeId("channel", "C2"));
      state.scopesByPrincipal["U2"] = [scopeId("personal", "U2"), scopeId("org", ORG), scopeId("channel", "C2")];
    },
    { type: "cron", id: "PK", scope: "org" },
    cap("U2"),
    "forbidden",
  ],
  [
    "a non-member of a shared home (membership-gated, not just creator-gated)",
    (state) => {
      addArtifact(state, "skill", "CS", scopeId("channel", "C1"));
      state.scopesByPrincipal["U3"] = [scopeId("personal", "U3"), scopeId("org", ORG)];
    },
    { type: "skill", id: "CS", scope: "org" },
    cap("U3"),
    "forbidden",
  ],
  [
    "sharing into a team the actor is NOT on",
    () => {},
    { type: "file", id: "F1", scope: scopeId("team", "T9") },
    cap("U1"),
    "forbidden",
  ],
  ["an unknown artifact", () => {}, { type: "file", id: "ghost", scope: "org" }, cap("U1"), "not_found"],
  ["a bad scope id", () => {}, { type: "file", id: "F1", scope: "not-a-scope" }, cap("U1"), "bad_request"],
  ["an unknown teammate", () => {}, { type: "file", id: "F1", recipient: "nobody" }, cap("U1"), "recipient_not_found"],
];
for (const [name, setup, input, claims, code, message] of refusals) {
  test(`share refuses ${name} and writes nothing`, async () => {
    const state = ownerState();
    setup(state);
    const r = await share(state, input, claims);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.code, code);
      if (message) assert.match(r.message, message);
    }
    assert.deepEqual(state.moves, []);
    assert.deepEqual(state.promotes, []);
    assert.deepEqual(await grantsOf(state), []);
  });
}

test("a member of a shared home (private channel/group) can share it even if they didn't create it (PR2 manage parity)", async () => {
  const state = addArtifact(ownerState(), "skill", "CS", scopeId("channel", "C1"));
  state.privateChannels.add("C1");
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("channel", "C1"),
    scopeId("group", "G9"),
  ];
  const r = await share(
    state,
    { type: "skill", id: "CS", scope: scopeId("group", "G9") },
    cap("U2", scopeId("channel", "C1")),
  );
  assert.ok(r.ok, JSON.stringify(r));
  const grants = await grantsOf(state);
  assert.equal(grants[0]!.granteeScopeId, scopeId("group", "G9"));
  assert.equal(grants[0]!.grantedBy, "U2", "the sharing member is recorded, not the creator");
});

test("a PUBLIC-channel artifact's author can share it end to end — both authz gates agree (#986 regression)", async () => {
  const state = addArtifact(ownerState(), "cron", "PK", scopeId("channel", "C2"));
  const r = await share(state, { type: "cron", id: "PK", scope: "org" }, cap("U1"));
  assert.ok(r.ok, `a public-channel author must share their own cron end to end: ${JSON.stringify(r)}`);
  const g = (await grantsOf(state)).find((x) => x.ref === "cron:PK");
  assert.ok(g, "the grant is actually persisted through the real acl guard");
  assert.equal(g!.granteeScopeId, scopeId("org", ORG));
  assert.equal(g!.grantedBy, "U1");
  state.privateChannels.add("C1");
  addArtifact(state, "deploy", "PD", scopeId("channel", "C2"));
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG)];
  const pub = await share(state, { type: "deploy", id: "PD", scope: "org" }, cap("U1"));
  assert.ok(pub.ok, "a public-channel author still manages via the owner door");
});

test("sharing a non-skill to the org is a plain visibility grant (org is everyone's floor — no review)", async () => {
  const state = ownerState();
  const r = await share(state, { type: "deploy", id: "D1", scope: "org" }, cap("U1"));
  assert.ok(r.ok);
  assert.equal(r.target.scope, scopeId("org", ORG));
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("org", ORG));
});

test("sharing into a TEAM the actor belongs to is frictionless (team is a my_scopes context, §3)", async () => {
  const state = ownerState();
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG), scopeId("team", "T1")];
  const r = await share(state, { type: "file", id: "F1", scope: scopeId("team", "T1") }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("team", "T1"));
});

test("an automated trigger (no liveActor) cannot MOVE a skill out of its shared home, and the live move records the mover", async () => {
  const state = addArtifact(ownerState(), "skill", "CM", scopeId("channel", "C1"));
  state.privateChannels.add("C1");
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("channel", "C1"),
    scopeId("group", "G9"),
  ];
  const svc = createControlService(fakeApp(state));

  const trigger = cap("U2", scopeId("personal", "U2"), false);
  const blocked = await svc.shareArtifact(
    { type: "skill", id: "CM", scope: scopeId("group", "G9"), move: true },
    trigger,
  );
  assert.equal(blocked.ok, false, "a trigger cannot move a shared skill out of its home");
  if (!blocked.ok) assert.equal(blocked.code, "forbidden");
  assert.equal(state.moves.length, 0, "nothing was re-homed");

  const live = await svc.shareArtifact(
    { type: "skill", id: "CM", scope: scopeId("group", "G9"), move: true },
    cap("U2", scopeId("channel", "C1")),
  );
  assert.ok(live.ok, JSON.stringify(live));
  assert.equal(state.moves.length, 1, "a live member's move goes through");
  assert.equal(state.moves[0]!.movedBy, "U2", "the mover is recorded, not the creator U1");
});

test("a trigger (no liveActor) cannot MOVE a personal skill INTO a shared scope either — a move that authors a group-wide skill is guarded like create", async () => {
  const state = ownerState();
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG), scopeId("channel", "C1")];
  const svc = createControlService(fakeApp(state));
  const trigger = cap("U1", scopeId("personal", "U1"), false);
  const blocked = await svc.shareArtifact(
    { type: "skill", id: "S1", scope: scopeId("channel", "C1"), move: true },
    trigger,
  );
  assert.equal(blocked.ok, false, "a trigger cannot move a skill into a shared home");
  if (!blocked.ok) assert.equal(blocked.code, "forbidden");
  assert.equal(state.moves.length, 0);

  const live = await svc.shareArtifact(
    { type: "skill", id: "S1", scope: scopeId("channel", "C1"), move: true },
    cap("U1"),
  );
  assert.ok(live.ok, JSON.stringify(live));
  assert.equal(state.moves[0]!.toScope, scopeId("channel", "C1"));
});

function callShareRoute(state: FakeState, capability: CapabilityClaims | null, body: unknown) {
  const out: { status?: number; body?: any } = {};
  const res = {
    writeHead(s: number) {
      out.status = s;
    },
    end(d?: string) {
      out.body = d ? JSON.parse(d) : undefined;
    },
  };
  const ctx = { res, deps: { control: createControlService(fakeApp(state)) }, body, capability } as unknown as ApiCtx;
  return shareRoute(ctx).then(() => out);
}

test("POST /v1/share: a single toScope (scope id) → 200 grant; a name → directory-resolved", async () => {
  const byScope = await callShareRoute(ownerState(), cap("U1"), {
    type: "file",
    id: "F1",
    toScope: scopeId("channel", "C1"),
  });
  assert.equal(byScope.status, 200);
  assert.equal(byScope.body.verb, "share");
  assert.equal(byScope.body.target.scope, scopeId("channel", "C1"));

  const byName = await callShareRoute(ownerState(), cap("U1"), { type: "file", id: "F1", toScope: "carol" });
  assert.equal(byName.status, 200);
  assert.equal(byName.body.target.label, "Carol");
});

test("POST /v1/share: no capability → 403; bad type/missing fields → 400; non-admin org cede → 403", async () => {
  const state = ownerState();
  assert.equal((await callShareRoute(state, null, { type: "file", id: "F1", toScope: "org" })).status, 403);
  assert.equal((await callShareRoute(state, cap("U1"), { type: "bogus", id: "F1", toScope: "org" })).status, 400);
  assert.equal((await callShareRoute(state, cap("U1"), { type: "file", toScope: "org" })).status, 400);
  assert.equal((await callShareRoute(state, cap("U1"), { type: "file", id: "F1" })).status, 400);
  assert.equal(
    (await callShareRoute(state, cap("U1"), { type: "skill", id: "S1", toScope: "org" })).status,
    403,
    "non-admin org skill cede → forbidden (403)",
  );
});

test("splitToScope: tool and route classify identically — a real scope id vs a name (incl. a colon name)", () => {
  assert.deepEqual(splitToScope("org"), { scope: "org" });
  assert.deepEqual(splitToScope("channel:C1"), { scope: "channel:C1" });
  assert.deepEqual(splitToScope("personal:U7"), { scope: "personal:U7" });
  assert.deepEqual(
    splitToScope("not:valid"),
    { recipient: "not:valid" },
    "an invalid kind: prefix is a name, not a scope",
  );
  assert.deepEqual(splitToScope("Carol"), { recipient: "Carol" });
  assert.deepEqual(splitToScope("  Ann Lee  "), { recipient: "Ann Lee" }, "trimmed");
});

test("SkillStore.move changes the home scope in place; org move is refused (use promote)", async () => {
  const store = createSkillStore();
  const created = await store.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "tidy", description: "d", requiredCapabilities: [], body: "b" },
    createdBy: "U1",
  });
  const moved = await store.move(created.id, scopeId("channel", "C1"));
  assert.equal(moved.id, created.id, "same record id");
  assert.equal(moved.version, created.version, "version unchanged by a move");
  assert.equal(moved.createdBy, "U1", "creator is immutable");
  assert.equal(moved.scopeId, scopeId("channel", "C1"), "home scope changed");
  await assert.rejects(() => store.move(created.id, scopeId("org", ORG)), /admin-gated/);
});

test("SkillStore.promote supersedes an existing same-name org record instead of duplicating it", async () => {
  const store = createSkillStore();
  const src = await store.create({
    scopeId: scopeId("personal", "U1"),
    manifest: { name: "tidy", description: "d", requiredCapabilities: [], body: "b" },
    createdBy: "U1",
  });
  await store.review(src.id, "R1", []);
  await store.publish(src.id);
  const first = await store.promote(src.id, scopeId("org", ORG));
  const second = await store.promote(src.id, scopeId("org", ORG));
  assert.equal(second.id, first.id, "retry re-uses the org record");
  assert.equal(second.version, first.version + 1);
  const orgRecords = (await store.list()).filter((x) => x.scopeId === scopeId("org", ORG) && x.status === "published");
  assert.equal(orgRecords.length, 1);
});
