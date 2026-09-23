import assert from "node:assert/strict";
import test from "node:test";
import { createToolContext, type CommandCredential, type ToolContextDeps } from "../src/tools/primitives.ts";
import type { ExecOptions, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId } from "../src/types.ts";

const handle: SandboxHandle = { id: "credential-preparation", rootDir: "/workspace", executionMode: "isolated" };
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

test("credential preparation uses the selected resource rather than the scope default", async () => {
  const events: string[] = [];
  const selected: SandboxHandle = { id: "selected-box", resourceId: "selected", rootDir: "/workspace" };
  const observed: SandboxHandle[] = [];
  const { ctx } = context(events, [], {
    sandboxResources: {
      async access(actorId, id) {
        assert.equal(actorId, "credential-tester");
        assert.equal(id, "selected");
        return { ownerScopeId: "personal:credential-tester" };
      },
    } as ToolContextDeps["sandboxResources"],
    async provisionResource(id) {
      assert.equal(id, "selected");
      events.push("provision:selected");
      return selected;
    },
    async getCommandCredentials(requested, target) {
      assert.deepEqual(requested, ["selected-credential"]);
      observed.push(target);
      events.push("catalog");
      return [credential(events, "selected-credential")];
    },
  });
  await ctx.execute("true", { credentials: ["selected-credential"] });
  await ctx.execute("true", { sandboxId: "selected", credentials: ["selected-credential"] });
  assert.deepEqual(observed, [handle, selected]);
  assert.deepEqual(events, [
    "policy",
    "provision",
    "catalog",
    "resolve:selected-credential",
    "commit:selected-credential",
    "run",
    "policy",
    "provision:selected",
    "catalog",
    "resolve:selected-credential",
    "commit:selected-credential",
    "run",
  ]);
});

test("denied commands do not prepare a target's credential catalog", async () => {
  const events: string[] = [];
  const { ctx } = context(events, [], {
    commandPolicy: () => ({ mode: "denylist", rules: [{ pattern: "echo", decision: "deny" }] }),
    async getCommandCredentials() {
      assert.fail("denied command reached credential catalog");
    },
  });
  await assert.rejects(ctx.execute("echo denied", { credentials: ["selected"] }), /denied/);
  assert.deepEqual(events, []);
});

for (const executionMode of [undefined, "legacy"] as const) {
  test(`legacy explicit environment credentials preserve handle isolation (${executionMode ?? "missing mode"})`, async () => {
    const events: string[] = [];
    const legacy: SandboxHandle = { id: "legacy", rootDir: "/workspace", executionMode, env: { EXISTING: "kept" } };
    const seen: SandboxHandle[] = [];
    const { ctx } = context(events, [credential(events, "selected", { env: [{ key: "TOKEN", value: "synthetic" }] })], {
      provision: async () => legacy,
      sandbox: {
        async run(target: SandboxHandle, _command: string, options?: ExecOptions) {
          seen.push(target);
          assert.equal(options?.credentials, undefined);
          return { code: 7, stdout: target.env?.TOKEN ?? "ok", stderr: target.env?.TOKEN ?? "", timedOut: false };
        },
      } as Sandbox,
    });
    const result = await ctx.execute("true", { credentials: ["selected"] });
    assert.equal(result.code, 7);
    assert.equal(result.stdout, "<redacted:TOKEN>");
    assert.equal(result.stderr, "<redacted:TOKEN>");
    await ctx.execute("true");
    assert.deepEqual(seen[0]?.env, { EXISTING: "kept", TOKEN: "synthetic" });
    assert.deepEqual(seen[1]?.env, { EXISTING: "kept" });
    assert.deepEqual(legacy.env, { EXISTING: "kept" });
  });
}

test("legacy file credential requests fail before consuming a single-use grant", async () => {
  const events: string[] = [];
  const { ctx, runs } = context(
    events,
    [
      credential(events, "file", {
        files: [{ path: ".config/tool/token", data: Buffer.from("synthetic") }],
        singleUse: true,
      }),
    ],
    { provision: async () => ({ id: "legacy", rootDir: "/workspace" }) },
  );
  await assert.rejects(ctx.execute("true", { credentials: ["file"] }), /file credential requests require an isolated/);
  assert.deepEqual(events, ["policy", "resolve:file"]);
  assert.equal(runs.length, 0);
});
