import "./support/auto-fake-sprites.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { createMemoryReplayDedupe, type ReplayDedupe } from "../src/auth/replay-dedupe.ts";
import { readBreakGlassConfig } from "../src/auth/break-glass.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { testConfig } from "./support/test-config.ts";

const ADMIN = "admin-alice@default-org";
const BREAK_GLASS_SECRET = "break-glass-secret-of-sufficient-length";

function durable(): ReplayDedupe {
  const inner = createMemoryReplayDedupe();
  return { durable: true, claim: (id, exp) => inner.claim(id, exp) };
}

function start(opts: { breakGlass?: boolean; passwordSignIn?: boolean } = {}) {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "password-routes-")),
      passwordSignIn: opts.passwordSignIn ?? true,
    }),
  );
  const breakGlass = opts.breakGlass
    ? readBreakGlassConfig({
        QM_BREAK_GLASS_PRINCIPAL: "rescue@example.com",
        QM_BREAK_GLASS_SECRET: BREAK_GLASS_SECRET,
      })
    : undefined;
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    sessions: built.sessions,
    auditLog: built.auditLog,
    identity: built.identity,
    directory: built.directory,
    ...(built.passwordCredentials ? { passwordCredentials: built.passwordCredentials } : {}),
    replayDedupe: durable(),
    ...(breakGlass ? { breakGlass } : {}),
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const admin = (base: string, method: string, path: string, body?: unknown, actor = ADMIN) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "x-admin-actor": actor, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const verify = (base: string, identifier: string, password: string, ip = "10.0.0.1") =>
  fetch(`${base}/v1/auth/broker/password/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password, ip }),
  });

test("an administrator creates an account and the broker can verify it", async () => {
  const s = start();
  try {
    const created = await admin(s.base, "POST", "/v1/admin/accounts", {
      principalId: "Ops@Example.com",
      displayName: "Ops",
      password: "issued-by-admin",
    });
    assert.equal(created.status, 200);
    assert.deepEqual(await created.json(), {
      ok: true,
      principalId: "Ops@Example.com",
      displayName: "Ops",
      mustChange: true,
    });

    // The member now exists in the directory, not only in the credential store.
    assert.ok(await s.built.directory.get("ops@example.com"));

    const ok = await verify(s.base, "ops@example.com", "issued-by-admin");
    assert.deepEqual(await ok.json(), { ok: true, principalId: "Ops@Example.com", mustChange: true });

    const wrong = await verify(s.base, "ops@example.com", "not-it");
    assert.deepEqual(await wrong.json(), { ok: false });
    const unknown = await verify(s.base, "nobody@example.com", "not-it");
    assert.deepEqual(await unknown.json(), { ok: false });
    assert.equal(wrong.status, unknown.status);
  } finally {
    await s.close();
  }
});

test("only an email address may be an identifier, and a duplicate is refused", async () => {
  const s = start();
  try {
    const bad = await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "ops", password: "issued-by-admin" });
    assert.equal(bad.status, 400);
    const weak = await admin(s.base, "POST", "/v1/admin/accounts", {
      principalId: "ops@example.com",
      password: "short",
    });
    assert.equal(weak.status, 400);
    assert.equal(
      (await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "ops@example.com", password: "issued-ok" }))
        .status,
      200,
    );
    assert.equal(
      (await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "OPS@example.com", password: "issued-ok" }))
        .status,
      409,
    );
  } finally {
    await s.close();
  }
});

test("account management is refused to anyone without an admin grant", async () => {
  const s = start();
  try {
    for (const [method, path, body] of [
      ["GET", "/v1/admin/accounts", undefined],
      ["POST", "/v1/admin/accounts", { principalId: "x@example.com", password: "issued-by-admin" }],
      ["PUT", "/v1/admin/accounts/x@example.com/password", { password: "issued-by-admin" }],
      ["PUT", "/v1/admin/accounts/x@example.com/active", { active: false }],
      ["DELETE", "/v1/admin/accounts/x@example.com", undefined],
    ] as const) {
      const r = await admin(s.base, method, path, body, "user-uma@default-org");
      assert.equal(r.status, 403, `${method} ${path} should be forbidden`);
    }
  } finally {
    await s.close();
  }
});

test("a deactivated account cannot sign in even with the right password", async () => {
  const s = start();
  try {
    await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "ops@example.com", password: "issued-by-admin" });
    assert.equal((await verify(s.base, "ops@example.com", "issued-by-admin")).status, 200);
    assert.equal(((await (await verify(s.base, "ops@example.com", "issued-by-admin")).json()) as any).ok, true);

    // An absent or non-boolean `active` must not read as "deactivate".
    for (const bad of [{}, { active: "false" }, { active: 0 }, { enabled: false }]) {
      const r = await admin(s.base, "PUT", "/v1/admin/accounts/ops@example.com/active", bad);
      assert.equal(r.status, 400, `body ${JSON.stringify(bad)} must be refused, not read as deactivate`);
    }
    const off = await admin(s.base, "PUT", "/v1/admin/accounts/ops@example.com/active", { active: false });
    assert.equal(off.status, 200);
    assert.deepEqual(await (await verify(s.base, "ops@example.com", "issued-by-admin")).json(), { ok: false });

    const on = await admin(s.base, "PUT", "/v1/admin/accounts/ops@example.com/active", { active: true });
    assert.equal(on.status, 200);
    assert.equal(((await (await verify(s.base, "ops@example.com", "issued-by-admin")).json()) as any).ok, true);
  } finally {
    await s.close();
  }
});

test("an administrator reset requires a new password at the next sign-in", async () => {
  const s = start();
  try {
    await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "ops@example.com", password: "issued-by-admin" });
    const change = await fetch(`${s.base}/v1/auth/broker/password/change`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "ops@example.com", password: "issued-by-admin", next: "chosen-by-ops" }),
    });
    assert.equal(change.status, 200);
    assert.equal(((await (await verify(s.base, "ops@example.com", "chosen-by-ops")).json()) as any).mustChange, false);

    const reset = await admin(s.base, "PUT", "/v1/admin/accounts/ops@example.com/password", {
      password: "reissued-by-admin",
    });
    assert.equal(reset.status, 200);
    const after = (await (await verify(s.base, "ops@example.com", "reissued-by-admin")).json()) as any;
    assert.equal(after.ok, true);
    assert.equal(after.mustChange, true);
  } finally {
    await s.close();
  }
});

test("an administrator cannot lock themselves out through this page", async () => {
  const s = start();
  try {
    await admin(s.base, "POST", "/v1/admin/accounts", {
      principalId: "admin-alice@example.com",
      password: "issued-by-admin",
    });
    // The admin actor header resolves to "admin-alice"; guard on the same person.
    const self = await admin(
      s.base,
      "PUT",
      "/v1/admin/accounts/admin-alice/active",
      { active: false },
      "admin-alice@default-org",
    );
    assert.equal(self.status, 400);
  } finally {
    await s.close();
  }
});

test("break-glass is absent unless it was configured at boot", async () => {
  const s = start();
  try {
    const r = await fetch(`${s.base}/v1/auth/break-glass`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BREAK_GLASS_SECRET}` },
      body: JSON.stringify({ principalId: "rescue@example.com", password: "recovered-by-hand" }),
    });
    assert.equal(r.status, 404);
  } finally {
    await s.close();
  }
});

