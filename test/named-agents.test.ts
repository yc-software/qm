import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import {
  createControlService,
  type AgentsRequest,
  type AgentsResult,
  type ControlService,
} from "../src/api/control-service.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { encodeRef, skillRef } from "../src/acl/resource-ref.ts";

const SECRET = "named-agents-test-secret".repeat(2);
const ORG = scopeId("org", "default-org");
const DESIGN = "C0DESIGN";
const DESIGN_SCOPE = scopeId("channel", DESIGN);
const ANN = "ann@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";
const DAN = "dan@example.com";
const ADMIN = "admin-alice";
const personal = (id: string) => scopeId("personal", id);
const ADA = {
  channel: "design",
  handle: "ada",
  displayName: "Ada",
  title: "Design critic",
};

async function setup(opts: { flag?: boolean } = {}) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "named-agents-")),
      signingSecret: SECRET,
      capabilitySecret: SECRET,
      apiBaseUrl: "http://core.example.test",
    }),
  );
  await built.app.upsertDirectory([
    { principalId: ANN, displayName: "Ann", type: "internal" },
    { principalId: BOB, displayName: "Bob", type: "internal" },
    { principalId: CY, displayName: "Cy", type: "internal" },
    { principalId: DAN, displayName: "Dan", type: "internal" },
    { principalId: ADMIN, displayName: "Alice Admin", type: "internal" },
  ]);
  await built.app.upsertChannels(
    [
      { channelId: DESIGN, name: "design", isPrivate: true },
      { channelId: "C0OPEN", name: "open", isPrivate: false },
    ],
    [ANN, BOB, CY]
      .map((principalId) => ({ channelId: DESIGN, principalId }))
      .concat([ANN, BOB, CY, DAN].map((principalId) => ({ channelId: "C0OPEN", principalId }))),
  );
  if (opts.flag !== false) await built.featureFlags.setEnabled("named_agents", ORG, true, ADMIN);
  const control = createControlService(built.app, built.scheduler, built.admin);
  return { built, control };
}

function toolsFor(
  control: ControlService,
  claims: Pick<CapabilityClaims, "actorId" | "scopeId"> & Partial<CapabilityClaims>,
) {
  const ctx = createToolContext({
    sandbox: {} as unknown as Sandbox,
    provision: async () => ({ id: "h", rootDir: "/workspace" }),
    writableScopeId: claims.scopeId,
    readOnlyScopeIds: [],
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    deploy: {} as never,
    acl: {} as never,
    createdBy: claims.actorId,
    control,
    controlClaims: { exp: Date.now() + CAPABILITY_TTL_MS, ...claims },
    agentsTool: true,
  });
  const all = createAgentTools({ current: ctx }, { controlTools: true });
  return async (name: string, params: Record<string, unknown>): Promise<string> => {
    const tool = all.find((t) => t.name === name);
    assert.ok(tool, `tool ${name}`);
    const out = (await tool.execute("call", params as never, undefined, undefined, {} as never)) as {
      content: Array<{ text: string }>;
    };
    return out.content[0]!.text;
  };
}

const fromDm = (control: ControlService, actorId: string, live = true) =>
  toolsFor(control, { actorId, scopeId: personal(actorId), ...(live ? { liveActor: true } : {}) });
const inChannel = (control: ControlService, actorId: string) =>
  toolsFor(control, { actorId, scopeId: DESIGN_SCOPE, liveActor: true });

const claimsFor = (actorId: string, extra: Partial<CapabilityClaims> = { liveActor: true }): CapabilityClaims => ({
  actorId,
  scopeId: personal(actorId),
  exp: Date.now() + CAPABILITY_TTL_MS,
  ...extra,
});
const agentsAs =
  (control: ControlService, actorId: string, extra?: Partial<CapabilityClaims>) =>
  (req: AgentsRequest): Promise<AgentsResult> =>
    control.agents(req, claimsFor(actorId, extra));

function agentOf(r: AgentsResult) {
  assert.ok(r.ok && "agent" in r, JSON.stringify(r));
  return r.agent;
}

