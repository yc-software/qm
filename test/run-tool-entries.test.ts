import "./support/auto-fake-sprites.ts";
import { selectDefaultSandbox } from "./support/default-sandbox.ts";

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import type { TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";

const actor = { externalId: "U1" };
function dm(text: string): TurnRequest {
  return {
    surface: "slack",
    actor,
    conversation: { kind: "dm", threadRef: "dm:D-tools", audience: [actor] },
    deliveryTarget: "slack:D-tools",
    text,
    liveActor: true,
    async: true,
  };
}

async function settled(built: ReturnType<typeof buildApp>, runId: string) {
  for (let i = 0; i < 300; i++) {
    const run = await built.runs.get(runId);
    if (run && (run.status === "done" || run.status === "failed")) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`run ${runId} did not settle`);
}

test("a run's tool entries are read from the session, bounded by its turn and its viewer", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "run-tools-")) }));
  built.runtime.start();
  try {
    await selectDefaultSandbox(built, "U1", "personal:U1");
    const first = await built.app.turn(dm("!run echo hi"));
    const run = await settled(built, first.runId!);
    const second = await built.app.turn(dm("plain follow-up"));
    await settled(built, second.runId!);
    const owner = run.request.actor.id;
    const entries = await built.app.getRunToolItems(first.runId!, owner);
    assert.deepEqual(
      entries.map((e) => e.kind),
      ["ToolCall", "ToolResult"],
    );
    assert.equal(entries[0]!.body.command, "echo hi");
    assert.ok(entries.every((e) => e.seq > run.turnUserSeq!));
    assert.deepEqual(await built.app.getRunToolItems(second.runId!, owner), []);
    assert.deepEqual(await built.app.getRunToolItems(first.runId!, "internal:someone-else"), []);
    assert.deepEqual(await built.app.getRunToolItems("missing-run", owner), []);
  } finally {
    await built.runtime.stop();
  }
});

test("a run's tool entries include rounds after a mid-run goal prompt and stop at the next run", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "run-tools-goal-")) }));
  built.runtime.start();
  try {
    await selectDefaultSandbox(built, "U1", "personal:U1");
    const first = await built.app.turn(dm("!run echo hi"));
    const run = await settled(built, first.runId!);
    const session = (await built.sessions.getByThread(run.sessionId))!;
    const { lease } = await built.sessions.acquireLease(session.id);
    await built.sessions.append(lease!, {
      kind: "UserMessage",
      text: "[goal] The active goal is not marked complete. Continue working toward it.",
      hidden: true,
      turnId: run.id,
    });
    const call = await built.sessions.append(lease!, {
      kind: "ToolCall",
      tool: "execute",
      callId: "goal-round",
      body: { command: "make test" },
    });
    await built.sessions.append(lease!, {
      kind: "ToolResult",
      tool: "execute",
      callId: "goal-round",
      isError: false,
      text: "ok",
    });
    await built.sessions.releaseLease(lease!);
    const second = await built.app.turn(dm("!run echo again"));
    await settled(built, second.runId!);
    const owner = run.request.actor.id;
    const callIds = (items: Array<{ callId: string | null }>) => items.map((e) => e.callId);
    const all = await built.app.getRunToolItems(run.id, owner);
    assert.equal(all.length, 4);
    assert.deepEqual(callIds(all.slice(2)), ["goal-round", "goal-round"]);
    assert.deepEqual(callIds(await built.app.getRunToolItems(run.id, owner, call.seq)), ["goal-round"]);
    const next = await built.app.getRunToolItems(second.runId!, owner);
    assert.equal(next.length, 2);
    assert.ok(next.every((e) => e.callId !== "goal-round"));
  } finally {
    await built.runtime.stop();
  }
});

test("each tool entry nudges the run stream once it is durable", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "run-tools-nudge-")) }));
  const log: string[] = [];
  const append = built.sessions.append.bind(built.sessions);
  built.sessions.append = async (lease, entry) => {
    const appended = await append(lease, entry);
    log.push(appended.kind);
    return appended;
  };
  try {
    await selectDefaultSandbox(built, "U1", "personal:U1");
    const turn = await built.app.turn(dm("!run echo hi"));
    const unsubscribe = built.app.subscribeRun(turn.runId!, (event) => {
      if (event.kind === "refresh") log.push("refresh");
    });
    built.runtime.start();
    await settled(built, turn.runId!);
    unsubscribe();
    for (const type of ["ToolCall", "ToolResult"]) {
      const at = log.indexOf(type);
      assert.ok(at >= 0, `${type} was appended`);
      assert.equal(log[at + 1], "refresh", `${type} is followed by a refresh before anything else is appended`);
    }
  } finally {
    await built.runtime.stop();
  }
});
