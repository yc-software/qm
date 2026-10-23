import "./support/auto-fake-sprites.ts";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { createMockHarness } from "./support/mock-harness.ts";
import { testConfig } from "./support/test-config.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, CONTROL_PLANE_AUD } from "../src/auth/capability-token.ts";
import { runNowSettled } from "./support/settle.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import {
  agentCronDigest,
  agentSkillDigest,
  type AgentPolicy,
  type AgentPolicyOperation,
} from "../src/auth/agent-policy.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";

interface Switchable {
  bound: boolean;
  grants: { id: string; digest: string }[];
  admit: (operation: AgentPolicyOperation) => boolean;
  operations: AgentPolicyOperation[];
}

async function fixture(t: TestContext) {
  const state: Switchable = { bound: false, grants: [], admit: () => true, operations: [] };
  const agentPolicy: AgentPolicy = {
    resolve: async () => (state.bound ? { subjectId: "agent", revision: 1, grants: state.grants } : null),
    admit: async (_context, _binding, operation) => {
      state.operations.push(operation);
      return state.admit(operation);
    },
  };
  const captures: HarnessTurnInput[] = [];
  const pi = createMockHarness();
  const runTurn = pi.turns.runTurn.bind(pi.turns);
  pi.turns.runTurn = async (input) => {
    captures.push(input);
    return runTurn(input);
  };
  const built = buildApp(testConfig(), { agentPolicy, harnesses: { pi } });
  await built.deploymentLayerReady;
  const computer = await built.sandboxResources.create("U1", "personal:U1", "sprites", "default");
  await built.sandboxResources.setDefault("U1", "personal:U1", computer.id);
  t.after(async () => {
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  const turn = (text: string, extra: Partial<TurnRequest> = {}) =>
    built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:agent-policy" },
      text,
      ...extra,
    } as TurnRequest);
  const reply = async (text: string) => {
    const result = await turn(text);
    assert.equal(result.status, "ok", JSON.stringify(result));
    return result.reply ?? "";
  };
  const skill = await built.skills.create({
    scopeId: "personal:U1",
    createdBy: "U1",
    manifest: {
      name: "policy-helper",
      description: "policy test",
      body: "POLICY_BODY",
      requiredCapabilities: [],
      files: [{ path: "references/example.txt", content: "POLICY_ASSET" }],
    },
  });
  await built.skills.review(skill.id, "reviewer", []);
  await built.skills.publish(skill.id);
  const grant = async () => {
    const current = (await built.skills.get(skill.id))!;
    state.grants = [{ id: current.id, digest: agentSkillDigest(current) }];
  };
  return { ...built, state, captures, turn, reply, skill, grant, computer };
}

test("a configured policy that binds no subject leaves turns and skills unchanged", async (t) => {
  const b = await fixture(t);
  assert.match(await b.reply("!skill policy-helper"), /POLICY_BODY$/);
  assert.equal(await b.reply("!skill-run policy-helper cat {dir}/references/example.txt"), "POLICY_ASSET");
  assert.deepEqual(b.state.operations, []);
});

test("bound subjects are refused when the policy denies the turn", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  b.state.admit = (operation) => operation.kind !== "turn";
  const result = await b.turn("hello");
  assert.equal(result.status, "refused");
  assert.equal(b.captures.length, 0);
});

test("bound subjects see only skills granted at their exact digest", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  assert.match(await b.reply("!skill policy-helper"), /no skill file/);
  await b.grant();
  assert.match(await b.reply("!skill policy-helper"), /POLICY_BODY$/);
  await b.skills.update(b.skill.id, { ...b.skill.manifest, body: "CHANGED_BODY" });
  assert.match(await b.reply("!skill policy-helper"), /no skill file/);
});

test("a laid skill tree is removed before the next tool call once its grant is revoked", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  await b.grant();
  assert.equal(await b.reply("!skill-run policy-helper cat {dir}/references/example.txt"), "POLICY_ASSET");
  b.state.admit = (operation) => {
    if (operation.kind === "tool" && operation.name === "execute") b.state.grants = [];
    return true;
  };
  assert.notEqual(await b.reply("!skill-run policy-helper cat {dir}/references/example.txt"), "POLICY_ASSET");
});

