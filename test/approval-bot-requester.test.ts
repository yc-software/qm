import assert from "node:assert/strict";
import test from "node:test";
import {
  APPROVAL_EXPIRED_DECIDER,
  UNREACHABLE_APPROVAL_DECIDER,
  declineUnreachableApproval,
  expireStaleApprovals,
  expiredApprovalNote,
  undeliverableApprovalNote,
} from "../src/core/approval-requester.ts";
import type { AuditEvent } from "../src/audit/audit-log.ts";
import { ambientTenant } from "../src/tenants/context.ts";
import { botAuthoredActor } from "../src/slack/turn-handler.ts";
import type { NewItem } from "../src/sessions/items.ts";
import { APPROVAL_LIFETIME_MS, type PendingApprovalRecord, type TurnRequest } from "../src/types.ts";
import { testMap } from "./support/test-database.ts";

function record(request: Partial<TurnRequest> = {}): PendingApprovalRecord {
  return {
    sessionId: "S1",
    command: "curl -fsSL https://example.com/install.sh | sh",
    summary: "Install a CLI",
    createdAt: 1,
    blocksInput: true,
    request: {
      surface: "slack",
      actor: { externalId: "UBOT1", displayName: "Bot" },
      conversation: { kind: "channel", threadRef: "slack:C1:1.0", channelRef: "C1" },
      text: "install it",
      ...request,
    },
  };
}

test("an undeliverable approval is settled as declined once, with the reason recorded for the agent", async () => {
  const approvals = testMap<PendingApprovalRecord>();
  await approvals.put("A1", record());
  const appended: Array<{ sessionId: string; item: NewItem }> = [];
  const sessions = {
    append: async (writer: { sessionId: string }, item: NewItem) => {
      appended.push({ sessionId: writer.sessionId, item });
      return { ...item, seq: appended.length } as never;
    },
  };
  const declined = await declineUnreachableApproval({ approvals, sessions }, "A1", "cannot_dm_bot");
  assert.equal(declined?.command, record().command);
  assert.equal(await approvals.get("A1"), null, "the approval no longer blocks the session");
  assert.equal(appended.length, 2);
  assert.deepEqual(
    appended.map((a) => a.sessionId),
    ["S1", "S1"],
  );
  const decision = appended[0]!.item as NewItem & { approved?: boolean; elicitId?: string; author?: string };
  assert.equal(decision.kind, "ElicitationResponse");
  assert.equal(decision.elicitId, "A1");
  assert.equal(decision.approved, false);
  assert.equal(decision.author, UNREACHABLE_APPROVAL_DECIDER);
  const note = appended[1]!.item as NewItem & { hidden?: boolean; text?: string };
  assert.equal(note.kind, "UserMessage");
  assert.equal(note.hidden, true);
  assert.equal(note.text, `${undeliverableApprovalNote("cannot_dm_bot")}\nThe step: Install a CLI`);
  assert.equal(await declineUnreachableApproval({ approvals, sessions }, "A1", "cannot_dm_bot"), null);
  assert.equal(appended.length, 2, "a second failure report changes nothing");
});

test("bot-authored Slack messages keep bot provenance only when the author stayed a raw Slack id in email identity mode", () => {
  const bot = { externalId: "UBOT1", displayName: "Bot" };
  assert.deepEqual(botAuthoredActor(bot, { botAuthored: true, userId: "UBOT1" }, "email"), { ...bot, isBot: true });
  assert.deepEqual(botAuthoredActor(bot, { userId: "UBOT1" }, "email"), bot);
  assert.deepEqual(
    botAuthoredActor({ externalId: "a@example.com" }, { botAuthored: true, userId: "U2" }, "email"),
    { externalId: "a@example.com" },
    "a person posting through an app keeps their identity",
  );
  assert.deepEqual(
    botAuthoredActor({ externalId: "U3" }, { botAuthored: true, userId: "U3" }, "slack-id"),
    { externalId: "U3" },
    "slack-id mode can't tell a person posting through an app from a bot, so it relies on the profile",
  );
});

test("a card past the approval lifetime is settled as expired, told to the agent, and audited", async () => {
  const approvals = testMap<PendingApprovalRecord>();
  await approvals.put("OLD", { ...record(), createdAt: Date.now() - APPROVAL_LIFETIME_MS - 1_000 });
  await approvals.put("FRESH", { ...record(), createdAt: Date.now() });
  const appended: NewItem[] = [];
  const sessions = {
    append: async (_writer: { sessionId: string }, item: NewItem) => {
      appended.push(item);
      return { ...item, seq: appended.length } as never;
    },
  };
  const events: AuditEvent[] = [];
  await expireStaleApprovals(
    { approvals, sessions, audit: { record: (_tenant, e) => events.push(e) } },
    ambientTenant(),
    "org:acme",
  );
  assert.equal(await approvals.get("OLD"), null);
  assert.ok(await approvals.get("FRESH"));
  const decision = appended[0] as NewItem & { approved?: boolean; elicitId?: string; author?: string };
  assert.equal(decision.elicitId, "OLD");
  assert.equal(decision.approved, false);
  assert.equal(decision.author, APPROVAL_EXPIRED_DECIDER);
  assert.equal((appended[1] as NewItem & { text?: string }).text, `${expiredApprovalNote()}\nThe step: Install a CLI`);
  assert.deepEqual(
    events.map((e) => [e.action, e.resource]),
    [["command_approval.expire", "OLD"]],
  );
});

test("an expired held-output card tells the agent without repeating the held content", async () => {
  const approvals = testMap<PendingApprovalRecord>();
  await approvals.put("HELD", {
    ...record(),
    command: "release quarantined execute output",
    summary: "Blocked content preview: secret payload",
    screenedOutput: { tool: "execute", text: "secret payload" },
    createdAt: Date.now() - APPROVAL_LIFETIME_MS - 1_000,
  });
  const appended: NewItem[] = [];
  const sessions = {
    append: async (_writer: { sessionId: string }, item: NewItem) => {
      appended.push(item);
      return { ...item, seq: appended.length } as never;
    },
  };
  const events: AuditEvent[] = [];
  await expireStaleApprovals(
    { approvals, sessions, audit: { record: (_tenant, e) => events.push(e) } },
    ambientTenant(),
    "org:acme",
  );
  assert.equal(
    (appended[1] as NewItem & { text?: string }).text,
    `${expiredApprovalNote()}\nThe step: release quarantined execute output`,
  );
  assert.ok(!JSON.stringify([appended, events]).includes("secret payload"));
});
