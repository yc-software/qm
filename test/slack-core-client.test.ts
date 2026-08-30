import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlackCoreClient } from "../src/api/slack-core-client.ts";

test("SlackCoreClient preserves durable approval metadata", async () => {
  const request = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "D1" },
    text: "approve",
  };
  const client = createSlackCoreClient({
    app: {
      getApproval: async () => ({
        requestId: "request-1",
        sessionId: "session-1",
        command: "mail_send",
        createdAt: 1,
        reason: "security quarantine",
        matched: "blocked pattern",
        purpose: "Send the approved draft",
        summary: "Draft send",
        summaryDetail: "Recipient and body are ready",
        approvalKey: "mail-send",
        grantModes: { session: false, always: false },
        blocksInput: true,
        kind: "input" as const,
        request,
      }),
    } as never,
    config: {} as never,
    runtimeFallback: {} as never,
    blobTransfer: {} as never,
    deliveries: {} as never,
    metrics: {} as never,
    runs: { onTerminal() {} } as never,
    turnStream: {} as never,
    tasks: {} as never,
  });

  assert.deepEqual(await client.getApproval("request-1"), {
    requestId: "request-1",
    command: "mail_send",
    reason: "security quarantine",
    matched: "blocked pattern",
    purpose: "Send the approved draft",
    summary: "Draft send",
    summaryDetail: "Recipient and body are ready",
    approvalKey: "mail-send",
    grantModes: { session: false, always: false },
    blocksInput: true,
    kind: "input",
    request,
  });
});
