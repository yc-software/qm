import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { createToolContext, NeedsApproval, type ToolContextDeps } from "../src/tools/primitives.ts";
import { intersectEgressPolicies } from "../src/resolution/egress-policy.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";

function fixture(
  source = "group:project",
  target = "personal:alice",
  authority = true,
  toolDeps: Partial<ToolContextDeps> = {},
  liveAdminTurn = false,
) {
  const state = {
    open: true,
    admin: liveAdminTurn,
    member: true,
    allowed: true,
    cutoverMode: "legacy",
    liveJobs: [] as Array<{ sandboxId: string; scopeId: string }>,
    targetPolicy: { mode: "denylist", rules: [] } as import("../src/types.ts").CommandPolicy,
    targetEgress: { allowedHosts: [], deniedHosts: [] } as import("../src/types.ts").EgressPolicy,
    sourcePolicy: { mode: "denylist", rules: [] } as import("../src/types.ts").CommandPolicy,
    provisionGate: null as Promise<void> | null,
  };
  const provisions: unknown[][] = [];
  const writes: unknown[] = [];
  const runs: SandboxHandle[] = [];
  const commands: string[] = [];
  const released: unknown[][] = [];
  const credentialOwners: string[] = [];
  const restored: Uint8Array[] = [];
  const starts: SandboxHandle[] = [];
  const resource = { id: "personal-box", ownerScopeId: target };
  const commandUses = new Map<string, number>();
  const approvalCalls: unknown[][] = [];
  const egressClaims: unknown[] = [];
  const config = {
    resolveSharingPostureDurable: async () => (state.open ? "open" : "isolated"),
    refreshSecurity: async () => {},
    getCommandPolicy: () => state.targetPolicy,
    getEgress: () => state.targetEgress,
  };
  const sandbox = {
    provision: async (...args: unknown[]) => {
      provisions.push(args);
      if (state.provisionGate) await state.provisionGate;
      return {
        id: "machine",
        resourceId: resource.id,
        scopeId: target,
        rootDir: "/workspace",
        env: (args[1] as { env?: Record<string, string> }).env,
      };
    },
    run: async (handle: SandboxHandle, command: string) => {
      runs.push(handle);
      commands.push(command);
      return { stdout: "existing work", stderr: "", code: 0, timedOut: false };
    },
    removeDir: async (...args: unknown[]) => {
      writes.push(args);
    },
    listDir: async () => [],
    teardown: async (...args: unknown[]) => {
      released.push(args);
    },
    writeFileBytes: async (_handle: unknown, _path: string, bytes: Uint8Array) => {
      restored.push(bytes);
    },
  };
  const roomSkill = {
    skill: {
      id: "room-tool",
      scopeId: source,
      manifest: {
        name: "room-tool",
        description: "room helper",
        requiredCapabilities: [],
        body: "synthetic-room-skill: run scripts/run.js",
        files: [{ path: "scripts/run.js", content: "synthetic-room-skill-file" }],
      },
      signature: "",
      status: "published",
      createdBy: "bob",
      version: 1,
      grantedCapabilities: [],
      approvals: [],
    },
    shadowed: [],
  };
  const resources = {
    get: async () => resource,
    access: async () => {
      if (!state.allowed) throw new Error("permission revoked");
      return resource;
    },
    list: async () => ({ sandboxes: [resource], defaultSandboxId: null }),
    status: async () => ({ machine: "machine" }),
    restart: async () => {},
    retire: async () => {},
  };
  const turn = createTurnSandboxes({
    deps: {
      sandbox,
      sandboxResources: resources,
      processes: { listLive: async () => state.liveJobs },
      deviceFlowCutover: {
        listServices: async () => ["custom-login"],
        resolvePolicy: async () => ({ mode: state.cutoverMode }),
        residentResetGeneration: async () => null,
      },
      keychain: {
        listByOwner: async () => [
          { kind: "file", service: "custom-login", origin: "manual", targets: [".custom-login/token"] },
        ],
        materializeOwnFiles: async (owner: string) => {
          credentialOwners.push(owner);
          return [
            {
              service: "custom-login",
              origin: "manual",
              files: [
                { path: ".custom-login/token", contentBase64: Buffer.from("synthetic-own-file").toString("base64") },
              ],
            },
          ];
        },
      },
      config,
      admin: { adminStatusOf: async () => ({ isAdmin: state.admin }) },
      isCurrentSharedScopeMember: async () => state.member,
    },
    actor: { id: "alice", type: "internal" },
    input: { origin: { kind: "human" } },
    session: { id: "session" },
    resolution: {
      egress: { allowedHosts: [], deniedHosts: ["source-denied.test"] },
      layers: [
        { scopeId: "org:test", mode: "ro", mountPath: "global" },
        { scopeId: "team:private", mode: "ro", mountPath: "private" },
        { scopeId: source, mode: "rw", mountPath: "" },
      ],
    },
    scopeId: source,
    memoryScopeId: source,
    openResourceAccess: authority,
    liveAdminTurn,
    credentialServices: [],
    credentialTools: [],
    quarantinedServices: [],
    cutoverModeOf: () => "legacy",
    egressTokenForTurn: "synthetic-source-egress",
    egressTokenForPolicy: async (policy: unknown) => {
      egressClaims.push(policy);
      return "synthetic-narrow-egress";
    },
    connectorEnv: { AGENT_API_TOKEN: "synthetic-room-capability", SHARED_SECRET: "synthetic-room-secret" },
    credentialCutoverServices: [],
    ownerAuthAvailable: false,
    turnSessionDir: "turn/session",
    turnFilesDir: "turn/session/fire",
    visibleSkills: [roomSkill],
    visibleSkillsForTurn: async () => [roomSkill],
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  const tools = createToolContext({
    sandbox,
    sandboxResources: resources,
    config,
    provisionResource: turn.provisionResource,
    accessSandboxResource: turn.accessResource,
    provision: turn.provision,
    useSkill: turn.useSkill,
    layers: [{ scopeId: source, mode: "rw", mountPath: "" }],
    commandPolicy: () => state.sourcePolicy,
    authorizeCommand: (_command: string, key = _command, exact?: boolean) => {
      approvalCalls.push([key, exact]);
      const uses = commandUses.get(key) ?? 0;
      if (uses <= 0) return false;
      commandUses.set(key, uses - 1);
      return true;
    },
    grantedHandles: [],
    commandCredentials: [
      { handle: "room-credential", env: [{ key: "ROOM_SECRET", value: "synthetic-room-credential" }] },
    ],
    backgroundBroker: {
      start: async (handle: SandboxHandle) => {
        starts.push(handle);
        return { processId: "job" };
      },
    },
    workspace: {},
    deploy: {},
    acl: {},
    createdBy: "alice",
    ...toolDeps,
  } as unknown as ToolContextDeps);
  return {
    turn,
    tools,
    provisions,
    writes,
    runs,
    starts,
    credentialOwners,
    restored,
    egressClaims,
    approvalCalls,
    released,
    commands,
    approve: (key: string, mode: "once" | "session" | "always" = "once") =>
      commandUses.set(key, (commandUses.get(key) ?? 0) + (mode === "once" ? 1 : Infinity)),
    state,
  };
}

test("Open shared requests execute on the owner's personal machine without moving room credentials or files", async () => {
  const f = fixture();
  assert.equal((await f.tools.execute("pwd", { sandboxId: "personal-box" })).stdout, "existing work");
  assert.equal(f.provisions.length, 1);
  assert.equal(JSON.stringify(f.provisions).includes("synthetic-room"), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.credentialOwners, ["alice"]);
  assert.equal(f.runs.at(-1)?.env?.OWN_SECRET, undefined);
  assert.ok(f.restored.some((bytes) => Buffer.from(bytes).includes("synthetic-own-file")));
  assert.equal(JSON.stringify(f.provisions).includes("team:private"), false);
  const skill = await f.tools.skill("room-tool", { sandboxId: "personal-box" });
  assert.match(skill.content ?? "", /synthetic-room-skill/);
  assert.equal(skill.dir, undefined);
  await f.turn.reclaimBox();
  assert.deepEqual(f.writes, []);
});

test("Open cross-scope cached handles recheck membership, posture, and target authorization", async () => {
  for (const revoke of ["revoke", "isolate", "deny"] as const) {
    const f = fixture();
    await f.turn.provisionResource("personal-box");
    if (revoke === "revoke") f.state.member = false;
    else if (revoke === "isolate") f.state.open = false;
    else f.state.allowed = false;
    await assert.rejects(f.turn.provisionResource("personal-box"), /authorized|permission/);
  }
});

test("a command waiting on another provision rechecks the target policy before continuing", async () => {
  const f = fixture();
  let release!: () => void;
  f.state.provisionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.turn.provisionResource("personal-box");
  while (f.provisions.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const access = await f.turn.accessResource("personal-box");
  const second = f.turn.provisionResource(access, (current) => {
    if (current.commandPolicy?.rules.some((rule) => rule.decision === "deny")) throw new Error("policy changed");
  });
  await new Promise((resolve) => setImmediate(resolve));
  f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "blocked", decision: "deny" }] };
  release();
  await first;
  await assert.rejects(second, /policy changed/);
});

