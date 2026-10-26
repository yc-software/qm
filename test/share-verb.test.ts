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
import { createSkillStore } from "../src/skills/skill-store.ts";
import { splitToScope, triggerBlocksSharedSkill } from "../src/api/artifact-share.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createMemoryFileArtifactStore, type FileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
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
  files: FileArtifactStore;
}

function fakeManages(state: FakeState): ManagesArtifactHome {
  return async (homeScopeId, createdBy, principalId) => {
    if (!principalId) return false;
    const { kind, ref } = parseScopeId(homeScopeId);
    const memberManaged = kind === "group" || (kind === "channel" && state.privateChannels.has(ref));
    if (memberManaged && (state.scopesByPrincipal[principalId] ?? []).includes(homeScopeId)) return true;
    if (kind === "team") return (state.scopesByPrincipal[principalId] ?? []).includes(homeScopeId);
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
    async getCron(id: string) {
      const home = state.artifacts[`cron:${id}`];
      return home ? { id, owner: home.createdBy, createdBy: home.createdBy, ownerScopeId: home.ownerScopeId } : null;
    },
    samePerson: async (a: string, b: string) => a === b,
    isCurrentSharedScopeMember: async () => false,
    artifactGrantPermission: async () => null,
    membershipControlsScope: async () => false,
    managesScope: async () => false,
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
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const state: FakeState = {
    artifacts: {},
    scopesByPrincipal: {},
    moves: [],
    promotes: [],
    admins: new Set(),
    recipients: {},
    privateChannels: new Set(),
    files,
    acl: createAclStore(undefined, {
      manages: (p, s, a) => manages(s, a ?? "", p),
      resolveFiles: (refs) => files.resolveByIds(refs),
    }),
    ...over,
  };
  const manages = fakeManages(state);
  return state;
}

async function grantsOf(state: FakeState): Promise<Grant[]> {
  return [...(await state.acl.list())];
}

async function ownerState(): Promise<FakeState> {
  const home = (type: ArtifactType, id: string): ArtifactHome & { type: ArtifactType } => ({
    type,
    id,
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    grantRef: type === "file" ? id : `${type === "deploy" ? "deployment" : type}:${id}`,
  });
  const state = baseState({
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
  await state.files.put({
    id: "F1",
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    name: "doc.md",
    path: "artifacts/F1/doc.md",
    mimetype: "text/markdown",
    data: Buffer.from("hello"),
    direction: "out",
  });
  return state;
}

test("share adds a grant for EVERY artifact type — one verb, one store, uniform across file/skill/deploy/cron", async () => {
  for (const type of ["file", "skill", "deploy", "cron"] as const) {
    const state = await ownerState();
    const svc = createControlService(fakeApp(state));
    const id = { file: "F1", skill: "S1", deploy: "D1", cron: "K1" }[type];
    const r = await svc.shareArtifact({ type, id, scope: scopeId("channel", "C1") }, cap("U1"));
    assert.ok(r.ok, `${type}: ${JSON.stringify(r)}`);
    assert.equal(r.verb, "share");
    const grants = await grantsOf(state);
    assert.equal(grants.length, 1, `${type}: exactly one grant`);
    const g = grants[0]!;
    assert.equal(g.ownerScopeId, scopeId("personal", "U1"), `${type}: home scope unchanged`);
    assert.equal(g.granteeScopeId, scopeId("channel", "C1"));
    assert.equal(g.grantedBy, "U1");
    assert.equal(g.permission, "read");
    const expectedPath = type === "file" ? id : `${type === "deploy" ? "deployment" : type}:${id}`;
    assert.equal(g.ref, expectedPath, `${type}: keyed on the artifact ID`);
  }
});

test("share resolves a teammate by name → a frictionless person grant (the person-follows model, §3)", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", recipient: "carol" }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.target.scope, scopeId("personal", "U-carol"));
  assert.equal(r.target.label, "Carol");
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("personal", "U-carol"));
});

test("share into a scope you belong to is frictionless; permission:write is honored", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "D1", scope: scopeId("channel", "C1"), permission: "write" },
    cap("U1"),
  );
  assert.ok(r.ok);
  assert.equal(r.permission, "write");
  assert.equal((await grantsOf(state))[0]!.permission, "write");
});

