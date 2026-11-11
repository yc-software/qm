import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import type { ProvisionOptions, Sandbox, SandboxHandle, TeardownOptions } from "../src/sandbox/sandbox.ts";

const OWN = "personal:alice";

function fixture(
  over: { holdKeepsWarm?: boolean | Error; live?: string[] | Error; teardownFails?: string[]; botActor?: true } = {},
) {
  const provisions: Array<ProvisionOptions | undefined> = [];
  const teardowns: Array<[string, TeardownOptions]> = [];
  const tornDown: SandboxHandle[] = [];
  const removed: Array<[string, string]> = [];
  const failNext: Array<Error> = [];
  const gates: Array<Promise<void>> = [];
  const teardownGates: Array<Promise<void>> = [];
  let n = 0;
  const sandbox: Partial<Sandbox> = {
    profile: { processSessions: false } as Sandbox["profile"],
    async provision(owner, opts) {
      provisions.push(opts);
      await gates.shift();
      const failure = failNext.shift();
      if (failure) throw failure;
      const id = opts?.scratch ? `scratch-${++n}` : (opts?.sandboxId ?? (owner !== OWN ? owner : `box-${++n}`));
      return {
        id,
        resourceId: opts?.scratch ? undefined : id,
        backend: "fake",
        rootDir: "/w",
        ...(owner ? { scopeId: owner } : {}),
      } as SandboxHandle;
    },
    async teardown(handle, opts) {
      teardowns.push([handle.id, opts ?? {}]);
      tornDown.push(handle);
      await teardownGates.shift();
      if (over.teardownFails?.includes(handle.id)) throw new Error(`teardown failed: ${handle.id}`);
    },
    async removeDir(handle, dir) {
      removed.push([handle.id, dir]);
    },
    async listDir() {
      return [];
    },
    async removeDirAndList() {
      return [];
    },
  };
  const holdFailures = new Set<string>();
  const errors: Array<{ code: string; message: string }> = [];
  let liveLookups = 0;
  const resource = (id: string, ownerScopeId = OWN) => ({
    id,
    ownerScopeId,
    state: "ready",
    backend: "fake",
    jobOnly: id.startsWith("job-only"),
  });
  const sandboxResources = {
    access: async (_actor: string, id: string) => {
      if (resource(id).jobOnly) throw new Error("only the job's own controls can reach it");
      return resource(id);
    },
    get: async (id: string) => resource(id),
    notePersonUse: mock.fn(async (id: string) => resource(id)),
    resolve: async () => undefined,
    hold: async (id: string) => {
      if (holdFailures.delete(id)) throw new Error(`hold failed: ${id}`);
    },
    release: async () => {
      if (over.holdKeepsWarm instanceof Error) throw over.holdKeepsWarm;
      return over.holdKeepsWarm ?? false;
    },
  };
  const turn = createTurnSandboxes({
    deps: {
      sandbox,
      sandboxResources,
      runs: { get: async () => undefined },
      processes: {
        listLive: async () => {
          liveLookups++;
          if (over.live instanceof Error) throw over.live;
          return (over.live ?? []).map((sandboxId) => ({ sandboxId }));
        },
      },
      config: {
        refreshSecurity: async () => {},
        getEgress: () => undefined,
        getCommandPolicy: () => null,
        resolveSharingPostureDurable: async () => "open",
      },
      isCurrentSharedScopeMember: async () => true,
      errors: { record: (_t: unknown, event: { code: string; message: string }) => errors.push(event) },
    },
    input: { origin: { kind: "user" }, runId: "run-1", botActor: over.botActor },
    actor: { id: "alice", type: "internal" },
    session: { id: "s" },
    resolution: { writableScopeId: OWN, readOnlyScopeIds: ["org:global"], orgScopeId: "org:global" },
    scopeId: OWN,
    memoryScopeId: OWN,
    transferId: "t",
    turnSessionDir: "turn/s",
    turnFilesDir: "turn/s/t",
    connectorEnv: {},
    egressTokenForPolicy: async () => undefined,
    openResourceAccess: true,
    visibleSkillsForTurn: async () => [],
  } as unknown as TurnSandboxContext);
  const released = () => Object.fromEntries(teardowns);
  const clearedTurnFiles = () => removed.filter(([, dir]) => dir === "turn/s/t").map(([id]) => id);
  return {
    turn,
    notePersonUse: sandboxResources.notePersonUse,
    provisions,
    teardowns,
    tornDown,
    released,
    clearedTurnFiles,
    failNext,
    gates,
    teardownGates,
    holdFailures,
    errors,
    liveLookups: () => liveLookups,
  };
}