function agentsOf(r: AgentsResult) {
  assert.ok(r.ok && "agents" in r, JSON.stringify(r));
  return r.agents.map((a) => a.handle);
}

function codeOf(r: AgentsResult) {
  assert.ok(!r.ok, JSON.stringify(r));
  return r.code;
}

async function createAda(control: ControlService) {
  const ada = agentOf(await agentsAs(control, ANN)({ action: "create", ...ADA, owners: ["Bob"] }));
  assert.deepEqual(
    {
      handle: ada.handle,
      displayName: ada.displayName,
      title: ada.title,
      channelId: ada.channelId,
      owners: ada.owners,
    },
    { handle: "ada", displayName: "Ada", title: "Design critic", channelId: DESIGN, owners: ["Ann", "Bob"] },
  );
}

function serve(built: Awaited<ReturnType<typeof setup>>["built"]) {
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    admin: built.admin,
    auditLog: built.auditLog,
    identity: built.identity,
    sessions: built.sessions,
    acl: built.acl,
    featureFlags: built.featureFlags,
    channelPolicy: built.channelPolicy,
    directory: built.directory,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { call, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function refusals(built: Awaited<ReturnType<typeof setup>>["built"]) {
  return (await built.auditLog.events()).filter((e) => e.action === "agent_lock_refused");
}

test("a channel member can no longer rewrite a named agent's soul through the guidance tool; a live owner can, versioned", async () => {
  const { built, control } = await setup();
  await createAda(control);
  const replace = { action: "replace", scope: "conversation" };

  assert.match(await inChannel(control, CY)("guidance", { ...replace, content: "be rude" }), /^\[error\]/);
  assert.equal(built.config.getSoul(DESIGN_SCOPE), null);
  assert.deepEqual(
    (await refusals(built)).map((e) => e.principalId),
    [CY],
  );

  const unattended = toolsFor(control, { actorId: ANN, scopeId: DESIGN_SCOPE });
  assert.match(await unattended("guidance", { ...replace, content: "be kind" }), /^\[error\]/);
  assert.equal(built.config.getSoul(DESIGN_SCOPE), null);

  assert.doesNotMatch(await inChannel(control, ANN)("guidance", { ...replace, content: "be kind" }), /^\[error\]/);
  assert.equal(built.config.getSoul(DESIGN_SCOPE), "be kind");
  assert.equal(built.config.soulHistory(DESIGN_SCOPE)[0]?.content, "be kind");
  assert.equal(built.config.soulHistory(DESIGN_SCOPE)[0]?.updatedBy, ANN);
});

test("POST /v1/soul and the web policy route refuse a non-owner member and allow a live owner; the admin console stays open", async () => {
  const { built, control } = await setup();
  await createAda(control);
  const { call, close } = serve(built);
  try {
    const denied = await call("POST", "/v1/soul", { scopeId: DESIGN_SCOPE, content: "be rude", actorId: CY });
    assert.equal(denied.status, 403);
    assert.equal(((await denied.json()) as { error: string }).error, "agent_locked");
    const allowed = await call("POST", "/v1/soul", { scopeId: DESIGN_SCOPE, content: "be kind", actorId: ANN });
    assert.equal(allowed.status, 200, await allowed.text());
    assert.equal(built.config.getSoul(DESIGN_SCOPE), "be kind");

    const policy = (principalId: string) =>
      call("PUT", "/v1/contexts/policy", { principalId, scope: DESIGN_SCOPE, orders: `orders from ${principalId}` });
    assert.equal((await policy(CY)).status, 403);
    assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders ?? "", "");
    assert.equal((await policy(ANN)).status, 200);
    assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders, `orders from ${ANN}`);

    const admin = await call(
      "PUT",
      `/v1/admin/scopes/${DESIGN_SCOPE}/soul`,
      { content: "admin says hi" },
      { "x-admin-actor": "admin-alice@default-org" },
    );
    assert.equal(admin.status, 200, await admin.text());
    assert.equal(built.config.getSoul(DESIGN_SCOPE), "admin says hi");
  } finally {
    await close();
  }
});

