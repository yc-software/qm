import assert from "node:assert/strict";
import test from "node:test";
import { createToolContext, type CommandCredential, type ToolContextDeps } from "../src/tools/primitives.ts";
import type { ExecOptions, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const handle: SandboxHandle = { id: "credential-preparation", rootDir: "/workspace" };
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
      return handle;
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

test("owner credentials cannot be requested on scoped or scratch workspaces", async () => {
  const events: string[] = [];
  const selected = { ...credential(events, "owner"), scope: "owner" as const };
  const { ctx, runs } = context(events, [selected], { provisionOwnerAuth: async () => handle });
  await assert.rejects(ctx.execute("true", { credentials: ["owner"] }), /requires scope:owner/);
  await assert.rejects(ctx.execute("true", { credentials: ["owner"], scratch: true }), /only on the scoped/);
  assert.deepEqual(events, []);
  await ctx.execute("true", { credentials: ["owner"], ownerAuth: true });
  assert.equal(runs.length, 1);
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
