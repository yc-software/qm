import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";

const root = resolve(import.meta.dirname, "..");
const allowlist: Record<string, string[]> = JSON.parse(
  readFileSync(join(root, "lint/slack-boundary-allowlist.json"), "utf8"),
);
const eslint = new ESLint({ cwd: root });

const boundaryMessages = (results: ESLint.LintResult[]): string[] =>
  results.flatMap((r) => r.messages.filter((m) => m.ruleId === "qm/slack-boundary").map((m) => m.message));

const lint = async (file: string, code: string): Promise<string[]> =>
  boundaryMessages(await eslint.lintText(code, { filePath: join(root, file) }));

test("every allowlisted file exists, is linted by the boundary rule, and still makes each allowlisted import", async () => {
  const files = Object.keys(allowlist).map((f) => join(root, f));
  assert.ok(files.length > 0);
  for (const file of files)
    assert.ok(
      (await eslint.calculateConfigForFile(file)).rules["qm/slack-boundary"],
      `${file} is exempt from the rule`,
    );
  const results = await eslint.lintFiles(files);
  assert.equal(results.length, files.length);
  assert.deepEqual(boundaryMessages(results), []);
});

test("a core file importing a Slack internal it is not allowlisted for fails lint", async () => {
  assert.deepEqual(
    await lint("src/core/new-module.ts", 'import { slackPluginConfigFromEnv } from "../slack/config.ts";\n'),
    [
      "Reach Slack through the Surface contract (src/surfaces/contract.ts) and the surface registry instead of importing src/slack/config.ts. Only src/slack/**, src/surfaces/slack/** and the composition root (src/wiring.ts, src/index.ts) may import Slack internals.",
    ],
  );
  assert.deepEqual(
    await lint(
      "src/agent/replay.ts",
      'import { x } from "../slack/message-revisions.ts";\nexport type { Y } from "../surfaces/slack/adapter.ts";\n',
    ),
    [
      "Reach Slack through the Surface contract (src/surfaces/contract.ts) and the surface registry instead of importing src/surfaces/slack/adapter.ts. Only src/slack/**, src/surfaces/slack/** and the composition root (src/wiring.ts, src/index.ts) may import Slack internals.",
    ],
  );
  assert.equal((await lint("src/core/new-module.ts", 'export * from "../slack/config.ts";\n')).length, 1);
  assert.equal((await lint("src/core/new-module.ts", 'const m = await import("../slack/config.ts");\n')).length, 1);
  assert.equal(
    (await lint("src/core/new-module.ts", 'type C = import("../slack/config.ts").SlackPluginConfig;\n')).length,
    1,
  );
  assert.deepEqual(await lint("src/core/new-module.ts", 'import { r } from "../surfaces/registry.ts";\n'), []);
});

test("an allowlisted file that drops its Slack import fails lint until its entry is removed", async () => {
  assert.deepEqual(await lint("src/agent/replay.ts", "export {};\n"), [
    "src/agent/replay.ts does not import src/slack/message-revisions.ts; delete that entry from lint/slack-boundary-allowlist.json so the allowlist only shrinks.",
  ]);
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
