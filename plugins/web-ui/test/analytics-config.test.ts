import assert from "node:assert/strict";
import { test } from "node:test";
import { productAnalyticsConfig } from "../server/analytics-config.ts";

test("analytics config validates the key and host and opens the remote-config host only on PostHog Cloud", () => {
  assert.deepEqual(productAnalyticsConfig({}), { origins: [] });
  assert.deepEqual(productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a" }), {
    analytics: { apiKey: "phc_a", host: "https://us.i.posthog.com" },
    origins: ["https://us.i.posthog.com", "https://us-assets.i.posthog.com"],
  });
  assert.deepEqual(
    productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a", POSTHOG_HOST: "https://eu.i.posthog.com" }).origins,
    ["https://eu.i.posthog.com", "https://eu-assets.i.posthog.com"],
  );
  assert.deepEqual(
    productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a", POSTHOG_HOST: "https://ph.example.com" }).origins,
    ["https://ph.example.com"],
  );
  assert.throws(() => productAnalyticsConfig({ POSTHOG_API_KEY: "secret" }), /ingestion token/);
  assert.throws(
    () => productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a", POSTHOG_HOST: "http://x.test" }),
    /HTTPS origin/,
  );
});
