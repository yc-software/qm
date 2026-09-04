import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
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
