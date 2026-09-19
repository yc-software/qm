import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../src/types.ts";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { withOperationSignal } from "../src/util/async.ts";

const handle: SandboxHandle = { id: "h", rootDir: "/workspace" };

function recordingSandbox(onRun?: (opts?: ExecOptions) => Promise<void>): {
  sandbox: Sandbox;
  lastOpts: () => ExecOptions | undefined;
} {
  let captured: ExecOptions | undefined;
  const sandbox = {
    async run(_handle: SandboxHandle, command: string, opts?: ExecOptions): Promise<ExecResult> {
      captured = opts;
      await onRun?.(opts);
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
  const controller = new AbortController();
  await ctx.execute("sleep 9999", { signal: controller.signal });
  const { signal, ...opts } = lastOpts()!;
  assert.deepEqual(opts, { timeoutMs: 120_000 });
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  const reason = new Error("turn cancelled");
  controller.abort(reason);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, reason);
});

test("no timeout and no signal → no opts override leaks; a signal alone still plumbs through", async () => {
  const { sandbox, lastOpts } = recordingSandbox();
  const ctx = ctxFor(sandbox);
  await ctx.execute("echo hi");
  assert.equal(lastOpts(), undefined);
  const controller = new AbortController();
  await ctx.execute("echo hi", { signal: controller.signal });
  const { signal, ...opts } = lastOpts()!;
  assert.deepEqual(opts, {});
  assert.ok(signal);
  assert.equal(signal.aborted, false);
  const reason = new Error("turn cancelled");
  controller.abort(reason);
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason, reason);
});

for (const scenario of [
  { name: "the turn signal alone", turn: true, ambient: false, abort: "turn" },
  { name: "the ambient signal alone", turn: false, ambient: true, abort: "ambient" },
  { name: "the turn signal combined with an ambient signal", turn: true, ambient: true, abort: "turn" },
  { name: "the ambient signal combined with a turn signal", turn: true, ambient: true, abort: "ambient" },
] as const) {
  test(`execute cancels in-flight sandbox work through ${scenario.name} and retains the timeout ceiling`, async () => {
    const turn = new AbortController();
    const ambient = new AbortController();
    const entered = Promise.withResolvers<ExecOptions | undefined>();
    const { sandbox } = recordingSandbox(async (opts) => {
      entered.resolve(opts);
      assert.ok(opts?.signal);
      const signal = opts.signal;
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const ctx = ctxFor(sandbox, { execTimeoutMs: 120_000, execTimeoutCeilingMs: 300_000 });
    const reason = new Error(`${scenario.abort} cancelled`);
    const running = withOperationSignal(scenario.ambient ? ambient.signal : undefined, () =>
      ctx.execute("sleep 9999", { timeoutSeconds: 400, ...(scenario.turn ? { signal: turn.signal } : {}) }),
    );
    const rejected = assert.rejects(running, (error) => error === reason);
    const { signal, ...opts } = (await entered.promise)!;
    assert.deepEqual(opts, { timeoutMs: 300_000 });
    assert.ok(signal);
    assert.equal(signal.aborted, false);
    const aborted = scenario.abort === "turn" ? turn : ambient;
    const remaining = scenario.abort === "turn" ? ambient : turn;
    aborted.abort(reason);
    await rejected;
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, reason);
    assert.equal(remaining.signal.aborted, false);
  });
}
