import "./support/auto-fake-sprites.ts";

import { test, describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import {
  createKeychain,
  renderKeychainManifest,
  KeychainError,
  ASK_TTL_MS,
  ASK_PRUNE_AFTER_MS,
  type Keychain,
  type KeychainAsk,
} from "../src/credentials/keychain.ts";
import { createAskExpirySweep, fireAskResolution } from "../src/triggers/keychain-ask.ts";
import { runTrigger } from "../src/triggers/run-trigger.ts";
import { createScheduler } from "../src/cron/scheduler.ts";
import { createCronStore } from "../src/cron/cron-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { createIdempotencyStore, type IdempotencyRecord } from "../src/idempotency/idempotency-store.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS, type CapabilityClaims } from "../src/auth/capability-token.ts";
import { scopeId, type TurnRequest, type TurnResult } from "../src/types.ts";
import { fakeSprites } from "./support/auto-fake-sprites.ts";
import { testConfig } from "./support/test-config.ts";

const KEY = deriveConnectorKey("keychain-ask-test-key");
const SECRET = "keychain-ask-route-secret".repeat(3);

function kcAt(now: () => number): Keychain {
  return createKeychain({
    creds: createMemoryMap(),
    grants: createMemoryMap(),
    asks: createMemoryMap(),
    key: KEY,
    now,
  });
}

const GH = {
  ownerId: "U_ALICE",
  service: "github",
  secret: "ghp_alice",
  envKey: "GITHUB_TOKEN",
  accountLabel: "alice-acme",
};

test("createAsk: owner derived from the credential, purpose frozen, dedup per (credential, scope, task)", async () => {
  const k = kcAt(() => 1_000_000);
  const cred = await k.save(GH);

  await assert.rejects(
    k.createAsk({ credentialId: "nope", requesterId: "U_BOB", requesterScopeId: "channel:C1", purpose: "x" }),
    (e: KeychainError) => e.status === 404,
  );
  const self = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_ALICE",
    requesterScopeId: "personal:U_ALICE",
    purpose: "scheduled check",
  });
  assert.equal(self.ask.status, "pending");
  await assert.rejects(
    k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "personal:U_BOB", purpose: "x" }),
    (e: KeychainError) => e.status === 403,
  );

  const { ask, existing } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "  clone acme/payments and run the tests  ",
    requesterThreadRef: "ch:C1-t1",
  });
  assert.equal(existing, false);
  assert.equal(ask.ownerId, "U_ALICE", "owner comes from the credential record, never the caller");
  assert.equal(ask.purpose, "clone acme/payments and run the tests");
  assert.equal(ask.status, "pending");
  assert.equal(ask.expiresAt, 1_000_000 + ASK_TTL_MS);

  const again = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "different words",
    requesterThreadRef: "ch:C1-t1",
  });
  assert.equal(again.existing, true);
  assert.equal(again.ask.id, ask.id, "one pending ask per (credential, scope, task) — re-asks are silent");
  assert.equal(again.ask.purpose, "clone acme/payments and run the tests", "the original purpose stays frozen");

  const elsewhere = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C2",
    purpose: "other room",
  });
  assert.equal(elsewhere.existing, false, "a different scope is a different ask");
});

test("personal cron asks deduplicate recurring fires without combining jobs or re-asking after denial", async () => {
  let now = 1000000;
  const k = kcAt(() => now++);
  const cred = await k.save(GH);
  const base = {
    credentialId: cred.id,
    requesterId: "U_ALICE",
    requesterScopeId: "personal:U_ALICE" as const,
    purpose: "first task",
    triggered: true,
  };
  const first = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:one" });
  const second = await k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:one", purpose: "second task" });
  assert.notEqual(first.ask.id, second.ask.id);
  const retry = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:two" });
  assert.equal(retry.ask.id, first.ask.id);
  assert.equal(retry.ask.requesterThreadRef, "cron:first:fire:one");
  assert.equal(retry.existing, true);
  await k.declineAsk({ askId: first.ask.id, ownerId: "U_ALICE", note: "no" });
  await assert.rejects(
    k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:three" }),
    (e: KeychainError) => e.status === 409,
  );
  const revived = await k.createAsk({ ...base, triggered: false, requesterThreadRef: "cron:first:fire:four" });
  const waiting = await k.createAsk({ ...base, requesterThreadRef: "cron:first:fire:five" });
  assert.equal(waiting.ask.id, revived.ask.id);
  await k.approveAsk({ askId: revived.ask.id, ownerId: "U_ALICE", mode: "once", purpose: "yes" });
  assert.equal((await k.getAsk(second.ask.id))?.status, "pending");
  now += ASK_TTL_MS + 1;
  await assert.rejects(
    k.createAsk({ ...base, requesterThreadRef: "cron:second:fire:two" }),
    (e: KeychainError) => e.status === 409,
  );
});

for (const outcome of ["declined", "expired"] as const) {
  test(`task ${outcome} decisions survive pruning and a later approval supersedes them`, async () => {
    let now = 1_000_000;
    const k = kcAt(() => now++);
    const credential = await k.save(GH);
    const input = {
      credentialId: credential.id,
      requesterId: "U_ALICE",
      requesterScopeId: "personal:U_ALICE" as const,
      requesterThreadRef: "cron:retained:fire:first",
      purpose: "scheduled check",
      triggered: true,
    };
    const { ask } = await k.createAsk(input);
    if (outcome === "declined") await k.declineAsk({ askId: ask.id, ownerId: "U_ALICE" });
    else now += ASK_TTL_MS + 1;
    const sweep = createAskExpirySweep({ keychain: k, fire: async () => undefined });
    await sweep(now);
    now += ASK_PRUNE_AFTER_MS + 1;
    await sweep(now);
    assert.equal((await k.getAsk(ask.id))?.status, outcome);
    await assert.rejects(
      k.createAsk({ ...input, requesterThreadRef: "cron:retained:fire:later" }),
      (e: KeychainError) => e.status === 409,
    );
    const revived = await k.createAsk({ ...input, triggered: false });
    await k.approveAsk({ askId: revived.ask.id, ownerId: "U_ALICE", mode: "once", purpose: "retry it" });
    await sweep(now);
    now += ASK_PRUNE_AFTER_MS + 1;
    await sweep(now);
    assert.equal(await k.getAsk(ask.id), null);
    assert.equal((await k.getAsk(revived.ask.id))?.status, "approved");
    const next = await k.createAsk({ ...input, requesterThreadRef: "cron:retained:fire:next" });
    assert.equal(next.existing, false);
    assert.equal(next.ask.status, "pending");
  });
}

