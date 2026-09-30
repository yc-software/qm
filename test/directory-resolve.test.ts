import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { CoreClient } from "./live-slack/core.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "directory-resolve-secret".repeat(3);

describe("GET /v1/directory/resolve (agent looks up a teammate's mention id)", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = await mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "dir-resolve-")), signingSecret: SECRET }));
    server = createServer(built.app, { signingSecret: SECRET, scheduler: built.scheduler });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    await built.app.upsertDirectory([
      { principalId: "carol@acme.com", displayName: "Carol Example", type: "internal", slackId: "U0CAROL" },
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U0ALICE" },
      { principalId: "jordan@acme.com", displayName: "Jordan", type: "internal", slackId: "U0JORDAN" },
      { principalId: "joan@acme.com", displayName: "Joan", type: "internal", slackId: "U0JOAN" },
    ]);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = (path: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });

  it("membership reads require source authentication and report only persisted channel members", async () => {
    await built.app.upsertChannels(
      [{ channelId: "CPUBLIC", name: "public", isPrivate: false }],
      [{ channelId: "CPUBLIC", principalId: "carol@acme.com" }],
    );
    for (const [channel, principal, member] of [
      ["CPUBLIC", "carol@acme.com", true],
      ["CPUBLIC", "alice@acme.com", false],
      ["CUNKNOWN", "carol@acme.com", false],
    ] as const) {
      const path = `/v1/directory/channels/${channel}/members/${encodeURIComponent(principal)}`;
      assert.equal((await fetch(`${base}${path}`)).status, 401);
      assert.equal((await get(path)).status, 403);
      const response = await fetch(`${base}${path}`, { headers: signedRequestHeaders(SECRET, "GET", path) });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { member });
    }
  });

  it("resolves a name to a single match carrying the slackId needed to @-mention", async () => {
    const res = await get("/v1/directory/resolve?q=carol");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string; slackId?: string }> };
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.principalId, "carol@acme.com");
    assert.equal(matches[0]!.slackId, "U0CAROL");
  });

  it("recovers the mention id from the principal id in slack-id identity mode (no slackId field)", async () => {
    await built.app.upsertDirectory([{ principalId: "U0SLACKID", displayName: "Morgan", type: "internal" }]);
    const res = await get("/v1/directory/resolve?q=Morgan");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string; slackId?: string }> };
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.slackId, "U0SLACKID");
    await built.app.upsertDirectory([
      { principalId: "carol@acme.com", displayName: "Carol Example", type: "internal", slackId: "U0CAROL" },
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U0ALICE" },
      { principalId: "jordan@acme.com", displayName: "Jordan", type: "internal", slackId: "U0JORDAN" },
      { principalId: "joan@acme.com", displayName: "Joan", type: "internal", slackId: "U0JOAN" },
    ]);
  });

  it("does not fabricate a mention id from a principal id that isn't Slack-id-shaped", async () => {
    await built.app.upsertDirectory([{ principalId: "USER123", displayName: "Pat", type: "internal" }]);
    const res = await get("/v1/directory/resolve?q=Pat");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string; slackId?: string }> };
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.slackId, undefined, "a too-short id (U+6) must not be mistaken for a mention handle");
    await built.app.upsertDirectory([
      { principalId: "carol@acme.com", displayName: "Carol Example", type: "internal", slackId: "U0CAROL" },
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U0ALICE" },
      { principalId: "jordan@acme.com", displayName: "Jordan", type: "internal", slackId: "U0JORDAN" },
      { principalId: "joan@acme.com", displayName: "Joan", type: "internal", slackId: "U0JOAN" },
    ]);
  });

  it("returns the candidate set for an ambiguous prefix", async () => {
    const res = await get("/v1/directory/resolve?q=jo");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string }> };
    assert.ok(matches.length >= 2, "an ambiguous prefix returns multiple candidates");
    assert.ok(matches.every((m) => m.principalId));
  });

  it("returns an empty match set for an unknown name (agent falls back to plain text)", async () => {
    const res = await get("/v1/directory/resolve?q=nobody-here");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as { matches: unknown[] }, { matches: [] });
  });

  it("rejects a missing query with 400", async () => {
    const res = await get("/v1/directory/resolve");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "bad_request");
  });

  it("rejects a request without a capability token (gated like the rest of the agent API)", async () => {
    const res = await fetch(`${base}/v1/directory/resolve?q=carol`);
    assert.equal(res.status, 401);
  });
  it("source pushes persist one observed room and reject malformed or stale partial writes", async () => {
    const post = (body: object) => {
      const raw = JSON.stringify(body);
      return fetch(`${base}/v1/directory`, {
        method: "POST",
        headers: {
          ...signedRequestHeaders(SECRET, "POST", "/v1/directory", raw),
          "content-type": "application/json",
        },
        body: raw,
      });
    };
    await built.app.upsertChannels([{ channelId: "C_OTHER", name: "other" }], [], 10);
    const body = {
      channels: [{ channelId: "C_LIVE", name: "live", isPrivate: true }],
      channelMembers: [{ channelId: "C_LIVE", principalId: "U1" }],
      channelsSyncedAt: 30,
      partialChannels: true,
    };
    assert.equal((await post(body)).status, 200);
    assert.equal(await built.directory.channelPrivacy("C_OTHER"), false);
    assert.equal(await built.directory.channelMember("C_LIVE", "U1"), true);
    assert.equal((await post({ ...body, channelsSyncedAt: 20 })).status, 409);
    for (const invalid of [
      { ...body, channelsSyncedAt: undefined },
      { ...body, channelMembers: undefined },
      { ...body, partialChannels: "true" },
    ])
      assert.equal((await post(invalid)).status, 400);
  });
});

