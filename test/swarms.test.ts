import { test } from "node:test";
import assert from "node:assert/strict";
import { selectAudience } from "../src/swarms/audience.ts";
import { createSwarmService, type SwarmCaller } from "../src/swarms/swarm-service.ts";
import { SWARM_LIMITS } from "../src/swarms/swarm-store.ts";
import { runResultDelivery } from "../src/delivery/run-result-delivery.ts";
import { createTurnSandboxes, type TurnSandboxContext } from "../src/core/orchestrator/sandboxes.ts";
import { processRun } from "../src/runs/worker.ts";
import type { Orchestrator } from "../src/core/orchestrator.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("initial pool creates durable ordinary sessions with distinct blank Modal disks", async () => {
  const fixture = await swarmFixture();
  const { service, caller, sandbox, root, sessions, store, runs } = fixture;
  const parent = await fixture.sandboxes.create("alice", root.scopeId, "modal", "Parent");
  await fixture.sandboxes.setDefault("alice", root.scopeId, parent.id);
  const layers = [{ scopeId: root.scopeId, mode: "rw" as const, mountPath: "/" }];
  const parentHandle = await sandbox.provision(layers);
  await sandbox.writeFile(parentHandle, "private-file", "do not copy");
  const workers = await service.spawn(caller, {
    requestId: "pool",
    count: 3,
    context: { role: "worker" },
    text: "Do independent work",
  });
  assert.equal(workers.length, 3);
  assert.ok(workers.every((worker) => worker.state === "reserved"));
  await service.sweep();
  const peers = (await service.inspect(caller)).peers;
  assert.equal(peers.length, 4);
  const handles = [];
  for (const peer of peers.slice(1)) {
    const session = await sessions.getForParticipant(peer.sessionId!, "alice");
    assert.equal(session?.scopeId, root.scopeId);
    assert.equal(session?.surface, "swarm");
    assert.match(session!.title!, /Swarm worker/);
    const handle = await sandbox.provision(layers, { sandboxId: peer.sandboxId });
    handles.push(handle);
    assert.equal(handle.scopeId, root.scopeId);
    assert.equal(await sandbox.readFile(handle, "private-file"), null);
  }
  assert.equal(new Set(handles.map((handle) => handle.id)).size, 3);
  await sandbox.writeFile(handles[0]!, "result", "worker only");
  assert.equal(await sandbox.readFile(handles[1]!, "result"), null);
  assert.equal((await sandbox.provision(layers)).id, parentHandle.id);
  const message = (await store.get(root.id))!.messages[0]!;
  assert.equal(message.author, "agent");
  for (const notification of Object.values(message.notifications)) {
    const run = (await runs.get(notification.runId!))!;
    assert.equal(run.request.origin.kind, "automation");
    assert.equal(run.request.deliveryTarget, undefined);
    assert.equal(run.request.origin.kind === "automation" && run.request.origin.useOwnerKeychain, undefined);
    assert.equal(
      runResultDelivery({
        ...run,
        request: { ...run.request, surface: "slack", deliveryTarget: "dm" },
        status: "done",
        result: { status: "ok", reply: "agent-only" },
      }),
      null,
    );
  }
});

test("own JSON context stays separate from trusted identity and scoped audience", async () => {
  const { service, caller, workerCaller, root } = await swarmFixture();
  const workers = await service.spawn(caller, {
    requestId: "pool",
    count: 2,
    contexts: [{ group: "feature", role: "worker" }, { role: "observer" }],
    text: "Work",
  });
  await service.sweep();
  const worker = await workerCaller(workers[0]!.id);
  await service.context(worker, {
    group: "feature",
    role: "worker",
    id: "forged",
    scopeId: "personal:bob",
    parentId: "forged",
  });
  const view = await service.inspect(worker);
  assert.equal(view.self.id, workers[0]!.id);
  assert.equal(view.self.parentId, root.id);
  const message = await service.send(caller, {
    requestId: "send",
    text: "Question",
    audience: '.[] | select(.group == "feature" and .role == "worker")',
  });
  assert.deepEqual(message.audience, [workers[0]!.id]);
  const observer = await workerCaller(workers[1]!.id);
  assert.ok((await service.read(observer, {})).some((entry) => entry.id === message.id));
  await service.context(worker, ["arbitrary", { value: null }]);
  assert.deepEqual((await service.inspect(worker)).self.context, ["arbitrary", { value: null }]);
  await service.context(worker, null);
  assert.equal((await service.inspect(worker)).self.context, null);
});

