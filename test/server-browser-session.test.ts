import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import type { AdminService } from "../src/admin/admin-service.ts";
import { createServer } from "../src/api/server.ts";
import { apiRoutes } from "../src/api/routes/index.ts";
import { sendJson } from "../src/api/http.ts";
import type { ApiCtx, Route } from "../src/api/routes/route.ts";
import { deriveKey, seal } from "../plugins/portal/src/session.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER, type PortalIdentity } from "../src/auth/portal-identity.ts";

const SIGNING = "browser-session-signing-secret-0123456789";
const PORTAL_IDENTITY = "browser-session-identity-secret-0123456789";
const CAPABILITY = "browser-session-capability-secret-0123456789";
const SESSION = "browser-session-cookie-secret-0123456789abc";
const ORIGIN = "https://qm.example.com";

const seen: { actor: unknown; principalId: string | null; body: unknown; dropOwner: unknown }[] = [];
const echo = (ctx: ApiCtx): void => {
  seen.push({
    actor: ctx.actor,
    principalId: ctx.url.searchParams.get("principalId"),
    body: ctx.body,
    dropOwner: ctx.req.headers["x-drop-owner"],
  });
  sendJson(ctx.res, 200, { ok: true });
};
const testRoutes: Route[] = [
  {
    method: "GET",
    path: "/v1/test/browser-read",
    auth: "source",
    actor: "query.principalId",
    browser: true,
    handle: echo,
  },
  {
    method: "POST",
    path: "/v1/test/browser-write",
    auth: "source",
    actor: "body.principalId",
    browser: true,
    handle: echo,
  },
  { method: "GET", path: "/v1/test/browser-person", auth: "source", actor: "person", browser: true, handle: echo },
  { method: "GET", path: "/v1/test/browser-undeclared", auth: "source", browser: true, handle: echo },
  { method: "GET", path: "/v1/test/service-read", auth: "source", actor: "query.principalId", handle: echo },
];
(apiRoutes as Route[]).push(...testRoutes);

const admin = {
  adminStatusOf: async (_tenant: unknown, { id }: { id: string }) => ({ isAdmin: id.startsWith("admin-") }),
} as unknown as AdminService;

const errorOf = async (r: Response) => (await r.json()) as { error: string; message: string };
const actorOf = () => seen[0]?.actor as PortalIdentity | undefined;

const nowS = (): number => Math.floor(Date.now() / 1000);

function sessionCookie(claims: Record<string, unknown> = {}): string {
  const session = { k: "session", sub: "alice", org: "default-org", iat: nowS(), exp: nowS() + 3600, ...claims };
  return `portal_session=${encodeURIComponent(seal(session, deriveKey(SESSION, "portal.session.v1")))}`;
}

function impersonationCookie(actor: string, target: string, org = "default-org"): string {
  const imp = { k: "impersonate", actor, target, org, iat: nowS(), exp: nowS() + 600 };
  return `portal_impersonate=${encodeURIComponent(seal(imp, deriveKey(SESSION, "portal.impersonate.v1")))}`;
}

