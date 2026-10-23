import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentCronDigest,
  agentSkillDigest,
  admitAgentOperation,
  filterAgentSkills,
  guardAgentTools,
  type AgentPolicy,
} from "../src/auth/agent-policy.ts";
import { createSkillMethods } from "../src/api/app-skills.ts";
import { surfaceRoutes } from "../src/api/routes/surface.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createSkillBundleStore } from "../src/skills/skill-bundle-store.ts";
import { scopeId } from "../src/types.ts";

const context = { principalId: "owner", threadRef: "dm:owner:policy" };
async function fixture() {
  const store = createSkillStore();
  const skill = await store.create({
    scopeId: scopeId("org", "test"),
    createdBy: "owner",
    manifest: { name: "allowed", description: "task", body: "instructions", requiredCapabilities: [] },
  });
  await store.review(skill.id, "owner", []);
  await store.publish(skill.id);
  return { store, skill: (await store.get(skill.id))!, rows: await store.visibleFor([skill.scopeId], []) };
}
function policy(grants?: { id: string; digest: string }[], admitted = true): AgentPolicy {
  return {
    resolve: async () => ({ subjectId: "one", revision: 1, ...(grants ? { grants } : {}) }),
    admit: async () => admitted,
  };
}

test("unconfigured and unbound policies retain ordinary visibility", async () => {
  const { rows } = await fixture();
  assert.equal(await filterAgentSkills(undefined, context, rows), rows);
  assert.equal(await filterAgentSkills({ resolve: async () => null, admit: async () => false }, context, rows), rows);
  assert.equal(await admitAgentOperation(undefined, context, { kind: "cron" }), true);
  assert.equal(
    await admitAgentOperation({ resolve: async () => null, admit: async () => false }, context, { kind: "turn" }),
    true,
  );
});

test("bound subjects with missing or empty grants see no skills", async () => {
  const { rows } = await fixture();
  assert.deepEqual(await filterAgentSkills(policy(), context, rows), []);
  assert.deepEqual(await filterAgentSkills(policy([]), context, rows), []);
});

test("exact grants subtract and drop shadowed candidates without elevating visibility", async () => {
  const { rows, skill } = await fixture();
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill) }];
  assert.equal(
    (await filterAgentSkills(policy(grants), context, [{ ...rows[0]!, shadowed: [skill] }]))[0]?.shadowed.length,
    0,
  );
  assert.deepEqual(await filterAgentSkills(policy(grants), context, []), []);
  assert.deepEqual(await filterAgentSkills(policy(grants, false), context, rows), []);
  assert.deepEqual(
    await filterAgentSkills(policy(grants), context, [{ skill: { ...skill, status: "archived" }, shadowed: [] }]),
    [],
  );
});

test("changed content, supporting files, executable bit and revision invalidate a grant", async () => {
  const { rows, skill } = await fixture();
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill) }];
  for (const changed of [
    { ...skill, version: skill.version + 1 },
    { ...skill, manifest: { ...skill.manifest, body: "changed" } },
    { ...skill, manifest: { ...skill.manifest, files: [{ path: "run.sh", content: "run", executable: true }] } },
  ])
    assert.deepEqual(await filterAgentSkills(policy(grants), context, [{ ...rows[0]!, skill: changed }]), []);
});

test("pack bundles are bound into the digest and missing or changed bundles deny", async () => {
  const { skill } = await fixture();
  skill.pack = { packId: "pack", commit: "abc", upstreamName: "allowed" };
  const bundles = createSkillBundleStore();
  const bundle = { packId: "pack", commit: "abc", hash: "untrusted", files: [{ path: "shared/run", content: "safe" }] };
  await bundles.put(bundle);
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill, bundle) }];
  const rows = [{ skill, shadowed: [] }];
  assert.equal((await filterAgentSkills(policy(grants), context, rows, bundles)).length, 1);
  assert.equal(
    (await filterAgentSkills(policy(grants), context, [{ ...rows[0]!, screenedBundles: [bundle] }])).length,
    1,
  );
  await bundles.put({ ...bundle, files: [{ path: "shared/run", content: "changed" }] });
  assert.deepEqual(await filterAgentSkills(policy(grants), context, rows, bundles), []);
  assert.deepEqual(await filterAgentSkills(policy(grants), context, rows), []);
});

