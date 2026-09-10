import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, gateSecret, portal } from "./helpers/deploy-hardening-fixture.ts";
import { mintDeployOwnerToken } from "../src/deploy/access-token.ts";
import { scopeId } from "../src/types.ts";

test("launch requires active identity; app authorization remains separate", async (t) => {
  const f = await fixture(t);
  for (const principal of [""]) {
    const r = await f.launch(principal);
    assert.equal(r.status, 403);
    assert.equal(r.headers.location, undefined);
    assert.equal(r.headers["set-cookie"], undefined);
  }
  const stranger = await f.complete("stranger");
  assert.equal((await f.send("/", { host: f.host, cookie: stranger.cookie })).status, 403);
  await f.identity.deactivate("viewer");
  assert.equal((await f.launch()).status, 403);
  assert.equal((await f.send("/d/alpha", { "x-as-principal": "owner" })).status, 401);
  assert.equal(f.seen.length, 0);
});

test("GET document, iframe, headerless and HEAD launch to ticket endpoint with byte-exact clean path/query", async (t) => {
  const f = await fixture(t);
  for (const [method, dest] of [
    ["GET", "document"],
    ["GET", "iframe"],
    ["GET", ""],
    ["HEAD", "document"],
  ]) {
    const r = await f.launch(
      "viewer",
      "/d/alpha/deep?q=a%20b&x=%2f&x=+",
      method,
      dest ? { "sec-fetch-dest": dest } : {},
    );
    assert.equal(r.status, 302);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    const u = new URL(String(r.headers.location));
    assert.equal(u.origin, `https://${f.d.id}.apps.example.test`);
    assert.equal(u.pathname, "/__qm/start");
    const redeemed = await f.redeem(r);
    assert.equal(redeemed.status, 302, redeemed.body);
    assert.equal(redeemed.headers.location, "/deep?q=a%20b&x=%2f&x=+");
    assert.match(redeemed.cookie, /^__Host-qm_app_session=/);
    const c = redeemed.headers["set-cookie"]!.join(";");
    assert.match(c, /HttpOnly/);
    assert.match(c, /Secure/);
    assert.match(c, /SameSite=Lax/);
    assert.doesNotMatch(c, /Domain=/i);
    const page = await f.send(String(redeemed.headers.location), { host: redeemed.host, cookie: redeemed.cookie });
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], undefined);
    assert.equal(f.seen.at(-1)!.path, "/deep?q=a%20b&x=%2f&x=+");
  }
  const root = await f.redeem(await f.launch("owner", "/d/alpha"));
  assert.equal(root.headers.location, "/");
});

test("launch session works without portal cookie, scrubs credentials and keeps only host-local app cookies", async (t) => {
  const f = await fixture(t);
  const r = await f.redeem(await f.launch());
  const page = await f.send("/assets/module.js", {
    host: r.host,
    cookie: `${r.cookie}; portal_session=secret; dpl_owner=secret; theme=dark; qm_app_session=forged`,
    "x-agent-capability": "secret",
    "x-portal-identity": "secret",
  });
  assert.equal(page.status, 200);
  assert.equal(f.seen.at(-1)!.headers.cookie, "theme=dark");
  assert.equal(f.seen.at(-1)!.headers["x-agent-capability"], undefined);
  assert.notEqual(f.seen.at(-1)!.headers["x-portal-identity"], "secret");
  assert.deepEqual(page.headers["set-cookie"], [
    "app_pref=ok; Path=/; SameSite=Lax",
    "app_other=yes; HttpOnly; Path=/deep",
  ]);
  const redirect = await f.send("/redirect", { host: r.host, cookie: r.cookie });
  assert.equal(redirect.headers.location, "/next?q=a%20b");
});

