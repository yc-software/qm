import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeychain, type KeychainAsk, type KeychainGrant } from "../src/credentials/keychain.ts";
import { createKeychainApprovals } from "../src/credentials/keychain-approval.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import {
  keychainApprovalMessage,
  keychainApprovalOrigin,
  registerKeychainApprovalActions,
} from "../src/slack/keychain-approvals.ts";
import type { App } from "../src/api/app.ts";
import type { Directory } from "../src/slack/directory.ts";
import type { SlackCoreClient } from "../src/api/slack-core-client.ts";

async function fixture() {
  let now = Date.now();
  let member = true;
  const grants = createMemoryMap<KeychainGrant>();
  const asks = createMemoryMap<KeychainAsk>();
  const keychain = createKeychain({
    creds: createMemoryMap(),
    grants,
    asks,
    key: deriveConnectorKey("native-approval-test"),
    now: () => now,
  });
  const credential = await keychain.save({ ownerId: "alice@example.com", service: "aws", secret: "fixture-secret" });
  const sessions = createMemorySessionStore();
  const session = await sessions.getOrCreateByThread("web:alice:fixture", "dm", "personal:alice@example.com");
  await sessions.addParticipant(session.id, "alice@example.com");
  const { ask } = await keychain.createAsk({
    credentialId: credential.id,
    requesterId: "alice@example.com",
    requesterScopeId: "personal:alice@example.com",
    requesterThreadRef: session.threadRef,
    requesterSeq: 120,
    requestedMode: "standing",
    purpose: "Read the nightly report",
  });
  const resumed: string[] = [];
  const app = {
    belongsToScope: async () => member,
    listContexts: async () => [{ scopeId: ask.requesterScopeId, name: "the Reports conversation" }],
  } as unknown as Pick<App, "belongsToScope" | "listContexts">;
  const identity = createIdentityService();
  const approvals = createKeychainApprovals({
    keychain,
    app,
    sessions,
    identity,
    resume: async (resolved) => {
      resumed.push(resolved.id);
    },
  });
  return {
    keychain,
    grants,
    asks,
    ask,
    session,
    sessions,
    approvals,
    resumed,
    revokeMembership: () => {
      member = false;
    },
    expire: () => {
      now += 25 * 3600_000;
    },
  };
}

test("native approval persists the explicit duration, resumes once, and replays without minting another grant", async () => {
  const f = await fixture();
  const outcomes = await Promise.all(
    ["standing", "standing", "deny"].map((decision) =>
      f.approvals.decide(f.ask.id, { externalId: "alice@example.com" }, decision as "standing" | "deny"),
    ),
  );
  assert.ok(outcomes.every((view) => view.ask.status === "approved"));
  assert.equal((await f.keychain.getAsk(f.ask.id))?.status, "approved");
  const grants = await f.grants.all();
  assert.equal(grants.length, 1);
  assert.equal(grants[0]!.mode, "standing");
  assert.equal(grants[0]!.audienceScopeId, f.ask.requesterScopeId);
  assert.equal(f.resumed.length, 1);
  assert.equal(outcomes[0]!.seq, 120);
});

test("one-time and denial decisions keep their exact meaning", async () => {
  for (const decision of ["once", "deny"] as const) {
    const f = await fixture();
    const view = await f.approvals.decide(f.ask.id, { externalId: "alice@example.com" }, decision);
    assert.equal(view.ask.status, decision === "deny" ? "declined" : "approved");
    assert.equal((await f.grants.all()).length, decision === "deny" ? 0 : 1);
    if (decision === "once") assert.equal(view.mode, "once");
  }
});

test("wrong owner, revoked membership, and expired requests never grant access", async () => {
  const f = await fixture();
  await assert.rejects(
    f.approvals.decide(f.ask.id, { externalId: "other@example.com" }, "standing"),
    /Only the credential owner/,
  );
  f.revokeMembership();
  await assert.rejects(
    f.approvals.decide(f.ask.id, { externalId: "alice@example.com" }, "standing"),
    /still have access/,
  );
  const expired = await fixture();
  expired.expire();
  assert.equal(
    (await expired.approvals.decide(expired.ask.id, { externalId: "alice@example.com" }, "standing")).ask.status,
    "expired",
  );
  assert.equal((await f.grants.all()).length, 0);
  assert.equal((await expired.grants.all()).length, 0);
});

test("the card links the conversation inline and omits command-policy fields", async () => {
  const f = await fixture();
  const view = (await f.approvals.get(f.ask.id, "alice@example.com"))!;
  const origin = await keychainApprovalOrigin(view, {}, "https://qm.example/web-ui");
  assert.equal(origin, `https://qm.example/web-ui/s/${f.session.id}?seq=120`);
  const card = keychainApprovalMessage(view, origin);
  const wire = JSON.stringify(card);
  assert.match(wire, /\|in the Reports conversation>/);
  assert.doesNotMatch(wire, /Command:|Flagged as:|Allow session|fixture-secret/);
  assert.match(wire, /ongoing access across your personal conversations/);
  for (const [scope, audience] of [
    ["channel:C1", "this channel"],
    ["group:project", "this group"],
  ] as const) {
    const scoped = keychainApprovalMessage({ ...view, ask: { ...view.ask, requesterScopeId: scope } }, origin);
    assert.ok(JSON.stringify(scoped).includes(`ongoing access across ${audience}`));
  }
  const once = keychainApprovalMessage({ ...view, ask: { ...view.ask, requestedMode: "once" } }, origin);
  assert.match(JSON.stringify(once), /one-time access/);
  assert.match(wire, /Allow once/);
  assert.match(wire, /Allow always/);
  assert.match(wire, /Deny/);
  assert.ok(card.blocks.every((block) => block.type !== "context"));
  const settled = keychainApprovalMessage(
    { ...view, ask: { ...view.ask, status: "approved" }, mode: "standing" },
    origin,
  );
  assert.doesNotMatch(JSON.stringify(settled), /action_id/);
  assert.match(settled.text, /ongoing access/);
});

