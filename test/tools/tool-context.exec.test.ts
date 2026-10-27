import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { ExecOptions, ExecResult, Sandbox, SandboxHandle } from "../../src/sandbox/sandbox.ts";
import { createToolContext, type ToolContextDeps } from "../../src/tools/tool-context.ts";
import { type CommandCredential } from "../../src/tools/primitives.ts";
import { scopeId, type WorkspaceLayer } from "../../src/types.ts";
import { createAgentTools } from "../../src/harness/agent-tools.ts";
import { createTurnToolState } from "../../src/harness/turn-tool-state.ts";

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

const executeCredentialPreparationHandle: SandboxHandle = { id: "credential-preparation", rootDir: "/workspace" };
type Materialized = Awaited<ReturnType<NonNullable<CommandCredential["resolve"]>>>;

function context(events: string[], credentials: CommandCredential[], extra: Partial<ToolContextDeps> = {}) {
  const runs: Array<SandboxHandle> = [];
  const sandbox = {
    async run(_handle: SandboxHandle, _command: string, _options?: ExecOptions) {
      events.push("run");
      runs.push(_handle);
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    },
  } as unknown as Sandbox;
  const ctx = createToolContext({
    sandbox,
    async provision() {
      events.push("provision");
      return executeCredentialPreparationHandle;
    },
    layers: [{ scopeId: scopeId("personal", "credential-tester"), mountPath: "", mode: "rw" }],
    commandPolicy() {
      events.push("policy");
      return { mode: "denylist", rules: [] };
    },
    authorizeCommand: () => false,
    commandCredentials: credentials,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "credential-tester",
    ...extra,
  });
  return { ctx, runs };
}

function credential(events: string[], name: string, value: Partial<Materialized> = {}): CommandCredential {
  return {
    handle: name,
    async resolve() {
      events.push(`resolve:${name}`);
      return {
        env: [],
        async commit() {
          events.push(`commit:${name}`);
        },
        ...value,
      };
    },
  };
}

test("credential resolution follows command policy and successful provisioning", async () => {
  const events: string[] = [];
  const { ctx, runs } = context(events, [
    credential(events, "selected", { env: [{ key: "TOKEN", value: "synthetic" }] }),
    credential(events, "unused"),
  ]);
  await ctx.execute("echo ready", { credentials: ["selected"] });
  assert.deepEqual(events, ["policy", "provision", "resolve:selected", "commit:selected", "run"]);
  assert.deepEqual(runs[0]?.env, { TOKEN: "synthetic" });
});

for (const stop of ["policy", "provision"] as const) {
  test(`${stop} rejection never resolves or commits requested credentials`, async () => {
    const events: string[] = [];
    const extra: Partial<ToolContextDeps> =
      stop === "policy"
        ? {
            commandPolicy() {
              events.push("policy");
              return { mode: "denylist", rules: [{ pattern: "echo", decision: "deny" }] };
            },
          }
        : {
            async provision() {
              events.push("provision");
              throw new Error("provision rejected");
            },
          };
    const { ctx, runs } = context(events, [credential(events, "selected")], extra);
    await assert.rejects(ctx.execute("echo ready", { credentials: ["selected"] }));
    assert.deepEqual(events, stop === "policy" ? ["policy"] : ["policy", "provision"]);
    assert.equal(runs.length, 0);
  });
}

test("conflicting env credentials fail before grant consumption", async () => {
  const events: string[] = [];
  const credentials = ["a", "b"].map((name) => credential(events, name, { env: [{ key: "TOKEN", value: name }] }));
  const { ctx, runs } = context(events, credentials);
  await assert.rejects(ctx.execute("true", { credentials: ["a", "b"] }), /conflicting/);
  assert.deepEqual(events, ["policy", "provision", "resolve:a", "resolve:b"]);
  assert.equal(runs.length, 0);
});

