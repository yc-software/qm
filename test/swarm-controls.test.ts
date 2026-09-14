import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { App } from "../src/api/app.ts";
import { createServer } from "../src/api/server.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

const human = (fixture: Awaited<ReturnType<typeof swarmFixture>>) => ({
  kind: "human" as const,
  actorId: fixture.caller.claims.actorId,
  sessionId: fixture.root.id,
});

test("live HTTP manager pause parks queued swarm work and resume retains the same payload and retry budget", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "control-worker", text: "Unchanged work" });
  await fixture.service.sweep();
  const queued = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  const before = structuredClone(queued);
  const secret = "swarm-control-fixture-signing-secret";
  const server = createServer({ swarms: fixture.service, getSessionForViewer: async () => ({}) } as unknown as App, {
    signingSecret: secret,
    portalIdentitySecret: secret,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const path = `/v1/sessions/${fixture.root.id}/swarm`;
    const portal = await mintPortalIdentity({ p: fixture.caller.claims.actorId, exp: Date.now() + 60_000 }, secret);
    const control = async (command: string) => {
      const body = JSON.stringify({ action: "control", memberId: member!.id, command });
      return fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(secret, "POST", path, body, {
          "content-type": "application/json",
          "x-portal-identity": portal,
        }),
        body,
      });
    };
    const pause = await control("pause");
    assert.equal(pause.status, 200, await pause.text());
    assert.equal(await fixture.runs.claimById(queued.id, "test", 60_000), null);
    assert.equal((await fixture.runs.get(queued.id))!.held, true);
    const resume = await control("resume");
    assert.equal(resume.status, 200, await resume.text());
    const after = (await fixture.runs.get(queued.id))!;
    assert.deepEqual(after.request, before.request);
    assert.equal(after.attempts, before.attempts);
    assert.equal(after.errorAttempts, before.errorAttempts);
    assert.equal(after.dedupKey, before.dedupKey);
    assert.ok(await fixture.runs.claimById(queued.id, "test", 60_000));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("only scope managers can control private members; agents and public IDs cannot grant control", async () => {
  const fixture = await swarmFixture();
  const identity = await fixture.service.character(fixture.caller, { version: 0, name: "Public", character: {} });
  const input = { memberId: fixture.root.id, command: "pause" as const };
  await assert.rejects(fixture.service.control(fixture.caller, input), /human scope management/);
  fixture.state.manageable = false;
  await assert.rejects(fixture.service.control(human(fixture), input), /scope management/);
  fixture.state.manageable = true;
  await assert.rejects(fixture.service.control(human(fixture), { ...input, memberId: identity.id }), /unknown member/);
  for (const override of [{ command: "delete" }, { subtree: 1 }, { version: -1 }, { version: 0.5 }])
    await assert.rejects(
      fixture.service.control(human(fixture), { ...input, ...override } as never),
      /invalid control/,
    );
  const results = await Promise.allSettled([
    fixture.service.control(human(fixture), { ...input, version: 0 }),
    fixture.service.control(human(fixture), { ...input, version: 0 }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
});

test("paused ancestors block descendants and reserve attempts, subtree resume preserves permanently stopped descendants", async () => {
  const fixture = await swarmFixture();
  const [parent] = await fixture.service.spawn(fixture.caller, { requestId: "parent", text: "Work" });
  await fixture.service.sweep();
  const parentCaller = await fixture.workerCaller(parent!.id);
  const [child, stoppedChild] = await fixture.service.spawn(parentCaller, {
    requestId: "children",
    text: "Work",
    count: 2,
  });
  await fixture.service.control(human(fixture), { memberId: stoppedChild!.id, command: "stop" });
  await fixture.service.control(human(fixture), { memberId: parent!.id, command: "pause" });
  for (let i = 0; i < 4; i++) await fixture.service.sweep();
  const view = await fixture.service.inspect(human(fixture));
  assert.equal(view.effectiveStates[child!.id], "paused");
  assert.equal(view.effectiveStates[stoppedChild!.id], "stopped");
  assert.equal(view.peers.find((member) => member.id === child!.id)!.attempts, 0);
  assert.equal(view.peers.find((member) => member.id === child!.id)!.state, "reserved");
  await assert.rejects(fixture.service.spawn(parentCaller, { requestId: "blocked", text: "No" }), /paused or stopped/);
  await fixture.service.control(human(fixture), { memberId: parent!.id, command: "resume", subtree: true });
  await fixture.service.sweep();
  const resumed = await fixture.service.inspect(human(fixture));
  assert.equal(resumed.peers.find((member) => member.id === child!.id)!.state, "ready");
  assert.equal(resumed.effectiveStates[stoppedChild!.id], "stopped");
  await assert.rejects(
    fixture.service.control(human(fixture), { memberId: stoppedChild!.id, command: "resume" }),
    /cannot resume/,
  );
});

test("stop cancels queued work but keeps dedupe evidence and sends existing abort signals to active work", async () => {
  const fixture = await swarmFixture();
  const [a, b] = await fixture.service.spawn(fixture.caller, { requestId: "workers", text: "Work", count: 2 });
  await fixture.service.sweep();
  const caller = await fixture.workerCaller(a!.id);
  const pending = (await fixture.runs.inFlightForThread(b!.threadRef))[0]!;
  await fixture.service.control(human(fixture), { memberId: fixture.root.id, command: "stop", subtree: true });
  assert.equal(caller.kind, "agent");
  if (caller.kind !== "agent") throw new Error("agent required");
  assert.deepEqual(
    (await fixture.serviceOptions.signals.takePending(caller.claims.runId!)).map((signal) => signal.kind),
    ["abort"],
  );
  const cancelled = (await fixture.runs.get(pending.id))!;
  assert.equal(cancelled.status, "done");
  assert.equal(cancelled.result?.stopped, true);
  assert.equal(cancelled.attempts, 0);
  assert.equal(cancelled.errorAttempts, 0);
  assert.equal((await fixture.runs.getByDedupKey(pending.dedupKey!))!.id, pending.id);
  await assert.rejects(
    fixture.service.control(human(fixture), { memberId: b!.id, command: "resume" }),
    /cannot resume/,
  );
  assert.ok((await fixture.service.inspect(human(fixture))).peers.length);
  assert.ok((await fixture.service.read(human(fixture), {})).length);
});

test("a claimed but unstarted paused run parks without consuming claims or errors and resumes identically", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "worker", text: "Work" });
  await fixture.service.sweep();
  const queued = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  const original = structuredClone(queued.request);
  const { processRun } = await import("../src/runs/worker.ts");
  for (let i = 0; i < 6; i++) {
    const claimed = (await fixture.runs.claimById(queued.id, "race", 60_000))!;
    assert.equal(claimed.attempts, 1);
    await fixture.service.control(human(fixture), { memberId: member!.id, command: "pause" });
    const outcome = await processRun(
      {
        runs: fixture.runs,
        leaseTtlMs: 60_000,
        orchestrator: {
          handleTurn: async (input: import("../src/core/orchestrator.ts").OrchestratorInput) => {
            await fixture.service.binding(input);
            throw new Error("must not execute paused work");
          },
        } as never,
      },
      claimed,
    );
    assert.equal(outcome.status, "queued");
    assert.equal(outcome.runId, queued.id);
    const held = (await fixture.runs.get(queued.id))!;
    assert.equal(held.held, true);
    assert.deepEqual(
      await fixture.serviceOptions.signals.takeLive(queued.id),
      [],
      "control abort must not carry into a resumed claim",
    );
    assert.equal(held.status, "pending");
    assert.equal(held.attempts, 0);
    assert.equal(held.errorAttempts, 0);
    assert.deepEqual(held.request, original);
    await fixture.service.control(human(fixture), { memberId: member!.id, command: "resume" });
  }
  assert.equal((await fixture.runs.claimById(queued.id, "final", 60_000))!.attempts, 1);
});