test("approveAsk: same createGrant owner gate, audience from the record, single resolution", async () => {
  const k = kcAt(Date.now);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "clone the repo",
  });

  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_BOB", mode: "once", purpose: "alice said fine" }),
    (e: KeychainError) => e.status === 403,
  );
  assert.equal((await k.getAsk(ask.id))?.status, "pending");
  await assert.rejects(
    k.approveAsk({ askId: "deadbeef0000", ownerId: "U_ALICE", mode: "once", purpose: "x" }),
    (e: KeychainError) => e.status === 404,
  );

  const { ask: approved, grant } = await k.approveAsk({
    askId: ask.id,
    ownerId: "U_ALICE",
    mode: "once",
    purpose: "sure, just this once",
  });
  assert.equal(approved.status, "approved");
  assert.equal(approved.grantId, grant.id);
  assert.equal(grant.audienceScopeId, "channel:C1", "audience comes from the ask record — the approver named no scope");
  assert.equal(grant.askId, ask.id);
  assert.equal(grant.purpose, "sure, just this once", "the grant binds the OWNER's verbatim words");

  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "again" }),
    (e: KeychainError) => e.status === 410,
    "re-approve is a replay",
  );

  await assert.rejects(k.materialize(grant.id, "channel:OTHER", "U_BOB"), (e: KeychainError) => e.status === 403);
  const m = await k.materialize(grant.id, "channel:C1", "U_BOB");
  assert.ok(m.kind === "env" && m.env[0]!.value === "ghp_alice");
  await assert.rejects(k.materialize(grant.id, "channel:C1", "U_BOB"), (e: KeychainError) => e.status === 410);
});

test("declineAsk is owner-gated and single-resolution", async () => {
  const k = kcAt(Date.now);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });

  await assert.rejects(k.declineAsk({ askId: ask.id, ownerId: "U_BOB" }), (e: KeychainError) => e.status === 403);
  const declined = await k.declineAsk({ askId: ask.id, ownerId: "U_ALICE", note: "not for prod" });
  assert.equal(declined.status, "declined");
  assert.equal(declined.note, "not for prod");
  await assert.rejects(k.declineAsk({ askId: ask.id, ownerId: "U_ALICE" }), (e: KeychainError) => e.status === 410);
  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "x" }),
    (e: KeychainError) => e.status === 410,
  );
});

test("expiry: lazy flip on read, sweep returns each expired ask exactly once", async () => {
  let t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });

  t += ASK_TTL_MS + 1;
  const listed = await k.listAsks({ requesterScopeId: "channel:C1" });
  assert.equal(listed[0]?.status, "expired");
  assert.equal((await k.getAsk(ask.id))?.status, "expired");
  await assert.rejects(
    k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "x" }),
    (e: KeychainError) => e.status === 410,
  );

  assert.deepEqual(
    (await k.unnotifiedResolvedAsks(t)).map((a) => a.id),
    [ask.id],
  );
  assert.deepEqual(
    (await k.unnotifiedResolvedAsks(t)).map((a) => a.id),
    [ask.id],
    "still returned until the resolution actually fired",
  );
  await k.markAskNotified(ask.id);
  assert.deepEqual(await k.unnotifiedResolvedAsks(t), []);
});

test("expiry sweep fires the resolution once and rides the scheduler tick", async () => {
  let t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  await k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "channel:C1", purpose: "p" });
  t += ASK_TTL_MS + 1;

  const fired: KeychainAsk[] = [];
  const sweep = createAskExpirySweep({ keychain: k, fire: async (a) => void fired.push(a) });
  await sweep(t);
  await sweep(t);
  assert.equal(fired.length, 1, "one resolution per expired ask, ever");
  assert.equal(fired[0]!.status, "expired");

  const swept: number[] = [];
  const idStore = createIdempotencyStore(createMemoryMap<IdempotencyRecord>());
  const scheduler = createScheduler({
    crons: createCronStore(createMemoryMap()),
    deliveries: createDeliveryStore(),
    idempotency: idStore,
    identity: createIdentityService(createMemoryMap()),
    run: async () => ({ status: "ok" }) as TurnResult,
    sweepAsks: async (now) => void swept.push(now),
  });
  await scheduler.tick(42);
  assert.deepEqual(swept, [42], "the ask sweep rides the scheduler's leader-leased tick");
});

test("sweep is the durable retry for approve/decline resolutions that never fired, and prunes old asks", async () => {
  let t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });
  await k.approveAsk({ askId: ask.id, ownerId: "U_ALICE", mode: "once", purpose: "yes" });

  const fired: KeychainAsk[] = [];
  const sweep = createAskExpirySweep({ keychain: k, fire: async (a) => void fired.push(a) });
  await sweep(t);
  assert.deepEqual(
    fired.map((a) => [a.id, a.status]),
    [[ask.id, "approved"]],
    "the sweep retries non-expiry resolutions too",
  );
  await sweep(t);
  assert.equal(fired.length, 1, "marked notified after firing — no refire");

  await k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "channel:C2", purpose: "p2" });
  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U_ALICE",
    audienceScopeId: "channel:C2",
    mode: "once",
    purpose: "here",
  });
  await k.resolveAsksForGrant(grant);
  await sweep(t);
  assert.equal(fired.length, 1, "adopted asks are born notified");

  t += ASK_PRUNE_AFTER_MS + 1;
  await sweep(t);
  assert.equal(await k.getAsk(ask.id), null, "resolved+notified asks are pruned after the retention window");
});

test("sweep isolates per-ask failures — one failed fire doesn't starve the batch", async () => {
  const t = 1_000_000;
  const k = kcAt(() => t);
  const cred = await k.save(GH);
  const a1 = (
    await k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "channel:C1", purpose: "p1" })
  ).ask;
  const a2 = (
    await k.createAsk({ credentialId: cred.id, requesterId: "U_BOB", requesterScopeId: "channel:C2", purpose: "p2" })
  ).ask;
  await k.approveAsk({ askId: a1.id, ownerId: "U_ALICE", mode: "once", purpose: "y1" });
  await k.approveAsk({ askId: a2.id, ownerId: "U_ALICE", mode: "once", purpose: "y2" });

  const fired: string[] = [];
  const sweep = createAskExpirySweep({
    keychain: k,
    fire: async (a) => {
      if (a.id === a1.id) throw new Error("delivery store down");
      fired.push(a.id);
    },
  });
  await sweep(t);
  assert.deepEqual(fired, [a2.id], "the failure didn't starve the rest of the batch");
  assert.equal((await k.getAsk(a1.id))?.notifiedAt, undefined, "the failed ask stays unnotified and retries next tick");
  assert.notEqual((await k.getAsk(a2.id))?.notifiedAt, undefined);
});

