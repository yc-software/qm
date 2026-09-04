import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePath, findRoute, type Route, type BaseCtx } from "../src/api/routes/route.ts";

function matched(path: string, pathname: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  return compilePath(path).test("GET", pathname, out) ? out : null;
}

test("compilePath: static paths match exactly", () => {
  assert.deepEqual(matched("/v1/crons", "/v1/crons"), {});
  assert.equal(matched("/v1/crons", "/v1/crons/x"), null);
  assert.equal(matched("/v1/crons", "/v1/cron"), null);
});

test("compilePath: a :param captures exactly one decoded segment", () => {
  assert.deepEqual(matched("/v1/crons/:id", "/v1/crons/abc"), { id: "abc" });
  assert.deepEqual(matched("/v1/crons/:id/disable", "/v1/crons/abc/disable"), { id: "abc" });
  assert.equal(matched("/v1/crons/:id", "/v1/crons/abc/disable"), null);
  assert.equal(matched("/v1/crons/:id/disable", "/v1/crons/abc"), null);
});

test("compilePath: params are URL-decoded; %2F does not smuggle a slash past segmenting", () => {
  assert.deepEqual(matched("/v1/admin/scopes/:scope", "/v1/admin/scopes/org%3Adefault-org"), {
    scope: "org:default-org",
  });
  assert.deepEqual(matched("/v1/admin/scopes/:scope", "/v1/admin/scopes/a%2Fb"), { scope: "a/b" });
});

test("compilePath: a malformed % is a clean no-match, never a throw", () => {
  assert.doesNotThrow(() => matched("/v1/crons/:id", "/v1/crons/%zz"));
  assert.equal(matched("/v1/crons/:id", "/v1/crons/%zz"), null);
});

test("findRoute: first-match wins, so a fixed suffix shadows the bare :id when listed first", () => {
  const seen: string[] = [];
  const routes: Route<BaseCtx>[] = [
    { method: "GET", path: "/v1/x/:id/title", auth: "source", handle: () => void seen.push("title") },
    { method: "GET", path: "/v1/x/:id", auth: "source", handle: () => void seen.push("id") },
  ];
  assert.equal(findRoute(routes, "GET", "/v1/x/7/title")?.route, routes[0]);
  assert.deepEqual(findRoute(routes, "GET", "/v1/x/7/title")?.params, { id: "7" });
  assert.equal(findRoute(routes, "GET", "/v1/x/7")?.route, routes[1]);
  assert.equal(findRoute(routes, "POST", "/v1/x/7"), null, "method must match too");
});

test("findRoute: a custom match route still works and yields empty params", () => {
  const route: Route<BaseCtx> = {
    match: (m, p) => m === "GET" && p.startsWith("/d/"),
    auth: "source",
    handle: () => {},
  };
  const found = findRoute([route], "GET", "/d/app/anything/here");
  assert.equal(found?.route, route);
  assert.deepEqual(found?.params, {});
});