test("each computer a turn touched is released exactly once, the default box with its own options", async () => {
  const f = fixture();
  const scoped = await f.turn.provision();
  await f.turn.provisionResource(scoped.id);
  await f.turn.provisionResource("other");
  assert.ok(f.notePersonUse.mock.calls.some((call) => call.arguments[0] === "other"));
  await f.turn.reclaimBox();
  assert.deepEqual(f.teardowns.map(([id]) => id).sort(), [scoped.id, "other"].sort());
  assert.ok(f.teardowns.every(([, opts]) => !opts.keepWarm && !opts.homeUnchanged));
  assert.deepEqual(f.clearedTurnFiles().sort(), [scoped.id, "other"].sort());
  assert.equal(f.liveLookups(), 1);
});

test("an eagerly warmed default box the turn never used is released as unchanged", async () => {
  const f = fixture();
  const box = await f.turn.provision(true);
  await f.turn.reclaimBox();
  assert.deepEqual(f.released(), { [box.id]: { homeUnchanged: true } });
  assert.equal(f.notePersonUse.mock.callCount(), 1);
});

test("an eagerly warmed default box the turn opened by its id is released as used", async () => {
  const f = fixture();
  const box = await f.turn.provision(true);
  await f.turn.provisionResource(box.id);
  await f.turn.reclaimBox();
  assert.deepEqual(f.released(), { [box.id]: {} });
});

const kinds = {
  scoped: { id: "box-1", open: (f: ReturnType<typeof fixture>) => f.turn.provision() },
  resource: { id: "job-box", open: (f: ReturnType<typeof fixture>) => f.turn.provisionResource("job-box") },
};

for (const [kind, { id, open }] of Object.entries(kinds)) {
  test(`a ${kind} computer running a background job stays warm`, async () => {
    const f = fixture({ live: [id] });
    await open(f);
    await f.turn.reclaimBox();
    assert.equal(f.released()[id]?.keepWarm, true);
  });

  test(`a ${kind} computer stays warm when another live turn still holds it`, async () => {
    const f = fixture({ holdKeepsWarm: true });
    await open(f);
    await f.turn.reclaimBox();
    assert.equal(f.released()[id]?.keepWarm, true);
  });

  test(`a ${kind} computer stays warm when its hold or job state cannot be read`, async () => {
    for (const over of [{ holdKeepsWarm: new Error("hold store down") }, { live: new Error("process store down") }]) {
      const f = fixture(over);
      await open(f);
      await f.turn.reclaimBox();
      assert.equal(f.released()[id]?.keepWarm, true);
    }
  });
}

test("a scratch computer is destroyed at turn end even when its job or another turn would keep a computer warm", async () => {
  const f = fixture({ holdKeepsWarm: true, live: ["scratch-1", "box-2"] });
  const scratch = await f.turn.provisionScratch();
  const box = await f.turn.provision();
  await f.turn.reclaimBox();
  assert.deepEqual(f.released(), { [scratch.id]: { destroy: true }, [box.id]: { keepWarm: true } });
});

test("concurrent opens of one computer share a single provision", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.turn.provisionResource("other"), f.turn.provisionResource("other")]);
  const [c, d] = await Promise.all([f.turn.provision(), f.turn.provision()]);
  assert.equal(a, b);
  assert.equal(c, d);
  assert.equal(f.provisions.length, 2);
  await f.turn.reclaimBox();
  assert.equal(f.teardowns.length, 2);
});

test("a computer whose setup fails mid-turn is still released, and the next call retries", async () => {
  const f = fixture();
  f.failNext.push(new Error("provider down"));
  await assert.rejects(f.turn.provision(), /provider down/);
  f.holdFailures.add("box-1");
  await assert.rejects(f.turn.provision(), /hold failed: box-1/);
  const box = await f.turn.provision();
  f.holdFailures.add("job-box");
  await assert.rejects(f.turn.provisionResource("job-box"), /hold failed: job-box/);
  await f.turn.provisionResource("job-box");
  await f.turn.reclaimBox();
  assert.deepEqual(f.teardowns.map(([id]) => id).sort(), ["box-1", box.id, "job-box"].sort());
});

test("switching the default mid-turn releases the old box, even one still being created", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  f.gates.push(gate.promise);
  const old = f.turn.provision();
  f.turn.invalidateProvision();
  const next = await f.turn.provision();
  gate.resolve();
  const previous = await old;
  assert.notEqual(previous.id, next.id);
  await f.turn.reclaimBox();
  assert.deepEqual(f.teardowns.map(([id]) => id).sort(), [previous.id, next.id].sort());
});

