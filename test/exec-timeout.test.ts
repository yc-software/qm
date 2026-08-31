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

test("expired effect authority rejects before sandbox, credential, MCP, control, or surface delegates", async () => {
  const calls = { authority: 0, provision: 0, sandbox: 0, credential: 0, mcp: 0, control: 0, surface: 0 };
  const sandbox = {
    async run(): Promise<ExecResult> {
      calls.sandbox += 1;
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const ctx = ctxFor(sandbox, {
    assertEffectCurrent: async () => {
      calls.authority += 1;
      throw new Error("schedule-fire receipt is not current");
    },
    provision: async () => {
      calls.provision += 1;
      return handle;
    },
    credentialExec: async () => {
      calls.credential += 1;
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    mcp: {
      toolDefs: () => [],
      async call() {
        calls.mcp += 1;
        return "unreachable";
      },
    } as never,
    control: {
      async listCrons() {
        calls.control += 1;
        return { crons: [], visible: [] };
      },
    } as never,
    controlClaims: {} as never,
    surface: {
      async post() {
        calls.surface += 1;
        return { ok: true, message: "unreachable" };
      },
    } as never,
  });

  await assert.rejects(ctx.execute("echo no"), /receipt is not current/u);
  await assert.rejects(ctx.credentialExec!("aws", []), /receipt is not current/u);
  await assert.rejects(ctx.callMcpTool("gmail.search", {}), /receipt is not current/u);
  await assert.rejects(ctx.cronList(), /receipt is not current/u);
  await assert.rejects(ctx.post("no"), /receipt is not current/u);
  assert.deepEqual(calls, {
    authority: 5,
    provision: 0,
    sandbox: 0,
    credential: 0,
    mcp: 0,
    control: 0,
    surface: 0,
  });
});

test("MCP native cards are consumed by the current surface and never returned as model-visible JSON", async () => {
  const posted: unknown[] = [];
  const card = {
    version: 1 as const,
    renderer: "qm.analytics.card.v1" as const,
    receiptId: "a".repeat(64),
    fallbackText: "Analytics result",
    heading: "Analytics",
    question: "How is usage?",
    findings: [],
    confidenceNotes: [],
    nextStep: "Review.",
    proposedActions: [],
  };
  const { sandbox } = recordingSandbox();
  const ctx = ctxFor(sandbox, {
    mcp: {
      toolDefs: () => [],
      async callWithContext() {
        return {
          text: "model-safe result",
          trustedAnalyticsCard: "sealed-card" as never,
          nativeCardIdempotencyKey: `mcp-card:${card.receiptId}`,
        };
      },
    } as never,
    surface: {
      async postNativeCard(received: unknown, idempotencyKey: string) {
        posted.push(received, idempotencyKey);
        return { ok: true, deliveryId: "delivery-1" };
      },
    } as never,
  });
  assert.equal(await ctx.callMcpTool("analytics", {}), "model-safe result");
  assert.deepEqual(posted, ["sealed-card", `mcp-card:${card.receiptId}`]);
});
