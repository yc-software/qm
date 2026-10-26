import assert from "node:assert/strict";
import test from "node:test";
import { mountAdmin } from "./fixture.ts";

const SCOPE = "personal:alice@example.com";
const SCOPE_ENC = encodeURIComponent(SCOPE);
const routes = {
  "/scopes": { scopes: [{ scopeId: "org:acme" }, { scopeId: SCOPE }], environments: [] },
  "/sessions": { sessions: [] },
  "/files": { files: [] },
  "/errors": { errors: [], total: 0 },
  "/spend": { rows: [] },
  "/skills": { skills: [] },
};

async function landing(url: string) {
  const admin = await mountAdmin(url, routes);
  await admin.settle();
  const result = { location: admin.location(), views: [...admin.views], requests: admin.requests.map((r) => r.url) };
  admin.close();
  return result;
}

const dataRequest = (requests: URL[], path: string) => requests.find((url) => url.pathname === `/api/admin${path}`);

test("session deep links stay on their path and load the session", async () => {
  const plain = await landing("/settings/history/s/sess-1");
  assert.equal(plain.location, "/settings/history/s/sess-1");
  assert.ok(dataRequest(plain.requests, "/sessions/sess-1"));
  assert.equal((await landing("/settings/history/s/sess-1?turn=4")).location, "/settings/history/s/sess-1?turn=4");
});

test("legacy query-param session links canonicalize to the path form", async () => {
  const legacy = await landing(`/settings/history?scope=${SCOPE_ENC}&session=sess-1`);
  assert.equal(legacy.location, "/settings/history/s/sess-1");
  assert.equal(dataRequest(legacy.requests, "/sessions/sess-1")!.searchParams.get("scope"), SCOPE);
  assert.equal((await landing("/settings/history?scopecom&session=sess-1")).location, "/settings/history/s/sess-1");
});

test("scoped history moves the scope into the path and keeps kind, cron and cursor as query params", async () => {
  const scoped = await landing(`/settings/history?scope=${SCOPE_ENC}&kind=cron&cron=c1&cursor=17~s9`);
  assert.equal(scoped.location, `/settings/history/scopes/${SCOPE_ENC}?cron=c1&kind=cron&cursor=17%7Es9`);
  const list = dataRequest(scoped.requests, "/sessions")!.searchParams;
  assert.equal(list.get("scope"), SCOPE);
  assert.equal(list.get("cursor"), "17~s9");
  assert.equal(list.get("cron"), "c1");
  assert.equal(list.get("origin"), "cron");
  const canonical = await landing(`/settings/history/scopes/${SCOPE_ENC}?kind=cron&cron=c1`);
  assert.equal(canonical.location, `/settings/history/scopes/${SCOPE_ENC}?cron=c1&kind=cron`);
  assert.equal(dataRequest(canonical.requests, "/sessions")!.searchParams.get("scope"), SCOPE);
});

test("a scope whose encoding the portal would reject stays in the query form", async () => {
  const slash = "personal:a/b@example.com";
  const result = await landing(`/settings/history?scope=${encodeURIComponent(slash)}&kind=cron`);
  assert.equal(result.location, `/settings/history?scope=${encodeURIComponent(slash)}&kind=cron`);
  assert.equal(dataRequest(result.requests, "/sessions")!.searchParams.get("scope"), slash);
});

test("an undecodable scope segment falls back to the org instead of throwing", async () => {
  const result = await landing("/settings/history/scopes/%E0%A4%A");
  assert.equal(result.location, "/settings/history");
  assert.equal(dataRequest(result.requests, "/sessions")!.searchParams.get("scope"), "org:acme");
});

test("the spend window round-trips through the URL", async () => {
  const preset = await landing("/settings/spend?range=90d");
  assert.equal(preset.location, "/settings/spend?range=90d");
  assert.equal(dataRequest(preset.requests, "/spend")!.searchParams.get("bucket") !== null, true);
  assert.equal((await landing("/settings/spend")).location, "/settings/spend");
  assert.equal((await landing("/settings/spend?range=constructor")).location, "/settings/spend?range=30d");
  const custom = await landing("/settings/spend?range=7d&from=2026-09-01&to=2026-10-01");
  assert.equal(custom.location, "/settings/spend?from=2026-09-01&to=2026-10-01");
  const spend = dataRequest(custom.requests, "/spend")!.searchParams;
  assert.equal(spend.get("from")!.slice(0, 10), "2026-09-01");
  assert.equal(
    (await landing("/settings/spend?range=7d&from=2026-02-30&to=2026-03-02")).location,
    "/settings/spend?range=7d",
  );
});

