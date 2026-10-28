import assert from "node:assert/strict";
import test from "node:test";
import { createTenantSlack } from "../src/boot.ts";
import { loadConfig } from "../src/config.ts";
import { registerTenantSettings, tenant, tenantFor, withTenant, type Tenant } from "../src/tenant.ts";
import type { buildApp } from "../src/wiring.ts";

const acme = tenantFor("acme-slack", "21111111-0000-4000-8000-00000000a001", "acme-slack");
const beta = tenantFor("beta-slack", "21111111-0000-4000-8000-00000000b002", "beta-slack");
const gamma = tenantFor("gamma-slack", "21111111-0000-4000-8000-00000000c003", "gamma-slack");
registerTenantSettings(
  [acme, beta, gamma].map((t) => ({
    id: t.id!,
    slug: t.slug!,
    orgId: t.orgId,
    hosts: [],
    status: "active" as const,
    oidcAdmin: false,
    secrets: {},
  })),
);

function tenantSlack() {
  const loads: Array<string | undefined> = [];
  const listeners: Array<() => void> = [];
  const built = {
    slackInstallation: {
      status: async () => ({ configured: false, managed: false }),
      get: async () => {
        loads.push(tenant().id);
        return null;
      },
      onChange: (cb: () => void) => {
        listeners.push(cb);
        return () => {};
      },
      close: async () => {},
    },
    slackCore: {},
  } as unknown as ReturnType<typeof buildApp>;
  const slack = createTenantSlack({ env: {}, config: loadConfig({}), built, slackConfig: null, running: true });
  const changed = (t: Tenant) => withTenant(t, () => listeners.forEach((cb) => cb()));
  return { slack, loads, changed };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a tenant's Slack receiver never polls, reloads on an installation change, and is evicted when idle", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const { slack, loads, changed } = tenantSlack();
  const first = withTenant(acme, slack.ensure);
  await flush();
  assert.deepEqual(loads, [acme.id]);
  t.mock.timers.tick(31 * 60_000);
  await flush();
  assert.deepEqual(loads, [acme.id]);
  changed(acme);
  changed(beta);
  await flush();
  assert.deepEqual(loads, [acme.id, acme.id]);
  t.mock.timers.tick(31 * 60_000);
  withTenant(beta, slack.ensure);
  await flush();
  assert.equal(first.runtime.ready(), false);
  assert.notEqual(withTenant(acme, slack.ensure), first);
});

test("a retired tenant's Slack receiver is dropped, and re-activating the tenant builds a fresh one", async () => {
  const { slack, loads, changed } = tenantSlack();
  const first = withTenant(gamma, slack.ensure);
  await flush();
  slack.sync([acme]);
  await flush();
  changed(gamma);
  await flush();
  assert.deepEqual(loads, [gamma.id]);
  const again = withTenant(gamma, slack.ensure);
  assert.notEqual(again, first);
  await flush();
  assert.deepEqual(loads, [gamma.id, gamma.id]);
});
