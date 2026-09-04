import { test } from "node:test";
import assert from "node:assert/strict";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import { findRoute, type RouteAuth } from "../src/api/routes/route.ts";
import { agentApiMatches } from "../src/api/agent-api-catalog.ts";
import { OAUTH_CONSENT_AUD, CREDENTIAL_BROKER_AUD } from "../src/auth/capability-token.ts";

const PUBLIC_ROUTES = new Set<string>();
const AUD_ROUTES = new Map<string, string>([
  ["POST /v1/connectors/oauth/consent/mint", OAUTH_CONSENT_AUD],
  ["POST /v1/credentials/broker", CREDENTIAL_BROKER_AUD],
]);
function expectedAuth(method: string, pathname: string): RouteAuth {
  if (PUBLIC_ROUTES.has(`${method} ${pathname}`)) return "public";
  const aud = AUD_ROUTES.get(`${method} ${pathname}`);
  if (aud) return { aud };
  if (agentApiMatches(method, pathname)) return "either";
  return "source";
}

function synthesize(path: string): string {
  return path
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "sample" : seg))
    .join("/");
}
const PATHS = new Set<string>();
for (const route of apiRoutes) if ("path" in route) PATHS.add(synthesize(route.path));
for (const p of [
  "/v1/crons/sample",
  "/v1/memory/self",
  "/v1/memory/search",
  "/v1/memory/facts",
  "/v1/admin/crons",
  "/v1/admin/deployments",
  "/v1/admin/skills",
  "/v1/connectors/oauth/github/start",
])
  PATHS.add(p);

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

test("for every request the table serves, the matched route's auth matches the pinned contract", () => {
  let probed = 0;
  for (const pathname of PATHS) {
    for (const method of METHODS) {
      const found = findRoute(apiRoutes, method, pathname);
      if (!found) continue;
      probed++;
      assert.deepEqual(
        found.route.auth,
        expectedAuth(method, pathname),
        `${method} ${pathname} resolves to a route whose auth ${JSON.stringify(found.route.auth)} disagrees with the pinned contract`,
      );
    }
  }
  assert.ok(probed > apiRoutes.length, `expected to probe more combos than routes, only hit ${probed}`);
});

test("every pinned dedicated-audience route actually resolves in the table", () => {
  for (const key of AUD_ROUTES.keys()) {
    const [method, pathname] = key.split(" ") as [string, string];
    const found = findRoute(apiRoutes, method, pathname);
    assert.ok(found, `${key} is pinned but no route serves it`);
    assert.deepEqual(found.route.auth, expectedAuth(method, pathname), `${key} resolves with unexpected auth`);
  }
});

test("raw routes keep their declared auth contracts (they self-enforce, so the declaration is the pin)", () => {
  const pins: Array<[string, string, RouteAuth]> = [
    ["GET", "/healthz", "public"],
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

test('"either" is exactly the agent-callable surface the catalog advertises', () => {
  for (const pathname of PATHS) {
    for (const method of METHODS) {
      const found = findRoute(apiRoutes, method, pathname);
      if (!found) continue;
      const auth = found.route.auth;
      if (typeof auth === "object" || auth === "public") continue;
      assert.equal(
        auth === "either",
        agentApiMatches(method, pathname),
        `${method} ${pathname}: auth "${String(auth)}" vs catalog ${agentApiMatches(method, pathname)}`,
      );
    }
  }
});
