import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createSlackInstallationStore } from "../src/surfaces/slack-installation.ts";
import { createTenantSlackRuntimes } from "../src/surfaces/slack-tenants.ts";
import { testMap } from "./support/test-database.ts";
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

  it("starts a runtime for a tenant whose Slack install appears after start, without an install notification", async () => {
    const [a] = db.tenants;
    const late = randomUUID();
    await db.owner.q("INSERT INTO tenants(id) VALUES ($1)", [late]);
    const started: string[] = [];
    const runtimes = createTenantSlackRuntimes({
      runtimeFor: (tenant) => ({
        start: () => void started.push(tenant.id),
        reconcile: async () => {},
        stop: async () => {},
      }),
      tenants: () => tenantLookup(db.app).slackTenants(),
      onError: (error) => assert.fail(String(error)),
      discoveryIntervalMs: 10,
    });
    runtimes.start();
    for (let i = 0; i < 200 && !started.includes(a!); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(!started.includes(late));
    await db.owner.q(`INSERT INTO slack_installation(tenant_id, id, json) VALUES ($1, 'org', $2)`, [
      late,
      JSON.stringify({ teamId: "T-late" }),
    ]);
    for (let i = 0; i < 200 && !started.includes(late); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    await runtimes.stop();
    assert.ok(started.includes(late));
  });

  it("tells listeners when an admin saves Slack tokens, in the saving request's tenant", async () => {
    const store = createSlackInstallationStore("org", testMap(), "k".repeat(32));
    const heard: (string | undefined)[] = [];
    store.onSet(() => heard.push(boundTenant()));
    const tenant = boundTenant();
    await store.set({ botToken: "xoxb-1", updatedBy: "admin" });
    assert.deepEqual(heard, [tenant]);
  });
});