test("resolveAsksForGrant: an in-room grant adopts the matching pending ask", async () => {
  const k = kcAt(Date.now);
  const cred = await k.save(GH);
  const { ask } = await k.createAsk({
    credentialId: cred.id,
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "p",
  });

  const other = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U_ALICE",
    audienceScopeId: "channel:OTHER",
    mode: "once",
    purpose: "elsewhere",
  });
  assert.deepEqual(await k.resolveAsksForGrant(other), [], "a grant for another scope adopts nothing");

  const grant = await k.createGrant({
    credentialId: cred.id,
    ownerId: "U_ALICE",
    audienceScopeId: "channel:C1",
    mode: "once",
    purpose: "yes go ahead",
  });
  const adopted = await k.resolveAsksForGrant(grant);
  assert.deepEqual(
    adopted.map((a) => [a.id, a.status, a.grantId]),
    [[ask.id, "approved", grant.id]],
  );
  assert.equal((await k.listGrants({ ownerId: "U_ALICE" })).find((g) => g.id === grant.id)?.askId, ask.id);
});

test("runTrigger marks every trigger-fired turn `triggered` (the consent-gate claim)", async () => {
  let seen: TurnRequest | undefined;
  const outcome = await runTrigger(
    {
      deliveries: createDeliveryStore(),
      idempotency: createIdempotencyStore(createMemoryMap<IdempotencyRecord>()),
      identity: createIdentityService(createMemoryMap()),
      run: async (req) => ((seen = req), { status: "ok" } as TurnResult),
    },
    {
      owner: "U_ALICE",
      ownerScopeId: scopeId("channel", "C1"),
      input: "do it",
      fireKey: "f1",
      surface: "cron",
      threadRef: "ch:C1-t1",
    },
  );
  assert.equal(outcome.ran, true);
  assert.equal(seen?.triggered, true);
  assert.equal(seen?.thinkingLevel, "xhigh");
  assert.equal(seen?.fastMode, false);
  assert.equal(seen?.conversation.threadRef, "ch:C1-t1", "an explicit threadRef overrides the per-fire fireKey thread");
});

test("runTrigger: silent markers never silence a notification-shaped fire (keychain-ask)", async () => {
  const deliveries = createDeliveryStore();
  const outcome = await runTrigger(
    {
      deliveries,
      idempotency: createIdempotencyStore(createMemoryMap<IdempotencyRecord>()),
      identity: createIdentityService(createMemoryMap()),
      run: async () => ({ status: "ok", reply: "The keychain ask was approved.\n\n[SILENT]" }) as TurnResult,
    },
    {
      owner: "U_ALICE",
      ownerScopeId: scopeId("personal", "U_ALICE"),
      input: "your ask was approved — resume",
      fireKey: "f-nu",
      surface: "keychain-ask",
      destination: { type: "slack", target: "D1", audienceScopeId: scopeId("personal", "U_ALICE") },
    },
  );
  assert.equal(outcome.ran, true);
  assert.equal((await deliveries.pending("slack")).length, 1, "the sentinel is poll-only; an ask notice must deliver");
});

