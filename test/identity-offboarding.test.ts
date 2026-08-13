import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "offboarding-secret".repeat(3);

const member = (principalId: string) => ({ principalId, displayName: principalId, type: "internal" as const });

describe("offboarding: directory sync and the /v1/principals routes drive deactivation (§3)", () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const signedPost = (path: string) => {
    const ts = Math.floor(Date.now() / 1000);
    return fetch(`${base}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-timestamp": String(ts),
        "x-signature": signRequest(SECRET, ts, `POST\n${path}\n`),
      },
    });
  };

  before(async () => {
    built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "offboarding-")),
        signingSecret: SECRET,
      }),
    );
    await built.identity.hydrate();
    server = createServer(built.app, { signingSecret: SECRET, identity: built.identity, auditLog: built.auditLog });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a roster swap that drops a member deactivates them; reappearing reactivates", async () => {
    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
    assert.equal(built.identity.classify("U-leave").type, "internal");

    await built.app.upsertDirectory([member("U-stay")]);
    assert.equal(built.identity.classify("U-leave").type, "guest");
    assert.equal(built.identity.classify("U-stay").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.deactivate" && e.principalId === "U-leave"),
    );

    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
    assert.equal(built.identity.classify("U-leave").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.reactivate" && e.principalId === "U-leave"),
    );
  });

  it("a directory sync cannot deactivate a durable identity it did not create", async () => {
    await built.directory.replace([
      { principalId: "portal@example.com", displayName: "Portal User", type: "internal" },
      { principalId: "U-slack", displayName: "Slack User", type: "internal", identitySource: "directory-sync" },
    ]);

    await built.app.upsertDirectory([]);

    assert.equal(built.identity.classify("portal@example.com").type, "internal");
    assert.equal(built.identity.deactivation("portal@example.com"), null);
    assert.equal(built.identity.classify("U-slack").type, "guest");
    assert.equal(built.identity.deactivation("U-slack")?.identitySource, "directory-sync");
    await built.app.upsertDirectory([member("U-stay"), member("U-leave")]);
  });

  it("a portal-owned identity remains portal-owned after appearing in a Slack snapshot", async () => {
    await built.directory.replace([
      { principalId: "Portal@Example.com", displayName: "Portal User", type: "internal" },
    ]);

    await built.app.upsertDirectory([
      {
        principalId: "portal@example.com",
        displayName: "Portal User from Slack",
        type: "internal",
        slackId: "U-portal",
      },
    ]);
    await built.app.upsertDirectory([]);

    assert.equal(built.identity.deactivation("portal@example.com"), null);
    const stored = await built.directory.get("portal@example.com");
    assert.equal(stored?.identitySource, undefined);
    assert.equal(stored?.displayName, "Portal User from Slack");
  });

  it("a guest-shaped source row cannot erase or claim a portal-owned identity", async () => {
    await built.directory.replace([
      { principalId: "portal-guest@example.com", displayName: "Portal Guest", type: "internal" },
    ]);
    await built.app.upsertDirectory([
      { principalId: "portal-guest@example.com", displayName: "Slack Guest", type: "guest" },
    ]);
    assert.equal(built.identity.deactivation("portal-guest@example.com"), null);
    assert.equal((await built.directory.get("portal-guest@example.com"))?.identitySource, undefined);
  });

  it("newer roster state wins when concurrent sync calls finish in the opposite order", async () => {
    await built.app.upsertDirectory([member("ordered@example.com")], 1000);
    await Promise.all([
      built.app.upsertDirectory([member("ordered@example.com")], 3000),
      built.app.upsertDirectory([], 2000),
    ]);
    assert.equal(built.identity.deactivation("ordered@example.com"), null);
  });

  it("the deactivate/reactivate routes flip classification and are audited", async () => {
    const off = await signedPost("/v1/principals/U-manual/deactivate");
    assert.equal(off.status, 200);
    assert.deepEqual(await off.json(), { ok: true, principalId: "U-manual", active: false });
    assert.equal(built.identity.classify("U-manual").type, "guest");

    await built.app.upsertDirectory([member("U-manual")]);
    assert.equal(built.identity.classify("U-manual").type, "guest");

    const on = await signedPost("/v1/principals/U-manual/reactivate");
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { ok: true, principalId: "U-manual", active: true });
    assert.equal(built.identity.classify("U-manual").type, "internal");
    assert.ok(
      (await built.auditLog.events()).some((e) => e.action === "principal.reactivate" && e.principalId === "U-manual"),
    );
  });

  it("an agent capability token cannot reach the principals routes (source-auth only)", async () => {
    const cap = await mintCapabilityToken(
      { actorId: "U-stay", scopeId: scopeId("personal", "U-stay"), exp: Date.now() + CAPABILITY_TTL_MS },
      SECRET,
    );
    const res = await fetch(`${base}/v1/principals/U-stay/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
    });
    assert.equal(res.status, 403);
  });
});
