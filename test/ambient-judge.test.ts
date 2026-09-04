import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmbientDecision, renderAmbientPrompt, type AmbientBatch } from "../src/surface-cache/ambient-judge.ts";

const base = (over: Partial<AmbientBatch>): AmbientBatch => ({
  container: "C1",
  surface: "slack",
  orders: "",
  self: { name: "agent", mentionId: "U00000002" },
  messages: [],
  ...over,
});

test("backdrop marks messages the direct path owns (handled / self-mention)", () => {
  const prompt = renderAmbientPrompt(
    base({
      backdrop: [
        {
          container: "C1",
          ts: "1.0",
          authorId: "U1",
          authorName: "alice",
          text: "@qm can you make a weekly digest? would that be possible?",
          mentionsSelf: true,
          createdAt: 1,
        },
        {
          container: "C1",
          ts: "2.0",
          authorId: "U1",
          authorName: "alice",
          text: "following up on the thread",
          handled: true,
          createdAt: 2,
        },
        { container: "C1", ts: "3.0", authorId: "U2", authorName: "bob", text: "unrelated chatter", createdAt: 3 },
      ],
      messages: [
        {
          container: "C1",
          ts: "4.0",
          authorId: "U1",
          authorName: "alice",
          text: "random thought: @carol @alice ^",
          createdAt: 4,
        },
      ],
    }),
  );
  const backdrop = prompt.slice(prompt.indexOf("EARLIER CONTEXT"), prompt.indexOf("NEW MESSAGES"));
  const marker = "[handled by the direct responder — do not re-engage]";
  assert.ok(backdrop.includes(`would that be possible? ${marker}`), "the self-mention request is marked owned");
  assert.ok(backdrop.includes(`following up on the thread ${marker}`), "the already-handled message is marked owned");
  assert.ok(!backdrop.includes(`unrelated chatter ${marker}`), "unowned backdrop messages are not marked");
  assert.ok(!prompt.slice(prompt.indexOf("NEW MESSAGES")).includes(marker), "the delta is never marked");
});

test("new messages carry their [id]; backdrop messages do not", () => {
  const prompt = renderAmbientPrompt(
    base({
      backdrop: [
        { container: "C1", ts: "1.0", authorId: "U1", authorName: "alice", text: "old context", createdAt: 1 },
      ],
      messages: [
        {
          container: "C1",
          ts: "2.0",
          authorId: "U2",
          authorName: "bob",
          text: "qm can you check the deploy?",
          createdAt: 2,
        },
      ],
    }),
  );
  assert.ok(prompt.includes("[2.0] bob: qm can you check the deploy?"), "a new message is id-prefixed");
  assert.ok(!prompt.includes("[1.0]"), "a backdrop message carries no id");
});

test("parseAmbientDecision reads asked_by (only on an engage)", () => {
  assert.deepEqual(parseAmbientDecision('{"act": true, "reason": "bob asked", "asked_by": "2.0"}'), {
    act: true,
    reason: "bob asked",
    askedBy: "2.0",
  });
  assert.deepEqual(parseAmbientDecision('{"act": true, "reason": "standing order"}'), {
    act: true,
    reason: "standing order",
  });
  assert.deepEqual(parseAmbientDecision('{"act": false, "asked_by": "2.0"}'), { act: false });
  assert.deepEqual(parseAmbientDecision('{"act": true, "asked_by": "   "}'), { act: true });
  assert.deepEqual(parseAmbientDecision('{"act": true, "asked_by": "[2.0]"}'), { act: true, askedBy: "2.0" });
});
