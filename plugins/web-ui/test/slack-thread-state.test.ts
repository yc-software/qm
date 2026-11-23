import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SlackOutbox } from "../src/slack-outbox.ts";
import { collectReactions } from "../src/slack-view.ts";

const said = (speaker: string, content: string, ts?: string) =>
  ({ role: "user", speaker, content, ts }) as AgentMessage;
const text = (m: AgentMessage) => (m as { content: string }).content;

test("a pending Slack reply clears only when its own Slack message arrives", () => {
  const reply = new EventTarget();
  const outbox = new SlackOutbox();
  outbox.listen(reply, { queued() {}, sent() {}, dropped() {} });
  const send = (type: string, detail: object) => reply.dispatchEvent(new CustomEvent(type, { detail }));
  send("slack-sending", { id: "a", sessionId: "s", text: "a & b", speaker: "Ann", speakerId: "ann" });
  send("slack-sent", { id: "a", ts: "1.2" });
  outbox.confirm("s", [said("Bob", "a & b", "1.1")]);
  assert.equal(outbox.pending("s").length, 1);
  outbox.confirm("s", [said("Ann", "a &amp; b", "1.2")]);
  assert.equal(outbox.pending("s").length, 0);
});

test("a reaction lands on the message its full quote names", () => {
  const shared = "Deploy finished for service alpha in region us-east-1";
  const first = said("Bob", `${shared}, all green`);
  const second = said("Bob", `${shared}, two failures`);
  const reaction = said("Ann", `[Slack reaction] Ann reacted with :eyes: on Bob's message: "${shared}, all green".`);
  const { onMessage } = collectReactions([first, second, reaction], text);
  assert.deepEqual([...(onMessage.get(first) ?? [])], [["eyes", ["Ann"]]]);
  assert.equal(onMessage.get(second), undefined);
});
