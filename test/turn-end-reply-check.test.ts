import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";
import type { DecisionRule } from "../src/decisions/decisions.ts";
import type { DecisionStore } from "../src/decisions/store.ts";
import { scopeId } from "../src/types.ts";

const REVISE_MESSAGE = "You used a table the user did not ask for.";
const FIRST_DRAFT = "You said: summarise the options";
const GUIDANCE = "Never use a table unless the person asked for one.";

const draftText = (entry: { payload: unknown }): string => String((entry.payload as { text?: unknown }).text ?? "");

const houseStyle = (mode: DecisionRule["mode"]): DecisionRule => ({
  id: "house-style",
  hook: "turn_end",
  question: "Does the draft reply follow the standing instructions for this conversation?",
  options: {
    keep: { description: "The draft follows them.", action: "keep" },
    revise: { description: "The draft breaks one of them.", action: "revise", message: REVISE_MESSAGE },
  },
  model: { provider: "p", model: "m" },
  mode,
  onError: "keep",
});

function decisionStore(rules: readonly DecisionRule[]): DecisionStore {
  return {
    providers: async () => [],
    rules: async (hook) => rules.filter((rule) => !hook || rule.hook === hook),
    saveProvider: async () => {},
    removeProvider: async () => {},
    saveRule: async () => {},
    removeRule: async () => {},
  };
}

function appWithVerdicts(mode: DecisionRule["mode"], verdicts: readonly ("keep" | "revise")[]) {
  const states: string[] = [];
  const built = buildApp(testConfig({ workers: 1 }), {
    decisions: decisionStore([houseStyle(mode)]),
    decisionBackend: {
      choose: async ({ state }) => {
        const verdict = verdicts[states.length] ?? "keep";
        states.push(state);
        return { "house-style": verdict === "revise" ? { keep: 0.05, revise: 0.95 } : { keep: 0.97, revise: 0.03 } };
      },
    },
  });
  return { built, states };
}

const until = async (done: () => boolean | Promise<boolean>, ms = 5_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !(await done())) await new Promise((r) => setTimeout(r, 25));
};

async function runTurn(options: {
  mode: DecisionRule["mode"];
  threadRef: string;
  text?: string;
  verdicts?: readonly ("keep" | "revise")[];
}) {
  const { built, states } = appWithVerdicts(options.mode, options.verdicts ?? ["revise"]);
  await built.config.setSoul(scopeId("personal", "U1"), GUIDANCE);
  built.runtime.start();
  try {
    const request: TurnRequest = {
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: options.threadRef },
      text: options.text ?? "summarise the options",
      idempotencyKey: options.threadRef,
      async: true,
    };
    const queued = await built.app.turn(request);
    const runId = queued.runId!;
    await built.runs.waitFor(runId, 10_000);
    const run = await built.app.getRun(runId);
    const session = await built.sessions.getByThread(options.threadRef);
    const entries = await built.sessions.getEntries(session!.id);
    return { states, asked: states.length, run, entries };
  } finally {
    await built.runtime.stop();
  }
}

test("an enforcing turn_end rule holds the draft back and delivers the rewrite", async () => {
  const { states, asked, run, entries } = await runTurn({ mode: "enforce", threadRef: "reply-check-enforce" });

  assert.equal(asked, 2);
  const reply = run?.result?.reply ?? "";
  assert.match(reply, new RegExp(REVISE_MESSAGE));
  assert.equal(reply.startsWith(FIRST_DRAFT), false);

  const delivered = entries.filter((e) => e.type === "assistant");
  assert.equal(delivered.length, 1);
  assert.equal(draftText(delivered[0]!), reply);

  const narration = entries.filter((e) => e.type === "text" && draftText(e).startsWith(FIRST_DRAFT));
  assert.equal(narration.length, 1);

  assert.equal(run?.partial?.trim(), reply.trim());
  assert.equal((narration[0]!.payload as { demoted?: boolean }).demoted, true);
  assert.ok(reply.includes(FIRST_DRAFT));
  assert.equal(states.length, 2);

  assert.ok(states[0]!.includes(FIRST_DRAFT));
  assert.ok(states[0]!.includes(GUIDANCE));
});

test("an observing turn_end rule classifies without changing the reply", async () => {
  const { states, run, entries } = await runTurn({ mode: "observe", threadRef: "reply-check-observe" });

  await until(() => states.length === 1);
  assert.equal(states.length, 1);
  assert.equal(run?.result?.reply?.startsWith(FIRST_DRAFT), true);
  assert.equal(entries.filter((e) => e.type === "assistant").length, 1);
  assert.equal(run?.partial?.startsWith(FIRST_DRAFT), true);
});

test("narration before a tool call still streams while the final reply is held", async () => {
  const { run, entries } = await runTurn({
    mode: "enforce",
    threadRef: "reply-check-narration",
    text: "!preamble Looking that up now.",
  });

  assert.equal(run?.partial?.startsWith("Looking that up now."), true);
  assert.equal(run?.partial?.split("All clear").length, 2);
  assert.equal(entries.filter((e) => e.type === "assistant").length, 1);
  assert.ok((run?.result?.reply ?? "").includes(REVISE_MESSAGE));
});

