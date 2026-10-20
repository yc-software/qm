import type { Item } from "../src/items.ts";
import { item } from "./item-fixture.ts";
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
  itemsToMessages,
  hasRecordedRunReply,
  pollRun,
  RUN_IDLE_MS,
  setClock,
  type AssistantWork,
} from "../src/core-bridge.ts";

const user = (runId: string): Item =>
  item("UserMessage", { seq: 1, createdAt: 100, text: "Compute the result", turnId: runId });
const answer: Item = item("AgentMessage", { seq: 2, createdAt: 200, text: "The result is 42." });
const fetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = fetch;
  setClock(() => Date.now());
});

test("a poll timeout retains the exact run identity needed to recover its saved answer", async () => {
  setClock(() => RUN_IDLE_MS + 1);
  globalThis.fetch = async () => {
    throw new TypeError("connection interrupted");
  };
  const partial = itemsToMessages([answer])[0] as AssistantWork;
  partial.content = [{ type: "text", text: "" }];
  const stream = createAssistantMessageEventStream();
  await pollRun(stream, partial, "run-current", { acc: "", startOffset: 0, lastProgressAt: 0 });
  const error = (await stream.result()) as AssistantWork;
  assert.equal(error.stopReason, "error");
  assert.equal(error.interruptedRunId, "run-current");
  assert.equal(hasRecordedRunReply([user("run-current"), answer], error.interruptedRunId!), true);
});

test("an idle running snapshot timeout also retains the run identity", async () => {
  setClock(() => RUN_IDLE_MS + 1);
  globalThis.fetch = async () => new Response(JSON.stringify({ status: "running", result: null }));
  const stream = createAssistantMessageEventStream();
  await pollRun(stream, itemsToMessages([answer])[0] as AssistantWork, "run-idle", {
    acc: "",
    startOffset: 0,
    lastProgressAt: 0,
  });
  assert.equal(((await stream.result()) as AssistantWork).interruptedRunId, "run-idle");
});

test("definitive backend failures are not marked as interrupted polling", async () => {
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: "failed", result: { status: "failed", reason: "backend error" } }));
  const stream = createAssistantMessageEventStream();
  await pollRun(stream, itemsToMessages([answer])[0] as AssistantWork, "run-failed", {
    acc: "",
    startOffset: 0,
    lastProgressAt: 0,
  });
  const error = (await stream.result()) as AssistantWork;
  assert.equal(error.stopReason, "error");
  assert.equal(error.interruptedRunId, undefined);
});

test("history must contain a saved assistant response for the exact interrupted run", () => {
  assert.equal(hasRecordedRunReply([user("other-run"), answer], "run-current"), false);
  assert.equal(hasRecordedRunReply([answer, user("run-current")], "run-current"), false);
  assert.equal(hasRecordedRunReply([user("run-current")], "run-current"), false);
  assert.equal(hasRecordedRunReply([answer], "run-current"), false);
  assert.equal(
    hasRecordedRunReply([user("run-current"), { ...answer, variant: "narration", text: "Working…" }], "run-current"),
    false,
  );
  assert.equal(hasRecordedRunReply([user("run-current"), user("later-run"), answer], "run-current"), false);
  assert.equal(
    hasRecordedRunReply([user("run-current"), { ...user("later-run"), hidden: true }, answer], "run-current"),
    false,
  );
});

test("steering within the same run does not hide its saved answer", () => {
  for (const turnId of [null, "run-current"]) {
    const steer = item("SteeringMessage", { seq: 1, createdAt: 100, text: "Compute the result", turnId });
    assert.equal(hasRecordedRunReply([user("run-current"), steer, answer], "run-current"), true);
  }
  assert.equal(
    hasRecordedRunReply(
      [user("run-current"), { ...user("later-run"), kind: "SteeringMessage" }, answer],
      "run-current",
    ),
    false,
  );
});
