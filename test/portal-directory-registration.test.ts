import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "portal-directory-registration-secret-0001";

let base: string;
let built: BuiltApp;
let server: Server;

const identity = (principalId: string, displayName?: string, impersonator?: string) =>
  mintSignedPayload(
    {
      p: principalId,
      ...(displayName ? { n: displayName } : {}),
      ...(impersonator ? { imp: impersonator } : {}),
      exp: Date.now() + 60_000,
    },
    SECRET,
  );

const request = async (principalId: string, path: string, init: RequestInit = {}, displayName?: string) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      "x-portal-identity": await identity(principalId, displayName),
    },
  });

before(async () => {
  built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "portal-directory-registration-")) }));
  await built.identity.hydrate();
  server = createInsecureTestServer(built.app, {
    portalIdentitySecret: SECRET,
    requireSignedPortalIdentity: true,
    identity: built.identity,
    directory: built.directory,
    advisoryLock: built.advisoryLock,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("signed-in principals remain searchable and addable after Slack drops them", async () => {
  assert.equal(
    (await request("bob@example.com", "/v1/projects?principalId=bob%40example.com", {}, "Bob Portal")).status,
    200,
  );

  const create = await request(
    "alice@example.com",
    "/v1/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ principalId: "alice@example.com", name: "Portal Project" }),
    },
    "Alice Portal",
  );
  assert.equal(create.status, 201);
  const projectId = ((await create.json()) as { project: { id: string } }).project.id;

  const search = await request("alice@example.com", "/v1/directory/resolve?q=Bob");
  assert.equal(search.status, 200);
  assert.deepEqual(await search.json(), {
    matches: [{ principalId: "bob@example.com", displayName: "Bob Portal", type: "internal" }],
  });

  const add = await request("alice@example.com", `/v1/projects/${projectId}/members`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ principalId: "alice@example.com", memberId: "bob@example.com" }),
  });
  assert.equal(add.status, 200);

  await built.app.upsertDirectory([
    { principalId: "bob@example.com", displayName: "Bob Slack", type: "internal", slackId: "U-BOB" },
    { principalId: "slack-only@example.com", displayName: "Slack Only", type: "internal" },
  ]);
  await built.app.upsertDirectory([]);

  assert.equal(built.identity.classify("bob@example.com").type, "internal");
  assert.equal(built.identity.classify("slack-only@example.com").type, "guest");
  assert.equal((await built.directory.resolve("Bob Slack")).kind, "one");
  assert.equal(await built.directory.get("slack-only@example.com"), null);
});

test("authentication and directory removal cannot split directory and identity ownership", async () => {
  await built.app.upsertDirectory([{ principalId: "racer@example.com", displayName: "Racer Slack", type: "internal" }]);
  const original = built.directory.registerAuthenticated.bind(built.directory);
  let entered!: () => void;
  let release!: () => void;
  const registrationEntered = new Promise<void>((resolve) => (entered = resolve));
  const registrationRelease = new Promise<void>((resolve) => (release = resolve));
  built.directory.registerAuthenticated = async (member) => {
    entered();
    await registrationRelease;
    await original(member);
  };

  try {
    const signedIn = request("racer@example.com", "/v1/projects?principalId=racer%40example.com", {}, "Racer Portal");
    await registrationEntered;
    const sync = built.app.upsertDirectory([]);
    release();
    assert.equal((await signedIn).status, 200);
    await sync;
  } finally {
    built.directory.registerAuthenticated = original;
  }

  assert.equal(built.identity.classify("racer@example.com").type, "internal");
  assert.equal((await built.directory.get("racer@example.com"))?.displayName, "Racer Portal");
});

test("impersonation does not register a principal who never signed in", async () => {
  const token = await identity("never-signed-in@example.com", "Never Signed In", "admin@example.com");
  const response = await fetch(`${base}/v1/projects?principalId=never-signed-in%40example.com`, {
    headers: { "x-portal-identity": token },
  });
  assert.equal(response.status, 200);
  assert.equal(await built.directory.get("never-signed-in@example.com"), null);
});