test("move changes the home scope (skills); the creator is untouched; no grant is written", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "skill", id: "S1", scope: scopeId("channel", "C1"), move: true },
    cap("U1"),
  );
  assert.ok(r.ok);
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "skill", id: "S1", toScope: scopeId("channel", "C1"), movedBy: "U1" }]);
  assert.equal((await grantsOf(state)).length, 0, "a move adds no grant");
});

test("move into a teammate's personal scope is refused — a move re-homes only into a context you belong to", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "S1", recipient: "carol", move: true }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal(state.moves.length, 0);
});

test("moving a DEPLOY to a teammate's personal scope is an ownership transfer — allowed for a live actor", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "deploy", id: "D1", recipient: "carol", move: true }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "deploy", id: "D1", toScope: scopeId("personal", "U-carol"), movedBy: "U1" }]);
  assert.equal((await grantsOf(state)).length, 0, "a move adds no grant at this layer");
});

test("a deploy ownership transfer to a person takes a LIVE actor — an autonomous trigger is refused", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "D1", recipient: "carol", move: true },
    cap("U1", undefined, false),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal(state.moves.length, 0);
});

test("moving a deploy into a channel you belong to re-homes it there (group ownership)", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "deploy", id: "D1", scope: scopeId("channel", "C1"), move: true },
    cap("U1"),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.verb, "move");
  assert.deepEqual(state.moves, [{ type: "deploy", id: "D1", toScope: scopeId("channel", "C1"), movedBy: "U1" }]);
});

test("move is refused for a type whose home isn't movable (file) — directed to share", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("channel", "C1"), move: true }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.code, "share_failed");
    assert.match(r.message, /isn't supported/);
  }
});

test("ceding a skill to the ORG is admin-gated — a non-admin share to org is forbidden, never a silent grant", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "S1", scope: "org" }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal((await grantsOf(state)).length, 0, "no grant is written for a refused org-skill cede");
});

test("an org admin CAN cede a skill to the org — share to org promotes", async () => {
  const state = await ownerState();
  state.admins.add("U1");
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "S1", scope: "org" }, cap("U1"));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.verb, "promote");
    assert.equal(r.id, "org-S1", "the promoted org record's id is returned, not the source's");
  }
  assert.deepEqual(state.promotes, [{ id: "S1", targetScopeId: scopeId("org", ORG), actorId: "U1" }]);
});

test("an org admin can promote a TEAMMATE'S skill org-wide — admin-ness, not ownership, is the authority", async () => {
  const state = await ownerState();
  state.admins.add("U9");
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "S1", scope: "org" }, cap("U9"));
  assert.equal(r.ok, true);
  assert.deepEqual(state.promotes, [{ id: "S1", targetScopeId: scopeId("org", ORG), actorId: "U9" }]);
});

test("an autonomous trigger (no liveActor) cannot cede a skill to the org, even as an admin", async () => {
  const state = await ownerState();
  state.admins.add("U1");
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "S1", scope: "org" }, cap("U1", undefined, false));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal(state.promotes.length, 0);
});

test("ceding a skill to the org via MOVE is also refused for a non-admin (admin gate, not a frictionless move)", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "S1", scope: "org", move: true }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("a non-member can't share into a scope they're not in (forbidden)", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("channel", "C9") }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal((await grantsOf(state)).length, 0);
});

test("only the owner may share a personal-homed artifact — a non-creator is forbidden (no transitive re-share)", async () => {
  const state = await ownerState();
  state.scopesByPrincipal["U2"] = [scopeId("personal", "U2"), scopeId("org", ORG), scopeId("channel", "C1")];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("channel", "C1") }, cap("U2"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("a member of a shared home (private channel/group) can share it even if they didn't create it (PR2 manage parity)", async () => {
  const state = await ownerState();
  state.privateChannels.add("C1");
  state.artifacts["skill:CS"] = {
    type: "skill",
    id: "CS",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "skill:CS",
  };
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("channel", "C1"),
    scopeId("group", "G9"),
  ];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "skill", id: "CS", scope: scopeId("group", "G9") },
    cap("U2", scopeId("channel", "C1")),
  );
  assert.ok(r.ok, JSON.stringify(r));
  const grants = await grantsOf(state);
  assert.equal(grants[0]!.granteeScopeId, scopeId("group", "G9"));
  assert.equal(grants[0]!.grantedBy, "U2", "the sharing member is recorded, not the creator");
});