async function withServer(
  fn: (base: string) => Promise<void>,
  overrides: Partial<Pick<ServerDeps, "portalSession" | "portalUrl" | "production" | "identity">> = {},
): Promise<void> {
  const server = createServer({} as App, {
    production: true,
    signingSecret: SIGNING,
    capabilitySecret: CAPABILITY,
    portalIdentitySecret: PORTAL_IDENTITY,
    portalSession: { secret: SESSION, maxAgeSeconds: 30 * 86400 },
    portalUrl: ORIGIN,
    replayDedupe: { claim: async () => true },
    admin,
    ...overrides,
  });
  server.listen(0);
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const write = (base: string, cookie: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/v1/test/browser-write`, {
    method: "POST",
    headers: {
      cookie,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("a signed-in browser reads its own principal, filled in when the client omits it", async () => {
  await withServer(async (base) => {
    seen.length = 0;
    const r = await fetch(`${base}/v1/test/browser-read`, { headers: { cookie: sessionCookie({ name: "Alice" }) } });
    assert.equal(r.status, 200);
    assert.equal(seen[0]?.principalId, "alice");
    const actor = actorOf();
    assert.deepEqual([actor?.p, actor?.authenticatedAs, actor?.n, actor?.imp], ["alice", "alice", "Alice", undefined]);
    const own = await fetch(`${base}/v1/test/browser-read?principalId=alice`, { headers: { cookie: sessionCookie() } });
    assert.equal(own.status, 200);
  });
});

test("a client-supplied principalId for someone else is refused", async () => {
  await withServer(async (base) => {
    const read = await fetch(`${base}/v1/test/browser-read?principalId=bob`, { headers: { cookie: sessionCookie() } });
    assert.equal(read.status, 403);
    assert.equal((await errorOf(read)).message, "portal identity does not match the requested actor");
    const w = await write(base, sessionCookie(), { principalId: "bob" });
    assert.equal(w.status, 403);
    seen.length = 0;
    const filled = await write(base, sessionCookie(), { title: "x" });
    assert.equal(filled.status, 200);
    assert.deepEqual(seen[0]?.body, { title: "x", principalId: "alice" });
  });
});

test("a principalId naming someone else is refused on any opted-in route, however it is spelled", async () => {
  await withServer(async (base) => {
    const cookie = { headers: { cookie: sessionCookie() } };
    for (const path of [
      "/v1/test/browser-read?principalId=alice&principalId=bob",
      "/v1/test/browser-person?principalId=bob",
    ]) {
      const r = await fetch(`${base}${path}`, cookie);
      assert.equal(r.status, 403, path);
    }
    for (const principalId of [["alice"], 7, null]) {
      const w = await write(base, sessionCookie(), { principalId });
      assert.equal(w.status, 403, JSON.stringify(principalId));
    }
    const person = await fetch(`${base}/v1/test/browser-person?principalId=alice`, cookie);
    assert.equal(person.status, 200);
  });
});

test("an unconfigured browser lane says so instead of blaming the cookie", async () => {
  for (const overrides of [
    { portalSession: { secret: "short", maxAgeSeconds: 86400 } },
    { portalSession: { secret: SIGNING, maxAgeSeconds: 86400 } },
    { portalSession: { secret: SESSION, maxAgeSeconds: Number.NaN } },
    { portalUrl: "not a url" },
  ]) {
    await withServer(async (base) => {
      const r = await fetch(`${base}/v1/test/browser-read`, { headers: { cookie: sessionCookie() } });
      assert.equal(r.status, 503);
      assert.equal((await errorOf(r)).message, "browser sign-in is not configured on this server");
    }, overrides);
  }
});

test("a session sealed for another org does not authenticate", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/v1/test/browser-read`, { headers: { cookie: sessionCookie({ org: "other-org" }) } });
    assert.equal(r.status, 401);
    assert.equal((await errorOf(r)).message, "a sign-in session for this organization is required");
  });
});

test("forged, expired and over-age sessions do not authenticate", async () => {
  await withServer(async (base) => {
    const forged = `portal_session=${encodeURIComponent(seal({ k: "session", sub: "alice", org: "default-org", iat: nowS(), exp: nowS() + 3600 }, deriveKey("wrong-secret-0123456789abcdef0123", "portal.session.v1")))}`;
    for (const cookie of [forged, sessionCookie({ exp: nowS() - 1 }), sessionCookie({ auth: nowS() - 40 * 86400 })]) {
      const r = await fetch(`${base}/v1/test/browser-read`, { headers: { cookie } });
      assert.equal(r.status, 401);
    }
  });
});

