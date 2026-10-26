import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAgentApis } from "../src/api/agent-api-catalog.ts";
import { UNATTENDED_ADMIN_GRANTS } from "../src/api/control-service.ts";
import { findRoute } from "../src/api/routes/route.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import type { CapabilityClaims } from "../src/auth/capability-token.ts";

const base: CapabilityClaims = { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + 60_000 };

function advertised(): Array<{ method: string; path: string }> {
  const listings = [
    renderAgentApis({ ...base, liveAuthor: true }, { isAdmin: true }, { swarmsEnabled: true }),
    renderAgentApis({ ...base, grants: [...UNATTENDED_ADMIN_GRANTS] }, { isAdmin: false }, { swarmsEnabled: false }),
  ];
  return listings.flatMap((listing) =>
    listing.endpoints.flatMap(({ method, path }) => {
      const [route = ""] = path.split("?");
      const paths = route
        .split("/")
        .slice(1)
        .map((segment) => (segment.startsWith(":") ? ["x1"] : segment.split("|")))
        .reduce<string[]>((acc, options) => acc.flatMap((prefix) => options.map((o) => `${prefix}/${o}`)), [""]);
      return method.split("|").flatMap((m) => paths.map((p) => ({ method: m, path: p })));
    }),
  );
}

test("every endpoint the agent API catalog advertises is served by a route an agent token can call", () => {
  const endpoints = advertised();
  assert.ok(endpoints.length > 100, `expected a full listing, got ${endpoints.length}`);
  const unreachable = endpoints.flatMap(({ method, path }) => {
    const found = findRoute(rawRoutes, method, path) ?? findRoute(apiRoutes, method, path);
    return found && (found.route.auth === "either" || typeof found.route.auth === "object")
      ? []
      : [`${method} ${path} (${found ? String(found.route.auth) : "no route"})`];
  });
  assert.deepEqual(unreachable, []);
});
