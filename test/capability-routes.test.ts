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

describe("capability-token control plane (crons + SOUL)", () => {
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
  const capChannel = async (actorId: string) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("channel", "C"),
        destination: { type: THREAD.type, target: THREAD.target, audienceScopeId: THREAD.audienceScopeId },
        destinations: [THREAD, ROOT],
        defaultDestinationKey: THREAD.key,
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
    server = createServer(built.app, { signingSecret: SECRET, scheduler: built.scheduler, config: built.config });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers });
  const patch = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const del = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "DELETE", headers });

  const MEMBERS = [
    { id: "U1", type: "internal" as const },
    { id: "U2", type: "internal" as const },
  ];
  const capChannelMembers = async (actorId: string) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("channel", "C"),
        destination: { type: ROOT.type, target: ROOT.target, audienceScopeId: ROOT.audienceScopeId },
        destinations: [THREAD, ROOT],
        defaultDestinationKey: ROOT.key,
        members: MEMBERS,
        exp: Date.now() + CAPABILITY_TTL_MS,
      },
      SECRET,
    );

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
      { "x-agent-capability": await capFor("U1") },
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
    const created = (await (
      await post(
        "/v1/crons",
        { title: "Gmail digest", schedule: { everyMs: 60_000 }, action: "orig" },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;
    assert.equal(created.cron.title, "Gmail digest");

    const patched = (await (
      await patch(`/v1/crons/${id}`, { title: "GitLab related work" }, { "x-agent-capability": await capFor("U1") })
    ).json()) as any;
    assert.equal(patched.cron.title, "GitLab related work");
    const archived = (await (
      await patch(`/v1/crons/${id}`, { archived: true }, { "x-agent-capability": await capFor("U1") })
    ).json()) as any;
    assert.equal(archived.cron.archived, true);
    assert.equal(archived.cron.enabled, false);
    await del(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U1") });
  });

  it("accepts calendar cron schedules and defaults timezone from the capability", async () => {
    const withTz = await post(
      "/v1/crons",
      { title: "Market open", schedule: { cron: "0 9 * * 1-5" }, action: "daily market brief" },
      { "x-agent-capability": await capFor("U1", undefined, { timezone: "America/New_York" }) },
    );
    assert.equal(withTz.status, 200);
    const created = (await withTz.json()) as any;
    assert.equal(created.cron.schedule.cron, "0 9 * * 1-5");
    assert.equal(created.cron.schedule.timezone, "America/New_York");
    assert.equal(typeof created.cron.nextFireAt, "number");

    const fallback = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * 1-5" }, action: "daily brief" },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(fallback.status, 200);
    assert.equal(((await fallback.json()) as any).cron.schedule.timezone, "America/Los_Angeles");
  });

  it("rejects mixed calendar and legacy schedule fields under a capability", async () => {
    const create = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * *", everyMs: 60_000 }, action: "mixed" },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(create.status, 400);
    assert.equal(((await create.json()) as any).error, "bad_request");

    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "orig" },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    const patchRes = await patch(
      `/v1/crons/${created.cron.id}`,
      { schedule: { cron: "0 9 * * *", firstFireAt: 1 } },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(patchRes.status, 400);
    assert.equal(((await patchRes.json()) as any).error, "bad_request");
  });

  it("creates a destination-less cron when the token carries no destination (nullable)", async () => {
    const noDest = await mintCapabilityToken(
      { actorId: "U9", scopeId: "personal:U9", exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const res = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "nightly workspace cleanup" },
      { "x-agent-capability": noDest },
    );
    assert.equal(res.status, 200);
    const { cron } = (await res.json()) as any;
    assert.equal(cron.owner, "U9");
    assert.equal(cron.destination, undefined);
  });

  it("lists only the caller's own crons under a capability", async () => {
    await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "u2 task" },
      { "x-agent-capability": await capFor("U2") },
    );
    const mine = (await (await get("/v1/crons", { "x-agent-capability": await capFor("U1") })).json()) as any;
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
      { "x-agent-capability": await capFor("U1") },
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
      { "x-agent-capability": await capChannel("U8") },
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

    const orgRes = await post(
      "/v1/soul",
      { content: "replace org" },
      { "x-agent-capability": await capFor("U1", orgScope) },
    );
    const teamRes = await post(
      "/v1/soul",
      { content: "replace team" },
      { "x-agent-capability": await capFor("U1", teamScope) },
    );

    assert.equal(orgRes.status, 403);
    assert.equal(teamRes.status, 403);
    assert.equal(built.config.soulVersion(orgScope), orgBefore);
    assert.equal(built.config.getSoul(teamScope), null);
  });

  it("reads the caller's in-scope SOUL under a capability", async () => {
    const personalScope = scopeId("personal", "U7");
    built.config.setSoul(personalScope, "Prefer precise, compact answers.");

    const res = await get("/v1/soul?scopeId=personal:U2", { "x-agent-capability": await capFor("U7") });
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

    const res = await get("/v1/soul?scopeId=personal:U8", { "x-agent-capability": await capChannel("U8") });
    assert.equal(res.status, 200);

    const got = (await res.json()) as any;
    assert.equal(got.scopeId, scopeId("channel", "C"));
    assert.equal(got.soul, "Channel C instruction.");
    assert.ok(got.effectiveSoul.includes("Channel C instruction."));
    assert.equal(got.effectiveSoul.includes("Private U8 instruction."), false);
  });

  it("rejects an invalid/expired token with 401", async () => {
    assert.equal(
      (await post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "x" }, { "x-agent-capability": "garbage" }))
        .status,
      401,
    );
    const expired = await mintCapabilityToken({ actorId: "U1", scopeId: "personal:U1", exp: Date.now() - 1 }, SECRET);
    assert.equal(
      (await post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "x" }, { "x-agent-capability": expired }))
        .status,
      401,
    );
  });

  it("refuses a capability token on a non-self-service route (e.g. /v1/turns) with 403", async () => {
    const res = await post(
      "/v1/turns",
      { surface: "x", actor: { externalId: "U1" }, conversation: { kind: "dm", threadRef: "t" }, text: "hi" },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(res.status, 403);
  });

  it("refuses a capability token minted for another audience on a self-service route", async () => {
    const foreign = await capFor("U1", scopeId("personal", "U1"), { aud: "some-other-surface" });
    const res = await get("/v1/keychain/overview", { "x-agent-capability": foreign });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /audience not valid/);
    const ok = await get("/v1/keychain/overview", { "x-agent-capability": await capFor("U1") });
    assert.notEqual(ok.status, 403);
  });

  it("Strict capabilities can observe but cannot directly mutate the control plane", async () => {
    const scope = scopeId("personal", "U-strict");
    await built.config.setSecurityPosture(scope, "strict");
    const token = await capFor("U-strict", scope);
    assert.equal((await get("/v1/crons", { "x-agent-capability": token })).status, 200);
    const create = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "must not run" },
      { "x-agent-capability": token },
    );
    assert.equal(create.status, 403);
    assert.match(((await create.json()) as { message: string }).message, /direct control-plane mutations/i);
  });

  it("a capability cannot cancel another user's cron", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "u1 owned" },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    const res = await post(`/v1/crons/${created.cron.id}/disable`, {}, { "x-agent-capability": await capFor("U2") });
    assert.equal(res.status, 403);
  });

  it("creates a cron at a chosen destinationKey (the whole channel), audience from the token", async () => {
    const res = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "channel digest", destinationKey: "k-root" },
      { "x-agent-capability": await capChannel("U1") },
    );
    assert.equal(res.status, 200);
    const { cron } = (await res.json()) as any;
    assert.equal(cron.destination.target, "C");
    assert.equal(cron.destination.audienceScopeId, "channel:C");
    assert.equal(cron.destination.key, undefined);
    assert.equal(cron.destination.label, undefined);
  });

  it("creates a cron at the default destination when no key is given (this thread)", async () => {
    const res = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "thread reminder" },
      { "x-agent-capability": await capChannel("U1") },
    );
    const { cron } = (await res.json()) as any;
    assert.equal(cron.destination.target, "C:111");
  });

  it("rejects an unknown destinationKey with 400 (no silent escalation)", async () => {
    const res = await post(
      "/v1/crons",
      { schedule: { everyMs: 60_000 }, action: "x", destinationKey: "k-not-in-set" },
      { "x-agent-capability": await capChannel("U1") },
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, "unknown_destination");
  });

  it("a forged body destination is ignored; the chosen candidate's audience wins", async () => {
    const res = await post(
      "/v1/crons",
      {
        schedule: { everyMs: 60_000 },
        action: "x",
        destinationKey: "k-root",
        destination: { type: "slack", target: "C", audienceScopeId: "personal:U1" },
      },
      { "x-agent-capability": await capChannel("U1") },
    );
    const { cron } = (await res.json()) as any;
    assert.equal(cron.destination.audienceScopeId, "channel:C");
  });

  it("retargets an existing cron to another candidate via POST /v1/crons/:id/destination", async () => {
    const cap = await capChannel("U1");
    const created = (await (
      await post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "move me" }, { "x-agent-capability": cap })
    ).json()) as any;
    assert.equal(created.cron.destination.target, "C:111");
    const res = await post(
      `/v1/crons/${created.cron.id}/destination`,
      { destinationKey: "k-root" },
      { "x-agent-capability": cap },
    );
    assert.equal(res.status, 200);
    const { cron } = (await res.json()) as any;
    assert.equal(cron.destination.target, "C");
    assert.equal(cron.destination.audienceScopeId, "channel:C");
  });

  it("retarget is owner-gated (another user's token → 403) and rejects an unknown key (400)", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "mine" },
        { "x-agent-capability": await capChannel("U1") },
      )
    ).json()) as any;
    const forbidden = await post(
      `/v1/crons/${created.cron.id}/destination`,
      { destinationKey: "k-root" },
      { "x-agent-capability": await capChannel("U2") },
    );
    assert.equal(forbidden.status, 403);
    const badKey = await post(
      `/v1/crons/${created.cron.id}/destination`,
      { destinationKey: "nope" },
      { "x-agent-capability": await capChannel("U1") },
    );
    assert.equal(badKey.status, 400);
  });

  it("you cannot retarget to a destination not authenticated in the current turn (personal-cron containment)", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "contained" },
        { "x-agent-capability": await capChannel("U1") },
      )
    ).json()) as any;
    const res = await post(
      `/v1/crons/${created.cron.id}/destination`,
      { destinationKey: "k-root" },
      { "x-agent-capability": await capFor("U1", scopeId("channel", "C")) },
    );
    assert.equal(res.status, 400);
  });

  it("gets, patches, runs, and deletes the caller's own cron by id", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "orig" },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;

    const got = (await (await get(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U1") })).json()) as any;
    assert.equal(got.cron.id, id);
    assert.equal(got.cron.action, "orig");

    const patched = (await (
      await patch(
        `/v1/crons/${id}`,
        { action: "edited", schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" } },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    assert.equal(patched.cron.id, id);
    assert.equal(patched.cron.action, "edited");
    assert.equal(patched.cron.schedule.cron, "0 9 * * *");
    const list = (await (await get("/v1/crons", { "x-agent-capability": await capFor("U1") })).json()) as any;
    assert.equal(list.crons.filter((c: any) => c.id === id).length, 1);

    assert.equal((await post(`/v1/crons/${id}/run`, {}, { "x-agent-capability": await capFor("U1") })).status, 200);

    assert.equal((await del(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U1") })).status, 200);
    assert.equal((await get(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U1") })).status, 404);
  });

  it("get/patch/delete/run of an OWNER cron are denied to another user (403), even in the same channel", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "u1 owned" },
        { "x-agent-capability": await capChannel("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;
    assert.equal((await get(`/v1/crons/${id}`, { "x-agent-capability": await capChannel("U2") })).status, 403);
    assert.equal(
      (await patch(`/v1/crons/${id}`, { action: "hijacked" }, { "x-agent-capability": await capChannel("U2") })).status,
      403,
    );
    assert.equal((await post(`/v1/crons/${id}/run`, {}, { "x-agent-capability": await capChannel("U2") })).status, 403);
    assert.equal((await del(`/v1/crons/${id}`, { "x-agent-capability": await capChannel("U2") })).status, 403);
  });

  it("get of an unknown cron is 404; a bad patch body is 400", async () => {
    assert.equal((await get(`/v1/crons/does-not-exist`, { "x-agent-capability": await capFor("U1") })).status, 404);
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "x" },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    assert.equal(
      (await patch(`/v1/crons/${created.cron.id}`, { nonsense: true }, { "x-agent-capability": await capFor("U1") }))
        .status,
      400,
    );
  });

  it("creates a scopeFloor cron when the token carries a member snapshot", async () => {
    const res = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" }, action: "team standup", runAs: "scopeFloor" },
      { "x-agent-capability": await capChannelMembers("U1") },
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
      { "x-agent-capability": await capChannel("U1") },
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, "members_unavailable");
  });

  it("any member of the scope can edit/disable a scopeFloor cron", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "team standup", runAs: "scopeFloor" },
        { "x-agent-capability": await capChannelMembers("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;
    const patched = await patch(
      `/v1/crons/${id}`,
      { action: "tweaked by a teammate" },
      { "x-agent-capability": await capChannelMembers("U2") },
    );
    assert.equal(patched.status, 200);
    assert.equal(((await patched.json()) as any).cron.action, "tweaked by a teammate");
    const list = (await (
      await get("/v1/crons", { "x-agent-capability": await capChannelMembers("U2") })
    ).json()) as any;
    assert.ok(list.crons.some((c: any) => c.id === id));
    assert.equal(
      (await post(`/v1/crons/${id}/disable`, {}, { "x-agent-capability": await capChannelMembers("U2") })).status,
      200,
    );
  });

  it("a scopeFloor cron from a different scope is readable by a snapshot member but never administrable (your boss's channel cron stays out of your DM's control)", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "team standup", runAs: "scopeFloor" },
        { "x-agent-capability": await capChannelMembers("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;
    assert.equal((await get(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U2") })).status, 200);
    assert.equal(
      (await patch(`/v1/crons/${id}`, { action: "hijack from my DM" }, { "x-agent-capability": await capFor("U2") }))
        .status,
      403,
    );
    assert.equal((await post(`/v1/crons/${id}/run`, {}, { "x-agent-capability": await capFor("U2") })).status, 403);
    assert.equal((await del(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U2") })).status, 403);
    const dmList = (await (await get("/v1/crons", { "x-agent-capability": await capFor("U2") })).json()) as any;
    assert.ok(!dmList.crons.some((c: any) => c.id === id), "not administered from the DM scope");
    assert.ok(
      dmList.visible.some((c: any) => c.id === id),
      "surfaced read-only in visible",
    );
  });
});
