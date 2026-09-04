import assert from "node:assert/strict";
import { test } from "node:test";
import { HOSTING_PROVIDERS, hostingProvider, hostingProviderUpFlags } from "../src/backends/registry.ts";
import { HOSTING_PROVIDER_IDS, hostingProviderChoices, isTarget } from "../src/providers.ts";

test("the hosting provider registry owns target discovery and lifecycle capabilities", () => {
  assert.deepEqual(Object.keys(HOSTING_PROVIDERS), [...HOSTING_PROVIDER_IDS]);
  assert.equal(hostingProviderChoices(), "docker, fly, or aws");
  assert.equal(isTarget("fly"), true);
  assert.equal(isTarget("kubernetes"), false);
  for (const id of HOSTING_PROVIDER_IDS) {
    const provider = hostingProvider(id);
    assert.equal(provider.id, id);
    assert.equal(typeof provider.scaffold.renderConfig, "function");
    assert.equal(typeof provider.publishSandbox, "function");
    assert.equal(typeof provider.requiresSandboxApp, "boolean");
    assert.equal(typeof provider.validateConfig, "function");
  }
  assert.deepEqual(hostingProvider("docker").upFlags, ["build-from", "only"]);
  assert.ok(hostingProvider("fly").upFlags.includes("image-from"));
  assert.ok(hostingProvider("aws").upFlags.includes("yes"));
  assert.deepEqual(hostingProviderUpFlags(), [
    "build-from",
    "only",
    "image-label",
    "image-from",
    "image-repo-prefix",
    "build-only",
    "yes",
  ]);
});

test("provider output coordinates stay behind the registry", () => {
  const common = {
    contract: 1 as const,
    orgId: "acme",
    publicUrl: "https://qm.example.com",
    services: ["core" as const],
    plugins: [],
    skills: [],
    env: {},
    imageOverrides: {},
  };
  assert.deepEqual(hostingProvider("docker").coordinates({ ...common, target: "docker" }), {});
  assert.deepEqual(
    hostingProvider("fly").coordinates({
      ...common,
      target: "fly",
      flyOrg: "acme-org",
      region: "iad",
    }),
    { accountOrOrganization: "acme-org", region: "iad" },
  );
  assert.deepEqual(
    hostingProvider("aws").coordinates({
      ...common,
      target: "aws",
      aws: {
        accountId: "123456789012",
        region: "us-east-1",
        cluster: "acme",
        deployRoleArn: "arn:aws:iam::123456789012:role/deploy",
        secretsPrefix: "acme/",
        imageLabel: "v1",
        networking: { cloudMapNamespace: "acme.internal" },
        services: {},
      },
    }),
    { accountOrOrganization: "123456789012", region: "us-east-1" },
  );
});
