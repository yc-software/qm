import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoopFireService } from "../src/loops/loop-fire.ts";
import { createLoopStore } from "../src/loops/loop-store.ts";
import { createLoopItemLedger } from "../src/loops/item-ledger.ts";
import { createLoopOutputStore } from "../src/loops/output-store.ts";
import { createShipGrantStore } from "../src/loops/ship-grant-store.ts";
import { buildShipGrant } from "../src/loops/ship-gate.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { FACTORY_LOOP_SURFACE, type FactoryEffectsDeps } from "../src/loops/factory/effects.ts";
import { FACTORY_REQUIRED_TOOLS } from "../src/loops/factory/preflight.ts";
import { FACTORY_ANTHROPIC_SLUG, FACTORY_GITHUB_SLUG, FACTORY_LINEAR_SLUG } from "../src/loops/factory/credentials.ts";
import { FACTORY_WRAPPER } from "../src/loops/factory/process-work.ts";
import type { FactoryConfig } from "../src/resolution/config-store.ts";
import type { ServiceCredentialReader } from "../src/credentials/keychain.ts";
import type { ReadProcessResult, Sandbox, SandboxHandle } from "../src/sandbox/sandbox.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

function fakeIdentity() {
  return {
    refresh: async () => {},
    classify: () => ({ type: "internal" as const }),
  };
}

function fakeDeliveries() {
  const sent: Array<{ text: string }> = [];
  return {
    sent,
    store: {
      enqueue: async (d: { text: string }) => {
        sent.push(d);
        return { id: "d1" };
      },
    },
  };
}

type Responder = (req: TurnRequest) => string;

function service(
  respond: Responder,
  overrides?: {
    grants?: ReturnType<typeof createShipGrantStore>;
    factory?: (loops: ReturnType<typeof createLoopStore>) => FactoryEffectsDeps;
  },
) {
  const loops = createLoopStore();
  const items = createLoopItemLedger();
  const outputs = createLoopOutputStore();
  const grants = overrides?.grants ?? createShipGrantStore();
  const deliveries = fakeDeliveries();
  const turns: TurnRequest[] = [];
  const idempotency = createIdempotencyStore();
  const fire = createLoopFireService({
    loops,
    items,
    outputs,
    grants,
    trigger: {
      deliveries: deliveries.store as never,
      idempotency,
      identity: fakeIdentity() as never,
      run: async (req): Promise<TurnResult> => {
        turns.push(req);
        return { status: "ok", reply: respond(req), sessionId: `s${turns.length}` };
      },
    },
    ...(overrides?.factory ? { factory: overrides.factory(loops) } : {}),
  });
  return { loops, items, outputs, grants, fire, turns, deliveries, idempotency };
}

const base = { owner: "josh", createdBy: "josh", ownerScopeId: scopeId("personal", "josh") };

async function makeLoop(loops: ReturnType<typeof createLoopStore>, over: Record<string, unknown> = {}) {
  return loops
    .create({
      ...base,
      name: "Sentry triage",
      playbook: "triage sentry issues",
      successCondition: "a fix PR is linked",
      shipActions: [{ action: "open_pr", gate: "hold" }],
      ...over,
    } as never)
    .then(({ loop }) => loop);
}

function stage(req: TurnRequest): string {
  const text = req.text ?? "";
  if (text.startsWith("[Loop intake]")) return "intake";
  if (text.startsWith("[Loop work]")) return "work";
  if (text.startsWith("[Loop judge]")) return "judge";
  if (text.startsWith("[Loop ship]")) return "ship";
  return "other";
}

const HAPPY: Responder = (req) => {
  switch (stage(req)) {
    case "intake":
      return '```json\n[{"sourceKey": "SENTRY-1", "sourceSummary": "TypeError in checkout"}]\n```';
    case "work":
      return 'Prepared a draft PR.\n```json\n{"outputs": [{"shipAction": "open_pr", "title": "Fix TypeError", "externalRef": "https://github.com/x/pull/1", "label": "checkout"}]}\n```';
    case "judge":
      return '```json\n{"outcome": "met", "reason": "draft PR linked"}\n```';
    default:
      return "done";
  }
};

test("a fire runs intake, work, and judge turns and holds the finished output", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  const result = await s.fire.fire(loop.id, "f1");
  assert.equal(result.status, "ok");
  assert.equal(result.summary?.enqueued, 1);
  assert.deepEqual(result.summary?.ready.length, 1);
  const outputs = await s.outputs.awaitingReview(loop.id);
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0]?.title, "Fix TypeError");
  assert.equal(outputs[0]?.capturedBy, "agent");
  assert.deepEqual(s.turns.map(stage), ["intake", "work", "judge"]);
});

test("a playbook that points at its own loop reaches the agent with the real id", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    playbook: "GET $AGENT_API_URL/v1/loops/$LOOP_ID/items, then POST $AGENT_API_URL/v1/loops/$LOOP_ID/items",
  });
  await s.fire.fire(loop.id, "f1");
  for (const turn of s.turns) {
    assert.ok(!turn.text?.includes("$LOOP_ID"), `${stage(turn)} still carries the unresolved placeholder`);
  }
  const intake = s.turns.find((t) => stage(t) === "intake");
  assert.match(intake!.text!, new RegExp(`/v1/loops/${loop.id}/items`));
});

test("intake and judge are read-only while work is isolated from surface actions", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const judge = s.turns.find((t) => stage(t) === "judge");
  const work = s.turns.find((t) => stage(t) === "work");
  const intake = s.turns.find((t) => stage(t) === "intake");
  assert.equal(intake?.readOnly, true);
  assert.equal(judge?.readOnly, true);
  assert.notEqual(work?.readOnly, true);
  assert.notEqual(work?.surfaceTools, true);
  assert.notEqual(work?.addressed, true);
  assert.deepEqual(judge?.conversation, work?.conversation);
});