test("a reply the addressed-turn nudge falls back to is checked before it is posted", async () => {
  const { built, states } = appWithVerdicts("enforce", ["keep", "revise"]);
  built.runtime.start();
  try {
    const actor = { externalId: "U1" };
    await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: "ch:C-check:1.1", channelRef: "C-check", audience: [actor] },
      deliveryTarget: "slack:C-check:1.1",
      text: "!shedmute",
      liveActor: true,
      async: true,
    });
    const deadline = Date.now() + 10_000;
    let posted: { text: string }[] = [];
    while (Date.now() < deadline && !posted.length) {
      posted = (await built.deliveries.pending("slack")) as { text: string }[];
      if (!posted.length) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(states.length, 3);
    assert.equal(posted.length, 1);
    assert.ok(posted[0]!.text.includes(REVISE_MESSAGE));
    assert.equal(posted[0]!.text.startsWith("worklog: did the thing but never posted"), false);
  } finally {
    await built.runtime.stop();
  }
});

test("a classifier that always says revise gets two rewrites, then the third draft is delivered", async () => {
  const { states, run, entries } = await runTurn({
    mode: "enforce",
    threadRef: "reply-check-cap",
    verdicts: ["revise", "revise", "revise", "revise"],
  });

  assert.equal(states.length, 2);
  assert.equal(entries.filter((e) => e.type === "assistant").length, 1);
  assert.equal(entries.filter((e) => e.type === "text" && (e.payload as { demoted?: boolean }).demoted).length, 2);
  assert.equal(run?.status, "done");
});

test("a reply that comes with an approval request is not held back, so the approval survives", async () => {
  const { states, run } = await runTurn({
    mode: "enforce",
    threadRef: "reply-check-approval",
    text: "!paused-approval git push --force origin main",
  });

  assert.equal(states.length, 0);
  assert.match(run?.result?.reply ?? "", /about to run it/);
  assert.equal(run?.result?.pendingApprovals?.length, 1);
});

test("once the agent has posted through the surface tool, its leftover text is not sent back for a rewrite", async () => {
  const { built, states } = appWithVerdicts("enforce", ["revise"]);
  built.runtime.start();
  try {
    const actor = { externalId: "U1" };
    await built.app.turn({
      surface: "slack",
      actor,
      conversation: { kind: "channel", threadRef: "ch:C-posted:2.1", channelRef: "C-posted", audience: [actor] },
      deliveryTarget: "slack:C-posted:2.1",
      text: "!post hello team",
      liveActor: true,
      async: true,
    });
    let posted: { text: string }[] = [];
    await until(async () => {
      posted = (await built.deliveries.pending("slack")) as { text: string }[];
      return posted.length > 0;
    });
    await new Promise((r) => setTimeout(r, 300));
    posted = (await built.deliveries.pending("slack")) as { text: string }[];
    assert.deepEqual(
      posted.map((d) => d.text),
      ["hello team"],
    );
    assert.equal(states.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("once a final answer is sent back, the run stops reading as responding while the rewrite is written", async () => {
  const { run } = await runTurn({ mode: "enforce", threadRef: "reply-check-phase", text: "!phased-reply" });

  const phases = (run?.activity ?? [])
    .filter((entry) => entry.type === "text_start")
    .map((entry) => (entry.payload as { phase?: string }).phase);
  assert.ok(phases.includes("final_answer"));
  assert.equal(phases.at(-1), undefined);
});

test("when the reply rules cannot be read, the turn still answers, unchecked", async () => {
  const built = buildApp(testConfig({ workers: 1 }), {
    decisions: {
      ...decisionStore([]),
      rules: async (hook) => {
        if (hook === "turn_end") throw new Error("rules store down");
        return [];
      },
    },
  });
  built.runtime.start();
  try {
    const queued = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "reply-check-store-down" },
      text: "summarise the options",
      idempotencyKey: "reply-check-store-down",
      async: true,
    });
    await built.runs.waitFor(queued.runId!, 10_000);
    const run = await built.app.getRun(queued.runId!);
    assert.equal(run?.status, "done");
    assert.ok(run?.result?.reply);
  } finally {
    await built.runtime.stop();
  }
});

test("a subagent's report to its parent agent is not judged against the person's reply rules", async () => {
  const { built, asked } = (() => {
    const made = appWithVerdicts("enforce", ["revise", "revise", "revise"]);
    return { built: made.built, asked: () => made.states.length };
  })();
  const personal = scopeId("personal", "U1");
  await built.config.setSoul(personal, GUIDANCE);
  const parent = await built.sessions.getOrCreateByThread("dm:U1:reply-check-parent", "dm", personal);
  const child = await built.sessions.getOrCreateByThread("agent:main:subagent:reply-check", "dm", personal);
  await built.sessions.setParentSession(child.id, parent.id);
  await built.sessions.addParticipant(child.id, "U1");
  await built.sessions.setSpawnMeta(child.id, {
    surface: "web",
    actor: { id: "U1", type: "internal" },
    conversation: { kind: "dm", threadRef: parent.threadRef, audience: [{ id: "U1", type: "internal" }] },
  });
  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: child.threadRef },
    text: "report back",
    triggered: true,
  } as TurnRequest);
  assert.equal(result.status, "ok", result.reason);
  assert.equal(asked(), 0);
});
