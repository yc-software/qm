import assert from "node:assert/strict";
import { test } from "node:test";
import { analyticsHookConfig } from "../../chassis/src/analytics-config.ts";

const config = (value: unknown) => analyticsHookConfig(JSON.stringify(value));

test("WEB_UI_ANALYTICS names the deployment's analytics module, its CSP origins and opaque options", () => {
  assert.deepEqual(analyticsHookConfig(undefined), { scriptOrigins: [], connectOrigins: [] });
  assert.deepEqual(config({ module: "/analytics/web.js" }), {
    analytics: { module: "/analytics/web.js" },
    scriptOrigins: [],
    connectOrigins: [],
  });
  assert.deepEqual(
    config({ module: "https://cdn.example.com/a.js", connect: ["https://events.example.com"], options: { k: 1 } }),
    {
      analytics: { module: "https://cdn.example.com/a.js", options: { k: 1 } },
      scriptOrigins: ["https://cdn.example.com"],
      connectOrigins: ["https://events.example.com"],
    },
  );
  for (const bad of [
    { module: "//evil.example.com/a.js" },
    { module: "http://cdn.example.com/a.js" },
    { module: "/a.js", connect: ["https://events.example.com/path"] },
    { module: "/a.js", connect: "https://events.example.com" },
    { module: "/a.js", extra: true },
    ["/a.js"],
  ])
    assert.throws(() => config(bad), /WEB_UI_ANALYTICS/);
  assert.throws(() => analyticsHookConfig("{"), SyntaxError);
});
