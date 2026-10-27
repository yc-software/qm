import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_AGENT_MODEL_ID } from "../../src/model/pi-models.ts";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const readme = read("README.md");
const boot = read("src/boot.ts");
const toolWrappers = read("src/harness/agent-tools/wrappers.ts");
const rootPackage = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
const webPackage = JSON.parse(read("plugins/web-ui/package.json")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

test(".env.example declares no model provider key, real or placeholder", () => {
  for (const line of read(".env.example").split("\n")) {
    assert.doesNotMatch(
      line,
      /^\s*(ANTHROPIC|OPENAI|OPENROUTER)_API_KEY=/,
      `${line.trim()} makes loadConfig report that provider as configured (config.ts does a bare truthiness check, ` +
        `so a placeholder counts), and the deployment then advertises a provider whose key cannot authenticate`,
    );
  }
});

test(".env.example does not pin a base model that drifts from the shipped default", () => {
  const envExample = read(".env.example");
  const pinned = /^PI_MODEL=(.+)$/m.exec(envExample)?.[1];
  if (pinned) assert.equal(pinned, DEFAULT_AGENT_MODEL_ID, "an active PI_MODEL pin must match the shipped default");
});

test("README describes the shipped Slack topology", () => {
  assert.match(boot, /startSlackPlugin\(desired, built\.slackCore\)/);
  assert.match(readme, /Slack is an optional in-process plugin that core starts\s+and supervises/);
  assert.doesNotMatch(readme, /nothing in the core knows about Slack/);
});

test("README names the frameworks the shipped surfaces use", () => {
  assert.ok(rootPackage.dependencies["@slack/bolt"]);
  assert.ok(webPackage.devDependencies.vite);
  assert.ok(webPackage.dependencies.lit);
  assert.match(webPackage.scripts.build ?? "", /vite build/);
  for (const framework of ["node:http", "Bolt", "Vite", "Lit"]) {
    assert.ok(readme.includes(framework), `README names ${framework}`);
  }
  assert.doesNotMatch(readme, /No build step, no framework/);
});

test("the tool approval gate exempts only the no-effect turn ender", () => {
  assert.match(toolWrappers, /TOOL_APPROVAL_EXEMPT = new Set\(\["finish_silently"\]\)/);
});