test("fireAskResolution: a turn that fires but doesn't land falls back to a plain delivery (once)", async () => {
  const deliveries = createDeliveryStore();
  const mkDeps = (run: () => Promise<TurnResult>) => ({
    deliveries,
    idempotency: createIdempotencyStore(createMemoryMap<IdempotencyRecord>()),
    identity: createIdentityService(createMemoryMap()),
    run,
    getAsk: async () => ask,
  });
  const ask: KeychainAsk = {
    id: "fa11bacc0000",
    credentialId: "c1",
    ownerId: "U_ALICE",
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    requesterDestination: { type: "slack", target: "C1", audienceScopeId: "channel:C1" },
    purpose: "p",
    status: "approved",
    createdAt: 1,
    expiresAt: 2,
    resolvedAt: 1,
    grantId: "g1",
  };

  const deps = mkDeps(async () => ({ status: "refused", reason: "rate limit exceeded" }) as TurnResult);
  await fireAskResolution(deps, ask);
  let pending = (await deliveries.pending("slack")).filter((d) => d.text.includes(ask.id));
  assert.equal(pending.length, 1);
  assert.match(pending[0]!.text, /couldn't resume the task automatically/);
  assert.match(pending[0]!.text, /was approved/);

  await fireAskResolution(deps, ask);
  pending = (await deliveries.pending("slack")).filter((d) => d.text.includes(ask.id));
  assert.equal(pending.length, 1, "fallback is at-most-once");

  const notified = { ...ask, id: "fa11bacc1111", notifiedAt: 5 };
  const deps2 = { ...mkDeps(async () => ({ status: "refused" }) as TurnResult), getAsk: async () => notified };
  await fireAskResolution(deps2, notified);
  const before = (await deliveries.pending("slack")).filter((d) => d.text.includes(notified.id)).length;
  await fireAskResolution(deps2, notified);
  assert.equal(
    (await deliveries.pending("slack")).filter((d) => d.text.includes(notified.id)).length,
    before,
    "no redundant line once notified",
  );

  let promptText = "";
  const standingGrant = {
    id: "g9",
    credentialId: "c1",
    ownerId: "U_ALICE",
    audienceScopeId: "channel:C1",
    mode: "standing",
    purpose: "use it for payments work this week",
    status: "active",
    createdAt: 1,
  } as any;
  const swAsk = { ...ask, id: "fa11bacc3333", grantId: "g9" };
  await fireAskResolution(
    {
      ...mkDeps(async () => ({ status: "ok" }) as TurnResult),
      getAsk: async () => swAsk,
      getGrant: async () => standingGrant,
      run: async (req) => ((promptText = req.text ?? ""), { status: "ok", reply: `ok ${swAsk.id}` } as TurnResult),
    },
    swAsk,
  );
  assert.match(promptText, /standing/, "mode comes from the looked-up grant");
  assert.match(
    promptText,
    /"use it for payments work this week"/,
    "the owner's verbatim consent is what the agent must act within",
  );
  assert.ok(!promptText.includes("single-use"), "a standing grant is not described as single-use");

  const okAsk = { ...ask, id: "fa11bacc2222" };
  const okDeps = mkDeps(async () => ({ status: "ok", reply: `done ${okAsk.id}` }) as TurnResult);
  await fireAskResolution({ ...okDeps, getAsk: async () => okAsk }, okAsk);
  const okLines = (await deliveries.pending("slack")).filter((d) => d.text.includes(okAsk.id));
  assert.equal(okLines.length, 1, "just the turn's reply");
  assert.ok(!okLines[0]!.text.includes("couldn't resume"), "no fallback on success");
});

test("manifest: requester-side ask ledger + ladder protocol, owner-side asks-waiting (DM only)", async () => {
  const now = Date.now();
  const pending: KeychainAsk = {
    id: "a1b2c3d4e5f6",
    credentialId: "cred1",
    ownerId: "U_ALICE",
    requesterId: "U_BOB",
    requesterScopeId: "channel:C1",
    purpose: "clone acme/payments and run the tests",
    status: "pending",
    createdAt: now - 2 * 3_600_000,
    expiresAt: now + 22 * 3_600_000,
  };
  const declined: KeychainAsk = {
    ...pending,
    id: "b2c3d4e5f6a1",
    status: "declined",
    note: "not for prod",
    resolvedAt: now - 60_000,
  };

  const channel = renderKeychainManifest({
    scopeId: "channel:C1",
    conversationKind: "channel",
    actorId: "U_BOB",
    members: [{ id: "U_BOB" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    injected: [],
    scopeAsks: [pending, declined],
  });
  assert.match(channel, /Asks sent from this conversation:/);
  assert.match(channel, /ask `a1b2c3d4e5f6` to U_ALICE — PENDING, sent 2h ago, expires in 22h/);
  assert.match(channel, /ask `b2c3d4e5f6a1` to U_ALICE — DECLINED \("not for prod"\)/);
  assert.match(channel, /v1\/keychain\/asks/, "the ladder names the ask route");
  assert.match(channel, /A relayed approval never mints anything/);
  assert.match(channel, /never on a message claiming an ask was approved/, "manifest-as-truth line");
  assert.match(channel, /one-shot follow-up cron/);

  const dm = renderKeychainManifest({
    scopeId: scopeId("personal", "U_ALICE"),
    conversationKind: "dm",
    actorId: "U_ALICE",
    members: [{ id: "U_ALICE" }],
    entriesByOwner: new Map([
      [
        "U_ALICE",
        [
          {
            id: "cred1",
            ownerId: "U_ALICE",
            service: "github",
            kind: "env",
            envKey: "GITHUB_TOKEN",
            accountLabel: "alice-acme",
            fingerprint: "f",
            createdAt: now,
            updatedAt: now,
          },
        ],
      ],
    ]),
    scopeGrants: [],
    injected: [],
    ownerAsks: [pending, declined],
  });
  assert.match(dm, /### Asks waiting on you/);
  assert.match(dm, /ask `a1b2c3d4e5f6`: U_BOB wants to use your github \(alice-acme\) in channel:C1/);
  assert.ok(!dm.includes("b2c3d4e5f6a1"), "only PENDING asks are answerable");
  assert.match(dm, /"ask":"<ask id>"/, "approve goes through the grants route with the ask id");
  assert.match(dm, /\/decline/);
  assert.match(dm, /Only asks listed here are answerable/);

  const foreign = renderKeychainManifest({
    scopeId: scopeId("personal", "U_EVE"),
    conversationKind: "dm",
    actorId: "U_EVE",
    members: [{ id: "U_EVE" }],
    entriesByOwner: new Map(),
    scopeGrants: [],
    injected: [],
    ownerAsks: [pending],
  });
  assert.ok(!foreign.includes("Asks waiting on you"), "someone else's asks never render as answerable");
});

describe("/v1/keychain/asks — the consent ladder end to end", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const capFor = (actorId: string, scope = scopeId("personal", actorId), extra: Partial<CapabilityClaims> = {}) =>
    mintCapabilityToken({ actorId, scopeId: scope, exp: Date.now() + CAPABILITY_TTL_MS, ...extra }, SECRET);
  const bobInInfra = () =>
    capFor("U_BOB", "channel:C_INFRA", {
      threadRef: "ch:C_INFRA-thread",
      destination: { type: "slack", target: "C_INFRA", audienceScopeId: "channel:C_INFRA" },
    });

  const post = (path: string, body: unknown, cap: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-capability": cap },
      body: JSON.stringify(body),
    });
  const get = (path: string, cap: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });
  const waitFor = async <T>(probe: () => Promise<T[]>, ms = 5_000): Promise<T[]> => {
    const start = Date.now();
    for (;;) {
      const v = await probe();
      if (v.length > 0 || Date.now() - start > ms) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "kc-asks-")), signingSecret: SECRET }));
    built.runtime.startBackground();
    await built.app.upsertDirectory([
      { principalId: "U_ALICE", displayName: "Alice", type: "internal" },
      { principalId: "U_BOB", displayName: "Bob", type: "internal" },
    ]);
    await built.app.upsertChannels(
      [
        { channelId: "C_INFRA", name: "infra", isPrivate: true },
        { channelId: "C_NOALICE", name: "no-alice", isPrivate: true },
        { channelId: "C_PUBLIC", name: "public-room" },
      ],
      [
        { channelId: "C_INFRA", principalId: "U_ALICE" },
        { channelId: "C_INFRA", principalId: "U_BOB" },
        { channelId: "C_NOALICE", principalId: "U_BOB" },
        { channelId: "C_PUBLIC", principalId: "U_BOB" },
      ],
    );
    server = createServer(built.app, {
      signingSecret: SECRET,
      keychain: built.keychain,
      deliveries: built.deliveries,
      ...(built.fireAskResolution ? { fireAskResolution: built.fireAskResolution } : {}),
      workspace: built.workspace,
      auditLog: built.auditLog,
      credentialUsage: built.credentialUsage,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  });

  it("gates creation: personal ownership and directory-verified channel membership", async () => {
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "github", secret: "ghp_alice", envKey: "GITHUB_TOKEN", accountLabel: "alice-acme" },
        await capFor("U_ALICE"),
      )
    ).json()) as any;

    const fromDm = await post("/v1/keychain/asks", { credential: credential.id, purpose: "p" }, await capFor("U_BOB"));
    assert.equal(fromDm.status, 403, "dm scopes cannot send asks in v1");

    const fromGroup = await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "p" },
      await capFor("U_BOB", "group:G_MPIM"),
    );
    assert.equal(fromGroup.status, 403, "group scopes fail closed too");

    const notMember = await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "p" },
      await capFor("U_BOB", "channel:C_NOALICE"),
    );
    assert.equal(notMember.status, 403, "owner not in the private channel → fail closed");

    const unknownChannel = await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "p" },
      await capFor("U_BOB", "channel:C_GHOST"),
    );
    assert.equal(unknownChannel.status, 403, "channel the directory hasn't seen → fail closed");

    const unknownCred = await post("/v1/keychain/asks", { credential: "nope", purpose: "p" }, await bobInInfra());
    assert.equal(unknownCred.status, 404);
  });

  it("rejects invalid ask expiry at the route boundary", async () => {
    const { credential } = (await (
      await post("/v1/keychain/credentials", { service: "invalid-ask-exp", secret: "x" }, await capFor("U_ALICE"))
    ).json()) as any;
    const res = await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "p", expiresAt: "not-a-date" },
      await bobInInfra(),
    );
    assert.equal(res.status, 400);
  });

  it("creates the ask, enqueues ONE core-composed owner DM (onBehalfOf provenance), dedups silently", async () => {
    const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
    const gh = creds.credentials.find((c: any) => c.service === "github");

    const res = await post(
      "/v1/keychain/asks",
      { credential: gh.id, purpose: "clone acme/payments and run the tests" },
      await bobInInfra(),
    );
    assert.equal(res.status, 200);
    const { ask, existing } = (await res.json()) as any;
    assert.equal(existing, false);
    assert.equal(ask.status, "pending");
    assert.equal(ask.ownerId, "U_ALICE");
    assert.equal(ask.requesterScopeId, "channel:C_INFRA", "scope comes from the token, not the body");
    assert.equal(ask.requesterThreadRef, "ch:C_INFRA-thread");

    const notices = (await built.deliveries.pending("principal")).filter(
      (d) => d.idempotencyKey === `ask:${ask.id}:notice`,
    );
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.destination.target, "U_ALICE");
    assert.equal(notices[0]!.destination.onBehalfOf, "U_BOB");
    assert.match(
      notices[0]!.text,
      /Bob \(U_BOB\) asked in \*\*#infra\*\*/,
      "core composes the notice from the directory + token",
    );
    assert.match(notices[0]!.text, /\*\*github\*\* credential \(alice-acme\), one time/);
    assert.match(
      notices[0]!.text,
      /"clone acme\/payments and run the tests"/,
      "the requester's purpose is quoted, visibly",
    );
    assert.match(notices[0]!.text, /only your own reply counts/);
    assert.match(notices[0]!.text, new RegExp(`ask \`${ask.id}\``));

    const again = await post(
      "/v1/keychain/asks",
      { credential: gh.id, purpose: "totally different words" },
      await bobInInfra(),
    );
    const dup = (await again.json()) as any;
    assert.equal(dup.existing, true);
    assert.equal(dup.ask.id, ask.id);
    assert.equal(
      (await built.deliveries.pending("principal")).filter((d) => d.idempotencyKey === `ask:${ask.id}:notice`).length,
      1,
      "no second DM — no nagging",
    );
  });

  it("public channel: any internal owner is askable", async () => {
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "npm", secret: "npm_alice", envKey: "NPM_TOKEN" },
        await capFor("U_ALICE"),
      )
    ).json()) as any;
    const res = await post(
      "/v1/keychain/asks",
      { credential: credential.id, purpose: "publish the package" },
      await capFor("U_BOB", "channel:C_PUBLIC"),
    );
    assert.equal(res.status, 200);
  });

  it("relayed approve 403s; the owner's own DM turn mints the audience-bound grant; replay 410s; the original thread resumes", async () => {
    const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
    const gh = creds.credentials.find((c: any) => c.service === "github");
    const list = (await (await get("/v1/keychain/asks", await bobInInfra())).json()) as any;
    const ask = list.asks.find((a: any) => a.credentialId === gh.id && a.status === "pending");
    assert.ok(ask, "the pending ask is visible from the asking conversation");

    const seeded = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U_BOB" },
      conversation: {
        kind: "channel",
        threadRef: "ch:C_INFRA-thread",
        channelRef: "C_INFRA",
        audience: [{ externalId: "U_BOB" }],
      },
      text: "waiting on alice",
    } as TurnRequest);
    assert.equal(seeded.status, "ok");
    const session = await built.sessions.getByThread("ch:C_INFRA-thread");
    assert.ok(session);

    const relayed = await post(
      "/v1/keychain/grants",
      { ask: ask.id, mode: "once", purpose: "alice said it's fine" },
      await bobInInfra(),
    );
    assert.equal(relayed.status, 403);

    assert.equal(
      (await post("/v1/keychain/grants", { ask: "deadbeef0000", mode: "once", purpose: "x" }, await capFor("U_ALICE")))
        .status,
      404,
    );

    const approved = await post(
      "/v1/keychain/grants",
      { ask: ask.id, mode: "once", purpose: "sure, just this once" },
      await capFor("U_ALICE"),
    );
    assert.equal(approved.status, 200);
    const body = (await approved.json()) as any;
    assert.equal(body.grant.audienceScopeId, "channel:C_INFRA");
    assert.equal(body.grant.askId, ask.id);
    assert.equal(body.ask.status, "approved");
    assert.equal(body.use.command, undefined, "the use.command would 403 from the owner's DM — suppressed");
    assert.match(body.use.note, /channel:C_INFRA/);

    assert.equal(
      (await post("/v1/keychain/grants", { ask: ask.id, mode: "once", purpose: "again" }, await capFor("U_ALICE")))
        .status,
      410,
    );

    const resolution = await waitFor(async () =>
      (await built.sessions.getEntries(session!.id)).filter(
        (e) => e.type === "user" && JSON.stringify(e.payload).includes(`Keychain ask \`${ask.id}\` was approved`),
      ),
    );
    assert.equal(resolution.length, 1, "exactly one resolution turn, in the original thread's session");
    const delivered = await waitFor(async () =>
      (await built.deliveries.pending("slack")).filter((d) => d.text.includes(`\`${ask.id}\``)),
    );
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0]!.destination.target, "C_INFRA");

    await waitFor(async () =>
      (((await (await get("/v1/keychain/asks", await bobInInfra())).json()) as any).asks as any[]).filter(
        (a) => a.id === ask.id && a.notifiedAt !== undefined,
      ),
    );
    await built.fireAskResolution!({ ...body.ask } as KeychainAsk, body.grant);
    assert.equal((await built.deliveries.pending("slack")).filter((d) => d.text.includes(`\`${ask.id}\``)).length, 1);

    assert.equal(
      (await post("/v1/keychain/use", { grant: body.grant.id }, await capFor("U_EVE", "channel:OTHER"))).status,
      403,
    );
    const used = await post("/v1/keychain/use", { grant: body.grant.id }, await bobInInfra());
    assert.equal(used.status, 200);
    assert.equal(await used.text(), "export GITHUB_TOKEN='ghp_alice'\n");
  });

  it("decline flips the ask and fires exactly one resolution turn into the asking channel", async () => {
    const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
    const npm = creds.credentials.find((c: any) => c.service === "npm");
    const made = (await (
      await post("/v1/keychain/asks", { credential: npm.id, purpose: "publish from infra" }, await bobInInfra())
    ).json()) as any;

    assert.equal(
      (await post(`/v1/keychain/asks/${made.ask.id}/decline`, { note: "not from a shared room" }, await bobInInfra()))
        .status,
      403,
      "only the owner declines",
    );
    const res = await post(
      `/v1/keychain/asks/${made.ask.id}/decline`,
      { note: "not from a shared room" },
      await capFor("U_ALICE"),
    );
    assert.equal(res.status, 200);
    const { ask } = (await res.json()) as any;
    assert.equal(ask.status, "declined");

    const delivered = await waitFor(async () =>
      (await built.deliveries.pending("slack")).filter((d) => d.text.includes(`\`${ask.id}\``)),
    );
    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!.text, /declined/);

    assert.equal((await post(`/v1/keychain/asks/${made.ask.id}/decline`, {}, await capFor("U_ALICE"))).status, 410);
  });

  it("in-room grant (owner present in the channel) adopts the pending ask without a resolution turn", async () => {
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "fly", secret: "fly_alice", envKey: "FLY_API_TOKEN" },
        await capFor("U_ALICE"),
      )
    ).json()) as any;
    const made = (await (
      await post("/v1/keychain/asks", { credential: credential.id, purpose: "deploy the preview" }, await bobInInfra())
    ).json()) as any;

    const granted = await post(
      "/v1/keychain/grants",
      { credential: credential.id, mode: "once", purpose: "yes, deploy it" },
      await capFor("U_ALICE", "channel:C_INFRA"),
    );
    assert.equal(granted.status, 200);
    const g = (await granted.json()) as any;
    assert.ok(g.use.command, "an in-scope mint keeps the runnable use.command");

    const asks = (await (await get("/v1/keychain/asks", await bobInInfra())).json()) as any;
    const adopted = asks.asks.find((a: any) => a.id === made.ask.id);
    assert.equal(adopted.status, "approved");
    assert.equal(adopted.grantId, g.grant.id);
    assert.equal(
      (await built.deliveries.pending("slack")).filter((d) => d.text.includes(`\`${made.ask.id}\``)).length,
      0,
      "no resolution turn — the conversation was already awake",
    );
  });

  it("trigger-claim hardening: consent routes refuse a trigger-fired turn's token", async () => {
    const creds = (await (await get("/v1/keychain/credentials", await capFor("U_ALICE"))).json()) as any;
    const gh = creds.credentials.find((c: any) => c.service === "github");
    const triggeredOwner = await capFor("U_ALICE", "channel:C_INFRA", { triggered: true });

    const mint = await post(
      "/v1/keychain/grants",
      { credential: gh.id, mode: "standing", purpose: "cron says yes" },
      triggeredOwner,
    );
    assert.equal(mint.status, 403, "an owner-owned cron firing in a requester-controlled context must not mint");
    const approve = await post("/v1/keychain/grants", { ask: "anything", mode: "once", purpose: "x" }, triggeredOwner);
    assert.equal(approve.status, 403);
    const decline = await post("/v1/keychain/asks/anything/decline", {}, triggeredOwner);
    assert.equal(decline.status, 403);
    const send = await post(
      "/v1/keychain/asks",
      { credential: gh.id, purpose: "p" },
      await capFor("U_BOB", "channel:C_INFRA", { triggered: true }),
    );
    assert.equal(send.status, 200, "background requests may ask but cannot approve");
  });

  for (const kind of ["channel", "group", "project"] as const) {
    for (const requesterId of ["U_ALICE", "U_BOB"]) {
      it(`${kind} scheduled request for ${requesterId === "U_ALICE" ? "own" : "another person's"} credential requires approval and resumes in place`, async () => {
        let scope: CapabilityClaims["scopeId"] = "channel:C_INFRA";
        let scopeVersion: string | undefined;
        if (kind === "group") {
          scope = "group:G_SHARED";
          await built.app.upsertGroups([
            { groupId: "G_SHARED", principalId: "U_ALICE" },
            { groupId: "G_SHARED", principalId: "U_BOB" },
          ]);
        } else if (kind === "project") {
          const project = await built.app.createProject("U_ALICE", `Approval QA ${requesterId}`);
          assert.ok(project);
          assert.equal((await built.app.addProjectMember(project.id, "U_ALICE", "U_BOB")).status, "ok");
          scope = project.scopeId;
          scopeVersion = await built.projects.version(scope.slice("group:".length));
        }
        const credential = await built.keychain!.save({
          ownerId: "U_ALICE",
          service: `shared-${kind}-${requesterId}`,
          secret: "synthetic-shared-value",
          envKey: "SHARED_QA_TOKEN",
        });
        const cron = await built.app.createCron({
          owner: requesterId,
          createdBy: requesterId,
          ownerScopeId: scope,
          title: "Shared credential QA",
          action: "run the synthetic shared check",
          schedule: { firstFireAt: Date.now() + 3600000 },
        });
        const threadRef = `cron:${cron.id}:fire:first`;
        const token = await capFor(requesterId, scope, {
          triggered: true,
          threadRef,
          ...(scopeVersion ? { scopeVersion } : {}),
        });
        const liveOwner = await capFor("U_ALICE", "personal:U_ALICE", { liveActor: true });
        const seed = await built.app.turn({
          surface: "cron",
          triggered: true,
          actor: { externalId: requesterId },
          conversation: {
            kind: kind === "channel" ? "channel" : "group",
            threadRef,
            channelRef: scope.slice(scope.indexOf(":") + 1),
            audience: [{ externalId: "U_ALICE" }, { externalId: "U_BOB" }],
          },
          text: "waiting for permission for a synthetic shared job",
        } as TurnRequest);
        assert.equal(seed.status, "ok");
        const session = await built.sessions.getByThread(threadRef);
        assert.ok(session);
        assert.equal((await post("/v1/keychain/use", { credential: credential.id }, token)).status, 403);
        const made = await post(
          "/v1/keychain/asks",
          { credential: credential.id, purpose: "run the synthetic shared check" },
          token,
        );
        assert.equal(made.status, 200, await made.clone().text());
        const { ask } = (await made.json()) as any;
        assert.equal(ask.ownerId, "U_ALICE");
        assert.equal(ask.requesterId, requesterId);
        const notices = (await built.deliveries.pending("principal")).filter(
          (d) => d.idempotencyKey === `ask:${ask.id}:notice`,
        );
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.destination.target, "U_ALICE");
        assert.match(notices[0]!.text, /Scheduled task "Shared credential QA"/);
        if (kind === "project") assert.match(notices[0]!.text, /Approval QA/);
        assert.ok(!notices[0]!.text.includes("synthetic-shared-value"));
        assert.equal(
          (await post("/v1/keychain/grants", { ask: ask.id, mode: "once", purpose: "I approve myself" }, token)).status,
          403,
        );
        if (requesterId !== "U_ALICE")
          assert.equal(
            (
              await post(
                "/v1/keychain/grants",
                { ask: ask.id, mode: "once", purpose: "Alice said yes" },
                await capFor(requesterId),
              )
            ).status,
            403,
          );
        const response = await post(
          "/v1/keychain/grants",
          { ask: ask.id, mode: "once", purpose: "yes, for this shared check" },
          liveOwner,
        );
        assert.equal(response.status, 200, await response.clone().text());
        const { grant, use } = (await response.json()) as any;
        assert.equal(grant.audienceScopeId, scope);
        assert.equal(use.command, undefined);
        const resumed = await waitFor(async () =>
          (await built.sessions.getEntries(session.id)).filter(
            (e) => e.type === "user" && JSON.stringify(e.payload).includes(`Keychain ask \`${ask.id}\` was approved`),
          ),
        );
        assert.equal(resumed.length, 1);
        assert.equal((await post("/v1/keychain/use", { grant: grant.id }, await capFor(requesterId))).status, 403);
        assert.equal((await post("/v1/keychain/use", { grant: grant.id }, token)).status, 200);
        assert.equal((await post("/v1/keychain/use", { grant: grant.id }, token)).status, 410);
      });
    }
  }

  it("shared background requests reject nonmembers, outsiders, stale project membership and inaccessible credentials", async () => {
    const credential = await built.keychain!.save({
      ownerId: "U_ALICE",
      service: "shared-private-gates",
      secret: "dummy",
      envKey: "QA_TOKEN",
    });
    await built.app.upsertDirectory([
      { principalId: "U_ALICE", displayName: "Alice", type: "internal" },
      { principalId: "U_BOB", displayName: "Bob", type: "internal" },
      { principalId: "U_EVE", displayName: "Eve", type: "internal" },
      { principalId: "U_EXTERNAL", displayName: "External", type: "guest" },
    ]);
    await built.app.upsertGroups([
      { groupId: "G_GUEST_QA", principalId: "U_ALICE" },
      { groupId: "G_GUEST_QA", principalId: "U_EXTERNAL" },
    ]);
    const external = await built.keychain!.save({
      ownerId: "U_EXTERNAL",
      service: "external-gate",
      secret: "dummy",
      envKey: "QA_TOKEN",
    });
    for (const [actor, scope, credentialId] of [
      ["U_BOB", "channel:C_NOALICE", credential.id],
      ["U_EVE", "channel:C_INFRA", credential.id],
      ["U_BOB", "group:G_UNKNOWN", credential.id],
      ["U_BOB", "channel:C_PUBLIC", external.id],
      ["U_EXTERNAL", "group:G_GUEST_QA", credential.id],
      ["U_BOB", "personal:U_BOB", credential.id],
    ] as const) {
      assert.equal(
        (
          await post(
            "/v1/keychain/asks",
            { credential: credentialId, purpose: "denied check" },
            await capFor(actor, scope, { triggered: true }),
          )
        ).status,
        403,
        `${actor} in ${scope} requesting ${credentialId}`,
      );
    }
    const project = await built.app.createProject("U_BOB", "Membership check");
    assert.ok(project);
    await built.app.addProjectMember(project.id, "U_BOB", "U_ALICE");
    const scopeVersion = await built.projects.version(project.scopeId.slice("group:".length));
    const stale = await capFor("U_BOB", project.scopeId, { triggered: true, scopeVersion });
    await built.app.removeProjectMember(project.id, "U_BOB", "U_ALICE");
    assert.equal(
      (await post("/v1/keychain/asks", { credential: credential.id, purpose: "stale check" }, stale)).status,
      403,
    );
  });

  for (const mode of ["once", "standing"] as const) {
    it(`personal scheduled request waits for approval, resumes its original thread, and respects ${mode} grants`, async () => {
      const threadRef = `dm:U_ALICE-cron-${mode}`;
      const personal = scopeId("personal", "U_ALICE");
      const token = await capFor("U_ALICE", personal, { triggered: true, threadRef });
      const live = await capFor("U_ALICE", personal, { liveActor: true });
      const { credential } = (await (
        await post(
          "/v1/keychain/credentials",
          { service: `cron-${mode}`, secret: "dummy-cron-value", envKey: "CRON_QA_TOKEN" },
          live,
        )
      ).json()) as any;
      const seed = await built.app.turn({
        surface: "slack",
        actor: { externalId: "U_ALICE" },
        conversation: { kind: "dm", threadRef },
        text: "waiting for scheduled credential approval",
      } as TurnRequest);
      assert.equal(seed.status, "ok");
      const session = await built.sessions.getByThread(threadRef);
      assert.ok(session);
      const denied = await post("/v1/keychain/use", { credential: credential.id }, token);
      assert.equal(denied.status, 403);
      assert.match(((await denied.json()) as any).message, /keychain\/asks/);
      const requested = await post(
        "/v1/keychain/asks",
        { credential: credential.id, purpose: "read-only dummy scheduled check", requestedMode: mode },
        token,
      );
      assert.equal(requested.status, 200);
      const { ask } = (await requested.json()) as any;
      assert.equal(ask.status, "pending");
      assert.equal(
        (await built.keychain!.listGrants({ audienceScopeId: personal })).filter(
          (g) => g.credentialId === credential.id,
        ).length,
        0,
      );
      const duplicate = (await (
        await post("/v1/keychain/asks", { credential: credential.id, purpose: "retry" }, token)
      ).json()) as any;
      assert.equal(duplicate.ask.id, ask.id);
      assert.equal(duplicate.existing, true);
      const notices = (await built.deliveries.pending("principal")).filter(
        (d) => d.idempotencyKey === `ask:${ask.id}:notice`,
      );
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.destination.target, "U_ALICE");
      assert.match(notices[0]!.text, /A task in your personal conversation is asking/);
      assert.ok(!notices[0]!.text.includes("dummy-cron-value"));
      assert.equal(
        (await post("/v1/keychain/grants", { ask: ask.id, mode, purpose: "approve myself" }, token)).status,
        403,
      );
      assert.equal(
        (await post("/v1/keychain/grants", { ask: ask.id, mode, purpose: "Alice said yes" }, await capFor("U_BOB")))
          .status,
        403,
      );
      const approval = await post(
        "/v1/keychain/grants",
        { ask: ask.id, mode, purpose: "yes, run this dummy check" },
        live,
      );
      assert.equal(approval.status, 200);
      const approved = (await approval.json()) as any;
      assert.equal(approved.grant.audienceScopeId, personal);
      assert.equal(approved.use.command, undefined);
      assert.match(approved.use.note, /Do not load or consume/);
      const resumed = await waitFor(async () =>
        (await built.sessions.getEntries(session.id)).filter(
          (e) => e.type === "user" && JSON.stringify(e.payload).includes(`Keychain ask \`${ask.id}\` was approved`),
        ),
      );
      assert.equal(resumed.length, 1);
      assert.equal((await post("/v1/keychain/use", { grant: approved.grant.id }, await capFor("U_BOB"))).status, 403);
      assert.equal((await post("/v1/keychain/use", { grant: approved.grant.id }, token)).status, 200);
      const second = await post("/v1/keychain/use", { grant: approved.grant.id }, token);
      assert.equal(second.status, mode === "standing" ? 200 : 410);
      if (mode === "standing") {
        assert.equal((await post(`/v1/keychain/grants/${approved.grant.id}/revoke`, {}, live)).status, 200);
        assert.equal((await post("/v1/keychain/use", { grant: approved.grant.id }, token)).status, 410);
      }
    });
  }

  it("a scheduled personal request can be declined without granting access", async () => {
    const live = await capFor("U_ALICE", "personal:U_ALICE", { liveActor: true });
    const token = await capFor("U_ALICE", "personal:U_ALICE", { triggered: true });
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "cron-decline", secret: "dummy", envKey: "CRON_QA_TOKEN" },
        live,
      )
    ).json()) as any;
    const { ask } = (await (
      await post("/v1/keychain/asks", { credential: credential.id, purpose: "dummy declined check" }, token)
    ).json()) as any;
    assert.equal((await post(`/v1/keychain/asks/${ask.id}/decline`, {}, token)).status, 403);
    assert.equal((await post(`/v1/keychain/asks/${ask.id}/decline`, { note: "no" }, live)).status, 200);
    assert.equal((await built.keychain!.getAsk(ask.id))?.status, "declined");
    assert.equal((await post("/v1/keychain/use", { credential: credential.id }, token)).status, 403);
    assert.equal(
      (
        await post(
          "/v1/keychain/asks",
          { credential: credential.id, purpose: "wrong scope" },
          await capFor("U_ALICE", "personal:U_BOB", { triggered: true }),
        )
      ).status,
      403,
    );
  });

  it("expiry: the scheduler sweep fires exactly one expired-resolution turn into the asking channel", async () => {
    const { credential } = (await (
      await post(
        "/v1/keychain/credentials",
        { service: "vercel", secret: "v_alice", envKey: "VERCEL_TOKEN" },
        await capFor("U_ALICE"),
      )
    ).json()) as any;
    const made = (await (
      await post(
        "/v1/keychain/asks",
        { credential: credential.id, purpose: "ship the preview", expiresAt: Date.now() + 80 },
        await bobInInfra(),
      )
    ).json()) as any;
    await new Promise((r) => setTimeout(r, 120));

    await built.scheduler.tick(Date.now());
    const delivered = await waitFor(async () =>
      (await built.deliveries.pending("slack")).filter((d) => d.text.includes(`\`${made.ask.id}\``)),
    );
    assert.equal(delivered.length, 1, "exactly one expired-resolution delivery");
    assert.match(delivered[0]!.text, /expired without an answer/);
    assert.equal(delivered[0]!.destination.target, "C_INFRA");

    await built.scheduler.tick(Date.now());
    assert.equal(
      (await built.deliveries.pending("slack")).filter((d) => d.text.includes(`\`${made.ask.id}\``)).length,
      1,
      "a second tick refires nothing — notifiedAt + fireKey both hold",
    );
  });
});

