import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesToMessages } from "../src/core-bridge.ts";

test("verified swarm labels survive transcript conversion and quarantined messages stay hidden", () => {
  const swarm = {
    swarmId: "recipient-root",
    messageId: "public-message",
    recipientId: "recipient",
    visibility: "org" as const,
    senderName: "Public sender",
  };
  const messages = entriesToMessages([
    { seq: 1, type: "user", payload: { text: "Automation wrapper", display: "Public text", swarm }, createdAt: 1 },
    {
      seq: 2,
      type: "user",
      payload: { text: "Quarantined", hidden: true, securityTainted: true, swarm },
      createdAt: 2,
    },
  ]);
  assert.equal(messages.length, 1);
  const user = messages[0] as unknown as { role: string; content: string; swarm: unknown };
  assert.equal(user.role, "user");
  assert.equal(user.content, "Public text");
  assert.deepEqual(user.swarm, swarm);
});