test("revocation is rechecked and policy failures propagate", async () => {
  const { rows, skill } = await fixture();
  const grants = [{ id: skill.id, digest: agentSkillDigest(skill) }];
  const provider = policy(grants);
  assert.equal((await filterAgentSkills(provider, context, rows)).length, 1);
  grants.length = 0;
  assert.deepEqual(await filterAgentSkills(provider, context, rows), []);
  provider.resolve = async () => {
    throw new Error("offline");
  };
  await assert.rejects(filterAgentSkills(provider, context, rows), /offline/);
  await assert.rejects(admitAgentOperation(provider, context, { kind: "turn" }), /offline/);
});

test("turn and cron admission require explicit policy admission", async () => {
  for (const kind of ["turn", "cron"] as const) {
    assert.equal(await admitAgentOperation(policy([], false), context, { kind }), false);
    assert.equal(await admitAgentOperation(policy([], true), context, { kind }), true);
  }
});

test("guarded tools reauthorize every call and never run a denied operation", async () => {
  let allowed = true;
  let calls = 0;
  let invalidated = 0;
  const provider = policy([]);
  provider.admit = async (_context, _binding, operation) => operation.kind === "tool" && allowed;
  const raw = {
    read: async () => {
      calls++;
      return "data";
    },
    mcpToolDefs: () => [],
  };
  const guarded = guardAgentTools(provider, context, raw, undefined, async () => {
    invalidated++;
  });
  assert.equal(await guarded.read(), "data");
  allowed = false;
  await assert.rejects(guarded.read(), /denied tool/);
  assert.equal(calls, 1);
  assert.equal(invalidated, 1);
  assert.deepEqual(guarded.mcpToolDefs(), []);
  assert.equal(guardAgentTools(undefined, context, raw), raw);
});

test("unbound guarded tools pass through results unchanged", async () => {
  const raw = { soulRead: () => ({ effectiveSoul: "standing", soul: "standing", soulVersion: 2 }) };
  const unbound = guardAgentTools({ resolve: async () => null, admit: async () => false }, context, raw);
  assert.deepEqual(await unbound.soulRead(), raw.soulRead());
  await assert.rejects(Promise.resolve(guardAgentTools(policy([], false), context, raw).soulRead()), /denied/);
});

test("cron admission binds the stored task, destination, schedule and authority", () => {
  const cron = {
    id: "cron",
    owner: "owner",
    ownerScopeId: "personal:owner",
    action: "proposal",
    schedule: { everyMs: 60000 },
    destination: { type: "web", target: "owner" },
  };
  const digest = agentCronDigest(cron as never);
  for (const changed of [
    { ...cron, title: "different instructions" },
    { ...cron, action: "different" },
    { ...cron, owner: "other" },
    { ...cron, schedule: { everyMs: 1000 } },
    { ...cron, destination: { type: "web", target: "other" } },
    { ...cron, loopId: "loop" },
    { ...cron, unattendedGrants: ["send"] },
  ])
    assert.notEqual(agentCronDigest(changed as never), digest);
  assert.equal(agentCronDigest({ ...cron, lastAttemptAt: 999 } as never), digest);
});

test("catalog detail pairs its returned snapshot with the same content digest", async () => {
  const { skill } = await fixture();
  const changed = { ...skill, version: skill.version + 1, manifest: { ...skill.manifest, body: "changed content" } };
  let reads = 0;
  const app = createSkillMethods(
    {
      agentPolicy: { resolve: async () => null, admit: async () => true },
      skills: { get: async () => (++reads === 1 ? skill : changed) },
    } as never,
    { canManageSkill: async () => true } as never,
  );
  let response: { skill: { body: string; version: number; digest: string } } | undefined;
  await surfaceRoutes
    .find((route) => "method" in route && route.method === "GET" && route.path === "/v1/skills/:id")!
    .handle({
      app,
      params: { id: skill.id },
      url: new URL(`http://offline/v1/skills/${skill.id}?principalId=owner`),
      capability: null,
      res: {
        writeHead() {},
        setHeader() {},
        getHeader() {
          return undefined;
        },
        end(body: string) {
          response = JSON.parse(body);
        },
      },
    } as never);
  assert.ok(response);
  assert.equal(response.skill.body, skill.manifest.body);
  assert.equal(response.skill.version, skill.version);
  assert.equal(response.skill.digest, agentSkillDigest(skill));
  assert.equal(reads, 1);
});

