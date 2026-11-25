import { test } from "node:test";
import assert from "node:assert/strict";
import { handleModelBudgetCap } from "../src/core/orchestrator/model-budget.ts";
import { MODEL_BUDGET_TEXT } from "../src/core/turn-error.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import type { AdminGrant, AdminService } from "../src/admin/admin-service.ts";
import { withTenant } from "../src/tenants/context.ts";
import { TEST_TENANT } from "./support/test-tenant.ts";
import { scopeId, type Principal } from "../src/types.ts";

const URL = "https://qm.example.com";
const admin1: Principal = { id: "admin1@example.com", type: "internal" };
const member: Principal = { id: "member@example.com", type: "internal" };
const guest: Principal = { id: "guest@other.com", type: "guest" };
const grants: AdminGrant[] = [
  { principalId: "admin1@example.com", role: "org_admin", scopeId: scopeId("org", "acme") },
  { principalId: "owner1@example.com", role: "owner", scopeId: scopeId("org", "acme") },
];
const fakeAdmin = {
  listGrants: async () => grants,
} as Pick<AdminService, "listGrants"> as AdminService;
const userCreds = {} as NonNullable<Parameters<typeof handleModelBudgetCap>[0]["userModelCredentials"]>;

test("cap hit in DM tailors copy for admin vs member, notifies admins once per day, and shields external audiences", () =>
  withTenant(TEST_TENANT, async (tenant) => {
    const deliveries = createDeliveryStore();
    const deps = { admin: fakeAdmin, deliveries, publicWebUrl: URL, userModelCredentials: userCreds };

    const adminMsg = await handleModelBudgetCap(deps, tenant, { kind: "dm" }, admin1, false);
    assert.match(adminMsg, /https:\/\/qm\.example\.com\/settings\/onboarding/);
    const afterAdmin = await deliveries.claimPending("principal", 60_000);
    assert.deepEqual(
      afterAdmin.map((d) => d.destination.target),
      ["owner1@example.com"],
    );

    const memberMsg = await handleModelBudgetCap(deps, tenant, { kind: "dm" }, member, false);
    assert.match(memberMsg, /https:\/\/qm\.example\.com\/settings\b/);
    assert.match(memberMsg, /Claude or ChatGPT/);
    const afterMember = await deliveries.claimPending("principal", 60_000);
    assert.deepEqual(
      afterMember.map((d) => d.destination.target),
      ["admin1@example.com"],
      "owner1 already notified today; admin1 now gets the DM",
    );

    const extMsg = await handleModelBudgetCap(deps, tenant, { kind: "channel" }, guest, true);
    assert.equal(extMsg, MODEL_BUDGET_TEXT);
    assert.doesNotMatch(extMsg, /qm\.example\.com/);
  }));