test("skill creation, edit, archive, move and sharing into the agent's channel are locked to live owners", async () => {
  const { built, control } = await setup();
  const ownSkill = await built.app.createOwnedSkill({
    principalId: CY,
    name: "cy-notes",
    description: "notes",
    body: "take notes",
    liveActor: true,
  });
  assert.ok(ownSkill);
  const homed = await built.app.createOwnedSkill({
    principalId: CY,
    homeScope: DESIGN_SCOPE,
    name: "crit",
    description: "critique",
    body: "critique designs",
    liveActor: true,
  });
  assert.ok(homed);
  await createAda(control);
  const { call, close } = serve(built);
  try {
    const create = (principalId: string, name: string) =>
      call("POST", "/v1/skills", { principalId, scopeId: DESIGN_SCOPE, name, description: "d", body: "b" });
    assert.equal((await create(CY, "sneaky")).status, 403);
    assert.equal((await create(ANN, "owned")).status, 201);

    const edit = await call("PUT", `/v1/skills/${homed.id}`, { principalId: CY, body: "be harsh" });
    assert.equal(edit.status, 403);
    assert.equal((await built.app.getSkill(homed.id))?.manifest.body, "critique designs");
    assert.equal((await call("DELETE", `/v1/skills/${homed.id}`, { principalId: CY })).status, 403);
    assert.equal((await built.app.getSkill(homed.id))?.status, "published");

    const cy = toolsFor(control, { actorId: CY, scopeId: personal(CY), liveActor: true });
    const before = (await refusals(built)).length;
    assert.match(await cy("skills", { action: "share", id: ownSkill.id, toScope: DESIGN_SCOPE }), /^\[error\]/);
    assert.equal((await refusals(built)).length, before + 1);
    const moveOut = await control.shareArtifact(
      { type: "skill", id: homed.id, scope: personal(CY), move: true },
      { actorId: CY, scopeId: DESIGN_SCOPE, liveActor: true, exp: Date.now() + CAPABILITY_TTL_MS },
    );
    assert.equal(moveOut.ok, false);
    assert.equal((await built.app.getSkill(homed.id))?.scopeId, DESIGN_SCOPE);

    const ann = toolsFor(control, { actorId: ANN, scopeId: personal(ANN), liveActor: true });
    const annSkill = await built.app.createOwnedSkill({
      principalId: ANN,
      name: "ann-tips",
      description: "tips",
      body: "tips",
      liveActor: true,
    });
    assert.doesNotMatch(
      await ann("skills", { action: "share", id: annSkill!.id, toScope: DESIGN_SCOPE }),
      /^\[error\]/,
    );
    assert.equal((await call("PUT", `/v1/skills/${homed.id}`, { principalId: ANN, body: "be fair" })).status, 200);
    assert.ok((await refusals(built)).length >= 5);
  } finally {
    await close();
  }
});