test("shipping a held output runs a ship turn and settles the item", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  const fired = await s.fire.fire(loop.id, "f1");
  const outputId = fired.summary!.ready[0]!;
  const outputs = await s.outputs.awaitingReview(loop.id);
  const shipped = await s.fire.shipOutput(loop.id, outputs[0]!.id, "josh");
  assert.equal(shipped?.state, "shipped");
  assert.equal(shipped?.decidedBy, "josh");
  assert.equal((await s.items.get(shipped!.itemId))?.status, "shipped");
  assert.equal(s.turns.filter((t) => stage(t) === "ship").length, 1);
  assert.equal(s.turns.find((t) => stage(t) === "ship")?.readOnly, undefined);
  assert.ok(outputId);
});

test("a ready output cannot ship unless its ready parent publishes it", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  const { item } = await s.items.enqueue({ loopId: loop.id, sourceKey: "stale" });
  const output = await s.outputs.capture({
    loopId: loop.id,
    itemId: item.id,
    attemptId: "stale-attempt",
    shipAction: "open_pr",
    title: "stale output",
    capturedBy: "ledger",
  });
  await s.outputs.promoteAttempt(item.id, "stale-attempt");
  assert.equal(await s.fire.shipOutput(loop.id, output.id, "josh"), null);
  assert.equal((await s.outputs.get(output.id))?.state, "ready");
  assert.equal(s.turns.length, 0);
});

test("returning a held output re-queues the item carrying the note, and the next fire re-works it", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  const returned = await s.fire.returnOutput(loop.id, output.id, "josh", "wrong module");
  assert.equal(returned?.state, "returned");
  const item = await s.items.get(returned!.itemId);
  assert.equal(item?.status, "queued");
  assert.equal(item?.guidance, "wrong module");
  await s.fire.fire(loop.id, "f2");
  const workPrompts = s.turns.filter((t) => stage(t) === "work").map((t) => t.text ?? "");
  assert.equal(workPrompts.length, 2);
  assert.match(workPrompts[1]!, /wrong module/);
});

test("a replayed ship operation becomes unconfirmed and a person can resolve it either way", async () => {
  for (const decision of ["shipped", "returned"] as const) {
    const s = service(HAPPY);
    const loop = await makeLoop(s.loops);
    await s.fire.fire(loop.id, `fire-${decision}`);
    const output = (await s.outputs.awaitingReview(loop.id))[0]!;
    await s.idempotency.once(`loop:${loop.id}:ship:${output.id}`, async () => {});
    const uncertain = await s.fire.shipOutput(loop.id, output.id, "josh");
    assert.equal(uncertain?.state, "unconfirmed");
    assert.equal((await s.items.get(output.itemId))?.status, "ready");
    const resolved =
      decision === "shipped"
        ? await s.fire.shipOutput(loop.id, output.id, "josh", "confirmed externally")
        : await s.fire.returnOutput(loop.id, output.id, "josh", "retry safely");
    assert.equal(resolved?.state, decision);
  }
});

test("returning one output supersedes active siblings before requeueing the item", async () => {
  const two: Responder = (req) =>
    stage(req) === "work"
      ? '```json\n{"outputs": [{"shipAction": "open_pr", "title": "one", "externalRef": "1"}, {"shipAction": "open_pr", "title": "two", "externalRef": "2"}]}\n```'
      : HAPPY(req);
  const s = service(two);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const outputs = await s.outputs.awaitingReview(loop.id);
  await s.fire.returnOutput(loop.id, outputs[0]!.id, "josh", "redo all");
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
  assert.equal((await s.outputs.get(outputs[1]!.id))?.state, "superseded");
  assert.equal((await s.items.get(outputs[0]!.itemId))?.status, "queued");
});

test("an item decision lease serializes shipping and returning", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  const token = await s.items.acquireDecision(output.itemId);
  assert.ok(token);
  assert.equal(await s.fire.returnOutput(loop.id, output.id, "josh", "retry"), null);
  assert.equal((await s.items.get(output.itemId))?.status, "ready");
  assert.equal(await s.items.releaseDecision(output.itemId, token), true);
  assert.equal((await s.fire.returnOutput(loop.id, output.id, "josh", "retry"))?.state, "returned");
});

test("confirming an unconfirmed output requires its ready parent to publish it", async () => {
  for (const invalid of ["parent", "membership"] as const) {
    const s = service(HAPPY);
    const loop = await makeLoop(s.loops);
    const { item } = await s.items.enqueue({ loopId: loop.id, sourceKey: invalid });
    const claimedItem = await s.items.claim(item.id);
    const output = await s.outputs.capture({
      loopId: loop.id,
      itemId: item.id,
      attemptId: invalid,
      shipAction: "open_pr",
      title: invalid,
      capturedBy: "ledger",
    });
    if (invalid === "membership") await s.items.markReady(item.id, [], claimedItem!.claimToken!);
    await s.outputs.promoteAttempt(item.id, invalid);
    const claimedOutput = await s.outputs.claimShipping(output.id);
    await s.outputs.markUnconfirmed(output.id, claimedOutput!.claimToken!);
    assert.equal(await s.fire.shipOutput(loop.id, output.id, "josh", "confirmed"), null);
    assert.equal((await s.outputs.get(output.id))?.state, "unconfirmed");
  }
});

test("returning an output fails while a sibling is shipping", async () => {
  const two: Responder = (req) =>
    stage(req) === "work"
      ? '```json\n{"outputs": [{"shipAction": "open_pr", "title": "one", "externalRef": "1"}, {"shipAction": "open_pr", "title": "two", "externalRef": "2"}]}\n```'
      : HAPPY(req);
  const s = service(two);
  const loop = await makeLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const outputs = await s.outputs.awaitingReview(loop.id);
  await s.outputs.claimShipping(outputs[1]!.id);
  assert.equal(await s.fire.returnOutput(loop.id, outputs[0]!.id, "josh", "retry"), null);
  assert.equal((await s.items.get(outputs[0]!.itemId))?.status, "ready");
  assert.equal((await s.outputs.get(outputs[0]!.id))?.state, "ready");
});

test("redelivering a committed fire key is silent and does not record another failure", async () => {
  const s = service(() => {
    throw new Error("source down");
  });
  const loop = await makeLoop(s.loops);
  await s.idempotency.once("duplicate:intake", async () => {});
  const result = await s.fire.fire(loop.id, "duplicate");
  assert.deepEqual(result, { status: "silent", note: "duplicate fire key" });
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, undefined);
});

