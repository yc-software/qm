import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp as buildProductionApp } from "../src/wiring.ts";
import { stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { testConfigStore, testConfigTables, testDatabaseUrl } from "./support/test-database.ts";
import { createPostgresReplayDedupe } from "../src/auth/replay-dedupe.ts";

const buildApp = (...args: Parameters<typeof buildProductionApp>) => stopAtEnd(buildProductionApp(...args));

const SECRET = "personal-account-test-signing-secret";

test("personal account choice persists across instances without changing anyone else's choice", async () => {
  const tables = testConfigTables();
  const first = testConfigStore({ tables });
  const second = testConfigStore({ tables });
  assert.equal(await first.getIndividualModelAuthDurable("alice"), false);
  await first.setPersonalModelAuth("alice", true);
  assert.equal(await second.getIndividualModelAuthDurable("alice"), true);
  assert.equal(await second.getIndividualModelAuthDurable("bob"), false);
  assert.equal(await second.getIndividualModelAuthDurable(), false);
  await second.setPersonalModelAuth("alice", false);
  assert.equal(await first.getIndividualModelAuthDurable("alice"), false);
  await first.setIndividualModelAuth(true);
  assert.equal(await second.getIndividualModelAuthDurable("alice"), true);
});

test("account API binds choice to the signed-in person, preserves connections, and fails closed after disconnect", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-account-")) }));
  const server = createServer(built.app, {
    replayDedupe: createPostgresReplayDedupe(testDatabaseUrl()),
    signingSecret: SECRET,
    requireSignedPortalIdentity: true,
    capabilitySecret: SECRET + "capability",
    portalIdentitySecret: SECRET + "portal",
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    auditLog: built.auditLog,
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  async function request(account: unknown, principalId = "alice", signedIn = "alice") {
    const path = "/v1/user-model-auth/account";
    const body = JSON.stringify({ account, principalId, nonce: crypto.randomUUID() });
    const ts = Math.floor(Date.now() / 1000);
    return fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n${body}`),
        "x-portal-identity": await mintPortalIdentity({ p: signedIn, exp: Date.now() + 60_000 }, SECRET + "portal"),
      },
      body,
    });
  }
  try {
    assert.equal((await request("personal")).status, 409);
    assert.equal((await request("invalid")).status, 400);
    await built.userModelCredentials.setApiKey("alice", "anthropic", "test-personal-key");
    assert.equal((await request("personal", "bob", "alice")).status, 403);
    const enabled = await request("personal");
    assert.equal(enabled.status, 200);
    assert.deepEqual(await enabled.json(), {
      individualModelAuth: true,
      required: false,
      account: "personal",
      connections: [{ provider: "anthropic", kind: "apikey" }],
    });
    assert.equal(await built.config.getIndividualModelAuthDurable("bob"), false);
    assert.equal((await request("company")).status, 200);
    assert.equal((await built.userModelCredentials.connections("alice")).length, 1);
    assert.equal((await request("personal")).status, 200);
    await built.userModelCredentials.delete("alice", "anthropic");
    assert.equal(await built.config.getIndividualModelAuthDurable("alice"), true);
    assert.equal((await request("company")).status, 200);
    await built.config.setIndividualModelAuth(true);
    assert.equal((await request("company")).status, 403);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("personal provider choice is durable and controls the submitted run independently of the company model", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-routing-")) }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "test-anthropic-key");
  await built.userModelCredentials.setApiKey("U1", "openai", "test-openai-key");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "personal-provider-choice" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "company-only-custom-model",
  });
  const run = await built.runs.get(submitted.runId!);
  assert.equal(run?.request.modelAccount, "openai");
  assert.equal(run?.request.model, undefined);
  await built.config.setPersonalModelAuth("U1", false);
  assert.equal((await built.runs.get(submitted.runId!))?.request.modelAccount, "openai");
  const steered = await built.app.signalRun(submitted.runId!, { kind: "steer", text: "more work" }, "U1");
  assert.equal(steered.accepted, false);
  assert.match(steered.reason ?? "", /account_changed/);
  assert.equal((await built.app.signalRun(submitted.runId!, { kind: "abort" }, "U1")).accepted, true);
});

test("shared chat messages queue instead of borrowing another person's account", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "personal-steering-")) }));
  const message = (user: string) => ({
    surface: "slack",
    actor: { externalId: user },
    conversation: { kind: "channel" as const, threadRef: "account-steering", channelRef: "C1" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  await built.config.setPersonalModelAuth("U1", true, "anthropic");
  const first = await built.app.turn(message("U1"));
  const other = await built.app.turn(message("U2"));
  assert.notEqual(first.runId, other.runId);
  assert.notEqual(other.steered, true);
  assert.equal((await built.runs.get(other.runId!))?.request.modelAccount, "company");
  assert.equal((await built.signals.takePending(first.runId!)).length, 0);
});