test("cancellation during resolution never commits a prepared grant", async () => {
  const events: string[] = [];
  const abort = new AbortController();
  const selected = credential(events, "selected");
  const resolve = selected.resolve!;
  selected.resolve = async () => {
    const prepared = await resolve();
    abort.abort();
    return prepared;
  };
  const { ctx, runs } = context(events, [selected]);
  await assert.rejects(ctx.execute("echo ready", { credentials: ["selected"], signal: abort.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(events, ["policy", "provision", "resolve:selected"]);
  assert.equal(runs.length, 0);
});

test("multiple single-use grants are rejected before any grant is committed", async () => {
  const events: string[] = [];
  const credentials = [
    credential(events, "standing"),
    credential(events, "once-a", { singleUse: true }),
    credential(events, "once-b", { singleUse: true }),
  ];
  const { ctx, runs } = context(events, credentials);
  await assert.rejects(
    ctx.execute("echo ready", { credentials: credentials.map((entry) => entry.handle) }),
    /at most one single-use/,
  );
  assert.deepEqual(events, ["policy", "provision", "resolve:standing", "resolve:once-a", "resolve:once-b"]);
  assert.equal(runs.length, 0);
});

test("single-use consumption follows all standing grant revalidation regardless of request order", async () => {
  const events: string[] = [];
  const credentials = [
    credential(events, "once", { singleUse: true }),
    credential(events, "standing-a"),
    credential(events, "standing-b"),
  ];
  const { ctx } = context(events, credentials);
  await ctx.execute("echo ready", { credentials: credentials.map((entry) => entry.handle) });
  assert.deepEqual(events, [
    "policy",
    "provision",
    "resolve:once",
    "resolve:standing-a",
    "resolve:standing-b",
    "commit:standing-a",
    "commit:standing-b",
    "commit:once",
    "run",
  ]);
});

test("failed standing revalidation preserves the single-use grant and prevents execution", async () => {
  const events: string[] = [];
  const credentials = [
    credential(events, "once", { singleUse: true }),
    credential(events, "revoked", {
      async commit() {
        events.push("revalidate:revoked");
        throw new Error("standing grant revoked");
      },
    }),
  ];
  const { ctx, runs } = context(events, credentials);
  await assert.rejects(ctx.execute("echo ready", { credentials: ["once", "revoked"] }), /standing grant revoked/);
  assert.deepEqual(events, ["policy", "provision", "resolve:once", "resolve:revoked", "revalidate:revoked"]);
  assert.equal(runs.length, 0);
});

test("newly available handles are resolved from the current catalog and revocation fails closed", async () => {
  const events: string[] = [];
  let available: CommandCredential[] = [];
  const { ctx, runs } = context(events, [], { resolveCommandCredentials: async () => available });
  await ctx.execute("true");
  available = [credential(events, "new"), credential(events, "unselected")];
  await ctx.execute("true", { credentials: ["new"] });
  assert.equal(events.filter((event) => event === "resolve:new").length, 1);
  assert.ok(!events.includes("resolve:unselected"));
  available = [];
  await assert.rejects(ctx.execute("true", { credentials: ["new"] }), /not available/);
  assert.equal(runs.length, 2);
});

function scratchContext(events: string[], extra: Partial<ToolContextDeps> = {}) {
  const commands: Array<[string, string, Record<string, string> | undefined]> = [];
  const sandbox = {
    async run(target: SandboxHandle, command: string) {
      commands.push([target.id, command, target.env]);
      return { code: 0, stdout: "ok", stderr: "", timedOut: false };
    },
  } as unknown as Sandbox;
  const { ctx } = context(
    events,
    [
      {
        ...credential(events, "granted", { env: [{ key: "GRANTED_TOKEN", value: "granted-secret" }] }),
        scratchOnly: true,
      },
      {
        ...credential(events, "brokered", { env: [{ key: "AGENT_CREDENTIAL_TOKEN", value: "room-capability" }] }),
        scratchOnly: false,
      },
    ],
    {
      sandbox,
      sandboxResources: {} as ToolContextDeps["sandboxResources"],
      async provisionResource() {
        events.push("resource");
        return { id: "room-resource", rootDir: "/room" };
      },
      async provisionScratch() {
        events.push("scratch");
        return { id: "scratch", rootDir: "/scratch", env: { AGENT_API_TOKEN: "turn-capability" } };
      },
      ...extra,
    },
  );
  return { ctx, commands };
}

test("background jobs with private credentials start on their own job computer", async () => {
  const events: string[] = [];
  const started: Array<[string, string, Record<string, string> | undefined]> = [];
  const broker = {
    async start(
      target: SandboxHandle,
      command: string,
      _purpose: string,
      _ttl: number,
      credentials?: { env?: Record<string, string> },
    ) {
      started.push([target.id, command, credentials?.env]);
      return { processId: "p1", output: "", cursor: 0, status: { state: "running" }, reattached: false };
    },
  } as unknown as ToolContextDeps["backgroundBroker"];
  const without = scratchContext(events, { backgroundBroker: broker });
  await assert.rejects(
    without.ctx.backgroundStart("sync", { purpose: "Sync", credentials: ["granted"] }),
    /cannot use granted; run the command in the foreground/,
  );
  assert.ok(!events.some((event) => event.startsWith("resolve")));
  const { ctx } = scratchContext(events, {
    backgroundBroker: broker,
    async provisionJobComputer() {
      events.push("job-computer");
      return { id: "job-box", rootDir: "/job", resourceId: "job-box" };
    },
  });
  const job = await ctx.backgroundStart("sync", { purpose: "Sync", sandboxId: "box-a", credentials: ["granted"] });
  assert.equal(job.jobComputer, true);
  const plain = await ctx.backgroundStart("poll", { purpose: "Poll", credentials: ["brokered"] });
  assert.equal(plain.jobComputer, undefined);
  assert.deepEqual(started, [
    ["job-box", "sync", { GRANTED_TOKEN: "granted-secret" }],
    ["credential-preparation", "poll", { AGENT_CREDENTIAL_TOKEN: "room-capability" }],
  ]);
  assert.ok(!events.includes("scratch") && !events.includes("resource"));
});

test("replay returns cached masked bytes without resolving a consumed single-use credential", async () => {
  let stored: string | undefined;
  let available = true;
  let resolutions = 0;
  const events: string[] = [];
  const extra: Partial<ToolContextDeps> = {
    runId: "once-replay",
    attempt: 1,
    ledger: {
      begin: async () => (stored === undefined ? { cached: false } : { cached: true, output: stored }),
      record: async (_run, _attempt, _index, output) => {
        stored = output;
      },
    } as ToolContextDeps["ledger"],
    resolveCommandCredentials: async () => {
      resolutions++;
      return available
        ? [
            {
              handle: "single",
              resolve: async () => ({
                env: [{ key: "TOKEN", value: "synthetic-secret" }],
                singleUse: true,
                commit: async () => {
                  available = false;
                },
              }),
            },
          ]
        : [];
    },
    sandbox: {
      run: async () => ({ stdout: "value=synthetic-secret", stderr: "", code: 0, timedOut: false }),
    } as unknown as Sandbox,
  };
  const first = await context(events, [], extra).ctx.execute("print token", { credentials: ["single"] });
  assert.equal(first.stdout, "value=<redacted:credential>");
  assert.ok(!stored?.includes("synthetic-secret"));
  events.length = 0;
  const replay = await context(events, [], extra).ctx.execute("print token", { credentials: ["single"] });
  assert.deepEqual(replay, first);
  assert.equal(resolutions, 1);
  assert.deepEqual(events, []);
});

test("the model and transcript see when a command moved to the scratch computer", async () => {
  const entries: Array<Record<string, unknown>> = [];
  let available = true;
  const { ctx } = scratchContext([], {
    async provisionScratch() {
      if (!available) throw new Error("provider unavailable");
      return { id: "scratch", rootDir: "/scratch" };
    },
  });
  const execute = createAgentTools(
    createTurnToolState({
      current: ctx,
      emit: (entry) =>
        void entries.push({ ...(entry.body as Record<string, unknown>), ...(entry.isError ? { isError: true } : {}) }),
      scopeLabel: scopeId("channel", "room"),
    }),
  )[0]!;
  const run = (params: Record<string, unknown>) =>
    (execute.execute as unknown as (id: string, p: unknown) => Promise<{ content: Array<{ text: string }> }>)("call", {
      purpose: "Check login",
      command: "whoami",
      ...params,
    });
  await run({ credentials: ["granted"] });
  assert.equal(entries.at(-1)?.scope, "scratch");
  await run({ credentials: ["brokered"] });
  assert.equal(entries.at(-1)?.scope, "scoped");
  available = false;
  await assert.rejects(run({ credentials: ["granted"] }), /provider unavailable/);
  assert.equal(entries.at(-1)?.isError, true);
});

const healthy = { machine: "healthy", listed: "warm", provisioned: true, guestResponsive: true };

function computerStatusProbeCtxFor(sandbox: Partial<Sandbox>, provision: ToolContextDeps["provision"]) {
  const scope = scopeId("channel", "C1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  return createToolContext({
    sandbox: { profile: { backend: "sprites" }, ...sandbox } as unknown as Sandbox,
    provision,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
}

test("computerStatus reports the guest as answering only when a command survives the real provision path", async () => {
  const ctx = computerStatusProbeCtxFor(
    {
      computerStatus: async () => healthy,
      run: async () => ({ stdout: "", stderr: "", code: 0, timedOut: false }),
    },
    async () => handle,
  );
  assert.deepEqual(await ctx.computerStatus(), healthy);
});

test("a provision failure turns a healthy-looking machine into NOT answering and names the cause", async () => {
  const ctx = computerStatusProbeCtxFor({ computerStatus: async () => healthy }, async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("New streams cannot be created after receiving a GOAWAY"), {
        code: "ERR_HTTP2_GOAWAY_SESSION",
      }),
    });
  });
  const status = await ctx.computerStatus();
  assert.equal(status.guestResponsive, false);
  assert.equal(status.machine, "healthy");
  assert.match(status.probeError ?? "", /fetch failed <- Error ERR_HTTP2_GOAWAY_SESSION: New streams/);
});

