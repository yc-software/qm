import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { startSlackPlugin, type SlackCoreClient } from "../src/slack/index.ts";
import { createSlackRuntimeReconciler } from "../src/surfaces/slack-runtime.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createBackgroundOwnershipStore, type BackgroundOwnership } from "../src/runs/background-ownership.ts";
import { createBackgroundController } from "../src/runs/background-controller.ts";

test("inactive Slack credentials release background ownership without an unhandled SDK rejection", async (t) => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: false, error: "account_inactive" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let stopped = 0;
  const errors: unknown[] = [];
  const runtime = createSlackRuntimeReconciler({
    startPaused: true,
    load: async () => ({ version: "inactive", config: {} }),
    startPlugin: () =>
      startSlackPlugin(
        {
          botToken: "xoxb-inactive",
          apiUrl: `http://127.0.0.1:${address.port}/`,
          receiverFactory: () => ({
            init() {},
            async start() {
              throw new Error("receiver must not start with inactive credentials");
            },
            async stop() {
              stopped++;
            },
          }),
        },
        {
          onScopeModelChanged: () => () => {},
          onChannelHeaderPinChanged: () => () => {},
        } as unknown as SlackCoreClient,
      ),
    onError: (error) => errors.push(error),
  });
  const store = createBackgroundOwnershipStore(createMemoryMap<BackgroundOwnership>());
  const controller = createBackgroundController({
    store,
    identity: { instanceId: "old", deploymentId: "old", taskArn: "task:old" },
    legacyEnabled: true,
    start: async () => {
      runtime.start();
      await runtime.reconcile();
    },
    fence: () => {
      void runtime.stop().catch((error) => errors.push(error));
    },
    relinquish: () => runtime.stop(),
    drained: async () => {},
    onError: (error) => errors.push(error),
    pollMs: 60_000,
  });
  t.after(() => controller.stop());
  controller.start();
  await controller.reconcile();
  await controller.drained();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    errors.some((error) => error instanceof Error && /account_inactive/.test(error.message)),
    String(errors),
  );
  assert.equal(stopped, 1);
  assert.deepEqual(requests, ["/api/auth.test"]);
  assert.equal(controller.canClaim(), false);
  assert.equal((await store.get()).members[0]?.state, "drained");
  await store.register({ instanceId: "next", deploymentId: "next", taskArn: "task:next" });
  await store.transition({
    expectedGeneration: 0,
    requestId: "handover",
    desiredDeploymentId: "next",
    bootstrapTaskArns: ["task:old", "task:next"],
  });
  await store.admit("next", 1, false);
  assert.equal((await store.get()).members[1]?.state, "admitted");
});
