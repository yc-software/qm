import "../support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { createIdentityService } from "../../src/identity/identity-service.ts";
import type { ExternalMember } from "../../src/identity/external-members.ts";
import { testDatabaseUrl } from "../support/test-database.ts";
import { mock, test } from "node:test";
import * as identityModule from "../../src/identity/identity-service.ts";
import * as configModule from "../../src/resolution/config-store.ts";
import { settle } from "../support/settle.ts";
import { testConfig } from "../support/test-config.ts";

const databaseUrl = testDatabaseUrl();
const id = createIdentityService(databaseUrl);

test("classifies a same-org member as internal", () => {
  const p = id.classify("U1");
  assert.equal(p.type, "internal");
  assert.equal(id.isInternal(p), true);
});

test("classifies a flagged Slack Connect user as guest", () => {
  const p = id.classify("U2", true);
  assert.equal(p.type, "guest");
  assert.equal(id.isInternal(p), false);
});

test("resolves bot assertions as internal automation callers", () => {
  const p = id.resolve({ externalId: "B1", isBot: true });
  assert.equal(p.type, "internal");
  assert.equal(id.isInternal(p), true);
});

test("audienceIsAllInternal is false if any member is non-internal (G1)", () => {
  const internal = id.classify("U1");
  const guest = id.classify("U2", true);
  assert.equal(id.audienceIsAllInternal([internal]), true);
  assert.equal(id.audienceIsAllInternal([internal, guest]), false);
});

test("audienceIsAllInternal is false for an empty audience (unknown ≠ all-internal)", () => {
  assert.equal(id.audienceIsAllInternal([]), false);
});

test("a deactivated principal classifies as non-internal (fail-closed source, §3)", async () => {
  const svc = createIdentityService(databaseUrl);
  assert.equal(svc.classify("U-leaver").type, "internal");
  await svc.deactivate("U-leaver");
  const after = svc.classify("U-leaver");
  assert.equal(after.type, "guest");
  assert.equal(svc.isInternal(after), false);
  await svc.reactivate("U-leaver");
  assert.equal(svc.classify("U-leaver").type, "internal");
});

test("deactivation folds email case: a leaver stays out under any casing of their address", async () => {
  const svc = createIdentityService(databaseUrl);
  await svc.deactivate("Alice@Corp.com");
  assert.equal(svc.classify("alice@corp.com").type, "guest");
  assert.equal(svc.classify("ALICE@CORP.COM").type, "guest");
  await svc.reactivate("alice@corp.com");
  assert.equal(svc.classify("Alice@Corp.com").type, "internal");
});

test("case fold does not merge distinct emails or touch non-email ids", async () => {
  const svc = createIdentityService(databaseUrl);
  await svc.deactivate("bob@corp.com");
  assert.equal(svc.classify("bobby@corp.com").type, "internal");
  await svc.deactivate("U-Case");
  assert.equal(svc.classify("u-case").type, "internal");
});

test("deactivation is durable: a fresh service over the same backing rehydrates it, folding case", async () => {
  const backing = testDatabaseUrl();
  await createIdentityService(backing).deactivate("Carol@Corp.com");
  const second = createIdentityService(backing);
  assert.equal(second.classify("carol@corp.com").type, "internal");
  await second.hydrate();
  assert.equal(second.classify("carol@corp.com").type, "guest");
});

test("a running instance refreshes deactivations written by another instance", async () => {
  const backing = testDatabaseUrl();
  const writer = createIdentityService(backing);
  const reader = createIdentityService(backing);
  await reader.hydrate();
  await writer.deactivate("U-leaver");
  assert.equal(reader.classify("U-leaver").type, "internal");
  await reader.refresh();
  assert.equal(reader.classify("U-leaver").type, "guest");
});

