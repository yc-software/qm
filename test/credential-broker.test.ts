import { test } from "node:test";
import assert from "node:assert/strict";
import { brokerCredentialCall, type BrokerFetch } from "../src/api/credential-broker.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";
import type { DecryptedServiceCredential, ServiceCredentialReader } from "../src/credentials/keychain.ts";
import { createCredentialUsageSink } from "../src/admin/credential-usage-sink.ts";

const SECRET = "super-secret-bearer";

function reader(rec: Partial<DecryptedServiceCredential> & { slug: string }): ServiceCredentialReader {
  const full: DecryptedServiceCredential = {
    name: rec.slug,
    secret: SECRET,
    delivery: "broker",
    host: "api.x.com",
    enabled: true,
    ...rec,
  };
  return { getServiceCredentialSecret: async (_org, slug) => (slug === full.slug ? full : null) };
}

const claims = (credentials: string[]): CapabilityClaims => ({
  actorId: "U1",
  scopeId: "personal:U1",
  aud: "credential-broker",
  credentials,
  exp: Date.now() + 60_000,
});

function captureFetch(): {
  fetch: BrokerFetch;
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: BrokerFetch = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    return { status: 200, contentType: "application/json", text: async () => '{"ok":true}' };
  };
  return { fetch, calls };
}

const base = (over: Partial<Parameters<typeof brokerCredentialCall>[0]> = {}) => ({
  claims: claims(["x-firehose"]),
  body: { credential: "x-firehose", method: "GET", url: "https://api.x.com/2/tweets/search/recent?query=ai" },
  orgScopeId: "org:default-org",
  reader: reader({ slug: "x-firehose", allowedMethods: ["GET"], allowedPathPrefixes: ["/2/tweets/search/"] }),
  fetchImpl: captureFetch().fetch,
  ...over,
});

test("happy path: injects the secret as Bearer, never exposes it in the result", async () => {
  const cap = captureFetch();
  const usage = createCredentialUsageSink();
  const r = await brokerCredentialCall(base({ fetchImpl: cap.fetch, usage }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { status: 200, contentType: "application/json", body: '{"ok":true}' });
  assert.doesNotMatch(JSON.stringify(r.json), new RegExp(SECRET));
  assert.equal(cap.calls.length, 1);
  assert.equal(cap.calls[0]!.headers["Authorization"], `Bearer ${SECRET}`);
  const used = await usage.list({ slug: "x-firehose" });
  assert.equal(used.length, 1);
  assert.equal(used[0]!.host, "api.x.com");
  assert.equal(used[0]!.status, "ok");
  assert.equal(used[0]!.principalId, "U1");
  assert.doesNotMatch(JSON.stringify(used), /tweets\/search|ai|super-secret/);
});

test("an env-delivery record is refused exactly like a missing credential — the broker door does not serve sandbox-env material", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({
      reader: reader({
        slug: "x-firehose",
        delivery: "env",
        envKey: "X_FIREHOSE_KEY",
        allowedMethods: ["GET"],
        allowedPathPrefixes: ["/2/tweets/search/"],
      }),
      fetchImpl: cap.fetch,
    }),
  );
  assert.equal(r.status, 404);
  assert.equal(cap.calls.length, 0, "no upstream fetch happens");
  assert.doesNotMatch(JSON.stringify(r.json), new RegExp(SECRET));
});

test("WHAT scheme normalization: a scheme missing its trailing space still emits `<scheme> <secret>`", async () => {
  const cap = captureFetch();
  await brokerCredentialCall(
    base({
      reader: reader({
        slug: "x-firehose",
        injection: { scheme: "Bearer" },
        allowedMethods: ["GET"],
        allowedPathPrefixes: ["/2/tweets/search/"],
      }),
      fetchImpl: cap.fetch,
    }),
  );
  assert.equal(cap.calls[0]!.headers["Authorization"], `Bearer ${SECRET}`);

  const cap2 = captureFetch();
  await brokerCredentialCall(
    base({
      reader: reader({
        slug: "x-firehose",
        injection: { header: "X-Api-Key", scheme: "" },
        allowedMethods: ["GET"],
        allowedPathPrefixes: ["/2/tweets/search/"],
      }),
      fetchImpl: cap2.fetch,
    }),
  );
  assert.equal(cap2.calls[0]!.headers["X-Api-Key"], SECRET);
});