test("jq rejects invalid, exhausting, module-loading, and fabricated recipients", async () => {
  const peers = [{ id: "eligible", context: { role: "worker" } }];
  for (const filter of [
    "select(",
    "--help",
    "--rawfile=/tmp/private",
    "[range(1000000000)]",
    "recurse",
    'include "/tmp/private"; .[]',
    '{id:"outsider"}',
    '"eligible"',
  ]) {
    await assert.rejects(selectAudience(filter, peers));
  }
  assert.deepEqual(await selectAudience("empty", peers), []);
  assert.deepEqual(await selectAudience(".[], .[]", peers), ["eligible"]);
  assert.deepEqual(await selectAudience("if env | length == 0 then .[] else empty end", peers), []);
  await assert.rejects(selectAudience("x".repeat(2_049), peers), /invalid/);
});

test("unrelated sessions, forged capabilities, and revoked scope membership fail closed", async () => {
  const { service, caller, sessions, root, state } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  const other = await sessions.getOrCreateByThread("other", "dm", root.scopeId);
  await sessions.addParticipant(other.id, "alice");
  assert.equal(caller.kind, "agent");
  if (caller.kind !== "agent") throw new Error("wrong caller");
  await assert.rejects(
    service.inspect({ kind: "agent", claims: { ...caller.claims, threadRef: other.threadRef } }),
    /mismatch/,
  );
  await assert.rejects(service.inspect({ kind: "agent", claims: { ...caller.claims, actorId: "bob" } }), /denied/);
  await assert.rejects(
    service.inspect({ kind: "agent", claims: { ...caller.claims, scopeId: "personal:bob" } }),
    /capability/,
  );
  await assert.rejects(
    service.inspect({ kind: "agent", claims: { ...caller.claims, runId: undefined } }),
    /capability/,
  );
  await assert.rejects(service.inspect({ kind: "human", actorId: "alice", sessionId: other.id }), /not found/);
  state.allowed = false;
  await assert.rejects(service.read(caller, {}), /denied/);
  state.allowed = true;
  await sessions.addParticipant(root.id, "bob");
  await assert.rejects(service.read(caller, {}), /roster changed/);
});

test("eligible recipients exclude a session whose roster changes", async () => {
  const { service, caller, sessions, workerCaller, runs } = await swarmFixture();
  const [worker] = await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const peer = (await service.inspect(caller)).peers.find((item) => item.id === worker!.id)!;
  await sessions.addParticipant(peer.sessionId!, "bob");
  const message = await service.send(caller, { requestId: "everyone", audience: ".[]", text: "Private work" });
  assert.ok(!message.audience.includes(peer.id));
  await assert.rejects(service.read(await workerCaller(peer.id), {}), /roster changed/);
  const run = (await runs.list()).find((entry) => entry.request.swarm)!;
  await assert.rejects(service.binding({ ...run.request, runId: run.id }), /authorization changed/);
});

test("spawn and send retry keys are idempotent and reject conflicting payloads", async () => {
  const { service, caller, store, root } = await swarmFixture();
  const request = { requestId: "one", text: "Work" };
  const [first, second] = await Promise.all([service.spawn(caller, request), service.spawn(caller, request)]);
  assert.equal(first[0]!.id, second[0]!.id);
  await assert.rejects(service.spawn(caller, { ...request, text: "Different" }), /reused/);
  await service.sweep();
  const message = { requestId: "message", audience: ".[]", text: "Question" };
  const [sent, resent] = await Promise.all([service.send(caller, message), service.send(caller, message)]);
  assert.equal(sent.id, resent.id);
  await assert.rejects(service.send(caller, { ...message, text: "Different" }), /reused/);
  assert.equal((await store.get(root.id))!.messages.length, 2);
});

