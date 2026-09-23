import "./support/auto-fake-sprites.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { DeploymentVersion } from "../src/deploy/deploy-store.ts";
import { verifyCapabilityToken } from "../src/auth/capability-token.ts";
import { personalScope } from "../src/types.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

let applied: DeploymentVersion | undefined;
mock.module("../src/deploy/docker-deploy-provider.ts", {
  namedExports: {
    createDockerDeployProvider: () => ({
      profile: { managedScaleToZero: false },
      apply: async (_deployment: unknown, version: DeploymentVersion) => {
        applied = version;
        return { host: "127.0.0.1", port: 12345 };
      },
      destroy: async () => {},
    }),
  },
});
const { buildApp, serverDeps } = await import("../src/wiring.ts");

test("published apps with no org credentials receive a broker-only token outside stored versions and Git", async (t) => {
  const config = testConfig({
    signingSecret: "fake-app-signing-key".repeat(2),
    apiBaseUrl: "https://core.example.com",
    deployProvider: "docker",
  });
  const built = buildApp(config);
  t.after(() => built.runtime.stop());
  const deployment = await built.app.deploy({
    ownerScopeId: personalScope("owner@example.com"),
    createdBy: "owner@example.com",
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "process.exit(0)" }],
  });
  assert.equal(applied?.env?.AGENT_API_URL, "https://core.example.com");
  const token = applied?.env?.AGENT_CREDENTIAL_TOKEN;
  assert.ok(token);
  const claims = await verifyCapabilityToken(token, TEST_CAPABILITY_SECRET);
  assert.equal(claims?.aud, "credential-broker");
  assert.equal(claims?.deployment, deployment.id);
  assert.equal(claims?.actorId, "owner@example.com");
  assert.deepEqual(claims?.credentials, []);
  assert.equal(applied?.env?.AGENT_API_TOKEN, undefined);
  assert.doesNotMatch(JSON.stringify(await built.deployStore.get(deployment.id)), new RegExp(token));
  const files = await built.deployStore.filesOf(deployment.id, 1);
  assert.deepEqual(
    files?.map((file) => file.path),
    ["app.js"],
  );
  assert.equal(serverDeps(config, built).deployStore, built.deployStore);
});
