import assert from "node:assert/strict";
import { test } from "node:test";
import { boundTenant } from "../../chassis/src/tenant.ts";
import type { TenantSignIn } from "../../chassis/src/tenant-sign-in.ts";
import { decodeJwt } from "jose";
import {
  authorizeQuery,
  basicAuth,
  CLIENT_ID,
  hiddenRequestToken,
  linkFrom,
  pkcePair,
  startHarness,
  type Harness,
} from "./helpers.ts";

const TENANT_A = "0f0e7c34-6d3b-4c1a-9a51-6a1f6a0c0a01";
const TENANT_B = "0f0e7c34-6d3b-4c1a-9a51-6a1f6a0c0b02";

const settings = new Map<string, TenantSignIn>([
  [
    TENANT_A,
    {
      allowedEmails: ["alice@a.example"],
      oidcClient: { issuer: "https://a.example/idp", clientId: "client-a", clientSecret: "a".repeat(40) },
    },
  ],
  [
    TENANT_B,
    {
      allowedEmails: ["bob@b.example"],
      oidcClient: { issuer: "https://b.example/idp", clientId: "client-b", clientSecret: "b".repeat(40) },
    },
  ],
]);

const hosts = new Map([
  ["127.0.0.1", TENANT_A],
  ["localhost", TENANT_B],
  ["a.example", TENANT_A],
]);

async function twoTenantHarness(): Promise<{ h: Harness; a: string; b: string }> {
  const h = await startHarness({
    hostTenants: async (host) => {
      const tenant = hosts.get(host);
      return tenant ? { multi: true, tenant } : { multi: true };
    },
    signIn: async () => settings.get(boundTenant() ?? "") ?? {},
  });
  const port = new URL(h.base).port;
  return { h, a: `http://127.0.0.1:${port}`, b: `http://localhost:${port}` };
}

async function askForLink(h: Harness, origin: string, clientId: string, email: string): Promise<number> {
  const page = await fetch(`${origin}/authorize?${authorizeQuery({ client_id: clientId })}`);
  if (page.status !== 200) return page.status;
  const request = hiddenRequestToken(await page.text());
  const before = h.mailer.sent.length;
  await fetch(`${origin}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request, email }).toString(),
  });
  await h.settle();
  return h.mailer.sent.length > before ? 202 : 403;
}

test("a user allowed only on tenant A's host is refused on tenant B's host", async (t) => {
  const { h, a, b } = await twoTenantHarness();
  t.after(() => h.close());
  assert.equal(await askForLink(h, a, "client-a", "alice@a.example"), 202);
  assert.equal(await askForLink(h, b, "client-b", "alice@a.example"), 403);
  assert.equal(await askForLink(h, b, "client-b", "bob@b.example"), 202);
  assert.equal(await askForLink(h, a, "client-b", "bob@b.example"), 400);
});

test("each tenant's host accepts only its own OIDC client", async (t) => {
  const { h, a, b } = await twoTenantHarness();
  t.after(() => h.close());
  assert.equal((await fetch(`${a}/authorize?${authorizeQuery({ client_id: "client-a" })}`)).status, 200);
  assert.equal((await fetch(`${b}/authorize?${authorizeQuery({ client_id: "client-a" })}`)).status, 400);
  assert.equal((await fetch(`${b}/authorize?${authorizeQuery({ client_id: "client-b" })}`)).status, 200);
  assert.equal((await fetch(`${a}/authorize?${authorizeQuery({ client_id: CLIENT_ID })}`)).status, 400);
});

test("a tenant without sign-in settings keeps the deployment's allowlist and client", async (t) => {
  const h = await startHarness({ signIn: async () => ({}) });
  t.after(() => h.close());
  assert.equal(await askForLink(h, h.base, CLIENT_ID, "admin@example.com"), 202);
  assert.equal(await askForLink(h, h.base, CLIENT_ID, "alice@a.example"), 403);
});

test("a company host forwarded by the portal gets its own issuer, callback and token exchange", async (t) => {
  const { h } = await twoTenantHarness();
  t.after(() => h.close());
  const company = { "x-forwarded-host": "a.example" };
  const redirectUri = "https://a.example/auth/callback";
  const { verifier, challenge } = pkcePair();
  const query = authorizeQuery({ client_id: "client-a", redirect_uri: redirectUri, code_challenge: challenge });
  const page = await fetch(`${h.base}/authorize?${query}`, { headers: company });
  assert.equal(page.status, 200);
  await fetch(`${h.base}/authorize`, {
    method: "POST",
    headers: { ...company, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: hiddenRequestToken(await page.text()), email: "alice@a.example" }).toString(),
  });
  await h.settle();
  const link = new URL(linkFrom(h.mailer));
  assert.equal(`${link.origin}${link.pathname}`, "https://a.example/idp/verify");
  const verified = await fetch(`${h.base}/verify`, {
    method: "POST",
    headers: { ...company, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: new URLSearchParams(link.hash.slice(1)).get("token") ?? "" }).toString(),
    redirect: "manual",
  });
  const back = new URL(verified.headers.get("location") ?? "");
  assert.equal(`${back.origin}${back.pathname}`, redirectUri);
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: back.searchParams.get("code") ?? "",
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  const exchange = (headers: Record<string, string>) =>
    fetch(`${h.base}/token`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/x-www-form-urlencoded",
        authorization: basicAuth("client-a", "a".repeat(40)),
      },
      body: form.toString(),
    });
  assert.equal((await exchange({ "x-forwarded-host": "localhost" })).status, 401);
  const tokens = await exchange(company);
  assert.equal(tokens.status, 200);
  const { id_token } = (await tokens.json()) as { id_token: string };
  assert.equal(decodeJwt(id_token).iss, "https://a.example/idp");
});