test("concurrent pool reservations enforce a finite total without partial allocation", async () => {
  const { service, serviceOptions, caller } = await swarmFixture();
  const second = createSwarmService(serviceOptions);
  const results = await Promise.allSettled([
    service.spawn(caller, { requestId: "first", count: 20, text: "Work" }),
    second.spawn(caller, { requestId: "second", count: 20, text: "Work" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await service.inspect(caller)).peers.length, 21);
  await service.spawn(caller, { requestId: "remaining", count: 11, text: "Work" });
  await assert.rejects(service.spawn(caller, { requestId: "excess", text: "Work" }), /agent budget/);
  assert.equal((await service.inspect(caller)).peers.length, SWARM_LIMITS.agents);
});

test("recursive spawn depth is enforced independently of arbitrary character", async () => {
  const { service, caller, workerCaller } = await swarmFixture();
  let current: SwarmCaller = caller;
  for (let depth = 1; depth <= SWARM_LIMITS.depth; depth++) {
    const [worker] = await service.spawn(current, {
      requestId: `level-${depth}`,
      context: { depth: -100 },
      text: "Work",
    });
    await service.sweep();
    current = await workerCaller(worker!.id);
    assert.equal((await service.inspect(current)).self.depth, depth);
  }
  await assert.rejects(service.spawn(current, { requestId: "too-deep", text: "Work" }), /depth budget/);
});

test("notification and message budgets include initial work and prevent recursion loops", async () => {
  const { service, caller, store, root } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  await store.update(root.id, (swarm) => {
    swarm.notificationCount = SWARM_LIMITS.notifications;
  });
  await assert.rejects(
    service.send(caller, { requestId: "notify", audience: ".[]", text: "Work" }),
    /notification budget/,
  );
  await service.send(caller, { requestId: "quiet", audience: ".[]", text: "No wake", notify: false });
  for (let index = 2; index < SWARM_LIMITS.messages; index++) {
    await service.send(caller, { requestId: `quiet-${index}`, audience: "empty", text: "Archive", notify: false });
  }
  await assert.rejects(
    service.send(caller, { requestId: "excess", audience: "empty", text: "Archive", notify: false }),
    /message budget/,
  );
  assert.equal((await service.read(caller, {})).length, 32);
});

test("restart between enqueue and outbox acknowledgement does not redeliver", async () => {
  const { service, serviceOptions, caller, store, root, runs } = await swarmFixture();
  await service.spawn(caller, { requestId: "pool", count: 2, text: "Work" });
  await service.sweep();
  const before = await runs.list();
  await store.update(root.id, (swarm) => {
    for (const message of swarm.messages)
      for (const id of Object.keys(message.notifications)) message.notifications[id] = { state: "pending" };
  });
  const restarted = createSwarmService(serviceOptions);
  await Promise.all([service.sweep(), restarted.sweep()]);
  assert.equal((await runs.list()).length, before.length);
  assert.deepEqual((await runs.list()).map((run) => run.id).sort(), before.map((run) => run.id).sort());
  assert.equal((await store.pending()).length, 0);
});

test("sandbox reservation survives a crash after provisioning without creating another disk", async () => {
  const { service, serviceOptions, caller, root, sandboxes, provisioned } = await swarmFixture();
  const [worker] = await service.spawn(caller, { requestId: "one", text: "Work" });
  await sandboxes.create("alice", root.scopeId, "modal", "Swarm worker", worker!.id);
  const count = provisioned.length;
  await createSwarmService(serviceOptions).sweep();
  assert.equal(provisioned.length, count);
  assert.equal((await service.inspect(caller)).peers[1]!.state, "ready");
  await assert.rejects(sandboxes.create("bob", "personal:bob", "modal", "forged", worker!.id), /ownership mismatch/);
});

test("slow provisioning does not accumulate overlapping outbox sweeps", async () => {
  const { service, caller, backend } = await swarmFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provision = backend.provision;
  backend.provision = async (layers, options) => {
    await gate;
    return provision(layers, options);
  };
  await service.spawn(caller, { requestId: "one", text: "Work" });
  const first = service.sweep();
  const second = service.sweep();
  assert.equal(first, second);
  release();
  await first;
  assert.equal((await service.inspect(caller)).peers[1]!.state, "ready");
});

test("provisioning failure is bounded and rolls back owned resources without queuing work", async () => {
  const { service, caller, state, store, root, runs, records, sessions, sandboxes } = await swarmFixture();
  const forum = await sandboxes.create("alice", root.scopeId, "modal", "Forum");
  state.failProvision = true;
  const [worker] = await service.spawn(caller, { requestId: "one", text: "Work", forumSandboxId: forum.id });
  await service.sweep();
  await service.sweep();
  await service.sweep();
  await service.sweep();
  const failed = (await store.get(root.id))!.members[1]!;
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempts, 3);
  assert.equal(failed.cleanupPending, false);
  assert.equal((await records.get(worker!.id))!.state, "retired");
  assert.equal((await records.get(forum.id))!.state, "ready");
  assert.equal(await sessions.getByThread(worker!.threadRef), null);
  assert.equal((await runs.list()).length, 1);
  assert.equal((await store.pending()).length, 0);
});

test("explicit forum supplements private worker disks and remains scope-authorized", async () => {
  const { service, caller, sandboxes, sandbox, root } = await swarmFixture();
  const forum = await sandboxes.create("alice", root.scopeId, "modal", "Forum");
  const other = await sandboxes.create("bob", "personal:bob", "modal", "Private");
  await assert.rejects(
    service.spawn(caller, { requestId: "wrong", text: "Work", forumSandboxId: other.id }),
    /permission/,
  );
  await service.spawn(caller, { requestId: "forum", count: 2, text: "Collaborate", forumSandboxId: forum.id });
  await service.sweep();
  const peers = (await service.inspect(caller)).peers.slice(1);
  assert.ok(peers.every((member) => member.forumSandboxId === forum.id && member.sandboxId !== forum.id));
  assert.equal(new Set(peers.map((member) => member.sandboxId)).size, 2);
  const layers = [{ scopeId: root.scopeId, mode: "rw" as const, mountPath: "/" }];
  const shared = await sandbox.provision(layers, { sandboxId: forum.id });
  await sandbox.writeFile(shared, "shared-result", "for peers");
  for (const peer of peers) {
    const own = await sandbox.provision(layers, { sandboxId: peer.sandboxId });
    assert.equal(await sandbox.readFile(own, "shared-result"), null);
    const selected = await sandbox.provision(layers, { sandboxId: peer.forumSandboxId });
    assert.equal(await sandbox.readFile(selected, "shared-result"), "for peers");
  }
});

test("correlated bounded waits observe replies without creating extra notifications", async () => {
  const { service, caller, workerCaller } = await swarmFixture();
  const [worker] = await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const question = await service.send(caller, {
    requestId: "ask",
    text: "Status?",
    audience: `.[] | select(.id == ${JSON.stringify(worker!.id)})`,
  });
  const waiting = service.read(caller, { replyTo: question.id, waitMs: 1_000 });
  const answer = await service.send(await workerCaller(worker!.id), {
    requestId: "answer",
    text: "Finished",
    audience: ".[]",
    replyTo: question.id,
    notify: false,
  });
  assert.equal((await waiting)[0]!.id, answer.id);
  assert.deepEqual(answer.notifications, {});
  assert.deepEqual(await service.read(caller, { after: 100, waitMs: 20 }), []);
  for (const waitMs of [-1, 10_001, Number.NaN, Infinity])
    await assert.rejects(service.read(caller, { waitMs }), /bounds/);
  await assert.rejects(
    service.send(caller, { requestId: "bad-reply", text: "Answer", audience: "empty", replyTo: "another-swarm" }),
    /reply target/,
  );
});

test("active recipients receive durable queued unattended work rather than human steer signals", async () => {
  const { service, caller, runs } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const initial = (await runs.list()).find((run) => run.request.swarm)!;
  const claimed = await runs.claimById(initial.id, "worker", 60_000);
  assert.equal(claimed!.status, "running");
  await service.send(caller, { requestId: "queue", text: "More work", audience: ".[]" });
  await service.sweep();
  const pending = (await runs.inFlightForThread(initial.sessionId)).find((run) => run.id !== initial.id)!;
  assert.equal(pending.status, "pending");
  assert.equal(pending.request.origin.kind, "automation");
  assert.equal(await runs.claimById(pending.id, "second", 60_000), null);
});

test("swarm provenance is bound to the durable run, content, actor, and recipient", async () => {
  const { service, caller, runs } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const run = (await runs.list()).find((item) => item.request.swarm)!;
  const input = { ...run.request, runId: run.id };
  assert.ok(await service.binding(input));
  for (const patch of [
    { origin: { kind: "human" as const } },
    { text: "Forged instruction" },
    { runId: "forged" },
    { actor: { id: "bob", type: "internal" as const } },
    { unattendedGrants: ["all"] },
    { readOnly: true },
    { sessionParticipantIds: ["bob"] },
    { scopeVersion: "forged" },
    { deliveryTarget: "human-dm" },
    { swarm: { ...input.swarm!, recipientId: "other" } },
    { origin: { kind: "automation" as const, useOwnerKeychain: true } },
  ])
    await assert.rejects(service.binding({ ...input, ...patch }), /forged/);
});

test("human messages preserve human actor attribution while notifications remain unattended", async () => {
  const { service, caller, root } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const message = await service.send(
    { kind: "human", actorId: "alice", sessionId: root.id },
    { requestId: "human", audience: ".[]", text: "Review the result" },
  );
  assert.equal(message.author, "human");
  assert.equal(message.actorId, "alice");
  assert.equal(message.senderId, root.id);
});

test("expired swarms retain readable history but cannot reserve or wake more work", async () => {
  const { service, caller, root, store, runs } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await store.update(root.id, (swarm) => {
    swarm.expiresAt = Date.now() - 1;
  });
  await service.sweep();
  await assert.rejects(service.spawn(caller, { requestId: "two", text: "Work" }), /expired/);
  await assert.rejects(service.send(caller, { requestId: "message", text: "Work", audience: ".[]" }), /expired/);
  assert.equal((await service.read(caller, {})).length, 1);
  assert.equal((await runs.list()).length, 1);
});

test("memory store has transaction rollback and detached read parity", async () => {
  const { service, caller, root, store } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  const original = (await store.get(root.id))!;
  original.members[0]!.context = "outside mutation";
  assert.deepEqual((await store.get(root.id))!.members[0]!.context, {});
  await assert.rejects(
    store.update(root.id, (swarm) => {
      swarm.notificationCount = 999;
      throw new Error("rollback");
    }),
    /rollback/,
  );
  assert.equal((await store.get(root.id))!.notificationCount, 1);
});

test("the orchestrator sandbox path selects worker storage without changing authorization layers", async () => {
  const { service, caller, sandbox, sandboxes, runs, root } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const run = (await runs.list()).find((item) => item.request.swarm)!;
  const binding = (await service.binding({ ...run.request, runId: run.id }))!;
  const storageScopeId = "environment:shared";
  const layers = [{ scopeId: storageScopeId, mountPath: "/", mode: "rw" as const }];
  const turn = createTurnSandboxes({
    deps: { sandbox, sandboxResources: sandboxes, swarms: service },
    input: { ...run.request, runId: run.id },
    actor: run.request.actor,
    session: { id: binding.member.sessionId },
    resolution: { layers, egress: { allowedHosts: [] } },
    scopeId: root.scopeId,
    memoryScopeId: storageScopeId,
    transferId: "transfer",
    turnSessionDir: "/tmp/session",
    turnFilesDir: "/tmp/files",
    connectorEnv: {},
    isolateOwnerKeychain: false,
    ownerAuthAvailable: false,
    ownerAuthEnv: {},
    ownerEnvCredentialIds: [],
    credentialTools: [],
    credentialServices: [],
    credentialCutoverServices: [],
    quarantinedServices: [],
    visibleSkills: [],
    visibleSkillsForTurn: async () => [],
    residentAuthConnectors: () => [],
    emitGapWork: () => {},
    perf: { credsMs: 0 },
  } as unknown as TurnSandboxContext);
  const handle = await turn.provision();
  assert.equal(handle.resourceId, binding.sandboxId);
  assert.equal(handle.scopeId, root.scopeId);
  assert.equal(layers[0]!.scopeId, storageScopeId);
  const forum = await sandboxes.create("alice", root.scopeId, "modal", "Forum");
  assert.equal((await turn.provisionResource(forum.id)).resourceId, forum.id);
  const foreign = await sandboxes.create("bob", "personal:bob", "modal", "Other scope");
  await assert.rejects(turn.provisionResource(foreign.id), /does not belong/);
});

test("durable worker rejects excessive swarm claims before calling the harness", async () => {
  const { service, caller, runs } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const pending = (await runs.list()).find((item) => item.request.swarm)!;
  const claimed = (await runs.claimById(pending.id, "test", 60_000))!;
  let called = false;
  const orchestrator = {
    handleTurn: async () => {
      called = true;
      return { status: "silent" as const };
    },
  } as unknown as Orchestrator;
  await assert.rejects(
    processRun({ runs, orchestrator, leaseTtlMs: 60_000 }, { ...claimed, attempts: 4 }),
    /claim budget/,
  );
  assert.equal(called, false);
  assert.equal((await runs.get(claimed.id))!.status, "failed");
});

test("swarm work cancellation has a hard worker deadline independent of the harness", async (context) => {
  const { service, caller, runs } = await swarmFixture();
  await service.spawn(caller, { requestId: "one", text: "Work" });
  await service.sweep();
  const pending = (await runs.list()).find((item) => item.request.swarm)!;
  const claimed = (await runs.claimById(pending.id, "test", 60_000))!;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let cancelled = false;
  const orchestrator = {
    async handleTurn(input: import("../src/core/orchestrator.ts").OrchestratorInput) {
      await new Promise<void>((resolve) =>
        input.cancel!.addEventListener(
          "abort",
          () => {
            cancelled = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { status: "silent" as const };
    },
  } as unknown as Orchestrator;
  const work = processRun({ runs, orchestrator, leaseTtlMs: 60_000 }, claimed);
  context.mock.timers.tick(SWARM_LIMITS.turnMs - 1);
  assert.equal(cancelled, false);
  context.mock.timers.tick(1);
  await work;
  assert.equal(cancelled, true);
});