test("WHO: a slug NOT in the token's signed set is refused (no record read, no fetch)", async () => {
  const cap = captureFetch();
  let readCount = 0;
  const r = await brokerCredentialCall(
    base({
      claims: claims([]),
      fetchImpl: cap.fetch,
      reader: {
        getServiceCredentialSecret: async () => {
          readCount++;
          return null;
        },
      },
    }),
  );
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.json), /not_entitled/);
  assert.equal(cap.calls.length, 0);
  assert.equal(readCount, 0, "must reject on the token alone, before touching the store");
});

test("WHAT host-pin: a different host is refused — the bearer can't be pointed at an attacker (exfil)", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({ body: { credential: "x-firehose", url: "https://evil.example/steal" }, fetchImpl: cap.fetch }),
  );
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.json), /host_not_allowed/);
  assert.equal(cap.calls.length, 0, "the secret must NEVER be sent to a non-pinned host");
});

test("WHAT host-pin: a userinfo trick (https://api.x.com@evil.com) targets evil.com → refused", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({
      body: { credential: "x-firehose", url: "https://api.x.com@evil.com/2/tweets/search/x" },
      fetchImpl: cap.fetch,
    }),
  );
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.json), /host_not_allowed/);
  assert.equal(cap.calls.length, 0);
});

test("WHAT path allowlist matches on a path BOUNDARY (no /a/b → /a/b-evil bypass)", async () => {
  const mk = () => reader({ slug: "x-firehose", allowedPathPrefixes: ["/2/tweets/search"] });
  const call = (url: string) =>
    brokerCredentialCall(
      base({ reader: mk(), body: { credential: "x-firehose", url }, fetchImpl: captureFetch().fetch }),
    );
  const evil = await call("https://api.x.com/2/tweets/search-evil/x");
  assert.equal(evil.status, 403);
  assert.match(JSON.stringify(evil.json), /path_not_allowed/);
  assert.equal((await call("https://api.x.com/2/tweets/search")).status, 200);
  assert.equal((await call("https://api.x.com/2/tweets/search/recent")).status, 200);
});

test("WHAT host-pin: a subdomain of the pinned host is allowed", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({ body: { credential: "x-firehose", url: "https://api.x.com/2/tweets/search/recent" }, fetchImpl: cap.fetch }),
  );
  assert.equal(r.status, 200);
  assert.equal(cap.calls.length, 1);
});

test("WHAT: https only — an http target is refused", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({ body: { credential: "x-firehose", url: "http://api.x.com/2/tweets/search/x" }, fetchImpl: cap.fetch }),
  );
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.json), /scheme_not_allowed/);
  assert.equal(cap.calls.length, 0);
});

test("WHAT method allowlist: a read bearer can't mutate", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({
      body: { credential: "x-firehose", method: "POST", url: "https://api.x.com/2/tweets/search/recent" },
      fetchImpl: cap.fetch,
    }),
  );
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.json), /method_not_allowed/);
  assert.equal(cap.calls.length, 0);
});

test("WHAT path allowlist: an out-of-allowlist path is refused", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({ body: { credential: "x-firehose", url: "https://api.x.com/2/dm/with/victim" }, fetchImpl: cap.fetch }),
  );
  assert.equal(r.status, 403);
  assert.match(JSON.stringify(r.json), /path_not_allowed/);
  assert.equal(cap.calls.length, 0);
});

