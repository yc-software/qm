import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";

const root = resolve(import.meta.dirname, "..");
const allowlist: Record<string, string[]> = JSON.parse(
  readFileSync(join(root, "lint/slack-boundary-allowlist.json"), "utf8"),
);
const eslint = new ESLint({ cwd: root });

const lint = async (file: string, code: string) =>
  (await eslint.lintText(code, { filePath: join(root, file) }))
    .flatMap((r) => r.messages)
    .filter((m) => m.ruleId === "qm/slack-boundary")
    .map(({ messageId, line, message }) => ({ messageId, line, message }));
const reported = async (file: string, code: string) =>
  (await lint(file, code)).map(({ messageId, line }) => `${messageId} on line ${line}`);

test("every allowlisted file exists and is checked by the boundary rule", async () => {
  assert.ok(Object.keys(allowlist).length > 0);
  for (const file of Object.keys(allowlist)) {
    assert.ok(existsSync(join(root, file)), `${file} no longer exists; delete its allowlist entry`);
    const config = await eslint.calculateConfigForFile(join(root, file));
    assert.ok(config.rules["qm/slack-boundary"], `${file} is exempt from the rule; delete its allowlist entry`);
  }
});

test("a file outside Slack imports a Slack internal it is not allowlisted for", async () => {
  assert.deepEqual(
    await reported(
      "src/agent/replay.ts",
      'import { x } from "../slack/message-revisions.ts";\nexport type { Y } from "../surfaces/slack/adapter.ts";\n',
    ),
    ["newImport on line 2"],
  );
  for (const code of [
    'import { slackPluginConfigFromEnv } from "../slack/config.ts";\n',
    'export * from "../slack/config.ts";\n',
    'const m = await import("../slack/config.ts");\n',
    "const m = await import(`../slack/config.ts`);\n",
    'type C = import("../slack/config.ts").SlackPluginConfig;\n',
    '// eslint-disable-next-line qm/slack-boundary\nimport { slackPluginConfigFromEnv } from "../slack/config.ts";\n',
  ])
    assert.deepEqual(await reported("src/core/new-module.ts", code), [
      `newImport on line ${code.split("\n").length - 1}`,
    ]);
  const [newImport] = await lint("src/core/new-module.ts", 'import { c } from "../slack/config.ts";\n');
  assert.ok(newImport?.message.includes("src/slack/config.ts"));
  assert.deepEqual(await lint("src/core/new-module.ts", 'import { r } from "../surfaces/registry.ts";\n'), []);
});

test("an allowlisted file that drops its Slack import fails until its entry is removed", async () => {
  const [stale, ...rest] = await lint("src/agent/replay.ts", "/* eslint-disable */\nexport {};\n");
  assert.deepEqual(rest, []);
  assert.equal(stale?.messageId, "staleEntry");
  assert.ok(stale.message.includes("src/slack/message-revisions.ts"));
});

test("Slack internals and the composition root may import Slack internals", async () => {
  const code = 'import { createSlackSurface } from "./surfaces/slack/adapter.ts";\n';
  assert.deepEqual(await lint("src/wiring.ts", code), []);
  assert.deepEqual(await lint("src/index.ts", code), []);
  assert.deepEqual(
    await lint("src/slack/new-module.ts", 'import { slackPluginConfigFromEnv } from "./config.ts";\n'),
    [],
  );
  assert.deepEqual(
    await lint(
      "src/surfaces/slack/new-module.ts",
      'import { slackPluginConfigFromEnv } from "../../slack/config.ts";\n',
    ),
    [],
  );
});
