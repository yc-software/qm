import assert from "node:assert/strict";
import test from "node:test";
import { createToolContext, type CommandCredential, type ToolContextDeps } from "../src/tools/primitives.ts";
import type { ExecOptions, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const handle: SandboxHandle = { id: "credential-preparation", rootDir: "/workspace" };
type Materialized = Awaited<ReturnType<CommandCredential["resolve"]>>;

function context(events: string[], credentials: CommandCredential[], extra: Partial<ToolContextDeps> = {}) {
  const runs: Array<ExecOptions | undefined> = [];
  const sandbox = {
    async run(_handle: SandboxHandle, _command: string, options?: ExecOptions) {
      events.push("run");
      runs.push(options);
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
  assert.deepEqual(runs[0]?.credentials, { env: { TOKEN: "synthetic" }, files: [] });
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

for (const conflict of ["environment", "file"] as const) {
  test(`conflicting ${conflict} values fail before every commit and execution`, async () => {
    const events: string[] = [];
    const credentials = ["first", "second"].map((name) =>
      credential(
        events,
        name,
        conflict === "environment"
          ? {
              env: [{ key: "SHARED_TOKEN", value: name }],
            }
          : {
              files: [{ path: ".config/tool/token", data: Buffer.from(name) }],
            },
      ),
    );
    const { ctx, runs } = context(events, credentials);
    await assert.rejects(
      ctx.execute("echo ready", { credentials: credentials.map((entry) => entry.handle) }),
      /conflicting/,
    );
    assert.deepEqual(events, ["policy", "provision", "resolve:first", "resolve:second"]);
    assert.equal(runs.length, 0);
  });
}

test("cancellation during resolution never commits a prepared grant", async () => {
  const events: string[] = [];
  const abort = new AbortController();
  const selected = credential(events, "selected");
  const resolve = selected.resolve;
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
