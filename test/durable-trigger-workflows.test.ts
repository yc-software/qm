import assert from "node:assert/strict";
import { test } from "node:test";
import { createSecretDropStore, type SecretDropRecord } from "../src/credentials/secret-drop.ts";
import { createKeychain } from "../src/credentials/keychain.ts";
import { createKeychainResolutionTasks } from "../src/triggers/keychain-ask.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createHmac } from "node:crypto";
import { SuspendTask } from "absurd-sdk";
import { createDurableTasks, type DurableTaskContext } from "../src/durable/tasks.ts";
import { createLoopFireService, type LoopFireDeps } from "../src/loops/loop-fire.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { createWebhookReceiver } from "../src/webhooks/webhook-receiver.ts";
import { createWebhookStore } from "../src/webhooks/webhook-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

const owner = { owner: "U1", createdBy: "U1", ownerScopeId: scopeId("personal", "U1") };

function trigger(run: (request: TurnRequest) => Promise<TurnResult>) {
  return {
    identity: createIdentityService(),
    idempotency: createIdempotencyStore(),
    deliveries: createDeliveryStore(),
    run,
  };
}

async function loops(
  respond?: (request: TurnRequest) => TurnResult | Promise<TurnResult>,
  sources?: LoopFireDeps["sources"],
) {
  const tasks = createDurableTasks({ queue: "qm_loops" });
  const stores = {
    loops: createLoopStore(),
    crons: createCronStore(),
    items: createLoopItemLedger(),
    outputs: createLoopOutputStore(),
    grants: createShipGrantStore(),
  };
  const turns: TurnRequest[] = [];
  const deps = {
    ...stores,
    tasks,
    ...(sources ? { sources } : {}),
    trigger: trigger(async (request) => {
      turns.push(request);
      if (respond) return respond(request);
      const text = request.text ?? "";
      let reply = "Sent the reply.";
      if (text.startsWith("[Loop intake]")) reply = '[{"sourceKey":"one"}]';
      else if (text.startsWith("[Loop work]")) reply = '{"outputs":[{"shipAction":"send","title":"Prepared reply"}]}';
      else if (text.startsWith("[Loop judge]")) reply = '{"outcome":"met","reason":"ready"}';
      return { status: "ok", reply, sessionId: `session-${turns.length}` };
    }),
  };
  const fire = createLoopFireService(deps);
  const { loop } = await stores.loops.create({
    ...owner,
    name: "Inbox",
    playbook: "Prepare replies",
    successCondition: "Ready to send",
    shipActions: [{ action: "send", gate: "hold" }],
  });
  const worker = tasks.start({ pollIntervalMs: 1 });
  return { ...stores, tasks, fire, loop, turns, close: () => worker.stop() };
}

test("a loop resumes after a committed item write without repeating its work turn", async (t) => {
  const world = await loops();
  t.after(world.close);
  const recordRun = world.items.recordRun.bind(world.items);
  let interrupted = false;
  world.items.recordRun = async (...args) => {
    const value = await recordRun(...args);
    if (!interrupted) {
      interrupted = true;
      throw new SuspendTask();
    }
    return value;
  };
  const result = await world.fire.fire(world.loop.id, "fire-recovery");
  assert.equal(result.status, "ok");
  assert.equal(world.turns.filter((request) => request.text?.startsWith("[Loop work]")).length, 1);
  assert.equal((await world.items.byLoop(world.loop.id))[0]?.attempts, 1);
  assert.equal((await world.outputs.awaitingReview(world.loop.id)).length, 1);
});

test("a shipping task completes item state after its output update loses acknowledgement", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.fire.fire(world.loop.id, "prepare-ship");
  const [output] = await world.outputs.awaitingReview(world.loop.id);
  const complete = world.outputs.completeShipping.bind(world.outputs);
  let interrupted = false;
  world.outputs.completeShipping = async (...args) => {
    const value = await complete(...args);
    if (!interrupted) {
      interrupted = true;
      throw new SuspendTask();
    }
    return value;
  };
  const shipped = await world.fire.shipOutput(world.loop.id, output!.id, owner.owner);
  assert.equal(shipped?.state, "shipped");
  assert.equal((await world.items.get(output!.itemId))?.status, "shipped");
  assert.equal(world.turns.filter((request) => request.text?.startsWith("[Loop ship]")).length, 1);
});

test("a follow-up recovers its proposal and appends one answer after a committed thread write", async (t) => {
  const world = await loops(() => ({
    status: "ok",
    reply: 'Shortened it.\n```json\n{"proposal":{"body":"Short"}}\n```',
  }));
  t.after(world.close);
  const { item } = await world.items.enqueue({ loopId: world.loop.id, sourceKey: "followup" });
  await world.items.setProposal(item.id, { data: { body: "Long version" }, by: "human" });
  const append = world.items.appendThread.bind(world.items);
  let interrupted = false;
  world.items.appendThread = async (...args) => {
    const value = await append(...args);
    if (!interrupted && args[1].some((message) => message.role === "agent")) {
      interrupted = true;
      throw new SuspendTask();
    }
    return value;
  };
  const updated = await world.fire.followUp(world.loop, item, "Make it shorter", owner.owner);
  assert.equal(updated?.proposal?.data.body, "Short");
  assert.deepEqual(
    updated?.thread?.map((message) => message.role),
    ["human", "agent"],
  );
  assert.equal(world.turns.length, 1);
});

