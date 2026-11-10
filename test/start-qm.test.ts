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

test("only a core that runs background work seeds skills at boot", async (t) => {
  const skillsSeedDir = mkdtempSync(join(tmpdir(), "start-qm-seed-"));
  mkdirSync(join(skillsSeedDir, "release-skill"));
  writeFileSync(
    join(skillsSeedDir, "release-skill", "SKILL.md"),
    "---\nname: release-skill\ndescription: Shipped by a new release.\n---\nBody.\n",
  );
  const databaseUrl = testMigratedDatabaseUrl();
  const boot = (backgroundWorkEnabled: boolean) =>
    startQm(testConfig({ databaseUrl, allowUnauthenticatedCore: true, skillsSeedDir, backgroundWorkEnabled }), {
      agent: createMockAgent(),
    });
  const seeded = async (qm: Awaited<ReturnType<typeof boot>>) =>
    (await qm.built.skills.list()).some((skill) => skill.manifest.name === "release-skill");
  const idle = await boot(false);
  t.after(() => idle.stop());
  assert.equal(await seeded(idle), false);
  const owner = await boot(true);
  t.after(() => owner.stop());
  const conversation = { kind: "dm" as const, threadRef: "start-qm-seed" };
  await owner.built.app.turn({ surface: "test", actor: { externalId: "U1" }, conversation, text: "hello" });
  assert.equal(await seeded(owner), true);
});
