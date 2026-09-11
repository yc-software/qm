import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { test } from "node:test";

test("coordination CI includes every database-backed fixture in a dedicated database", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  const script: string = manifest.scripts["test:coordination:pg"];
  const patterns = script
    .split("&&")[1]!
    .trim()
    .split(/\s+/)
    .filter((word) => word.startsWith("test/"));
  const variable = "COORDINATION_TEST_DATABASE_URL";
  for (const file of readdirSync("test").filter((name) => name.endsWith(".test.ts"))) {
    if (!readFileSync(`test/${file}`, "utf8").includes(variable)) continue;
    assert.ok(
      patterns.some((pattern) => matchesGlob(`test/${file}`, pattern)),
      `Missing PostgreSQL fixture: ${file}`,
    );
  }
  const workflow = readFileSync(".github/workflows/cicd.yml", "utf8");
  assert.match(workflow, /CREATE DATABASE qm_coordination/);
  assert.match(workflow, /COORDINATION_TEST_DATABASE_URL: postgres:\/\/[^\n]+\/qm_coordination\n/);
  assert.match(workflow, /run: npm run test:coordination:pg/);
});

test("the coordination PostgreSQL command refuses to silently skip a missing database", () => {
  const env = { ...process.env };
  delete env.COORDINATION_TEST_DATABASE_URL;
  const result = spawnSync("npm", ["run", "test:coordination:pg"], { env, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /COORDINATION_TEST_DATABASE_URL is required/);
});