describe("a deployment without the Slack surface (the directory store is never populated)", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = await mintCapabilityToken(
    { actorId: "dana@acme.com", scopeId: "personal:dana@acme.com", exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "dir-web-only-")),
        signingSecret: SECRET,
        emailAuthPrincipals: ["dana@acme.com"],
      }),
    );
    server = createServer(built.app, { signingSecret: SECRET, scheduler: built.scheduler });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const session = await built.sessions.getOrCreateByThread("web:1", "dm", "personal:rex@acme.com");
    await built.sessions.addParticipant(session.id, "rex@acme.com");
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = (path: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });
  const matchesOf = async (query: string): Promise<Array<{ principalId: string; type: string }>> => {
    const res = await get(`/v1/directory/resolve?q=${encodeURIComponent(query)}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { matches: Array<{ principalId: string; type: string }> }).matches;
  };

  it("finds a principal who has signed in but was never pushed into the directory", async () => {
    const matches = await matchesOf("rex@acme.com");
    assert.deepEqual(
      matches.map((m) => m.principalId),
      ["rex@acme.com"],
    );
    assert.equal(matches[0]!.type, "internal", "the web UI only offers internal principals as project members");
  });

  it("matches on a prefix, the way the stored directory does — the search box types a name, not an address", async () => {
    assert.deepEqual(
      (await matchesOf("dan")).map((m) => m.principalId),
      ["dana@acme.com"],
    );
    assert.deepEqual(
      (await matchesOf("rex")).map((m) => m.principalId),
      ["rex@acme.com"],
    );
  });

  it("still returns nothing for someone who has never signed in", async () => {
    assert.deepEqual(await matchesOf("nobody@acme.com"), []);
  });

  it("rejects a member pushed with a type outside PrincipalType instead of dropping it silently", async () => {
    const body = JSON.stringify({ members: [{ principalId: "sam@acme.com", displayName: "Sam", type: "user" }] });
    const ts = Math.floor(Date.now() / 1000);
    const res = await fetch(`${base}/v1/directory`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n/v1/directory\n${body}`),
      },
      body,
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { message: string }).message, /internal, guest/);
    assert.deepEqual(await matchesOf("sam@acme.com"), [], "a rejected push must not land");
  });
});

describe("qualification membership readiness with signed portal identity enforcement", () => {
  it("authenticates directory reads with the separate portal key", async () => {
    const portalSecret = "readiness-portal-key-distinct-from-source";
    const originalPortalSecret = process.env.PORTAL_IDENTITY_SECRET;
    const app = buildApp(testConfig({ signingSecret: SECRET }));
    await app.app.upsertDirectory([
      { principalId: process.env.LIVE_E2E_ADMIN_PRINCIPAL || "admin-alice", displayName: "Admin", type: "internal" },
      { principalId: "qa@example.com", displayName: "QA", type: "internal", slackId: "UQA" },
    ]);
    await app.app.upsertChannels(
      [{ channelId: "CQA", name: "qa", isPrivate: false }],
      [{ channelId: "CQA", principalId: "qa@example.com" }],
    );
    const server = createServer(app.app, {
      signingSecret: SECRET,
      portalIdentitySecret: portalSecret,
      capabilitySecret: "readiness-capability-key-distinct-from-source",
      requireSignedPortalIdentity: true,
      identity: app.identity,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    try {
      const path = "/v1/directory/resolve?q=UQA";
      const unsigned = await fetch(`${base}${path}`, { headers: signedRequestHeaders(SECRET, "GET", path) });
      assert.equal(unsigned.status, 401);
      process.env.PORTAL_IDENTITY_SECRET = portalSecret;
      const core = new CoreClient(base, SECRET);
      await core.waitForChannelMembership("CQA", "UQA", 5000);
      process.env.PORTAL_IDENTITY_SECRET = SECRET;
      await assert.rejects(core.waitForChannelMembership("CQA", "UQA", 5000), /401.*portal identity required/);
    } finally {
      if (originalPortalSecret === undefined) delete process.env.PORTAL_IDENTITY_SECRET;
      else process.env.PORTAL_IDENTITY_SECRET = originalPortalSecret;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
