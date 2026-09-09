import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { FACTORY_LOOP_SURFACE } from "../src/loops/factory/effects.ts";
import { scopeId } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

test("a booted instance drives a factory loop through the factory dependencies it wired", async () => {
  const built = buildApp(testConfig());
  const { loop } = await built.loops.store.create({
    owner: "josh",
    createdBy: "josh",
    ownerScopeId: scopeId("personal", "josh"),
    name: "factory",
    surface: FACTORY_LOOP_SURFACE,
    playbook: "the factory wrapper does the work",
    successCondition: "the pull request converged",
    shipActions: [{ action: "open_pr", gate: "hold" }],
  });

  const unconfigured = await built.loops.fire!.fire(loop.id, "f1");
  assert.equal(unconfigured.status, "failed");
  assert.match(unconfigured.note ?? "", /factory_config_missing/);

  built.loops.config.setFactoryConfig({
    forge: "github",
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
  });

  const uncredentialed = await built.loops.fire!.fire(loop.id, "f2");
  assert.equal(uncredentialed.status, "failed");
  assert.match(uncredentialed.note ?? "", /factory_credentials_missing: factory-linear, factory-github/);
});