test("a one-shot command approval is consumed once after a pending provision settles", async () => {
  const f = fixture();
  f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] };
  let approvalKey = "";
  await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), (error: unknown) => {
    assert.ok(error instanceof NeedsApproval);
    approvalKey = error.approvalKey!;
    return true;
  });
  f.approve(approvalKey);
  let release!: () => void;
  f.state.provisionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = f.turn.provisionResource("personal-box");
  while (f.provisions.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const execute = f.tools.execute("protected", { sandboxId: "personal-box" });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await first;
  assert.equal((await execute).stdout, "existing work");
  await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), NeedsApproval);
});

test("Open continuity works from a DM into a currently joined shared scope, not another person's computer", async () => {
  await fixture("personal:alice", "group:project").turn.provisionResource("personal-box");
  await assert.rejects(fixture("group:project", "personal:bob").turn.provisionResource("personal-box"), /authorized/);
});

test("Open continuity applies consistently to inventory and explicit management", async () => {
  const f = fixture();
  const listed = (await f.tools.sandboxResources!("list")) as { sandboxes: unknown[] };
  assert.equal(listed.sandboxes.length, 1);
  await f.tools.computerStatus("personal-box");
  await f.tools.restartComputer("personal-box");
  await f.tools.sandboxResources!("retire", { sandboxId: "personal-box" });
  f.state.open = false;
  assert.equal(((await f.tools.sandboxResources!("list")) as { sandboxes: unknown[] }).sandboxes.length, 0);
  await assert.rejects(f.tools.computerStatus("personal-box"), /authorized/);
});

