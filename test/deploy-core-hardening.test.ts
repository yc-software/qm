import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, gateSecret, portal, secret } from "./helpers/deploy-hardening-fixture.ts";
import { mintDeployOwnerToken, viewerIdentityKey } from "../src/deploy/access-token.ts";
import { verifyPortalIdentity } from "../src/auth/portal-identity.ts";
import { createHmac } from "node:crypto";
import { scopeId } from "../src/types.ts";
import { createMemoryReplayDedupe } from "../src/auth/replay-dedupe.ts";

test("browser-bound handoff authenticates the receiving browser, not the start URL issuer", async (t) => {
  const f = await fixture(t);
  const b = await f.begin("owner");
  const request = new URL(String(b.initial.headers.location)).searchParams.get("request")!;
  const payload = JSON.parse(Buffer.from(request.split(".")[1]!, "base64url").toString());
  assert.equal(payload.type, "request");
  assert.equal(payload.sub, undefined, "a copied start request has no actor authority");
  const ticket = await f.launch("viewer", b.source.pathname + b.source.search);
  assert.equal(new URL(String(ticket.headers.location)).pathname, "/__qm/launch");
  assert.equal((await f.atApp(ticket)).status, 401, "copied callback without browser challenge fails");
  assert.equal((await f.atApp(ticket, "__Host-qm_app_challenge=another-browser")).status, 401);
  const done = await f.atApp(ticket, b.challenge);
  assert.equal(done.status, 302, done.body);
  assert.equal(done.headers.location, "/deep?q=a%20b&x=%2f&x=+");
  assert.match(b.challenge, /^__Host-qm_app_challenge=[\w-]{43}$/);
  for (const c of [...b.start.headers["set-cookie"]!, ...done.headers["set-cookie"]!]) {
    assert.match(c, /Secure/);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Lax/);
    assert.match(c, /Path=\//);
    assert.doesNotMatch(c, /Domain=/i);
  }
  const cookie = f.cookieOf(done, "__Host-qm_app_session");
  assert.equal((await f.send("/api", { host: f.host, cookie })).status, 200);
  const identity = await verifyPortalIdentity(
    String(f.seen.at(-1)!.headers["x-portal-identity"]),
    viewerIdentityKey(secret, f.d.id),
    Date.now(),
  );
  assert.equal(identity?.p, "viewer");
  assert.equal((await f.atApp(ticket, b.challenge)).status, 401, "one-time callback cannot be replayed");
});

