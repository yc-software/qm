import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createTenantSlackRuntimes } from "../src/surfaces/slack-tenants.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { tenantLookup } from "../src/tenants/lookup.ts";
import { twoTenants, type TwoTenants } from "./support/two-tenants.ts";

describe("per-tenant Slack runtimes", () => {
  let db: TwoTenants;

  before(async () => {
    db = await twoTenants();
    for (const [i, tenant] of db.tenants.entries())
      await db.owner.q(`INSERT INTO slack_installation(tenant_id, id, json) VALUES ($1, 'org', $2)`, [
        tenant,
        JSON.stringify({ teamId: `T${i}`, disabled: i === 1 }),
      ]);
  });

  after(() => db?.close());

  it("lists only tenants with an active installation through the definer function as the app login", async () => {
    const [a, b] = db.tenants;
    assert.deepEqual(await tenantLookup(db.app).slackTenants(), [a]);
    await db.owner.q(`UPDATE slack_installation SET json = json - 'disabled' WHERE tenant_id = $1`, [b]);
    assert.deepEqual((await tenantLookup(db.app).slackTenants()).sort(), [a, b].sort());
  });

  it("runs one runtime per tenant, each bound to its tenant, and starts a new install's tenant on reconcile", async () => {
    const [a, b] = db.tenants;
    const events: string[] = [];
    const runtimes = createTenantSlackRuntimes({
      runtimeFor: (tenant) => {
        events.push(`create ${tenant} in ${boundTenant()}`);
        return {
          start: () => void events.push(`start ${tenant} in ${boundTenant()}`),
          reconcile: async () => void events.push(`reconcile ${tenant} in ${boundTenant()}`),
          stop: async () => void events.push(`stop ${tenant}`),
        };
      },
      tenants: async () => [undefined, a, a],
      onError: (error) => assert.fail(String(error)),
    });
    runtimes.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [`create ${a} in ${a}`, `start ${a} in ${a}`]);
    await withTenant(b!, () => runtimes.reconcile());
    assert.deepEqual(events.slice(2), [`create ${b} in ${b}`, `start ${b} in ${b}`, `reconcile ${b} in ${b}`]);
    await runtimes.stop();
    assert.deepEqual(events.slice(5).sort(), [`stop ${a}`, `stop ${b}`].sort());
  });
});
