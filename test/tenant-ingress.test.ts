import { after, before, describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import { createServer } from "../src/api/server.ts";
import { CAPABILITY_HEADER } from "../src/api/contract.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import { findRoute, type ApiCtx, type BaseCtx, type Route, type RouteTenant } from "../src/api/routes/route.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { sealOAuthState } from "../src/connectors/oauth.ts";
import { mintDeployGitAccess } from "../src/deploy/access-token.ts";
import type { SecretDropStore } from "../src/credentials/secret-drop.ts";
import type { DeliverResult } from "../src/webhooks/webhook-receiver.ts";
import { createManagedSlack } from "../src/surfaces/slack-managed.ts";
import { createHmac } from "node:crypto";
import type { App as BoltApp, ReceiverEvent } from "@slack/bolt";
import type { AckGate } from "../src/slack/deferred-ack.ts";
import { createHttpEventsReceiver } from "../src/slack/http-events.ts";
import { slackTeamOf } from "../src/slack/index.ts";
import { slackTeamTenant } from "../src/slack/slack-tables.ts";
import { boundTenant, isTenantId, withoutTenant, withTenant } from "../src/tenants/context.ts";
import { serverDeps } from "../src/wiring.ts";
import { signedRequestHeaders } from "../plugins/chassis/src/source-auth-sign.ts";
import { buildApp } from "./support/build-app.ts";
import { TEST_CAPABILITY_SECRET, testConfig } from "./support/test-config.ts";
import { testTenants } from "./support/test-tenants.ts";

const SIGNING_SECRET = "tenant-ingress-signing-secret-0123456789abcdef";
const APPS_DOMAIN = "apps.ingress.test";
const NO_TENANT = { error: "unauthorized", message: "this request carries no verifiable tenant" };

const MATCH_SAMPLES: Record<string, [string, string]> = {
  brokerGitHttp: ["GET", "/v1/credentials/git/gitlab/acme/repo.git/info/refs"],
  oauthCallback: ["GET", "/v1/connectors/oauth/github/callback"],
  serveDeploymentGit: ["GET", "/v1/deployments/dep-1/git/info/refs"],
  proxyAdminDeployment: ["GET", "/v1/admin/deployments/dep-1/proxy/"],
  proxyDeployment: ["GET", "/d/demo/"],
  proxy: ["GET", "/v1/sandbox-model/v1/models"],
  oauthStart: ["GET", "/v1/connectors/oauth/github/start"],
  cronById: ["GET", "/v1/crons/cron-1"],
};

const UNBOUND_ROUTES: Record<string, { tenant: RouteTenant; gap?: string }> = {
  "GET /healthz": { tenant: "none" },
  "GET /readyz": { tenant: "none" },
  "GET /v1/background-work": { tenant: "none" },
  "POST /v1/background-work": { tenant: "none" },
  "POST /slack/events": { tenant: "row" },
  "POST /v1/slack/managed/installation": { tenant: "row" },
  "DELETE /v1/slack/managed/installation": { tenant: "row" },
  "POST /v1/slack/managed/events": { tenant: "row" },
  "GET /v1/connectors/oauth/github/callback": { tenant: "row" },
  "GET /v1/deployments/dep-1/git/info/refs": { tenant: "row" },
  "POST /v1/webhooks/incoming/x": { tenant: "row", gap: "K2" },
  "POST /v1/loop-ingress/x": { tenant: "row", gap: "K2" },
  "GET /v1/keychain/drops/x/form": { tenant: "row", gap: "K1" },
  "POST /v1/keychain/drops/x": { tenant: "row", gap: "K1" },
};

type AnyRoute = Route<BaseCtx> | Route<ApiCtx>;

const allRoutes: AnyRoute[] = [...rawRoutes, ...apiRoutes];

function requestLine(route: AnyRoute): [string, string] {
  if ("path" in route) return [route.method, route.path.replace(/:[A-Za-z]+/g, "x")];
  const sample = MATCH_SAMPLES[route.handle.name];
  assert.ok(sample, `match route ${route.handle.name} needs a sample request in MATCH_SAMPLES`);
  return sample;
}

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

const [TENANT] = testTenants();
const config = testConfig();
const built = buildApp(config);
const MANAGED_TOKEN = "managed-slack-ingress-token-0123456789";
const SLACK_SIGNING_SECRET = "slack-ingress-signing-secret";
const TEAM = "TINGRESS";
const managedSlack = createManagedSlack({
  serviceUrl: "https://slack-service.ingress.test",
  token: MANAGED_TOKEN,
  stateSecret: "managed-slack-ingress-state-secret",
  store: built.slackInstallation,
  teamTenant: slackTeamTenant(),
  runtimes: { current: () => [], accounts: async () => [], refresh: async () => {} },
});
const slackSeen: Array<string | undefined> = [];
const dedupeSeen: Array<{ id: string; tenant: string | undefined }> = [];
let core: Server;
let slackReceiver: ReturnType<typeof createHttpEventsReceiver>;

before(async () => {
  await withTenant(TENANT, () =>
    built.slackInstallation.set({
      botToken: "xoxb-ingress",
      teamId: TEAM,
      installId: "install-ingress",
      updatedBy: "test",
    }),
  );
  const teamTenant = slackTeamTenant();
  slackReceiver = createHttpEventsReceiver({
    signingSecret: SLACK_SIGNING_SECRET,
    port: 0,
    tenantFor: async (body) => {
      const team = slackTeamOf(body);
      return team ? teamTenant(team) : null;
    },
  });
  slackReceiver.init?.({
    processEvent: async (event: ReceiverEvent) => {
      slackSeen.push(boundTenant());
      await event.ack();
      (event.customProperties?.ackGate as AckGate | undefined)?.persisted();
    },
  } as unknown as BoltApp);
  await slackReceiver.start(0 as never);
  core = createServer(built.app, {
    ...serverDeps(config, built),
    signingSecret: SIGNING_SECRET,
    replayDedupe: {
      claim: (id, expiresAtMs) => {
        dedupeSeen.push({ id, tenant: boundTenant() });
        return built.replayDedupe.claim(id, expiresAtMs);
      },
    },
    managedSlack,
    slackEventsPort: portOf(slackReceiver.server),
    deployAppsDomain: APPS_DOMAIN,
    deployGateSecret: "deploy-gate-secret-for-ingress-tests-0123",
  });
  await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve) => core.close(() => resolve()));
  await slackReceiver.stop(0 as never);
});

