import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { tenantOrgId } from "../src/config.ts";
import {
  deploymentBrokerCredentialsFromEnv,
  tenantBrokerCredentials,
  withDeploymentCredentials,
} from "../src/credentials/deployment-credentials.ts";
import type { ServiceCredentialStore } from "../src/credentials/keychain.ts";
import { boundTenant, withTenant } from "../src/tenants/context.ts";
import { replaceLoadedTenantSettings, type TenantSettings } from "../src/tenants/settings.ts";
import { scopeId } from "../src/types.ts";

const a = randomUUID();
const b = randomUUID();
const search = (host: string) => [{ slug: "search", host, secretEnv: "BROKER_SECRET_SEARCH" }];
const tenant = (org: string, host: string, secret: string): TenantSettings => ({
  orgId: org,
  env: { BROKER_CREDENTIALS: JSON.stringify(search(host)), BROKER_SECRET_SEARCH: secret },
});

const empty: ServiceCredentialStore = {
  getServiceCredentialSecret: async () => null,
  listServiceCredentials: async () => [],
  setServiceCredential: async () => {},
  setServiceCredentialIfAbsent: async () => 1,
  setServiceCredentialIfCurrent: async () => 1,
  deleteServiceCredential: async () => {},
  deleteServiceCredentialIfCurrent: async () => true,
};

const deployment = deploymentBrokerCredentialsFromEnv({
  BROKER_CREDENTIALS: JSON.stringify(search("api.deployment.example")),
  BROKER_SECRET_SEARCH: "deployment-key",
});
const store = withDeploymentCredentials(
  empty,
  () => scopeId("org", boundTenant() ? tenantOrgId("install-org") : "install-org"),
  tenantBrokerCredentials(deployment),
);

afterEach(() => replaceLoadedTenantSettings(new Map()));

describe("org-shared broker credentials per tenant", () => {
  it("serves each tenant its own credentials in its own org and never another tenant's", async () => {
    replaceLoadedTenantSettings(
      new Map([
        [a, tenant("org-a", "api.a.example", "key-a")],
        [b, tenant("org-b", "api.b.example", "key-b")],
      ]),
    );
    const own = await withTenant(a, () => store.getServiceCredentialSecret(scopeId("org", "org-a"), "search"));
    assert.equal(own?.secret, "key-a");
    assert.equal(own?.host, "api.a.example");
    assert.equal(await withTenant(a, () => store.getServiceCredentialSecret(scopeId("org", "org-b"), "search")), null);
    const listedB = await withTenant(b, () => store.listServiceCredentials(scopeId("org", "org-b")));
    assert.deepEqual(
      listedB.map((c) => [c.slug, c.host, c.source]),
      [["search", "api.b.example", "deployment"]],
    );
    assert.doesNotMatch(JSON.stringify(listedB), /key-a|key-b/);
    assert.deepEqual(await withTenant(b, () => store.listServiceCredentials(scopeId("org", "org-a"))), []);
    await assert.rejects(
      withTenant(b, () =>
        store.setServiceCredential(scopeId("org", "org-b"), {
          slug: "search",
          name: "x",
          host: "evil.example",
          secret: "s",
        }),
      ),
      /supplied by this deployment/,
    );
  });

  it("follows a tenant's settings when they change", async () => {
    replaceLoadedTenantSettings(new Map([[a, tenant("org-a", "api.a.example", "key-a")]]));
    const read = () => withTenant(a, () => store.getServiceCredentialSecret(scopeId("org", "org-a"), "search"));
    assert.equal((await read())?.secret, "key-a");
    replaceLoadedTenantSettings(new Map([[a, tenant("org-a", "api.a.example", "key-a2")]]));
    assert.equal((await read())?.secret, "key-a2");
  });

  it("keeps the deployment set without a tenant or without the tenant's own BROKER_CREDENTIALS", async () => {
    replaceLoadedTenantSettings(new Map([[a, { orgId: "install-org", env: {} }]]));
    const unbound = await store.getServiceCredentialSecret(scopeId("org", "install-org"), "search");
    assert.equal(unbound?.secret, "deployment-key");
    const plain = await withTenant(a, () => store.getServiceCredentialSecret(scopeId("org", "install-org"), "search"));
    assert.equal(plain?.secret, "deployment-key");
  });

  it("ignores a tenant's malformed BROKER_CREDENTIALS without echoing its secrets", async () => {
    replaceLoadedTenantSettings(
      new Map([
        [a, { orgId: "org-a", env: { BROKER_CREDENTIALS: '[{"slug":"search"}]', BROKER_SECRET_SEARCH: "key-a" } }],
      ]),
    );
    assert.deepEqual(await withTenant(a, () => store.listServiceCredentials(scopeId("org", "org-a"))), []);
  });
});