test("reclaim waits for in-flight creation before releasing", async () => {
  const f = fixture();
  const gate = Promise.withResolvers<void>();
  f.gates.push(gate.promise);
  const opening = f.turn.provisionResource(await f.turn.accessResource("job-box"));
  const reclaim = f.turn.reclaimBox();
  gate.resolve();
  await Promise.all([opening, reclaim]);
  assert.deepEqual(Object.keys(f.released()), ["job-box"]);
});

test("a computer opened while reclaim waits on another is released too", async () => {
  const f = fixture();
  const first = Promise.withResolvers<void>();
  const second = Promise.withResolvers<void>();
  f.gates.push(first.promise, second.promise);
  const opening = f.turn.provisionResource(await f.turn.accessResource("job-box"));
  const reclaim = f.turn.reclaimBox();
  const late = f.turn.provisionResource("other");
  first.resolve();
  await opening;
  second.resolve();
  await Promise.all([late, reclaim]);
  assert.deepEqual(Object.keys(f.released()).sort(), ["job-box", "other"]);
});

test("a computer opened while reclaim is tearing down another is released too", async () => {
  const f = fixture();
  const tearing = Promise.withResolvers<void>();
  f.teardownGates.push(tearing.promise);
  await f.turn.provisionResource("job-box");
  const reclaim = f.turn.reclaimBox();
  while (!f.teardowns.length) await new Promise((resolve) => setImmediate(resolve));
  await f.turn.provisionResource("other");
  tearing.resolve();
  await reclaim;
  assert.deepEqual(Object.keys(f.released()).sort(), ["job-box", "other"]);
});

test("another scope's computer is released without touching this turn's files", async () => {
  const f = fixture();
  await f.turn.provisionResource({
    resource: { id: "theirs", ownerScopeId: "personal:bob" } as never,
    crossScope: true,
    egress: undefined as never,
    commandPolicy: null,
  });
  await f.turn.reclaimBox();
  assert.deepEqual(Object.keys(f.released()), ["theirs"]);
  assert.deepEqual(f.clearedTurnFiles(), []);
});

test("a failed release does not stop the others, and only scratch failures fail the turn", async () => {
  const f = fixture({ teardownFails: ["box-1", "scratch-2"] });
  await f.turn.provision();
  await f.turn.provisionScratch();
  await f.turn.provisionResource("job-box");
  await assert.rejects(f.turn.reclaimBox(), /Disposable sandbox destruction failed/);
  assert.deepEqual([...new Set(f.teardowns.map(([id]) => id))].sort(), ["box-1", "job-box", "scratch-2"]);
  const clean = fixture({ teardownFails: ["box-1"] });
  await clean.turn.provision();
  await clean.turn.reclaimBox();
  assert.deepEqual(Object.keys(clean.released()), ["box-1"]);
  assert.deepEqual(
    clean.errors.map((e) => [e.code, e.message]),
    [["teardown_failed", "fake:box-1: teardown failed: box-1"]],
  );
});

test("a failed reopen under another egress policy keeps the working handle", async () => {
  const f = fixture();
  const first = await f.turn.provisionResource("job-box");
  const access = await f.turn.accessResource("job-box");
  f.failNext.push(new Error("provider refused"));
  await assert.rejects(
    f.turn.provisionResource({ ...access, egress: { allowedHosts: ["only.test"], deniedHosts: [] } }),
    /provider refused/,
  );
  assert.equal(await f.turn.provisionResource("job-box"), first);
  assert.equal(f.provisions.length, 2);
  await f.turn.reclaimBox();
  assert.equal(f.tornDown[0], first);
});

test("reopening a computer under a different egress policy releases it once", async () => {
  const f = fixture();
  const first = await f.turn.provisionResource("job-box");
  const again = await f.turn.provisionResource("job-box");
  assert.equal(first, again);
  const access = await f.turn.accessResource("job-box");
  const narrowed = await f.turn.provisionResource({
    ...access,
    egress: { allowedHosts: ["only.test"], deniedHosts: [] },
  });
  assert.notEqual(narrowed, first);
  assert.equal(f.provisions.length, 2);
  await f.turn.reclaimBox();
  assert.equal(f.tornDown.length, 1);
  assert.equal(f.tornDown[0], narrowed);
});

test("a Slack bot's turn cannot open a background job's computer it didn't make", async () => {
  const f = fixture({ botActor: true });
  await assert.rejects(f.turn.provisionJobSandbox("job-only-1"), /can use only a computer it made/);
  assert.equal(f.provisions.length, 0);
});

test("concurrent opens of a background job's own computer share one provision", async () => {
  const f = fixture();
  const [a, b] = await Promise.all([
    f.turn.provisionJobSandbox("job-only-1"),
    f.turn.provisionJobSandbox("job-only-1"),
  ]);
  assert.equal(a, b);
  assert.equal(f.provisions.length, 1);
});