test("webhook acceptance persists a task before returning and finalization replays the saved turn", async (t) => {
  const tasks = createDurableTasks({ queue: "qm_triggers" });
  const webhooks = createWebhookStore();
  let calls = 0;
  const deps = trigger(async () => {
    calls++;
    return { status: "ok", reply: "Handled" };
  });
  const receiver = createWebhookReceiver({ ...deps, tasks, webhooks });
  const webhook = await webhooks.create({
    ...owner,
    action: "Handle event",
    verification: { scheme: "github", secret: "secret" },
  });
  const rawBody = '{"action":"opened"}';
  const request = {
    rawBody,
    headers: {
      "x-hub-signature-256": `sha256=${createHmac("sha256", "secret").update(rawBody).digest("hex")}`,
      "x-github-delivery": "delivery-one",
      "x-github-event": "issues",
      "content-type": "application/json",
    },
  };
  const recordFire = webhooks.recordFire.bind(webhooks);
  let interrupted = false;
  webhooks.recordFire = async (...args) => {
    if (!interrupted) {
      interrupted = true;
      throw new SuspendTask();
    }
    await recordFire(...args);
  };
  assert.deepEqual(await receiver.deliver(webhook.id, request), { status: 202 });
  assert.equal(calls, 0);
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  for (let i = 0; i < 100 && !(await webhooks.get(webhook.id))?.lastFiredAt; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.ok((await webhooks.get(webhook.id))?.lastFiredAt);
});

test("cron admission recovers a manual fire recorded before task enqueue fails", async (t) => {
  const tasks = createDurableTasks({ queue: "qm_triggers" });
  const crons = createCronStore();
  let calls = 0;
  const scheduler = createScheduler({
    ...trigger(async () => {
      calls++;
      return { status: "ok", reply: "Finished" };
    }),
    tasks,
    crons,
  });
  const cron = await crons.create({ ...owner, action: "Do work", schedule: { everyMs: 60_000 } });
  const spawn = tasks.spawn.bind(tasks);
  let interrupted = false;
  tasks.spawn = async (...args) => {
    if (!interrupted && args[0] === "cron.fire") {
      interrupted = true;
      throw new Error("enqueue connection lost");
    }
    return spawn(...args);
  };
  await assert.rejects(scheduler.runNow(cron.id), /enqueue connection lost/);
  const pending = (await crons.listFires(cron.id)).runs[0]!;
  assert.equal(pending.status, "running");
  await scheduler.tick();
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  const recovered = await spawn("cron.fire", {}, { idempotencyKey: pending.fireKey });
  await tasks.result(recovered.taskId);
  assert.equal(calls, 1);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "ok");
});

test("a durable busy cron uses current lateness when deciding whether to defer again", async (t) => {
  const tasks = createDurableTasks({ queue: "qm_triggers" });
  const crons = createCronStore();
  let now = Date.now();
  const register = tasks.register.bind(tasks);
  tasks.register = <P, R>(name: string, handler: (context: DurableTaskContext, params: P) => Promise<R>) =>
    register<P, R>(name, (context, params) =>
      handler(
        {
          ...context,
          sleepFor: async () => {
            now += 601_000;
          },
        },
        params,
      ),
    );
  let calls = 0;
  const scheduler = createScheduler({
    ...trigger(async () => {
      calls++;
      return { status: "refused", refusalKind: "session_busy" };
    }),
    tasks,
    crons,
    now: () => now,
  });
  const cron = await crons.create({ ...owner, action: "Do work", schedule: { everyMs: 60_000, firstFireAt: now } });
  const receipts: string[] = [];
  const spawn = tasks.spawn.bind(tasks);
  tasks.spawn = async (...args) => {
    const receipt = await spawn(...args);
    if (args[0] === "cron.fire") receipts.push(receipt.taskId);
    return receipt;
  };
  await scheduler.tick();
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  await tasks.result(receipts[0]!);
  assert.equal(calls, 2);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "refused");
  assert.equal((await crons.get(cron.id))?.lastFiredAt, now);
});

for (const boundary of ["enqueue", "proposal", "promote", "ready", "outcome"] as const) {
  test(`loop ${boundary} writes replay after losing acknowledgement`, async (t) => {
    const world = await loops();
    t.after(world.close);
    const loseAcknowledgement = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => {
      let interrupted = false;
      return async (...args: A) => {
        const value = await fn(...args);
        if (!interrupted) {
          interrupted = true;
          throw new SuspendTask();
        }
        return value;
      };
    };
    if (boundary === "enqueue") world.items.enqueue = loseAcknowledgement(world.items.enqueue);
    if (boundary === "promote") world.outputs.promoteAttempt = loseAcknowledgement(world.outputs.promoteAttempt);
    if (boundary === "ready") world.items.markReady = loseAcknowledgement(world.items.markReady);
    if (boundary === "outcome") world.loops.recordFireOutcome = loseAcknowledgement(world.loops.recordFireOutcome);
    if (boundary === "proposal") {
      const { item } = await world.items.enqueue({ loopId: world.loop.id, sourceKey: "proposal" });
      const proposal = { data: { body: "Draft" }, by: "human" as const };
      const first = await world.items.setProposal(item.id, proposal, { operationId: "same-operation" });
      const second = await world.items.setProposal(item.id, proposal, { operationId: "same-operation" });
      assert.equal(second?.proposal?.at, first?.proposal?.at);
      assert.equal(second?.workflowOperations?.filter((id) => id === "same-operation").length, 1);
      return;
    }
    const result = await world.fire.fire(world.loop.id, `recover-${boundary}`);
    assert.equal(result.status, "ok");
    const [item] = await world.items.byLoop(world.loop.id);
    assert.equal(item?.attempts, 1);
    assert.equal(item?.status, "ready");
    assert.equal((await world.outputs.awaitingReview(world.loop.id)).length, 1);
    assert.equal((await world.loops.get(world.loop.id))?.fireOutcomeOperations?.length, 1);
    assert.equal(world.turns.length, 3);
  });
}

