import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const externalDestinationBoundaries = [
  "src/api/routes/turns.ts",
  "src/api/routes/admin/artifacts.ts",
  "src/api/capability-destination.ts",
  "src/auth/capability-token.ts",
  "src/core/turn-origin.ts",
  "src/cron/cron-store.ts",
  "src/triggers/trigger-store.ts",
  "src/webhooks/webhook-store.ts",
  "src/webhooks/webhook-receiver.ts",
];

test("external destination boundaries expose no analytics-card field", async () => {
  for (const path of externalDestinationBoundaries) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /trustedAnalyticsCard|\.nativeCard\b/, path);
  }
  const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
  const destination = types.slice(
    types.indexOf("export interface Destination"),
    types.indexOf("export interface QmAnalyticsNativeCard"),
  );
  assert.doesNotMatch(destination, /nativeCard|analyticsCard/);
});
