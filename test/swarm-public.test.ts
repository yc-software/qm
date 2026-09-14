import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

async function publicPeers() {
  const alice = await swarmFixture();
  const bob = await swarmFixture({ actorId: "bob", store: alice.store, sessions: alice.sessions, runs: alice.runs });
  const sender = await alice.service.character(alice.caller, {
    version: 0,
    name: "Researcher",
    character: { role: "research" },
  });
  const recipient = await bob.service.character(bob.caller, {
    version: 0,
    name: "Reviewer",
    character: { role: "review" },
  });
  return { alice, bob, sender, recipient };
}

test("live HTTP publishes to a different scope using explicit public identities", async () => {
  const { alice, bob, recipient } = await publicPeers();
  const capabilitySecret = "public-message-fixture-capability-secret";
  const server = createServer(
    { swarms: alice.service, authorizesCapabilityScope: async () => true } as unknown as App,
    { signingSecret: "public-message-fixture-signing-secret", capabilitySecret },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const token = await mintCapabilityToken(alice.caller.claims, capabilitySecret);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/swarm`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "x-agent-capability": token, "content-type": "application/json" },
      body: JSON.stringify({
        action: "send",
        visibility: "org",
        requestId: "public-http",
        audience: [recipient.id],
        text: "Please review the public finding.",
      }),
    });
    assert.equal(response.status, 202, await response.clone().text());
    const result = JSON.stringify(await response.json());
    assert.ok(result.includes('"visibility":"org"'));
    for (const value of [alice.root.id, bob.root.id, alice.root.scopeId, bob.root.scopeId])
      assert.ok(!result.includes(value));
    await alice.service.sweep();
    const runs = await alice.runs.inFlightForThread(bob.root.threadRef);
    assert.equal(runs.length, 2);
    const delivered = runs.find((run) => run.request.swarm)!;
    assert.equal(delivered.request.actor.id, "bob");
    assert.equal(delivered.request.conversation.threadRef, bob.root.threadRef);
    assert.equal(delivered.request.origin.kind, "automation");
    assert.ok(!JSON.stringify(delivered.request).includes(alice.root.id));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function claimedPublic(peers: Awaited<ReturnType<typeof publicPeers>>, messageId: string) {
  const { alice, bob, recipient } = peers;
  await bob.runs.complete(bob.caller.claims.runId!, bob.caller.claims.runLeaseToken!, { status: "ok", reply: "Done" });
  await alice.service.sweep();
  const queued = (await alice.runs.getByDedupKey(`swarm:${messageId}:${recipient.id}`))!;
  assert.ok(queued);
  const run = (await alice.runs.claimById(queued.id, "public-test", 60_000))!;
  assert.ok(run);
  return { ...run.request, runId: run.id, runLeaseToken: run.leaseToken!, attempt: run.attempts };
}

test("preview never dispatches and accepted evidence survives metadata edits and idempotent retries", async () => {
  const peers = await publicPeers();
  const { alice, bob, sender, recipient } = peers;
  const before = await alice.runs.list();
  assert.deepEqual(await alice.service.preview(alice.caller, { audience: [recipient.id] }), [recipient]);
  assert.deepEqual(await alice.runs.list(), before);
  const input = {
    requestId: "frozen",
    audience: [recipient.id],
    versions: { [recipient.id]: 1 },
    text: "Public finding",
  };
  const [first, retry] = await Promise.all([
    alice.service.publish(alice.caller, input),
    alice.service.publish(alice.caller, input),
  ]);
  assert.deepEqual(first, retry);
  await bob.service.character(bob.caller, { version: 1, name: "Updated reviewer", character: { role: "different" } });
  await alice.service.character(alice.caller, { version: 1, name: "Updated sender", character: {} });
  assert.deepEqual(await alice.service.publish(alice.caller, input), first);
  assert.deepEqual(first.sender, sender);
  assert.deepEqual(first.audience, [recipient]);
  await assert.rejects(
    alice.service.preview(alice.caller, { audience: [recipient.id], versions: { [recipient.id]: 1 } }),
    /version conflict/,
  );
  await assert.rejects(alice.service.publish(alice.caller, { ...input, text: "Changed" }), /different content/);
  const request = await claimedPublic(peers, first.id);
  const binding = await alice.service.binding(request);
  assert.equal(binding?.rootSessionId, bob.root.id);
  assert.equal(binding?.publicMessage, true);
  assert.ok(request.text.includes("Researcher"));
  assert.ok(!request.text.includes("Updated sender"));
  assert.equal((await alice.store.get(alice.root.id))!.notificationCount, 1);
  assert.equal((await alice.store.get(bob.root.id))!.notificationCount, 1);
});

test("public execution uses only the recipient's template and rejects every forged dispatch field", async () => {
  const peers = await publicPeers();
  const { alice, bob, recipient } = peers;
  await bob.store.update(bob.root.id, (swarm) => {
    swarm.template.model = "recipient-model";
    swarm.template.unattendedGrants = { source: "recipient" } as never;
  });
  await alice.store.update(alice.root.id, (swarm) => {
    swarm.template.model = "sender-model";
    swarm.template.unattendedGrants = { source: "sender" } as never;
  });
  const message = await alice.service.publish(alice.caller, {
    requestId: "authority",
    audience: [recipient.id],
    text: "Safe public fact",
  });
  const request = await claimedPublic(peers, message.id);
  assert.equal(request.model, "recipient-model");
  assert.deepEqual(request.unattendedGrants, { source: "recipient" });
  assert.deepEqual(request.sessionParticipantIds, ["bob"]);
  assert.ok(!JSON.stringify(request).includes("sender-model"));
  assert.ok(await alice.service.binding(request));
  for (const changed of [
    { actor: { id: "alice", type: "internal" as const } },
    { model: "sender-model" },
    { unattendedGrants: { source: "sender" } as never },
    { surface: "web" },
    { text: "Substituted" },
    { origin: { kind: "human" as const } },
    { origin: { kind: "automation" as const, useOwnerKeychain: true as const } },
    { swarm: { ...request.swarm!, swarmId: alice.root.id } },
    { swarm: { ...request.swarm!, recipientId: alice.root.id } },
    { swarm: { ...request.swarm!, visibility: undefined } },
    { sessionParticipantIds: ["alice", "bob"] },
    { runId: alice.caller.claims.runId },
  ])
    await assert.rejects(alice.service.binding({ ...request, ...changed }), /forged|authorization/);
});

test("public reads and cross-root replies never reveal private messages, bindings, runs, or session links", async () => {
  const { alice, bob, sender, recipient } = await publicPeers();
  const privateMessage = await alice.service.send(alice.caller, {
    requestId: "private",
    audience: "all",
    text: "Private secret",
  });
  const publicMessage = await alice.service.publish(alice.caller, {
    requestId: "public",
    audience: [recipient.id],
    text: "Public finding",
    notify: false,
  });
  const reply = await bob.service.publish(bob.caller, {
    requestId: "reply",
    audience: [sender.id],
    replyTo: publicMessage.id,
    text: "Public answer",
    notify: false,
  });
  assert.deepEqual((await alice.service.readPublic(alice.caller, { replyTo: publicMessage.id })).messages, [reply]);
  assert.deepEqual((await alice.service.readPublic(alice.caller, { id: privateMessage.id })).messages, []);
  assert.deepEqual(await alice.service.read(alice.caller, {}), [privateMessage]);
  const before = await alice.runs.list();
  const listing = await alice.service.readPublic(alice.caller);
  const json = JSON.stringify(listing);
  for (const hidden of [
    "Private secret",
    "senderSessionId",
    "destinations",
    "runId",
    "actorId",
    "scopeId",
    alice.root.id,
    bob.root.id,
  ])
    assert.ok(!json.includes(hidden), hidden);
  assert.equal(listing.messages.length, 2);
  assert.deepEqual(await alice.runs.list(), before);
  await assert.rejects(
    bob.service.publish(bob.caller, {
      requestId: "private-reply",
      audience: [],
      replyTo: privateMessage.id,
      text: "Forged",
    }),
    /reply target/,
  );
  await assert.rejects(
    alice.service.send(alice.caller, {
      requestId: "wrong-reply",
      audience: "all",
      replyTo: publicMessage.id,
      text: "Private",
    }),
    /reply target/,
  );
});

for (const phase of ["delivery", "execution"] as const) {
  for (const invalidation of [
    "source expiry",
    "destination expiry",
    "source roster",
    "destination roster",
    "source revoked",
    "destination revoked",
    "destination deleted",
  ] as const) {
    test(`public ${phase} rejects ${invalidation}`, async () => {
      const peers = await publicPeers();
      const { alice, bob, recipient } = peers;
      const message = await alice.service.publish(alice.caller, {
        requestId: "gated",
        audience: [recipient.id],
        text: "Public work",
      });
      const request = phase === "execution" ? await claimedPublic(peers, message.id) : undefined;
      switch (invalidation) {
        case "source expiry":
          await alice.store.update(alice.root.id, (swarm) => {
            swarm.expiresAt = Date.now() - 1;
          });
          break;
        case "destination expiry":
          await alice.store.update(bob.root.id, (swarm) => {
            swarm.expiresAt = Date.now() - 1;
          });
          break;
        case "source roster":
          await alice.sessions.addParticipant(alice.root.id, "unexpected");
          break;
        case "destination roster":
          await alice.sessions.addParticipant(bob.root.id, "unexpected");
          break;
        case "source revoked":
          alice.state.blockedActors.add("alice");
          break;
        case "destination revoked":
          alice.state.blockedActors.add("bob");
          break;
        case "destination deleted":
          await alice.sessions.deleteSessionIfEmpty(bob.root.id);
          break;
      }
      if (request) await assert.rejects(alice.service.binding(request), /forged|authorization|expired|session/);
      else {
        await alice.service.sweep();
        assert.equal(await alice.runs.getByDedupKey(`swarm:${message.id}:${recipient.id}`), null);
        assert.equal((await alice.store.get(alice.root.id))!.messages[0]!.notifications[recipient.id]!.state, "failed");
      }
    });
  }
}

test("recipient budgets stop fan-in, survive restarts, and count retry delivery only once", async () => {
  const { alice, bob, recipient } = await publicPeers();
  await bob.store.update(bob.root.id, (swarm) => {
    swarm.settings.notifications = 1;
  });
  const one = await alice.service.publish(alice.caller, { requestId: "one", audience: [recipient.id], text: "First" });
  const two = await alice.service.publish(alice.caller, { requestId: "two", audience: [recipient.id], text: "Second" });
  const { createSwarmService } = await import("../src/swarms/swarm-service.ts");
  const restart = createSwarmService(alice.serviceOptions);
  await Promise.all([alice.service.sweep(), restart.sweep()]);
  assert.ok(await alice.runs.getByDedupKey(`swarm:${one.id}:${recipient.id}`));
  assert.equal(await alice.runs.getByDedupKey(`swarm:${two.id}:${recipient.id}`), null);
  assert.equal((await alice.store.get(bob.root.id))!.notificationCount, 1);
  await alice.store.update(alice.root.id, (swarm) => {
    swarm.messages[0]!.notifications[recipient.id] = { state: "pending" };
  });
  await restart.sweep();
  assert.equal((await alice.store.get(bob.root.id))!.notificationCount, 1);
  assert.equal((await alice.runs.inFlightForThread(bob.root.threadRef)).length, 2);
});

test("public pagination filters revoked authors before visible cursors and preserves expired published history", async () => {
  const { alice, bob } = await publicPeers();
  await bob.service.publish(bob.caller, { requestId: "hidden", audience: [], text: "Public but revoked" });
  const messages = [];
  for (let index = 0; index < 3; index++)
    messages.push(
      await alice.service.publish(alice.caller, {
        requestId: `page-${index}`,
        audience: [],
        text: `Visible page ${index}`,
      }),
    );
  alice.state.blockedActors.add("bob");
  const found = [];
  let after: string | undefined;
  do {
    const page = await alice.service.readPublic(alice.caller, { after, limit: 1 });
    assert.equal(page.messages.length, 1);
    found.push(...page.messages);
    if (page.nextAfter) assert.ok(page.nextAfter.endsWith(page.messages[0]!.id));
    after = page.nextAfter;
  } while (after);
  assert.equal(found.length, 3);
  assert.deepEqual(new Set(found.map((message) => message.id)), new Set(messages.map((message) => message.id)));
  await alice.store.update(alice.root.id, (swarm) => {
    swarm.expiresAt = Date.now() - 1;
  });
  assert.equal((await alice.service.readPublic(alice.caller, { search: "Visible page" })).messages.length, 3);
});

test("public operations reject global audiences, private IDs, malformed versions, and stale source leases", async () => {
  const { alice, bob, recipient } = await publicPeers();
  const valid = { requestId: "invalid", audience: [recipient.id], text: "Public" };
  for (const input of [
    { audience: "all" },
    { audience: [bob.root.id] },
    { audience: [123] },
    { audience: Array.from({ length: 65 }, () => recipient.id) },
    { versions: [] },
    { versions: { [recipient.id]: -1 } },
    { versions: { wrong: 1 } },
    { notify: null },
    { replyTo: "not-an-id" },
    { text: " " },
  ])
    await assert.rejects(alice.service.publish(alice.caller, { ...valid, ...input } as never));
  assert.equal((await alice.store.get(alice.root.id))!.messages.length, 0);
  const stale = { ...alice.caller, claims: { ...alice.caller.claims, runLeaseToken: "replaced" } };
  await assert.rejects(alice.service.publish(stale, valid), /active capability/);
  for (const options of [
    { limit: 0 },
    { limit: 33 },
    { after: bob.root.id },
    { id: "private" },
    { search: "x".repeat(201) },
  ])
    await assert.rejects(alice.service.readPublic(alice.caller, options), /invalid public read/);
});

test("published workers address foreign workers without exposing their private ancestry", async () => {
  const { alice, bob } = await publicPeers();
  const [source] = await alice.service.spawn(alice.caller, { requestId: "source-worker", text: "Initialize" });
  const [destination] = await bob.service.spawn(bob.caller, { requestId: "destination-worker", text: "Initialize" });
  await alice.service.sweep();
  const sourceCaller = await alice.workerCaller(source!.id);
  const destinationCaller = await bob.workerCaller(destination!.id);
  assert.equal(sourceCaller.kind, "agent");
  assert.equal(destinationCaller.kind, "agent");
  if (sourceCaller.kind !== "agent" || destinationCaller.kind !== "agent") throw new Error("worker agent required");
  await alice.service.character(sourceCaller, { version: 0, name: "Worker source", character: {} });
  const target = await bob.service.character(destinationCaller, {
    version: 0,
    name: "Worker recipient",
    character: {},
  });
  const message = await alice.service.publish(sourceCaller, {
    requestId: "worker-cross-root",
    audience: [target.id],
    text: "Public worker result",
  });
  await bob.runs.complete(destinationCaller.claims.runId!, destinationCaller.claims.runLeaseToken!, {
    status: "ok",
    reply: "Done",
  });
  await alice.service.sweep();
  const queued = (await alice.runs.getByDedupKey(`swarm:${message.id}:${target.id}`))!;
  const claimed = (await alice.runs.claimById(queued.id, "worker-cross-public", 60_000))!;
  const binding = await alice.service.binding({
    ...claimed.request,
    runId: claimed.id,
    runLeaseToken: claimed.leaseToken!,
    attempt: claimed.attempts,
  });
  assert.equal(binding?.member.id, destination!.id);
  assert.equal(binding?.sandboxId, destination!.sandboxId);
  assert.equal(binding?.rootSessionId, bob.root.id);
  assert.equal(binding?.publicMessage, true);
  for (const hidden of [alice.root.id, source!.id, sourceCaller.claims.sessionId!])
    assert.ok(!JSON.stringify(claimed.request).includes(hidden));
});

test("discovery enforces a scan budget even when every published candidate is revoked", async () => {
  const { SWARM_LIMITS } = await import("../src/swarms/swarm-store.ts");
  const viewer = await swarmFixture();
  for (let index = 0; index < SWARM_LIMITS.discoveryScan + 1; index++) {
    const actorId = `revoked-${index}`;
    const peer = await swarmFixture({ actorId, store: viewer.store, sessions: viewer.sessions, runs: viewer.runs });
    await peer.service.character(peer.caller, { version: 0, name: "Hidden", character: {} });
    viewer.state.blockedActors.add(actorId);
  }
  let batches = 0;
  const published = viewer.store.published.bind(viewer.store);
  viewer.store.published = async (...args) => {
    batches++;
    return published(...args);
  };
  await assert.rejects(viewer.service.discover(viewer.caller), /scan budget exceeded/);
  assert.equal(batches, SWARM_LIMITS.discoveryScan / SWARM_LIMITS.discoveryBatch);
});

test("saved public evidence has a combined byte budget rather than multiplying the row size by fanout", async () => {
  const { alice, bob, recipient } = await publicPeers();
  await bob.service.character(bob.caller, {
    version: 1,
    name: "Large public character",
    character: { text: "x".repeat(6000) },
  });
  await alice.service.character(alice.caller, {
    version: 1,
    name: "Large sender character",
    character: { text: "y".repeat(6000) },
  });
  await assert.rejects(
    alice.service.publish(alice.caller, {
      requestId: "large-evidence",
      audience: [recipient.id],
      text: "Small message",
    }),
    /evidence budget/,
  );
  const source = (await alice.store.get(alice.root.id))!;
  assert.equal(source.messages.length, 0);
  assert.equal(source.notificationCount, 0);
});