test("an author who LEFT a private channel can no longer share its artifact (parity with canManageSkill — membership, not authorship)", async () => {
  const state = await ownerState();
  state.privateChannels.add("C1");
  state.artifacts["skill:CS"] = {
    type: "skill",
    id: "CS",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "skill:CS",
  };
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG)];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "CS", scope: "org" }, cap("U1"));
  assert.equal(r.ok, false, "the ex-member author must not pass the manage check on a private channel");
  if (!r.ok) assert.equal(r.code, "forbidden");
  state.artifacts["deploy:PD"] = {
    type: "deploy",
    id: "PD",
    ownerScopeId: scopeId("channel", "C2"),
    createdBy: "U1",
    grantRef: "deployment:PD",
  };
  const pub = await svc.shareArtifact({ type: "deploy", id: "PD", scope: "org" }, cap("U1"));
  assert.ok(pub.ok, "a public-channel author still manages via the owner door");
});

test("a PUBLIC-channel artifact's author can share it end to end — both authz gates agree (#986 regression)", async () => {
  const state = await ownerState();
  state.artifacts["cron:PK"] = {
    type: "cron",
    id: "PK",
    ownerScopeId: scopeId("channel", "C2"),
    createdBy: "U1",
    grantRef: "cron:PK",
  };
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "cron", id: "PK", scope: "org" }, cap("U1"));
  assert.ok(r.ok, `a public-channel author must share their own cron end to end: ${JSON.stringify(r)}`);
  const g = (await grantsOf(state)).find((x) => x.ref === "cron:PK");
  assert.ok(g, "the grant is actually persisted through the real acl guard");
  assert.equal(g!.granteeScopeId, scopeId("org", ORG));
  assert.equal(g!.grantedBy, "U1");
});

test("a non-owner non-member CANNOT share a PUBLIC-channel artifact — the author door is author-only", async () => {
  const state = await ownerState();
  state.artifacts["cron:PK"] = {
    type: "cron",
    id: "PK",
    ownerScopeId: scopeId("channel", "C2"),
    createdBy: "U1",
    grantRef: "cron:PK",
  };
  state.scopesByPrincipal["U2"] = [scopeId("personal", "U2"), scopeId("org", ORG), scopeId("channel", "C2")];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "cron", id: "PK", scope: "org" }, cap("U2"));
  assert.equal(r.ok, false, "a non-author public-channel member must not share it");
  if (!r.ok) assert.equal(r.code, "forbidden");
  assert.equal(
    (await grantsOf(state)).find((x) => x.ref === "cron:PK"),
    undefined,
    "no grant is persisted",
  );
});

test("a non-member of a shared home cannot share it (membership-gated, not just creator-gated)", async () => {
  const state = await ownerState();
  state.artifacts["skill:CS"] = {
    type: "skill",
    id: "CS",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "skill:CS",
  };
  state.scopesByPrincipal["U3"] = [scopeId("personal", "U3"), scopeId("org", ORG)];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "skill", id: "CS", scope: "org" }, cap("U3"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("an unknown artifact is a not_found; a bad scope id is a bad_request; an unknown teammate is recipient_not_found", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const missing = await svc.shareArtifact({ type: "file", id: "ghost", scope: "org" }, cap("U1"));
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.code, "not_found");
    assert.match(missing.message, /POST \/v1\/files\/uploads/);
  }
  const path = await svc.shareArtifact({ type: "file", id: "artifacts/F1/doc.md", scope: "org" }, cap("U1"));
  assert.equal(path.ok, false);
  if (!path.ok) assert.match(path.message, /POST \/v1\/files\/uploads/);

  const badScope = await svc.shareArtifact({ type: "file", id: "F1", scope: "not-a-scope" }, cap("U1"));
  assert.equal(badScope.ok, false);
  if (!badScope.ok) assert.equal(badScope.code, "bad_request");

  const noOne = await svc.shareArtifact({ type: "file", id: "F1", recipient: "nobody" }, cap("U1"));
  assert.equal(noOne.ok, false);
  if (!noOne.ok) assert.equal(noOne.code, "recipient_not_found");
});

