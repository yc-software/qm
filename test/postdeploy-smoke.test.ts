import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDeployedHealth,
  checkLiveSession,
  checkSlackCredentials,
  deployedHealthUrls,
  firstAdminPrincipal,
  INVALID_INDEX_QUERY,
  PARALLEL_EXCEPTION_QUERY,
  stagingApiHeaders,
} from "../src/deployment/postdeploy-smoke.ts";
import { PORTAL_IDENTITY_HEADER, verifyPortalIdentity } from "../src/auth/portal-identity.ts";

test("deployed database smoke rejects the parallel exception-handler failure class", () => {
  assert.match(PARALLEL_EXCEPTION_QUERY, /p\.proparallel = 's'/);
  assert.ok(PARALLEL_EXCEPTION_QUERY.includes("p.prosrc ~* '\\mEXCEPTION\\M'"));
  assert.match(PARALLEL_EXCEPTION_QUERY, /l\.lanname = 'plpgsql'/);
});

test("deployed database smoke rejects invalid or unready indexes", () => {
  assert.match(INVALID_INDEX_QUERY, /NOT i\.indisvalid OR NOT i\.indisready/);
});

test("deployed API smoke uses a configured real org admin", () => {
  assert.equal(firstAdminPrincipal("josh@example.com:org_admin,other@example.com:org_admin"), "josh@example.com");
  assert.throws(() => firstAdminPrincipal(undefined), /requires ADMIN_GRANTS/);
  assert.throws(() => firstAdminPrincipal("josh@example.com:viewer"), /requires ADMIN_GRANTS/);
});

test("deployed API smoke proves the production portal-identity boundary", async () => {
  const now = Date.now();
  const headers = await stagingApiHeaders(
    "josh@example.com",
    "source-secret",
    "portal-secret",
    "GET",
    "/v1/admin/sessions",
    "",
    { "x-admin-actor": "josh@example.com@acme" },
    now,
  );
  assert.equal(headers["x-admin-actor"], "josh@example.com@acme");
  const actor = await verifyPortalIdentity(headers[PORTAL_IDENTITY_HEADER]!, "portal-secret", now);
  assert.equal(actor?.p, "josh@example.com");
});

test("deployed staging smoke reaches every Fly service and the public portal", () => {
  assert.deepEqual(deployedHealthUrls("qm-core", "https://qm-portal.fly.dev"), [
    "http://127.0.0.1:8080/healthz",
    "http://qm-admin.internal:8080/healthz",
    "http://qm-web-ui.flycast/healthz",
    "http://qm-portal.internal:8080/healthz",
    "https://qm-portal.fly.dev/healthz",
  ]);
  assert.throws(() => deployedHealthUrls("wrong-app", "https://example.com"), /FLY_APP_NAME ending in -core/);
});

test("deployed staging health rejects an unhealthy service", async () => {
  await assert.rejects(
    checkDeployedHealth(["http://core/healthz", "http://portal/healthz"], async (input) => {
      return new Response(null, { status: String(input).includes("portal") ? 503 : 200 });
    }),
    /http:\/\/portal\/healthz returned 503/,
  );
});

test("deployed staging smoke verifies its own Slack bot and Socket Mode credentials", async () => {
  const calls: Array<{ url: string; authorization: string | null }> = [];
  await checkSlackCredentials("xoxb-secret", "xapp-secret", "https://slack.example/api", async (input, init) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ ok: true });
  });
  assert.deepEqual(calls, [
    { url: "https://slack.example/api/auth.test", authorization: "Bearer xoxb-secret" },
    { url: "https://slack.example/api/apps.connections.open", authorization: "Bearer xapp-secret" },
  ]);
  await assert.rejects(
    checkSlackCredentials("xoxb-secret", "xapp-secret", undefined, async () =>
      Response.json({ ok: false, error: "invalid_auth" }),
    ),
    /Slack auth\.test failed: invalid_auth/,
  );
});

test("live session smoke proves a model turn, persistence, title, error log, and cleanup", async () => {
  const calls: Array<{ method: string; path: string; body: string; portalIdentity: string | null }> = [];
  const config = {
    adminGrants: "josh@example.com:org_admin",
    orgId: "acme",
    portalIdentitySecret: "portal-secret",
    signingSecret: "source-secret",
  };
  await checkLiveSession(config, "http://core.internal:8080", async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: String(init?.body ?? ""),
      portalIdentity: new Headers(init?.headers).get(PORTAL_IDENTITY_HEADER),
    });
    if (url.pathname === "/v1/turns")
      return Response.json({ status: "ok", sessionId: "sess-1", reply: "QM deployment canary passed." });
    if (url.pathname === "/v1/admin/errors") return Response.json({ errors: [] });
    if (method === "POST") return Response.json({ session: { id: "sess-1", archived: true } });
    return Response.json({
      session: { id: "sess-1", title: "Deployment canary" },
      entries: [{ type: "user" }, { type: "assistant" }],
    });
  });
  assert.deepEqual(
    calls.map(({ method, path }) => [method, path]),
    [
      ["POST", "/v1/turns"],
      ["GET", "/v1/sessions/sess-1?viewer=josh%40example.com&tailTurns=1"],
      ["GET", "/v1/admin/errors?scope=personal%3Ajosh%40example.com&sessionId=sess-1"],
      ["POST", "/v1/sessions/sess-1"],
    ],
  );
  assert.equal(JSON.parse(calls[0]!.body).readOnly, true);
  assert.equal(JSON.parse(calls[0]!.body).skipMemory, true);
  assert.deepEqual(JSON.parse(calls[3]!.body), { principalId: "josh@example.com", archived: true });
  for (const call of calls) {
    const identity = await verifyPortalIdentity(call.portalIdentity ?? "", "portal-secret", Date.now());
    assert.equal(identity?.p, "josh@example.com", `${call.method} ${call.path} carries the canary identity`);
  }

  let archivedFailedSession = false;
  await assert.rejects(
    checkLiveSession(config, "http://core.internal:8080", async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/turns")
        return Response.json({ status: "ok", sessionId: "sess-2", reply: "QM deployment canary passed." });
      if (path === "/v1/sessions/sess-2" && init?.method === "POST") archivedFailedSession = true;
      return Response.json({ session: { id: "sess-2" }, entries: [{ type: "user" }, { type: "assistant" }] });
    }),
    /generated title/,
  );
  assert.equal(archivedFailedSession, true);

  await assert.rejects(
    checkLiveSession(config, "http://core.internal:8080", async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/turns") return Response.json({ status: "ok", sessionId: "sess-3", reply: "Looks good" });
      return Response.json({ session: { id: "sess-3", archived: true } });
    }),
    /unexpected model reply/,
  );

  let failedThreadRef = "";
  let archivedFailedRequest = false;
  await assert.rejects(
    checkLiveSession(config, "http://core.internal:8080", async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/turns") {
        failedThreadRef = JSON.parse(String(init?.body)).conversation.threadRef as string;
        return new Response("model failed", { status: 500 });
      }
      if (url.pathname === "/v1/admin/sessions") {
        return Response.json({ sessions: [{ id: "sess-500", threadRef: failedThreadRef }] });
      }
      if (url.pathname === "/v1/sessions/sess-500" && init?.method === "POST") archivedFailedRequest = true;
      return Response.json({ session: { id: "sess-500", archived: true } });
    }),
    /returned 500/,
  );
  assert.equal(archivedFailedRequest, true);
});