test("a concurrent duplicate intake is silent and does not record a failed fire", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = s.idempotency.once("concurrent:intake", async () => blocked);
  await new Promise<void>((resolve) => setImmediate(resolve));
  const duplicate = await s.fire.fire(loop.id, "concurrent");
  release();
  await owner;
  assert.deepEqual(duplicate, { status: "silent", note: "duplicate fire key" });
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, undefined);
});

test("the scheduler sweep pings a stale loop without waiting for another fire", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    governor: { staleFireMs: 1_000 },
    destination: { type: "slack", target: "C1", audienceScopeId: base.ownerScopeId },
  });
  await s.loops.recordFireOutcome(loop.id, false);
  const firedAt = (await s.loops.get(loop.id))!.lastFiredAt!;
  await s.fire.sweepStale(firedAt + 1_001);
  assert.equal(s.deliveries.sent.length, 1);
  assert.match(s.deliveries.sent[0]!.text, /trigger looks dead/);
});

test("the scheduler sweep detects a stale loop that has never fired", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    governor: { staleFireMs: 1_000 },
    destination: { type: "slack", target: "C1", audienceScopeId: base.ownerScopeId },
  });
  await s.fire.sweepStale(loop.createdAt + 1_001);
  assert.equal(s.deliveries.sent.length, 1);
  assert.match(s.deliveries.sent[0]!.text, /trigger looks dead/);
});

test("review saturation pings once and recovers after outputs drain", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops, {
    caps: { maxOpenOutputs: 1 },
    destination: { type: "slack", target: "C1", audienceScopeId: base.ownerScopeId },
  });
  await s.fire.fire(loop.id, "f1");
  assert.equal((await s.loops.get(loop.id))?.health, "degraded");
  assert.equal(s.deliveries.sent.length, 1);
  assert.match(s.deliveries.sent[0]!.text, /waiting for review/);
  await s.fire.fire(loop.id, "saturated");
  assert.equal(s.deliveries.sent.length, 1);
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  await s.fire.shipOutput(loop.id, output.id, "reviewer");
  await s.fire.fire(loop.id, "drained");
  assert.equal((await s.loops.get(loop.id))?.health, "healthy");
  assert.equal(s.deliveries.sent.length, 1);
});

test("prompt fences cannot be escaped by loop, item, output, or reviewer text", async () => {
  const poison = "before```after";
  const malicious: Responder = (req) => {
    switch (stage(req)) {
      case "intake":
        return `[{"sourceKey":"${poison}","sourceSummary":"${poison}"}]`;
      case "work":
        return `\`\`\`json\n${JSON.stringify({ outputs: [{ shipAction: "open_pr", title: poison, externalRef: poison }] })}\n\`\`\``;
      case "judge":
        return `\`\`\`json\n${JSON.stringify({ outcome: "met", reason: "done", checks: [{ command: poison, passed: true, detail: "ok" }] })}\n\`\`\``;
      default:
        return "done";
    }
  };
  const s = service(malicious);
  const loop = await makeLoop(s.loops, {
    name: poison,
    playbook: poison,
    successCondition: poison,
    successChecks: [poison],
  });
  await s.fire.fire(loop.id, "fence-test");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  await s.fire.shipOutput(loop.id, output.id, "josh", poison);
  for (const turn of s.turns) {
    assert.doesNotMatch(turn.text ?? "", /before```after/);
  }
  const judge = s.turns.find((turn) => stage(turn) === "judge")?.text ?? "";
  assert.doesNotMatch(judge.split("```untrusted-data")[0]!, /sourceKey/);
  assert.match(judge, /"sourceKey":"beforeʼʼʼafter"/);
});

test("an auto grant ships the matching slice without a person", async () => {
  const grants = createShipGrantStore();
  const s = service(HAPPY, { grants });
  const loop = await makeLoop(s.loops);
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped.length, 1);
  assert.equal(s.turns.filter((t) => stage(t) === "ship").length, 1);
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
});

test("revoking an auto grant during work leaves the output held", async () => {
  const grants = createShipGrantStore();
  let grantId = "";
  const s = service(
    (req) => {
      if (stage(req) === "judge") void grants.revoke(grantId, "reviewer");
      return HAPPY(req);
    },
    { grants },
  );
  const loop = await makeLoop(s.loops);
  const grant = await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  grantId = grant.id;
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped, []);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(s.turns.filter((turn) => stage(turn) === "ship").length, 0);
});

test("a policy version bump during work leaves the output held", async () => {
  const grants = createShipGrantStore();
  let loopId = "";
  const s = service(
    (req) => {
      if (stage(req) === "judge") void s.loops.editPlaybook(loopId, { playbook: "new policy", by: "reviewer" });
      return HAPPY(req);
    },
    { grants },
  );
  const loop = await makeLoop(s.loops);
  loopId = loop.id;
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped, []);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(s.turns.filter((turn) => stage(turn) === "ship").length, 0);
});

test("a stale grant does not auto-ship after a semantic policy change", async () => {
  const grants = createShipGrantStore();
  const s = service(HAPPY, { grants });
  const loop = await makeLoop(s.loops);
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: "checkout",
      policyVersion: loop.policyVersion,
    }),
  );
  await s.loops.editPlaybook(loop.id, { playbook: "triage without side effects", by: "josh" });
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.shipped, []);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(s.turns.filter((t) => stage(t) === "ship").length, 0);
});

test("an undeclared ship action parks the item and quarantines through the governor", async () => {
  const rogue: Responder = (req) => {
    switch (stage(req)) {
      case "intake":
        return '[{"sourceKey": "SENTRY-9"}]';
      case "work":
        return '```json\n{"outputs": [{"shipAction": "send_email", "title": "Emailed the customer"}]}\n```';
      default:
        return '```json\n{"outcome": "met", "reason": "n/a"}\n```';
    }
  };
  const s = service(rogue);
  const loop = await makeLoop(s.loops);
  const result = await s.fire.fire(loop.id, "f1");
  assert.deepEqual(result.summary?.undeclaredShipActions, ["send_email"]);
  const after = await s.loops.get(loop.id);
  assert.equal(after?.state, "quarantined");
  assert.equal(after?.health, "quarantined");
});