test("Slack action records the authenticated clicker before displaying success", async () => {
  const f = await fixture();
  let handler: (args: any) => Promise<void> = async () => {};
  const updates: unknown[] = [];
  registerKeychainApprovalActions(
    {
      action: (_pattern, fn) => {
        handler = fn;
      },
    },
    {
      core: { keychainApprovals: f.approvals } as SlackCoreClient,
      directory: {
        classifyActor: async (_client, id) => ({
          externalId: id === "UOWNER" ? "alice@example.com" : "other@example.com",
        }),
      } as Directory,
    },
  );
  const errors: unknown[] = [];
  const client = {
    chat: {
      update: async (body: any) => {
        assert.equal((await f.keychain.getAsk(f.ask.id))?.status, "approved");
        updates.push(body);
      },
      postEphemeral: async (body: unknown) => {
        errors.push(body);
      },
    },
  };
  const args = {
    ack: async () => {},
    body: { user: { id: "UOTHER" }, channel: { id: "D1" }, message: { ts: "1.2" } },
    action: { action_id: "keychain_allow_always", value: f.ask.id },
    client,
  };
  await handler(args);
  assert.equal(updates.length, 0);
  assert.equal(errors.length, 1);
  await handler({ ...args, body: { ...args.body, user: { id: "UOWNER" } } });
  assert.equal(updates.length, 1);
});

test("a crash after grant persistence recovers approval before denial or expiry", async () => {
  for (const expire of [false, true]) {
    const f = await fixture();
    const merge = f.asks.merge.bind(f.asks);
    let fail = true;
    f.asks.merge = async (id, patch) => {
      if (fail && patch.status === "approved") {
        fail = false;
        throw new Error("injected persistence failure");
      }
      return merge(id, patch);
    };
    await assert.rejects(f.approvals.decide(f.ask.id, { externalId: "alice@example.com" }, "standing"), /injected/);
    if (expire) f.expire();
    const replay = await f.approvals.decide(f.ask.id, { externalId: "alice@example.com" }, "deny");
    assert.equal(replay.ask.status, "approved");
    assert.equal(replay.mode, "standing");
    assert.equal((await f.grants.all()).length, 1);
    assert.equal((await f.keychain.unnotifiedResolvedAsks(Date.now())).length, 1);
  }
});

test("an expired notification cannot hide an approval recovered after a failed write", async () => {
  for (const notifyBeforeRecovery of [true, false]) {
    const f = await fixture();
    const put = f.grants.putIfAbsent.bind(f.grants);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.grants.putIfAbsent = async (id, grant) => {
      entered();
      await paused;
      return put(id, grant);
    };
    const merge = f.asks.merge.bind(f.asks);
    f.asks.merge = async (id, patch) => {
      if (patch.status === "approved") throw new Error("injected persistence failure");
      return merge(id, patch);
    };
    const approving = assert.rejects(
      f.approvals.decide(f.ask.id, { externalId: "alice@example.com" }, "standing"),
      /injected/,
    );
    await started;
    f.expire();
    assert.equal((await f.keychain.getAsk(f.ask.id))?.status, "expired");
    if (notifyBeforeRecovery) await f.keychain.markAskNotified(f.ask.id, "expired");
    release();
    await approving;
    assert.equal((await f.keychain.getAsk(f.ask.id))?.status, "approved");
    if (!notifyBeforeRecovery) await f.keychain.markAskNotified(f.ask.id, "expired");
    assert.equal((await f.keychain.unnotifiedResolvedAsks(Date.now())).length, 1);
    await f.keychain.markAskNotified(f.ask.id, "approved");
    assert.equal((await f.keychain.unnotifiedResolvedAsks(Date.now())).length, 0);
  }
});

test("approval labels use the owner's session title without exposing inaccessible titles", async () => {
  const f = await fixture();
  await f.sessions.updateTitle(f.session.id, "Nightly report");
  await f.sessions.updateParticipantView(f.session.id, "alice@example.com", { title: "My nightly report" });
  const view = (await f.approvals.get(f.ask.id, "alice@example.com"))!;
  assert.equal(view.conversation, "My nightly report");
  assert.match(JSON.stringify(keychainApprovalMessage(view, "https://qm.example/s/test")), /\|in My nightly report>/);
  f.sessions.getForParticipant = async () => null;
  const hidden = (await f.approvals.get(f.ask.id, "alice@example.com"))!;
  assert.equal(hidden.conversation, "the Reports conversation");
  assert.equal(hidden.sessionId, undefined);
});
