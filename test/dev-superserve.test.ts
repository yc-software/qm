import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSandbox } from "../scripts/dev/lib/sandbox.ts";

const resolve = (worktree: string, env: Record<string, string> = {}) =>
  resolveSandbox({
    worktree,
    requested: "superserve",
    corePort: 8080,
    lock: "/tmp/qm-dev-superserve-test",
    baseEnv: {
      SUPERSERVE_API_KEY: "test-key",
      SUPERSERVE_TEMPLATE: "qm-agent-test",
      PUBLIC_API_URL: "https://core.example.com",
      ...env,
    },
    log() {},
  });

test("Superserve dev namespaces isolate worktrees and survive instance restarts", async () => {
  const first = await resolve("/worktrees/template-a");
  const restarted = await resolve("/worktrees/template-a");
  const second = await resolve("/worktrees/template-b");
  const prefix = first.env.SUPERSERVE_NAME_PREFIX;
  assert.ok(prefix);
  assert.match(prefix, /^qmdev-[a-f0-9]{12}$/);
  assert.equal(restarted.env.SUPERSERVE_NAME_PREFIX, prefix);
  assert.notEqual(second.env.SUPERSERVE_NAME_PREFIX, prefix);
});

test("Superserve dev namespaces preserve an explicit override", async () => {
  const result = await resolve("/worktrees/template-a", { SUPERSERVE_NAME_PREFIX: "my-dev-namespace" });
  assert.equal(result.env.SUPERSERVE_NAME_PREFIX, "my-dev-namespace");
});

test("Superserve dev settings trim credentials and template and reject blank values before boot", async () => {
  const result = await resolve("/worktrees/template-a", {
    SUPERSERVE_API_KEY: " test-key ",
    SUPERSERVE_TEMPLATE: " qm-agent-test ",
  });
  assert.equal(result.env.SUPERSERVE_API_KEY, "test-key");
  assert.equal(result.env.SUPERSERVE_TEMPLATE, "qm-agent-test");
  for (const key of ["SUPERSERVE_API_KEY", "SUPERSERVE_TEMPLATE"]) {
    await assert.rejects(resolve("/worktrees/template-a", { [key]: "  " }), new RegExp(`requires ${key}`));
  }
});