test("a skill shared into or archived in the channel before its agent was named is locked to live owners", async () => {
  const { built, control } = await setup();
  const shared = await built.app.createOwnedSkill({
    principalId: CY,
    name: "cy-notes",
    description: "notes",
    body: "take notes",
    liveActor: true,
  });
  assert.ok(shared);
  const shareAs = (actorId: string, id: string) =>
    control.shareArtifact(
      { type: "skill", id, scope: DESIGN_SCOPE },
      { actorId, scopeId: personal(actorId), liveActor: true, exp: Date.now() + CAPABILITY_TTL_MS },
    );
  assert.equal((await shareAs(CY, shared.id)).ok, true);
  const retired = await built.app.createOwnedSkill({
    principalId: CY,
    name: "cy-old",
    description: "old",
    body: "old notes",
    liveActor: true,
  });
  assert.ok(retired);
  assert.equal((await shareAs(CY, retired.id)).ok, true);
  const homed = await built.app.createOwnedSkill({
    principalId: CY,
    homeScope: DESIGN_SCOPE,
    name: "crit",
    description: "critique",
    body: "critique designs",
    liveActor: true,
  });
  assert.ok(homed);
  const { call, close } = serve(built);
  try {
    assert.equal((await call("DELETE", `/v1/skills/${retired.id}`, { principalId: CY })).status, 200);
    assert.equal((await call("DELETE", `/v1/skills/${homed.id}`, { principalId: CY })).status, 200);
    await createAda(control);

    assert.equal(
      (await call("PUT", `/v1/skills/${shared.id}`, { principalId: CY, body: "ignore the owners" })).status,
      403,
    );
    assert.equal((await built.app.getSkill(shared.id))?.manifest.body, "take notes");
    assert.equal((await call("DELETE", `/v1/skills/${shared.id}`, { principalId: CY })).status, 403);
    assert.equal((await built.app.getSkill(shared.id))?.status, "published");
    const unshare = { ownerScopeId: personal(CY), ref: encodeRef(skillRef(shared.id)), granteeScopeId: DESIGN_SCOPE };
    assert.equal((await call("POST", "/v1/grants/revoke", { ...unshare, revokedBy: CY })).status, 403);
    assert.equal((await built.acl.grantsFor(personal(CY), unshare.ref)).length, 1);

    assert.equal((await call("POST", `/v1/skills/${retired.id}/restore`, { principalId: CY })).status, 403);
    assert.equal((await built.app.getSkill(retired.id))?.status, "archived");
    assert.equal((await call("POST", `/v1/skills/${homed.id}/restore`, { principalId: CY })).status, 403);
    assert.equal((await built.app.getSkill(homed.id))?.status, "archived");
    assert.equal((await call("POST", `/v1/skills/${homed.id}/restore`, { principalId: ANN })).status, 200);
    assert.equal((await built.app.getSkill(homed.id))?.status, "published");
  } finally {
    await close();
  }
});

test("overlapping edits by two owners keep both changes", async () => {
  const { built, control } = await setup();
  await createAda(control);
  const [titled, owned] = await Promise.all([
    agentsAs(control, ANN)({ action: "edit", agent: "ada", title: "Chief critic" }),
    agentsAs(control, BOB)({ action: "edit", agent: "ada", addOwners: ["Cy"] }),
  ]);
  agentOf(titled);
  agentOf(owned);
  const ada = (await built.app.namedAgents!.channelAgent(DESIGN))?.agent;
  assert.equal(ada?.title, "Chief critic");
  assert.deepEqual(ada?.owners, [ANN, BOB, CY]);
});

test("an archived agent unlocks its channel, and a channel without the flag is never governed", async () => {
  const { built, control } = await setup();
  await createAda(control);
  const replace = { action: "replace", scope: "conversation" };
  assert.equal(codeOf(await agentsAs(control, CY)({ action: "archive", agent: "ada" })), "forbidden");
  assert.equal(await built.app.namedAgents!.channelAgent(DESIGN).then((g) => g?.agent.state), "active");
  agentOf(await agentsAs(control, BOB)({ action: "archive", agent: "ada" }));
  assert.equal(await built.app.namedAgents!.channelAgent(DESIGN), undefined);
  await inChannel(control, CY)("guidance", { ...replace, content: "member edit" });
  assert.equal(built.config.getSoul(DESIGN_SCOPE), "member edit");

  await built.featureFlags.setEnabled("named_agents", ORG, false, ADMIN);
  await built.featureFlags.setEnabled("named_agents", personal(ANN), true, ADMIN);
  await createAda(control);
  assert.equal(await built.app.namedAgents!.channelAgent(DESIGN), undefined);
  await inChannel(control, CY)("guidance", { ...replace, content: "still open" });
  assert.equal(built.config.getSoul(DESIGN_SCOPE), "still open");
  await built.featureFlags.setEnabled("named_agents", DESIGN_SCOPE, true, ADMIN);
  assert.equal((await built.app.namedAgents!.channelAgent(DESIGN))?.agent.displayName, "Ada");
});