test("an uncertain source send is not repeated on task replay or a revised draft", async (t) => {
  let sends = 0;
  const world = await loops(undefined, {
    tokens: { connectorAccessToken: async () => "token" },
    fetchImpl: async () => {
      sends++;
      return new Response("{}", { status: 200 });
    },
  });
  t.after(world.close);
  await world.items.ingest([
    {
      loopId: world.loop.id,
      dedupeKey: "gmail-message",
      source: "gmail",
      sourcePayload: { gmail: { threadId: "thread", to: ["reader@example.com"] } },
      proposal: { data: { body: "Reply" }, by: "human" },
    },
  ]);
  const [item] = await world.items.byLoop(world.loop.id);
  const finish = world.items.finishSourceAction;
  let interrupted = false;
  world.items.finishSourceAction = async (...args) => {
    if (!interrupted) {
      interrupted = true;
      throw new SuspendTask();
    }
    await finish(...args);
  };
  const result = await world.fire.sourceAction!(world.loop, item!, "send", {}, "human");
  assert.equal(result.ok, false);
  assert.equal(sends, 1);
  let current = (await world.items.get(item!.id))!;
  assert.ok(Object.values(current.sourceActions ?? {}).some((receipt) => receipt.state === "uncertain"));
  assert.match(current.thread?.at(-1)?.text ?? "", /may have completed/);
  current = (await world.items.setProposal(current.id, { data: { body: "New reply" }, by: "human" }))!;
  assert.equal((await world.fire.sourceAction!(world.loop, current, "send", {}, "human")).ok, false);
  assert.equal(sends, 1);
  await world.items.recordAction(current.id, { kind: "replied", outcome: "dismissed", result: "Verified in Gmail" });
  current = (await world.items.reopen(current.id))!;
  assert.equal((await world.fire.sourceAction!(world.loop, current, "send", {}, "human")).ok, true);
  assert.equal(sends, 2);
});

test("secret drop acceptance recovers encrypted input without repeating credential save or granting twice", async (t) => {
  const tasks = createDurableTasks({ queue: "qm_triggers" });
  const key = deriveConnectorKey("durable-drop-test-key");
  const backing = createMemoryMap<SecretDropRecord>();
  const drops = createSecretDropStore(backing, { key, tasks });
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key,
  });
  createKeychainResolutionTasks({
    ...trigger(async () => ({ status: "ok", reply: "Saved" })),
    keychain,
    secretDrops: drops,
    tasks,
    authorizeDrop: async () => true,
  });
  const { dropId } = await drops.mint({
    ownerId: owner.owner,
    requestedBy: owner.owner,
    service: "github",
    purpose: "Finish work",
    audienceScopeId: scopeId("channel", "C1"),
    grantMode: "once",
  });
  const spawn = tasks.spawn.bind(tasks);
  let failedAdmission = false;
  tasks.spawn = async (...args) => {
    if (!failedAdmission && args[0] === "keychain.drop-redeem") {
      failedAdmission = true;
      throw new Error("acceptance acknowledgement lost");
    }
    return spawn(...args);
  };
  await assert.rejects(drops.submit!(dropId, { secret: "never-store-this-plaintext" }), /acknowledgement lost/);
  assert.doesNotMatch(JSON.stringify(await backing.all()), /never-store-this-plaintext/);
  assert.equal((await drops.peek(dropId)).ok, false);
  const pending = (await drops.submission(dropId))!.rec;
  assert.equal((await drops.siblings({ ...pending, service: "other" })).length, 1);
  const save = keychain.save;
  const grant = keychain.createGrant;
  let saved = false;
  let granted = false;
  keychain.save = async (input) => {
    const value = await save(input);
    if (!saved) {
      saved = true;
      throw new SuspendTask();
    }
    return value;
  };
  keychain.createGrant = async (input) => {
    const value = await grant(input);
    if (!granted) {
      granted = true;
      throw new SuspendTask();
    }
    return value;
  };
  await drops.recoverSubmissions();
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  const receipt = await spawn("keychain.drop-redeem", { dropId }, { idempotencyKey: `drop-redeem:${dropId}` });
  const credential = await tasks.result<{ id: string }>(receipt.taskId);
  assert.ok(credential.id);
  assert.equal((await drops.submission(dropId))?.input, undefined);
  assert.equal((await drops.siblings({ ...pending, service: "other" })).length, 0);
  const active = await keychain.listGrants({ audienceScopeId: scopeId("channel", "C1") });
  assert.equal(active.length, 1);
  assert.equal(active[0]?.credentialId, credential.id);
});

