import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

test("slack manifest parity between src and cli template", () => {
  const srcManifest = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../src/slack/manifest.json"), "utf8"));
  const cliManifest = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../templates/slack-manifest.json"), "utf8"),
  );
  assert.deepEqual(cliManifest, srcManifest);
  const botEvents: string[] = srcManifest.settings.event_subscriptions.bot_events;
  assert.ok(botEvents.includes("agent_session_stopped"));
  assert.ok(botEvents.includes("agent_session_title_changed"));
  assert.ok(srcManifest.oauth_config.scopes.bot.includes("assistant:write"));
  assert.ok(srcManifest.features.agent_view);
});
