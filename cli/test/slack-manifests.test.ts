import { test } from "node:test";
import assert from "node:assert";
import { usesSlackOidc } from "../src/slack-manifests.ts";
import type { QmConfig } from "../src/config.ts";

function configWithCoreEnv(env: Record<string, string>): QmConfig {
  return { env: { core: env } } as unknown as QmConfig;
}

test("usesSlackOidc matches by hostname, not substring", () => {
  assert.equal(usesSlackOidc(configWithCoreEnv({ OIDC_ISSUER: "https://slack.com" })), true);
  assert.equal(usesSlackOidc(configWithCoreEnv({ OIDC_ISSUER: "https://enterprise.slack.com" })), true);
  assert.equal(
    usesSlackOidc(configWithCoreEnv({ OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize" })),
    true,
  );
  assert.equal(usesSlackOidc(configWithCoreEnv({ OIDC_ISSUER: "https://not-slack.com.example/idp" })), false);
  assert.equal(usesSlackOidc(configWithCoreEnv({ OIDC_ISSUER: "https://evil-slack.com/auth" })), false);
  assert.equal(usesSlackOidc(configWithCoreEnv({ OIDC_ISSUER: "https://slack.com.evil.example" })), false);
  assert.equal(usesSlackOidc(configWithCoreEnv({ OIDC_ISSUER: "slack.com" })), false);
  assert.equal(usesSlackOidc(configWithCoreEnv({})), false);
});