test("reenabled cron resumes after its disabled scheduled task completed", async (t) => {
  const tasks = createDurableTasks({ queue: "qm_triggers" });
  const crons = createCronStore();
  let calls = 0;
  const scheduler = createScheduler({
    ...trigger(async () => {
      calls++;
      return { status: "ok" };
    }),
    tasks,
    crons,
  });
  const cron = await crons.create({
    ...owner,
    action: "Do work",
    schedule: { everyMs: 60_000, firstFireAt: Date.now() - 1 },
  });
  const taskIds: string[] = [];
  const spawn = tasks.spawn.bind(tasks);
  tasks.spawn = async (...args) => {
    const receipt = await spawn(...args);
    if (args[0] === "cron.fire") taskIds.push(receipt.taskId);
    return receipt;
  };
  await scheduler.tick();
  await crons.setEnabled(cron.id, false);
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  await tasks.result(taskIds[0]!);
  await crons.setEnabled(cron.id, true);
  await scheduler.tick();
  await tasks.result(taskIds.at(-1)!);
  assert.equal(calls, 1);
});

test("paused loop does not execute shipping after replay", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.fire.fire(world.loop.id, "prepare-pause");
  const [output] = await world.outputs.awaitingReview(world.loop.id);
  const begin = world.outputs.beginShipAttempt.bind(world.outputs);
  let interrupted = false;
  world.outputs.beginShipAttempt = async (...args) => {
    const value = await begin(...args);
    if (!interrupted) {
      interrupted = true;
      await world.loops.setState(world.loop.id, "paused");
      throw new SuspendTask();
    }
    return value;
  };
  await world.fire.shipOutput(world.loop.id, output!.id, owner.owner);
  assert.equal(world.turns.filter((request) => request.text?.startsWith("[Loop ship]")).length, 0);
  assert.equal((await world.items.get(output!.itemId))?.decisionToken, undefined);
  assert.equal((await world.outputs.get(output!.id))?.state, "ready");
  await world.loops.setState(world.loop.id, "enabled");
  assert.equal((await world.fire.shipOutput(world.loop.id, output!.id, owner.owner))?.state, "shipped");
});

test("source action retries after account is connected", async (t) => {
  let connected = false;
  let sends = 0;
  const world = await loops(undefined, {
    tokens: { connectorAccessToken: async () => (connected ? "token" : null) },
    fetchImpl: async () => {
      sends++;
      return new Response("{}", { status: 200 });
    },
  });
  t.after(world.close);
  await world.items.ingest([
    {
      loopId: world.loop.id,
      dedupeKey: "gmail-message",
      source: "gmail",
      sourcePayload: { gmail: { threadId: "thread", to: ["reader@example.com"] } },
      proposal: { data: { body: "Reply" }, by: "human" },
    },
  ]);
  const [item] = await world.items.byLoop(world.loop.id);
  const first = await world.fire.sourceAction!(world.loop, item!, "send", {}, "human");
  assert.equal(first.ok, false);
  connected = true;
  const second = await world.fire.sourceAction!(world.loop, (await world.items.get(item!.id))!, "send", {}, "human");
  assert.equal(second.ok, true);
  assert.equal(sends, 1);
});

test("revoking an auto-ship grant during replay releases the output for human review", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.grants.put({
    id: "auto",
    loopId: world.loop.id,
    shipAction: "send",
    actorId: owner.owner,
    policyVersion: 1,
    createdAt: Date.now(),
  });
  const begin = world.outputs.beginShipAttempt.bind(world.outputs);
  let interrupted = false;
  world.outputs.beginShipAttempt = async (...args) => {
    const value = await begin(...args);
    if (!interrupted) {
      interrupted = true;
      await world.grants.revoke("auto", owner.owner);
      throw new SuspendTask();
    }
    return value;
  };
  await world.fire.fire(world.loop.id, "auto-revoked");
  const [output] = await world.outputs.awaitingReview(world.loop.id);
  assert.ok(output);
  assert.equal((await world.items.get(output.itemId))?.decisionToken, undefined);
  assert.equal(world.turns.filter((request) => request.text?.startsWith("[Loop ship]")).length, 0);
  assert.equal((await world.fire.shipOutput(world.loop.id, output.id, owner.owner))?.state, "shipped");
});

test("a failed shipping turn settles its workflow instead of retrying its cached failure forever", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.fire.fire(world.loop.id, "prepare-failure");
  const [output] = await world.outputs.awaitingReview(world.loop.id);
  const stores = { loops: world.loops, items: world.items, outputs: world.outputs, grants: world.grants };
  const failedTasks = createDurableTasks({ queue: "failed-ship" });
  const fire = createLoopFireService({
    ...stores,
    tasks: failedTasks,
    trigger: trigger(async () => ({ status: "failed", reason: "upstream unavailable" })),
  });
  const worker = failedTasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  await assert.rejects(fire.shipOutput(world.loop.id, output!.id, owner.owner), /upstream unavailable/);
  assert.equal((await world.outputs.get(output!.id))?.state, "ready");
  assert.equal((await world.items.get(output!.itemId))?.decisionToken, undefined);
});

