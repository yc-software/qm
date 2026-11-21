import assert from "node:assert/strict";
import test from "node:test";
import { createTurnSandboxAccess } from "../src/sandbox/sandbox-resources.ts";

const bobBox = { id: "box-bob", ownerScopeId: "personal:bob@x.com", state: "ready" };

function access(orgAdmin: boolean) {
  return createTurnSandboxAccess({
    deps: {
      sandboxResources: { access: async () => bobBox } as any,
      config: {
        refreshSecurity: async () => {},
        getEgress: () => undefined,
        getCommandPolicy: () => null,
      } as any,
    },
    actor: { type: "internal", id: "admin@x.com" } as any,
    resolution: { writableScopeId: "personal:admin@x.com", egress: undefined } as any,
    scopeId: "personal:admin@x.com" as any,
    orgAdmin,
  });
}

test("an org admin's turn can open another person's computer by id, under that computer's own policy", async () => {
  const plan = await access(true).accessResource("box-bob");
  assert.equal(plan.resource.id, "box-bob");
  assert.equal(plan.crossScope, true);
  assert.equal("credentialScopeId" in plan, false, "the owner's credentials are not loaded");
});

test("a non-admin turn still cannot open another person's computer", async () => {
  await assert.rejects(access(false).accessResource("box-bob"), /no longer authorized/);
});
