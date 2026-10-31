import { linkedDiscordUserIds } from "../src/api/discord-core-client.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cardCustomId } from "../src/discord/approval-cards.ts";
import { createInteractionHandler, type ButtonClick } from "../src/discord/interactions.ts";
import type { Delivery } from "../src/types.ts";

const DID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const request = {
  surface: "discord",
  actor: { externalId: "discord:111" },
  conversation: {
    kind: "channel",
    threadRef: "discord:th:t1",
    channelRef: "c1",
    audience: [{ externalId: "discord:111" }],
  },
  deliveryTarget: "t1",
  text: "clean the build",
};

function harness(opts: {
  destination: Partial<Delivery["destination"]>;
  approval?: unknown;
  keychainError?: Error;
  keychainView?: unknown;
  omitKeychainApprovals?: boolean;
  readersReady?: boolean;
  readersResult?: unknown;
  hasGuestReader?: boolean;
  slowContinue?: Promise<void>;
  submitFails?: boolean | (() => boolean);
  submitResult?: unknown;
  finalEditFails?: boolean;
  approvalGoneAfterFirstRead?: boolean;
}) {
  const log: string[] = [];
  const continued: Array<Record<string, unknown>> = [];
  let approvalReads = 0;
  const handler = createInteractionHandler({
    core: {
      getDelivery: async (id: string) => {
        log.push("core:getDelivery");
        return id === DID
          ? ({ id, destination: { type: "discord-dm", target: "discord:111", ...opts.destination } } as Delivery)
          : null;
      },
      getApproval: async () => {
        approvalReads += 1;
        if (opts.approvalGoneAfterFirstRead && approvalReads > 1) return null;
        return opts.approval === undefined ? { requestId: "A1", command: "rm", request } : opts.approval;
      },
      decideDeploymentAccess: async (_v: string, _a: unknown, approve: boolean) => (approve ? "Granted" : "Declined"),
      discordUserIdsFor: linkedDiscordUserIds,
      ...(opts.omitKeychainApprovals
        ? {}
        : {
            keychainApprovals: {
              get: async () => null,
              decide: async () => {
                if (opts.keychainError) throw opts.keychainError;
                return (
                  opts.keychainView ?? {
                    ask: { id: "k1", status: "pending" },
                    service: "github",
                    conversation: "#eng",
                  }
                );
              },
            },
          }),
    } as never,
    classifyUser: async (id) => {
      log.push("classify");
      return id === "666" ? { externalId: "discord:666", isExternalGuest: true } : { externalId: `discord:${id}` };
    },
    readersOf: async () => {
      if (opts.readersResult) return opts.readersResult as never;
      if (opts.readersReady === false) return { ok: false, retry: true, reason: "members_not_ready" };
      if (opts.hasGuestReader)
        return {
          ok: true,
          readers: [{ externalId: "discord:111" }, { externalId: "discord:666", isExternalGuest: true }],
        };
      return { ok: true, readers: [{ externalId: "discord:111" }, { externalId: "discord:112" }] };
    },
    continueTurn: async (body, hooks) => {
      continued.push(body as Record<string, unknown>);
      const aud = (body as { conversation?: { audience?: Array<{ isExternalGuest?: boolean }> } }).conversation
        ?.audience;
      if (aud?.some((a) => a.isExternalGuest)) return;
      const fails = typeof opts.submitFails === "function" ? opts.submitFails() : opts.submitFails;
      if (fails) return;
      await hooks.onAccepted();
      await hooks.onSettled((opts.submitResult ?? { status: "ok" }) as never);
      await opts.slowContinue;
    },
  });
  const click = (userId: string, customId: string): ButtonClick => ({
    customId,
    userId,
    defer: async () => void log.push("defer"),
    refuse: async (c) => void log.push(`refuse:${c}`),
    settle: async (c) => void log.push(`settle:${c}`),
    settleFinal: async (c) => {
      if (opts.finalEditFails) throw new Error("edit failed");
      log.push(`final:${c}`);
    },
  });
  return { handler, click, log, continued };
}

test("the click is deferred before any core call", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" } });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(h.log[0], "defer");
});

test("a click by a non-requester is refused ephemerally and submits nothing", async () => {
  const h = harness({ destination: { commandApprovalId: "A1", target: "discord:112" } });
  await h.handler(h.click("112", cardCustomId("cmd", "always", DID)));
  assert.equal(h.log.at(-1), "refuse:Only the person who requested this command can approve or deny it.");
  assert.deepEqual(h.continued, []);
});

