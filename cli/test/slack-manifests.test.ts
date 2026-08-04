import { test } from "node:test";
import assert from "node:assert";
import { usesSlackOidc } from "../src/slack-manifests.ts";
import type { QmConfig } from "../src/config.ts";

function configWithPortalEnv(env: Record<string, string>): QmConfig {
  return { env: { portal: env } } as unknown as QmConfig;
}

test("usesSlackOidc matches by hostname, not substring", () => {
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://slack.com" })), true);
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://enterprise.slack.com" })), true);
  assert.equal(
    usesSlackOidc(configWithPortalEnv({ OIDC_AUTH_ENDPOINT: "https://slack.com/openid/connect/authorize" })),
    true,
  );
  // substring lookalikes must not count as Slack
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://not-slack.com.example/idp" })), false);
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://evil-slack.com/auth" })), false);
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "https://slack.com.evil.example" })), false);
  // malformed values fail closed
  assert.equal(usesSlackOidc(configWithPortalEnv({ OIDC_ISSUER: "slack.com" })), false);
  assert.equal(usesSlackOidc(configWithPortalEnv({})), false);
});