test("a failed intake records the failure and repeated failures degrade health", async () => {
  let calls = 0;
  const s = service(() => {
    calls += 1;
    throw new Error("source down");
  });
  const loop = await makeLoop(s.loops);
  for (let i = 0; i < 3; i++) {
    const result = await s.fire.fire(loop.id, `f${i}`);
    assert.equal(result.status, "failed");
  }
  const after = await s.loops.get(loop.id);
  assert.equal(after?.consecutiveFailedFires, 3);
  assert.notEqual(after?.health, "healthy");
  assert.ok(calls >= 3);
});

test("a quiet fire with nothing to review reports silent", async () => {
  const quiet: Responder = (req) => (stage(req) === "intake" ? "```json\n[]\n```" : "done");
  const s = service(quiet);
  const loop = await makeLoop(s.loops);
  const result = await s.fire.fire(loop.id, "f1");
  assert.equal(result.status, "silent");
});

test("an unmet judgment continues the item; the attempt cap parks it", async () => {
  const never: Responder = (req) => {
    switch (stage(req)) {
      case "intake":
        return '[{"sourceKey": "SENTRY-2"}]';
      case "work":
        return '```json\n{"outputs": []}\n```';
      case "judge":
        return '```json\n{"outcome": "continue", "reason": "no PR yet"}\n```';
      default:
        return "done";
    }
  };
  const s = service(never);
  const loop = await makeLoop(s.loops, { caps: { maxItemAttempts: 2 } });
  const first = await s.fire.fire(loop.id, "f1");
  assert.equal(first.summary?.continued.length, 1);
  const second = await s.fire.fire(loop.id, "f2");
  assert.equal(second.summary?.parked.length, 1);
  const items = await s.items.byLoop(loop.id);
  assert.equal(items[0]?.status, "failed");
  assert.match(items[0]?.parkedReason ?? "", /attempt cap/);
});

test("a paused loop refuses to fire", async () => {
  const s = service(HAPPY);
  const loop = await makeLoop(s.loops);
  await s.loops.setState(loop.id, "paused");
  const result = await s.fire.fire(loop.id, "f1");
  assert.equal(result.status, "silent");
  assert.equal(s.turns.length, 0);
});

const FACTORY_TICKET = "QM-12";
const FACTORY_BRANCH = "fix/qm-12";
const FACTORY_PR_URL = "https://github.com/acme/app/pull/42";
const LINEAR_URL = "https://api.linear.app/graphql";
const GH_GRAPHQL = "https://api.github.com/graphql";
const GH_REPO = "https://api.github.com/repos/acme/app";
const HEAD_SHA = "1".repeat(40);
const LINEAR_KEY = "lin_FAKE_KEY";
const GITHUB_TOKEN = "ghp_FAKE_TOKEN";
const ANTHROPIC_KEY = "sk-ant-FAKE_KEY";
const WRAPPER_STDOUT = `working\nBRANCH:${FACTORY_BRANCH}\nMR:42\n`;
const ALREADY_FIXED_STDOUT = "ALREADY_FIXED:true\nALREADY_FIXED_EVIDENCE:fixed by #40\n";

const FACTORY_CONFIG: FactoryConfig = {
  forge: "github",
  publishProject: "acme/app",
  targetBranch: "main",
  repoCloneUrl: "https://github.com/acme/app.git",
  linearTeamId: "TEAM-1",
  sourceAppDirs: "src",
  sourceTestRe: "\\.test\\.ts$",
  verifyTestsCmd: "npm test",
  verifyTestFileCmd: "npm test --",
  verifyLintCmd: "npm run lint",
  bugbotRequired: true,
  followupsEnabled: false,
};

interface FactorySandbox {
  sandbox: Sandbox;
  ops: string[];
}

function factorySandbox(
  opts: { stdout?: string; read?: (ops: string[]) => Promise<ReadProcessResult> } = {},
): FactorySandbox {
  const ops: string[] = [];
  const stdout = opts.stdout ?? WRAPPER_STDOUT;
  const probe = FACTORY_REQUIRED_TOOLS.map((tool) => `${tool}=ok 1.0`).join("\n");
  const unused = (name: string) => () => Promise.reject(new Error(`a factory loop must not call ${name}`));
  let provisioned = 0;
  let started = 0;
  const wrapperProcessIds = new Set<string>();
  const defaultRead = async (): Promise<ReadProcessResult> => {
    const sinceStart = ops.slice(ops.lastIndexOf("startProcess"));
    return sinceStart.filter((op) => op === "readProcess").length === 1
      ? { chunks: stdout, cursor: stdout.length, status: { state: "running" } }
      : { chunks: "", cursor: stdout.length, status: { state: "exited", code: 0 } };
  };
  const record = <T>(op: string, value: T): Promise<T> => {
    ops.push(op);
    return Promise.resolve(value);
  };
  const sandbox: Record<string, unknown> = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    provision: () => {
      provisioned += 1;
      return record("provision", { id: `sbx-${provisioned}`, rootDir: "/workspace" });
    },
    run: () => record("run", { stdout: `${probe}\n`, stderr: "", code: 0, timedOut: false }),
    startProcess: (_handle: SandboxHandle, command: string) => {
      started += 1;
      const processId = `p${started}`;
      if (command.includes(FACTORY_WRAPPER)) wrapperProcessIds.add(processId);
      return record("startProcess", { processId });
    },
    readProcess: (_handle: SandboxHandle, processId: string) => {
      ops.push("readProcess");
      if (!wrapperProcessIds.has(processId)) {
        return Promise.resolve({ chunks: "", cursor: 0, status: { state: "exited" as const, code: 0 } });
      }
      return (opts.read ?? defaultRead)(ops);
    },
    signalProcess: () => record("signalProcess", undefined),
    teardown: () => record("teardown", undefined),
    readFile: unused("readFile"),
    writeFile: unused("writeFile"),
    writeFileBytes: unused("writeFileBytes"),
    readFileBytes: unused("readFileBytes"),
    listDir: unused("listDir"),
    removeDir: unused("removeDir"),
    writeStdin: unused("writeStdin"),
    listProcesses: unused("listProcesses"),
  };
  return { sandbox: sandbox as unknown as Sandbox, ops };
}

