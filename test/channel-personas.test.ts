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
import { encodeRef, skillRef } from "../src/acl/resource-ref.ts";
import { PersonaLocked } from "../src/personas/channel-personas.ts";
import type { PersonaResult } from "../src/personas/persona-service.ts";

const SECRET = "channel-personas-test-secret".repeat(2);
const ORG = scopeId("org", "default-org");
const DESIGN = "C0DESIGN";
const DESIGN_SCOPE = scopeId("channel", DESIGN);
const ANN = "ann@example.com";
const BOB = "bob@example.com";
const CY = "cy@example.com";
const DAN = "dan@example.com";
const ADMIN = "admin-alice";
const ADMIN_HEADER = { "x-admin-actor": "admin-alice@default-org" };
const personal = (id: string) => scopeId("personal", id);
const live = { liveActor: true };

function ok<T>(result: PersonaResult<T>): T {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return (result as { value: T }).value;
}

async function setup(opts: { orgFlag?: boolean } = {}) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "channel-personas-")),
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
      { channelId: "C0CRIT", name: "design-crit", isPrivate: false },
    ],
    [ANN, BOB, CY]
      .map((principalId) => ({ channelId: DESIGN, principalId }))
      .concat([ANN, BOB, CY, DAN].map((principalId) => ({ channelId: "C0OPEN", principalId })))
      .concat([{ channelId: "C0CRIT", principalId: DAN }]),
  );
  if (opts.orgFlag !== false) await built.featureFlags.setEnabled("personas", ORG, true, ADMIN);
  else
    for (const who of [ANN, BOB, CY, DAN]) await built.featureFlags.setEnabled("personas", personal(who), true, ADMIN);
  const personas = built.app.personas!;
  const channels = built.app.channelPersonas!;
  const control = createControlService(built.app, built.scheduler, built.admin);
  const ada = ok(await personas.create(ANN, { name: "Ada", icon: { kind: "emoji", value: "🎨" } }));
  ok(
    await personas.setAccess(ANN, ada.id, [
      { scopeId: personal(ANN), role: "owner" },
      { scopeId: personal(BOB), role: "write" },
    ]),
  );
  const wear = async (channel = "design", personaId: string | null = ada.id, actor = ANN) =>
    channels.set({ id: actor, live: true }, channel, personaId);
  return { built, personas, channels, control, ada, wear };
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

const inChannel = (control: ControlService, actorId: string) =>
  toolsFor(control, { actorId, scopeId: DESIGN_SCOPE, liveActor: true });

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
  return (await built.auditLog.events()).filter((e) => e.action === "persona_lock_refused");
}

const turn = (actor: string, conversation: TurnRequest["conversation"], text: string): TurnRequest => ({
  surface: "slack",
  actor: { externalId: actor },
  conversation,
  text,
  origin: { kind: "human" },
});
const thread = (channel: string, root: string): TurnRequest["conversation"] => ({
  kind: "channel",
  threadRef: `ch:${channel}:${root}`,
  channelRef: channel,
});