test("app session writes require exact Origin and legacy owner cookies grant no authority, not sibling same-site or absent/null", async (t) => {
  const f = await fixture(t);
  const r = await f.redeem(await f.launch());
  for (const origin of [
    undefined,
    "null",
    "https://beta.apps.example.test",
    portal,
    "https://alpha.apps.example.test:444",
  ]) {
    const denied = await f.send(
      "/api/write",
      { host: r.host, cookie: r.cookie, ...(origin ? { origin } : {}) },
      "POST",
      "must not arrive",
    );
    assert.equal(denied.status, 403);
  }
  const ok = await f.send("/api/write", { host: r.host, cookie: r.cookie, origin: r.origin }, "POST", "hello");
  assert.equal(ok.status, 200);
  assert.equal(f.seen.at(-1)!.body, "hello");
  const owner = await mintDeployOwnerToken(gateSecret, { slug: f.d.id, sub: "owner", exp: Date.now() + 60_000 });
  assert.equal((await f.send("/api/write", { host: r.host, cookie: `dpl_owner=${owner}` }, "POST")).status, 401);
});

test("launch and session audiences reject cross-app use, tampering, revocation and deactivation", async (t) => {
  const f = await fixture(t);
  const launch = await f.launch();
  assert.equal((await f.redeem(launch, `${(await f.app.getDeployment("beta"))!.id}.apps.example.test`)).status, 401);
  const r = await f.redeem(launch);
  assert.equal(
    (await f.send("/api", { host: `${(await f.app.getDeployment("beta"))!.id}.apps.example.test`, cookie: r.cookie }))
      .status,
    401,
  );
  assert.equal((await f.send("/api", { host: r.host, cookie: r.cookie + "x" })).status, 401);
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), null, { createdBy: "owner" });
  assert.equal((await f.send("/api", { host: r.host, cookie: r.cookie })).status, 403);
  assert.equal((await f.redeem(await f.launch("owner"))).status, 302);
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), "read", { createdBy: "owner" });
  await f.identity.deactivate("viewer");
  assert.equal((await f.send("/api", { host: r.host, cookie: r.cookie })).status, 403);
  assert.equal((await f.redeem(launch)).status, 403);
});

test("viewer session does not borrow authority from a different owner's legacy cookie", async (t) => {
  const f = await fixture(t);
  const r = await f.redeem(await f.launch());
  const owner = await mintDeployOwnerToken(gateSecret, { slug: f.d.id, sub: "owner", exp: Date.now() + 60_000 });
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), null, { createdBy: "owner" });
  const response = await f.send("/", {
    host: r.host,
    cookie: `${r.cookie}; dpl_owner=${owner}`,
    "sec-fetch-dest": "document",
    accept: "text/html",
  });
  assert.equal(response.status, 403);
  assert.doesNotMatch(response.body, /__qmAppShell/);
  await f.identity.deactivate("owner");
  assert.equal((await f.send("/", { host: r.host, cookie: `dpl_owner=${owner}` })).status, 401);
});

test("signed-out direct app login returns through portal launch instead of requiring parent cookie", async (t) => {
  const f = await fixture(t);
  const r = await f.send("/deep?q=a%20b&x=+", { host: `${f.d.id}.apps.example.test`, accept: "text/html" });
  assert.equal(r.status, 302);
  const signin = new URL(String(r.headers.location));
  assert.equal(signin.origin, portal);
  assert.equal(signin.href, `${portal}/d/${f.d.id}/deep?q=a%20b&x=+`);
});

test("explicit non-production loopback uses apps.localhost and the actual listening port without app config", async (t) => {
  const f = await fixture(t, "local");
  const launch = await f.launch("viewer", "/d/alpha");
  const u = new URL(String(launch.headers.location));
  assert.equal(u.origin, `http://${f.d.id}.apps.localhost:${f.port}`);
  const r = await f.redeem(launch);
  assert.equal(r.status, 302);
  assert.match(r.cookie, /^__Host-qm_app_session=/);
  assert.equal((await f.send("/", { host: r.host, cookie: r.cookie })).status, 200);
  assert.equal((await f.launch("viewer", "/d/alpha", "GET", { host: "remote.example.test" })).status, 503);
  assert.equal((await f.send("/", { host: `${f.d.id}.apps.localhost:${f.port + 1}`, cookie: r.cookie })).status, 403);
});