test("create checks membership and names; edits recheck names; one agent per channel", async () => {
  const { built, control } = await setup();
  const dan = agentsAs(control, DAN);
  assert.equal(codeOf(await dan({ action: "create", ...ADA })), "forbidden");
  const ann = agentsAs(control, ANN);
  assert.equal(codeOf(await ann({ action: "create", ...ADA, displayName: "Bob" })), "bad_request");
  assert.equal(codeOf(await ann({ action: "create", ...ADA, handle: "cy" })), "bad_request");
  assert.equal(codeOf(await ann({ action: "create", ...ADA, displayName: "qm" })), "bad_request");
  assert.equal(codeOf(await ann({ action: "create", ...ADA, handle: "Not A Handle!" })), "bad_request");
  assert.equal(await built.app.namedAgents!.channelAgent(DESIGN), undefined);
  await createAda(control);
  assert.equal(codeOf(await ann({ action: "create", ...ADA, handle: "ada2", displayName: "Ada Two" })), "conflict");
  assert.equal(
    codeOf(await ann({ action: "create", ...ADA, channel: "open", handle: "ADA", displayName: "Other" })),
    "conflict",
  );

  const annTool = fromDm(control, ANN);
  assert.doesNotMatch(
    await annTool("agents", { action: "create", ...ADA, channel: "open", handle: "opie", displayName: "Opie" }),
    /^\[error\]/,
  );
  assert.equal((await built.app.namedAgents!.channelAgent("C0OPEN"))?.agent.handle, "opie");
  assert.equal(codeOf(await ann({ action: "edit", agent: "opie", displayName: "ada" })), "conflict");
  assert.equal(codeOf(await ann({ action: "edit", agent: "opie", displayName: "Dan" })), "bad_request");
  assert.equal(agentOf(await ann({ action: "edit", agent: "ada", title: "Chief critic" })).title, "Chief critic");
  const actions = (await built.auditLog.events()).map((e) => e.action);
  assert.deepEqual(
    ["agent_create", "agent_update"].map((a) => actions.includes(a)),
    [true, true],
  );
});

test("the last active owner can't be removed or demoted, including when stored under a Slack-id alias", async () => {
  const { built, control } = await setup();
  await built.app.upsertChannels(
    [{ channelId: DESIGN, name: "design", isPrivate: true }],
    [ANN, BOB, CY, "UANN"].map((principalId) => ({ channelId: DESIGN, principalId })),
  );
  const asSlack = agentsAs(control, "UANN");
  assert.deepEqual(agentOf(await asSlack({ action: "create", ...ADA })).owners, ["UANN"]);
  await built.principalLinks.link({ principalId: "UANN", canonicalId: ANN, evidence: "test: slack id", linkedBy: ANN });
  const ann = agentsAs(control, ANN);
  const listed = await ann({ action: "list" });
  assert.ok(listed.ok && "agents" in listed);
  assert.deepEqual(listed.agents[0]?.owners, ["Ann"]);
  await inChannel(control, ANN)("guidance", { action: "replace", scope: "conversation", content: "alias owner" });
  assert.equal(built.config.getSoul(DESIGN_SCOPE), "alias owner");
  assert.equal(codeOf(await ann({ action: "edit", agent: "ada", removeOwners: ["Ann"] })), "forbidden");
  assert.equal(codeOf(await asSlack({ action: "edit", agent: "ada", removeOwners: [ANN] })), "forbidden");
  assert.deepEqual(agentOf(await ann({ action: "edit", agent: "ada", addOwners: ["Bob"] })).owners, ["Ann", "Bob"]);
  await built.identity.deactivate(BOB);
  assert.equal(codeOf(await ann({ action: "edit", agent: "ada", removeOwners: ["Ann"] })), "forbidden");
  await built.identity.reactivate(BOB);
  assert.deepEqual(agentOf(await asSlack({ action: "edit", agent: "ada", removeOwners: ["Ann"] })).owners, ["Bob"]);
  assert.deepEqual((await built.app.namedAgents!.channelAgent(DESIGN))?.agent.owners, [BOB]);
  const audit = (await built.auditLog.events()).map((e) => e.action);
  assert.ok(audit.includes("agent_owner_add") && audit.includes("agent_owner_remove"));
});