test("Open personal credentials never flow into another shared computer", async () => {
  const f = fixture("personal:alice", "group:project");
  await f.tools.execute("pwd", { sandboxId: "personal-box" });
  assert.equal(JSON.stringify(f.provisions).includes("synthetic-own"), false);
  assert.equal(JSON.stringify(f.provisions).includes("synthetic-room"), false);
  assert.deepEqual(f.credentialOwners, []);
  assert.deepEqual(f.restored, []);
});

test("background starts use the authorized personal target and recheck revocation", async () => {
  const f = fixture();
  await f.tools.backgroundStart("node work.js", { sandboxId: "personal-box" });
  assert.equal(f.starts[0]?.scopeId, "personal:alice");
  assert.equal(f.starts[0]?.env, undefined);
  f.state.member = false;
  await assert.rejects(f.tools.backgroundStart("node work.js", { sandboxId: "personal-box" }), /authorized/);
});

test("untrusted background authority and copying room command credentials are refused", async () => {
  await assert.rejects(
    fixture("group:project", "personal:alice", false).turn.provisionResource("personal-box"),
    /authorized/,
  );
  const f = fixture();
  await assert.rejects(
    f.tools.execute("pwd", { sandboxId: "personal-box", credentials: ["room-credential"] }),
    /cannot be copied/,
  );
  assert.deepEqual(f.provisions, []);
});

test("target command denials and approvals apply before either execution path can provision", async () => {
  for (const decision of ["deny", "require_approval"] as const) {
    const f = fixture();
    f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "blocked", decision }] };
    await assert.rejects(f.tools.execute("blocked", { sandboxId: "personal-box" }));
    await assert.rejects(f.tools.backgroundStart("blocked", { sandboxId: "personal-box" }));
    assert.deepEqual(f.provisions, []);
  }
});

test("cross-target egress policies narrow both provider policy and minted proxy capability", async () => {
  const f = fixture();
  f.state.targetEgress = { allowedHosts: ["api.example.test"], deniedHosts: ["target-denied.test"] };
  await f.turn.provisionResource("personal-box");
  const policy = { allowedHosts: ["api.example.test"], deniedHosts: ["source-denied.test", "target-denied.test"] };
  assert.deepEqual(f.egressClaims, [policy]);
  const opts = f.provisions[0]![1] as { egress: unknown; egressToken: string };
  assert.deepEqual(opts.egress, policy);
  assert.equal(opts.egressToken, "synthetic-narrow-egress");
  f.state.targetEgress = { allowedHosts: ["new.example.test"], deniedHosts: [] };
  await f.turn.provisionResource("personal-box");
  assert.equal(f.egressClaims.length, 2);
  assert.equal(f.provisions.length, 2);
  assert.deepEqual((f.provisions[1]![1] as { egress: unknown }).egress, {
    allowedHosts: ["new.example.test"],
    deniedHosts: ["source-denied.test"],
  });
});

