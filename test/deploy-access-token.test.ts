import { test } from "node:test";
import assert from "node:assert/strict";
import { mintDeployGitAccess, verifyDeployGitAccess } from "../src/deploy/access-token.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";

const secret = "edge-secret";

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

test("Git credentials retain valid computer authority and refuse malformed computer claims", async () => {
  for (const personalOnly of [false, true]) {
    const context = {
      scopeId: "personal:alice",
      sessionId: "session",
      computer: { personalOnly, resourceId: "computer" },
    };
    const token = await mintDeployGitAccess(secret, {
      deploymentId: "app",
      principalId: "alice",
      permission: "read",
      context,
      exp: 10_000,
    });
    assert.deepEqual((await verifyDeployGitAccess(secret, token, 5_000))?.context, context);
  }
  for (const computer of [null, {}, [], { personalOnly: "true" }, { personalOnly: true, resourceId: "" }]) {
    const token = await mintDeployGitAccess(secret, {
      deploymentId: "app",
      principalId: "alice",
      permission: "read",
      context: { computer } as never,
      exp: 10_000,
    });
    assert.equal(await verifyDeployGitAccess(secret, token, 5_000), null);
  }
});