test("pause racing provisioning preserves the reservation, refunds the attempt, and reuses the same resource", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "provision", text: "Work" });
  const create = fixture.sandboxes.create.bind(fixture.sandboxes);
  let paused = false;
  fixture.sandboxes.create = async (...args) => {
    const result = await create(...args);
    if (!paused) {
      paused = true;
      await fixture.service.control(human(fixture), { memberId: member!.id, command: "pause" });
    }
    return result;
  };
  await fixture.service.sweep();
  const held = (await fixture.store.get(fixture.root.id))!.members.find((item) => item.id === member!.id)!;
  assert.equal(held.state, "reserved");
  assert.equal(held.attempts, 0);
  assert.equal(held.cleanupPending, undefined);
  assert.equal((await fixture.runs.inFlightForThread(member!.threadRef)).length, 0);
  await fixture.service.control(human(fixture), { memberId: member!.id, command: "resume" });
  await fixture.service.sweep();
  assert.equal(
    (await fixture.store.get(fixture.root.id))!.members.find((item) => item.id === member!.id)!.state,
    "ready",
  );
  assert.equal(fixture.provisioned.length, 1);
});

test("disabled execution is read-only and already queued work cannot bypass binding", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "disabled", text: "Work" });
  await fixture.service.sweep();
  await fixture.service.character(fixture.caller, { version: 0, name: "Read only", character: {} });
  const { createSwarmService } = await import("../src/swarms/swarm-service.ts");
  const disabled = createSwarmService({ ...fixture.serviceOptions, enabled: () => false });
  assert.equal((await disabled.inspect(human(fixture))).executionEnabled, false);
  assert.ok((await disabled.read(human(fixture), {})).length);
  assert.ok((await disabled.discover(human(fixture))).peers.length);
  await assert.rejects(disabled.spawn(human(fixture), { requestId: "no", text: "No" }), /disabled/);
  await assert.rejects(disabled.context(human(fixture), { changed: true }), /paused/);
  await assert.rejects(disabled.character(human(fixture), { version: 1, name: "No", character: {} }), /paused/);
  const queued = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  const claim = (await fixture.runs.claimById(queued.id, "disabled", 60_000))!;
  await assert.rejects(
    disabled.binding({ ...claim.request, runId: claim.id, runLeaseToken: claim.leaseToken!, attempt: claim.attempts }),
    /paused/,
  );
  assert.equal((await fixture.runs.get(queued.id))!.held, true);
  await fixture.service.sweep();
  assert.ok(await fixture.runs.claimById(queued.id, "enabled", 60_000));
});

