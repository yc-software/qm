import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";
import type { Directory } from "../src/slack/directory.ts";
import {
  createKeychainApprovals,
  keychainApprovalMessage,
  type KeychainAskActionId,
} from "../src/slack/keychain-approval.ts";

const prompt = {
  id: "ask-123",
  service: "openai",
  accountLabel: "content team",
  requesterName: "Morgan",
  scopeLabel: "#content",
  purpose: "Create an approved campaign image",
  expiresAt: Date.now() + 60_000,
} as const;

test("keychain approval card offers scoped once, standing, and deny decisions", () => {
  const message = keychainApprovalMessage(prompt);
  assert.match(message.text, /Morgan/);
  assert.match(message.text, /openai/);
  const actions = message.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ text: { text: string }; action_id: KeychainAskActionId; value: string; style?: string }>;
  };
  assert.deepEqual(
    actions.elements.map((element) => [element.text.text, element.action_id, element.value, element.style]),
    [
      ["Allow once", "keychain_ask_allow_once", "ask-123", "primary"],
      ["Always allow here", "keychain_ask_allow_standing", "ask-123", undefined],
      ["Deny", "keychain_ask_deny", "ask-123", "danger"],
    ],
  );
  assert.ok(
    message.blocks
      .flatMap((block) => (block.type === "context" ? ((block.elements as Array<{ text: string }>) ?? []) : []))
      .some((element) => element.text.includes("limited to this credential and Slack conversation")),
  );
});

test("standing requests make the matching scoped decision primary", () => {
  const message = keychainApprovalMessage({ ...prompt, requestedMode: "standing" });
  const actions = message.blocks.find((block) => block.type === "actions") as {
    elements: Array<{ action_id: KeychainAskActionId; style?: string }>;
  };
  assert.equal(actions.elements.find((element) => element.action_id === "keychain_ask_allow_once")?.style, undefined);
  assert.equal(
    actions.elements.find((element) => element.action_id === "keychain_ask_allow_standing")?.style,
    "primary",
  );
});

test("Slack click resolves with the clicker's classified principal and replaces the card", async () => {
  const calls: unknown[] = [];
  const updates: unknown[] = [];
  const core = {
    async resolveKeychainAsk(askId: string, ownerId: string, decision: string) {
      calls.push({ askId, ownerId, decision });
      return {
        askId,
        status: "approved" as const,
        mode: "standing" as const,
        scopeLabel: "channel:C1",
        purpose: "Create an approved campaign image",
      };
    },
  } as unknown as SlackCoreClient;
  const directory = {
    async classifyActor() {
      return { externalId: "owner@example.com" };
    },
  } as unknown as Directory;
  const handlers: Array<(args: any) => Promise<void>> = [];
  createKeychainApprovals({ core, directory }).registerActions({
    action(_pattern, handler) {
      handlers.push(handler);
    },
  });
  let acked = false;
  await handlers[0]!({
    ack: async () => {
      acked = true;
    },
    action: { action_id: "keychain_ask_allow_standing", value: "ask-123" },
    body: { user: { id: "U1" }, channel: { id: "D1" }, message: { ts: "1.2" } },
    client: {
      chat: {
        update: async (body: unknown) => void updates.push(body),
        postEphemeral: async () => undefined,
      },
    },
  });
  assert.equal(acked, true);
  assert.deepEqual(calls, [{ askId: "ask-123", ownerId: "owner@example.com", decision: "standing" }]);
  assert.equal(updates.length, 1);
  assert.match(JSON.stringify(updates[0]), /Always allowed here/);
  assert.doesNotMatch(JSON.stringify(updates[0]), /keychain_ask_allow_once/);
});

test("non-owners receive an ephemeral refusal and the card remains actionable", async () => {
  const ephemerals: unknown[] = [];
  const core = {
    async resolveKeychainAsk() {
      throw Object.assign(new Error("owner mismatch"), { status: 403 });
    },
  } as unknown as SlackCoreClient;
  const directory = {
    async classifyActor() {
      return { externalId: "other@example.com" };
    },
  } as unknown as Directory;
  const handlers: Array<(args: any) => Promise<void>> = [];
  createKeychainApprovals({ core, directory }).registerActions({
    action(_pattern, handler) {
      handlers.push(handler);
    },
  });
  await handlers[0]!({
    ack: async () => undefined,
    action: { action_id: "keychain_ask_allow_once", value: "ask-123" },
    body: { user: { id: "U2" }, channel: { id: "D1" }, message: { ts: "1.2" } },
    client: {
      chat: {
        update: async () => assert.fail("unauthorized click must not replace the card"),
        postEphemeral: async (body: unknown) => void ephemerals.push(body),
      },
    },
  });
  assert.equal(ephemerals.length, 1);
  assert.match(JSON.stringify(ephemerals[0]), /Only the owner/);
});

test("a saved decision is not reported as failed when Slack cannot refresh the card", async () => {
  const ephemerals: unknown[] = [];
  const core = {
    async resolveKeychainAsk(askId: string) {
      return {
        askId,
        status: "approved" as const,
        mode: "standing" as const,
        scopeLabel: "channel:C1",
        purpose: "Create an approved campaign image",
      };
    },
  } as unknown as SlackCoreClient;
  const directory = {
    async classifyActor() {
      return { externalId: "owner@example.com" };
    },
  } as unknown as Directory;
  const handlers: Array<(args: any) => Promise<void>> = [];
  createKeychainApprovals({ core, directory }).registerActions({
    action(_pattern, handler) {
      handlers.push(handler);
    },
  });
  await handlers[0]!({
    ack: async () => undefined,
    action: { action_id: "keychain_ask_allow_standing", value: "ask-123" },
    body: { user: { id: "U1" }, channel: { id: "D1" }, message: { ts: "1.2" } },
    client: {
      chat: {
        update: async () => {
          throw new Error("Slack unavailable");
        },
        postEphemeral: async (body: unknown) => void ephemerals.push(body),
      },
    },
  });
  assert.equal(ephemerals.length, 1);
  assert.match(JSON.stringify(ephemerals[0]), /permission decision was saved/);
  assert.doesNotMatch(JSON.stringify(ephemerals[0]), /couldn't update that credential permission/);
});