test("production lacking isolated origin gives actionable configuration response, never full same-origin app", async (t) => {
  const f = await fixture(t, "missing");
  const r = await f.launch();
  assert.equal(r.status, 503);
  assert.match(r.body, /DEPLOY_APPS_DOMAIN/);
  assert.match(r.body, /wildcard|TLS/);
  assert.equal(f.seen.length, 0);
});

test("explicit legacy subresources remain sandboxed and transport nonce removal preserves all other query bytes", async (t) => {
  const f = await fixture(t, "missing");
  const r = await f.launch("viewer", "/d/alpha/file.js?a=%20&b=+&access=app-value", "GET", {
    "sec-fetch-dest": "script",
  });
  assert.equal(r.status, 200);
  assert.match(String(r.headers["content-security-policy"]), /^sandbox /);
  assert.equal(f.seen.at(-1)!.path, "/file.js?a=%20&b=+&access=app-value");
});

test("canonical origins survive renaming and friendly-name reuse without sharing origin storage", async (t) => {
  const f = await fixture(t);
  const r = await f.redeem(await f.launch());
  assert.equal(r.host, `${f.d.id}.apps.example.test`);
  await f.app.renameDeployment(f.d.id, "renamed");
  const replacement = await f.app.deploy({
    name: "alpha",
    createdBy: "owner",
    ownerScopeId: scopeId("personal", "owner"),
    entrypoint: "x",
    files: [],
  });
  const next = await f.redeem(await f.launch("owner", "/d/alpha"));
  assert.equal(next.host, `${replacement.id}.apps.example.test`);
  assert.notEqual(next.host, r.host);
  assert.equal((await f.send("/", { host: next.host, cookie: r.cookie })).status, 401);
  assert.equal((await f.send("/", { host: r.host, cookie: r.cookie })).status, 200);
  const alias = await f.send("/deep?q=a%20b", { host: "alpha.apps.example.test" });
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.location, `https://${replacement.id}.apps.example.test/deep?q=a%20b`);
});

test("foreign-origin reads cannot use reflected app CORS as a cross-app credential bridge", async (t) => {
  const f = await fixture(t);
  const r = await f.redeem(await f.launch());
  const cases: Record<string, string>[] = [
    { origin: "https://sibling.apps.example.test" },
    { origin: "null" },
    { "sec-fetch-site": "same-site", "sec-fetch-dest": "empty" },
  ];
  for (const headers of cases) {
    assert.equal((await f.send("/api", { host: r.host, cookie: r.cookie, ...headers })).status, 403);
  }
  assert.equal(f.seen.length, 0);
});

test("scoped app requests retain ordinary owner/access query keys verbatim", async (t) => {
  const f = await fixture(t);
  const r = await f.redeem(await f.launch("viewer", "/d/alpha/?owner=app&access=a%20b&dpl_signin=1"));
  const response = await f.send(String(r.headers.location), { host: r.host, cookie: r.cookie });
  assert.equal(response.status, 200);
  assert.equal(f.seen.at(-1)!.path, "/?owner=app&access=a%20b&dpl_signin=1");
});

test("legacy owner query is app data and never establishes owner authority for either principal", async (t) => {
  const f = await fixture(t);
  const owner = await f.redeem(await f.launch("owner"));
  const token = await mintDeployOwnerToken(gateSecret, { slug: f.d.id, sub: "owner", exp: Date.now() + 60_000 });
  const enabled = await f.send(`/?owner=${token}`, { host: owner.host, cookie: owner.cookie });
  assert.equal(enabled.status, 200);
  assert.doesNotMatch(String(enabled.headers["set-cookie"]), /dpl_owner=/);
  const viewer = await f.redeem(await f.launch());
  const forbidden = await f.send(`/?owner=${token}`, { host: viewer.host, cookie: viewer.cookie });
  assert.equal(
    forbidden.headers["set-cookie"]?.some((c) => c.startsWith("dpl_owner=")),
    false,
  );
});