for (const side of ["source", "recipient"] as const) {
  test(`public ${side} pause gates already queued foreign work; resume releases only eligible work`, async () => {
    const alice = await swarmFixture();
    const bob = await swarmFixture({ actorId: "bob", store: alice.store, sessions: alice.sessions, runs: alice.runs });
    await alice.service.character(alice.caller, { version: 0, name: "Source", character: {} });
    const recipient = await bob.service.character(bob.caller, { version: 0, name: "Target", character: {} });
    const message = await alice.service.publish(alice.caller, {
      requestId: "cross-control",
      audience: [recipient.id],
      text: "Public",
    });
    await alice.service.sweep();
    const queued = (await alice.runs.getByDedupKey(`swarm:${message.id}:${recipient.id}`))!;
    const controlled = side === "source" ? alice : bob;
    await controlled.service.control(human(controlled), { memberId: controlled.root.id, command: "pause" });
    assert.equal((await alice.runs.get(queued.id))!.held, true);
    const other = side === "source" ? bob : alice;
    await other.service.control(human(other), { memberId: other.root.id, command: "pause" });
    await controlled.service.control(human(controlled), { memberId: controlled.root.id, command: "resume" });
    assert.equal((await alice.runs.get(queued.id))!.held, true);
    await other.service.control(human(other), { memberId: other.root.id, command: "resume" });
    assert.equal((await alice.runs.get(queued.id))!.held, false);
    assert.equal((await alice.runs.get(queued.id))!.attempts, 0);
  });
}