test("cross-origin writes are refused", async () => {
  await withServer(async (base) => {
    const evil = await write(
      base,
      sessionCookie(),
      {},
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    );
    assert.equal(evil.status, 403);
    assert.equal((await errorOf(evil)).message, "cross-origin request refused");
    const sameSite = await write(
      base,
      sessionCookie(),
      {},
      { origin: "https://apps.qm.example.com", "sec-fetch-site": "same-site" },
    );
    assert.equal(sameSite.status, 403);
    const noFetchMetadata = await fetch(`${base}/v1/test/browser-write`, {
      method: "POST",
      headers: { cookie: sessionCookie(), "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(noFetchMetadata.status, 403);
  });
});

test("apps-only sign-ins are refused", async () => {
  await withServer(async (base) => {
    const appOnly = await fetch(`${base}/v1/test/browser-read`, {
      headers: { cookie: sessionCookie({ appOnly: true }) },
    });
    assert.equal(appOnly.status, 403);
    assert.equal((await errorOf(appOnly)).error, "app_only_session");
  });
});

test("impersonation is ignored on requests from another origin", async () => {
  await withServer(async (base) => {
    seen.length = 0;
    const cookie = `${sessionCookie({ sub: "admin-alice" })}; ${impersonationCookie("admin-alice", "carol")}`;
    const foreign = await fetch(`${base}/v1/test/browser-read`, {
      headers: { cookie, origin: "https://embedder.example.com" },
    });
    assert.equal(foreign.status, 200);
    assert.equal(seen[0]?.principalId, "admin-alice");
    const own = await fetch(`${base}/v1/test/browser-read`, { headers: { cookie, origin: ORIGIN } });
    assert.equal(own.status, 200);
    assert.equal(seen[1]?.principalId, "carol");
  });
});

test("impersonation is honoured only for an admin's own impersonation cookie", async () => {
  await withServer(async (base) => {
    seen.length = 0;
    const asAdmin = await fetch(`${base}/v1/test/browser-read`, {
      headers: { cookie: `${sessionCookie({ sub: "admin-alice" })}; ${impersonationCookie("admin-alice", "carol")}` },
    });
    assert.equal(asAdmin.status, 200);
    assert.equal(seen[0]?.principalId, "carol");
    assert.equal(actorOf()?.imp, "admin-alice");

    seen.length = 0;
    const nonAdmin = await fetch(`${base}/v1/test/browser-read`, {
      headers: { cookie: `${sessionCookie({ sub: "mallory" })}; ${impersonationCookie("mallory", "carol")}` },
    });
    assert.equal(nonAdmin.status, 200);
    assert.equal(seen[0]?.principalId, "mallory");
    assert.equal(actorOf()?.imp, undefined);

    seen.length = 0;
    const otherOrg = await fetch(`${base}/v1/test/browser-read`, {
      headers: {
        cookie: `${sessionCookie({ sub: "admin-alice" })}; ${impersonationCookie("admin-alice", "carol", "other-org")}`,
      },
    });
    assert.equal(otherOrg.status, 200);
    assert.equal(seen[0]?.principalId, "admin-alice");

    const borrowed = await fetch(`${base}/v1/test/browser-read?principalId=carol`, {
      headers: { cookie: `${sessionCookie({ sub: "admin-bob" })}; ${impersonationCookie("admin-alice", "carol")}` },
    });
    assert.equal(borrowed.status, 403);
  });
});

test("routes that have not opted in stay closed to cookies, and signed callers are unchanged", async () => {
  await withServer(async (base) => {
    const cookieOnly = await fetch(`${base}/v1/test/service-read?principalId=alice`, {
      headers: { cookie: sessionCookie() },
    });
    assert.equal(cookieOnly.status, 401);
    const path = withSourceAuthNonce("/v1/test/browser-read?principalId=bob", SIGNING);
    const signed = await fetch(`${base}${path}`, {
      headers: {
        ...signedHeaders(SIGNING, "GET", path),
        [PORTAL_IDENTITY_HEADER]: await mintPortalIdentity({ p: "bob", exp: Date.now() + 60_000 }, PORTAL_IDENTITY),
        cookie: sessionCookie(),
      },
    });
    assert.equal(signed.status, 200);
    const forgedSignature = await fetch(`${base}/v1/test/browser-read`, {
      headers: { cookie: sessionCookie(), "x-signature": "nope", "x-timestamp": String(nowS()) },
    });
    assert.equal(forgedSignature.status, 401);
  });
});

test("the browser lane binds the actor even where signed portal identity is not required", async () => {
  await withServer(
    async (base) => {
      const read = await fetch(`${base}/v1/test/browser-read?principalId=bob`, {
        headers: { cookie: sessionCookie() },
      });
      assert.equal(read.status, 403);
      const w = await write(base, sessionCookie(), { principalId: "bob" });
      assert.equal(w.status, 403);
    },
    { production: false },
  );
});

test("deactivated people and relay-only identity headers get nothing from a cookie", async () => {
  const identity = {
    refresh: async () => {},
    classify: (id: string) => ({ type: id === "gone" ? "external" : "internal" }),
  } as unknown as ServerDeps["identity"];
  await withServer(
    async (base) => {
      const gone = await fetch(`${base}/v1/test/browser-read`, { headers: { cookie: sessionCookie({ sub: "gone" }) } });
      assert.equal(gone.status, 401);
      assert.equal((await errorOf(gone)).message, "principal is no longer active");
      const undeclared = await fetch(`${base}/v1/test/browser-undeclared`, {
        headers: { cookie: sessionCookie({ sub: "gone" }) },
      });
      assert.equal(undeclared.status, 401);
      seen.length = 0;
      const smuggled = await fetch(`${base}/v1/test/browser-read`, {
        headers: { cookie: sessionCookie(), "x-drop-owner": "bob" },
      });
      assert.equal(smuggled.status, 200);
      assert.equal(seen[0]?.dropOwner, undefined);
    },
    { identity },
  );
});

test("every opted-in production route binds the caller's identity", () => {
  for (const route of apiRoutes) {
    if (!route.browser || testRoutes.includes(route)) continue;
    assert.ok(
      route.actor && route.actor !== "system",
      `${"path" in route ? route.path : "match route"} must bind an actor`,
    );
  }
});
