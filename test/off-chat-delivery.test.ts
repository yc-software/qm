import { test } from "node:test";
import assert from "node:assert/strict";
import { withOffChatRecipients } from "../src/delivery/off-chat-delivery.ts";
import type { DeliveryStore } from "../src/delivery/delivery-store.ts";

function harness(chatMembers: string[]) {
  const sent: Array<{ destination: { type: string; target: string }; idempotencyKey: string }> = [];
  const store = {
    enqueue: async (input: (typeof sent)[number]) => (sent.push(input), input),
  } as unknown as DeliveryStore;
  const deliveries = withOffChatRecipients(store, {
    directory: {
      getMany: async (ids: string[]) => new Map(ids.filter((id) => chatMembers.includes(id)).map((id) => [id, {}])),
    },
    sessions: {
      getOrCreateByThread: async (threadRef: string) => ({ id: threadRef, threadRef }),
      addParticipant: async () => {},
    },
    signInMembers: async () => [],
  } as unknown as Parameters<typeof withOffChatRecipients>[1]);
  return { deliveries, sent };
}

const card = (target: string) => ({
  destination: {
    type: "principal" as const,
    target,
    onBehalfOf: target,
    commandApprovalId: "a1",
    webHome: true as const,
  },
  text: "Approval needed: x",
  idempotencyKey: "approval:a1",
});

test("a homed approval card reaches the owner's web DM whichever directory they come from", async () => {
  const webOnly = harness([]);
  await webOnly.deliveries.enqueue(card("owner@example.com"));
  assert.deepEqual(
    webOnly.sent.map((d) => [d.destination.type, d.destination.target]),
    [["web", "web:owner@example.com:direct"]],
  );
  const slack = harness(["U1"]);
  await slack.deliveries.enqueue(card("U1"));
  assert.deepEqual(
    slack.sent.map((d) => [d.destination.type, d.destination.target, d.idempotencyKey]),
    [
      ["principal", "U1", "approval:a1"],
      ["web", "web:U1:direct", "web-home:approval:a1"],
    ],
  );
});

test("a card with a native principal route gets no web copy", async () => {
  const slack = harness(["U1"]);
  const { webHome: _webHome, ...destination } = card("U1").destination;
  await slack.deliveries.enqueue({ ...card("U1"), destination });
  assert.deepEqual(
    slack.sent.map((d) => d.destination.type),
    ["principal"],
  );
});