test("explicit item actions can retry a failed turn and never repeat a completed action", async (t) => {
  let calls = 0;
  const world = await loops(() => {
    calls++;
    return calls === 1 ? { status: "failed", reason: "service unavailable" } : { status: "ok", reply: "Done" };
  });
  t.after(world.close);
  const { item } = await world.items.enqueue({ loopId: world.loop.id, sourceKey: "retry-action" });
  await world.items.setProposal(item.id, { data: { body: "Draft" }, by: "human" });
  const proposed = (await world.items.get(item.id))!;
  assert.equal((await world.fire.itemAction(world.loop, proposed, "run", {}, owner.owner)).ok, false);
  assert.equal((await world.fire.itemAction(world.loop, proposed, "run", {}, owner.owner)).ok, true);
  assert.equal((await world.fire.itemAction(world.loop, proposed, "run", {}, owner.owner)).ok, false);
  assert.equal(calls, 2);
});

test("an accepted source action rechecks owner authorization before using connector credentials", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.items.ingest([
    {
      loopId: world.loop.id,
      dedupeKey: "revoked-owner",
      source: "gmail",
      sourcePayload: { gmail: { threadId: "thread", to: ["reader@example.com"] } },
      proposal: { data: { body: "Reply" }, by: "human" },
    },
  ]);
  const [item] = await world.items.byLoop(world.loop.id);
  const tasks = createDurableTasks({ queue: "source-auth" });
  const identity = createIdentityService();
  let sends = 0;
  const fire = createLoopFireService({
    loops: world.loops,
    items: world.items,
    outputs: world.outputs,
    grants: world.grants,
    tasks,
    trigger: { ...trigger(async () => ({ status: "ok" })), identity },
    sources: {
      tokens: { connectorAccessToken: async () => "token" },
      fetchImpl: async () => {
        sends++;
        return new Response("{}", { status: 200 });
      },
    },
  });
  const pending = fire.sourceAction!(world.loop, item!, "send", {}, "human");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await identity.deactivate(owner.owner);
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  assert.equal((await pending).ok, false);
  assert.equal(sends, 0);
  assert.equal((await world.items.get(item!.id))?.decisionToken, undefined);
});

test("replaying a fire after its governor notification does not publish another notification", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.loops.update(world.loop.id, {
    caps: { maxOpenOutputs: 1 },
    destination: { type: "principal", target: owner.owner },
  });
  const tasks = createDurableTasks({ queue: "governor-replay" });
  const register = tasks.register.bind(tasks);
  let interrupted = false;
  tasks.register = <P, R>(name: string, handler: (context: DurableTaskContext, params: P) => Promise<R>) =>
    register<P, R>(name, async (context, params) => {
      const value = await handler(context, params);
      if (name === "loop.fire" && !interrupted) {
        interrupted = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new SuspendTask();
      }
      return value;
    });
  const deliveries = createDeliveryStore();
  const fire = createLoopFireService({
    loops: world.loops,
    items: world.items,
    outputs: world.outputs,
    grants: world.grants,
    tasks,
    trigger: {
      ...trigger(async (request) => {
        const input = request.text ?? "";
        let reply = '{"outcome":"met","reason":"ready"}';
        if (input.startsWith("[Loop intake]")) reply = '[{"sourceKey":"one"}]';
        else if (input.startsWith("[Loop work]")) reply = '{"outputs":[{"shipAction":"send","title":"Reply"}]}';
        return { status: "ok", reply };
      }),
      deliveries,
    },
  });
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  await fire.fire(world.loop.id, "notify-once");
  assert.equal((await deliveries.pending("principal")).length, 1);
});

test("pausing a suspended loop prevents new fire stages and releases its work claim", async (t) => {
  const world = await loops();
  t.after(world.close);
  const recordRun = world.items.recordRun.bind(world.items);
  let interrupted = false;
  world.items.recordRun = async (...args) => {
    const value = await recordRun(...args);
    if (!interrupted) {
      interrupted = true;
      await world.loops.setState(world.loop.id, "paused");
      throw new SuspendTask();
    }
    return value;
  };
  await world.fire.fire(world.loop.id, "paused-stage");
  assert.equal(world.turns.filter((request) => request.text?.startsWith("[Loop judge]")).length, 0);
  const [item] = await world.items.byLoop(world.loop.id);
  assert.equal(item?.claimToken, undefined);
});

test("a manual cron paused before task acceptance closes its fire and allows a later manual run", async (t) => {
  const tasks = createDurableTasks({ queue: "manual-cancel" });
  const crons = createCronStore();
  let calls = 0;
  const scheduler = createScheduler({
    ...trigger(async () => {
      calls++;
      return { status: "ok" };
    }),
    tasks,
    crons,
  });
  const cron = await crons.create({ ...owner, action: "Run", schedule: { everyMs: 60_000 } });
  const first = await scheduler.runNow(cron.id);
  assert.equal(first.started, true);
  if (!first.started) return;
  await crons.setEnabled(cron.id, false);
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  await first.settled;
  assert.equal((await crons.listFires(cron.id)).runs.find((fire) => fire.fireKey === first.fireKey)?.status, "refused");
  await crons.setEnabled(cron.id, true);
  const second = await scheduler.runNow(cron.id);
  assert.equal(second.started, true);
  if (second.started) await second.settled;
  assert.equal(calls, 1);
});

