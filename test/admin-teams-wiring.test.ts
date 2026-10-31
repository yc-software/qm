import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serverDeps, type BuiltApp } from "../src/wiring.ts";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

test("serverDeps passes the team store to the admin API", () => {
  const config = testConfig({ dataDir: mkdtempSync(join(tmpdir(), "admin-teams-wiring-")) });
  const built = buildApp(config);
  const teams = { list: async () => [] } as unknown as NonNullable<BuiltApp["teams"]>;
  assert.equal(serverDeps(config, { ...built, teams }).teams, teams);
  assert.equal(serverDeps(config, built).teams, built.teams);
});