test("a channel's persona needs personas on org-wide, an owner who is in the channel, and a live turn; the channel is told", async () => {
  const flagged = await setup({ orgFlag: false });
  assert.equal((await flagged.wear()).status, "disabled");

  const { built, channels, ada, wear } = await setup();
  for (const channel of ["design", DESIGN]) {
    const hidden = await wear(channel, ada.id, DAN);
    assert.equal(hidden.status, "not_found");
    assert.doesNotMatch(JSON.stringify(hidden), /#design"|Ada/);
  }
  const ambiguous = await wear("des", ada.id, DAN);
  assert.equal(ambiguous.status, "invalid");
  assert.match(JSON.stringify(ambiguous), /#design-crit/);
  assert.doesNotMatch(JSON.stringify(ambiguous).replaceAll("#design-crit", ""), /#design/);
  assert.equal((await wear("design", ada.id, BOB)).status, "forbidden");
  assert.equal((await wear("open", ada.id, DAN)).status, "not_found");
  assert.equal((await channels.set({ id: ANN, live: false }, "design", ada.id)).status, "forbidden");
  assert.equal(await channels.current(DESIGN_SCOPE), undefined);

  const worn = ok(await wear());
  assert.deepEqual([worn.channelId, worn.persona?.name], [DESIGN, "Ada"]);
  assert.equal((await channels.current(DESIGN_SCOPE))?.id, ada.id);
  const notices = (await built.deliveries.pending("slack")).filter((d) => d.destination.target === DESIGN);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /now wears the persona Ada/);
  assert.ok((await built.auditLog.events()).some((e) => e.action === "persona_channel_default_set"));

  const { call, close } = serve(built);
  try {
    const seen = await call("GET", "/v1/channels/design/persona?principalId=" + encodeURIComponent(CY));
    assert.equal(seen.status, 200);
    assert.equal(((await seen.json()) as { channel: { persona: { name: string } } }).channel.persona.name, "Ada");
    const hidden = await call("GET", `/v1/channels/${DESIGN}/persona?principalId=${encodeURIComponent(DAN)}`);
    assert.equal(hidden.status, 404);
    assert.doesNotMatch(await hidden.text(), /Ada/);
    const open = await call("PUT", "/v1/channels/open/persona", { principalId: ANN, personaId: ada.id });
    assert.equal(open.status, 200, await open.text());
    assert.equal((await channels.current(scopeId("channel", "C0OPEN")))?.name, "Ada");
  } finally {
    await close();
  }
});

test("every conversation in the channel wears its persona, for every sender; a session can't pick another there", async () => {
  const { built, personas, ada, wear } = await setup();
  const prompt = async (actor: string, conversation: TurnRequest["conversation"]) => {
    const result = await built.app.turn(turn(actor, conversation, "!sysprompt"));
    return { reply: result.reply ?? "", sessionId: result.sessionId! };
  };
  assert.doesNotMatch((await prompt(CY, thread(DESIGN, "0.0"))).reply, /## Persona/);
  ok(await wear());
  const worn = await prompt(CY, thread(DESIGN, "1.1"));
  assert.match(worn.reply, /## Persona: Ada/);
  assert.match(worn.reply, /This channel wears "Ada" for every conversation in it/);
  assert.doesNotMatch((await prompt(CY, thread("C0OPEN", "1.1"))).reply, /## Persona/);

  const bea = ok(await personas.create(CY, { name: "Bea" }));
  const session = { id: worn.sessionId, scopeId: DESIGN_SCOPE };
  assert.equal((await personas.assign(CY, session, bea.id)).status, "invalid");
  assert.equal((await personas.assign(CY, session, null)).status, "invalid");
  assert.equal((await personas.assign(ANN, session, ada.id)).status, "ok");

  await built.featureFlags.setEnabled("personas", ORG, false, ADMIN);
  await built.featureFlags.setEnabled("personas", personal(CY), true, ADMIN);
  assert.doesNotMatch((await prompt(CY, thread(DESIGN, "2.2"))).reply, /This channel wears/);
});

test("the guidance tool, POST /v1/soul and the policy route are locked to the persona's writers, owners and org admins", async () => {
  const { built, control, wear } = await setup();
  ok(await wear());
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
  assert.doesNotMatch(await inChannel(control, BOB)("guidance", { ...replace, content: "be kind" }), /^\[error\]/);
  assert.equal(built.config.getSoul(DESIGN_SCOPE), "be kind");
  assert.equal(built.config.soulHistory(DESIGN_SCOPE)[0]?.updatedBy, BOB);

  const { call, close } = serve(built);
  try {
    const denied = await call("POST", "/v1/soul", { scopeId: DESIGN_SCOPE, content: "be rude", actorId: CY });
    assert.equal(denied.status, 403);
    const body = (await denied.json()) as { error: string; message: string };
    assert.equal(body.error, "persona_locked");
    assert.match(body.message, /#design wears the persona Ada.*ask Ann/);
    const allowed = await call("POST", "/v1/soul", { scopeId: DESIGN_SCOPE, content: "be fair", actorId: ANN });
    assert.equal(allowed.status, 200, await allowed.text());
    assert.equal(built.config.getSoul(DESIGN_SCOPE), "be fair");
    await built.app.channelPersonas!.assertMayInstruct(DESIGN_SCOPE, { id: ADMIN, live: true });
    await assert.rejects(
      built.app.channelPersonas!.assertMayInstruct(DESIGN_SCOPE, { id: ADMIN, live: false }),
      PersonaLocked,
    );
    await assert.rejects(
      built.app.channelPersonas!.assertMayInstruct(DESIGN_SCOPE, { id: ANN, live: false }),
      (e: Error) => e instanceof PersonaLocked && /sent themselves, never from an automation/.test(e.message),
    );

    const policy = (principalId: string) =>
      call("PUT", "/v1/contexts/policy", { principalId, scope: DESIGN_SCOPE, orders: `orders from ${principalId}` });
    assert.equal((await policy(CY)).status, 403);
    assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders ?? "", "");
    assert.equal((await policy(BOB)).status, 200);
    assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders, `orders from ${BOB}`);
    const cached = (setBy?: string) =>
      call("POST", "/v1/surface-cache/policy", { container: DESIGN, orders: "cached", ...(setBy ? { setBy } : {}) });
    assert.equal((await cached()).status, 403);
    assert.equal((await cached(CY)).status, 403);
    assert.equal((await cached(BOB)).status, 200);

    const console = await call("PUT", `/v1/admin/scopes/${DESIGN_SCOPE}/soul`, { content: "console" }, ADMIN_HEADER);
    assert.equal(console.status, 200, await console.text());
    assert.equal(built.config.getSoul(DESIGN_SCOPE), "console");
  } finally {
    await close();
  }
});

test("every skill mutation that reaches the channel, through its home, a grant or a dormant grant, takes a writer", async () => {
  const OPEN = scopeId("channel", "C0OPEN");
  type Shape = {
    home: string;
    shares: string[];
    parkIn?: string;
    unshare: [string, string];
    moveOut?: string;
    moveIn?: string;
  };
  const shapes: Record<string, Shape> = {
    home: { home: DESIGN_SCOPE, shares: [OPEN], unshare: [DESIGN_SCOPE, OPEN], moveOut: personal(CY) },
    shared: { home: personal(CY), shares: [DESIGN_SCOPE], unshare: [personal(CY), DESIGN_SCOPE], moveOut: OPEN },
    dormant: {
      home: personal(CY),
      shares: [DESIGN_SCOPE],
      parkIn: OPEN,
      unshare: [personal(CY), DESIGN_SCOPE],
      moveIn: personal(CY),
    },
    unreached: {
      home: personal(CY),
      shares: [OPEN],
      unshare: [personal(CY), OPEN],
      moveOut: OPEN,
      moveIn: DESIGN_SCOPE,
    },
  };
  const expected: Record<string, Record<string, "locked" | "open">> = {
    home: {
      create: "locked",
      edit: "locked",
      archive: "locked",
      restore: "locked",
      recreate: "locked",
      shareOut: "locked",
      unshare: "locked",
      moveOut: "locked",
    },
    shared: {
      edit: "locked",
      archive: "locked",
      restore: "locked",
      recreate: "locked",
      shareOut: "locked",
      unshare: "locked",
      moveOut: "locked",
    },
    dormant: {
      create: "open",
      edit: "open",
      archive: "open",
      restore: "open",
      recreate: "open",
      shareIn: "locked",
      shareOut: "open",
      unshare: "locked",
      moveIn: "locked",
    },
    unreached: {
      create: "open",
      edit: "open",
      archive: "open",
      restore: "open",
      recreate: "open",
      shareIn: "locked",
      shareOut: "open",
      unshare: "open",
      moveOut: "open",
      moveIn: "locked",
    },
  };

  for (const cyWrites of [false, true]) {
    const { built, personas, ada, wear } = await setup();
    const { app } = built;
    const grant = (owner: string, id: string, grantee: string) =>
      app.grant(
        {
          ownerScopeId: owner,
          ref: encodeRef(skillRef(id)),
          granteeScopeId: grantee,
          permission: "read",
          grantedBy: CY,
        },
        live,
      );
    const move = (id: string, to: string) => app.moveArtifactHome("skill", id, to, CY, live);
    const skillOf = async (id: string) => (await app.getSkill(id))!;
    const create = async (id: string, suffix: string) => {
      const { scopeId: homeScope, manifest } = await skillOf(id);
      assert.ok(
        await app.createOwnedSkill({
          principalId: CY,
          homeScope,
          name: manifest.name + suffix,
          description: "d",
          body: "b",
          liveActor: true,
        }),
      );
    };
    const mutations: Record<string, (id: string, shape: Shape) => Promise<unknown>> = {
      create: (id) => create(id, "-sibling"),
      edit: async (id) => assert.ok(await app.updateOwnedSkill(id, CY, { body: "changed" }, live)),
      archive: async (id) =>
        assert.equal(await app.deleteOwnedSkill({ principalId: CY, id, liveActor: true }), "deleted"),
      restore: async (id) => assert.ok(await app.restoreOwnedSkill(id, CY, live)),
      recreate: (id) => create(id, ""),
      shareIn: async (id) => grant((await skillOf(id)).scopeId, id, DESIGN_SCOPE),
      shareOut: async (id) => grant((await skillOf(id)).scopeId, id, personal(DAN)),
      unshare: (id, shape) => app.revokeGrant(shape.unshare[0], encodeRef(skillRef(id)), shape.unshare[1], CY, live),
      moveOut: (id, shape) => move(id, shape.moveOut!),
      moveIn: (id, shape) => move(id, shape.moveIn!),
    };

    const cases: Array<{ label: string; id: string; shape: Shape; mutation: string; outcome: string }> = [];
    for (const [shapeName, row] of Object.entries(expected)) {
      const shape = shapes[shapeName]!;
      for (const [mutation, outcome] of Object.entries(row)) {
        const skill = await app.createOwnedSkill({
          principalId: CY,
          homeScope: shape.home,
          name: (shapeName + "-" + mutation).toLowerCase(),
          description: "d",
          body: "b",
          liveActor: true,
        });
        assert.ok(skill);
        for (const to of shape.shares) await grant(shape.home, skill.id, to);
        if (shape.parkIn) await move(skill.id, shape.parkIn);
        if (mutation === "restore" || mutation === "recreate") await mutations.archive!(skill.id, shape);
        cases.push({ label: shapeName + " " + mutation, id: skill.id, shape, mutation, outcome });
      }
    }
    if (cyWrites)
      ok(
        await personas.setAccess(ANN, ada.id, [
          { scopeId: personal(ANN), role: "owner" },
          { scopeId: personal(CY), role: "write" },
        ]),
      );
    ok(await wear());

    const state = async (id: string) => ({
      skills: (await app.listSkills()).map((s) => [s.id, s.scopeId, s.status, s.version]),
      grants: await Promise.all(
        [DESIGN_SCOPE, OPEN, personal(CY)].map((owner) => built.acl.grantsFor(owner, encodeRef(skillRef(id)))),
      ),
    });
    for (const c of cases) {
      const act = () => mutations[c.mutation]!(c.id, c.shape);
      if (c.outcome === "open" || cyWrites) {
        await act();
        continue;
      }
      const before = await state(c.id);
      await assert.rejects(act, PersonaLocked, c.label);
      assert.deepEqual(await state(c.id), before, c.label);
    }
  }
});

test("a channel's own grant on the persona never unlocks the channel, and a refusal names nothing private to an outsider", async () => {
  const { built, personas, control, ada, wear } = await setup();
  assert.ok(
    await built.app.upsertChannels(
      [{ channelId: "C0SIDE", name: "side", isPrivate: true }],
      [CY, DAN].map((principalId) => ({ channelId: "C0SIDE", principalId })),
      Date.now(),
      undefined,
      undefined,
      true,
    ),
  );
  const skill = await built.app.createOwnedSkill({
    principalId: CY,
    homeScope: scopeId("channel", "C0SIDE"),
    name: "side-notes",
    description: "notes",
    body: "take notes",
    liveActor: true,
  });
  assert.ok(skill);
  const shared = await control.shareArtifact(
    { type: "skill", id: skill.id, scope: DESIGN_SCOPE },
    { actorId: CY, scopeId: personal(CY), liveActor: true, exp: Date.now() + CAPABILITY_TTL_MS },
  );
  assert.equal(shared.ok, true);
  ok(
    await personas.setAccess(ANN, ada.id, [
      { scopeId: personal(ANN), role: "owner" },
      { scopeId: DESIGN_SCOPE, role: "write" },
    ]),
  );
  ok(await wear());
  const editAs = (principalId: string) =>
    built.app.updateOwnedSkill(skill.id, principalId, { body: "changed" }, { liveActor: true });
  await assert.rejects(editAs(CY), (e: Error) => e instanceof PersonaLocked && e.message.includes("#design"));
  await assert.rejects(editAs(DAN), (e: Error) => e instanceof PersonaLocked && !/design|Ada|Ann/.test(e.message));
  assert.equal((await built.app.getSkill(skill.id))?.manifest.body, "take notes");
});

test("changing or clearing the channel's persona takes the lock, and a deleted persona stops applying", async () => {
  const { built, personas, control, wear } = await setup();
  ok(await wear());
  const bea = ok(await personas.create(CY, { name: "Bea" }));
  assert.equal((await wear("design", bea.id, CY)).status, "forbidden");
  assert.equal((await wear("design", null, CY)).status, "forbidden");
  assert.equal((await wear("design", null, BOB)).status, "ok");
  assert.equal(await built.app.channelPersonas!.current(DESIGN_SCOPE), undefined);
  assert.ok(
    (await built.deliveries.pending("slack")).some((d) => /no longer wears the persona Ada/.test(d.text ?? "")),
  );
  ok(await wear("open"));
  assert.equal((await wear("open", null, ADMIN)).status, "ok");
  assert.equal((await wear("design", bea.id, CY)).status, "ok");
  assert.equal((await built.app.channelPersonas!.current(DESIGN_SCOPE))?.name, "Bea");

  ok(await personas.remove(CY, bea.id));
  assert.equal(await built.app.channelPersonas!.current(DESIGN_SCOPE), undefined);
  await inChannel(control, CY)("guidance", { action: "replace", scope: "conversation", content: "member edit" });
  assert.equal(built.config.getSoul(DESIGN_SCOPE), "member edit");
});

test("a persona access change that would leave no active owner is refused", async () => {
  const { built, personas, ada } = await setup();
  await built.identity.deactivate(DAN);
  const access = (owner: string) => [
    { scopeId: personal(owner), role: "owner" as const },
    { scopeId: personal(BOB), role: "write" as const },
  ];
  assert.equal((await personas.setAccess(ANN, ada.id, access(DAN))).status, "invalid");
  assert.equal((await personas.setAccess(ANN, ada.id, access(ANN))).status, "ok");
});

test("standing orders set from a channel turn are locked to the persona's writers", async () => {
  const { built, wear } = await setup();
  ok(await wear());
  built.runtime.start();
  const say = async (actor: string, root: string, text: string) => {
    await built.app.turn({
      ...turn(
        actor,
        {
          ...thread(DESIGN, root),
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
  await say(BOB, "2.2", "!set_standing_order be kind");
  assert.equal((await built.app.getChannelPolicy(DESIGN))?.orders, "be kind");
});
