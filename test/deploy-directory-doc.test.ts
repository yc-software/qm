import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const docPath = new URL("../docs/deploy-directory.md", import.meta.url);

test("the onboarding guide uses the portal's implemented OIDC callback", () => {
  const guide = readFileSync(new URL("../docs/getting-started.md", import.meta.url), "utf8");
  assert.match(guide, /<publicUrl>\/auth\/callback/);
  assert.doesNotMatch(guide, /<publicUrl>\/oauth\/callback/);
});

test("every ENFORCED deployment-contract clause names a verifier and its implementation exists", () => {
  const doc = readFileSync(docPath, "utf8");
  const rows = [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(ENFORCED|VALIDATED-ONLY|RESERVED)\s*\|\s*([^|]+?)\s*\|$/gm)];
  assert.ok(rows.length >= 10, "clause-status table must remain substantive");
  const implementations: Record<string, Array<[string, RegExp]>> = {
    "config.v1": [["../cli/src/config.ts", /CONTRACT_VERSION\s*=\s*1/]],
    "config.no-secret-values": [["../cli/src/commands/check.ts", /config\.no-secret-values/]],
    "secrets.computed-set": [["../cli/src/secrets.ts", /function computedSecrets/]],
    "sandbox.descriptors": [
      ["../cli/src/sandbox-layer.ts", /function validateSandboxLayer/],
      ["../src/api/routes/deployment-layer.ts", /PUT.*\/v1\/deployment-layer/],
    ],
    "sandbox.approvals-tighten": [
      ["../src/deployment/deployment-layer.ts", /ApprovalDecision\s*=\s*"require_approval"\s*\|\s*"deny"/],
      ["../src/policy/command-policy.ts", /function evaluateCommand/],
    ],
    "runtime.layer-resolved": [
      ["../src/deployment/deployment-layer-store.ts", /function createDeploymentLayerStore/],
      ["../cli/src/commands/conformance.ts", /deploymentLayerRequest/],
    ],
    "aws.rendered-task": [["../cli/src/backends/aws.ts", /function renderTaskDefinition/]],
    "aws.live-drift": [["../cli/src/backends/aws.ts", /function awsCheckLive/]],
    "sandbox.aws-substrate": [
      ["../src/sandbox/aws-sandbox.ts", /function createAwsSandbox/],
      ["../cli/src/backends/aws.ts", /AWS_SANDBOX_IMAGE_VERSION/],
    ],
    "target.provider-registry": [
      ["../cli/src/backends/registry.ts", /HOSTING_PROVIDERS/],
      ["../cli/test/package.test.ts", /packed npm artifact creates and operates a standalone deployment repository/],
    ],
  };
  const enforced = rows.filter((row) => row[2] === "ENFORCED").map((row) => row[1]!);
  assert.deepEqual(
    enforced.sort(),
    Object.keys(implementations).sort(),
    "every ENFORCED clause must have an executable verifier mapping",
  );
  for (const [clause, checks] of Object.entries(implementations)) {
    for (const [path, pattern] of checks) {
      assert.match(
        readFileSync(new URL(path, import.meta.url), "utf8"),
        pattern,
        `${clause}: ${path} no longer contains ${pattern}`,
      );
    }
  }
});