test("external members written by one instance reach another over the same backing", async () => {
  const writer = createIdentityService(databaseUrl);
  const reader = createIdentityService(databaseUrl);
  await reader.hydrate();
  const now = Date.now();
  const member = (expiresAt: number): ExternalMember => ({
    email: "pat@partner.example",
    role: "member",
    expiresAt,
    invitedBy: "admin-alice",
    createdAt: now,
    updatedAt: now,
  });
  await writer.putExternalMember(member(now + 60_000));
  assert.equal(reader.externalMember("pat@partner.example"), undefined);
  await reader.refresh();
  assert.equal(reader.externalMember("Pat@Partner.example")?.expiresAt, now + 60_000);
  assert.equal(reader.classify("pat@partner.example").type, "internal");

  await writer.putExternalMember(member(now - 1));
  await reader.refresh();
  assert.equal(reader.classify("pat@partner.example").type, "internal", "within the TTL the cache is served");
  await reader.refresh(true);
  assert.equal(reader.classify("pat@partner.example").type, "guest", "a forced refresh reads the store");
  const late = createIdentityService(databaseUrl);
  await late.hydrate();
  assert.equal(late.classify("pat@partner.example").type, "guest");
});

test("a directory sync deactivates dropped members and self-heals when they reappear", async () => {
  const svc = createIdentityService(databaseUrl);
  const out = await svc.recordDirectorySync(["U-gone"], ["U-here"]);
  assert.deepEqual(out, { deactivated: ["U-gone"], reactivated: [] });
  assert.equal(svc.classify("U-gone").type, "guest");

  const back = await svc.recordDirectorySync([], ["U-gone", "U-here"]);
  assert.deepEqual(back, { deactivated: [], reactivated: ["U-gone"] });
  assert.equal(svc.classify("U-gone").type, "internal");
});

test("a manual deactivation survives roster churn — only reactivate() clears it", async () => {
  const svc = createIdentityService(databaseUrl);
  await svc.deactivate("U-fired");
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.recordDirectorySync(["U-fired"], []);
  await svc.recordDirectorySync([], ["U-fired"]);
  assert.equal(svc.classify("U-fired").type, "guest");
  await svc.reactivate("U-fired");
  assert.equal(svc.classify("U-fired").type, "internal");
});

test("a teammate without an expiry stays active after another instance reloads it", async () => {
  const now = Date.now();
  const teammate: ExternalMember = {
    email: "sam@partner.example",
    role: "member",
    expiresAt: null,
    kind: "teammate",
    invitedBy: "admin-alice",
    createdAt: now,
    updatedAt: now,
  };
  await createIdentityService(databaseUrl).putExternalMember(teammate);
  const reader = createIdentityService(databaseUrl);
  await reader.hydrate();
  assert.deepEqual(reader.externalMember("sam@partner.example"), teammate);
  assert.equal(reader.classify("sam@partner.example").type, "internal");
});

const identityFailure = new Error("identity persistence unavailable");
const configFailure = new Error("configuration persistence unavailable");

mock.module("../../src/identity/identity-service.ts", {
  namedExports: {
    ...identityModule,
    createIdentityService: (...args: Parameters<typeof identityModule.createIdentityService>) => ({
      ...identityModule.createIdentityService(...args),
      hydrate: async () => {
        throw identityFailure;
      },
    }),
  },
});
mock.module("../../src/resolution/config-store.ts", {
  namedExports: {
    ...configModule,
    createConfigStore: (...args: Parameters<typeof configModule.createConfigStore>) => ({
      ...configModule.createConfigStore(...args),
      hydrate: async () => {
        throw configFailure;
      },
    }),
  },
});

const { buildApp } = await import("../support/build-app.ts");

test("eager hydration failures are contained while explicit startup hydration remains fail-closed", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const built = buildApp(testConfig());
  try {
    const logged = (context: string) =>
      errors.mock.calls.some(({ arguments: args }) => String(args[0]).includes(context));
    await settle(async () => logged("startup: hydrate identity") && logged("startup: hydrate configuration"));
    assert.ok(logged("startup: hydrate identity"));
    assert.ok(logged("startup: hydrate configuration"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(built.identity.hydrate(), (error: unknown) => error === identityFailure);
      await assert.rejects(built.config.hydrate!(), (error: unknown) => error === configFailure);
    }
  } finally {
    await built.runtime.stop();
  }
});

test("a deactivation that fails to persist leaves the principal active so a retry can still deactivate", async () => {
  const unreachable = new URL(databaseUrl);
  unreachable.port = "1";
  const svc = createIdentityService(unreachable.toString());
  await assert.rejects(() => svc.deactivate("U-flaky"));
  assert.equal(svc.classify("U-flaky").type, "internal");
  assert.equal(svc.deactivationSource("U-flaky"), undefined);
});
