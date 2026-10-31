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