test("pause racing a claim and a concurrent resume cannot strand held work or carry a stale abort", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "race", text: "Work" });
  await fixture.service.sweep();
  const queued = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  const claimed = (await fixture.runs.claimById(queued.id, "race", 60_000))!;
  await fixture.service.control(human(fixture), { memberId: member!.id, command: "pause" });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const setHeld = fixture.runs.setHeld.bind(fixture.runs);
  fixture.runs.setHeld = async (...args) => {
    if (args[2]) {
      entered.resolve();
      await release.promise;
    }
    return setHeld(...args);
  };
  const input = {
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  };
  const parked = assert.rejects(fixture.service.binding(input), /paused/);
  await entered.promise;
  const resumed = fixture.service.control(human(fixture), { memberId: member!.id, command: "resume" });
  release.resolve();
  await parked;
  await resumed;
  assert.equal((await fixture.runs.get(queued.id))!.held, false);
  assert.deepEqual(await fixture.serviceOptions.signals.takeLive(queued.id), []);
  assert.equal((await fixture.runs.claimById(queued.id, "resumed", 60_000))!.attempts, 1);
});

test("expiry retires held work without resetting the work deadline or retry accounting", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "expiry", text: "Work" });
  await fixture.service.sweep();
  const queued = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  await fixture.service.control(human(fixture), { memberId: member!.id, command: "pause" });
  await fixture.store.update(fixture.root.id, (swarm) => {
    swarm.expiresAt = Date.now() - 1;
  });
  await fixture.service.sweep();
  const retired = (await fixture.runs.get(queued.id))!;
  assert.equal(retired.status, "done");
  assert.equal(retired.result?.stopped, true);
  assert.equal(retired.attempts, 0);
  await assert.rejects(
    fixture.service.control(human(fixture), { memberId: member!.id, command: "resume" }),
    /cannot resume/,
  );
});

test("a resumed binding clears crash-left control aborts but never a user's stop or steer", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "abort-recovery", text: "Work" });
  await fixture.service.sweep();
  const pending = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  const signals = fixture.serviceOptions.signals;
  await signals.send(pending.id, {
    kind: "abort",
    dedupeKey: `swarm-control:${fixture.root.id}:${pending.id}:old-claim`,
  });
  await signals.send(pending.id, { kind: "abort", dedupeKey: "human-stop" });
  await signals.send(pending.id, { kind: "steer", text: "Keep this", dedupeKey: "human-steer" });
  const claimed = (await fixture.runs.claimById(pending.id, "recovered", 60_000))!;
  assert.ok(
    await fixture.service.binding({
      ...claimed.request,
      runId: claimed.id,
      runLeaseToken: claimed.leaseToken!,
      attempt: claimed.attempts,
    }),
  );
  const remaining = await signals.takePending(pending.id);
  assert.deepEqual(
    remaining.map((signal) => signal.dedupeKey),
    ["human-stop", "human-steer"],
  );
});

test("an expired or disabled swarm does not permanently disable ordinary root conversations", async () => {
  const fixture = await swarmFixture();
  await fixture.service.character(fixture.caller, { version: 0, name: "Root", character: {} });
  await fixture.store.update(fixture.root.id, (swarm) => {
    swarm.expiresAt = Date.now() - 1;
  });
  const root = (await fixture.runs.get(fixture.caller.claims.runId!))!;
  const { createSwarmService } = await import("../src/swarms/swarm-service.ts");
  const disabled = createSwarmService({ ...fixture.serviceOptions, enabled: () => false });
  assert.equal(
    await disabled.binding({
      ...root.request,
      runId: root.id,
      runLeaseToken: root.leaseToken!,
      attempt: root.attempts,
    }),
    null,
  );
  await fixture.service.control(human(fixture), { memberId: fixture.root.id, command: "stop" });
  await assert.rejects(
    disabled.binding({ ...root.request, runId: root.id, runLeaseToken: root.leaseToken!, attempt: root.attempts }),
    /stopped/,
  );
});