test("an obsolete scheduled task cannot cancel its replacement's fire history", async (t) => {
  const tasks = createDurableTasks({ queue: "cron-generation-cancel" });
  const crons = createCronStore();
  const admission: string[] = [];
  const spawn = tasks.spawn.bind(tasks);
  tasks.spawn = async (...args) => {
    const receipt = await spawn(...args);
    if (args[0] === "cron.fire") admission.push(receipt.taskId);
    return receipt;
  };
  let releaseOld!: () => void;
  let oldStarted!: () => void;
  const oldWaiting = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldEntered = new Promise<void>((resolve) => {
    oldStarted = resolve;
  });
  const register = tasks.register.bind(tasks);
  let first = true;
  tasks.register = <P, R>(name: string, handler: (context: DurableTaskContext, params: P) => Promise<R>) =>
    register<P, R>(name, async (context, params) => {
      if (name === "cron.fire" && first) {
        first = false;
        oldStarted();
        await oldWaiting;
      }
      return handler(context, params);
    });
  let runStarted!: () => void;
  let finishRun!: () => void;
  const entered = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const running = new Promise<void>((resolve) => {
    finishRun = resolve;
  });
  const scheduler = createScheduler({
    ...trigger(async () => {
      runStarted();
      await running;
      return { status: "ok" };
    }),
    tasks,
    crons,
  });
  const cron = await crons.create({
    ...owner,
    action: "Run",
    schedule: { everyMs: 60_000, firstFireAt: Date.now() - 1 },
  });
  await scheduler.tick();
  const worker = tasks.start({ concurrency: 2, pollIntervalMs: 1 });
  t.after(async () => {
    releaseOld();
    finishRun();
    await worker.stop();
  });
  await oldEntered;
  await crons.setEnabled(cron.id, false);
  await crons.setEnabled(cron.id, true);
  await scheduler.tick();
  await entered;
  releaseOld();
  await tasks.result(admission[0]!);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "running");
  finishRun();
  await tasks.result(admission[1]!);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "ok");
});

test("a retry cannot act using a decision checkpoint after another task acquired the item", async (t) => {
  const world = await loops();
  t.after(world.close);
  const { item } = await world.items.enqueue({ loopId: world.loop.id, sourceKey: "decision-retry" });
  const tasks = createDurableTasks({ queue: "decision-retry" });
  let calls = 0;
  let secondStarted!: () => void;
  let finishSecond!: () => void;
  const entered = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  const running = new Promise<void>((resolve) => {
    finishSecond = resolve;
  });
  const fire = createLoopFireService({
    loops: world.loops,
    items: world.items,
    outputs: world.outputs,
    grants: world.grants,
    tasks,
    trigger: trigger(async () => {
      calls++;
      if (calls === 1) throw new Error("temporary transport failure");
      if (calls === 2) {
        secondStarted();
        await running;
      }
      return { status: "ok", reply: "Acted" };
    }),
  });
  const worker = tasks.start({ concurrency: 2, pollIntervalMs: 1 });
  t.after(async () => {
    finishSecond();
    await worker.stop();
  });
  const firstAction = fire.itemAction(world.loop, item, "send", {}, owner.owner);
  while (calls === 0 || (await world.items.get(item.id))?.decisionToken)
    await new Promise((resolve) => setTimeout(resolve, 1));
  const secondAction = fire.itemAction(world.loop, item, "send", {}, owner.owner);
  await entered;
  const replay = await firstAction;
  assert.equal(replay.ok, false);
  assert.equal(calls, 2);
  finishSecond();
  assert.equal((await secondAction).ok, true);
});

async function bindWorkflowCron(world: Awaited<ReturnType<typeof loops>>, unattendedGrants: string[] = []) {
  const cron = await world.crons.create({
    ...owner,
    schedule: { everyMs: 60_000 },
    action: "fire loop",
    loopId: world.loop.id,
    unattendedGrants,
  });
  await world.loops.update(world.loop.id, { cronId: cron.id });
  return cron;
}

test("resumed loop stages use revoked cron grants without repeating completed stages", async (t) => {
  const world = await loops();
  t.after(world.close);
  const cron = await bindWorkflowCron(world, ["admin.sessions.read"]);
  const recordRun = world.items.recordRun.bind(world.items);
  let interrupted = false;
  world.items.recordRun = async (...args) => {
    const value = await recordRun(...args);
    if (!interrupted) {
      interrupted = true;
      await world.crons.update(cron.id, { unattendedGrants: [] });
      throw new SuspendTask();
    }
    return value;
  };
  const result = await world.fire.fire(world.loop.id, "grant-revocation", cron.id);
  assert.equal(result.status, "ok");
  assert.deepEqual(
    world.turns.map((turn) => turn.unattendedGrants),
    [["admin.sessions.read"], ["admin.sessions.read"], []],
  );
  const output = (await world.outputs.awaitingReview(world.loop.id))[0]!;
  await world.fire.shipOutput(world.loop.id, output.id, owner.owner);
  assert.deepEqual(world.turns.at(-1)?.unattendedGrants, []);
});

for (const patch of [{ enabled: false }, { archived: true }]) {
  test(`resumed privileged loops stop unexecuted stages after cron ${JSON.stringify(patch)}`, async (t) => {
    const world = await loops();
    t.after(world.close);
    const cron = await bindWorkflowCron(world, ["admin.sessions.read"]);
    const recordRun = world.items.recordRun.bind(world.items);
    let interrupted = false;
    world.items.recordRun = async (...args) => {
      const value = await recordRun(...args);
      if (!interrupted) {
        interrupted = true;
        await world.crons.update(cron.id, patch);
        throw new SuspendTask();
      }
      return value;
    };
    const result = await world.fire.fire(world.loop.id, "disabled-after-work", cron.id);
    assert.equal(result.status, "failed");
    assert.equal(world.turns.length, 2);
    assert.equal(world.turns.filter((turn) => turn.text?.startsWith("[Loop work]")).length, 1);
    assert.match(result.note ?? "", /disabled or archived/);
  });
}

