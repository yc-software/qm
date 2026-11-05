import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { trustedEmailRoutes } from "../src/api/routes/trusted-emails.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createPrincipalLinkService } from "../src/identity/principal-links.ts";
import { canonicalPerson, installPrincipalLinks } from "../src/directory/person.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { scopeId } from "../src/types.ts";
import { orgId, orgScope } from "../src/config.ts";
import { trustedPrincipal } from "../plugins/portal/src/trusted-entry.ts";
import { testAdvisoryLock, testMap } from "./support/test-database.ts";

const identitySecret = "portal-identity-secret".repeat(2);
const signingSecret = "core-signing-secret".repeat(2);
const issuer = "https://identity.example.test";
const founder = trustedPrincipal(issuer, "founder-7");

function fixture() {
  const keychain = createKeychain({
    lock: testAdvisoryLock(),
    creds: testMap(),
    grants: testMap(),
    asks: testMap(),
    key: deriveConnectorKey("trusted-email-test"),
  });
  const links = createPrincipalLinkService(testMap(), testAdvisoryLock());
  installPrincipalLinks(links);
  const claimed = new Set<string>();
  const deactivated = new Set<string>();
  const externals = new Set<string>();
  const audits: Array<{ action: string; resource?: string; principalId?: string }> = [];
  const composioAccounts = new Set<string>();
  const composioCalls: string[] = [];
  let composioDown = false;
  const deps: Partial<ServerDeps> = {
    keychain,
    serviceCreds: keychain,
    principalLinks: links,
    portalIdentitySecret: identitySecret,
    replayDedupe: {
      claim: async (key: string) => (claimed.has(key) ? false : (claimed.add(key), true)),
    } as unknown as ServerDeps["replayDedupe"],
    identity: {
      refresh: async () => undefined,
      classify: (id: string) => ({
        id: canonicalPerson(id),
        type: deactivated.has(canonicalPerson(id)) ? "guest" : "internal",
      }),
      externalMember: (id: string) => (externals.has(id) ? { email: id } : undefined),
    } as unknown as ServerDeps["identity"],
    auditLog: { record: (e: (typeof audits)[number]) => audits.push(e) } as unknown as ServerDeps["auditLog"],
    composioFetch: (async (input: string | URL | Request) => {
      composioCalls.push(String(input));
      if (composioDown) return new Response("down", { status: 503 });
      const user = new URL(String(input)).searchParams.get("user_ids");
      return Response.json({ items: composioAccounts.has(user ?? "") ? [{ id: "ca_1" }] : [] });
    }) as typeof fetch,
  };
  async function send(payload: Record<string, unknown>, key = identitySecret) {
    let status = 0;
    let text = "";
    const res = {
      setHeader() {},
      getHeader() {},
      writeHead(code: number) {
        status = code;
      },
      end(value?: string) {
        text = value ?? "";
      },
    } as unknown as ServerResponse;
    const ctx = {
      deps,
      res,
      url: new URL("http://localhost/v1/auth/trusted/emails"),
      body: { assertion: await mintSignedPayload(payload, key) },
      secret: signingSecret,
    } as unknown as ApiCtx;
    await trustedEmailRoutes[0]!.handle(ctx);
    return { status, data: text ? JSON.parse(text) : null };
  }
  const claims = (overrides: Record<string, unknown> = {}) => ({
    purpose: "trusted-entry-emails",
    issuer,
    subject: "founder-7",
    emails: ["founder@example.test"],
    org: orgScope(),
    exp: Date.now() + 55_000,
    jti: crypto.randomUUID(),
    ...overrides,
  });
  return {
    deps,
    links,
    keychain,
    send,
    claims,
    audits,
    deactivated,
    externals,
    composioAccounts,
    composioCalls,
    setComposioDown: (down: boolean) => void (composioDown = down),
  };
}

test("a verified email identity joins the signed-in person and Slack's email identity resolves to it", async (t) => {
  const f = fixture();
  t.after(() => installPrincipalLinks(null));
  const response = await f.send(f.claims({ emails: ["founder@example.test", "alt@example.test"] }));
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { linked: 2, unchanged: 0, skipped: {} });
  // Slack's email identity mode uses the lowercased address as the principal id.
  assert.equal(canonicalPerson("founder@example.test"), founder);
  assert.equal(canonicalPerson("alt@example.test"), founder);
  const stored = (await f.links.list()).find((link) => link.principalId === "founder@example.test")!;
  assert.equal(stored.canonicalId, founder);
  assert.equal(stored.linkedBy, founder);
  assert.match(stored.evidence, /trusted OIDC issuer https:\/\/identity\.example\.test/);
  assert.deepEqual(
    f.audits.map((e) => [e.action, e.resource, e.principalId]),
    [
      ["principal_link.create", `founder@example.test -> ${founder}`, founder],
      ["principal_link.create", `alt@example.test -> ${founder}`, founder],
    ],
  );
  const again = await f.send(f.claims({ emails: ["founder@example.test"] }));
  assert.deepEqual(again.data, { linked: 0, unchanged: 1, skipped: {} });
  assert.equal(f.audits.length, 2);
});