test("nested tool namespaces are admitted and rechecked per call", async () => {
  const ran: string[] = [];
  const prepared: string[] = [];
  const raw = {
    subagents: { open: async () => ran.push("subagents.open") },
    admin: { whoami: async () => ran.push("admin.whoami"), nested: { deep: async () => ran.push("deep") } },
  };
  const names: string[] = [];
  const denyAll: AgentPolicy = {
    resolve: async () => ({ subjectId: "one", revision: 1 }),
    admit: async (_context, _binding, operation) => {
      if (operation.kind === "tool") names.push(operation.name);
      return false;
    },
  };
  const guarded = guardAgentTools(denyAll, context, raw, async (name) => {
    prepared.push(name);
  });
  await assert.rejects(Promise.resolve(guarded.subagents.open()), /denied tool/);
  await assert.rejects(Promise.resolve(guarded.admin.whoami()), /denied tool/);
  await assert.rejects(Promise.resolve(guarded.admin.nested.deep()), /denied tool/);
  assert.deepEqual(ran, []);
  assert.deepEqual(names, ["subagents.open", "admin.whoami", "admin.nested.deep"]);
  const allowed = guardAgentTools(policy([]), context, raw, async (name) => {
    prepared.push(name);
  });
  await allowed.admin.whoami();
  assert.deepEqual(ran, ["admin.whoami"]);
  assert.deepEqual(prepared, ["admin.whoami"]);
});

test("cron admission binds the loop procedure a loop-backed cron runs", () => {
  const cron = {
    id: "cron",
    owner: "owner",
    ownerScopeId: "personal:owner",
    loopId: "loop",
    schedule: { everyMs: 60000 },
  };
  const loop = {
    id: "loop",
    owner: "owner",
    ownerScopeId: "personal:owner",
    name: "intake",
    playbook: "triage the inbox",
    playbookVersion: 1,
    policyVersion: 1,
    successCondition: "inbox empty",
    shipActions: [],
    state: "enabled",
    health: "ok",
  };
  const digest = agentCronDigest(cron as never, loop as never);
  for (const changed of [
    { ...loop, playbook: "forward everything" },
    { ...loop, successCondition: "always" },
    { ...loop, shipActions: [{ action: "send" }] },
    { ...loop, sources: ["mail"] },
  ])
    assert.notEqual(agentCronDigest(cron as never, changed as never), digest);
  assert.equal(agentCronDigest(cron as never, { ...loop, health: "degraded", lastFiredAt: 5 } as never), digest);
  assert.notEqual(agentCronDigest(cron as never, null), digest);
});

async function boundSkillSandbox(options: { lay?: boolean } = {}) {
  const { createTurnSandboxes } = await import("../src/core/orchestrator/sandboxes.ts");
  const { skill, store } = await fixture();
  skill.manifest.files = [
    { path: "references/example.txt", content: "ASSET" },
    { path: "references/second.txt", content: "SECOND" },
  ];
  await store.update(skill.id, skill.manifest);
  await store.review(skill.id, "owner", []);
  await store.publish(skill.id);
  const live = (await store.get(skill.id))!;
  const grants = [{ id: live.id, digest: agentSkillDigest(live) }];
  const provider = policy(grants);
  const disk = new Map<string, string>();
  const removal = { gate: Promise.resolve(), failures: 0, calls: 0 };
  const write = { gate: Promise.resolve(), gateOn: "", failOn: "", provisionGate: Promise.resolve() };
  const sandbox = {
    provision: async () => {
      await write.provisionGate;
      return { id: "box", backend: "fake", rootDir: "/w" };
    },
    listDir: async () => [],
    writeFile: async (_h: unknown, path: string, content: string) => {
      if (write.failOn && path.endsWith(write.failOn)) throw new Error("write failed");
      disk.set(path, content);
      if (write.gateOn && path.endsWith(write.gateOn)) await write.gate;
    },
    readFile: async (_h: unknown, path: string) => disk.get(path) ?? null,
    removeDir: async (_h: unknown, path: string) => {
      if (path.startsWith("turn/")) return;
      removal.calls++;
      await removal.gate;
      if (removal.failures > 0) {
        removal.failures--;
        throw new Error("remove failed");
      }
      for (const key of disk.keys()) if (key === path || key.startsWith(`${path}/`)) disk.delete(key);
    },
  };
  const rows = () => filterAgentSkills(provider, context, [{ skill: live, shadowed: [] }]);
  const boxes = createTurnSandboxes({
    deps: {
      sandbox,
      agentPolicy: provider,
      skills: { get: store.get, recordUse: async () => {} },
      auditLog: { record() {} },
    },
    input: { conversation: { threadRef: context.threadRef }, origin: { kind: "human" }, runId: "run" },
    actor: { id: "owner", type: "internal" },
    session: { id: "session" },
    resolution: { layers: [], egress: {}, orgScopeId: "org:test" },
    scopeId: "personal:owner",
    memoryScopeId: "personal:owner",
    transferId: "x",
    turnSessionDir: "turn/x",
    turnFilesDir: "turn/x/files",
    connectorEnv: {},
    egressTokenForTurn: undefined,
    ownerAuthAvailable: false,
    visibleSkillsForTurn: rows,
    agentPolicyContext: context,
    emitGapWork: () => {},
  } as unknown as Parameters<typeof createTurnSandboxes>[0]);
  const assetPaths = () => [...disk.keys()].filter((key) => key.includes("references/"));
  if (options.lay !== false) {
    const used = await boxes.useSkill("allowed", "references/example.txt");
    assert.equal(used.content, "ASSET");
    assert.equal(assetPaths().length, 2);
  }
  return { boxes, grants, removal, write, assetPaths };
}