test("denied tool calls do not run", async (t) => {
  const b = await fixture(t);
  b.state.bound = true;
  b.state.admit = (operation) => !(operation.kind === "tool" && operation.name === "read");
  await assert.rejects(b.turn("!read notes.txt"), /agent policy denied tool admission/);
  assert.ok(b.state.operations.some((operation) => operation.kind === "tool" && operation.name === "read"));
});

test("bound turns start without inherited history, prior turns or overheard context", async (t) => {
  const b = await fixture(t);
  assert.equal((await b.turn("OLD_HISTORY_MARKER")).status, "ok");
  b.state.bound = true;
  const result = await b.turn("current task", {
    priorTurns: [{ role: "user", text: "OLD_PRIOR_MARKER" }],
    overheard: [{ role: "user", ts: "100.1", text: "OLD_OVERHEARD_MARKER" }],
  } as Partial<TurnRequest>);
  assert.equal(result.status, "ok", JSON.stringify(result));
  const input = b.captures.at(-1)!;
  assert.deepEqual(input.history, []);
  assert.equal(input.priorTurns, undefined);
  assert.equal(input.overheard, undefined);
  assert.doesNotMatch(input.environment ?? "", /OLD_/);
});

test("cron fires are admitted against the stored payload and a denial disables the cron", async () => {
  const crons = createCronStore();
  const calls: TurnRequest[] = [];
  const operations: AgentPolicyOperation[] = [];
  let admitted = false;
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    agentPolicy: {
      resolve: async () => ({ subjectId: "agent", revision: 1 }),
      admit: async (_context, _binding, operation) => {
        operations.push(operation);
        return admitted;
      },
    },
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run: async (req: TurnRequest): Promise<TurnResult> => {
      calls.push(req);
      return { status: "ok", reply: "done" };
    },
  });
  const cron = await crons.create({
    schedule: { everyMs: 1000 },
    action: "summarize",
    owner: "U1",
    createdBy: "U1",
    ownerScopeId: scopeId("personal", "U1"),
  });
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 0);
  assert.equal(operations[0]?.kind, "cron");
  assert.equal(typeof (operations[0] as { payloadDigest?: string }).payloadDigest, "string");
  const stored = await crons.get(cron.id);
  assert.equal(stored?.enabled, false);
  assert.equal((await crons.listFires(cron.id)).runs[0]?.status, "refused");
  admitted = true;
  await crons.setEnabled(cron.id, true);
  await runNowSettled(scheduler, cron.id);
  assert.equal(calls.length, 1);
});

test("bound turns cannot reach a persistent sandbox by id", async (t) => {
  const b = await fixture(t);
  const command = JSON.stringify({ command: "echo reached", sandboxId: b.computer.id });
  assert.equal(await b.reply(`!execute ${command}`), "reached");
  b.state.bound = true;
  await assert.rejects(
    b.turn(`!execute ${command}`),
    /agent policy denied sandbox access|sandbox inventory unavailable/,
  );
});