test("email identities with their own state, links or owners are left for an administrator", async (t) => {
  const f = fixture();
  t.after(() => installPrincipalLinks(null));
  await f.keychain.save({ ownerId: "keys@example.test", service: "github", envKey: "GH_TOKEN", secret: "s" });
  const org = scopeId("org", orgId());
  await f.keychain.setServiceCredential(org, {
    slug: "composio",
    name: "Composio",
    delivery: "env",
    envKey: "COMPOSIO_API_KEY",
    secret: "company-key",
    host: "",
    enabled: true,
  });
  const { composioUserId } = await import("../src/api/routes/composio.ts");
  const { externalOrgId } = await import("../src/tenants/external-org.ts");
  f.composioAccounts.add(composioUserId(externalOrgId(), "apps@example.test"));
  await f.links.link({
    principalId: "taken@example.test",
    canonicalId: "someone-else",
    evidence: "admin",
    linkedBy: "a",
  });
  await f.links.link({
    principalId: "U0SLACK",
    canonicalId: "canonical@example.test",
    evidence: "admin",
    linkedBy: "a",
  });
  f.deactivated.add("gone@example.test");
  f.externals.add("guest@example.test");
  const response = await f.send(
    f.claims({
      emails: [
        "keys@example.test",
        "apps@example.test",
        "taken@example.test",
        "canonical@example.test",
        "gone@example.test",
        "guest@example.test",
      ],
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, {
    linked: 0,
    unchanged: 0,
    skipped: { established: 2, linked_elsewhere: 1, has_aliases: 1, inactive: 1, external_member: 1 },
  });
  assert.equal(canonicalPerson("taken@example.test"), "someone-else");
  assert.equal(canonicalPerson("keys@example.test"), "keys@example.test");
  assert.ok(f.composioCalls.length > 0);
  assert.ok(!f.audits.some((e) => e.action === "principal_link.create"));
});

test("an unreadable Composio project fails closed for that email", async (t) => {
  const f = fixture();
  t.after(() => installPrincipalLinks(null));
  await f.keychain.setServiceCredential(scopeId("org", orgId()), {
    slug: "composio",
    name: "Composio",
    delivery: "env",
    envKey: "COMPOSIO_API_KEY",
    secret: "company-key",
    host: "",
    enabled: true,
  });
  f.setComposioDown(true);
  const response = await f.send(f.claims());
  assert.deepEqual(response.data, { linked: 0, unchanged: 0, skipped: { check_failed: 1 } });
  assert.equal(canonicalPerson("founder@example.test"), "founder@example.test");
});

test("emails join the person's canonical principal when the sign-in was already merged into it", async (t) => {
  const f = fixture();
  t.after(() => installPrincipalLinks(null));
  await f.links.link({ principalId: founder, canonicalId: "first@example.test", evidence: "admin", linkedBy: "a" });
  const response = await f.send(f.claims({ emails: ["first@example.test", "second@example.test"] }));
  assert.deepEqual(response.data, { linked: 1, unchanged: 1, skipped: {} });
  assert.equal(canonicalPerson("second@example.test"), "first@example.test");
});

test("forged, unrelated, malformed, expired and replayed assertions link nothing", async (t) => {
  const f = fixture();
  t.after(() => installPrincipalLinks(null));
  for (const invalid of [
    { purpose: "trusted-entry-admin" },
    { org: "org:other" },
    { issuer: "" },
    { subject: "" },
    { subject: "x".repeat(256) },
    { imp: "operator" },
    { exp: Date.now() - 1 },
    { exp: Date.now() + 120_000 },
    { jti: "not-a-uuid" },
    { emails: [] },
    { emails: "founder@example.test" },
    { emails: ["Founder@Example.test"] },
    { emails: ["not-an-email"] },
    { emails: Array.from({ length: 21 }, (_, i) => `f${i}@example.test`) },
  ])
    assert.equal((await f.send(f.claims(invalid))).status, 403, JSON.stringify(invalid));
  assert.equal((await f.send(f.claims(), signingSecret)).status, 403);
  f.deactivated.add(founder);
  assert.equal((await f.send(f.claims())).status, 403);
  f.deactivated.delete(founder);
  const payload = f.claims();
  assert.equal((await f.send(payload)).status, 200);
  assert.equal((await f.send(payload)).status, 409);
  assert.equal((await f.links.list()).length, 1);
});

test("on a shared host with no tenant bound, a sign-in links nothing", async (t) => {
  const { withoutTenant } = await import("../src/tenants/context.ts");
  const f = fixture();
  t.after(() => installPrincipalLinks(null));
  const response = await withoutTenant(() => f.send(f.claims()));
  assert.equal(response.status, 204);
  assert.equal(canonicalPerson("founder@example.test"), "founder@example.test");
});
