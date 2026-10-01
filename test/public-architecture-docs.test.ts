import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_AGENT_MODEL_ID } from "../src/model/pi-models.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const server = read("src/api/server.ts");
const agentTools = read("src/harness/agent-tools.ts");
const adminUi = read("plugins/admin/public/index.html");

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

test("Strict posture describes its approval gate, exemptions, and direct-mutation boundary", () => {
  assert.match(agentTools, /TOOL_APPROVAL_EXEMPT = new Set\(\["finish_silently"\]\)/);
  assert.match(
    server,
    /pathname === "\/v1\/surface-context".*pathname === "\/v1\/memory\/search".*pathname\.startsWith\("\/v1\/run-signals\/"\)/s,
  );
  assert.match(server, /decision === "decline"/);
  assert.doesNotMatch(server, /Strict posture permits observation only/);
  assert.doesNotMatch(adminUi, /every tool call/i);
});
