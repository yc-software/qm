import assert from "node:assert/strict";
import test from "node:test";
import { isAppGitRoute } from "../plugins/chassis/src/app-git.ts";
import { matchPublicPassthrough } from "../plugins/portal/src/public-passthrough.ts";
import { apiRoutes, rawRoutes } from "../src/api/routes/index.ts";

const NON_PASSTHROUGH = new Set([
  "GET /healthz",
  "GET /readyz",
  "GET /v1/app-return",
  "GET /v1/web/desktop/download",
  "GET /v1/public-shares/:token/files/:fileId",
  "GET /v1/web/shares/external/:token",
]);
const MATCH_SAMPLES: ReadonlyArray<readonly [string, string]> = [
  ["GET", "/v1/connectors/oauth/google/callback"],
  ["GET", "/v1/apps/demo/git/info/refs"],
];

test("every auth:public core route is forwarded by portal or listed as non-passthrough", () => {
  const seen = new Set<string>();
  const missing: string[] = [];
  for (const r of [...rawRoutes, ...apiRoutes]) {
    if (r.auth !== "public") continue;
    const sample =
      "path" in r
        ? ([r.method ?? "GET", r.path.replace(/:([A-Za-z0-9_]+)/g, "s")] as const)
        : MATCH_SAMPLES.find(([m, p]) => r.match(m, p));
    assert.ok(sample, "unrecognized match-based public route");
    const ok = matchPublicPassthrough(sample[0], sample[1]) !== null || isAppGitRoute(sample[0], sample[1]);
    const key = "path" in r ? `${sample[0]} ${r.path}` : `${sample[0]} ${sample[1]}`;
    if (NON_PASSTHROUGH.has(key)) {
      assert.equal(ok, false, `remove ${key}`);
      seen.add(key);
    } else if (!ok) missing.push(key);
  }
  assert.deepEqual({ missing, stale: [...NON_PASSTHROUGH].filter((k) => !seen.has(k)) }, { missing: [], stale: [] });
});
