import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { createControlService, type ControlService } from "../src/api/control-service.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { createToolContext } from "../src/tools/primitives.ts";
import { createAgentTools } from "../src/agent/agent-tools.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";

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
  avatar: { kind: "emoji", value: ":art:" },
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

async function createAda(control: ControlService, extra: Record<string, unknown> = {}) {
  const out = await fromDm(control, ANN)("agents", { action: "create", ...ADA, owners: ["Bob"], ...extra });
  assert.match(out, /^Created Ada \(@ada\), Design critic, in #design\. Owners: Ann, Bob\./, out);
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

  const refused = await inChannel(control, CY)("guidance", {
    action: "replace",
    scope: "conversation",
    content: "be rude",
  });
  assert.match(
    refused,
    /^\[error\] #design belongs to Ada\. Only Ada's owners and org admins can change .*; ask Ann\.$/,
  );
  assert.equal(built.config.getSoul(DESIGN_SCOPE), null);
  assert.equal((await refusals(built)).length, 1);
  assert.equal((await refusals(built))[0]!.principalId, CY);

  const unattended = await toolsFor(control, { actorId: ANN, scopeId: DESIGN_SCOPE })("guidance", {
    action: "replace",
    scope: "conversation",
    content: "be kind",
  });
  assert.match(unattended, /^\[error\] #design belongs to Ada/);

  const ok = await inChannel(control, ANN)("guidance", {
    action: "replace",
    scope: "conversation",
    content: "be kind",
  });
  assert.match(ok, /Updated your standing instructions \(now version \d+\)/);
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
    assert.match(
      await cy("skills", { action: "share", id: ownSkill.id, toScope: DESIGN_SCOPE }),
      /^\[error\] #design belongs to Ada/,
    );
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
    assert.match(await ann("skills", { action: "share", id: annSkill!.id, toScope: DESIGN_SCOPE }), /^Shared skill/);
    assert.equal((await call("PUT", `/v1/skills/${homed.id}`, { principalId: ANN, body: "be fair" })).status, 200);
    assert.ok((await refusals(built)).length >= 5);
  } finally {
    await close();
  }
});

test("an archived agent unlocks its channel, and a channel without the flag is never governed", async () => {
  const { built, control } = await setup();
  await createAda(control);
  assert.match(
    await fromDm(control, CY)("agents", { action: "archive", agent: "ada" }),
    /^\[error\] only Ada's active owners/,
  );
  assert.match(
    await fromDm(control, BOB)("agents", { action: "archive", agent: "ada" }),
    /^Archived Ada; #design is unlocked\./,
  );
  assert.match(
    await inChannel(control, CY)("guidance", { action: "replace", scope: "conversation", content: "member edit" }),
    /Updated your standing instructions/,
  );
  assert.equal(await built.app.namedAgents!.channelAgent(DESIGN), undefined);

  await built.featureFlags.setEnabled("named_agents", ORG, false, ADMIN);
  await built.featureFlags.setEnabled("named_agents", personal(ANN), true, ADMIN);
  await createAda(control);
  assert.equal(await built.app.namedAgents!.channelAgent(DESIGN), undefined);
  assert.match(
    await inChannel(control, CY)("guidance", { action: "replace", scope: "conversation", content: "still open" }),
    /Updated your standing instructions/,
  );
  await built.featureFlags.setEnabled("named_agents", DESIGN_SCOPE, true, ADMIN);
  assert.equal((await built.app.namedAgents!.channelAgent(DESIGN))?.agent.displayName, "Ada");
});

