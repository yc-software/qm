import "./support/auto-fake-sprites.ts";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { ServerDeps } from "../src/api/deps.ts";
import { webMeConfig } from "../src/api/routes/web-me.ts";
import { orgId, orgScope } from "../src/config.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { serverDeps } from "../src/wiring.ts";
import { buildApp, stopAtEnd } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { browserImpersonationCookie, browserSessionCookie, browserSessionDeps } from "./support/browser-session.ts";
import { testTenant } from "./support/test-tenant.ts";

const config = testConfig({ signingSecret: "web-me-signing-secret-0123456789abcdef" });
const built = stopAtEnd(buildApp(config));
const activities = [{ id: "app", title: "Build a home", prompt: "Build a project tracker.", icon: "app" }];
const webMe = webMeConfig({
  WEB_UI_ANALYTICS: JSON.stringify({
    module: "https://cdn.example.com/analytics.js",
    connect: ["https://events.example.com"],
    options: { key: "public" },
  }),
  SENTRY_BROWSER_DSN: "https://public@sentry.example.com/1",
  SENTRY_RELEASE: "release-1",
  WEB_UI_WELCOME_COHORT: " spring ",
  WEB_UI_SUGGESTED_ACTIVITIES: JSON.stringify(activities),
});

async function serve(deps: Partial<ServerDeps> = {}): Promise<string> {
  const server = createServer(built.app, {
    ...serverDeps(config, built),
    ...browserSessionDeps,
    web: { events: {} as never, me: webMe, shell: { release: async () => undefined } as never },
    suggestedActivities: undefined,
    ...deps,
  } as ServerDeps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const base = await serve();

async function me(cookie: string, at = base): Promise<Record<string, unknown>> {
  const response = await fetch(`${at}/me`, { headers: { cookie } });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as Record<string, unknown>;
}

test("/me describes the signed-in person, the company and the web app's settings, in the relay's shape", async () => {
  await built.app.setDirectoryWorkspaceUrl(testTenant, "https://acme.slack.com");
  await built.config.setBranding(orgScope() as ScopeId, { orgName: " Acme " });
  const body = await me(browserSessionCookie("bob@example.com", { name: " Bob " }));
  assert.deepEqual(body, {
    user: "bob@example.com",
    org: orgId(),
    companyName: "Acme",
    workspace: null,
    analytics: { module: "https://cdn.example.com/analytics.js", options: { key: "public" } },
    browserErrors: { dsn: "https://public@sentry.example.com/1", release: "release-1" },
    mode: "portal",
    slackWorkspaceUrl: "https://acme.slack.com",
    individualModelAuth: false,
    modelAuthConnected: false,
    impersonatedBy: null,
    displayName: "Bob",
    welcomeCohort: "spring",
    suggestedActivities: activities,
    permissions: [],
  });
  assert.equal((await fetch(`${base}/me`)).status, 401);
});

test("an impersonating admin sees the target's /me, marked as impersonated and without analytics or error reporting", async () => {
  const body = await me(
    `${browserSessionCookie("admin-alice", { name: "Admin" })}; ${browserImpersonationCookie("admin-alice", "carol@example.com")}`,
  );
  assert.equal(body.user, "carol@example.com");
  assert.equal(body.impersonatedBy, "admin-alice");
  assert.equal(body.displayName, null);
  assert.equal(body.analytics, undefined);
  assert.equal(body.browserErrors, undefined);
  assert.deepEqual(body.permissions, []);
  assert.deepEqual((await me(browserSessionCookie("admin-alice"))).permissions, ["admin"]);
});

test("an admin impersonating another admin gets no admin pages, since every admin route refuses impersonation", async () => {
  const cookie = `${browserSessionCookie("admin-alice")}; ${browserImpersonationCookie("admin-alice", "admin-bob")}`;
  const body = await me(cookie);
  assert.equal(body.user, "admin-bob");
  assert.deepEqual(body.permissions, []);
  assert.deepEqual((await me(browserSessionCookie("admin-bob"))).permissions, ["admin"]);
  assert.equal((await fetch(`${base}/api/admin/users`, { headers: { cookie } })).status, 403);
});

test("loops and inbox permissions follow the person's inbox_loops flag", async () => {
  const flag = (user: string, on: boolean) =>
    built.featureFlags.setEnabled("inbox_loops", scopeId("personal", user), on, "test");
  assert.deepEqual((await me(browserSessionCookie("alice@example.com"))).permissions, []);
  await flag("alice@example.com", true);
  assert.deepEqual((await me(browserSessionCookie("alice@example.com"))).permissions, ["loops", "inbox"]);
  assert.deepEqual((await me(browserSessionCookie("bob@example.com"))).permissions, []);
  await flag("alice@example.com", false);
});

test("with suggestion generation on, /me leaves the fallback suggestions to the generation request", async () => {
  const generating = await serve({ suggestedActivities: built.suggestedActivities ?? ({} as never) });
  const body = await me(browserSessionCookie("bob@example.com"), generating);
  assert.equal(body.suggestedActivitiesGeneration, true);
  assert.equal(body.suggestedActivities, undefined);
});
