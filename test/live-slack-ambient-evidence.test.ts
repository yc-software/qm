import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assertAmbientRoundTrip, assertPolicyRestored, type AmbientEvidence } from "./live-slack/ambient-evidence.ts";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/ambient-unprompted-run.json", import.meta.url), "utf8"),
) as AmbientEvidence & { provenance: string };
const [workerId, childId] = recorded.sessions.map((s) => s.id) as [string, string];

const variant = (edit: (e: AmbientEvidence) => void): AmbientEvidence => {
  const e = structuredClone(recorded);
  edit(e);
  return e;
};
const session = (e: AmbientEvidence, id: string) => e.sessions.find((s) => s.id === id)!;

test("the live ambient scenario's checks accept the recorded unprompted round trip and reject each broken variant", () => {
  const failure = (e: AmbientEvidence) => {
    try {
      assertAmbientRoundTrip(e);
      return "pass";
    } catch (err) {
      return (err as Error).message.split("\n")[0];
    }
  };
  const helperAnswer = session(recorded, childId).items.at(-1)!.text!;
  assert.deepEqual(
    {
      recorded: failure(recorded),
      personWorker: failure(variant((e) => (session(e, workerId).session.spawnMeta!.actor = { id: "a@x.com" }))),
      otherChannelWorker: failure(
        variant((e) => (session(e, workerId).session.spawnMeta!.actor = { id: "system:channel:COTHER" })),
      ),
      notUnprompted: failure(variant((e) => (session(e, workerId).session.spawnMeta!.origin = { kind: "automation" }))),
      humanOrigin: failure(variant((e) => (session(e, workerId).session.spawnMeta!.origin = { kind: "human" }))),
      helperNotUnprompted: failure(
        variant((e) => (session(e, childId).session.spawnMeta!.origin = { kind: "automation" })),
      ),
      baselineWorker: failure(variant((e) => (e.baseline = [workerId]))),
      noReturn: failure(
        variant(
          (e) => (session(e, workerId).items = session(e, workerId).items.filter((i) => i.kind !== "ToolResult")),
        ),
      ),
      otherChildReturn: failure(
        variant((e) => {
          for (const i of session(e, workerId).items) i.text = i.text?.replaceAll(childId, "another-child");
        }),
      ),
      answerMismatch: failure(variant((e) => (session(e, childId).items.at(-1)!.text = `${helperAnswer} (edited)`))),
      topLevelReply: failure(variant((e) => delete e.reply!.thread_ts)),
      otherThreadReply: failure(variant((e) => (e.reply!.thread_ts = "1.000001"))),
      adminError: failure(variant((e) => (e.errors = [{ sessionId: childId }]))),
    },
    {
      recorded: "pass",
      personWorker: "the worker ran unprompted as the channel",
      otherChannelWorker: "the worker ran unprompted as the channel",
      notUnprompted: "the worker ran unprompted as the channel",
      humanOrigin: "the worker ran unprompted as the channel",
      helperNotUnprompted: "the helper ran in the same channel as the channel, still unprompted",
      baselineWorker: "this post started a new ambient worker in the channel",
      noReturn: "the helper's final answer came back to the worker as its subagent wake",
      otherChildReturn: "the helper's final answer came back to the worker as its subagent wake",
      answerMismatch: "the returned content is the helper's own final answer",
      topLevelReply: "the worker replied in the note's thread",
      otherThreadReply: "the worker replied in the note's thread",
      adminError: "no refusal or error recorded for the worker or its helper",
    },
  );
  const wanted = { orders: "watch for notes", bots: {}, ambientEnabled: true };
  assert.doesNotThrow(() => assertPolicyRestored(wanted, { ...wanted }));
  assert.throws(() => assertPolicyRestored(wanted, { ...wanted, ambientEnabled: null }), /restored exactly/);
  assert.throws(() => assertPolicyRestored(wanted, undefined), /restored exactly/);
});