test("cached personal access reapplies device-flow quarantine without injecting environment credentials", async () => {
  const f = fixture();
  const first = await f.turn.provisionResource("personal-box");
  const firstRestores = f.restored.length;
  f.state.cutoverMode = "ephemeral_only";
  const second = await f.turn.provisionResource("personal-box");
  assert.equal(second, first);
  assert.ok(f.commands.some((command) => command.includes("rm -rf -- '.custom-login/token'")));
  assert.equal(f.restored.length, firstRestores);
  assert.equal(second.env, undefined);
});

test("cross-scope teardown preserves live jobs regardless of which conversation started them", async () => {
  for (const jobScope of ["personal:alice", "group:project", "group:other"]) {
    const f = fixture();
    f.state.liveJobs = [{ sandboxId: "personal-box", scopeId: jobScope }];
    await f.turn.provisionResource("personal-box");
    await f.turn.reclaimBox();
    assert.deepEqual(f.released[0]![1], { keepWarm: true });
  }
});

test("egress intersection narrows host suffixes and refuses disjoint allowlists", () => {
  assert.deepEqual(
    intersectEgressPolicies(
      { allowedHosts: ["example.test"], deniedHosts: ["deny.test"] },
      { allowedHosts: ["api.example.test"], deniedHosts: ["other.test"] },
    ),
    { allowedHosts: ["api.example.test"], deniedHosts: ["deny.test", "other.test"] },
  );
  assert.throws(
    () => intersectEgressPolicies({ allowedHosts: ["a.test"] }, { allowedHosts: ["b.test"] }),
    /no overlap/,
  );
});

test("two requiring policies produce one target-qualified one-shot approval", async () => {
  for (const method of ["execute", "backgroundStart"] as const) {
    const f = fixture();
    f.state.sourcePolicy = { mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] };
    f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "command", decision: "require_approval" }] };
    let approvalKey = "";
    await assert.rejects(f.tools[method]("protected command", { sandboxId: "personal-box" }), (err: unknown) => {
      assert.ok(err instanceof NeedsApproval);
      assert.deepEqual(err.grantModes, { session: false, always: false });
      approvalKey = err.approvalKey!;
      assert.deepEqual(JSON.parse(approvalKey.slice("sandbox:".length)), ["personal:alice", "protected", "command"]);
      return true;
    });
    assert.deepEqual(f.approvalCalls, [[approvalKey, true]]);
    f.approve(approvalKey);
    await f.tools[method]("protected command", { sandboxId: "personal-box" });
    await assert.rejects(f.tools[method]("protected command", { sandboxId: "personal-box" }), NeedsApproval);
  }
});

test("target denial wins before a source one-shot approval is consumed", async () => {
  const f = fixture();
  f.state.sourcePolicy = { mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] };
  f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "protected", decision: "deny" }] };
  f.approve("protected", "once");
  await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), /denied/);
  assert.deepEqual(f.approvalCalls, []);
});

test("cross-scope credential handles are refused without resolving or consuming grants", async () => {
  const events: string[] = [];
  const f = fixture("group:project", "personal:alice", true, {
    commandCredentials: [
      {
        handle: "lazy",
        resolve: async () => {
          events.push("resolve");
          return {
            env: [{ key: "TOKEN", value: "synthetic-command-secret" }],
            singleUse: true,
            commit: async () => {
              events.push("commit");
            },
          };
        },
      },
    ],
  });
  f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] };
  await assert.rejects(
    f.tools.execute("protected", { sandboxId: "personal-box", credentials: ["lazy"] }),
    /cannot be copied/,
  );
  assert.deepEqual(events, []);
  assert.deepEqual(f.approvalCalls, []);
  assert.deepEqual(f.provisions, []);
});

test("credential-specific source policy still restricts an explicit cross-scope target", async () => {
  const calls: unknown[] = [];
  const f = fixture("group:project", "personal:alice", true, {
    commandPolicyForCredentials: (handles, ownerAuth) => {
      calls.push([handles, ownerAuth]);
      return { mode: "denylist", rules: [{ pattern: "protected", decision: "deny" }] };
    },
  });
  await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), /denied/);
  assert.deepEqual(calls, [[[], false]]);
  assert.deepEqual(f.provisions, []);
});

