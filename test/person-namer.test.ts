import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "../src/api/app.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { discoverScopes, personNamer } from "../src/api/routes/admin/common.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";

const trusted = "oidc:issuer-hash:c3ViamVjdA";

test("a trusted sign-in principal is named through its linked email, falling back to the email itself", async (t) => {
  installPrincipalLinks({
    canonical: () => undefined,
    aliases: (key) => ({ [trusted]: ["founder@company.test"], "oidc:other": ["unlisted@company.test"] })[key] ?? [],
  });
  t.after(() => installPrincipalLinks(null));
  const app = {
    directoryMembers: async () => [
      { principalId: "founder@company.test", displayName: "Fran Founder", type: "internal" },
      { principalId: "nameless@company.test", displayName: "", type: "internal" },
    ],
  } as unknown as App;
  const nameOf = await personNamer(app, { identity: { refresh: async () => undefined } } as unknown as ServerDeps);
  assert.equal(nameOf(trusted), "Fran Founder");
  assert.equal(nameOf("Founder@Company.test"), "Fran Founder");
  assert.equal(nameOf("nameless@company.test"), "nameless@company.test");
  assert.equal(nameOf("oidc:other"), "unlisted@company.test");
  assert.equal(nameOf("oidc:stranger"), undefined);
});

test("one person's two personal scopes get labels that tell them apart", async (t) => {
  installPrincipalLinks({
    canonical: (key) => (key === "founder@company.test" ? trusted : undefined),
    aliases: (key) => (key === trusted ? ["founder@company.test"] : []),
  });
  t.after(() => installPrincipalLinks(null));
  const app = {
    directoryMembers: async () => [{ principalId: "founder@company.test", displayName: "", type: "internal" }],
    directoryChannels: async () => [],
  } as unknown as App;
  const deps = {
    orgId: "acme",
    identity: { refresh: async () => undefined },
    sessions: { distinctScopes: async () => [], distinctParticipants: async () => [] },
    admin: { listGrants: async () => [] },
  } as unknown as ServerDeps;
  const labels = await discoverScopes(app, deps, [
    `personal:${trusted}`,
    "personal:founder@company.test",
    "personal:solo@company.test",
  ]);
  assert.equal(labels.get(`personal:${trusted}`), "founder@company.test (by sign-in)");
  assert.equal(labels.get("personal:founder@company.test"), "founder@company.test (by email)");
  assert.equal(labels.get("personal:solo@company.test"), "solo@company.test");
});