test("WHAT path allowlist: percent-encoded parent traversal never escapes the prefix", async () => {
  const mk = () => reader({ slug: "x-firehose", allowedPathPrefixes: ["/2/tweets/search"] });
  const evil = [
    "https://api.x.com/2/tweets/search/../secrets", // literal
    "https://api.x.com/2/tweets/search/..%2fsecrets", // encoded slash
    "https://api.x.com/2/tweets/search/%2e%2e/secrets", // encoded dots (URL-normalized out of prefix)
    "https://api.x.com/2/tweets/search/%2e%2e%2fsecrets", // fully encoded
    "https://api.x.com/2/tweets/search/%252e%252e%252fsecrets", // double-encoded
    "https://api.x.com/2/tweets/search/..%5csecrets", // encoded backslash
    "https://api.x.com/2/tweets/search/%zz", // undecodable
  ];
  for (const url of evil) {
    const cap = captureFetch();
    const r = await brokerCredentialCall(
      base({ reader: mk(), body: { credential: "x-firehose", url }, fetchImpl: cap.fetch }),
    );
    assert.equal(r.status, 403, url);
    assert.match(JSON.stringify(r.json), /path_not_allowed/, url);
    assert.equal(cap.calls.length, 0, `no upstream fetch for ${url}`);
  }
  // benign lookalikes still pass: dots inside a segment are not dot segments
  const cap = captureFetch();
  const ok = await brokerCredentialCall(
    base({
      reader: mk(),
      body: { credential: "x-firehose", url: "https://api.x.com/2/tweets/search/v1..v2/some%20file" },
      fetchImpl: cap.fetch,
    }),
  );
  assert.equal(ok.status, 200);
  assert.equal(cap.calls.length, 1);
});

test("a disabled credential is refused even when the token still names it (live re-check)", async () => {
  const cap = captureFetch();
  const r = await brokerCredentialCall(
    base({ reader: reader({ slug: "x-firehose", enabled: false }), fetchImpl: cap.fetch }),
  );
  assert.equal(r.status, 404);
  assert.match(JSON.stringify(r.json), /credential_unavailable/);
  assert.equal(cap.calls.length, 0);
});

test("caller-supplied headers cannot override the injected auth header or smuggle others", async () => {
  const cap = captureFetch();
  await brokerCredentialCall(
    base({
      body: {
        credential: "x-firehose",
        url: "https://api.x.com/2/tweets/search/recent",
        headers: { Authorization: "Bearer ATTACKER", Host: "evil.example", Cookie: "x=y", Accept: "application/json" },
      },
      fetchImpl: cap.fetch,
    }),
  );
  const h = cap.calls[0]!.headers;
  assert.equal(h["Authorization"], `Bearer ${SECRET}`);
  assert.equal(h["Host"], undefined);
  assert.equal(h["Cookie"], undefined);
  assert.equal(h["Accept"], "application/json");
});

test("a custom injection header + scheme is honored", async () => {
  const cap = captureFetch();
  await brokerCredentialCall(
    base({
      reader: reader({
        slug: "x-firehose",
        injection: { header: "X-Api-Key", scheme: "" },
        allowedPathPrefixes: ["/"],
      }),
      fetchImpl: cap.fetch,
    }),
  );
  assert.equal(cap.calls[0]!.headers["X-Api-Key"], SECRET);
  assert.equal(cap.calls[0]!.headers["Authorization"], undefined);
});

test("an upstream fetch error is reported generically (never leaks the URL/headers) + recorded", async () => {
  const usage = createCredentialUsageSink();
  const r = await brokerCredentialCall(
    base({
      usage,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED https://api.x.com with Bearer super-secret-bearer");
      },
    }),
  );
  assert.equal(r.status, 502);
  assert.match(JSON.stringify(r.json), /upstream_unreachable/);
  assert.doesNotMatch(JSON.stringify(r.json), new RegExp(SECRET));
  assert.equal((await usage.list({ slug: "x-firehose" }))[0]!.status, "error");
});

test("a missing slug or url is a 400 bad_request", async () => {
  assert.equal(
    (await brokerCredentialCall(base({ body: { url: "https://api.x.com/2/tweets/search/x" } }))).status,
    400,
  );
  assert.equal((await brokerCredentialCall(base({ body: { credential: "x-firehose" } }))).status, 400);
});
