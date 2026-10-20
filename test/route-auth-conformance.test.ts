import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import { findRoute, type RouteAuth } from "../src/api/routes/route.ts";
import { OAUTH_CONSENT_AUD, CREDENTIAL_BROKER_AUD, BROWSER_MODEL_AUD } from "../src/auth/capability-token.ts";

const AUD_ROUTES = new Map<string, string>([
  ["POST /v1/browser-model/chat/completions", BROWSER_MODEL_AUD],
  ["POST /v1/connectors/oauth/consent/mint", OAUTH_CONSENT_AUD],
  ["POST /v1/credentials/broker", CREDENTIAL_BROKER_AUD],
]);
test("every pinned dedicated-audience route actually resolves in the table", () => {
  for (const key of AUD_ROUTES.keys()) {
    const [method, pathname] = key.split(" ") as [string, string];
    const found = findRoute(apiRoutes, method, pathname);
    assert.ok(found, `${key} is pinned but no route serves it`);
    assert.deepEqual(found.route.auth, { aud: AUD_ROUTES.get(key) }, `${key} resolves with unexpected auth`);
  }
});

test("raw routes keep their declared auth contracts (front enforces capability audiences, handlers enforce the rest)", () => {
  const pins: Array<[string, string, RouteAuth]> = [
    ["GET", "/healthz", "public"],
    ["GET", "/readyz", "public"],
    ["GET", "/v1/spend/export", "public"],
    ["GET", "/v1/credentials/git/gitlab/acme/repo.git/info/refs", { aud: CREDENTIAL_BROKER_AUD }],
    ["POST", "/v1/credentials/git/gitlab/acme/repo.git/git-upload-pack", { aud: CREDENTIAL_BROKER_AUD }],
  ];
  for (const [method, pathname, auth] of pins) {
    const found = findRoute(rawRoutes, method, pathname);
    assert.ok(found, `${method} ${pathname} not served by a raw route`);
    assert.deepEqual(found.route.auth, auth, `${method} ${pathname} declares unexpected auth`);
  }
  for (const route of rawRoutes) {
    assert.ok(route.auth !== undefined, "every raw route must declare its auth contract");
  }
});