test("break-glass restores one named principal, and only with the boot secret", async () => {
  const s = start({ breakGlass: true });
  const call = (headers: Record<string, string>, body: unknown) =>
    fetch(`${s.base}/v1/auth/break-glass`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await call({}, { principalId: "rescue@example.com", password: "recovered-by-hand" })).status,
      403,
      "no secret",
    );
    assert.equal(
      (
        await call(
          { authorization: "Bearer wrong" },
          { principalId: "rescue@example.com", password: "recovered-by-hand" },
        )
      ).status,
      403,
      "wrong secret",
    );
    assert.equal(
      (
        await call(
          { authorization: `Bearer ${BREAK_GLASS_SECRET}` },
          {
            principalId: "someone-else@example.com",
            password: "recovered-by-hand",
          },
        )
      ).status,
      403,
      "a principal the configuration does not cover",
    );

    const ok = await call(
      { authorization: `Bearer ${BREAK_GLASS_SECRET}` },
      {
        principalId: "rescue@example.com",
        password: "recovered-by-hand",
      },
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, mustChange: true });

    const verdict = (await (await verify(s.base, "rescue@example.com", "recovered-by-hand")).json()) as any;
    assert.equal(verdict.ok, true);
    assert.equal(verdict.mustChange, true, "the recovered account must still choose its own password");

    const grants = await s.built.admin.listGrants();
    assert.ok(
      grants.some((g) => g.principalId === "rescue@example.com"),
      "administrator access is what break-glass restores",
    );

    const audit = await s.built.auditLog.events();
    assert.ok(audit.some((e) => e.action === "break-glass.recover"));
    assert.ok(audit.some((e) => e.action === "break-glass.refused"));
  } finally {
    await s.close();
  }
});