test("durable scheduler delegation preserves the firing cron binding", async (t) => {
  const world = await loops();
  t.after(world.close);
  const bound = await bindWorkflowCron(world, ["admin.sessions.read"]);
  const foreign = await world.crons.create({
    ...owner,
    schedule: { everyMs: 60_000 },
    action: "fire another cron's loop",
    loopId: world.loop.id,
  });
  const tasks = createDurableTasks({ queue: "bound-cron-authority" });
  const scheduler = createScheduler({
    crons: world.crons,
    tasks,
    ...trigger(async () => {
      throw new Error("cron must delegate to loop");
    }),
    fireLoop: (loopId, fireKey, cronId) => world.fire.fire(loopId, fireKey, cronId),
  });
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  const refused = await scheduler.runNow(foreign.id);
  assert.equal(refused.started, true);
  if (refused.started) await refused.settled;
  assert.equal((await world.crons.listFires(foreign.id)).runs[0]?.status, "failed");
  assert.equal(world.turns.length, 0);
  const allowed = await scheduler.runNow(bound.id, { actorId: owner.owner, liveActor: true });
  assert.equal(allowed.started, true);
  if (allowed.started) await allowed.settled;
  assert.equal((await world.crons.listFires(bound.id)).runs[0]?.status, "ok");
  assert.equal(world.turns.length, 3);
  assert.ok(world.turns.every((turn) => turn.unattendedGrants?.[0] === "admin.sessions.read"));
});

test("queued item actions retain their actor when a live bound cron grants privilege", async (t) => {
  const world = await loops();
  t.after(world.close);
  await world.close();
  const { item } = await world.items.enqueue({ loopId: world.loop.id, sourceKey: "queued-actor" });
  const action = world.fire.itemAction(world.loop, item, "inspect", {}, "other-person", {
    actorId: "other-person",
    liveActor: true,
  });
  await bindWorkflowCron(world, ["admin.sessions.read"]);
  const worker = world.tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  const result = await action;
  assert.equal(result.ok, false);
  assert.match(result.note ?? "", /only the (?:cron )?owner/);
  assert.equal(world.turns.length, 0);
  assert.equal((await world.items.get(item.id))?.decisionToken, undefined);
});

test("queued follow-ups resolve the current loop binding instead of a captured cron", async (t) => {
  const world = await loops();
  t.after(world.close);
  const oldCron = await bindWorkflowCron(world, ["admin.sessions.read"]);
  const snapshot = (await world.loops.get(world.loop.id))!;
  const { item } = await world.items.enqueue({ loopId: world.loop.id, sourceKey: "queued-binding" });
  await world.close();
  const followUp = world.fire.followUp(snapshot, item, "inspect", owner.owner);
  const replacement = await bindWorkflowCron(world, []);
  assert.notEqual(replacement.id, oldCron.id);
  const worker = world.tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  await followUp;
  assert.equal(world.turns.length, 1);
  assert.deepEqual(world.turns[0]?.unattendedGrants, []);
});

for (const admission of ["fire", "requestFire"] as const) {
  test(`queued manual loop ${admission} retains the requesting actor if privilege is added`, async (t) => {
    const world = await loops();
    t.after(world.close);
    await world.close();
    const fireKey = `manual-actor:${admission}`;
    const requested = world.fire[admission]!(world.loop.id, fireKey, undefined, {
      actorId: "other-person",
      liveActor: true,
    });
    const cron = await bindWorkflowCron(world, ["admin.sessions.read"]);
    const worker = world.tasks.start({ pollIntervalMs: 1 });
    t.after(() => worker.stop());
    await requested;
    const { taskId } = await world.tasks.spawn("loop.fire", {}, { idempotencyKey: fireKey });
    const result = await world.tasks.result<{ status: string; note?: string }>(taskId);
    assert.equal(result.status, "failed");
    assert.match(result.note ?? "", /only the (?:cron )?owner/);
    assert.equal(world.turns.length, 0);
    const allowed = await world.fire.fire(world.loop.id, "scheduled-owner", cron.id);
    assert.equal(allowed.status, "ok");
    assert.equal(world.turns.length, 3);
  });
}

test("rebound scheduled loops finish replay bookkeeping and release their item claim", async (t) => {
  const world = await loops();
  t.after(world.close);
  const cron = await bindWorkflowCron(world, ["admin.sessions.read"]);
  const recordRun = world.items.recordRun.bind(world.items);
  let interrupted = false;
  world.items.recordRun = async (...args) => {
    const value = await recordRun(...args);
    if (!interrupted) {
      interrupted = true;
      const replacement = await world.crons.create({
        ...owner,
        schedule: { everyMs: 120_000 },
        action: "replacement fire loop",
        loopId: world.loop.id,
      });
      await world.loops.update(world.loop.id, { cronId: replacement.id });
      throw new SuspendTask();
    }
    return value;
  };
  const result = await world.fire.fire(world.loop.id, "rebound-after-work", cron.id);
  assert.equal(result.status, "failed");
  assert.match(result.note ?? "", /binding mismatch/);
  assert.equal(world.turns.length, 2);
  const [item] = await world.items.byLoop(world.loop.id);
  assert.equal(item?.claimToken, undefined);
  assert.notEqual(item?.status, "in_progress");
});