test("callback redemption is atomic; parallel tabs and claim-store outages fail closed", async (t) => {
  const f = await fixture(t);
  const a = await f.begin();
  const b = await f.begin();
  const ticket = await f.launch("viewer", a.source.pathname + a.source.search);
  assert.equal((await f.atApp(ticket, b.challenge)).status, 401, "superseded challenge cannot redeem older tab");
  const results = await Promise.all([f.atApp(ticket, a.challenge), f.atApp(ticket, a.challenge)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [302, 401]);
  const broken = await fixture(t, "configured", {
    durable: true,
    claim: async () => {
      throw new Error("offline");
    },
  });
  const c = await broken.begin();
  const failed = await broken.atApp(await broken.launch("viewer", c.source.pathname + c.source.search), c.challenge);
  assert.equal(failed.status, 503);
  assert.equal(failed.headers["set-cookie"], undefined);
  assert.equal(broken.seen.length, 0);
});

test("production handoff requires durable replay state; local uses existing memory replay", async (t) => {
  const f = await fixture(t, "configured", createMemoryReplayDedupe());
  assert.equal((await f.launch()).status, 503);
  const local = await fixture(t, "local");
  const source = "http://localhost:5173";
  const done = await local.complete("viewer", "/d/alpha/", source);
  assert.equal(done.done.status, 302);
  assert.match(done.cookie, /^__Host-qm_app_session=/);
  assert.equal((await local.send("/", { host: local.host, cookie: done.cookie })).status, 200);
});

test("only configured production or explicit local source return origins are honored", async (t) => {
  const f = await fixture(t);
  for (const source of [
    "https://evil.example.test",
    "http://localhost:5173",
    portal + "/path",
    portal + "?q=x",
    portal + "#x",
    "https://user@portal.example.test",
  ]) {
    assert.equal((await f.launch("owner", "/d/alpha/", "GET", { "x-qm-launch-origin": source })).status, 400, source);
  }
  const b = await f.begin();
  assert.equal(
    (
      await f.launch("viewer", b.source.pathname + b.source.search, "GET", {
        "x-qm-launch-origin": "https://evil.example.test",
      })
    ).status,
    400,
  );
  const local = await fixture(t, "local");
  for (const source of ["http://localhost:5173", "http://127.0.0.1:4100", "http://[::1]:4300"]) {
    assert.equal((await local.complete("viewer", "/d/alpha/", source)).done.status, 302);
  }
  for (const source of ["http://localhost.evil.test:5173", "http://app.localhost:5173", "http://127.0.0.2:5173"]) {
    assert.equal((await local.launch("owner", "/d/alpha/", "GET", { "x-qm-launch-origin": source })).status, 400);
  }
  const other = await local.begin("viewer", "/d/alpha/", "http://localhost:5173");
  assert.equal(
    (
      await local.launch("viewer", other.source.pathname + other.source.search, "GET", {
        "x-qm-launch-origin": "http://localhost:4300",
      })
    ).status,
    401,
  );
});

test("stale cookie navigation restarts source login; assets/API/writes stay 401 and all app query bytes survive", async (t) => {
  const f = await fixture(t);
  const path = "/deep?owner=app&access=a%20b&dpl_signin=1&x=+&x=%2f";
  for (const cookie of ["", "__Host-qm_app_session=junk", await f.session("viewer", { exp: Date.now() - 1 })]) {
    const nav = await f.send(path, { host: f.host, cookie, "sec-fetch-dest": "document", accept: "text/html" });
    assert.equal(nav.status, 302, nav.body);
    assert.equal(nav.headers.location, `${portal}/d/${f.d.id}${path}`);
    for (const [method, dest] of [
      ["GET", "script"],
      ["GET", "empty"],
      ["POST", "document"],
    ]) {
      assert.equal(
        (await f.send(path, { host: f.host, cookie, "sec-fetch-dest": dest!, accept: "text/html" }, method)).status,
        401,
      );
    }
  }
  assert.equal((await f.send(path, { host: f.host, cookie: await f.session() })).status, 200);
  assert.equal(f.seen.at(-1)!.path, path);
});

test("owner bearer and parent portal credentials no longer authorize app runtime or switch active actor", async (t) => {
  const f = await fixture(t);
  const owner = await mintDeployOwnerToken(gateSecret, { slug: f.d.id, sub: "owner", exp: Date.now() + 60_000 });
  for (const path of ["/api", "/?owner=" + owner]) {
    assert.equal((await f.send(path, { host: f.host, cookie: `dpl_owner=${owner}` })).status, 401);
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({ k: "session", sub: "owner", org: "acme", iat: now, exp: now + 3600 }),
  ).toString("base64url");
  const key = createHmac("sha256", "legacy-secret").update("portal.session.v1").digest();
  const parentCookie = `portal_session=${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
  assert.equal(
    (await f.send("/api", { host: f.host, cookie: parentCookie })).status,
    401,
    "even a correctly signed legacy parent cookie is not app authority",
  );
  const ownPage = await f.send("/", { host: f.host, cookie: await f.session("owner"), "sec-fetch-dest": "document" });
  assert.equal(ownPage.status, 200);
  assert.doesNotMatch(ownPage.body, /__qmAppShell/);
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), null, { createdBy: "owner" });
  assert.equal((await f.send("/", { host: f.host, cookie: `${await f.session()}; dpl_owner=${owner}` })).status, 403);
  await f.identity.deactivate("owner");
  assert.equal((await f.send("/", { host: f.host, cookie: await f.session("owner") })).status, 403);
});

test("friendly hosts are redirect-only in production AND local, never receive new app execution after slug reuse", async (t) => {
  for (const mode of ["configured", "local"] as const) {
    const f = await fixture(t, mode);
    await f.app.renameDeployment(f.d.id, "renamed");
    const d2 = await f.app.deploy({
      name: "alpha",
      createdBy: "owner",
      ownerScopeId: scopeId("personal", "owner"),
      entrypoint: "x",
      files: [],
    });
    const alias = mode === "local" ? `alpha.apps.localhost:${f.port}` : "alpha.apps.example.test";
    const next = f.origin.replace(f.d.id, d2.id);
    assert.equal((await f.send("/deep?owner=x", { host: alias })).headers.location, next + "/deep?owner=x");
    for (const [path, method] of [
      ["/", "POST"],
      ["/__qm/launch?ticket=x", "GET"],
    ])
      assert.equal((await f.send(path!, { host: alias }, method)).status, 405);
    assert.equal(f.seen.length, 0);
  }
});

test("cross-origin authenticated reads/writes and mismatched fetch metadata fail before upstream, upstream CORS is removed", async (t) => {
  const f = await fixture(t);
  const cookie = await f.session();
  for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    for (const origin of ["null", "https://sibling.apps.example.test", portal]) {
      assert.equal((await f.send("/api", { host: f.host, cookie, origin }, method)).status, 403);
    }
  }
  assert.equal(
    (await f.send("/api", { host: f.host, cookie, origin: f.origin, "sec-fetch-site": "same-site" }, "POST")).status,
    403,
  );
  assert.equal(f.seen.length, 0);
  const ok = await f.send("/api", { host: f.host, cookie, origin: f.origin }, "POST", "works");
  assert.equal(ok.status, 200);
  assert.equal(f.seen.at(-1)!.body, "works");
  assert.equal(ok.headers["access-control-allow-origin"], undefined);
  assert.equal(ok.headers["access-control-allow-credentials"], undefined);
  assert.equal(ok.headers["cache-control"], "private, no-store");
  assert.equal(ok.headers["cdn-cache-control"], undefined);
  assert.equal(ok.headers["surrogate-control"], undefined);
});

test("gateway strips reserved cookies and spoofed authority headers but preserves app auth; duplicate session cookie fails closed", async (t) => {
  const f = await fixture(t);
  const cookie = await f.session();
  const r = await f.send("/api", {
    host: f.host,
    cookie: `${cookie}; __Host-qm_app_challenge=secret; __Host-portal_session=secret; portal_session=secret; dpl_owner=secret; webuiuser=secret; qm_idp_session=secret; __Host-qm_idp_session=secret; theme=dark`,
    authorization: "Bearer app-owned",
    "x-agent-capability": "evil",
    "x-source-auth": "evil",
    "x-qm-launch-origin": "evil",
    "x-forwarded-user": "evil",
    "x-forwarded-host": "evil",
    forwarded: "evil",
    "x-real-ip": "evil",
    "x-signature": "evil",
    "x-admin-actor": "evil",
  });
  assert.equal(r.status, 200);
  const headers = f.seen.at(-1)!.headers;
  assert.equal(headers.cookie, "theme=dark");
  assert.equal(headers.authorization, "Bearer app-owned");
  for (const name of [
    "x-agent-capability",
    "x-source-auth",
    "x-qm-launch-origin",
    "x-forwarded-user",
    "forwarded",
    "x-real-ip",
    "x-signature",
    "x-admin-actor",
  ])
    assert.equal(headers[name], undefined, name);
  assert.equal(headers["x-forwarded-host"], f.host);
  assert.deepEqual(r.headers["set-cookie"], [
    "app_pref=ok; Path=/; SameSite=Lax",
    "app_other=yes; HttpOnly; Path=/deep",
  ]);
  assert.equal((await f.send("/api", { host: f.host, cookie: cookie + "; " + cookie })).status, 401);
});

test("new app auth/control namespaces never pass to upstream", async (t) => {
  const f = await fixture(t);
  const cookie = await f.session("owner");
  for (const path of ["/__qm/unknown", "/__claw__/unknown", "/__claw__/version"]) {
    assert.equal((await f.send(path, { host: f.host, cookie })).status, 404);
  }
  assert.equal(f.seen.length, 0);
});

test("owner editor link stays on the trusted surface, checks active manager and never mints runtime owner authority", async (t) => {
  const f = await fixture(t);
  const path = `/v1/deployments/${f.d.id}/owner-url?principalId=owner`;
  const timestamp = Math.floor(Date.now() / 1000);
  const { signRequest } = await import("../src/auth/source-auth.ts");
  const { mintPortalIdentity } = await import("../src/auth/portal-identity.ts");
  const r = await f.send(path, {
    "x-timestamp": String(timestamp),
    "x-signature": signRequest(secret, timestamp, `GET\n${path}\n`),
    "x-portal-identity": await mintPortalIdentity(
      { p: "owner", exp: Date.now() + 60_000 },
      "portal-identity-origin-secret",
    ),
  });
  assert.equal(r.status, 200, r.body);
  const url = new URL(JSON.parse(r.body).url);
  assert.equal(url.origin, portal);
  assert.equal(url.pathname, "/app-edit");
  assert.equal(url.searchParams.get("slug"), f.d.id);
  assert.equal(url.searchParams.has("owner"), false);
});

test("encoded gateway routes and request-access are never forwarded, even for an authorized owner", async (t) => {
  const f = await fixture(t);
  const cookie = await f.session("owner");
  for (const path of [
    "/__qm%2funknown",
    "/%255f%255fqm/unknown",
    "/__claw__%2fversion",
    "/__qm",
    "/__claw__",
    "/__claw__/request-access",
  ]) {
    assert.equal((await f.send(path, { host: f.host, cookie })).status, 404, path);
  }
  for (const path of ["/a/%2e%2e/b", "/%252e%252e/b", "//evil.test"])
    assert.equal((await f.send(path, { host: f.host, cookie })).status, 400, path);
  assert.equal(
    (await f.send("/__claw__/request-access", { host: f.host, cookie, origin: f.origin }, "POST")).status,
    404,
  );
  assert.equal(f.seen.length, 0);
});

test("ACL revocation between ticket issue and callback denies the clean app request; deactivation blocks callback itself", async (t) => {
  const f = await fixture(t);
  const b = await f.begin();
  const ticket = await f.launch("viewer", b.source.pathname + b.source.search);
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), null, { createdBy: "owner" });
  const done = await f.atApp(ticket, b.challenge);
  assert.equal(done.status, 302, "app session is identity, not an ACL grant");
  const cookie = f.cookieOf(done, "__Host-qm_app_session");
  for (const path of ["/", "/assets/app.js", "/api"])
    assert.equal((await f.send(path, { host: f.host, cookie })).status, 403);
  assert.equal(f.seen.length, 0);
  await f.app.shareDeployment(f.d.id, scopeId("personal", "viewer"), "read", { createdBy: "owner" });
  const next = await f.begin();
  const callback = await f.launch("viewer", next.source.pathname + next.source.search);
  await f.identity.deactivate("viewer");
  assert.equal((await f.atApp(callback, next.challenge)).status, 403);
});

test("app hosts never fall through to core APIs, and callback/header failures cannot reach upstream", async (t) => {
  const f = await fixture(t);
  for (const host of [f.host, "unknown.apps.example.test", `nested.${f.host}`]) {
    const result = await f.send("/v1/config", { host, "x-as-principal": "owner", "x-forwarded-host": "localhost" });
    assert.ok([401, 404].includes(result.status));
  }
  const b = await f.begin();
  const callback = await f.launch("viewer", b.source.pathname + b.source.search);
  const url = new URL(String(callback.headers.location));
  assert.equal(
    (await f.send(url.pathname + url.search + "&ticket=junk", { host: f.host, cookie: b.challenge })).status,
    401,
  );
  assert.equal((await f.send(url.pathname + url.search, { host: f.host, cookie: b.challenge }, "POST")).status, 405);
  assert.equal(
    (await f.send(b.source.pathname + b.source.search, { "x-as-principal": "owner", "x-qm-launch-origin": portal }))
      .status,
    401,
  );
  assert.equal(f.seen.length, 0);
});

test("HEAD launch follows the same browser-bound handshake without proxying a body", async (t) => {
  const f = await fixture(t);
  const launch = await f.launch("viewer", "/d/alpha/", "HEAD");
  const u = new URL(String(launch.headers.location));
  const start = await f.send(u.pathname + u.search, { host: u.host }, "HEAD");
  assert.equal(start.status, 302);
  const source = new URL(String(start.headers.location));
  const ticket = await f.launch("viewer", source.pathname + source.search, "HEAD");
  const callback = new URL(String(ticket.headers.location));
  const done = await f.send(
    callback.pathname + callback.search,
    { host: callback.host, cookie: f.cookieOf(start, "__Host-qm_app_challenge") },
    "HEAD",
  );
  assert.equal(done.status, 302);
  assert.equal(done.body, "");
  assert.equal(done.headers.location, "/");
  const page = await f.send("/", { host: f.host, cookie: f.cookieOf(done, "__Host-qm_app_session") }, "HEAD");
  assert.equal(page.status, 200);
  assert.equal(page.body, "");
});

test("surface challenge protocol never reaches upstream when replayed as an asset or write", async (t) => {
  const f = await fixture(t);
  const b = await f.begin();
  for (const [method, dest] of [
    ["GET", "script"],
    ["POST", "document"],
  ]) {
    const r = await f.launch("viewer", b.source.pathname + b.source.search, method, { "sec-fetch-dest": dest! });
    assert.equal(r.status, 400);
  }
  assert.equal(f.seen.length, 0);
});

test("in-memory replay requires explicit non-production, not an omitted production setting", async (t) => {
  const f = await fixture(t, "configured", createMemoryReplayDedupe(), true);
  assert.equal((await f.launch()).status, 503);
});
