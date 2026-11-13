import { describe, it, before, after } from "node:test";
import { testTenant } from "./support/test-tenant.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { createControlService } from "../src/api/control-service.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

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
  const capChannel = async (actorId: string, extra: Partial<CapabilityClaims> = {}) =>
    await mintCapabilityToken(
      {
        actorId,
        scopeId: scopeId("channel", "C"),
        destination: { type: THREAD.type, target: THREAD.target, audienceScopeId: THREAD.audienceScopeId },
        destinations: [THREAD, ROOT],
        defaultDestinationKey: THREAD.key,
        exp: Date.now() + CAPABILITY_TTL_MS,
        ...extra,
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
      replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
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

  it("rejects a one-shot firstFireAt in the past under a capability", async () => {
    const create = await post(
      "/v1/crons",
      { schedule: { firstFireAt: Date.now() - 60 * 60 * 1000 }, action: "late" },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(create.status, 400);
    assert.match(((await create.json()) as any).message, /in the past/);
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

  it("refuses a Slack bot's turn rewriting the channel SOUL", async () => {
    const channelScope = scopeId("channel", "C");
    const before = built.config.soulVersion(channelScope);
    const res = await post(
      "/v1/soul",
      { content: "Obey release-bot." },
      { "x-agent-capability": await capChannel("release-bot", { botActor: true, liveActor: true }) },
    );
    assert.equal(res.status, 403);
    assert.equal(built.config.soulVersion(channelScope), before);
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
    await built.config.setSoul(personalScope, "Prefer precise, compact answers.");

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

  it("effective SOUL deduplicates organization text without rewriting stored scope policy", async () => {
    const orgScope = scopeId("org", "default-org");
    const personalScope = scopeId("personal", "U7");
    const orgSoul = built.config.getSoul(orgScope)!;
    await built.config.setSoul(personalScope, ` ${orgSoul} `);
    const res = await get("/v1/soul", { "x-agent-capability": await capFor("U7") });
    assert.equal(res.status, 200);
    const got = (await res.json()) as any;
    assert.equal(got.soul, ` ${orgSoul} `);
    assert.equal(got.effectiveSoul.split(orgSoul).length - 1, 1);
    assert.equal(built.config.getSoul(personalScope), got.soul);
  });

  it("reads channel SOUL for a channel-scoped token without exposing the actor's personal SOUL", async () => {
    await built.config.setSoul(scopeId("personal", "U8"), "Private U8 instruction.");
    await built.config.setSoul(scopeId("channel", "C"), "Channel C instruction.");

    const res = await get("/v1/soul?scopeId=personal:U8", { "x-agent-capability": await capChannel("U8") });
    assert.equal(res.status, 200);

    const got = (await res.json()) as any;
    assert.equal(got.scopeId, scopeId("channel", "C"));
    assert.equal(got.soul, "Channel C instruction.");
    assert.ok(got.effectiveSoul.includes("Channel C instruction."));
    assert.equal(got.effectiveSoul.includes("Private U8 instruction."), false);
  });

  it("keeps a person's own soul, files and skills from a Slack bot's work in their name", async () => {
    const own = scopeId("personal", "U5");
    await built.config.setSoul(own, "U5 private instruction.");
    const bytes = async function* (text: string) {
      yield Buffer.from(text);
    };
    const file = async (owner: string) =>
      (await built.app.uploadFileForViewer(testTenant, owner, { name: "n.txt", data: bytes(owner) }))!.id;
    const skill = async (principalId: string) =>
      (await built.app.createOwnedSkill({ principalId, name: `s-${principalId}`, description: "d", body: "b" }))!.id;
    const [mine, theirs, mySkill, theirSkill] = [
      await file("U5"),
      await file("U6"),
      await skill("U5"),
      await skill("U6"),
    ];
    for (const ref of [theirs, `skill:${theirSkill}`]) {
      const grant = { ownerScopeId: scopeId("personal", "U6"), ref, granteeScopeId: own, permission: "read" } as const;
      await built.acl.grant(testTenant, { ...grant, grantedBy: "U6" }, "U6");
    }
    const as = async (botActor: boolean) => ({
      "x-agent-capability": await capFor("U5", own, botActor ? { botActor } : {}),
    });
    const reads = [
      `/v1/files/${mine}/content`,
      `/v1/files/${theirs}/content`,
      `/v1/skills/${mySkill}`,
      `/v1/skills/${theirSkill}`,
    ];
    const statuses = async (botActor: boolean) =>
      Promise.all(reads.map(async (path) => (await get(path, await as(botActor))).status));
    assert.deepEqual(await statuses(false), [200, 200, 200, 200]);
    assert.deepEqual(await statuses(true), [404, 404, 404, 404]);
    const bot = await as(true);
    assert.deepEqual(await (await get("/v1/files", bot)).json(), { owned: [], shared: [] });
    assert.equal(((await (await get("/v1/soul", bot)).json()) as { soul: string | null }).soul, null);
    const writes = [
      await post("/v1/soul", { content: "bot rewrite" }, bot),
      await post("/v1/skills", { name: "bot-skill", description: "d", body: "b" }, bot),
      await fetch(`${base}/v1/skills/${mySkill}`, {
        method: "PUT",
        headers: { "content-type": "application/json", ...bot },
        body: JSON.stringify({ body: "bot" }),
      }),
      await del(`/v1/skills/${mySkill}`, bot),
    ];
    assert.deepEqual(
      writes.map((res) => res.status),
      [403, 403, 404, 403],
    );
    await built.app.deleteOwnedSkill({ principalId: "U5", id: mySkill });
    assert.equal((await post(`/v1/skills/${mySkill}/restore`, {}, bot)).status, 404);
    assert.equal(built.config.getSoul(own), "U5 private instruction.");
    const share = await createControlService(built.app).shareArtifact(
      { type: "file", id: mine, scope: scopeId("channel", "C") },
      { actorId: "U5", scopeId: own, botActor: true, exp: Date.now() + CAPABILITY_TTL_MS },
    );
    assert.equal(share.ok ? "shared" : share.code, "forbidden");
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
    const search = await post("/v1/memory/search", { query: "anything" }, { "x-agent-capability": token });
    assert.doesNotMatch(await search.text(), /direct control-plane mutations/i);
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
    const enable = await post(`/v1/crons/${created.cron.id}/enable`, {}, { "x-agent-capability": await capFor("U2") });
    assert.equal(enable.status, 403);
    const owner = { "x-agent-capability": await capFor("U1") };
    assert.equal((await post(`/v1/crons/${created.cron.id}/disable`, {}, owner)).status, 200);
    assert.equal((await post(`/v1/crons/${created.cron.id}/enable`, {}, owner)).status, 200);
    assert.equal((await built.app.getCron(created.cron.id))?.enabled, true);
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
    const same = (await (
      await patch(
        `/v1/crons/${id}`,
        { action: "edited", schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" } },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    assert.equal(same.cron.id, id);
    assert.equal(same.cron.action, "edited");
    const list = (await (await get("/v1/crons", { "x-agent-capability": await capFor("U1") })).json()) as any;
    assert.equal(list.crons.filter((c: any) => c.id === id).length, 1);

    assert.equal((await post(`/v1/crons/${id}/run`, {}, { "x-agent-capability": await capFor("U1") })).status, 200);

    assert.equal((await del(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U1") })).status, 200);
    assert.equal((await get(`/v1/crons/${id}`, { "x-agent-capability": await capFor("U1") })).status, 404);
  });

  it("the runs endpoint reads the fire table", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "count things" },
        { "x-agent-capability": await capFor("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;
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

    const res = await get(`/v1/crons/${id}/runs?limit=1`, { "x-agent-capability": await capFor("U1") });
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.total, 2);
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].fireKey, "k2");
    assert.equal(body.runs[0].reply, "second");
  });

  it("another public-channel user can read an OWNER cron but cannot patch, run, or delete it", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "u1 owned" },
        { "x-agent-capability": await capChannel("U1") },
      )
    ).json()) as any;
    const id = created.cron.id;
    assert.equal((await get(`/v1/crons/${id}`, { "x-agent-capability": await capChannel("U2") })).status, 200);
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
    const nonsense = await patch(
      `/v1/crons/${created.cron.id}`,
      { nonsense: true },
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(nonsense.status, 400);
    assert.match(((await nonsense.json()) as any).message, /nothing to change/);
    const empty = await patch(`/v1/crons/${created.cron.id}`, {}, { "x-agent-capability": await capFor("U1") });
    assert.equal(empty.status, 400);
    assert.match(((await empty.json()) as any).message, /nothing to change/);
  });

  it("a channel cron belongs to its creator; teammates edit it only once the owner shares write access", async () => {
    const created = await post(
      "/v1/crons",
      { schedule: { cron: "0 9 * * *", timezone: "America/Los_Angeles" }, action: "team standup" },
      { "x-agent-capability": await capChannelMembers("U1") },
    );
    assert.equal(created.status, 200);
    const { cron } = (await created.json()) as any;
    assert.equal(cron.owner, "U1");
    assert.equal(cron.ownerScopeId, "channel:C");
    const teammate = { "x-agent-capability": await capChannelMembers("U2") };
    assert.equal((await patch(`/v1/crons/${cron.id}`, { action: "tweaked" }, teammate)).status, 403);
    const shared = await post(
      "/v1/share",
      { type: "cron", id: cron.id, toScope: "personal:U2", permission: "write" },
      { "x-agent-capability": await capChannelMembers("U1") },
    );
    assert.equal(shared.status, 200);
    const renamed = await patch(`/v1/crons/${cron.id}`, { title: "standup (renamed)" }, teammate);
    assert.equal(renamed.status, 200);
    assert.equal(((await renamed.json()) as any).cron.owner, "U1", "a write grant edits without taking over");
    const taken = await patch(`/v1/crons/${cron.id}`, { action: "tweaked by a teammate" }, teammate);
    assert.equal(taken.status, 200);
    assert.equal(((await taken.json()) as any).cron.owner, "U2", "whoever rewrites the task owns the fires");
    assert.equal((await post(`/v1/crons/${cron.id}/disable`, {}, teammate)).status, 200);
    assert.equal(
      (await post(`/v1/crons/${cron.id}/enable`, {}, { "x-agent-capability": await capChannelMembers("U1") })).status,
      200,
      "the previous owner keeps a write grant",
    );
    const channelClaims = (actorId: string): CapabilityClaims => ({
      actorId,
      scopeId: scopeId("channel", "C"),
      destination: { type: ROOT.type, target: ROOT.target, audienceScopeId: ROOT.audienceScopeId },
      destinations: [THREAD, ROOT],
      defaultDestinationKey: ROOT.key,
      members: MEMBERS,
      exp: Date.now() + CAPABILITY_TTL_MS,
    });
    const control = createControlService(built.app, built.scheduler);
    const script = { command: "./standup.sh" };
    const passes = async () => undefined;
    const byPreviousOwner = await control.patchCron(cron.id, { script }, channelClaims("U1"), passes);
    assert.equal(byPreviousOwner.ok ? "" : byPreviousOwner.code, "forbidden", "only the owner changes the script");
    const byOwner = await control.patchCron(cron.id, { script }, channelClaims("U2"), passes);
    assert.deepEqual(byOwner.ok && byOwner.cron.script, script);
    const removed = await control.patchCron(cron.id, { script: null }, channelClaims("U1"));
    assert.equal(removed.ok ? "" : removed.code, "forbidden");
    const overHttp = await patch(
      `/v1/crons/${cron.id}`,
      { script },
      { "x-agent-capability": await capChannelMembers("U2") },
    );
    assert.equal(overHttp.status, 400);
    assert.match(((await overHttp.json()) as any).message, /cron tool/);
  });

  it("records the agent turn that changed a cron: its actor, its run and whether it was bot work", async () => {
    const owner = { "x-agent-capability": await capChannelMembers("U1") };
    const created = await post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "standup notes" }, owner);
    const { cron } = (await created.json()) as any;
    await post("/v1/share", { type: "cron", id: cron.id, toScope: "personal:U2", permission: "write" }, owner);
    const teammate = { "x-agent-capability": await capChannel("U2", { runId: "run-u2" }) };
    assert.equal((await patch(`/v1/crons/${cron.id}`, { title: "standup (renamed)" }, teammate)).status, 200);
    const bot = {
      "x-agent-capability": await capFor("B1", scopeId("personal", "B1"), { botActor: true, runId: "run-b1" }),
    };
    const botCron = (
      (await (await post("/v1/crons", { schedule: { everyMs: 60_000 }, action: "x" }, bot)).json()) as any
    ).cron;
    assert.equal((await del(`/v1/crons/${botCron.id}`, bot)).status, 200);
    const changes = (await built.auditLog.events(testTenant)).filter(
      (e) => [cron.id, botCron.id].includes(e.resource) && ["cron_update", "cron_delete"].includes(e.action),
    );
    assert.deepEqual(
      changes.map(({ principalId, action, detail }) => ({ principalId, action, detail })),
      [
        { principalId: "U2", action: "cron_update", detail: JSON.stringify({ runId: "run-u2" }) },
        { principalId: "B1", action: "cron_delete", detail: JSON.stringify({ runId: "run-b1", botActor: true }) },
      ],
    );
  });

  it("a channel cron is readable by a member but never administrable by them (your boss's channel cron stays out of your DM's control)", async () => {
    const created = (await (
      await post(
        "/v1/crons",
        { schedule: { everyMs: 60_000 }, action: "team standup" },
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

  it("refuses webhook registration without a live person in personal and channel scopes", async () => {
    const webhooksBefore = await built.app.listWebhooks();
    const auditBefore = (await built.auditLog.events(testTenant)).filter((e) => e.action !== "turn");
    for (const scope of [scopeId("personal", "U1"), scopeId("channel", "C")]) {
      for (const extra of [
        {},
        { liveActor: false, liveAuthor: false },
        { triggered: true },
        { triggered: true, liveActor: true },
        { triggered: true, liveAuthor: true },
      ]) {
        const res = await post(
          "/v1/webhooks",
          { action: "handle the event", verification: { scheme: "hmac-sha256", secret: "secret" } },
          { "x-agent-capability": await capFor("U1", scope, { aud: "control-plane", ...extra }) },
        );
        assert.equal(res.status, 403, JSON.stringify({ scope, extra }));
        assert.equal(((await res.json()) as { error: string }).error, "forbidden");
        assert.deepEqual(await built.app.listWebhooks(), webhooksBefore);
        assert.deepEqual(
          (await built.auditLog.events(testTenant)).filter((e) => e.action !== "turn"),
          auditBefore,
        );
      }
    }
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
      { "x-agent-capability": await capFor("U1", scopeId("personal", "U1"), { liveActor: true }) },
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

  it("registers a destination-less webhook when the token carries no destination (side-effect-only)", async () => {
    const noDest = await mintCapabilityToken(
      { actorId: "U9", scopeId: "personal:U9", liveAuthor: true, exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const res = await post(
      "/v1/webhooks",
      { action: "mirror the event to a file", verification: { scheme: "hmac-sha256", secret: "side-effect-secret" } },
      { "x-agent-capability": noDest },
    );
    assert.equal(res.status, 200);
    const { webhook } = (await res.json()) as any;
    assert.equal(webhook.owner, "U9");
    assert.equal(webhook.destination, undefined);
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
      { "x-agent-capability": await capChannel("U1", { liveActor: true }) },
    );
    assert.equal(res.status, 200);
    const { webhook } = (await res.json()) as any;
    assert.equal(webhook.destination.target, "C");
    assert.equal(webhook.destination.audienceScopeId, "channel:C");
    assert.equal(webhook.destination.key, undefined);
  });

  it("rejects an unknown webhook destinationKey with 400 (no silent escalation)", async () => {
    const res = await post(
      "/v1/webhooks",
      {
        action: "x",
        verification: { scheme: "hmac-sha256", secret: "unknown-destination-secret" },
        destinationKey: "k-not-in-set",
      },
      { "x-agent-capability": await capChannel("U1", { liveActor: true }) },
    );
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error, "unknown_destination");
  });

  it("lists only the caller's own webhooks under a capability, with secrets redacted", async () => {
    await post(
      "/v1/webhooks",
      { action: "u2 hook", verification: { scheme: "hmac-sha256", secret: "s2" } },
      { "x-agent-capability": await capFor("U2", scopeId("personal", "U2"), { liveActor: true }) },
    );
    const mine = (await (await get("/v1/webhooks", { "x-agent-capability": await capFor("U1") })).json()) as any;
    assert.ok(mine.webhooks.length >= 1);
    assert.ok(
      mine.webhooks.every((w: any) => w.owner === "U1"),
      "a capability must not see other users' webhooks",
    );
    assert.ok(mine.webhooks.every((w: any) => !w.verification.secret || w.verification.secret === "***"));
  });

  it("a capability can disable its OWN webhook but not another user's", async () => {
    const created = (await (
      await post(
        "/v1/webhooks",
        { action: "u1 owned", verification: { scheme: "hmac-sha256", secret: "owned-secret" } },
        { "x-agent-capability": await capFor("U1", scopeId("personal", "U1"), { liveActor: true }) },
      )
    ).json()) as any;
    const forbidden = await post(
      `/v1/webhooks/${created.webhook.id}/disable`,
      {},
      { "x-agent-capability": await capFor("U2") },
    );
    assert.equal(forbidden.status, 403);
    const ok = await post(
      `/v1/webhooks/${created.webhook.id}/disable`,
      {},
      { "x-agent-capability": await capFor("U1") },
    );
    assert.equal(ok.status, 200);
  });

  it("a bot's capability can't list, read the events of, or disable a channel member's webhook", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: true }],
      ["admin-alice", "U1", "U2", "release-bot"].map((principalId) => ({ channelId: "C", principalId })),
    );
    const created = (await (
      await post(
        "/v1/webhooks",
        { action: "u1 channel hook", verification: { scheme: "hmac-sha256", secret: "channel-secret" } },
        { "x-agent-capability": await capChannel("U1", { liveActor: true }) },
      )
    ).json()) as any;
    const bot = { "x-agent-capability": await capChannel("release-bot", { botActor: true, liveActor: true }) };
    const listed = (await (await get("/v1/webhooks", bot)).json()) as any;
    assert.equal(
      listed.webhooks.some((w: any) => w.id === created.webhook.id),
      false,
    );
    assert.equal((await get(`/v1/webhooks/${created.webhook.id}/events`, bot)).status, 404);
    assert.equal((await post(`/v1/webhooks/${created.webhook.id}/disable`, {}, bot)).status, 403);
    assert.equal((await built.app.getWebhook(created.webhook.id))?.enabled, true);
    const member = { "x-agent-capability": await capChannel("U2") };
    assert.equal((await post(`/v1/webhooks/${created.webhook.id}/disable`, {}, member)).status, 200);
  });

  it("a public channel remains available to an active internal principal outside its current roster", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: false }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    assert.equal((await get("/v1/soul", { "x-agent-capability": await capChannel("U8") })).status, 200);
  });

  it("a live bot QM knows as an app retains private-channel tools without a Slack user principal; others do not", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: true }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    for (const [actorId, botActor] of [
      ["B-LEGACY", true],
      ["U8", false],
      ["B-UNSEEN", undefined],
    ] as const) {
      const conversation = { kind: "channel", threadRef: `ch:C:${actorId}`, channelRef: "C" } as const;
      if (botActor !== undefined)
        await built.app.turn({ surface: "test", actor: { externalId: actorId }, conversation, text: "hi", botActor });
      const members = [{ id: actorId, type: "internal" as const }];
      const soul = async (extra: Partial<CapabilityClaims>) =>
        (await get("/v1/soul", { "x-agent-capability": await capChannel(actorId, { members, ...extra }) })).status;
      assert.deepEqual([await soul({ botActor: true, liveActor: true }), await soul({})], [botActor ? 200 : 403, 403]);
    }
  });
});