test("an agent token lists its granted skills with digests", async (t) => {
  const SECRET = "agent-policy-cap-secret".repeat(3);
  let grants: { id: string; digest: string }[] = [];
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "agent-policy-cap-")), seedSkills: false, signingSecret: SECRET }),
    {
      agentPolicy: {
        resolve: async (context) => (context.runtime ? { subjectId: "agent", revision: 1, grants } : null),
        admit: async () => true,
      },
    },
  );
  const server = createServer(built.app, { signingSecret: SECRET });
  server.listen(0);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    built.scheduler.stop();
    built.deploymentLayerRefresh.stop();
    await built.runtime.stop();
  });
  const create = async (name: string) => {
    const skill = await built.skills.create({
      scopeId: "personal:U1",
      createdBy: "U1",
      manifest: { name, description: name, body: `# ${name}`, requiredCapabilities: [] },
    });
    await built.skills.review(skill.id, "reviewer", []);
    await built.skills.publish(skill.id);
    return (await built.skills.get(skill.id))!;
  };
  const granted = await create("granted-skill");
  await create("other-skill");
  grants = [{ id: granted.id, digest: agentSkillDigest(granted) }];
  const token = await mintCapabilityToken(
    { actorId: "U1", scopeId: scopeId("personal", "U1"), aud: CONTROL_PLANE_AUD, exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );
  const res = await fetch(`http://localhost:${(server.address() as AddressInfo).port}/v1/skills`, {
    headers: { "x-agent-capability": token },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const body = (await res.json()) as { skills: { id: string; digest?: string }[] };
  assert.deepEqual(
    body.skills.map((skill) => [skill.id, skill.digest]),
    [[granted.id, grants[0]!.digest]],
  );
});

async function loopCronFixture(
  policy?: AgentPolicy,
  extra: Record<string, unknown> = {},
  loopInput: Record<string, unknown> = {},
  reply: (req: TurnRequest) => string = () => "[]",
) {
  const { createLoopFireService } = await import("../src/loops/loop-fire.ts");
  const { createLoopStore } = await import("../src/loops/loop-store.ts");
  const { createLoopItemLedger } = await import("../src/loops/item-ledger.ts");
  const { createLoopOutputStore } = await import("../src/loops/output-store.ts");
  const { createShipGrantStore } = await import("../src/loops/ship-grant-store.ts");
  const loops = createLoopStore();
  const crons = createCronStore();
  const turns: TurnRequest[] = [];
  const trigger = {
    deliveries: { enqueue: async () => ({ id: "d1" }) } as never,
    idempotency: createIdempotencyStore(),
    identity: { refresh: async () => {}, classify: () => ({ type: "internal" as const }) } as never,
    run: async (req: TurnRequest): Promise<TurnResult> => {
      turns.push(req);
      return { status: "ok", reply: reply(req), sessionId: `s${turns.length}` };
    },
  };
  const service = createLoopFireService({
    crons,
    triageEnabledFor: async () => true,
    loops,
    items: createLoopItemLedger(),
    outputs: createLoopOutputStore(),
    grants: createShipGrantStore(),
    trigger,
  } as never);
  const owner = { owner: "U1", createdBy: "U1", ownerScopeId: scopeId("personal", "U1") };
  const { loop } = await loops.create({
    ...owner,
    name: "intake",
    playbook: "APPROVED_PLAYBOOK",
    successCondition: "done",
    shipActions: [],
    ...loopInput,
  } as never);
  const cron = await crons.create({ ...owner, schedule: { everyMs: 1000 }, loopId: loop.id } as never);
  await loops.update(loop.id, { cronId: cron.id });
  const scheduler = createScheduler({
    ...singleProcessDeps(),
    ...(policy ? { agentPolicy: policy } : {}),
    crons,
    deliveries: createDeliveryStore(),
    idempotency: createIdempotencyStore(),
    identity: createIdentityService(),
    run: async (): Promise<TurnResult> => ({ status: "ok", reply: "done" }),
    fireLoop: (loopId: string, fireKey: string, cronId: string, options?: never) =>
      service.fire(loopId, fireKey, cronId, options),
    ...extra,
  } as never);
  const approved = agentCronDigest((await crons.get(cron.id))!, await loops.get(loop.id));
  return { loops, crons, cron, loop, scheduler, turns, approved };
}

function pinnedPolicy(approved: () => string, onAdmit: () => Promise<void> = async () => {}): AgentPolicy {
  return {
    resolve: async () => ({ subjectId: "agent", revision: 1 }),
    admit: async (_context, _binding, operation) => {
      if (operation.kind !== "cron") return true;
      await onAdmit();
      return operation.payloadDigest === approved();
    },
  };
}

test("a loop edited after approval is refused before it runs", async () => {
  let approved = "";
  const f = await loopCronFixture(pinnedPolicy(() => approved));
  approved = f.approved;
  await f.loops.editPlaybook(f.loop.id, { playbook: "CHANGED_PLAYBOOK", by: "U1" });
  await runNowSettled(f.scheduler, f.cron.id);
  assert.equal(f.turns.length, 0);
  assert.equal((await f.crons.listFires(f.cron.id)).runs[0]?.status, "refused");
  assert.equal((await f.crons.get(f.cron.id))?.enabled, false);
});

test("a loop edited during admission runs the admitted procedure, not the edit", async () => {
  let approved = "";
  let edit: () => Promise<void> = async () => {};
  const f = await loopCronFixture(
    pinnedPolicy(
      () => approved,
      () => edit(),
    ),
  );
  approved = f.approved;
  edit = async () => {
    edit = async () => {};
    await f.loops.editPlaybook(f.loop.id, { playbook: "CHANGED_PLAYBOOK", by: "U1" });
  };
  await runNowSettled(f.scheduler, f.cron.id);
  assert.ok(f.turns.length > 0);
  for (const turn of f.turns) assert.doesNotMatch(turn.text ?? "", /CHANGED_PLAYBOOK/);
});

test("a policy outage settles the cron fire instead of leaving it running", async () => {
  const f = await loopCronFixture({
    resolve: async () => {
      throw new Error("policy offline");
    },
    admit: async () => true,
  });
  await runNowSettled(f.scheduler, f.cron.id);
  const [last] = (await f.crons.listFires(f.cron.id)).runs;
  assert.equal(last?.status, "failed");
  assert.match(last?.note ?? "", /policy offline/);
  assert.equal(f.turns.length, 0);
  const again = await f.scheduler.runNow(f.cron.id);
  assert.equal(again.started, true);
  if (again.started) await again.settled;
});

test("without a policy a loop-backed cron fires without admission or extra loop lookups", async () => {
  const seen: unknown[] = [];
  const f = await loopCronFixture(undefined, {
    fireLoop: async (_loopId: string, _fireKey: string, _cronId: string, options?: unknown) => {
      seen.push(options);
      return { status: "ok" };
    },
  });
  await runNowSettled(f.scheduler, f.cron.id);
  assert.deepEqual(seen, [undefined]);
  assert.equal((await f.crons.listFires(f.cron.id)).runs[0]?.status, "ok");
});

test("authority added to a cron during admission does not reach the loop turn", async () => {
  let approved = "";
  let edit: () => Promise<void> = async () => {};
  const f = await loopCronFixture(
    pinnedPolicy(
      () => approved,
      () => edit(),
    ),
  );
  approved = f.approved;
  edit = async () => {
    edit = async () => {};
    await f.crons.update(f.cron.id, { unattendedGrants: ["admin.sessions.read"] } as never);
  };
  await runNowSettled(f.scheduler, f.cron.id);
  assert.ok(f.turns.length > 0);
  for (const turn of f.turns) assert.deepEqual(turn.unattendedGrants ?? [], []);
});

test("an auto-ship runs on the admitted loop, not one edited mid-fire", async () => {
  let midFire: () => Promise<void> = async () => {};
  const reply = (req: TurnRequest) => {
    const text = req.text ?? "";
    if (text.startsWith("[Loop intake]")) return '```json\n[{"sourceKey": "K1", "sourceSummary": "one"}]\n```';
    if (text.startsWith("[Loop work]")) {
      void midFire();
      return '```json\n{"outputs": [{"shipAction": "open_pr", "title": "Fix", "externalRef": "https://example.com/1"}]}\n```';
    }
    if (text.startsWith("[Loop judge]")) return '```json\n{"outcome": "met", "reason": "ok"}\n```';
    return "shipped";
  };
  let approved = "";
  const f = await loopCronFixture(
    pinnedPolicy(() => approved),
    {},
    { name: "APPROVED_LOOP", shipActions: [{ action: "open_pr", gate: "auto" }] },
    reply,
  );
  approved = f.approved;
  midFire = async () => {
    midFire = async () => {};
    await f.loops.update(f.loop.id, { name: "UNAPPROVED_SHIP_NAME" });
  };
  await runNowSettled(f.scheduler, f.cron.id);
  const ship = f.turns.find((turn) => (turn.text ?? "").startsWith("[Loop ship]"));
  assert.ok(ship, "the admitted auto-ship ran");
  assert.match(ship.text ?? "", /APPROVED_LOOP/);
  assert.doesNotMatch(ship.text ?? "", /UNAPPROVED_SHIP_NAME/);
});
