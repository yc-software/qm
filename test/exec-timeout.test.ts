import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function recordingSandbox(): { sandbox: Sandbox; lastOpts: () => ExecOptions | undefined } {
  let captured: ExecOptions | undefined;
  const sandbox = {
    async run(_handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult> {
      captured = opts;
      return { stdout: `ran ${command}`, stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  return { sandbox, lastOpts: () => captured };
}

function ctxFor(sandbox: Sandbox, extra: Partial<ToolContextDeps> = {}) {
  const scope = scopeId("personal", "U1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  return createToolContext({
    sandbox,
    provision: async () => handle,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
    ...extra,
  });
}

test("the agent's timeout_seconds is converted to ms and passed to sandbox.run", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox, { execTimeoutMs: 120_000, execTimeoutCeilingMs: 300_000 });
  await ctx.execute("npm ci", { timeoutSeconds: 200 });
  assert.deepEqual(lastOpts(), { timeoutMs: 200_000 });
});

test("an over-ceiling timeout_seconds is CLAMPED to the ceiling (G4: one session can't starve others)", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox, { execTimeoutMs: 120_000, execTimeoutCeilingMs: 300_000 });
  await ctx.execute("sleep 9999", { timeoutSeconds: 100_000 });
  assert.deepEqual(lastOpts(), { timeoutMs: 300_000 });
});

test("no agent param → the configured default is used (and still clamped)", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox, { execTimeoutMs: 120_000, execTimeoutCeilingMs: 300_000 });
  await ctx.execute("echo hi");
  assert.deepEqual(lastOpts(), { timeoutMs: 120_000 });
});

test("a misconfigured default ABOVE the ceiling is itself clamped (the ceiling is the hard cap)", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox, { execTimeoutMs: 500_000, execTimeoutCeilingMs: 300_000 });
  await ctx.execute("echo hi");
  assert.deepEqual(lastOpts(), { timeoutMs: 300_000 });
});

test("nothing configured (no agent param, no default) → no timeoutMs override leaks (sandbox backstop)", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox);
  await ctx.execute("echo hi");
  assert.equal(lastOpts(), undefined);
});

test("with a ceiling but no default, an under-ceiling agent param passes through unclamped", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox, { execTimeoutCeilingMs: 300_000 });
  await ctx.execute("npm test", { timeoutSeconds: 90 });
  assert.deepEqual(lastOpts(), { timeoutMs: 90_000 });
});

test("the per-turn abort signal plumbs through execute() into sandbox.run (alongside timeoutMs)", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox, { execTimeoutMs: 120_000 });
  const signal = new AbortController().signal;
  await ctx.execute("sleep 9999", { signal });
  assert.deepEqual(lastOpts(), { timeoutMs: 120_000, signal });
});

test("no timeout and no signal → no opts override leaks; a signal alone still plumbs through", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox);
  await ctx.execute("echo hi");
  assert.equal(lastOpts(), undefined);
  const signal = new AbortController().signal;
  await ctx.execute("echo hi", { signal });
  assert.deepEqual(lastOpts(), { signal });
});