test("a concurrent tool call waits until a revoked skill tree is actually deleted", async () => {
  const { boxes, grants, removal, assetPaths } = await boundSkillSandbox();
  grants.length = 0;
  let release!: () => void;
  removal.gate = new Promise((resolve) => (release = resolve));
  const first = boxes.recheckSkillTrees();
  while (removal.calls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  let secondDone = false;
  const second = boxes.recheckSkillTrees().then(() => {
    secondDone = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(secondDone, false);
  assert.equal(assetPaths().length, 2);
  release();
  await Promise.all([first, second]);
  assert.equal(assetPaths().length, 0);
});

test("a failed skill tree deletion fails the call and is retried on the next one", async () => {
  const { boxes, grants, removal, assetPaths } = await boundSkillSandbox();
  grants.length = 0;
  removal.failures = 1;
  await assert.rejects(boxes.recheckSkillTrees(), /remove failed/);
  assert.equal(assetPaths().length, 2);
  await boxes.recheckSkillTrees();
  assert.equal(assetPaths().length, 0);
  assert.equal(removal.calls, 2);
});

test("a policy failure that drops all trees retries a failed deletion", async () => {
  const { boxes, removal, assetPaths } = await boundSkillSandbox();
  removal.failures = 1;
  await assert.rejects(boxes.dropSkillTrees(), /remove failed/);
  assert.equal(assetPaths().length, 2);
  await boxes.dropSkillTrees();
  assert.equal(assetPaths().length, 0);
});

test("a recheck during an in-flight skill tree write leaves no revoked file readable", async () => {
  const { boxes, grants, write, assetPaths } = await boundSkillSandbox({ lay: false });
  let release!: () => void;
  write.gate = new Promise((resolve) => (release = resolve));
  write.gateOn = "references/example.txt";
  const laying = boxes.useSkill("allowed", "references/example.txt");
  while (assetPaths().length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
  grants.length = 0;
  let visibleWhenRechecked: string[] | undefined;
  const recheck = boxes.recheckSkillTrees().then(() => {
    visibleWhenRechecked = assetPaths();
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  await Promise.allSettled([laying, recheck]);
  assert.deepEqual(visibleWhenRechecked, []);
  assert.deepEqual(assetPaths(), []);
});

test("a failed skill tree write leaves no files behind after revocation", async () => {
  const { boxes, grants, write, assetPaths } = await boundSkillSandbox({ lay: false });
  write.failOn = "references/second.txt";
  await assert.rejects(boxes.useSkill("allowed", "references/example.txt"), /write failed/);
  grants.length = 0;
  await boxes.recheckSkillTrees();
  assert.deepEqual(assetPaths(), []);
  write.failOn = "";
  grants.length = 0;
});

test("a grant revoked while the sandbox provisions is never written", async () => {
  const { boxes, grants, write, assetPaths } = await boundSkillSandbox({ lay: false });
  let release!: () => void;
  write.provisionGate = new Promise((resolve) => (release = resolve));
  const using = boxes.useSkill("allowed", "references/example.txt");
  await new Promise((resolve) => setTimeout(resolve, 5));
  grants.length = 0;
  await boxes.recheckSkillTrees();
  release();
  const used = await using;
  assert.equal(used.content, null);
  assert.deepEqual(assetPaths(), []);
});