test("deactivating every owner orphans the agent: the lock holds, admins see it, offboarding names it without acting", async () => {
  const { built, control } = await setup();
  await createAda(control);
  const { call, close } = serve(built);
  try {
    const preview = await call(
      "POST",
      `/v1/admin/users/${BOB}/offboard`,
      {},
      { "x-admin-actor": "admin-alice@default-org" },
    );
    assert.equal(preview.status, 200);
    assert.ok(
      !((await preview.json()) as { changes: Array<{ kind: string }> }).changes.some((c) => c.kind === "agent"),
    );

    await built.identity.deactivate(ANN);
    const applied = await call(
      "POST",
      `/v1/admin/users/${BOB}/offboard`,
      { apply: true },
      { "x-admin-actor": "admin-alice@default-org" },
    );
    assert.equal(applied.status, 200);
    const notice = ((await applied.json()) as { changes: Array<Record<string, unknown>> }).changes.find(
      (c) => c.kind === "agent",
    );
    assert.deepEqual(notice, { kind: "agent", id: notice!.id, label: "Ada", action: "orphan_notice" });
    assert.equal((await built.app.namedAgents!.channelAgent(DESIGN))?.orphaned, true);
    assert.ok(!(await built.auditLog.events()).some((e) => e.action.startsWith("user.offboard.agent")));

    assert.match(
      await inChannel(control, CY)("guidance", { action: "replace", scope: "conversation", content: "x" }),
      /^\[error\]/,
    );
    assert.equal(built.config.getSoul(DESIGN_SCOPE), null);
    const cyList = await agentsAs(control, CY)({ action: "list" });
    assert.ok(cyList.ok && "agents" in cyList);
    assert.deepEqual(
      cyList.agents.map((a) => [a.handle, a.orphaned]),
      [["ada", true]],
    );
    assert.deepEqual(agentsOf(await agentsAs(control, DAN)({ action: "list" })), []);
    const admin = agentsAs(control, ADMIN);
    assert.equal(codeOf(await admin({ action: "edit", agent: "ada", title: "Hijacked" })), "forbidden");
    assert.deepEqual(agentOf(await admin({ action: "edit", agent: "ada", addOwners: ["Cy"] })).owners, [
      "Ann",
      "Bob",
      "Cy",
    ]);
    assert.equal((await built.app.namedAgents!.channelAgent(DESIGN))?.orphaned, false);
  } finally {
    await close();
  }
});

test("standing orders set from a channel turn are locked to the agent's owners", async () => {
  const { built, control } = await setup();
  await createAda(control);
  built.runtime.start();
  const say = async (actor: string, root: string, text: string) => {
    await built.app.turn({
      ...turn(
        actor,
        {
          kind: "channel",
          threadRef: `ch:${DESIGN}:${root}`,
          channelRef: DESIGN,
          audience: [{ externalId: actor }],
          publishMembers: [ANN, BOB, CY].map((externalId) => ({ externalId })),
        },
        text,
      ),
      deliveryTarget: `${DESIGN}:${root}`,
      async: true,
    });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const session = await built.sessions.getByThread(`ch:${DESIGN}:${root}`);
      const reply = session
        ? (await built.sessions.getItems(session.id)).find(
            (item) => item.kind === "AgentMessage" && item.variant === null && item.text,
          )
        : undefined;
      if (reply) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("no reply");
  };
  await say(CY, "1.1", "!set_standing_order be rude");
  assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders ?? "", "");
  assert.deepEqual(
    (await refusals(built)).map((e) => e.principalId),
    [CY],
  );
  await say(ANN, "2.2", "!set_standing_order be kind");
  assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders, "be kind");
});