test("a command that exits non-zero on the provisioned box is NOT answering without a probe error", async () => {
  const ctx = computerStatusProbeCtxFor(
    {
      computerStatus: async () => healthy,
      run: async () => ({ stdout: "", stderr: "", code: 127, timedOut: false }),
    },
    async () => handle,
  );
  const status = await ctx.computerStatus();
  assert.equal(status.guestResponsive, false);
  assert.equal(status.probeError, undefined);
});

test("computerStatus never provisions when the backend reports no machine", async () => {
  let provisions = 0;
  const none = { machine: "no sandbox provisioned yet", provisioned: false, guestResponsive: false };
  const ctx = computerStatusProbeCtxFor({ computerStatus: async () => none }, async () => {
    provisions += 1;
    return handle;
  });
  assert.deepEqual(await ctx.computerStatus(), none);
  assert.equal(provisions, 0, "a status check must not cold-start a box");
});

test("a probe that hangs on the real exec path reports NOT answering within the probe bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ctx = computerStatusProbeCtxFor(
    {
      computerStatus: async () => healthy,
      run: () => new Promise(() => {}),
    },
    async () => handle,
  );
  const pending = ctx.computerStatus();
  await setImmediate();
  t.mock.timers.tick(20_000);
  const status = await pending;
  assert.equal(status.guestResponsive, false);
  assert.match(status.probeError ?? "", /timed out/);
});

test("status for an explicit sandbox probes its exec path instead of trusting the provider", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const scope = scopeId("channel", "C1");
  const layers: WorkspaceLayer[] = [{ scopeId: scope, mountPath: "", mode: "rw" }];
  const access = { resource: { id: "sb1", ownerScopeId: scope }, crossScope: false } as never;
  const ctx = createToolContext({
    sandbox: {
      profile: { backend: "sprites" },
      run: () => new Promise(() => {}),
    } as unknown as Sandbox,
    provision: async () => handle,
    provisionResource: async () => handle,
    accessSandboxResource: async () => access,
    sandboxResources: { status: async () => healthy } as never,
    layers,
    commandPolicy: () => ({ mode: "denylist", rules: [] }),
    authorizeCommand: () => false,
    grantedHandles: [],
    workspace: {} as never,
    deploy: {} as never,
    acl: {} as never,
    createdBy: "U1",
  });
  const pending = ctx.computerStatus("sb1");
  await setImmediate();
  t.mock.timers.tick(20_000);
  const status = await pending;
  assert.equal(status.guestResponsive, false);
  assert.match(status.probeError ?? "", /timed out/);
});