interface FactoryFetchCall {
  url: string;
  method: string;
  body: string;
  query: string;
  headers: Headers;
}

interface FactoryFetch {
  fetch: typeof globalThis.fetch;
  calls: FactoryFetchCall[];
  fail: (match: string, status: number) => void;
}

function factoryFetch(
  opts: {
    intake?: string[];
    pr?: { draft?: boolean; open?: boolean; merged?: boolean };
    issue?: { name?: string; type?: string; labels?: string[] };
  } = {},
): FactoryFetch {
  const calls: FactoryFetchCall[] = [];
  const pr = { draft: true, open: true, merged: false, ...opts.pr };
  const issue = { name: "Auto-Triage", type: "unstarted", labels: [] as string[], ...opts.issue };
  const teamStates = [
    { id: "st-triage", name: "Auto-Triage", type: "unstarted" },
    { id: "st-review", name: "In Review", type: "started" },
    { id: "st-done", name: "Done", type: "completed" },
  ];
  let failure: { match: string; status: number } | null = null;

  const linear = (query: string): unknown => {
    if (query.includes("FactoryIntake"))
      return {
        data: {
          team: {
            issues: {
              nodes: (opts.intake ?? [FACTORY_TICKET]).map((identifier) => ({
                identifier,
                title: `${identifier} title`,
                createdAt: "2026-01-01T00:00:00.000Z",
                inverseRelations: { nodes: [] },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    if (query.includes("issueLabels(filter")) return { data: { issueLabels: { nodes: [{ id: "label-ready" }] } } };
    if (query.includes("issue(id:"))
      return {
        data: {
          issue: {
            id: "issue-1",
            state: { id: "st-current", name: issue.name, type: issue.type },
            labels: { nodes: issue.labels.map((name) => ({ id: name, name })) },
            team: { id: "TEAM-1", states: { nodes: teamStates } },
          },
        },
      };
    return { data: { mutation: { success: true } } };
  };

  const route = (url: string, method: string, query: string): unknown => {
    if (url === LINEAR_URL) return linear(query);
    if (url === GH_GRAPHQL)
      return query.includes("markPullRequestReadyForReview")
        ? { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }
        : { data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } };
    if (url.startsWith(`${GH_REPO}/pulls/42/reviews`)) return [{ user: { login: "cursor[bot]" }, commit_id: HEAD_SHA }];
    if (url.startsWith(`${GH_REPO}/pulls/42`))
      return method === "GET"
        ? {
            node_id: "PR_42",
            draft: pr.draft,
            state: pr.open ? "open" : "closed",
            merged: pr.merged,
            head: { sha: HEAD_SHA },
            mergeable: true,
            mergeable_state: "clean",
          }
        : {};
    if (url.startsWith(`${GH_REPO}/branches/`)) return { commit: { sha: HEAD_SHA } };
    if (url.includes("/check-runs"))
      return { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] };
    if (url.startsWith(`${GH_REPO}/issues/42/comments`)) return {};
    throw new Error(`unrouted factory request: ${method} ${url}`);
  };

  return {
    calls,
    fail: (match, status) => {
      failure = { match, status };
    },
    fetch: (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      const query = body ? String((JSON.parse(body) as { query?: unknown }).query ?? "") : "";
      calls.push({ url, method, body, query, headers: new Headers(init?.headers) });
      if (failure && url.includes(failure.match))
        return Promise.resolve(new Response("nope", { status: failure.status }));
      return Promise.resolve(Response.json(route(url, method, query) as Record<string, unknown>));
    },
  };
}

function factoryCredentials(missing: string[] = []): ServiceCredentialReader {
  return {
    getServiceCredentialSecret: async (_scope, slug) =>
      missing.includes(slug)
        ? null
        : {
            slug,
            name: slug,
            secret:
              slug === FACTORY_LINEAR_SLUG ? LINEAR_KEY : slug === FACTORY_GITHUB_SLUG ? GITHUB_TOKEN : ANTHROPIC_KEY,
            delivery: "broker",
            host: "api.example.com",
            deployments: false,
            enabled: true,
          },
  };
}

interface FactoryFake {
  deps: (loops: ReturnType<typeof createLoopStore>) => FactoryEffectsDeps;
  sandbox: FactorySandbox;
  fetch: FactoryFetch;
  instances: () => number;
}

function factoryFake(
  over: {
    config?: FactoryConfig | null;
    credentials?: ServiceCredentialReader;
    sandbox?: FactorySandbox;
    fetch?: FactoryFetch;
  } = {},
): FactoryFake {
  const sandbox = over.sandbox ?? factorySandbox();
  const fetched = over.fetch ?? factoryFetch();
  const config = over.config === undefined ? FACTORY_CONFIG : over.config;
  let repoDirReads = 0;
  return {
    sandbox,
    fetch: fetched,
    instances: () => repoDirReads,
    deps: (loops) => ({
      sandbox: sandbox.sandbox,
      config: { getFactoryConfig: () => config },
      credentials: over.credentials ?? factoryCredentials(),
      orgScopeId: scopeId("org", "acme"),
      loops,
      fetch: fetched.fetch,
      pausePollMs: 1,
      get repoDir(): string {
        repoDirReads += 1;
        return "/workspace/repo";
      },
    }),
  };
}

const FACTORY_NO_TURNS: Responder = (req) => {
  if (stage(req) !== "other") throw new Error(`a factory loop must take no ${stage(req)} turn`);
  return "done";
};

async function makeFactoryLoop(loops: ReturnType<typeof createLoopStore>, over: Record<string, unknown> = {}) {
  return makeLoop(loops, {
    name: "factory",
    surface: FACTORY_LOOP_SURFACE,
    playbook: "the factory wrapper does the work",
    successCondition: "the pull request converged",
    shipActions: [
      { action: "open_pr", gate: "hold" },
      { action: "close_already_fixed", gate: "hold" },
    ],
    ...over,
  });
}

async function readyFactoryOutput(
  s: ReturnType<typeof service>,
  loopId: string,
  capture: { shipAction: string; title: string; externalRef?: string },
) {
  const { item } = await s.items.enqueue({ loopId, sourceKey: FACTORY_TICKET });
  const claimed = await s.items.claim(item.id);
  const output = await s.outputs.capture({
    loopId,
    itemId: item.id,
    attemptId: "a1",
    capturedBy: "classifier",
    ...capture,
  });
  await s.items.markReady(item.id, [output.id], claimed!.claimToken!);
  await s.outputs.promoteAttempt(item.id, "a1");
  return output;
}

async function heldFactoryOutput(fake: FactoryFake, over: Record<string, unknown> = {}) {
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
  const loop = await makeFactoryLoop(s.loops, over);
  await s.fire.fire(loop.id, "f1");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  return { s, loop, output, before: fake.fetch.calls.length };
}

const traffic = (calls: FactoryFetchCall[]): string[] => calls.map((call) => `${call.method} ${call.url}`);

test("factory surface: a fire drives the factory effects and takes no agent turn", async () => {
  const fake = factoryFake();
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
  const loop = await makeFactoryLoop(s.loops);

  const result = await s.fire.fire(loop.id, "f1");

  assert.equal(result.status, "ok");
  assert.equal(s.turns.length, 0);
  assert.equal(result.summary?.enqueued, 1);
  assert.equal(result.summary?.worked, 1);
  assert.equal(result.summary?.ready.length, 1);
  assert.equal(fake.instances(), 1);
  const intake = fake.fetch.calls[0];
  assert.equal(intake?.url, LINEAR_URL);
  assert.match(intake?.body ?? "", /"teamId":"TEAM-1"/);
  assert.equal(intake?.headers.get("Authorization"), LINEAR_KEY);
  assert.deepEqual(fake.sandbox.ops.slice(0, 7), [
    "provision",
    "run",
    "startProcess",
    "readProcess",
    "teardown",
    "provision",
    "startProcess",
  ]);
  const items = await s.items.byLoop(loop.id);
  assert.equal(items[0]?.sourceKey, FACTORY_TICKET);
  const output = (await s.outputs.awaitingReview(loop.id))[0];
  assert.equal(output?.shipAction, "open_pr");
  assert.equal(output?.label, FACTORY_BRANCH);
  assert.equal(output?.externalRef, FACTORY_PR_URL);
  assert.equal(output?.capturedBy, "classifier");
  assert.ok(fake.fetch.calls.some((call) => call.url === `${GH_REPO}/pulls/42`));
});

test("factory surface: a repeated fire key is silent and re-runs neither intake nor the wrapper", async () => {
  const fake = factoryFake();
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
  const loop = await makeFactoryLoop(s.loops);
  await s.fire.fire(loop.id, "f1");
  const calls = fake.fetch.calls.length;
  const ops = fake.sandbox.ops.length;

  const repeat = await s.fire.fire(loop.id, "f1");

  assert.deepEqual(repeat, { status: "silent", note: "duplicate fire key" });
  assert.equal(fake.fetch.calls.length, calls);
  assert.equal(fake.sandbox.ops.length, ops);
  assert.equal((await s.items.byLoop(loop.id)).length, 1);
});

test("factory surface: a fire without the factory dep fails and runs nothing", async () => {
  const s = service(FACTORY_NO_TURNS);
  const loop = await makeFactoryLoop(s.loops);

  const result = await s.fire.fire(loop.id, "f1");

  assert.deepEqual(result, { status: "failed", note: "factory loop has no factory deps" });
  assert.equal(s.turns.length, 0);
  assert.deepEqual(await s.items.byLoop(loop.id), []);
  assert.equal((await s.loops.get(loop.id))?.consecutiveFailedFires, undefined);
});

test("factory surface: a missing config or credential fails the fire before the sandbox", async () => {
  const cases: [string, RegExp, Parameters<typeof factoryFake>[0]][] = [
    ["config", /factory_config_missing/, { config: null }],
    [
      "credential",
      /factory_credentials_missing: factory-github, factory-anthropic/,
      { credentials: factoryCredentials([FACTORY_GITHUB_SLUG, FACTORY_ANTHROPIC_SLUG]) },
    ],
  ];
  for (const [name, expected, over] of cases) {
    const fake = factoryFake(over);
    const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
    const loop = await makeFactoryLoop(s.loops);

    const result = await s.fire.fire(loop.id, "f1");

    assert.equal(result.status, "failed", name);
    assert.match(result.note ?? "", expected);
    assert.deepEqual(fake.sandbox.ops, []);
  }
});

test("factory surface: pausing the loop mid-run aborts the wrapper and fails the item", async () => {
  let pause: (() => Promise<void>) | null = null;
  const sandbox = factorySandbox({
    read: async (ops) => {
      if (ops.includes("signalProcess")) return { chunks: "", cursor: 0, status: { state: "exited", code: 143 } };
      if (pause) await pause();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { chunks: "", cursor: 0, status: { state: "running" } };
    },
  });
  const fake = factoryFake({ sandbox });
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
  const loop = await makeFactoryLoop(s.loops);
  pause = async () => {
    await s.loops.setState(loop.id, "paused");
  };

  const result = await s.fire.fire(loop.id, "f1");

  assert.equal(result.status, "failed");
  assert.deepEqual(result.summary?.failures, [`${FACTORY_TICKET}: factory_run_aborted`]);
  assert.ok(fake.sandbox.ops.includes("signalProcess"));
});

test("factory surface: shipping an open_pr output undrafts the request and advances the ticket", async () => {
  const fake = factoryFake();
  const { s, loop, output, before } = await heldFactoryOutput(fake);

  const shipped = await s.fire.shipOutput(loop.id, output.id, "josh");

  assert.equal(shipped?.state, "shipped");
  assert.equal(shipped?.decidedBy, "josh");
  assert.equal(shipped?.shipResult?.note, "undraft=true, linear-state=true, linear-label=true");
  assert.equal(shipped?.decisionNote, undefined);
  assert.equal((await s.items.get(output.itemId))?.status, "shipped");
  assert.equal(s.turns.length, 0);
  const sent = fake.fetch.calls.slice(before);
  assert.deepEqual(traffic(sent), [
    `GET ${GH_REPO}/pulls/42`,
    `POST ${GH_GRAPHQL}`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
  ]);
  assert.equal(sent[0]?.headers.get("Authorization"), `Bearer ${GITHUB_TOKEN}`);
  assert.equal(sent[0]?.headers.get("Accept"), "application/vnd.github+json");
  assert.match(sent[1]!.query, /markPullRequestReadyForReview/);
  assert.match(sent[3]!.query, /issueUpdate\(id: "issue-1", input: \{ stateId: "st-review" \}\)/);
  assert.match(sent[5]!.query, /issueAddLabel\(id: "issue-1", labelId: "label-ready"\)/);
});

test("factory surface: re-deciding an already-shipped pull request reports every step unchanged", async () => {
  const fake = factoryFake({
    fetch: factoryFetch({
      pr: { draft: false },
      issue: { name: "In Review", type: "started", labels: ["ready-for-review"] },
    }),
  });
  const { s, loop, output, before } = await heldFactoryOutput(fake);

  const shipped = await s.fire.shipOutput(loop.id, output.id, "josh");

  assert.equal(shipped?.state, "shipped");
  assert.equal(shipped?.shipResult?.note, "undraft=false, linear-state=false, linear-label=false");
  const sent = fake.fetch.calls.slice(before);
  assert.deepEqual(traffic(sent), [`GET ${GH_REPO}/pulls/42`, `POST ${LINEAR_URL}`]);
});

test("factory surface: a forge failure while shipping releases the claim and re-throws", async () => {
  const fake = factoryFake();
  const { s, loop, output } = await heldFactoryOutput(fake);
  fake.fetch.fail(`${GH_REPO}/pulls/42`, 500);

  await assert.rejects(s.fire.shipOutput(loop.id, output.id, "josh"), /forge_undraft_failed: 500/);

  assert.equal((await s.outputs.get(output.id))?.state, "ready");
  assert.equal((await s.items.get(output.itemId))?.status, "ready");
});

test("factory surface: shipping an already-fixed output posts to Linear and touches no forge", async () => {
  const fake = factoryFake({ sandbox: factorySandbox({ stdout: ALREADY_FIXED_STDOUT }) });
  const { s, loop, output, before } = await heldFactoryOutput(fake);

  const shipped = await s.fire.shipOutput(loop.id, output.id, "josh");

  assert.equal(shipped?.state, "shipped");
  assert.equal(shipped?.shipResult?.note, "linear-comment=true, linear-state=true");
  const sent = fake.fetch.calls.slice(before);
  assert.deepEqual(traffic(sent), [`POST ${LINEAR_URL}`, `POST ${LINEAR_URL}`, `POST ${LINEAR_URL}`]);
  assert.match(sent[1]!.query, /body: "Already fixed\. fixed by #40"/);
  assert.match(sent[2]!.query, /stateId: "st-done"/);
  assert.equal(fake.fetch.calls.filter((call) => call.url.startsWith("https://api.github.com/")).length, 0);
});

test("factory surface: an already-fixed output on a terminal ticket only comments, and bare evidence stays bare", async () => {
  const terminal = factoryFake({
    sandbox: factorySandbox({ stdout: ALREADY_FIXED_STDOUT }),
    fetch: factoryFetch({ issue: { name: "Done", type: "completed" } }),
  });
  const held = await heldFactoryOutput(terminal);
  const shipped = await held.s.fire.shipOutput(held.loop.id, held.output.id, "josh");
  assert.equal(shipped?.shipResult?.note, "linear-comment=true, linear-state=false");
  assert.deepEqual(traffic(terminal.fetch.calls.slice(held.before)), [`POST ${LINEAR_URL}`, `POST ${LINEAR_URL}`]);

  const bare = factoryFake({ sandbox: factorySandbox({ stdout: "ALREADY_FIXED:true\n" }) });
  const noEvidence = await heldFactoryOutput(bare);
  await noEvidence.s.fire.shipOutput(noEvidence.loop.id, noEvidence.output.id, "josh");
  assert.match(bare.fetch.calls.slice(noEvidence.before)[1]!.query, /body: "Already fixed\."/);
});

test("factory surface: an unknown ship action or a ref without a number fails before any request", async () => {
  for (const broken of [
    { shipAction: "merge_pr", externalRef: FACTORY_PR_URL, expected: /factory_ship_action_unknown: merge_pr/ },
    {
      shipAction: "open_pr",
      externalRef: "https://github.com/acme/app/pull/main",
      expected: /factory_ship_ref_missing/,
    },
  ]) {
    const fake = factoryFake();
    const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
    const loop = await makeFactoryLoop(s.loops);
    const output = await readyFactoryOutput(s, loop.id, {
      shipAction: broken.shipAction,
      title: broken.shipAction,
      externalRef: broken.externalRef,
    });

    await assert.rejects(s.fire.shipOutput(loop.id, output.id, "josh"), broken.expected);

    assert.deepEqual(fake.fetch.calls, []);
    assert.equal((await s.outputs.get(output.id))?.state, "ready");
  }
});

test("factory surface: shipping without the factory dep fails instead of taking the turn path", async () => {
  const s = service(FACTORY_NO_TURNS);
  const loop = await makeFactoryLoop(s.loops);
  const output = await readyFactoryOutput(s, loop.id, {
    shipAction: "open_pr",
    title: "fix",
    externalRef: FACTORY_PR_URL,
  });

  await assert.rejects(s.fire.shipOutput(loop.id, output.id, "josh"), /factory loop has no factory deps/);

  assert.equal(s.turns.length, 0);
  assert.equal((await s.outputs.get(output.id))?.state, "ready");
  assert.equal((await s.items.get(output.itemId))?.status, "ready");
});

test("factory surface: an auto grant ships through the same forge path with no turn", async () => {
  const grants = createShipGrantStore();
  const fake = factoryFake();
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps, grants });
  const loop = await makeFactoryLoop(s.loops);
  await grants.put(
    buildShipGrant({
      loopId: loop.id,
      shipAction: "open_pr",
      actorId: "josh",
      label: FACTORY_BRANCH,
      policyVersion: loop.policyVersion,
    }),
  );

  const result = await s.fire.fire(loop.id, "f1");

  const item = (await s.items.byLoop(loop.id))[0]!;
  assert.deepEqual(result.summary?.shipped, [item.id]);
  assert.equal(s.turns.length, 0);
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
  assert.equal((await s.outputs.byItem(item.id))[0]?.state, "shipped");
  assert.ok(fake.fetch.calls.some((call) => call.query.includes("markPullRequestReadyForReview")));
});

test("factory surface: returning an output closes the pull request and re-triages the ticket", async () => {
  const fake = factoryFake({ fetch: factoryFetch({ issue: { name: "In Review", type: "started" } }) });
  const { s, loop, output, before } = await heldFactoryOutput(fake);

  const returned = await s.fire.returnOutput(loop.id, output.id, "josh", "tests are flaky");

  assert.equal(returned?.state, "returned");
  assert.equal((await s.items.get(output.itemId))?.status, "queued");
  assert.equal(s.turns.length, 0);
  const sent = fake.fetch.calls.slice(before);
  assert.deepEqual(traffic(sent), [
    `POST ${GH_REPO}/issues/42/comments`,
    `GET ${GH_REPO}/pulls/42`,
    `PATCH ${GH_REPO}/pulls/42`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
  ]);
  assert.match(sent[0]!.body, /"Returned by the factory reviewer: tests are flaky"/);
  assert.match(sent[2]!.body, /"state":"closed"/);
  assert.match(sent[4]!.query, /body: "Returned to Auto-Triage: tests are flaky"/);
  assert.match(sent[5]!.query, /stateId: "st-triage"/);
});

test("factory surface: returning an already-fixed output leaves its evidence pull request open", async () => {
  const fake = factoryFake({
    sandbox: factorySandbox({ stdout: `${ALREADY_FIXED_STDOUT}MR:42\n` }),
    fetch: factoryFetch({ issue: { name: "In Review", type: "started" } }),
  });
  const { s, loop, output, before } = await heldFactoryOutput(fake);
  assert.equal(output.shipAction, "close_already_fixed");
  assert.equal(output.externalRef, FACTORY_PR_URL);

  const returned = await s.fire.returnOutput(loop.id, output.id, "josh", "still reproduces");

  assert.equal(returned?.state, "returned");
  assert.deepEqual(traffic(fake.fetch.calls.slice(before)), [
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
  ]);
});

test("factory surface: a merged pull request is not closed on return", async () => {
  const fake = factoryFake({
    fetch: factoryFetch({
      pr: { draft: false, open: false, merged: true },
      issue: { name: "In Review", type: "started" },
    }),
  });
  const { s, loop, output, before } = await heldFactoryOutput(fake);

  await s.fire.returnOutput(loop.id, output.id, "josh", "shipped elsewhere");

  assert.deepEqual(traffic(fake.fetch.calls.slice(before)), [
    `POST ${GH_REPO}/issues/42/comments`,
    `GET ${GH_REPO}/pulls/42`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
    `POST ${LINEAR_URL}`,
  ]);
});

test("factory surface: an output with no external ref runs the Linear steps only", async () => {
  const fake = factoryFake({ fetch: factoryFetch({ issue: { name: "In Review", type: "started" } }) });
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
  const loop = await makeFactoryLoop(s.loops);
  const output = await readyFactoryOutput(s, loop.id, { shipAction: "open_pr", title: "no ref" });

  await s.fire.returnOutput(loop.id, output.id, "josh", "start over");

  assert.deepEqual(traffic(fake.fetch.calls), [`POST ${LINEAR_URL}`, `POST ${LINEAR_URL}`, `POST ${LINEAR_URL}`]);
});

test("factory surface: a forge failure while returning leaves the ledger return recorded", async () => {
  const fake = factoryFake();
  const { s, loop, output } = await heldFactoryOutput(fake);
  fake.fetch.fail(`${GH_REPO}/issues/42/comments`, 500);

  await assert.rejects(s.fire.returnOutput(loop.id, output.id, "josh", "tests are flaky"), /forge_comment_failed: 500/);

  assert.equal((await s.outputs.get(output.id))?.state, "returned");
  assert.equal((await s.items.get(output.itemId))?.status, "queued");
});

test("factory surface: a follow-up records the message and takes no turn", async () => {
  const fake = factoryFake();
  const { s, loop, before } = await heldFactoryOutput(fake);
  const item = (await s.items.byLoop(loop.id))[0]!;

  const after = await s.fire.followUp(loop, item, "please rebase", "josh");

  assert.equal(s.turns.length, 0);
  assert.deepEqual(
    (after?.thread ?? []).map((message) => [message.role, message.text]),
    [["human", "please rebase"]],
  );
  assert.equal(after?.proposal, undefined);
  assert.equal(fake.fetch.calls.length, before);

  const action = await s.fire.itemAction(loop, item, "nudge", {});
  assert.equal(action.ok, true);
  assert.equal(s.turns.length, 1);
});

test("factory surface: an undeclared already-fixed artifact parks the item and ships nothing", async () => {
  const fake = factoryFake({ sandbox: factorySandbox({ stdout: ALREADY_FIXED_STDOUT }) });
  const s = service(FACTORY_NO_TURNS, { factory: fake.deps });
  const loop = await makeFactoryLoop(s.loops, { shipActions: [{ action: "open_pr", gate: "hold" }] });

  const result = await s.fire.fire(loop.id, "f1");

  const item = (await s.items.byLoop(loop.id))[0]!;
  assert.deepEqual(result.summary?.undeclaredShipActions, ["close_already_fixed"]);
  assert.deepEqual(result.summary?.parked, [item.id]);
  assert.deepEqual(await s.outputs.awaitingReview(loop.id), []);
});

test("factory surface: a non-factory loop with the dep wired keeps the turn pipeline", async () => {
  const fake = factoryFake();
  const s = service(HAPPY, { factory: fake.deps });
  const loop = await makeLoop(s.loops);

  await s.fire.fire(loop.id, "f1");
  const output = (await s.outputs.awaitingReview(loop.id))[0]!;
  await s.fire.shipOutput(loop.id, output.id, "josh");
  await s.fire.followUp(loop, (await s.items.get(output.itemId))!, "any news?", "josh");

  assert.deepEqual(s.turns.map(stage), ["intake", "work", "judge", "ship", "other"]);
  assert.deepEqual(fake.fetch.calls, []);
  assert.deepEqual(fake.sandbox.ops, []);
  assert.equal(fake.instances(), 0);
});
