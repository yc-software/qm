import { test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { createToolContext, NeedsApproval, type ToolContextDeps } from "../src/tools/primitives.ts";
import {
  addCommandApprovalUse,
  consumeCommandApprovalUse,
  type CommandApprovalUses,
} from "../src/policy/command-policy.ts";
import { intersectEgressPolicies } from "../src/resolution/egress-policy.ts";
import type { SandboxHandle } from "../src/sandbox/sandbox.ts";

function fixture(source = "group:project", target = "personal:alice", authority = true) {
  let open = true;
  let member = true;
  let allowed = true;
  const provisions: unknown[][] = [];
  const writes: unknown[] = [];
  const runs: SandboxHandle[] = [];
  const commands: string[] = [];
  const released: unknown[][] = [];
  let ownEnv: Record<string, string> = { OWN_SECRET: "synthetic-own-secret" };
  let cutoverMode = "legacy";
  let liveJobs: Array<{ sandboxId: string; scopeId: string }> = [];
  const credentialOwners: string[] = [];
  const restored: Uint8Array[] = [];
  const starts: SandboxHandle[] = [];
  const resource = { id: "personal-box", ownerScopeId: target };
  let targetPolicy = { mode: "denylist", rules: [] } as import("../src/types.ts").CommandPolicy;
  let targetEgress = { allowedHosts: [], deniedHosts: [] } as import("../src/types.ts").EgressPolicy;
  let sourcePolicy = { mode: "denylist", rules: [] } as import("../src/types.ts").CommandPolicy;
  let targetModes = { session: true, always: true };
  let sourceModes = { session: true, always: true };
  const commandUses = new Map<string, CommandApprovalUses>();
  const approvalCalls: unknown[][] = [];
  const egressClaims: unknown[] = [];
  const config = {
    resolveSharingPostureDurable: async () => (open ? "open" : "isolated"),
    refreshSecurity: async () => {},
    getCommandPolicy: () => targetPolicy,
    getApprovalGrantModesDurable: async (scope: string) => (scope === target ? targetModes : sourceModes),
    getEgress: () => targetEgress,
  };
  const sandbox = {
    provision: async (...args: unknown[]) => {
      provisions.push(args);
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
  const resources = {
    get: async () => resource,
    access: async () => {
      if (!allowed) throw new Error("permission revoked");
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
      processes: { listLive: async () => liveJobs },
      deviceFlowCutover: {
        listServices: async () => ["custom-login"],
        resolvePolicy: async () => ({ mode: cutoverMode }),
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
      isCurrentSharedScopeMember: async () => member,
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
    ownerAuthEnv: { OWN_SECRET: "synthetic-own-secret" },
    ownerEnvForTarget: async () => ownEnv,
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
    visibleSkills: [],
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  const tools = createToolContext({
    sandbox,
    sandboxResources: resources,
    config,
    provisionResource: turn.provisionResource,
    canUseSandboxScope: turn.canUseSandboxScope,
    provision: turn.provision,
    ensureSkillTree: turn.ensureSkillTree,
    layers: [{ scopeId: source, mode: "rw", mountPath: "" }],
    commandPolicy: () => sourcePolicy,
    authorizeCommand: (command: string, key = command, exact?: boolean, modes?: typeof targetModes) => {
      approvalCalls.push([key, exact, modes]);
      return consumeCommandApprovalUse(commandUses, key, modes);
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
    approve: (key: string, mode: "once" | "session" | "always") => addCommandApprovalUse(commandUses, key, mode),
    setSourcePolicy: (policy: typeof sourcePolicy) => {
      sourcePolicy = policy;
    },
    setTargetModes: (modes: typeof targetModes) => {
      targetModes = modes;
    },
    setSourceModes: (modes: typeof sourceModes) => {
      sourceModes = modes;
    },
    released,
    commands,
    revokeOwnEnv: () => {
      ownEnv = {};
    },
    quarantine: () => {
      cutoverMode = "ephemeral_only";
    },
    setLiveJobs: (jobs: typeof liveJobs) => {
      liveJobs = jobs;
    },
    setTargetPolicy: (policy: typeof targetPolicy) => {
      targetPolicy = policy;
    },
    setTargetEgress: (policy: typeof targetEgress) => {
      targetEgress = policy;
    },
    revoke: () => {
      member = false;
    },
    isolate: () => {
      open = false;
    },
    deny: () => {
      allowed = false;
    },
  };
}

test("Open shared requests execute on the owner's personal machine without moving room credentials or files", async () => {
  const f = fixture();
  assert.equal((await f.tools.execute("pwd", { sandboxId: "personal-box" })).stdout, "existing work");
  assert.equal(f.provisions.length, 1);
  assert.equal(JSON.stringify(f.provisions).includes("synthetic-room"), false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.credentialOwners, ["alice"]);
  assert.equal(f.runs.at(-1)?.env?.OWN_SECRET, "synthetic-own-secret");
  assert.ok(f.restored.some((bytes) => Buffer.from(bytes).includes("synthetic-own-file")));
  assert.equal(JSON.stringify(f.provisions).includes("team:private"), false);
  await f.tools.execute("node skills/private-tool/run.js", { sandboxId: "personal-box" });
  await f.turn.reclaimBox();
  assert.deepEqual(f.writes, []);
});

test("Open cross-scope cached handles recheck membership, posture, and target authorization", async () => {
  for (const revoke of ["revoke", "isolate", "deny"] as const) {
    const f = fixture();
    await f.turn.provisionResource("personal-box");
    f[revoke]();
    await assert.rejects(f.turn.provisionResource("personal-box"), /authorized|permission/);
  }
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
  f.isolate();
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
  assert.deepEqual(f.starts[0]?.env, { OWN_SECRET: "synthetic-own-secret" });
  f.revoke();
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
    f.setTargetPolicy({ mode: "denylist", rules: [{ pattern: "blocked", decision }] });
    await assert.rejects(f.tools.execute("blocked", { sandboxId: "personal-box" }));
    await assert.rejects(f.tools.backgroundStart("blocked", { sandboxId: "personal-box" }));
    assert.deepEqual(f.provisions, []);
  }
});

test("cross-target egress policies narrow both provider policy and minted proxy capability", async () => {
  const f = fixture();
  f.setTargetEgress({ allowedHosts: ["api.example.test"], deniedHosts: ["target-denied.test"] });
  await f.turn.provisionResource("personal-box");
  const policy = { allowedHosts: ["api.example.test"], deniedHosts: ["source-denied.test", "target-denied.test"] };
  assert.deepEqual(f.egressClaims, [policy]);
  const opts = f.provisions[0]![1] as { egress: unknown; egressToken: string };
  assert.deepEqual(opts.egress, policy);
  assert.equal(opts.egressToken, "synthetic-narrow-egress");
  f.setTargetEgress({ allowedHosts: ["new.example.test"], deniedHosts: [] });
  await f.turn.provisionResource("personal-box");
  assert.equal(f.egressClaims.length, 2);
});

test("cached personal access refreshes removed env credentials and quarantines manually saved files", async () => {
  const f = fixture();
  await f.turn.provisionResource("personal-box");
  const firstRestores = f.restored.length;
  f.quarantine();
  await f.turn.provisionResource("personal-box");
  assert.ok(f.commands.some((command) => command.includes("rm -rf -- '.custom-login/token'")));
  assert.equal(f.restored.length, firstRestores);
  f.revokeOwnEnv();
  const handle = await f.turn.provisionResource("personal-box");
  assert.deepEqual(handle.env, {});
});

test("cross-scope teardown preserves live jobs regardless of which conversation started them", async () => {
  for (const jobScope of ["personal:alice", "group:project", "group:other"]) {
    const f = fixture();
    f.setLiveJobs([{ sandboxId: "personal-box", scopeId: jobScope }]);
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

test("two requiring policies produce one target-qualified one-shot approval without consuming a source grant", async () => {
  for (const method of ["execute", "backgroundStart"] as const) {
    const f = fixture();
    f.setSourcePolicy({ mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] });
    f.setTargetPolicy({ mode: "denylist", rules: [{ pattern: "command", decision: "require_approval" }] });
    f.setSourceModes({ session: false, always: true });
    f.setTargetModes({ session: true, always: false });
    f.approve("protected", "always");
    let approvalKey = "";
    await assert.rejects(f.tools[method]("protected command", { sandboxId: "personal-box" }), (err: unknown) => {
      assert.ok(err instanceof NeedsApproval);
      assert.deepEqual(err.grantModes, { session: false, always: false });
      approvalKey = err.approvalKey!;
      assert.deepEqual(JSON.parse(approvalKey.slice("sandbox:".length)), ["personal:alice", "protected", "command"]);
      return true;
    });
    assert.equal(f.approvalCalls.length, 1);
    f.approve(approvalKey, "once");
    await f.tools[method]("protected command", { sandboxId: "personal-box" });
    await assert.rejects(f.tools[method]("protected command", { sandboxId: "personal-box" }), NeedsApproval);
  }
});

test("target disables already-issued reusable grants but a fresh once approval still works", async () => {
  for (const mode of ["session", "always"] as const) {
    const f = fixture();
    f.setTargetPolicy({ mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] });
    let key = "";
    await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), (err: unknown) => {
      assert.ok(err instanceof NeedsApproval);
      key = err.approvalKey!;
      return true;
    });
    f.approve(key, mode);
    await f.tools.execute("protected", { sandboxId: "personal-box" });
    f.setTargetModes({ session: false, always: false });
    await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), NeedsApproval);
    f.approve(key, "once");
    await f.tools.execute("protected", { sandboxId: "personal-box" });
    await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), NeedsApproval);
  }
});

test("target denial wins before a source one-shot approval is consumed", async () => {
  const f = fixture();
  f.setSourcePolicy({ mode: "denylist", rules: [{ pattern: "protected", decision: "require_approval" }] });
  f.setTargetPolicy({ mode: "denylist", rules: [{ pattern: "protected", decision: "deny" }] });
  f.approve("protected", "once");
  await assert.rejects(f.tools.execute("protected", { sandboxId: "personal-box" }), /denied/);
  assert.deepEqual(f.approvalCalls, []);
});
