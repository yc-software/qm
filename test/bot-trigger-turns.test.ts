import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import { runNowSettled } from "./support/settle.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";
import { createServer } from "../src/api/server.ts";
import { serverDeps } from "../src/wiring.ts";
import type { Agent, RuntimeChoice } from "../src/agent/agent.ts";
import type { RuntimeResult } from "../src/agent/runtime-types.ts";
import { scopeId } from "../src/types.ts";
import type { Cron } from "../src/triggers/types.ts";
import { createMonitorPoller } from "../src/monitors/monitor-poller.ts";
import { createIdempotencyStore } from "../src/idempotency/idempotency-store.ts";
import { singleProcessDeps } from "./support/single-process.ts";
import { testMap } from "./support/test-database.ts";

const active: RuntimeChoice = { modelId: "claude-opus-5", effortLevel: "high", fastMode: false };

test("a cron a Slack bot's turn creates runs as the bot's work, with a bot turn's limits, and the bot's turn manages only crons bot work made", async (t) => {
  const runtimes: RuntimeResult[] = [];
  const agent: Agent = {
    async runTurn(turn) {
      if (turn.input === "mint") await turn.tools.execute("true");
      else
        runtimes.push(await turn.runtimeControl!(active, { action: "set", model: active.modelId, lifetime: "task" }));
      return { reply: "done", modelCalls: 1 };
    },
  };
  const config = testConfig({ signingSecret: "bot-trigger-turns".repeat(2), apiBaseUrl: "http://core.test" });
  const built = buildApp(config, { agent });
  let token = "";
  const provision = built.sandbox.provision.bind(built.sandbox);
  built.sandbox.provision = (owner, opts) => {
    token = opts?.env?.AGENT_API_TOKEN ?? token;
    return provision(owner, opts);
  };
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const cronBy = async (botActor: boolean) => {
    await selectDefaultSandbox(built, "U1", scopeId("personal", "U1"));
    const conversation = { kind: "dm" as const, threadRef: `dm:U1:${botActor}` };
    await built.app.turn({ surface: "test", actor: { externalId: "U1" }, conversation, text: "mint", botActor });
    const headers = { "x-agent-capability": token, "content-type": "application/json" };
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/crons`;
    const api = (method: string, path: string, body = {}) =>
      fetch(base + path, { method, headers, body: JSON.stringify(body) });
    const created = await api("POST", "", { schedule: { everyMs: 3_600_000 }, task: `post the ${botActor} notes` });
    const { cron } = (await created.json()) as { cron: Cron };
    await runNowSettled(built.scheduler, cron.id);
    const [fired] = await built.runs.list({ threadRef: (await built.crons.listFires(cron.id)).runs.at(-1)!.threadRef });
    return { api, id: cron.id, botActor: fired?.request.botActor };
  };
  const person = await cronBy(false);
  const bot = await cronBy(true);
  assert.deepEqual([person.botActor, bot.botActor], [undefined, true], "the bot's cron fires as bot work");
  assert.deepEqual(
    runtimes.map((result) => (result.ok ? "ok" : result.error)),
    ["ok", "live_actor_required"],
    "a person's cron may pick its own model for the fire; a bot's cron may not",
  );
  const manage = async (id: string) => [
    (await bot.api("PATCH", `/${id}`, { title: "renamed" })).status,
    (await bot.api("POST", `/${id}/disable`)).status,
    (await bot.api("POST", `/${id}/run`)).status,
  ];
  assert.deepEqual(await manage(bot.id), [200, 200, 400], "bot work in a person's name manages the cron it made");
  assert.deepEqual(await manage(person.id), [403, 403, 403], "but not that person's own cron");
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
