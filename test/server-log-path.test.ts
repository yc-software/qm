import { test } from "node:test";
import assert from "node:assert/strict";
import { loggablePath } from "../src/api/server.ts";

test("server error logs keep the path but drop query strings that can carry tokens", () => {
  assert.equal(loggablePath("/v1/drops/abc?t=secret-drop-token"), "/v1/drops/abc?<query omitted>");
  assert.equal(loggablePath("/oauth/callback?code=xyz&state=s"), "/oauth/callback?<query omitted>");
  assert.equal(loggablePath("/healthz"), "/healthz");
  assert.equal(loggablePath(undefined), "?");
});
