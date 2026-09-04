import { test } from "node:test";
import assert from "node:assert/strict";
import { agentApiMatches } from "../src/api/agent-api-catalog.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";
import type { BaseCtx, Route } from "../src/api/routes/route.ts";

const DEDICATED_AUDIENCE_EITHER = new Set<string>(["POST /v1/blobs", "GET /v1/blobs/:id"]);

const sample = (p: string) => p.replace(/:[A-Za-z]+/g, "x123");
const hasPath = (r: Route<BaseCtx>): r is Route<BaseCtx> & { method: string; path: string } =>
  "path" in r && "method" in r;

const allRoutes: ReadonlyArray<Route<BaseCtx>> = [
  ...(rawRoutes as ReadonlyArray<Route<BaseCtx>>),
  ...(apiRoutes as unknown as ReadonlyArray<Route<BaseCtx>>),
];

test("every auth:'either' route is admitted by the catalog gate (no parity drift)", () => {
  const misses: string[] = [];
  for (const r of allRoutes) {
    if (r.auth !== "either" || !hasPath(r)) continue;
    const key = `${r.method} ${r.path}`;
    if (DEDICATED_AUDIENCE_EITHER.has(key)) continue;
    for (const method of r.method.split("|")) {
      if (!agentApiMatches(method, sample(r.path))) misses.push(`${method} ${r.path}`);
    }
  }
  assert.deepEqual(
    misses,
    [],
    `agent-callable routes the catalog gate rejects (add them to FAMILIES in agent-api-catalog.ts, ` +
      `or, if they use a dedicated-audience token, to DEDICATED_AUDIENCE_EITHER here): ${misses.join(", ")}`,
  );
});

test("the catalog gate admits no source-only or public route (no over-exposure)", () => {
  const leaks: string[] = [];
  for (const r of allRoutes) {
    if (!hasPath(r)) continue;
    if (r.auth !== "source" && r.auth !== "public") continue;
    for (const method of r.method.split("|")) {
      if (agentApiMatches(method, sample(r.path))) leaks.push(`${method} ${r.path} (${String(r.auth)})`);
    }
  }
  assert.deepEqual(leaks, [], `internal routes wrongly admitted to the agent surface: ${leaks.join(", ")}`);
});