function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body = "",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: portOf(core), method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function tenantlessAuth(route: AnyRoute, method: string, path: string, body: string) {
  const sourceSigned = withoutTenant(() =>
    signedRequestHeaders(SIGNING_SECRET, method, path, body, { "content-type": "application/json" }),
  );
  const capability = async (aud?: string) => ({
    "content-type": "application/json",
    [CAPABILITY_HEADER]: await withoutTenant(() =>
      mintCapabilityToken(
        { actorId: "U1", scopeId: "personal:U1", ...(aud ? { aud } : {}), exp: Date.now() + 60_000 },
        TEST_CAPABILITY_SECRET,
      ),
    ),
  });
  if (route.auth === "public") return [{ "content-type": "application/json" }];
  if (route.auth === "source") return [sourceSigned];
  if (route.auth === "either") return [sourceSigned, await capability()];
  return [await capability(route.auth.aud)];
}

describe("the tenantless allow-list", () => {
  it("every match route has a sample request that resolves to it", () => {
    for (const route of rawRoutes) {
      const [method, path] = requestLine(route);
      assert.equal(findRoute(rawRoutes, method, path)?.route, route, `${method} ${path} resolves elsewhere`);
    }
    for (const route of apiRoutes) {
      const [method, path] = requestLine(route);
      assert.equal(findRoute(apiRoutes, method, path)?.route, route, `${method} ${path} resolves elsewhere`);
    }
  });

  it("names exactly the routes that may enter without a tenant", () => {
    const marked = Object.fromEntries(
      allRoutes.filter((route) => route.tenant).map((route) => [requestLine(route).join(" "), route.tenant]),
    );
    const listed = Object.fromEntries(Object.entries(UNBOUND_ROUTES).map(([line, entry]) => [line, entry.tenant]));
    assert.deepEqual(marked, listed);
  });
});

describe("fail-closed ingress", () => {
  it("rejects every unlisted route that carries no verifiable tenant", async () => {
    const admitted: string[] = [];
    for (const route of allRoutes) {
      const [method, path] = requestLine(route);
      if (route.tenant) continue;
      const body = method === "GET" || method === "DELETE" ? "" : "{}";
      for (const headers of await tenantlessAuth(route, method, path, body)) {
        const response = await send(method, path, headers, body);
        if (response.status !== 401 || JSON.stringify(parsed(response.body)) !== JSON.stringify(NO_TENANT))
          admitted.push(`${method} ${path} -> ${response.status} ${response.body.slice(0, 120)}`);
      }
    }
    assert.deepEqual(admitted, []);
  });

  it("rejects a public route that names a tenant only in an unsigned header", async () => {
    const response = await send("GET", "/v1/spend/export", { "x-qm-tenant": TENANT });
    assert.equal(response.status, 401);
    assert.deepEqual(parsed(response.body), NO_TENANT);
  });

  it("lets listed routes reach their handlers without a tenant", async () => {
    for (const line of Object.keys(UNBOUND_ROUTES)) {
      const [method, path] = line.split(" ");
      assert.ok(method && path);
      const response = await send(method, path, { "content-type": "application/json" }, method === "GET" ? "" : "{}");
      assert.notDeepEqual(parsed(response.body), NO_TENANT, `${line} was rejected at ingress`);
    }
  });

  it("serves health probes with no tenant", async () => {
    assert.equal((await send("GET", "/healthz")).status, 200);
  });
});

function recordTenant(seen: Array<string | undefined>): void {
  seen.push(boundTenant());
}

