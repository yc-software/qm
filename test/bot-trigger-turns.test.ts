import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { runNowSettled } from "./support/settle.ts";
import { createControlService } from "../src/api/control-service.ts";
import { CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import type { Agent, RuntimeChoice } from "../src/agent/agent.ts";
import type { RuntimeResult } from "../src/agent/runtime-types.ts";
import { scopeId } from "../src/types.ts";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testMap } from "./support/test-database.ts";

const active: RuntimeChoice = { modelId: "claude-opus-5", effortLevel: "high", fastMode: false };

function turnClaims(actorId: string, extra: Partial<CapabilityClaims> = {}): CapabilityClaims {
  const home = scopeId("personal", actorId);
  return {
    actorId,
    scopeId: home,
    destination: { type: "slack", target: "D1", audienceScopeId: home },
    destinations: [{ key: "k-dm", type: "slack", target: "D1", audienceScopeId: home, label: "this DM" }],
    defaultDestinationKey: "k-dm",
    exp: Date.now() + CAPABILITY_TTL_MS,
    ...extra,
  };
}

test("a cron a Slack bot's turn creates runs as the bot's work, with a bot turn's limits", async () => {
  const runtimes: RuntimeResult[] = [];
  const agent: Agent = {
    async runTurn(turn) {
      runtimes.push(await turn.runtimeControl!(active, { action: "set", model: active.modelId, lifetime: "task" }));
      return { reply: "done", modelCalls: 1 };
    },
  };
  const built = buildApp(testConfig({}), { agent });
  const control = createControlService(built.app, built.scheduler, built.admin);
  const fire = async (claims: CapabilityClaims) => {
    const created = await control.createCron(
      { schedule: { everyMs: 3_600_000 }, action: "post the release notes" },
      claims,
    );
    assert.ok(created.ok, JSON.stringify(created));
    await runNowSettled(built.scheduler, created.cron.id);
    const [run] = await built.runs.list({
      threadRef: (await built.crons.listFires(created.cron.id)).runs.at(-1)!.threadRef,
    });
    return run;
  };
  const person = await fire(turnClaims("U1", { liveActor: true }));
  const bot = await fire(turnClaims("release-bot", { liveActor: true, botActor: true }));
  assert.deepEqual(
    [person?.request.botActor, bot?.request.botActor],
    [undefined, true],
    "the bot's cron fires as bot work",
  );
  assert.deepEqual(
    runtimes.map((result) => (result.ok ? "ok" : result.error)),
    ["ok", "live_actor_required"],
    "a person's cron may pick its own model for the fire; a bot's cron may not",
  );
});

test("a background-job watch a Slack bot's turn arms wakes it as the bot's work", async () => {
  const agent: Agent = {
    async runTurn(turn) {
      const watch = /^watch (\S+)$/.exec(turn.input.trim());
      if (watch) await turn.tools.backgroundWatch!(watch[1]!);
      return { reply: "done", modelCalls: 1 };
    },
  };
  const built = buildApp(testConfig({}), { agent });
  const processes = built.processes!;
  const poller = createMonitorPoller({
    ...singleProcessDeps(),
    monitors: built.monitors,
    processes,
    sandbox: built.sandbox,
    deliveries: built.deliveries,
    idempotency: createIdempotencyStore(testMap()),
    identity: built.identity,
    run: (req) => built.app.turn(req),
  });
  built.sandbox.readProcess = async () => ({ chunks: "build ok\n", cursor: 9, status: { state: "running" } });
  const watchAs = async (actorId: string, botActor: boolean) => {
    const threadRef = `watch-${actorId}`;
    const computer = await built.sandboxResources.create(actorId, scopeId("personal", actorId), "sprites", "Builds");
    await processes.register({
      processId: `build-${actorId}`,
      scopeId: scopeId("personal", actorId),
      sandboxId: computer.id,
      kind: "background",
      command: "npm run build",
      ttlMs: 600_000,
    });
    const armed = await built.app.turn({
      surface: "test",
      actor: { externalId: actorId },
      conversation: { kind: "dm", threadRef },
      text: `watch build-${actorId}`,
      ...(botActor ? { botActor: true } : {}),
    });
    assert.equal(armed.status, "ok", armed.reply);
    return threadRef;
  };
  const threads = [await watchAs("U1", false), await watchAs("release-bot", true)];
  await poller.tick();
  const wakes = await Promise.all(
    threads.map(async (threadRef) =>
      (await built.runs.list({ threadRef })).find((run) => run.request.surface === "monitor"),
    ),
  );
  assert.deepEqual(
    wakes.map((run) => [run?.request.surface, run?.request.botActor]),
    [
      ["monitor", undefined],
      ["monitor", true],
    ],
    "the watch the bot armed wakes as bot work",
  );
});