test("a completed cron run still finalizes after its initiating proof becomes insufficient", async (t) => {
  const tasks = createDurableTasks({ queue: "manual-proof-replay" });
  const crons = createCronStore();
  let calls = 0;
  const scheduler = createScheduler({
    crons,
    tasks,
    ...trigger(async () => {
      calls++;
      return { status: "ok", reply: "Finished" };
    }),
  });
  const cron = await crons.create({ ...owner, action: "Do work", schedule: { everyMs: 60_000 } });
  const record = crons.recordFire.bind(crons);
  let interrupted = false;
  crons.recordFire = async (id, entry) => {
    if (entry.status === "ok" && !interrupted) {
      interrupted = true;
      await crons.update(id, { unattendedGrants: ["admin.sessions.read"] });
      throw new SuspendTask();
    }
    await record(id, entry);
  };
  const worker = tasks.start({ pollIntervalMs: 1 });
  t.after(() => worker.stop());
  const started = await scheduler.runNow(cron.id, { actorId: owner.owner, liveActor: false });
  assert.equal(started.started, true);
  if (started.started) await started.settled;
  assert.equal(calls, 1);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "ok");
});

for (const initiator of [undefined, { actorId: owner.owner, liveActor: false }]) {
  test(`queued same-owner manual loop fires cannot gain privilege without live proof: ${JSON.stringify(initiator)}`, async (t) => {
    const world = await loops();
    t.after(world.close);
    await world.close();
    const requested = world.fire.fire(world.loop.id, "non-live-manual", undefined, initiator);
    await bindWorkflowCron(world, ["admin.sessions.read"]);
    const worker = world.tasks.start({ pollIntervalMs: 1 });
    t.after(() => worker.stop());
    assert.equal((await requested).status, "failed");
    assert.equal(world.turns.length, 0);
  });
}

test("manual loop initiating proof survives the transition from judge to auto-ship", async (t) => {
  const world = await loops();
  t.after(world.close);
  const cron = await bindWorkflowCron(world);
  await world.grants.put({
    id: "manual-auto",
    loopId: world.loop.id,
    shipAction: "send",
    actorId: owner.owner,
    policyVersion: 1,
    createdAt: Date.now(),
  });
  const begin = world.outputs.beginShipAttempt.bind(world.outputs);
  world.outputs.beginShipAttempt = async (...args) => {
    const result = await begin(...args);
    await world.crons.update(cron.id, { unattendedGrants: ["admin.sessions.read"] });
    return result;
  };
  const result = await world.fire.fire(world.loop.id, "manual-auto-proof", undefined, {
    actorId: owner.owner,
    liveActor: false,
  });
  assert.equal(result.status, "failed");
  assert.equal(world.turns.length, 3);
  assert.equal(world.turns.filter((turn) => turn.text?.startsWith("[Loop ship]")).length, 0);
  assert.equal((await world.items.byLoop(world.loop.id))[0]?.decisionToken, undefined);
});

test("an admitted output return completes bookkeeping after authority changes during replay", async (t) => {
  const world = await loops();
  t.after(world.close);
  const cron = await bindWorkflowCron(world);
  await world.fire.fire(world.loop.id, "prepare-return", cron.id);
  const output = (await world.outputs.awaitingReview(world.loop.id))[0]!;
  const returned = world.outputs.returnToLoop.bind(world.outputs);
  let interrupted = false;
  world.outputs.returnToLoop = async (...args) => {
    const value = await returned(...args);
    if (!interrupted) {
      interrupted = true;
      await world.crons.update(cron.id, { unattendedGrants: ["admin.sessions.read"] });
      throw new SuspendTask();
    }
    return value;
  };
  assert.ok(
    await world.fire.returnOutput(world.loop.id, output.id, owner.owner, "Revise", {
      actorId: owner.owner,
      liveActor: false,
    }),
  );
  const item = await world.items.get(output.itemId);
  assert.equal(item?.decisionToken, undefined);
  assert.equal(item?.status, "queued");
});

test("scheduled auto-ship retains its firing cron binding after judge completes", async (t) => {
  const world = await loops();
  t.after(world.close);
  const cron = await bindWorkflowCron(world, ["admin.sessions.read"]);
  await world.grants.put({
    id: "bound-auto",
    loopId: world.loop.id,
    shipAction: "send",
    actorId: owner.owner,
    policyVersion: 1,
    createdAt: Date.now(),
  });
  const begin = world.outputs.beginShipAttempt.bind(world.outputs);
  world.outputs.beginShipAttempt = async (...args) => {
    const result = await begin(...args);
    await bindWorkflowCron(world, []);
    return result;
  };
  const result = await world.fire.fire(world.loop.id, "rebound-auto-ship", cron.id);
  assert.equal(result.status, "failed");
  assert.equal(world.turns.length, 3);
  assert.match(result.note ?? "", /binding mismatch/);
  assert.equal((await world.items.byLoop(world.loop.id))[0]?.decisionToken, undefined);
});