test("the requester's click settles the card and continues the turn with fresh readers and an idempotency key", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" } });
  await h.handler(h.click("111", cardCustomId("cmd", "session", DID)));
  assert.ok(h.log.includes("settle:Approving `rm`…"));
  assert.ok(h.log.includes("final:Approved (session): `rm`"));
  const body = h.continued[0] as {
    approval: unknown;
    conversation: { audience: unknown[] };
    deliveryTarget: string;
    idempotencyKey: string;
    surface?: unknown;
  };
  assert.deepEqual(body.approval, { requestId: "A1", approved: true, scope: "session" });
  assert.equal(body.conversation.audience.length, 2);
  assert.equal(body.deliveryTarget, "t1");
  assert.equal(body.idempotencyKey, "discord-approval:A1");
  assert.equal(body.surface, undefined);
});

test("two clicks on the same card on the same handler instance refuse the second with busy text and continue once", async () => {
  let release!: () => void;
  const h = harness({
    destination: { commandApprovalId: "A1" },
    slowContinue: new Promise<void>((r) => (release = r)),
  });
  const first = h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  await new Promise((r) => setTimeout(r, 10));
  const second = h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  await new Promise((r) => setTimeout(r, 10));
  release();
  await Promise.all([first, second]);
  assert.equal(h.continued.length, 1);
  assert.ok(h.log.includes("refuse:Already working on that decision."));
});

test("a continuation that core does not accept leaves the card actionable and says so ephemerally", async () => {
  let submitFails = true;
  const h = harness({ destination: { commandApprovalId: "A1" }, submitFails: () => submitFails });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(
    h.log.some((l) => l.startsWith("settle:") || l.startsWith("final:")),
    false,
  );
  assert.equal(h.log.at(-1), "refuse:I couldn't continue that yet. The card is still active, so try again.");
  submitFails = false;
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.ok(h.log.includes("final:Approved (once): `rm`"));
});

test("deny submits a denial with no scope", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" } });
  await h.handler(h.click("111", cardCustomId("cmd", "deny", DID)));
  assert.deepEqual((h.continued[0] as { approval: unknown }).approval, { requestId: "A1", approved: false });
});

test("a click by a guest or unlinked user is refused before the delivery is read", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" } });
  await h.handler(h.click("666", cardCustomId("cmd", "once", DID)));
  assert.deepEqual(h.log, ["defer", "classify", "refuse:Only people in the organization can decide this."]);
});

test("a click while readers are unknown refuses without settling the card", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" }, readersReady: false });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(
    h.log.at(-1),
    "refuse:I can't confirm who can read that conversation right now. Try the button again in a minute.",
  );
  assert.equal(
    h.log.some((l) => l.startsWith("settle:")),
    false,
  );
  assert.deepEqual(h.continued, []);
});

test("a card whose base channel now has a guest reader leaves the card actionable and refuses ephemerally", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" }, hasGuestReader: true });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(
    h.log.some((l) => l.startsWith("settle:") || l.startsWith("final:")),
    false,
  );
  assert.equal(h.log.at(-1), "refuse:I couldn't continue that yet. The card is still active, so try again.");
  assert.equal(h.continued.length, 1);
  const continuedAudience = (h.continued[0] as { conversation: { audience: Array<{ isExternalGuest?: boolean }> } })
    .conversation.audience;
  assert.ok(continuedAudience.some((a) => a.isExternalGuest));
});

test("an expired approval settles the card without a turn", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" }, approval: null });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.match(h.log.at(-1)!, /^settle:.*no longer pending/);
  assert.deepEqual(h.continued, []);
});

test("keychain decision by a non-owner surfaces the core refusal", async () => {
  const h = harness({
    destination: { keychainAskId: "k1", target: "discord:112" },
    keychainError: new Error("Only the credential owner can decide this request."),
  });
  await h.handler(h.click("112", cardCustomId("key", "once", DID)));
  assert.equal(h.log.at(-1), "refuse:Couldn't complete that: Only the credential owner can decide this request.");
});

test("deploy access is decided by core and the card shows its answer", async () => {
  const h = harness({ destination: { deploymentAccess: { deploymentId: "d", requesterId: "bob@acme.com" } } });
  await h.handler(h.click("111", cardCustomId("dep", "approve", DID)));
  assert.equal(h.log.at(-1), "settle:Granted");
});

test("a stale or already-settled card is refused as a stale button", async () => {
  const h = harness({ destination: { deploymentAccess: { deploymentId: "d", requesterId: "b" } } });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(h.log.at(-1), "refuse:This button is no longer valid.");
});

