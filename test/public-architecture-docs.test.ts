import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_AGENT_MODEL_ID } from "../src/model/pi-models.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

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