test("create checks membership, names and avatars; edits recheck names; one agent per channel", async () => {
  const { built, control } = await setup();
  const dan = fromDm(control, DAN);
  assert.match(
    await dan("agents", { action: "create", ...ADA }),
    /^\[error\] only a member of #design can give it an agent/,
  );
  const ann = fromDm(control, ANN);
  assert.match(await ann("agents", { action: "create", ...ADA, displayName: "Bob" }), /matches Bob in the directory/);
  assert.match(await ann("agents", { action: "create", ...ADA, handle: "cy" }), /matches Cy in the directory/);
  assert.match(await ann("agents", { action: "create", ...ADA, displayName: "qm" }), /this assistant's own name/);
  assert.match(
    await ann("agents", { action: "create", ...ADA, avatar: { kind: "emoji", value: "🎨" } }),
    /Slack shortcode like ":art:"/,
  );
  assert.match(
    await ann("agents", { action: "create", ...ADA, avatar: { kind: "url", value: "http://cdn.example.com/a.png" } }),
    /public https URL/,
  );
  await createAda(control, { avatar: { kind: "url", value: "https://cdn.example.com/ada.png" } });
  assert.match(
    await ann("agents", { action: "create", ...ADA, handle: "ada2", displayName: "Ada Two" }),
    /#design already has Ada/,
  );
  assert.match(
    await ann("agents", { action: "create", ...ADA, channel: "open", handle: "ADA", displayName: "Other" }),
    /Ada \(@ada\) already uses that name/,
  );
  assert.match(
    await ann("agents", { action: "create", ...ADA, channel: "open", handle: "opie", displayName: "Opie" }),
    /^Created Opie/,
  );
  assert.match(await ann("agents", { action: "edit", agent: "opie", displayName: "ada" }), /already uses that name/);
  assert.match(
    await ann("agents", { action: "edit", agent: "opie", displayName: "Dan" }),
    /matches Dan in the directory/,
  );
  assert.match(
    await ann("agents", { action: "edit", agent: "ada", title: "Chief critic" }),
    /^Updated Ada \(@ada\), Chief critic/,
  );
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
  const asSlack = fromDm(control, "UANN");
  assert.match(await asSlack("agents", { action: "create", ...ADA }), /^Created Ada .*Owners: UANN\./);
  await built.principalLinks.link({ principalId: "UANN", canonicalId: ANN, evidence: "test: slack id", linkedBy: ANN });
  const ann = fromDm(control, ANN);
  assert.match(await fromDm(control, ANN)("agents", { action: "list" }), /Ada \(@ada\).*Owners: Ann\./);
  assert.match(
    await inChannel(control, ANN)("guidance", { action: "replace", scope: "conversation", content: "alias owner" }),
    /Updated your standing instructions/,
  );
  assert.match(await ann("agents", { action: "edit", agent: "ada", removeOwners: ["Ann"] }), /no active owner/);
  assert.match(await asSlack("agents", { action: "edit", agent: "ada", removeOwners: [ANN] }), /no active owner/);
  assert.match(await ann("agents", { action: "edit", agent: "ada", addOwners: ["Bob"] }), /Owners: Ann, Bob\./);
  await built.identity.deactivate(BOB);
  assert.match(await ann("agents", { action: "edit", agent: "ada", removeOwners: ["Ann"] }), /no active owner/);
  await built.identity.reactivate(BOB);
  assert.match(await asSlack("agents", { action: "edit", agent: "ada", removeOwners: ["Ann"] }), /Owners: Bob\./);
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
      /belongs to Ada, who has no active owner\. Only an org admin/,
    );
    assert.match(await fromDm(control, CY)("agents", { action: "list" }), /Ada \(@ada\).*No active owner\./);
    assert.match(await fromDm(control, DAN)("agents", { action: "list" }), /^No agents\.$/);
    const admin = fromDm(control, ADMIN);
    assert.match(
      await admin("agents", { action: "edit", agent: "ada", title: "Hijacked" }),
      /^\[error\] only Ada's active owners/,
    );
    assert.match(
      await admin("agents", { action: "edit", agent: "ada", addOwners: ["Cy"] }),
      /^Updated Ada.*Owners: Ann, Bob, Cy\./,
    );
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
      if (reply && "text" in reply) return String(reply.text);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("no reply");
  };
  assert.match(
    await say(CY, "1.1", "!set_standing_order be rude"),
    /couldn't set standing order\] #design belongs to Ada/,
  );
  assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders ?? "", "");
  assert.match(await say(ANN, "2.2", "!set_standing_order be kind"), /standing order set/);
  assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders, "be kind");
});

test("list never shows a private channel's agent to a non-member", async () => {
  const { control } = await setup();
  await createAda(control);
  assert.match(
    await fromDm(control, ANN)("agents", {
      action: "create",
      ...ADA,
      channel: "open",
      handle: "opie",
      displayName: "Opie",
    }),
    /^Created/,
  );
  const dan = await fromDm(control, DAN)("agents", { action: "list" });
  assert.match(dan, /Opie/);
  assert.doesNotMatch(dan, /Ada/);
  const cy = await fromDm(control, CY)("agents", { action: "list" });
  assert.match(cy, /Ada/);
  assert.match(cy, /Opie/);
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

  assert.match(
    await fromDm(control, ANN, false)("agents", { action: "list" }),
    /^\[error\] named agents are managed only by a person/,
  );
  assert.match(
    await toolsFor(control, { actorId: ANN, scopeId: DESIGN_SCOPE, liveActor: true })("agents", { action: "list" }),
    /^\[error\] named agents are managed only by a person/,
  );
  assert.match(
    await fromDm(control, BOB)("agents", { action: "list" }),
    /^\[error\] named agents are managed only by a person/,
  );
});

test("a bound channel's prompt names the agent and its owners; other channels and orphans keep the plain prompt", async () => {
  const { built, control } = await setup();
  await built.config.setSoul(DESIGN_SCOPE, "Critique kindly.");
  await built.config.setSoul(scopeId("channel", "C0OPEN"), "Open rules.");
  const prompt = async (conversation: TurnRequest["conversation"]) =>
    (await built.app.turn(turn(ANN, conversation, "!sysprompt"))).reply ?? "";
  const openThread: TurnRequest["conversation"] = { kind: "channel", threadRef: "ch:C0OPEN:1.1", channelRef: "C0OPEN" };
  assert.match(
    await prompt(designThread),
    /## Conversation instructions \(organization instructions take precedence\)\nCritique kindly\./,
  );

  await createAda(control);
  const bound = await prompt(designThread);
  assert.match(
    bound,
    /## Who you are: Ada \(organization instructions take precedence\)\nYou are Ada, Design critic, in #design\. Your owners are Ann and Bob\. Only your owners and org admins can change your instructions or skills\.\n\nCritique kindly\./,
  );
  assert.doesNotMatch(bound, /## Conversation instructions/);
  const again = await prompt({ ...designThread, threadRef: `ch:${DESIGN}:2.2` });
  assert.equal(
    again.match(/## Who you are[^]*?Critique kindly\./)?.[0],
    bound.match(/## Who you are[^]*?Critique kindly\./)?.[0],
  );

  const open = await prompt(openThread);
  assert.match(open, /## Conversation instructions \(organization instructions take precedence\)\nOpen rules\./);
  assert.doesNotMatch(open, /Who you are/);

  await built.identity.deactivate(ANN);
  await built.identity.deactivate(BOB);
  const orphan = await prompt({ ...designThread, threadRef: `ch:${DESIGN}:3.3` });
  assert.doesNotMatch(orphan, /Who you are|Your owners are/);
});
