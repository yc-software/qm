import { SandboxProvisionCleanupError, cleanupFailedProvision } from "../src/sandbox/sandbox.ts";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import type { Config } from "../src/config.ts";
import { createAgentTools, type ToolContextRef } from "../src/harness/agent-tools.ts";
import { createToolContext, type ToolContext, type ToolContextDeps } from "../src/tools/primitives.ts";
import { scopeId, type TurnRequest, type WorkspaceLayer } from "../src/types.ts";
import type { Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { testConfig } from "./support/test-config.ts";

const scopedHandle: SandboxHandle = { id: "scoped-box", rootDir: "/workspace" };
const scratchHandle: SandboxHandle = { id: "scratch-box", rootDir: "/workspace", scratch: true };

function routingCtx(extra: Partial<ToolContextDeps> = {}) {
  const calls = { provision: 0, scratch: 0, ranOn: [] as string[] };
  const layers: WorkspaceLayer[] = [{ scopeId: scopeId("personal", "U1"), mountPath: "", mode: "rw" }];
  const sandbox = {
    async run(handle: SandboxHandle) {
      calls.ranOn.push(handle.id);
      return { stdout: "ok", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const ctx = createToolContext({
    sandbox,
    provision: async () => {
      calls.provision++;
      return scopedHandle;
    },
    provisionScratch: async () => {
      calls.scratch++;
      return scratchHandle;
    },
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
  return { ctx, calls };
}

test("execute routes scratch:true to the scratch box and default to the scoped box", async () => {
  const { ctx, calls } = routingCtx();
  await ctx.execute("echo hi");
  assert.deepEqual({ ...calls }, { provision: 1, scratch: 0, ranOn: ["scoped-box"] });
  await ctx.execute("echo hi", { scratch: true });
  assert.deepEqual({ ...calls }, { provision: 1, scratch: 1, ranOn: ["scoped-box", "scratch-box"] });
});

test("execute scratch:true without a wired scratch path fails loudly, never silently scoped", async () => {
  const { ctx } = routingCtx({ provisionScratch: undefined });
  await assert.rejects(ctx.execute("echo hi", { scratch: true }), /scratch execution is not available/);
});

function sinkToolContext() {
  const seen: Array<{ command: string; opts: unknown }> = [];
  const tc = {
    async execute(command: string, opts?: unknown) {
      seen.push({ command, opts });
      return { stdout: `ran ${command}`, stderr: "", code: 0, timedOut: false };
    },
  } as unknown as ToolContext;
  return { tc, seen };
}

const textOf = (r: unknown): string => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const call = (tool: ReturnType<typeof createAgentTools>[number] | undefined, params: unknown) => {
  assert.ok(tool);
  return (tool.execute as unknown as (id: string, p: unknown) => Promise<unknown>)("t", params);
};
const schemaProps = (tool: ReturnType<typeof createAgentTools>[number]): string[] =>
  Object.keys((tool as unknown as { parameters: { properties: Record<string, unknown> } }).parameters.properties);
const schemaRequired = (tool: ReturnType<typeof createAgentTools>[number]): string[] =>
  (tool as unknown as { parameters: { required?: string[] } }).parameters.required ?? [];

test("flag OFF: the execute surface is exactly the legacy one (no scope/durable, scoped box)", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createAgentTools({ current: tc });
  assert.deepEqual(schemaProps(execute!), [
    "command",
    "sandbox_id",
    "purpose",
    "timeout_seconds",
    "credentials",
    "retrySafe",
  ]);
  assert.deepEqual(schemaRequired(execute!), ["command", "purpose"]);
  await call(execute, { command: "echo hi" });
  assert.deepEqual(seen, [{ command: "echo hi", opts: undefined }]);
});

test("flag ON: scope defaults to the durable scoped box; scratch is an explicit opt-in", async () => {
  const { tc, seen } = sinkToolContext();
  const ref: ToolContextRef = { current: tc };
  const [execute] = createAgentTools(ref, { scratchExec: true });
  assert.deepEqual(schemaProps(execute!), [
    "command",
    "sandbox_id",
    "purpose",
    "timeout_seconds",
    "credentials",
    "scope",
    "durable",
    "retrySafe",
  ]);

  await call(execute, { command: "echo hi" });
  assert.deepEqual(
    seen.at(-1),
    { command: "echo hi", opts: undefined },
    "omitted scope = durable scoped (follow-ups must work)",
  );

  await call(execute, { command: "echo hi", scope: "scratch" });
  assert.deepEqual(seen.at(-1)!.opts, { scratch: true });

  await call(execute, { command: "echo hi", scope: "scoped" });
  assert.deepEqual(seen.at(-1)!.opts, undefined, "a scoped run carries no scratch opt (today's path)");

  await call(execute, { command: "echo hi", scope: "scoped", durable: true, timeout_seconds: 9 });
  assert.deepEqual(seen.at(-1)!.opts, { timeoutSeconds: 9 });
});

test("flag ON: unsupported scope/durable pairings return a crisp [error] without executing", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createAgentTools({ current: tc }, { scratchExec: true });

  const e1 = textOf(await call(execute, { command: "echo hi", scope: "scratch", durable: true }));
  assert.match(e1, /\[error\] a scratch box cannot be made durable yet/);

  const e2 = textOf(await call(execute, { command: "echo hi", scope: "scoped", durable: false }));
  assert.match(e2, /\[error\] the scoped computer is always durable today/);

  assert.equal(seen.length, 0, "invalid pairings never reach the sandbox");
});

test("flag ON: the tool_call/tool_result entries record which box ran the command", async () => {
  const emitted: Array<{ type: string; payload: { tool?: string; scope?: string } }> = [];
  const { tc } = sinkToolContext();
  const ref: ToolContextRef = {
    current: tc,
    emit: (e) => {
      emitted.push(e as never);
    },
    scopeLabel: scopeId("personal", "U1"),
  };
  const [execute] = createAgentTools(ref, { scratchExec: true });
  await call(execute, { command: "echo hi", scope: "scratch" });
  await call(execute, { command: "echo hi" });
  assert.deepEqual(
    emitted.map((e) => `${e.type}:${e.payload.scope}`),
    ["tool_call:scratch", "tool_result:scratch", "tool_call:scoped", "tool_result:scoped"],
  );
});

test("flag ON: the description advertises the routing policy truthfully", () => {
  const { tc } = sinkToolContext();
  const [legacy] = createAgentTools({ current: tc });
  const [execute] = createAgentTools({ current: tc }, { scratchExec: true });
  const desc = (execute as unknown as { description: string }).description;
  assert.match(desc, /"scoped" \(DEFAULT\)/);
  assert.match(desc, /Use it for self-contained commands and API work/);
  assert.match(desc, /only credentials explicitly requested/);
  assert.doesNotMatch(JSON.stringify(execute), /credential-free|blank, instant/);
  assert.match(desc, /including Files/);
  assert.match(desc, /local files are discarded after the turn/);
  assert.match(desc, /Use scope:"scoped" when you need existing workspace files/);
  assert.doesNotMatch((legacy as unknown as { description: string }).description, /scratch/i);
});

async function freshApp(extra: Partial<Config> = {}) {
  const config = testConfig({
    dataDir: mkdtempSync(join(tmpdir(), "ap-scratch-")),
    ...extra,
  });
  const built = buildApp(config);
  const computer = await built.sandboxResources.create("U1", "personal:U1", "sprites", "scoped");
  await built.sandboxResources.setDefault("U1", "personal:U1", computer.id);
  return built;
}

const dm = (text: string): TurnRequest => ({
  surface: "test",
  actor: { externalId: "U1" },
  conversation: { kind: "dm", threadRef: "dm:U1:t1" },
  text,
});

test("a scratch turn runs on a separate volumeless box with scoped capability tokens", async () => {
  const { app } = await freshApp({ signingSecret: "s3cret", apiBaseUrl: "https://core.test" });

  const scoped = await app.turn(dm("!run printenv AGENT_API_TOKEN"));
  assert.equal(scoped.status, "ok");
  assert.ok(
    scoped.reply && scoped.reply.length > 0 && !scoped.reply.startsWith("(exit"),
    "the scoped box sees the capability token",
  );

  const scratch = await app.turn(dm("!scratch printenv AGENT_API_TOKEN"));
  assert.equal(scratch.status, "ok");
  assert.equal(scratch.reply, "<redacted:credential>", "scoped capability tokens are usable but masked in output");

  assert.ok(
    fakeSprites.names().some((n) => n.startsWith("qm-sandbox-")),
    "the scoped box is the scope's durable sprite",
  );
  assert.ok(
    fakeSprites.calls.some((c) => /\/sprites\/qm-scratch-[^/]+\/exec$/.test(c.path)),
    "the scratch run landed on a separate throwaway sprite",
  );
  assert.ok(
    !fakeSprites.names().some((n) => n.startsWith("qm-scratch-")),
    "the scratch sprite is destroyed at release",
  );
});

test("nothing on the scratch box survives the turn", async () => {
  const { app } = await freshApp();
  const first = await app.turn(dm('!scratch sh -c "echo leak > leak.txt && cat leak.txt"'));
  assert.equal(first.reply, "leak");
  const second = await app.turn(dm('!scratch sh -c "cat leak.txt 2>/dev/null; echo clean"'));
  assert.equal(second.reply, "clean", "the release reset blanked the box between turns");
});

test("a deliverable has to live on the scoped computer — the scratch box can't be attached from", async () => {
  const { app } = await freshApp();
  const made = await app.turn(dm('!scratch sh -c "printf hello > from-scratch.txt && echo made"'));
  assert.equal(made.reply, "made");
  const res = await app.turn(dm("!attach from-scratch.txt"));
  assert.equal(res.attachments, undefined, "the scratch box is wiped and invisible to attach");
  assert.match(res.reply ?? "", /not attached.*from-scratch\.txt \(not found\)/);
});

test("a scratch-only turn still reclaims its box (reset + suspend) when the turn ends", async () => {
  const { app, sandbox } = await freshApp();
  let toreDown = 0;
  const realTeardown = sandbox.teardown.bind(sandbox);
  sandbox.teardown = async (handle, opts) => {
    if (handle.scratch) toreDown++;
    return realTeardown(handle, opts);
  };
  await app.turn(dm("!scratch echo hi"));
  assert.equal(toreDown, 1, "the scratch box is released exactly once per turn");
});

test("execute exposes only requested keychain environment values to one command", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const sandbox = {
    async run(handle: SandboxHandle) {
      seen.push(handle.env);
      return { stdout: "ok", stderr: "", code: 0, timedOut: false };
    },
  } as unknown as Sandbox;
  const { ctx } = routingCtx({
    sandbox,
    commandCredentials: [
      { handle: "kc_github12345", env: [{ key: "GITHUB_TOKEN", value: "secret" }] },
      { handle: "kc_npm123456789", env: [{ key: "NPM_TOKEN", value: "other" }] },
    ],
  });

  await ctx.execute("env");
  await ctx.execute("env", { credentials: ["kc_github12345"] });

  assert.equal(seen[0]?.GITHUB_TOKEN, undefined);
  assert.equal(seen[1]?.GITHUB_TOKEN, "secret");
  assert.equal(seen[1]?.NPM_TOKEN, undefined);
  assert.equal(scopedHandle.env, undefined, "command credentials never mutate SandboxHandle");
});

test("execute rejects unavailable, conflicting, and reached credential requests", async () => {
  const { ctx } = routingCtx({
    commandCredentials: [
      { handle: "kc_one12345678", env: [{ key: "TOKEN", value: "one" }] },
      { handle: "kc_two12345678", env: [{ key: "TOKEN", value: "two" }] },
    ],
  });

  await assert.rejects(ctx.execute("true", { credentials: ["kc_missing"] }), /not available/);
  await assert.rejects(
    ctx.execute("true", { credentials: ["kc_one12345678", "kc_two12345678"] }),
    /conflicting environment key/,
  );
  await assert.rejects(
    ctx.execute("true", { reachTarget: "#other", credentials: ["kc_one12345678"] }),
    /scoped, scratch, or owner computers/,
  );
});

test("execute schema lists exact command credential handles", async () => {
  const { tc, seen } = sinkToolContext();
  const [execute] = createAgentTools({ current: tc }, { commandCredentialHandles: ["kc_github12345"] });
  assert.deepEqual(schemaProps(execute!), [
    "command",
    "sandbox_id",
    "purpose",
    "timeout_seconds",
    "credentials",
    "retrySafe",
  ]);

  await call(execute, { command: "gh api user", credentials: ["kc_github12345"] });
  assert.deepEqual(seen.at(-1)?.opts, { credentials: ["kc_github12345"] });
});

test("execute masks credential output before model delivery, screening, and transcript logging", async () => {
  const secret = "execution-secret-123456";
  const emitted: unknown[] = [];
  const screened: unknown[] = [];
  const { ctx } = routingCtx({
    sandbox: {
      async run() {
        return { stdout: `safe prefix ${secret} safe suffix`, stderr: "useful diagnostics", code: 0, timedOut: false };
      },
    } as unknown as Sandbox,
    commandCredentials: [{ handle: "kc_test123456", env: [{ key: "TOKEN", value: secret }] }],
  });
  const [execute] = createAgentTools(
    {
      current: ctx,
      scopeLabel: scopeId("personal", "U1"),
      emit: async (entry) => {
        emitted.push(entry);
      },
      screenToolResult: async (input) => {
        screened.push(input);
        return { outcome: "allow" };
      },
    },
    { commandCredentialHandles: ["kc_test123456"] },
  );
  const result = await call(execute, { command: "diagnose", credentials: ["kc_test123456"] });
  const all = JSON.stringify({ result, emitted, screened });
  assert.ok(!all.includes(secret));
  assert.ok(all.includes("useful diagnostics"));
  assert.match(textOf(result), /<redacted:credential>/);
  assert.match(textOf(result), /exit 0/);
  assert.equal(screened.length, 1);
  assert.ok(
    emitted.some((entry) => {
      const e = entry as { type?: string; payload?: { isError?: boolean; code?: number } };
      return e.type === "tool_result" && e.payload?.isError === false && e.payload?.code === 0;
    }),
  );
});

test("execute checks only the current execution environment, including inherited credentials", async () => {
  const inherited = "inherited-secret-1234";
  const unselected = "unselected-secret-5678";
  let output = unselected;
  const { ctx } = routingCtx({
    provision: async () => ({ ...scopedHandle, env: { TOKEN: inherited, AWS_REGION: "us-west-2" } }),
    sandbox: {
      async run() {
        return { stdout: output, stderr: "", code: 0, timedOut: false };
      },
    } as unknown as Sandbox,
    commandCredentials: [{ handle: "kc_unused1234", env: [{ key: "OTHER_TOKEN", value: unselected }] }],
  });
  assert.equal((await ctx.execute("diagnose")).stdout, unselected);
  output = "us-west-2";
  assert.equal((await ctx.execute("diagnose")).stdout, output);
  output = inherited;
  assert.equal((await ctx.execute("diagnose")).stdout, "<redacted:credential>");
});

test("execute replaces credential-bearing provider errors without retaining the original cause", async () => {
  const secret = "provider-secret-12345";
  const { ctx } = routingCtx({
    provision: async () => ({ ...scopedHandle, env: { TOKEN: secret } }),
    sandbox: {
      async run() {
        throw new Error(`provider returned ${secret}`);
      },
    } as unknown as Sandbox,
  });
  await assert.rejects(ctx.execute("diagnose"), (error: Error) => {
    assert.equal(error.message, "provider returned <redacted:credential>");
    assert.ok(!error.stack?.includes(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
});

test("execute records a safe provider-error result for native replay", async () => {
  const secret = "provider-secret-12345";
  const entries: unknown[] = [];
  const { ctx } = routingCtx({
    provision: async () => ({ ...scopedHandle, env: { TOKEN: secret } }),
    sandbox: {
      async run() {
        throw new Error(`provider returned ${secret}`);
      },
    } as unknown as Sandbox,
  });
  const [execute] = createAgentTools({
    current: ctx,
    scopeLabel: scopeId("personal", "U1"),
    emit: async (entry) => {
      entries.push(entry);
    },
  });
  const result = await call(execute, { command: "diagnose" });
  assert.match(textOf(result), /<redacted:credential>/);
  assert.ok(!JSON.stringify({ result, entries }).includes(secret));
  assert.ok(entries.some((entry) => (entry as { type?: string }).type === "tool_result"));
});

test("execute respects secret metadata even for configuration-named credentials", async () => {
  const { ctx } = routingCtx({
    sandbox: {
      async run() {
        return { stdout: "credential", stderr: "", code: 0, timedOut: false };
      },
    } as unknown as Sandbox,
    commandCredentials: [
      {
        handle: "kc_config1234",
        env: [
          { key: "AWS_REGION", value: "credential", secret: true },
          { key: "USERNAME", value: "a", secret: false },
        ],
      },
    ],
  });
  assert.equal((await ctx.execute("diagnose", { credentials: ["kc_config1234"] })).stdout, "<redacted:credential>");
});

test("owner execute masks selected credentials and inherited proxy credentials", async () => {
  const { ctx } = routingCtx({
    provisionOwnerAuth: async () => ({ ...scopedHandle, env: { HTTPS_PROXY: "https://user:proxy-secret@proxy.test" } }),
    commandCredentials: [{ handle: "owner-token", scope: "owner", env: [{ key: "TOKEN", value: "owner-secret" }] }],
    sandbox: {
      async run() {
        return { stdout: "owner-secret https://user:proxy-secret@proxy.test", stderr: "", code: 0, timedOut: false };
      },
    } as unknown as Sandbox,
  });
  assert.equal(
    (await ctx.execute("diagnose", { ownerAuth: true, credentials: ["owner-token"] })).stdout,
    "<redacted:credential> <redacted:credential>",
  );
});

test("scratch credentials are selected per command and masked before returning", async () => {
  const environments: Array<Record<string, string> | undefined> = [];
  const { ctx } = routingCtx({
    provisionScratch: async () => ({ ...scratchHandle, env: { AGENT_API_TOKEN: "scope-capability" } }),
    commandCredentials: [
      { handle: "selected", env: [{ key: "TOKEN", value: "selected-secret" }] },
      { handle: "unselected", env: [{ key: "OTHER_TOKEN", value: "other-secret" }] },
      { handle: "owner", scope: "owner", env: [{ key: "OWNER_TOKEN", value: "owner-secret" }] },
    ],
    sandbox: {
      async run(handle: SandboxHandle) {
        environments.push(handle.env);
        return { stdout: Object.values(handle.env ?? {}).join(" "), stderr: "", code: 0, timedOut: false };
      },
    } as unknown as Sandbox,
  });
  const result = await ctx.execute("env", { scratch: true, credentials: ["selected"] });
  assert.equal(result.stdout, "<redacted:credential> <redacted:credential>");
  assert.equal(environments[0]?.TOKEN, "selected-secret");
  assert.equal(environments[0]?.OTHER_TOKEN, undefined);
  await ctx.execute("env", { scratch: true });
  assert.equal(environments[1]?.TOKEN, undefined);
  await assert.rejects(ctx.execute("env", { scratch: true, credentials: ["owner"] }), /requires scope:owner/);
});

function turnBoxes(sandbox: Partial<Sandbox>, transferId = "turn-a") {
  const events: import("../src/audit/audit-log.ts").AuditEvent[] = [];
  const errors: unknown[] = [];
  const boxes = createTurnSandboxes({
    deps: {
      sandbox,
      auditLog: { record: (event: import("../src/audit/audit-log.ts").AuditEvent) => events.push(event) },
      errors: { record: (...args: unknown[]) => errors.push(args) },
    },
    input: { runId: "run-1" },
    actor: { id: "U1" },
    session: { id: "session-1" },
    transferId,
    scopeId: scopeId("channel", "C1"),
    memoryScopeId: scopeId("channel", "C1"),
    connectorEnv: { AGENT_API_TOKEN: "scope-capability" },
    resolution: {
      layers: [
        { scopeId: scopeId("channel", "C1"), mode: "rw", mountPath: "" },
        { scopeId: scopeId("org", "global"), mode: "ro", mountPath: "global" },
      ],
    },
  } as unknown as TurnSandboxContext);
  return { boxes, events, errors };
}

test("scratch provisioning is singleflight within a turn and isolated across turns", async () => {
  const provisions: Parameters<Sandbox["provision"]>[] = [];
  const releases: Parameters<Sandbox["teardown"]>[] = [];
  const sandbox: Partial<Sandbox> = {
    async provision(...args) {
      provisions.push(args);
      await Promise.resolve();
      return { ...scratchHandle, id: args[1]!.scratch!.key, backend: "local" };
    },
    async teardown(...args) {
      releases.push(args);
    },
  };
  const first = turnBoxes(sandbox);
  const second = turnBoxes(sandbox, "turn-b");
  const [a, b, c] = await Promise.all([
    first.boxes.provisionScratch(),
    first.boxes.provisionScratch(),
    second.boxes.provisionScratch(),
  ]);
  assert.equal(a, b);
  assert.notEqual(a.id, c.id);
  assert.equal(provisions.length, 2);
  for (const [layers, opts] of provisions) {
    assert.deepEqual(
      layers.map((layer) => layer.mountPath),
      ["global"],
    );
    assert.deepEqual(opts?.env, { AGENT_API_TOKEN: "scope-capability" });
  }
  await first.boxes.reclaimBox();
  await second.boxes.reclaimBox();
  assert.equal(releases.length, 2);
  assert.ok(releases.every(([, opts]) => opts?.destroy === true));
  assert.deepEqual(
    first.events.map((event) => event.action),
    ["sandbox.scratch.provision_started", "sandbox.scratch.provision_ready", "sandbox.scratch.released"],
  );
  assert.equal(new Set(first.events.map((event) => event.resource)).size, 1);
  const detail = JSON.parse(first.events.at(-1)!.detail!);
  assert.equal(detail.runId, "run-1");
  assert.equal(detail.sessionId, "session-1");
  assert.equal(detail.sandboxId, a.id);
  assert.equal(detail.backend, "local");
  assert.ok(detail.cleanupMs >= 0);
  assert.ok(!JSON.stringify(first.events).includes("scope-capability"));
});

test("reclaim waits for in-flight scratch creation before destroying its handle", async () => {
  const ready = Promise.withResolvers<SandboxHandle>();
  const destroyed: string[] = [];
  const { boxes } = turnBoxes({
    provision: () => ready.promise,
    async teardown(handle) {
      destroyed.push(handle.id);
    },
  });
  const provision = boxes.provisionScratch();
  const reclaim = boxes.reclaimBox();
  ready.resolve(scratchHandle);
  await Promise.all([provision, reclaim]);
  assert.deepEqual(destroyed, [scratchHandle.id]);
  assert.equal(boxes.scratchBox.handle, null);
});

test("scratch destruction failures keep their cause and retain the handle for retry", async () => {
  let attempts = 0;
  let fail = true;
  const { boxes, events, errors } = turnBoxes({
    async provision() {
      return scratchHandle;
    },
    async teardown() {
      attempts++;
      if (fail) throw new Error(`teardown-boom-${attempts}`);
    },
  });
  await boxes.provisionScratch();
  await assert.rejects(boxes.reclaimBox(), (error: Error) => {
    assert.equal(error.message, "Disposable sandbox destruction failed");
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((attempt: Error) => attempt.message),
      ["teardown-boom-1", "teardown-boom-2", "teardown-boom-3"],
    );
    return true;
  });
  assert.equal(attempts, 3);
  assert.equal(boxes.scratchBox.handle, scratchHandle);
  assert.equal(events.filter((event) => event.action === "sandbox.scratch.release_failed").length, 1);
  assert.equal(events.filter((event) => event.action === "sandbox.scratch.released").length, 0);
  assert.equal(
    JSON.parse(events.find((event) => event.action === "sandbox.scratch.release_failed")!.detail!).error,
    "Disposable sandbox destruction failed <- Error: teardown-boom-1 <- Error: teardown-boom-2 <- Error: teardown-boom-3",
  );
  assert.equal(errors.length, 1);
  fail = false;
  await boxes.reclaimBox();
  assert.equal(boxes.scratchBox.handle, null);
});

test("failed scratch provisioning is audited with its error and can retry", async () => {
  let attempts = 0;
  const { boxes, events } = turnBoxes({
    async provision() {
      if (attempts++ === 0) throw new Error("provision-boom");
      return scratchHandle;
    },
    async teardown() {},
  });
  await assert.rejects(boxes.provisionScratch(), /provision-boom/);
  await boxes.provisionScratch();
  await boxes.reclaimBox();
  assert.deepEqual(
    events.map((event) => event.action),
    [
      "sandbox.scratch.provision_started",
      "sandbox.scratch.provision_failed",
      "sandbox.scratch.provision_started",
      "sandbox.scratch.provision_ready",
      "sandbox.scratch.released",
    ],
  );
  assert.equal(JSON.parse(events[1]!.detail!).error, "provision-boom");
});

for (const recovers of [true, false]) {
  test(`failed scratch initialization keeps both errors and the cleanup identity; recovery=${recovers}`, async () => {
    let destroys = 0;
    const partial = { ...scratchHandle, backend: "local", env: { TOKEN: "token" } };
    const sandbox: Partial<Sandbox> = {
      async provision() {
        const failure = new Error("initialization failed");
        await cleanupFailedProvision({ teardown: sandbox.teardown! }, partial, failure);
        throw failure;
      },
      async teardown(handle, opts) {
        assert.equal(handle.id, partial.id);
        assert.equal(opts?.destroy, true);
        if (destroys++ === 0 || !recovers) throw new Error("teardown-boom");
      },
    };
    const { boxes, events } = turnBoxes(sandbox);
    await assert.rejects(boxes.provisionScratch(), (error: Error) => {
      assert.ok(error instanceof SandboxProvisionCleanupError);
      assert.equal(error.handle.id, partial.id);
      assert.match(error.message, /initialization failed/);
      assert.equal((error.cause as Error).message, "teardown-boom");
      return true;
    });
    await assert.rejects(boxes.provisionScratch(), /cleanup is still pending/);
    assert.equal(boxes.scratchBox.handle, null);
    assert.equal(boxes.scratchBox.pending?.id, partial.id);
    if (recovers) await boxes.reclaimBox();
    else await assert.rejects(boxes.reclaimBox(), /Disposable sandbox destruction failed/);
    const failure = events.find((event) => event.action === "sandbox.scratch.provision_failed")!;
    assert.equal(JSON.parse(failure.detail!).sandboxId, partial.id);
    assert.equal(JSON.parse(failure.detail!).backend, "local");
    assert.equal(events.at(-1)?.action, `sandbox.scratch.${recovers ? "released" : "release_failed"}`);
    assert.equal(boxes.scratchBox.pending === null, recovers);
  });
}