test("scoped data views keep their query-param scope", async () => {
  const files = await landing(`/settings/files?scope=${SCOPE_ENC}`);
  assert.equal(files.location, `/settings/files?scope=${SCOPE_ENC}`);
  assert.equal(dataRequest(files.requests, "/files")!.searchParams.get("scope"), SCOPE);
});

test("a bare history URL is the org scope, while other views keep the last viewed scope", async () => {
  const admin = await mountAdmin(`/settings/files?scope=${SCOPE_ENC}`, routes);
  await admin.settle();
  const visit = async (url: string) => {
    admin.window.history.pushState({}, "", url);
    admin.window.dispatchEvent(new admin.window.PopStateEvent("popstate"));
    await admin.settle();
  };
  await visit("/settings/skills");
  assert.equal(admin.requests.findLast((r) => r.path === "/skills")!.url.searchParams.get("scope"), SCOPE);
  await visit("/settings/history?kind=cron");
  assert.equal(admin.requests.findLast((r) => r.path === "/sessions")!.url.searchParams.get("scope"), "org:acme");
  admin.close();
});

test("Errors opens org-wide, keeps explicit scopes, and pages by offset", async () => {
  const bare = await landing("/settings/errors");
  assert.equal(bare.location, "/settings/errors?scope=org%3Aacme");
  assert.equal(dataRequest(bare.requests, "/errors")!.searchParams.get("scope"), "org:acme");
  const paged = await landing(`/settings/errors?scope=${SCOPE_ENC}&page=37`);
  assert.equal(paged.location, `/settings/errors?scope=${SCOPE_ENC}&page=37`);
  const errors = dataRequest(paged.requests, "/errors")!.searchParams;
  assert.equal(errors.get("scope"), SCOPE);
  assert.equal(errors.get("offset"), "1800");
});

test("Slack setup links select Slack settings and keep the guide", async () => {
  for (const url of ["/settings?setup=slack", "/settings/?setup=slack", "/settings/connectors?setup=slack"]) {
    const result = await landing(url);
    assert.equal(result.location, "/settings/slack-settings?setup=slack", url);
    assert.equal(result.views.at(-1), "slack-settings");
  }
  for (const step of ["setup", "install", "connected"]) {
    const result = await landing(`/settings?slack=${step}`);
    assert.equal(result.views.at(-1), "slack-settings", step);
    assert.equal(result.location, `/settings/slack-settings?slack=${step}`);
  }
});

test("the bare settings URL is the general view, onboarding has a path, and unknown views fall back to history", async () => {
  assert.deepEqual((await landing("/settings")).views, ["general"]);
  assert.deepEqual((await landing("/settings?slack=unknown")).views, ["general"]);
  assert.deepEqual((await landing("/settings/onboarding")).views, ["onboarding"]);
  assert.deepEqual((await landing("/settings?view=onboarding")).views, ["onboarding"]);
  const unknown = await landing("/settings/no-such-view");
  assert.deepEqual(unknown.views, ["history"]);
  assert.equal(unknown.location, "/settings/history");
});

test("navigation drops unknown parameters while keeping route state", async () => {
  assert.equal(
    (await landing("/settings/history/s/sess-1?turn=4&variant=original")).location,
    "/settings/history/s/sess-1?turn=4",
  );
});

test("show() moves between views and reports each one", async () => {
  const admin = await mountAdmin("/settings/files", routes);
  await admin.settle();
  admin.controller.show("errors");
  await admin.settle();
  assert.equal(admin.location(), "/settings/errors?scope=org%3Aacme");
  admin.controller.show("general");
  assert.equal(admin.location(), "/settings");
  assert.deepEqual(admin.views, ["files", "errors", "general"]);
  admin.close();
});

test("the org-wide history landing lists named environments with their attached scopes", async () => {
  const admin = await mountAdmin("/settings/history", {
    ...routes,
    "/scopes": {
      scopes: [{ scopeId: "org:acme" }, { scopeId: "channel:C1", label: "#eng" }],
      environments: [{ id: "environment:lab", name: "Lab", attachedScopes: ["channel:C1"] }],
    },
  });
  await admin.settle(10);
  const card = [...admin.document.querySelectorAll("#view-data section.card")].find((section) =>
    section.textContent!.includes("Named environments"),
  );
  assert.ok(card, "named environments card");
  assert.match(card!.textContent!, /Lab/);
  assert.match(card!.textContent!, /#eng/);
  admin.close();
});
