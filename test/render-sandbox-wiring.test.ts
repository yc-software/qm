import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("Render sandboxes can start without S3 storage configuration", async () => {
  const built = buildApp(
    testConfig({
      sandboxBackend: "render",
      databaseUrl: "postgres://unused/unused",
      snapshotStore: "local",
      s3Bucket: undefined,
      renderSandbox: {
        apiKey: "render-test-key",
        workspaceId: "tea-test",
        image: `ghcr.io/yc-software/qm/sandbox-base:${"c".repeat(40)}@sha256:${"d".repeat(64)}`,
      },
    }),
  );
  await built.runtime.stop();
});
