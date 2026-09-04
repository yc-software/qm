import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfigAt } from "../src/config.ts";
import { computedSecrets } from "../src/secrets.ts";
import { runChecks } from "../src/commands/check.ts";

const stacksDir = fileURLToPath(new URL("../../deploy/stacks", import.meta.url));

function stackConfigPaths(): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(stacksDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) paths.push(join(stacksDir, entry.name));
    if (entry.isDirectory()) {
      for (const nested of readdirSync(join(stacksDir, entry.name))) {
        if (nested === "qm.config.jsonc") paths.push(join(stacksDir, entry.name, nested));
      }
    }
  }
  return paths;
}

test("every checked-in stack config passes loadConfigAt", () => {
  const paths = stackConfigPaths();
  assert.ok(paths.length > 0, `no stack configs found under ${stacksDir}`);
  for (const path of paths) {
    assert.doesNotThrow(() => {
      const { config } = loadConfigAt(path);
      runChecks(config, dirname(path), join(dirname(path), "sandbox"), { report: false });
    }, `stack config must pass the full static check: ${path}`);
  }
});

test("the reference Fly deployment declares the in-process Slack surface", () => {
  const { config } = loadConfigAt(join(stacksDir, "acme", "qm.config.jsonc"));
  assert.ok(config.services.includes("slack"));
  const secrets = new Set(computedSecrets(config).map((secret) => secret.name));
  assert.ok(secrets.has("SLACK_BOT_TOKEN"));
  assert.ok(secrets.has("SLACK_APP_TOKEN"));
});