test("keychain settle text reflects the decided state when already allowed and click is deny", async () => {
  const h = harness({
    destination: { keychainAskId: "k1" },
    keychainView: {
      ask: { id: "k1", status: "approved", requesterScopeId: "s" },
      service: "github",
      conversation: "#eng",
      mode: "standing",
    },
  });
  await h.handler(h.click("111", cardCustomId("key", "deny", DID)));
  assert.equal(h.log.at(-1), "settle:Always allowed.");
});

test("a command approval for a different surface refuses as a stale button", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1" },
    approval: {
      requestId: "A1",
      command: "rm -rf build",
      request: {
        surface: "slack",
        actor: { externalId: "discord:111" },
      },
    },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(h.log.at(-1), "refuse:This button is no longer valid.");
  assert.deepEqual(h.continued, []);
});

test("a keychain click when keychainApprovals is absent on core refuses as a stale button", async () => {
  const h = harness({
    destination: { keychainAskId: "k1" },
    omitKeychainApprovals: true,
  });
  await h.handler(h.click("111", cardCustomId("key", "once", DID)));
  assert.equal(h.log.at(-1), "refuse:This button is no longer valid.");
});

test("unreadable channel final failure refuses locally without continuing turn", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1" },
    readersResult: { ok: false, retry: false, reason: "not_a_guild_channel" },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(
    h.log.at(-1),
    "refuse:I can't confirm who can read that conversation right now. Try the button again in a minute.",
  );
  assert.deepEqual(h.continued, []);
});

test("a continuation refused by core settles the final card as Not approved, never Approved", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1" },
    submitResult: {
      status: "refused",
      reason: "internal-only: shared audience includes a non-internal participant",
    },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(
    h.log.some((l) => l.includes("Approved")),
    false,
  );
  assert.ok(
    h.log.includes(
      "final:Not approved: I can't answer here: people outside the organization can read this channel. Ask me in a private channel or a DM. The request is still pending; use the web link in the thread to retry.",
    ),
  );
});

test("a refusal after the approval record is gone says it is no longer pending", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1" },
    approval: { requestId: "A1", command: "x", request },
    submitResult: { status: "refused", reason: "nope" },
    approvalGoneAfterFirstRead: true,
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.ok(h.log.includes("final:Not approved: I can't do that: nope That approval request is no longer pending."));
});

test("a deny click whose result is refused with approval denied shows Denied", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1" },
    approval: { requestId: "A1", command: "x", request },
    submitResult: { status: "refused", reason: "approval denied for x" },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "deny", DID)));
  assert.ok(h.log.includes("settle:Denying `x`…"));
  assert.ok(h.log.includes("final:Denied: `x`"));
});

test("an approve click refused with approval denied text is not shown as Denied or Approved", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1" },
    submitResult: { status: "refused", reason: "approval denied for rm" },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(
    h.log.some((l) => l.startsWith("final:Approved") || l.startsWith("final:Denied")),
    false,
  );
});

test("a failed run shows the failure text on the final card", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" }, submitResult: { status: "failed" } });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.ok(h.log.includes("final:Something went wrong on my end and I couldn't finish that. Try again in a moment."));
});

test("a failing final edit never throws into the click handler", async () => {
  const h = harness({ destination: { commandApprovalId: "A1" }, finalEditFails: true });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.ok(h.log.includes("settle:Approving `rm`…"));
  assert.equal(
    h.log.some((l) => l.startsWith("refuse:")),
    false,
  );
});

test("a keychain click by the recipient decides the ask", async () => {
  const h = harness({
    destination: { keychainAskId: "k1" },
    keychainView: {
      ask: { id: "k1", status: "approved", requesterScopeId: "s" },
      service: "github",
      conversation: "#eng",
      mode: "once",
    },
  });
  await h.handler(h.click("111", cardCustomId("key", "once", DID)));
  assert.equal(h.log.at(-1), "settle:Allowed once.");
});

test("a delivery whose type is not discord-dm refuses as a stale button", async () => {
  const h = harness({
    destination: { type: "discord", commandApprovalId: "A1" },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(h.log.at(-1), "refuse:This button is no longer valid.");
});

test("a clicker who is not the DM recipient refuses as a stale button", async () => {
  const h = harness({
    destination: { commandApprovalId: "A1", target: "discord:999" },
  });
  await h.handler(h.click("111", cardCustomId("cmd", "once", DID)));
  assert.equal(h.log.at(-1), "refuse:This button is no longer valid.");
});