test("list never shows a private channel's agent to a non-member", async () => {
  const { control } = await setup();
  await createAda(control);
  agentOf(
    await agentsAs(control, ANN)({ action: "create", ...ADA, channel: "open", handle: "opie", displayName: "Opie" }),
  );
  assert.deepEqual(agentsOf(await agentsAs(control, DAN)({ action: "list" })), ["opie"]);
  assert.deepEqual(agentsOf(await agentsAs(control, CY)({ action: "list" })).sort(), ["ada", "opie"]);
});

const turn = (actor: string, conversation: TurnRequest["conversation"], text: string): TurnRequest => ({
  surface: "slack",
  actor: { externalId: actor },
  conversation,
  text,
  origin: { kind: "human" },
});
const dmWith = (actor: string): TurnRequest["conversation"] => ({ kind: "dm", threadRef: `dm:${actor}:t` });
const designThread: TurnRequest["conversation"] = {
  kind: "channel",
  threadRef: `ch:${DESIGN}:1.1`,
  channelRef: DESIGN,
};

test("the agents tool is offered only in a live person's own DM with the flag on, and re-checked server-side", async () => {
  const { built, control } = await setup({ flag: false });
  const names = async (actor: string, conversation: TurnRequest["conversation"]) =>
    (await built.app.turn(turn(actor, conversation, "!toolnames"))).reply ?? "";
  assert.doesNotMatch(await names(ANN, dmWith(ANN)), /(^|,)agents(,|$)/);
  await built.featureFlags.setEnabled("named_agents", personal(ANN), true, ADMIN);
  assert.match(await names(ANN, dmWith(ANN)), /(^|,)agents(,|$)/);
  assert.doesNotMatch(await names(ANN, designThread), /(^|,)agents(,|$)/);
  assert.doesNotMatch(await names(BOB, dmWith(BOB)), /(^|,)agents(,|$)/);

  const list = { action: "list" } as const;
  assert.equal(codeOf(await agentsAs(control, ANN, {})(list)), "forbidden");
  assert.equal(codeOf(await agentsAs(control, ANN, { liveActor: true, triggered: true })(list)), "forbidden");
  assert.equal(codeOf(await agentsAs(control, ANN, { liveActor: true, scopeId: DESIGN_SCOPE })(list)), "forbidden");
  assert.equal(codeOf(await agentsAs(control, BOB)(list)), "forbidden");
  assert.deepEqual(agentsOf(await agentsAs(control, ANN)(list)), []);
  assert.deepEqual(agentsOf(await agentsAs(control, ANN, { liveAuthor: true })(list)), []);
});

test("a governed channel's prompt names the agent and its active owners; other channels and orphans don't", async () => {
  const { built, control } = await setup();
  await built.config.setSoul(DESIGN_SCOPE, "Critique kindly.");
  const prompt = async (conversation: TurnRequest["conversation"]) =>
    (await built.app.turn(turn(CY, conversation, "!sysprompt"))).reply ?? "";
  const thread = (root: string): TurnRequest["conversation"] => ({
    ...designThread,
    threadRef: `ch:${DESIGN}:${root}`,
  });
  const openThread: TurnRequest["conversation"] = { kind: "channel", threadRef: "ch:C0OPEN:1.1", channelRef: "C0OPEN" };

  const before = await prompt(thread("0.0"));
  assert.ok(before.includes("Critique kindly."));
  assert.doesNotMatch(before, /\bAda\b|\bBob\b/);

  await createAda(control);
  const governed = await prompt(thread("1.1"));
  assert.ok(governed.includes("Critique kindly."));
  assert.match(governed, /\bAda\b/);
  assert.match(governed, /\bBob\b/);
  assert.doesNotMatch(await prompt(openThread), /\bAda\b|\bBob\b/);

  await built.identity.deactivate(BOB);
  const oneOwner = await prompt(thread("2.2"));
  assert.match(oneOwner, /\bAda\b/);
  assert.doesNotMatch(oneOwner, /\bBob\b/);

  await built.identity.deactivate(ANN);
  const orphan = await prompt(thread("3.3"));
  assert.ok(orphan.includes("Critique kindly."));
  assert.doesNotMatch(orphan, /\bAda\b|\bBob\b/);
});