describe("row- and signed-source-resolved routes bind before tenant work", () => {
  it("the OAuth callback binds the tenant sealed into its state", async () => {
    const state = await withTenant(TENANT, () =>
      sealOAuthState(
        { provider: "github", principalId: "U1", redirectUri: "https://ingress.test/cb" },
        { secret: SIGNING_SECRET },
      ),
    );
    dedupeSeen.length = 0;
    const query = new URLSearchParams({ code: "code-1", state });
    await send("GET", `/v1/connectors/oauth/github/callback?${query}`);
    const claim = dedupeSeen.find((entry) => entry.id.startsWith("oauth:"));
    assert.equal(claim?.tenant, TENANT);
  });

  it("deploy git binds the tenant its access token carries", async (t: TestContext) => {
    const seen: Array<string | undefined> = [];
    t.mock.method(built.app, "deploymentGitRepoPath", async () => {
      recordTenant(seen);
      return null;
    });
    const token = await withTenant(TENANT, () =>
      mintDeployGitAccess(SIGNING_SECRET, { deploymentId: "dep-1", permission: "read", exp: Date.now() + 60_000 }),
    );
    const response = await send("GET", "/v1/deployments/dep-1/git/info/refs?service=git-upload-pack", {
      authorization: `Bearer ${token}`,
    });
    assert.equal(response.status, 404);
    assert.deepEqual(seen, [TENANT]);
  });

  it("incoming webhooks bind a tenant before delivery", { todo: "K2 resolves the webhook's tenant" }, async (t) => {
    const seen: Array<string | undefined> = [];
    t.mock.method(built.webhookReceiver, "deliver", async (): Promise<DeliverResult> => {
      recordTenant(seen);
      return { status: 404 };
    });
    await send("POST", "/v1/webhooks/incoming/x", { "content-type": "application/json" }, "{}");
    assert.equal(seen.length, 1);
    assert.ok(isTenantId(seen[0]));
  });

  it("loop ingress binds a tenant before receiving", { todo: "K2 resolves the loop source's tenant" }, async (t) => {
    const seen: Array<string | undefined> = [];
    t.mock.method(built.loopIngress, "receive", async () => {
      recordTenant(seen);
      return { status: 404, body: "" };
    });
    await send("POST", "/v1/loop-ingress/x", { "content-type": "application/json" }, "{}");
    assert.equal(seen.length, 1);
    assert.ok(isTenantId(seen[0]));
  });

  const dropRequests: Array<[string, string]> = [
    ["GET", "/v1/keychain/drops/x/form"],
    ["POST", "/v1/keychain/drops/x"],
  ];
  for (const [method, path] of dropRequests) {
    it(
      `secret drop ${method} binds a tenant before reading the drop`,
      { todo: "K1 resolves the drop row's tenant" },
      async (t) => {
        const seen: Array<string | undefined> = [];
        t.mock.method(built.secretDrops, "peek", async (): ReturnType<SecretDropStore["peek"]> => {
          recordTenant(seen);
          return { ok: false, reason: "not_found" };
        });
        const body = method === "GET" ? "" : "{}";
        const headers = withoutTenant(() =>
          signedRequestHeaders(SIGNING_SECRET, method, path, body, { "content-type": "application/json" }),
        );
        await send(method, path, headers, body);
        assert.equal(seen.length, 1);
        assert.ok(isTenantId(seen[0]));
      },
    );
  }

  it("managed Slack binds the verified installation's tenant before handling", async (t) => {
    const seen: Array<string | undefined> = [];
    t.mock.method(
      managedSlack,
      "handle",
      async (_req: unknown, res: { writeHead(status: number): { end(): void } }) => {
        recordTenant(seen);
        res.writeHead(204).end();
      },
    );
    const body = JSON.stringify({ installId: "install-ingress", body: { team_id: TEAM, api_app_id: "AINGRESS" } });
    await send(
      "POST",
      "/v1/slack/managed/events",
      { "content-type": "application/json", authorization: `Bearer ${MANAGED_TOKEN}` },
      body,
    );
    assert.deepEqual(seen, [TENANT]);
  });

  it("Slack events reach the receiver bound to the tenant that installed the workspace", async () => {
    slackSeen.length = 0;
    const raw = JSON.stringify({
      type: "event_callback",
      team_id: TEAM,
      event_id: "EvIngress",
      event: { type: "app_mention", channel: "C1", ts: "1.1" },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${raw}`).digest("hex")}`;
    const response = await send(
      "POST",
      "/slack/events",
      { "content-type": "application/json", "x-slack-signature": signature, "x-slack-request-timestamp": timestamp },
      raw,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(slackSeen, [TENANT]);
  });

  it(
    "the app subdomain proxy binds a tenant before loading the app",
    { todo: "T2 resolves the app host's tenant" },
    async (t) => {
      const seen: Array<string | undefined> = [];
      t.mock.method(built.app, "getDeployment", async () => {
        recordTenant(seen);
        return null;
      });
      await send("GET", "/", { host: `demo.${APPS_DOMAIN}` });
      assert.equal(seen.length, 1);
      assert.ok(isTenantId(seen[0]));
    },
  );
});