test("credential-specific source approval intersects target policy without consuming approval on target denial", async () => {
  const f = fixture("group:project", "personal:alice", true, {
    commandPolicyForCredentials: () => ({
      mode: "denylist",
      rules: [{ pattern: "protected", decision: "require_approval" }],
    }),
  });
  f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "command", decision: "deny" }] };
  f.approve("protected");
  await assert.rejects(f.tools.execute("protected command", { sandboxId: "personal-box" }), /denied/);
  assert.deepEqual(f.approvalCalls, []);
  f.state.targetPolicy = { mode: "denylist", rules: [{ pattern: "command", decision: "require_approval" }] };
  let approvalKey = "";
  await assert.rejects(f.tools.execute("protected command", { sandboxId: "personal-box" }), (error: unknown) => {
    assert.ok(error instanceof NeedsApproval);
    assert.deepEqual(error.grantModes, { session: false, always: false });
    approvalKey = error.approvalKey!;
    assert.deepEqual(JSON.parse(approvalKey.slice("sandbox:".length)), ["personal:alice", "protected", "command"]);
    return true;
  });
  f.approve(approvalKey);
  await f.tools.execute("protected command", { sandboxId: "personal-box" });
  await assert.rejects(f.tools.execute("protected command", { sandboxId: "personal-box" }), NeedsApproval);
});

test("same-scope explicit execution prepares credentials only after provisioning and wraps the effective env", async () => {
  const events: string[] = [];
  const f: ReturnType<typeof fixture> = fixture("group:project", "group:project", true, {
    commandPolicyForCredentials: (handles, ownerAuth) => {
      assert.deepEqual(handles, ["lazy"]);
      assert.equal(ownerAuth, false);
      events.push("policy");
      return { mode: "denylist", rules: [] };
    },
    commandCredentials: [
      {
        handle: "lazy",
        resolve: async () => {
          assert.equal(f.provisions.length, 1);
          events.push("resolve");
          return {
            env: [{ key: "TOKEN", value: "synthetic-command-secret" }],
            singleUse: true,
            commit: async () => {
              events.push("commit");
            },
          };
        },
      },
    ],
    scopedCommand: (command, env) => {
      events.push("wrap");
      assert.equal(env?.TOKEN, "synthetic-command-secret");
      assert.equal(env?.SHARED_SECRET, "synthetic-room-secret");
      return command;
    },
  });
  await f.tools.execute("pwd", { sandboxId: "personal-box", credentials: ["lazy"] });
  assert.deepEqual(events, ["policy", "resolve", "commit", "wrap"]);
  assert.equal(f.runs.at(-1)?.env?.TOKEN, "synthetic-command-secret");
});

for (const source of ["personal:alice", "group:project"]) {
  test(`live admin from ${source} maintains a nonmember's computer without moving credentials`, async () => {
    const f = fixture(source, "personal:bob", true, {}, true);
    f.state.member = false;
    if (source === "personal:alice") f.state.open = false;
    assert.equal(((await f.tools.sandboxResources!("list")) as { sandboxes: unknown[] }).sandboxes.length, 1);
    await f.tools.computerStatus("personal-box");
    await f.tools.restartComputer("personal-box");
    await f.tools.execute("repair", { sandboxId: "personal-box" });
    assert.deepEqual(f.commands, ["repair"]);
    assert.deepEqual(f.credentialOwners, []);
    assert.deepEqual(f.restored, []);
    assert.equal(JSON.stringify(f.provisions).includes("synthetic-room"), false);
    if (source === "group:project") {
      f.state.open = false;
      await assert.rejects(f.tools.execute("after isolation", { sandboxId: "personal-box" }), /authorized/);
      f.state.open = true;
    }
    f.state.admin = false;
    await assert.rejects(f.tools.execute("repair again", { sandboxId: "personal-box" }), /authorized/);
    await assert.rejects(f.tools.computerStatus("personal-box"), /authorized/);
    assert.deepEqual(f.commands, ["repair"]);
  });
}

test("admin membership alone cannot elevate autonomous or isolated shared sandbox access", async () => {
  const automated = fixture("personal:alice", "personal:bob", false);
  automated.state.admin = true;
  await assert.rejects(automated.tools.computerStatus("personal-box"), /authorized/);
  const isolated = fixture("group:project", "personal:bob", true, {}, true);
  isolated.state.open = false;
  await assert.rejects(isolated.tools.execute("repair", { sandboxId: "personal-box" }), /authorized/);
});