test("with QM_PASSWORD_SIGN_IN off the routes do not exist and no credential table is created", async () => {
  const s = start({ passwordSignIn: false, breakGlass: true });
  try {
    assert.equal(s.built.passwordCredentials, undefined);
    assert.equal((await verify(s.base, "ops@example.com", "issued-by-admin")).status, 404);
    assert.equal((await admin(s.base, "GET", "/v1/admin/accounts")).status, 404);
    const rescue = await fetch(`${s.base}/v1/auth/break-glass`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BREAK_GLASS_SECRET}` },
      body: JSON.stringify({ principalId: "rescue@example.com", password: "recovered-by-hand" }),
    });
    assert.equal(rescue.status, 404, "break-glass is meaningless with no credential to reset");
  } finally {
    await s.close();
  }
});

test("a deactivation on another replica is honoured immediately, not after the refresh interval", async () => {
  const s = start();
  try {
    await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "ops@example.com", password: "issued-by-admin" });
    // Warm this replica's cache, then deactivate through a second service over
    // the same durable store — which is what a second core replica is.
    assert.equal(((await (await verify(s.base, "ops@example.com", "issued-by-admin")).json()) as any).ok, true);

    const other = createIdentityService(s.built.identityStore);
    await other.deactivate("ops@example.com", "manual");

    // No waiting for REFRESH_TTL_MS: an admission decision reads the record.
    assert.equal(s.built.identity.classify("ops@example.com").type, "internal", "the cache is indeed still stale");
    assert.deepEqual(await (await verify(s.base, "ops@example.com", "issued-by-admin")).json(), { ok: false });
    assert.equal((await s.built.identity.classifyFresh("ops@example.com")).type, "guest");
  } finally {
    await s.close();
  }
});

test("the attempt limiter behaves the same for an identifier with an account and one without", async () => {
  const s = start();
  try {
    await admin(s.base, "POST", "/v1/admin/accounts", { principalId: "ops@example.com", password: "issued-by-admin" });
    // Eleven wrong attempts each. The eleventh is refused by the limiter for
    // both, so being rate-limited says nothing about who has an account.
    const run = async (identifier: string): Promise<number[]> => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) statuses.push((await verify(s.base, identifier, `wrong-${i}`, "10.0.0.9")).status);
      return statuses;
    };
    assert.deepEqual(await run("ops@example.com"), await run("nobody@example.com"));
  } finally {
    await s.close();
  }
});

test("a break-glass call whose grant fails reports failure rather than success", async () => {
  const s = start({ breakGlass: true });
  const admin_ = s.built.admin;
  const original = admin_.forceGrantOrgAdmin.bind(admin_);
  admin_.forceGrantOrgAdmin = async () => {
    throw new Error("grant store is away");
  };
  try {
    const r = await fetch(`${s.base}/v1/auth/break-glass`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${BREAK_GLASS_SECRET}` },
      body: JSON.stringify({ principalId: "rescue@example.com", password: "recovered-by-hand" }),
    });
    assert.equal(r.status, 500);
    const audit = await s.built.auditLog.events();
    assert.ok(
      audit.some((e) => e.action === "break-glass.recover" && e.status === "partial"),
      "the partial recovery is what the audit log must say",
    );
    assert.ok(
      !audit.some((e) => e.action === "break-glass.recover" && e.status === "ok"),
      "and it must not also claim success",
    );
  } finally {
    admin_.forceGrantOrgAdmin = original;
    await s.close();
  }
});