test("a crash after holding disabled work leaves a durable reconciliation marker for re-enable", async () => {
  const fixture = await swarmFixture();
  const [member] = await fixture.service.spawn(fixture.caller, { requestId: "hold-crash", text: "Work" });
  await fixture.service.sweep();
  const pending = (await fixture.runs.inFlightForThread(member!.threadRef))[0]!;
  const claim = (await fixture.runs.claimById(pending.id, "crash", 60_000))!;
  const { createSwarmService } = await import("../src/swarms/swarm-service.ts");
  const disabled = createSwarmService({ ...fixture.serviceOptions, enabled: () => false });
  const setHeld = fixture.runs.setHeld.bind(fixture.runs);
  fixture.runs.setHeld = async (...args) => {
    const applied = await setHeld(...args);
    if (args[2]) throw new Error("injected lost hold acknowledgment");
    return applied;
  };
  await assert.rejects(
    disabled.binding({ ...claim.request, runId: claim.id, runLeaseToken: claim.leaseToken!, attempt: claim.attempts }),
    /lost hold acknowledgment/,
  );
  assert.equal((await fixture.runs.get(pending.id))!.held, true);
  assert.equal((await fixture.store.get(fixture.root.id))!.controlsPending, true);
  fixture.runs.setHeld = setHeld;
  const restarted = createSwarmService(fixture.serviceOptions);
  await restarted.sweep();
  assert.ok(await fixture.runs.claimById(pending.id, "recovered", 60_000));
});

for (const command of ["pause", "stop"] as const) {
  test(`${command} preserves later human root turns without reopening agent work`, async () => {
    const f = await swarmFixture();
    const [worker] = await f.service.spawn(f.caller, { requestId: "root-control", text: "Worker task" });
    await f.service.sweep();
    const original = (await f.runs.get(f.caller.claims.runId!))!;
    await f.service.control(human(f), { memberId: f.root.id, command, subtree: true });
    assert.ok((await f.serviceOptions.signals.takePending(original.id)).some((s) => s.kind === "abort"));
    await f.runs.complete(original.id, original.leaseToken!, { status: "ok", stopped: true });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const { run: fresh } = await f.runs.enqueue({ sessionId: f.root.threadRef, request: original.request });
    await f.service.sweep();
    assert.equal((await f.runs.get(fresh.id))!.status, "pending");
    assert.equal(Boolean((await f.runs.get(fresh.id))!.held), false);
    const claim = (await f.runs.claimById(fresh.id, "human", 60_000))!;
    assert.ok(claim);
    assert.equal(
      await f.service.binding({ ...claim.request, runId: claim.id, runLeaseToken: claim.leaseToken! }),
      null,
    );
    await f.service.sweep();
    assert.equal((await f.serviceOptions.signals.takePending(fresh.id)).length, 0);
    await assert.rejects(f.service.spawn(human(f), { requestId: "cannot-reopen", text: "No" }), /paused|stopped/);
    const { run: automation } = await f.runs.enqueue({
      sessionId: f.root.threadRef,
      request: { ...original.request, origin: { kind: "automation" } },
    });
    await f.service.sweep();
    const gated = (await f.runs.get(automation.id))!;
    assert.ok(gated.held || gated.result?.stopped);
    assert.equal(
      (await f.service.inspect(human(f))).effectiveStates[worker!.id],
      command === "pause" ? "paused" : "stopped",
    );
  });
}