test("sharing a non-skill to the org is a plain visibility grant (org is everyone's floor — no review)", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "deploy", id: "D1", scope: "org" }, cap("U1"));
  assert.ok(r.ok);
  assert.equal(r.target.scope, scopeId("org", ORG));
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("org", ORG));
});

test("sharing into a TEAM the actor belongs to is frictionless (team is a my_scopes context, §3)", async () => {
  const state = await ownerState();
  state.scopesByPrincipal["U1"] = [scopeId("personal", "U1"), scopeId("org", ORG), scopeId("team", "T1")];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("team", "T1") }, cap("U1"));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await grantsOf(state))[0]!.granteeScopeId, scopeId("team", "T1"));
});

test("sharing into a team the actor is NOT on is forbidden", async () => {
  const state = await ownerState();
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact({ type: "file", id: "F1", scope: scopeId("team", "T9") }, cap("U1"));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "forbidden");
});

test("a move records the acting principal in the audit, not the artifact's creator", async () => {
  const state = await ownerState();
  state.privateChannels.add("C1");
  state.artifacts["skill:CM"] = {
    type: "skill",
    id: "CM",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "skill:CM",
  };
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("channel", "C1"),
    scopeId("group", "G9"),
  ];
  const svc = createControlService(fakeApp(state));
  const r = await svc.shareArtifact(
    { type: "skill", id: "CM", scope: scopeId("group", "G9"), move: true },
    cap("U2", scopeId("channel", "C1")),
  );
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(state.moves[0]!.movedBy, "U2", "the mover is recorded, not the creator U1");
});

test("an automated trigger (no liveActor) cannot MOVE a skill out of its shared home — the move-verb sibling of the shared-skill mutation guard", async () => {
  const state = await ownerState();
  state.privateChannels.add("C1");
  state.artifacts["skill:CM"] = {
    type: "skill",
    id: "CM",
    ownerScopeId: scopeId("channel", "C1"),
    createdBy: "U1",
    grantRef: "skill:CM",
  };
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
});

test("a team member who didn't create a team-owned skill can share it onward; a trigger cannot move it out", async () => {
  const state = await ownerState();
  state.artifacts["skill:TS"] = {
    type: "skill",
    id: "TS",
    ownerScopeId: scopeId("team", "alpha"),
    createdBy: "U1",
    grantRef: "skill:TS",
  };
  state.scopesByPrincipal["U2"] = [
    scopeId("personal", "U2"),
    scopeId("org", ORG),
    scopeId("team", "alpha"),
    scopeId("channel", "C7"),
  ];
  state.scopesByPrincipal["U3"] = [scopeId("personal", "U3"), scopeId("org", ORG), scopeId("channel", "C7")];
  const svc = createControlService(fakeApp(state));

  const shared = await svc.shareArtifact(
    { type: "skill", id: "TS", scope: scopeId("channel", "C7"), permission: "write" },
    cap("U2"),
  );
  assert.ok(shared.ok, JSON.stringify(shared));
  assert.ok((await grantsOf(state)).some((g) => g.ref === "skill:TS" && g.granteeScopeId === scopeId("channel", "C7")));

  const outsider = await svc.shareArtifact(
    { type: "skill", id: "TS", scope: scopeId("channel", "C7"), permission: "write" },
    cap("U3"),
  );
  assert.equal(outsider.ok, false, "a non-member cannot manage the team's skill");

  const trigger = await svc.shareArtifact(
    { type: "skill", id: "TS", scope: scopeId("personal", "U2"), move: true },
    cap("U2", scopeId("personal", "U2"), false),
  );
  assert.equal(trigger.ok, false, "an automated trigger cannot take a team skill out of the team");
  assert.equal(state.moves.length, 0);
});

test("skill mutations from an automated trigger are blocked for team homes, like channel and group homes", () => {
  assert.equal(triggerBlocksSharedSkill(scopeId("team", "alpha"), false), true);
  assert.equal(triggerBlocksSharedSkill(scopeId("team", "alpha"), true), false);
  assert.equal(triggerBlocksSharedSkill(scopeId("personal", "U1"), false), false);
});

test("a trigger (no liveActor) cannot MOVE a personal skill INTO a shared scope either — a move that authors a group-wide skill is guarded like create", async () => {
  const state = await ownerState();
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

test("splitToScope classifies a real scope id vs a name (incl. a colon name)", () => {
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