test("turn e2e: trigger-fired turns mint `triggered` into the capability token; threadRef is carried", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "kc-claims-")),
      signingSecret: SECRET,
      apiBaseUrl: "http://core.test",
    }),
  );
  // The recorded script is the backend's OUTER `sh -c` wrapper, so the export's single quotes
  // arrive shell-escaped — match the token's own alphabet instead of the quoting around it.
  const extractToken = (since: number): CapabilityClaims | null => {
    for (const script of fakeSprites.execScripts().slice(since)) {
      const m = /export AGENT_API_TOKEN=\W*([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(script);
      if (!m) continue;
      const token = m[1]!;
      return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as CapabilityClaims;
    }
    return null;
  };

  let mark = fakeSprites.execScripts().length;
  const turn = (triggered: boolean): TurnRequest =>
    ({
      surface: triggered ? "keychain-ask" : "slack",
      actor: { externalId: "U_ALICE" },
      conversation: { kind: "channel", threadRef: "ch:C9-t", channelRef: "C9", audience: [{ externalId: "U_ALICE" }] },
      text: "!run true",
      ...(triggered ? { triggered: true } : {}),
    }) as TurnRequest;

  assert.equal((await built.app.turn(turn(false))).status, "ok");
  const human = extractToken(mark);
  assert.ok(human, "the turn exported a capability token into the sandbox");
  assert.equal(human!.triggered, undefined, "a surface-authenticated human turn carries no triggered claim");
  assert.equal(human!.threadRef, "ch:C9-t", "the token carries the conversation threadRef for ask continuity");

  mark = fakeSprites.execScripts().length;
  assert.equal((await built.app.turn(turn(true))).status, "ok");
  const fired = extractToken(mark);
  assert.ok(fired);
  assert.equal(fired!.triggered, true, "a trigger-fired turn's token says so — consent routes refuse it");
});
