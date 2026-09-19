import { test } from "node:test";
import assert from "node:assert/strict";
import { deploymentGitToken, mintDeployGitAccess, verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { createTenantContext, runWithTenant } from "../src/tenancy/context.ts";

const secret = "edge-secret";

test("deployment Git credentials preserve Basic password and username fallback", () => {
  const url = new URL("https://core.test/git?token=query-token");
  for (const [value, expected] of [
    ["user:password", "password"],
    ["user:password:with:colons", "password:with:colons"],
    ["user:", "user"],
    [":password", "password"],
    ["user", "user"],
    [":", null],
  ] as const) {
    const token = Buffer.from(value).toString("base64");
    for (const separator of [" ", "\t", "  \t  "]) {
      assert.equal(deploymentGitToken(`bAsIc${separator}${token}`, url), expected);
    }
  }
  assert.equal(deploymentGitToken("Basic !!!", url), null);
});

test("deployment Git Bearer credentials override query credentials and preserve their text", () => {
  const url = new URL("https://core.test/git?token=query-token&access_token=access-token");
  for (const separator of [" ", "\t", "  \t  "]) {
    assert.equal(deploymentGitToken(`bEaReR${separator}header-token`, url), "header-token");
  }
  assert.equal(deploymentGitToken("Bearer header-token ", url), "header-token ");
  for (const authorization of [
    undefined,
    "",
    "Basic",
    "Bearer",
    "Basic ",
    "Bearer\t",
    "Digest token",
    "BearerX token",
  ]) {
    assert.equal(deploymentGitToken(authorization, url), "query-token");
  }
  assert.equal(
    deploymentGitToken(undefined, new URL("https://core.test/git?access_token=access-token")),
    "access-token",
  );
  assert.equal(deploymentGitToken(undefined, new URL("https://core.test/git?token=&access_token=access-token")), "");
  assert.equal(deploymentGitToken(undefined, new URL("https://core.test/git")), null);
});

test("deployment Git credentials handle long whitespace separators and malformed multiline values", () => {
  const url = new URL("https://core.test/git?token=query-token");
  const whitespace = " \t".repeat(32_768);
  const token = Buffer.from("user:password").toString("base64");
  assert.equal(deploymentGitToken(`Basic${whitespace}${token}`, url), "password");
  assert.equal(deploymentGitToken(`Bearer${whitespace}header-token`, url), "header-token");
  for (const scheme of ["Basic", "Bearer"]) {
    for (const suffix of ["", "token\ninvalid", "token\rinvalid", "token\u2028invalid", "token\u2029invalid"]) {
      assert.equal(deploymentGitToken(`${scheme}${whitespace}${suffix}`, url), "query-token");
    }
    assert.equal(
      deploymentGitToken(`${scheme}${whitespace}`, new URL("https://core.test/git?access_token=access-token")),
      "access-token",
    );
  }
});

test("a git-access token carries and validates its permission", async () => {
  for (const permission of ["read", "write"] as const) {
    const tok = await mintDeployGitAccess(secret, { deploymentId: "d1", permission, exp: 10_000 });
    const got = await verifyDeployGitAccess(secret, tok, 5_000);
    assert.equal(got?.deploymentId, "d1");
    assert.equal(got?.permission, permission);
  }
});

test("a git-access token with a missing/invalid permission is rejected", async () => {
  const noPerm = await mintDeployGitAccess(secret, { deploymentId: "d1" } as never);
  assert.equal(await verifyDeployGitAccess(secret, noPerm, 5_000), null);
  const badPerm = await mintDeployGitAccess(secret, { deploymentId: "d1", permission: "admin" } as never);
  assert.equal(await verifyDeployGitAccess(secret, badPerm, 5_000), null);
});

test("git-access tokens minted before the authorization-bound format are invalidated", async () => {
  const legacy = await mintSignedPayload({ deploymentId: "d1", permission: "write", exp: 10_000 }, secret);
  assert.equal(await verifyDeployGitAccess(secret, legacy, 5_000), null);
});

test("deployment Git access binds its tenant even when tenants share signing material", async () => {
  const alpha = createTenantContext({ id: "alpha", env: {}, pooled: true });
  const beta = createTenantContext({ id: "beta", env: {}, pooled: true });
  const token = await runWithTenant(alpha, () =>
    mintDeployGitAccess(secret, {
      deploymentId: "shared-deployment-id",
      permission: "write",
      principalId: "U1",
      exp: 10_000,
    }),
  );
  assert.equal((await runWithTenant(alpha, () => verifyDeployGitAccess(secret, token, 5_000)))?.orgId, "alpha");
  assert.equal(await runWithTenant(beta, () => verifyDeployGitAccess(secret, token, 5_000)), null);
  assert.equal(await verifyDeployGitAccess(secret, token, 5_000, "beta", true), null);
  const legacy = await mintSignedPayload(
    { deploymentId: "shared-deployment-id", permission: "read", version: 1, exp: 10_000 },
    secret,
  );
  assert.ok(await verifyDeployGitAccess(secret, legacy, 5_000));
  assert.equal(await runWithTenant(beta, () => verifyDeployGitAccess(secret, legacy, 5_000)), null);
});
