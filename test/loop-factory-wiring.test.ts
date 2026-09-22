import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { FACTORY_LOOP_SURFACE } from "../src/loops/factory/effects.ts";
import { scopeId, type ScopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import { FACTORY_GITHUB_SLUG, FACTORY_LINEAR_SLUG } from "../src/loops/factory/credentials.ts";
import type { Config } from "../src/config.ts";

const FACTORY_CONFIG = {
  forge: "github" as const,
  publishProject: "acme/app",
  targetBranch: "main",
  repoCloneUrl: "https://github.com/acme/app.git",
  linearTeamId: "TEAM-1",
  sourceAppDirs: "src",
  sourceTestRe: "\\.test\\.ts$",
  verifyTestsCmd: "npm test",
  verifyTestFileCmd: "npm test --",
  verifyLintCmd: "npm run lint",
  bugbotRequired: true,
  followupsEnabled: false,
};

const MODEL_AUTH_NOTE = /model auth: core has no Anthropic credential configured/;

async function factoryLoopId(built: BuiltApp, name = "factory"): Promise<string> {
  const { loop } = await built.loops.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: scopeId("personal", "josh"),
    name,
    surface: FACTORY_LOOP_SURFACE,
    playbook: "the factory wrapper does the work",
    successCondition: "the pull request converged",
    shipActions: [{ action: "open_pr", gate: "hold" }],
  });
  return loop.id;
}

async function seedFactoryCredentials(built: BuiltApp, org: ScopeId): Promise<void> {
  for (const [slug, secret, host] of [
    [FACTORY_LINEAR_SLUG, "lin_FAKE", "api.linear.app"],
    [FACTORY_GITHUB_SLUG, "ghp_FAKE", "api.github.com"],
  ] as const) {
    await built.serviceCreds.setServiceCredential(org, { slug, name: slug, secret, host });
  }
}

test("a booted instance drives a factory loop through the factory dependencies it wired", async () => {
  const built = buildApp(testConfig());
  const loopId = await factoryLoopId(built);

  const unconfigured = await built.loops.fire!.fire(loopId, "f1");
  assert.equal(unconfigured.status, "failed");
  assert.match(unconfigured.note ?? "", /factory_config_missing/);

  built.loops.config.setFactoryConfig(FACTORY_CONFIG);

  const uncredentialed = await built.loops.fire!.fire(loopId, "f2");
  assert.equal(uncredentialed.status, "failed");
  assert.match(uncredentialed.note ?? "", /factory_credentials_missing: factory-linear, factory-github/);
});

test("the wired modelAuthEnv comes from core's own Anthropic configuration, so an unconfigured deployment is named and a configured one gets past the gate", async () => {
  const cases: [string, Partial<Config>, boolean][] = [
    ["neither key nor token", {}, true],
    ["a deployment ANTHROPIC_API_KEY", { anthropicApiKey: "cfg-key" }, false],
    ["a claude oauth token", { claudeProcessEnv: { CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/usr/bin" } }, false],
  ];
  for (const [label, overrides, gated] of cases) {
    const config = testConfig(overrides);
    const built = buildApp(config);
    const loopId = await factoryLoopId(built);
    built.loops.config.setFactoryConfig(FACTORY_CONFIG);
    await seedFactoryCredentials(built, scopeId("org", config.orgId));

    const fired = await built.loops.fire!.fire(loopId, "f1");

    assert.equal(fired.status, "failed", label);
    assert.equal(MODEL_AUTH_NOTE.test(fired.note ?? ""), gated, `${label}: ${fired.note ?? ""}`);
  }
});

test("a deployment whose only model auth is its CLAUDE_AUTH_CREDENTIAL keychain credential gets past the gate, on either token key that credential may hold", async () => {
  const config = testConfig();
  const built = buildApp(config);
  const keychain = built.keychain;
  assert.ok(keychain, "the test config boots a keychain");
  built.loops.config.setFactoryConfig(FACTORY_CONFIG);
  await seedFactoryCredentials(built, scopeId("org", config.orgId));

  const unregistered = await built.loops.fire!.fire(await factoryLoopId(built, "factory-none"), "f1");
  assert.match(unregistered.note ?? "", MODEL_AUTH_NOTE);

  for (const envKey of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
    const saved = await keychain.save({
      ownerId: "josh",
      service: `claude-${envKey}`,
      secret: `${envKey}-value`,
      envKey,
    });
    config.claudeAuthCredential = saved.id;

    const fired = await built.loops.fire!.fire(await factoryLoopId(built, `factory-${envKey}`), "f1");

    assert.equal(MODEL_AUTH_NOTE.test(fired.note ?? ""), false, `${envKey}: ${fired.note ?? ""}`);
  }
});

const PINGS_SKIPPED_NOTE = "slack: no installation for this org, pings skipped";

async function firePingsSkipped(built: BuiltApp, loopId: string, fireId: string): Promise<boolean> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    await built.loops.fire!.fire(loopId, fireId);
  } finally {
    console.warn = original;
  }
  return warnings.some((warning) => warning.includes(PINGS_SKIPPED_NOTE));
}

test("the wired factory reads the org's Slack installation store live, so seeding and deleting the installation flips the pings-skipped note", async () => {
  const config = testConfig({ anthropicApiKey: "cfg-key" });
  const built = buildApp(config);
  const loopId = await factoryLoopId(built);
  built.loops.config.setFactoryConfig({ ...FACTORY_CONFIG, slackChannel: "#factory-runs" });
  await seedFactoryCredentials(built, scopeId("org", config.orgId));

  const uninstalled = await firePingsSkipped(built, loopId, "f1");
  await built.slackInstallation.set({ botToken: "xoxb-FAKE", appToken: "xapp-FAKE", updatedBy: "josh" });
  const installed = await firePingsSkipped(built, loopId, "f2");
  await built.slackInstallation.delete("josh");
  const removed = await firePingsSkipped(built, loopId, "f3");

  assert.deepEqual([uninstalled, installed, removed], [true, false, true]);
});
