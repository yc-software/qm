import { test } from "node:test";
import assert from "node:assert/strict";
import type { App } from "../src/api/app.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { personNamer, threadRefLabel } from "../src/api/routes/admin/common.ts";
import { installPrincipalLinks } from "../src/directory/person.ts";

const trusted = "oidc:issuer-hash:c3ViamVjdA";

test("a trusted sign-in principal is named through its linked email, falling back to the email itself", async (t) => {
  installPrincipalLinks({
    canonical: () => undefined,
    aliases: (key) => ({ [trusted]: ["founder@company.test"], "oidc:other": ["unlisted@company.test"] })[key] ?? [],
    userId: () => undefined,
    claim: () => {},
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

test("a thread reference in the audit log names its owner and keeps the thread id", () => {
  const nameOf = (id: string) => (id === trusted ? "founder@company.test" : undefined);
  const thread = "0b6c8a52-3f4e-4c1a-9d2b-5e7f8a9b0c1d";
  assert.equal(threadRefLabel(`web:${trusted}:${thread}`, nameOf), `web:founder@company.test:${thread}`);
  assert.equal(threadRefLabel(`web:oidc:stranger:${thread}`, nameOf), undefined);
  assert.equal(threadRefLabel("audit", nameOf), undefined);
  assert.equal(threadRefLabel(undefined, nameOf), undefined);
});
