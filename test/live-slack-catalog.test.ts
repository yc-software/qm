import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Ctx, type Env } from "./live-slack/harness.ts";
import { SlackClient, type SlackMessage } from "./live-slack/slack.ts";
import { scenarios } from "./live-slack/scenarios.ts";

function context(name: string) {
  const scenario = scenarios.find((item) => item.name === name)!;
  const qa = new SlackClient("test", "http://127.0.0.1");
  qa.createChannel = async () => "CHANNEL";
  qa.invite = async () => {};
  qa.post = async () => "1";
  qa.getPermalink = async () => "https://example.test/message";
  const env = {
    qa,
    botUserId: "BOT",
    runId: "catalog",
    targetChannel: "CTARGET123",
    actors: new Map([["alice", { name: "alice", client: qa, userId: "ALICE" }]]),
  } as Env;
  return { scenario, qa, ctx: new Ctx(env, scenario, 1) };
}

test("channel-audience check sees broadcasts but still rejects a missing marker", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const { scenario, qa, ctx } = context("mu-audience-answer-in-channel");
  qa.replies = async () => [];
  qa.history = async () => [
    { ts: "2", user: "BOT", text: "Monday" },
    { ts: "3", user: "OTHER", text: ctx.marker() },
    { ts: "4", thread_ts: "unrelated", user: "BOT", text: ctx.marker() },
    ...(Date.now() >= 110_000 ? [{ ts: "5", thread_ts: "5", user: "BOT", text: `Monday ${ctx.marker()}` }] : []),
  ];
  let settled = false;
  let failure: unknown;
  const result = scenario.run(ctx).then(
    () => {
      settled = true;
    },
    (error) => {
      settled = true;
      failure = error;
    },
  );
  await setImmediate();
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(2500);
    await setImmediate();
  }
  assert.equal(settled, false);
  for (let i = 0; i < 100 && !settled; i++) {
    t.mock.timers.tick(2500);
    await setImmediate();
  }
  await result;
  assert.ifError(failure);
  assert.equal(ctx.timeline.botMessages().at(-1)?.ts, "5");
});

for (const progress of ["reaction", "acknowledgment", "other-user-reaction", "late-acknowledgment", "none"]) {
  test(`long task progress: ${progress}`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
    const { scenario, qa, ctx } = context("long-task-streaming");
    qa.replies = async () =>
      [
        {
          ts: "1",
          user: "QA",
          reactions: progress.includes("reaction")
            ? [{ name: "eyes", users: [progress === "reaction" ? "BOT" : "OTHER"] }]
            : [],
        },
        ...(progress === "acknowledgment" ? [{ ts: "2", user: "BOT", text: "I'll explain how DNS works." }] : []),
        ...(Date.now() >= 102_500 ? [{ ts: "3", user: "BOT", text: "DNS ".repeat(150) }] : []),
        ...(progress === "late-acknowledgment" && Date.now() >= 105_000
          ? [{ ts: "4", user: "BOT", text: "All done." }]
          : []),
      ] as SlackMessage[];
    const run = scenario.run(ctx);
    const result =
      progress === "reaction" || progress === "acknowledgment" ? run : assert.rejects(run, /acknowledgment/);
    await setImmediate();
    for (let i = 0; i < 4; i++) {
      t.mock.timers.tick(2500);
      await setImmediate();
    }
    await result;
  });
}

for (const name of ["context-pull-cross-channel", "channel-reach"]) {
  test(`${name} names the channel actually seeded by the fixture`, async () => {
    const { scenario, ctx, qa } = context(name);
    qa.history = async () => [{ ts: "2", user: "BOT", text: ctx.marker() }];
    ctx.freshChannel = async () =>
      ({
        mention: async (text: string) => {
          assert.ok(text.includes("CTARGET123"));
          return "1";
        },
        waitForBotReply: async () => ({ text: ctx.marker("xchan") }),
      }) as never;
    await scenario.run(ctx);
  });
}

for (const [name, tool] of [
  ["execute-turn", "execute"],
  ["perf-budget", "execute"],
  ["perf-budget", "sandbox"],
]) {
  test(`${name} waits past an acknowledgment for successful ${tool} output`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
    const { scenario, qa, ctx } = context(name!);
    const output = name === "execute-turn" ? "Linux test 6.1.0-test" : ctx.marker("executed");
    qa.replies = async () => [
      { ts: "2", user: "BOT", text: "I'll run that now." },
      ...(Date.now() >= 120_000 ? [{ ts: "3", user: "BOT", text: output }] : []),
    ];
    ctx.env.core = {
      findSessionByThread: async () => ({
        id: "session",
        entries: [
          {
            type: "tool_result",
            payload: { tool, action: "exec", code: 0, isError: false, timedOut: false, stdout: `${output}\n` },
          },
        ],
      }),
      getSession: async () => ({
        entries: Date.now() >= 130_000 ? [{ type: "assistant", payload: { workFinishedAt: 130_000 } }] : [],
      }),
      getSessionLlm: async () => {
        assert.ok(Date.now() >= 130_000, "metrics must be read after the turn finishes");
        return { requests: [{ stepGapMs: 1, gapPhases: {} }] };
      },
    } as never;
    let settled = false;
    const result = scenario.run(ctx).then(() => {
      settled = true;
    });
    await setImmediate();
    for (let i = 0; i < 3; i++) {
      t.mock.timers.tick(2500);
      await setImmediate();
    }
    assert.equal(settled, false);
    for (let i = 0; i < 12; i++) {
      t.mock.timers.tick(2500);
      await setImmediate();
    }
    await result;
  });
}

test("performance check rejects failed execution before evaluating timing", async () => {
  const { scenario, ctx } = context("perf-budget");
  ctx.freshChannel = async () =>
    ({ id: "CHANNEL", mention: async () => "1", waitForBotReply: async () => ({}) }) as never;
  ctx.env.core = {
    findSessionByThread: async () => ({
      id: "session",
      entries: [{ type: "tool_result", payload: { tool: "execute", isError: true } }],
    }),
    getSessionLlm: async () => ({ requests: [{ stepGapMs: 1, gapPhases: {} }] }),
  } as never;
  await assert.rejects(scenario.run(ctx), /successful.*execut/);
});
