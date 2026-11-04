import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startQm } from "../src/start.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";
import { testMigratedDatabaseUrl } from "./support/test-database.ts";

test("a turn submitted to QM booted by startQm completes", async (t) => {
  const config = testConfig({ allowUnauthenticatedCore: true, runWaitMs: 10_000 });
  const qm = await startQm(config, { agent: createMockAgent() });
  t.after(() => qm.stop());
  const conversation = { kind: "dm" as const, threadRef: "start-qm" };
  const result = await qm.built.app.turn({ surface: "test", actor: { externalId: "U1" }, conversation, text: "hello" });
  assert.equal(result.status, "ok", result.reason);
});

test("only a core that runs background work seeds skills at boot", async () => {
  const skillsSeedDir = mkdtempSync(join(tmpdir(), "start-qm-seed-"));
  mkdirSync(join(skillsSeedDir, "release-skill"));
  writeFileSync(
    join(skillsSeedDir, "release-skill", "SKILL.md"),
    "---\nname: release-skill\ndescription: Shipped by a new release.\n---\nBody.\n",
  );
  const databaseUrl = testMigratedDatabaseUrl();
  const bootSeeds = async (backgroundWorkEnabled: boolean) => {
    const config = testConfig({ databaseUrl, allowUnauthenticatedCore: true, skillsSeedDir, backgroundWorkEnabled });
    const qm = await startQm(config, { agent: createMockAgent() });
    const names = (await qm.built.skills.list()).map((skill) => skill.manifest.name);
    await qm.stop();
    return names.includes("release-skill");
  };
  assert.equal(await bootSeeds(false), false);
  assert.equal(await bootSeeds(true), true);
});
