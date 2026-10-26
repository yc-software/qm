import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { createServer } from "../src/api/server.ts";
import { scopeId } from "../src/types.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "route-test-secret".repeat(3);

describe("capability-token control plane (SOUL)", () => {
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

  it("channel-header-pin takes the actor and scope from the token and refuses non-live tokens", async () => {
    const put = (body: unknown, token: string) =>
      fetch(`${base}/v1/channel-header-pin`, {
        method: "PUT",
        headers: { "content-type": "application/json", "x-agent-capability": token },
        body: JSON.stringify(body),
      });
    const live = await capChannel("U1", { liveActor: true });
    const spoofed = await put({ on: true, principalId: "U2", scopeId: "channel:OTHER" }, live);
    assert.equal(spoofed.status, 200);
    assert.equal(((await spoofed.json()) as { scopeId: string }).scopeId, "channel:C");
    const triggered = await put({ on: false }, await capChannel("U1", { triggered: true }));
    assert.equal(triggered.status, 403);
    assert.deepEqual(await triggered.json(), { error: "live_actor_required" });
  });

  it("rejects an invalid/expired token with 401", async () => {
    assert.equal((await post("/v1/soul", { soul: "x" }, { "x-agent-capability": "garbage" })).status, 401);
    const expired = await mintCapabilityToken({ actorId: "U1", scopeId: "personal:U1", exp: Date.now() - 1 }, SECRET);
    assert.equal((await post("/v1/soul", { soul: "x" }, { "x-agent-capability": expired })).status, 401);
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
    assert.equal((await get("/v1/soul", { "x-agent-capability": token })).status, 200);
    const update = await post("/v1/soul", { soul: "must not apply" }, { "x-agent-capability": token });
    assert.equal(update.status, 403);
    assert.match(((await update.json()) as { message: string }).message, /direct control-plane mutations/i);
  });

  it("a public channel remains available to an active internal principal outside its current roster", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: false }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    assert.equal((await get("/v1/soul", { "x-agent-capability": await capChannel("U8") })).status, 200);
  });

  it("a live verified bot retains private-channel tools without a Slack user principal", async () => {
    await built.directory.replaceChannels(
      [{ channelId: "C", name: "eng", isPrivate: true }],
      ["admin-alice", "U1", "U2"].map((principalId) => ({ channelId: "C", principalId })),
    );
    const members = [{ id: "B-LEGACY", type: "internal" as const }];
    const token = await capFor("B-LEGACY", scopeId("channel", "C"), {
      botActor: true,
      liveActor: true,
      members,
    });
    assert.equal((await get("/v1/soul", { "x-agent-capability": token })).status, 200);
    assert.equal(
      (
        await get("/v1/soul", {
          "x-agent-capability": await capFor("B-LEGACY", scopeId("channel", "C"), { members }),
        })
      ).status,
      403,
    );
  });
});
