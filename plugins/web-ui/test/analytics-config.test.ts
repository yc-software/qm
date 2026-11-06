import assert from "node:assert/strict";
import { test } from "node:test";
import { productAnalyticsConfig } from "../server/analytics-config.ts";

test("Session recording options are optional, must be an object, and open the remote-config host only on PostHog Cloud", () => {
  assert.deepEqual(productAnalyticsConfig({}), { origins: [] });
  assert.deepEqual(productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a" }), {
    analytics: { apiKey: "phc_a", host: "https://us.i.posthog.com" },
    origins: ["https://us.i.posthog.com"],
  });
  assert.deepEqual(
    productAnalyticsConfig({
      POSTHOG_API_KEY: "phc_a",
      POSTHOG_HOST: "https://eu.i.posthog.com",
      POSTHOG_SESSION_RECORDING: "{}",
    }).origins,
    ["https://eu.i.posthog.com", "https://eu-assets.i.posthog.com"],
  );
  assert.deepEqual(
    productAnalyticsConfig({
      POSTHOG_API_KEY: "phc_a",
      POSTHOG_HOST: "https://ph.example.com",
      POSTHOG_SESSION_RECORDING: "{}",
    }).origins,
    ["https://ph.example.com"],
  );
  assert.throws(
    () => productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a", POSTHOG_SESSION_RECORDING: "[]" }),
    /JSON object/,
  );
  assert.throws(
    () => productAnalyticsConfig({ POSTHOG_API_KEY: "phc_a", POSTHOG_SESSION_RECORDING: "{" }),
    SyntaxError,
  );
});
