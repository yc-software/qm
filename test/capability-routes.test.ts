import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "route-test-secret".repeat(3);

describe("capability-token control plane (crons + webhooks + SOUL)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = async (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scope,
        destination: { type: "slack", target: `D-${actorId}`, audienceScopeId: scope },
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...extra,
      },
      SECRET,
    );

  const THREAD = {
    key: "k-thread",
    type: "slack",
    target: "C:111",
    audienceScopeId: scopeId("channel", "C"),
    label: "this thread",
  } as const;
  const ROOT = {
    key: "k-root",
    type: "slack",
    target: "C",
    audienceScopeId: scopeId("channel", "C"),
    label: "#eng (the whole channel)",
  } as const;
  const MEMBERS = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const capChannel = async (actorId: string, withMembers = false) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("channel", "C"),
        destination: withMembers
          ? { type: ROOT.type, target: ROOT.target, audienceScopeId: ROOT.audienceScopeId }
          : { type: THREAD.type, target: THREAD.target, audienceScopeId: THREAD.audienceScopeId },
        destinations: [THREAD, ROOT],
        defaultDestinationKey: withMembers ? ROOT.key : THREAD.key,
        ...(withMembers ? { members: MEMBERS } : {}),
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "cap-routes-")),
        signingSecret: SECRET,
      }),
    );
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: false }],
      ["admin-alice", "U1", "U2", "U8"].map((principalId) => ({ channelId: "C", principalId })),
    );
    server = createServer(built.app, {
      signingSecret: SECRET,
      scheduler: built.scheduler,
      config: built.config,
      admin: built.admin,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  type Headers = Record<string, string>;
  const send = (method: string, path: string, headers: Headers, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (path: string, body: unknown, headers: Headers = {}) => send("POST", path, headers, body);
  const get = (path: string, headers: Headers = {}) => send("GET", path, headers);
  const patch = (path: string, body: unknown, headers: Headers = {}) => send("PATCH", path, headers, body);
  const del = (path: string, headers: Headers = {}) => send("DELETE", path, headers);
  const json = async (res: Promise<Response> | Response) => (await (await res).json()) as any;
  const auth = async (
    actorId: string,
    scope = scopeId("personal", actorId),
    extra: Partial<CapabilityClaims> = {},
  ) => ({
    "x-agent-capability": await capFor(actorId, scope, extra),
  });
  const live = (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
    auth(actorId, scope, { liveActor: true, ...extra });
  const inChannel = async (actorId: string) => ({ "x-agent-capability": await capChannel(actorId) });
  const withMembers = async (actorId: string) => ({ "x-agent-capability": await capChannel(actorId, true) });
  const noDestination = async () => ({
    "x-agent-capability": await mintCapabilityToken(
      { actorId: "U9", scopeId: "personal:U9", exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    ),
  });
  const createCron = async (headers: Headers, body: Record<string, unknown> = {}) =>
    (await json(post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "x", ...body }, headers))).cron;
  const statusOf = async (res: Promise<Response>) => (await res).status;

  it("enforces unattended grant creation and privileged-cron tamper rules at the HTTP boundary", async () => {
    const body = {
      schedule: { everyMs: 60_000 },
      action: "scan transcripts",
      unattendedGrants: ["admin.sessions.read"],
    };
    const soleAdmin = { members: [{ id: "admin-alice", type: "internal" as const }] };
    assert.equal(await statusOf(post("/v1/crons", body, await auth("admin-alice"))), 403);
    assert.equal(await statusOf(post("/v1/crons", body, await live("U1"))), 403);
    assert.equal(
      await statusOf(post("/v1/crons", { ...body, unattendedGrants: ["admin.everything"] }, await live("admin-alice"))),
      400,
    );
    for (const runAs of ["scopeFloor", "scopeShared"]) {
      assert.equal(
        await statusOf(
          post("/v1/crons", { ...body, runAs }, await live("admin-alice", scopeId("channel", "C"), soleAdmin)),
        ),
        400,
      );
    }
    const create = await post("/v1/crons", body, await live("admin-alice"));
    assert.equal(create.status, 200);
    const { cron } = (await create.json()) as { cron: { id: string; unattendedGrants?: string[] } };
    assert.deepEqual(cron.unattendedGrants, ["admin.sessions.read"]);
    assert.deepEqual((await json(get(`/v1/crons/${cron.id}`, await live("admin-alice")))).cron.unattendedGrants, [
      "admin.sessions.read",
    ]);
    const listed = (await json(get("/v1/crons", await live("admin-alice")))) as {
      crons: Array<{ id: string; unattendedGrants?: string[] }>;
    };
    assert.deepEqual(listed.crons.find((candidate) => candidate.id === cron.id)?.unattendedGrants, [
      "admin.sessions.read",
    ]);
    assert.equal(await statusOf(patch(`/v1/crons/${cron.id}`, { action: "tamper" }, await auth("admin-alice"))), 403);
    assert.equal(await statusOf(patch(`/v1/crons/${cron.id}`, { unattendedGrants: [] }, await live("admin-bob"))), 403);
    assert.equal(
      await statusOf(
        post(`/v1/crons/${cron.id}/note`, { note: "steer the next privileged fire" }, await auth("admin-alice")),
      ),
      403,
      "an unattended non-fire session cannot note a privileged cron over HTTP either",
    );
    assert.equal(
      await statusOf(
        post(
          `/v1/crons/${cron.id}/note`,
          { note: "scan clean, nothing carried over" },
          await auth("admin-alice", scopeId("personal", "admin-alice"), { threadRef: `cron:${cron.id}:fire:abc` }),
        ),
      ),
      200,
      "the cron's own fire leaves its shift-change note over the agent API",
    );
  });

  it("creates a cron as the TOKEN's actor, ignoring a forged owner in the body", async () => {
    const res = await post(
      "/v1/crons",
      {
        schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" },
        action: "send the daily digest",
        owner: "U2",
        createdBy: "U2",
        ownerScopeId: "personal:U2",
        destination: { type: "evil", target: "attacker" },
      },
      await auth("U1"),
    );
    assert.equal(res.status, 200);
    const { cron } = (await res.json()) as any;
    assert.equal(cron.owner, "U1");
    assert.equal(cron.createdBy, "U1");
    assert.equal(cron.ownerScopeId, "personal:U1");
    assert.equal(cron.destination.type, "slack");
    assert.equal(cron.destination.target, "D-U1");
    assert.equal(cron.action, "send the daily digest");
    assert.equal(cron.schedule.cron, "0 9 * * *");
  });

  it("accepts a brief title for agent-created crons and preserves title patches", async () => {
    const cron = await createCron(await auth("U1"), { title: "Gmail digest", action: "orig" });
    assert.equal(cron.title, "Gmail digest");
    const patched = await json(patch(`/v1/crons/${cron.id}`, { title: "GitLab related work" }, await auth("U1")));
    assert.equal(patched.cron.title, "GitLab related work");
    const archived = await json(patch(`/v1/crons/${cron.id}`, { archived: true }, await auth("U1")));
    assert.equal(archived.cron.archived, true);
    assert.equal(archived.cron.enabled, false);
    await del(`/v1/crons/${cron.id}`, await auth("U1"));
  });

  it("accepts calendar cron schedules and defaults timezone from the capability", async () => {
    const withTz = await post(
      "/v1/crons",
      { title: "Market open", schedule: { cron: "0 9 * * 1-5" }, action: "daily market brief" },
      await auth("U1", undefined, { timezone: "America/New_York" }),
    );
    assert.equal(withTz.status, 200);
    const created = (await withTz.json()) as any;
    assert.equal(created.cron.schedule.cron, "0 9 * * 1-5");
    assert.equal(created.cron.schedule.timezone, "America/New_York");
    assert.equal(typeof created.cron.nextFireAt, "number");

    const fallback = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * 1-5" }, action: "daily brief" },
      await auth("U1"),
    );
    assert.equal(fallback.status, 200);
    assert.equal(((await fallback.json()) as any).cron.schedule.timezone, "America/Los_Angeles");
  });

  it("rejects a past one-shot and mixed calendar/legacy schedule fields under a capability", async () => {
    const late = await post(
      "/v1/crons",
      { schedule: { firstFireAt: Date.now() - 60 * 60 * 1000 }, action: "late" },
      await auth("U1"),
    );
    assert.equal(late.status, 400);
    assert.match(((await late.json()) as any).message, /in the past/);

    const create = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * *", everyMs: 60_000 }, action: "mixed" },
      await auth("U1"),
    );
    assert.equal(create.status, 400);
    assert.equal(((await create.json()) as any).error, "bad_request");
    const cron = await createCron(await auth("U1"), { action: "orig" });
    const patchRes = await patch(
      `/v1/crons/${cron.id}`,
      { schedule: { cron: "0 9 * * *", firstFireAt: 1 } },
      await auth("U1"),
    );
    assert.equal(patchRes.status, 400);
    assert.equal(((await patchRes.json()) as any).error, "bad_request");
  });

  it("creates a destination-less cron or webhook when the token carries no destination", async () => {
    const cronRes = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "nightly workspace cleanup" },
      await noDestination(),
    );
    assert.equal(cronRes.status, 200);
    const { cron } = (await cronRes.json()) as any;
    assert.equal(cron.owner, "U9");
    assert.equal(cron.destination, undefined);

    const hookRes = await post(
      "/v1/webhooks",
      { action: "mirror the event to a file", verification: { scheme: "hmac-sha256", secret: "side-effect-secret" } },
      await noDestination(),
    );
    assert.equal(hookRes.status, 200);
    const { webhook } = (await hookRes.json()) as any;
    assert.equal(webhook.owner, "U9");
    assert.equal(webhook.destination, undefined);
  });

  it("lists only the caller's own crons under a capability", async () => {
    await createCron(await auth("U2"), { action: "u2 task" });
    const mine = await json(get("/v1/crons", await auth("U1")));
    assert.ok(mine.crons.length >= 1);
    assert.ok(
      mine.crons.every((c: any) => c.owner === "U1"),
      "a capability must not see other users' crons",
    );
  });

  it("updates only the caller's OWN personal SOUL, ignoring body scope/actor", async () => {
    const orgVerBefore = built.config.soulVersion(scopeId("org", "default-org"));
    const res = await post(
      "/v1/soul",
      { content: "Always answer in bullet points.", scopeId: "org:default-org", actorId: "U2" },
      await auth("U1"),
    );
    assert.equal(res.status, 200);
    assert.ok(built.config.soulVersion(scopeId("personal", "U1")) >= 1, "U1's personal SOUL was updated");
    assert.equal(built.config.soulVersion(scopeId("org", "default-org")), orgVerBefore, "org SOUL floor untouched");
  });

  it("updates the token's shared-scope SOUL without touching the actor's personal SOUL", async () => {
    const personalScope = scopeId("personal", "U8");
    const channelScope = scopeId("channel", "C");
    const personalBefore = built.config.soulVersion(personalScope);
    const res = await post(
      "/v1/soul",
      { content: "Channel C speaks in haiku.", scopeId: personalScope, actorId: "U2" },
      await inChannel("U8"),
    );
    assert.equal(res.status, 200);
    assert.equal(built.config.getSoul(channelScope), "Channel C speaks in haiku.");
    assert.ok(built.config.soulVersion(channelScope) >= 1, "channel SOUL was updated");
    assert.equal(built.config.soulVersion(personalScope), personalBefore, "actor's personal SOUL was not touched");
  });

  it("does not let capability self-update org or team SOUL", async () => {
    const orgScope = scopeId("org", "default-org");
    const teamScope = scopeId("team", "T");
    const orgBefore = built.config.soulVersion(orgScope);
    assert.equal(await statusOf(post("/v1/soul", { content: "replace org" }, await auth("U1", orgScope))), 403);
    assert.equal(await statusOf(post("/v1/soul", { content: "replace team" }, await auth("U1", teamScope))), 403);
    assert.equal(built.config.soulVersion(orgScope), orgBefore);
    assert.equal(built.config.getSoul(teamScope), null);
  });

  it("reads the caller's in-scope SOUL under a capability", async () => {
    const personalScope = scopeId("personal", "U7");
    built.config.setSoul(personalScope, "Prefer precise, compact answers.");
    const res = await get("/v1/soul?scopeId=personal:U2", await auth("U7"));
    assert.equal(res.status, 200);
    const got = (await res.json()) as any;
    assert.equal(got.scopeId, personalScope, "query scope is ignored; the token's signed scope wins");
    assert.equal(got.soul, "Prefer precise, compact answers.");
    assert.ok(got.soulVersion >= 1);
    assert.equal(got.orgScopeId, scopeId("org", "default-org"));
    assert.equal(typeof got.orgSoul, "string");
    assert.ok(got.effectiveSoul.includes("Prefer precise, compact answers."));
    assert.ok(got.effectiveSoul.includes(got.orgSoul));
  });

  it("reads channel SOUL for a channel-scoped token without exposing the actor's personal SOUL", async () => {
    built.config.setSoul(scopeId("personal", "U8"), "Private U8 instruction.");
    built.config.setSoul(scopeId("channel", "C"), "Channel C instruction.");
    const res = await get("/v1/soul?scopeId=personal:U8", await inChannel("U8"));
    assert.equal(res.status, 200);
    const got = (await res.json()) as any;
    assert.equal(got.scopeId, scopeId("channel", "C"));
    assert.equal(got.soul, "Channel C instruction.");
    assert.ok(got.effectiveSoul.includes("Channel C instruction."));
    assert.equal(got.effectiveSoul.includes("Private U8 instruction."), false);
  });

  it("rejects an invalid/expired token with 401", async () => {
    const expired = await mintCapabilityToken({ actorId: "U1", scopeId: "personal:U1", exp: Date.now() - 1 }, SECRET);
    for (const token of ["garbage", expired]) {
      assert.equal(
        await statusOf(
          post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "x" }, { "x-agent-capability": token }),
        ),
        401,
      );
    }
  });

  it("refuses a capability token on a non-self-service route (e.g. /v1/turns) with 403", async () => {
    const res = await post(
      "/v1/turns",
      { surface: "x", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef: "t" }, text: "hi" },
      await auth("U1"),
    );
    assert.equal(res.status, 403);
  });

  it("refuses a capability token minted for another audience on a self-service route", async () => {
    const res = await get(
      "/v1/keychain/overview",
      await auth("U1", scopeId("personal", "U1"), { aud: "some-other-surface" }),
    );
    assert.equal(res.status, 403);
    assert.match(await res.text(), /audience not valid/);
    assert.notEqual(await statusOf(get("/v1/keychain/overview", await auth("U1"))), 403);
  });

  it("Strict capabilities can observe but cannot directly mutate the control plane", async () => {
    const scope = scopeId("personal", "U-strict");
    await built.config.setSecurityPosture(scope, "strict");
    const headers = await auth("U-strict", scope);
    assert.equal(await statusOf(get("/v1/crons", headers)), 200);
    const create = await post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "must not run" }, headers);
    assert.equal(create.status, 403);
    assert.match(((await create.json()) as { message: string }).message, /direct control-plane mutations/i);
  });

  it("a capability cannot cancel another user's cron", async () => {
    const cron = await createCron(await auth("U1"), { action: "u1 owned" });
    assert.equal(await statusOf(post(`/v1/crons/${cron.id}/disable`, {}, await auth("U2"))), 403);
  });

  it("creates a channel-token cron at the chosen or default destination; a forged body destination is ignored", async () => {
    const root = await createCron(await inChannel("U1"), { action: "channel digest", destinationKey: "k-root" });
    assert.equal(root.destination.target, "C");
    assert.equal(root.destination.audienceScopeId, "channel:C");
    assert.equal(root.destination.key, undefined);
    assert.equal(root.destination.label, undefined);
    assert.equal((await createCron(await inChannel("U1"), { action: "thread reminder" })).destination.target, "C:111");
    const forged = await createCron(await inChannel("U1"), {
      destinationKey: "k-root",
      destination: { type: "slack", target: "C", audienceScopeId: "personal:U1" },
    });
    assert.equal(forged.destination.audienceScopeId, "channel:C");
  });

  for (const [route, extra] of [
    ["/v1/crons", { schedule: { everyMs: 60_000 } }],
    ["/v1/webhooks", { verification: { scheme: "hmac-sha256", secret: "unknown-destination-secret" } }],
  ] as const) {
    it(`rejects an unknown ${route} destinationKey with 400 (no silent escalation)`, async () => {
      const res = await post(route, { ...extra, action: "x", destinationKey: "k-not-in-set" }, await inChannel("U1"));
      assert.equal(res.status, 400);
      assert.equal(((await res.json()) as any).error, "unknown_destination");
    });
  }

  it("retargets an existing cron to another candidate via POST /v1/crons/:id/destination", async () => {
    const headers = await inChannel("U1");
    const created = await createCron(headers, { action: "move me" });
    assert.equal(created.destination.target, "C:111");
    const res = await post(`/v1/crons/${created.id}/destination`, { destinationKey: "k-root" }, headers);
    assert.equal(res.status, 200);
    const { cron } = (await res.json()) as any;
    assert.equal(cron.destination.target, "C");
    assert.equal(cron.destination.audienceScopeId, "channel:C");
  });

  it("retarget is owner-gated (403), rejects an unknown key (400), and needs a destination authenticated this turn", async () => {
    const cron = await createCron(await inChannel("U1"), { action: "mine" });
    const retarget = async (destinationKey: string, headers: Headers) =>
      await statusOf(post(`/v1/crons/${cron.id}/destination`, { destinationKey }, headers));
    assert.equal(await retarget("k-root", await inChannel("U2")), 403);
    assert.equal(await retarget("nope", await inChannel("U1")), 400);
    const contained = await createCron(await inChannel("U1"), { action: "contained" });
    assert.equal(
      await statusOf(
        post(
          `/v1/crons/${contained.id}/destination`,
          { destinationKey: "k-root" },
          await auth("U1", scopeId("channel", "C")),
        ),
      ),
      400,
    );
  });

  it("gets, patches, runs, and deletes the caller's own cron by id", async () => {
    const { id } = await createCron(await auth("U1"), { action: "orig" });
    const got = await json(get(`/v1/crons/${id}`, await auth("U1")));
    assert.equal(got.cron.id, id);
    assert.equal(got.cron.action, "orig");
    const edit = { action: "edited", schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" } };
    const patched = await json(patch(`/v1/crons/${id}`, edit, await auth("U1")));
    assert.equal(patched.cron.id, id);
    assert.equal(patched.cron.action, "edited");
    assert.equal(patched.cron.schedule.cron, "0 9 * * *");
    const same = await json(patch(`/v1/crons/${id}`, edit, await auth("U1")));
    assert.equal(same.cron.id, id);
    assert.equal(same.cron.action, "edited");
    const list = await json(get("/v1/crons", await auth("U1")));
    assert.equal(list.crons.filter((c: any) => c.id === id).length, 1);
    assert.equal(await statusOf(post(`/v1/crons/${id}/run`, {}, await auth("U1"))), 200);
    assert.equal(await statusOf(del(`/v1/crons/${id}`, await auth("U1"))), 200);
    assert.equal(await statusOf(get(`/v1/crons/${id}`, await auth("U1"))), 404);
  });

  it("the runs endpoint reads the fire table and strips the legacy fireLog from the cron", async () => {
    const { id } = await createCron(await auth("U1"), { action: "count things" });
    await built.crons.recordFire(id, {
      fireKey: "k1",
      threadRef: "t1",
      firedAt: 1_000,
      endedAt: 2_000,
      status: "failed",
      note: "first",
    });
    await built.crons.recordFire(id, {
      fireKey: "k2",
      threadRef: "t2",
      firedAt: 3_000,
      endedAt: 4_000,
      status: "ok",
      reply: "second",
    });
    const res = await get(`/v1/crons/${id}/runs?limit=1`, await auth("U1"));
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.total, 2);
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].fireKey, "k2");
    assert.equal(body.runs[0].reply, "second");
    assert.equal("fireLog" in body.cron, false);
  });

  const assertReadOnly = async (id: string, headers: Headers, hijack: string) => {
    assert.equal(await statusOf(get(`/v1/crons/${id}`, headers)), 200);
    assert.equal(await statusOf(patch(`/v1/crons/${id}`, { action: hijack }, headers)), 403);
    assert.equal(await statusOf(post(`/v1/crons/${id}/run`, {}, headers)), 403);
    assert.equal(await statusOf(del(`/v1/crons/${id}`, headers)), 403);
  };

  it("another public-channel user can read an OWNER cron but cannot patch, run, or delete it", async () => {
    const { id } = await createCron(await inChannel("U1"), { action: "u1 owned" });
    await assertReadOnly(id, await inChannel("U2"), "hijacked");
  });

  it("get of an unknown cron is 404; a bad patch body is 400", async () => {
    assert.equal(await statusOf(get(`/v1/crons/does-not-exist`, await auth("U1"))), 404);
    const { id } = await createCron(await auth("U1"));
    for (const body of [{ nonsense: true }, {}]) {
      const res = await patch(`/v1/crons/${id}`, body, await auth("U1"));
      assert.equal(res.status, 400);
      assert.match(((await res.json()) as any).message, /nothing to change/);
    }
  });

  it("creates a scopeFloor cron when the token carries a member snapshot", async () => {
    const res = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" }, action: "team standup", runAs: "scopeFloor" },
      await withMembers("U1"),
    );
    assert.equal(res.status, 200);
    const { cron } = (await res.json()) as any;
    assert.equal(cron.runAs, "scopeFloor");
    assert.equal(cron.ownerScopeId, "channel:C");
    assert.deepEqual(cron.members.map((m: any) => m.id).sort(), ["U1", "U2"]);
  });

  it("a scopeFloor create with no signed members is rejected (400)", async () => {
    const res = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "team standup", runAs: "scopeFloor" },
      await inChannel("U1"),
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, "members_unavailable");
  });

  it("any member of the scope can edit/disable a scopeFloor cron", async () => {
    const { id } = await createCron(await withMembers("U1"), { action: "team standup", runAs: "scopeFloor" });
    const patched = await patch(`/v1/crons/${id}`, { action: "tweaked by a teammate" }, await withMembers("U2"));
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as any).cron.action, "tweaked by a teammate");
    assert.ok((await json(get("/v1/crons", await withMembers("U2")))).crons.some((c: any) => c.id === id));
    assert.equal(await statusOf(post(`/v1/crons/${id}/disable`, {}, await withMembers("U2"))), 200);
  });

  it("a scopeFloor cron from a different scope is readable by a snapshot member but never administrable (your boss's channel cron stays out of your DM's control)", async () => {
    const { id } = await createCron(await withMembers("U1"), { action: "team standup", runAs: "scopeFloor" });
    await assertReadOnly(id, await auth("U2"), "hijack from my DM");
    const dmList = await json(get("/v1/crons", await auth("U2")));
    assert.ok(!dmList.crons.some((c: any) => c.id === id), "not administered from the DM scope");
    assert.ok(
      dmList.visible.some((c: any) => c.id === id),
      "surfaced read-only in visible",
    );
  });

  it("registers a webhook as the TOKEN's actor, ignoring a forged owner in the body", async () => {
    const res = await post(
      "/v1/webhooks",
      {
        action: "triage the GitHub event",
        verification: { scheme: "github", secret: "gh-secret" },
        owner: "U2",
        createdBy: "U2",
        ownerScopeId: "personal:U2",
        destination: { type: "evil", target: "attacker" },
      },
      await auth("U1"),
    );
    assert.equal(res.status, 200);
    const { webhook, url } = (await res.json()) as any;
    assert.equal(webhook.owner, "U1");
    assert.equal(webhook.createdBy, "U1");
    assert.equal(webhook.ownerScopeId, "personal:U1");
    assert.equal(webhook.action, "triage the GitHub event");
    assert.equal(webhook.verification.scheme, "github");
    assert.equal(webhook.verification.secret, "gh-secret");
    assert.equal(webhook.destination.type, "slack");
    assert.equal(webhook.destination.target, "D-U1");
    assert.equal(url, `/v1/webhooks/incoming/${webhook.id}`);
  });

  it("registers a webhook at a chosen destinationKey; a forged body destination is ignored", async () => {
    const res = await post(
      "/v1/webhooks",
      {
        action: "post deploys to the channel",
        verification: { scheme: "hmac-sha256", secret: "deploy-secret" },
        destinationKey: "k-root",
        destination: { type: "slack", target: "C", audienceScopeId: "personal:U1" },
      },
      await inChannel("U1"),
    );
    assert.equal(res.status, 200);
    const { webhook } = (await res.json()) as any;
    assert.equal(webhook.destination.target, "C");
    assert.equal(webhook.destination.audienceScopeId, "channel:C");
    assert.equal(webhook.destination.key, undefined);
  });

  it("lists only the caller's own webhooks under a capability, with secrets redacted", async () => {
    await post(
      "/v1/webhooks",
      { action: "u2 hook", verification: { scheme: "hmac-sha256", secret: "s2" } },
      await auth("U2"),
    );
    const mine = await json(get("/v1/webhooks", await auth("U1")));
    assert.ok(mine.webhooks.length >= 1);
    assert.ok(
      mine.webhooks.every((w: any) => w.owner === "U1"),
      "a capability must not see other users' webhooks",
    );
    assert.ok(mine.webhooks.every((w: any) => !w.verification.secret || w.verification.secret === "***"));
  });

  it("a capability can disable its OWN webhook but not another user's", async () => {
    const { webhook } = await json(
      post(
        "/v1/webhooks",
        { action: "u1 owned", verification: { scheme: "hmac-sha256", secret: "owned-secret" } },
        await auth("U1"),
      ),
    );
    assert.equal(await statusOf(post(`/v1/webhooks/${webhook.id}/disable`, {}, await auth("U2"))), 403);
    assert.equal(await statusOf(post(`/v1/webhooks/${webhook.id}/disable`, {}, await auth("U1"))), 200);
  });

  it("a public channel remains available to an active internal principal outside its current roster", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: false }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    assert.equal(await statusOf(get("/v1/soul", await inChannel("U8"))), 200);
  });

  it("a live verified bot retains private-channel tools without a Slack user principal", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: true }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    const members = [{ id: "B-LEGACY", type: "internal" as const }];
    const channel = scopeId("channel", "C");
    assert.equal(await statusOf(get("/v1/soul", await live("B-LEGACY", channel, { botActor: true, members }))), 200);
    assert.equal(await statusOf(get("/v1/soul", await auth("B-LEGACY", channel, { members }))), 403);
  });
});
