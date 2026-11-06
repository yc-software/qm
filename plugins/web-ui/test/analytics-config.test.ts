import assert from "node:assert/strict";
import { test } from "node:test";
import { productAnalyticsConfig } from "../server/analytics-config.ts";

const config = (value: unknown) => ({ POSTHOG_CONFIG: JSON.stringify(value) });

test("POSTHOG_CONFIG supplies the token, host and session recording options and opens the remote-config host on PostHog Cloud", () => {
  assert.deepEqual(productAnalyticsConfig({}), { origins: [] });
  assert.deepEqual(productAnalyticsConfig(config({ token: "phc_a" })), {
    analytics: { apiKey: "phc_a", host: "https://us.i.posthog.com" },
    origins: ["https://us.i.posthog.com", "https://us-assets.i.posthog.com"],
  });
  assert.deepEqual(
    productAnalyticsConfig(
      config({ token: "phc_a", api_host: "https://eu.i.posthog.com", session_recording: { maskAllInputs: true } }),
    ),
    {
      analytics: { apiKey: "phc_a", host: "https://eu.i.posthog.com", sessionRecording: { maskAllInputs: true } },
      origins: ["https://eu.i.posthog.com", "https://eu-assets.i.posthog.com"],
    },
  );
  assert.deepEqual(productAnalyticsConfig(config({ token: "phc_a", api_host: "https://ph.example.com" })).origins, [
    "https://ph.example.com",
  ]);
  assert.throws(() => productAnalyticsConfig(config({ token: "phx_personal" })), /ingestion token/);
  assert.throws(() => productAnalyticsConfig(config({ token: "phc_a", api_host: "http://x.test" })), /HTTPS origin/);
  assert.throws(() => productAnalyticsConfig(config(["phc_a"])), /JSON object/);
  assert.throws(
    () => productAnalyticsConfig(config({ token: "phc_a", autocapture: true })),
    /unsupported keys: autocapture/,
  );
  assert.throws(() => productAnalyticsConfig(config({ token: "phc_a", session_recording: true })), /must be an object/);
  assert.throws(() => productAnalyticsConfig({ POSTHOG_CONFIG: "{" }), SyntaxError);
});
