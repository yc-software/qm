import { createSwarmService } from "../src/swarms/swarm-service.ts";
import type { SwarmCaller } from "../src/swarms/swarm-service.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { swarmFixture } from "./support/swarm-fixture.ts";

test("live HTTP explicitly publishes a versioned identity without spawning workers", async () => {
  const fixture = await swarmFixture();
  const capabilitySecret = "coordination-fixture-capability-secret";
  const server = createServer(
    { swarms: fixture.service, authorizesCapabilityScope: async () => true } as unknown as App,
    { signingSecret: "coordination-fixture-source-secret", capabilitySecret },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1/swarm";
    const token = await mintCapabilityToken(fixture.caller.claims, capabilitySecret);
    const headers = { "x-agent-capability": token, "content-type": "application/json" };
    const response = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "character",
        version: 0,
        name: "Compiler reviewer",
        character: { specialty: "compiler" },
      }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const identity = (await response.json()) as { id: string; name: string; version: number; character: unknown };
    assert.equal(identity.version, 1);
    assert.notEqual(identity.id, fixture.root.id);
    assert.equal(identity.name, "Compiler reviewer");
    assert.deepEqual(identity.character, { specialty: "compiler" });
    assert.deepEqual(fixture.provisioned, []);
    const swarm = (await fixture.store.get(fixture.root.id))!;
    assert.equal(swarm.members.length, 1);
    assert.equal(swarm.messages.length, 0);
    const discovery = await fetch(base + "?discover=1", { headers });
    assert.equal(discovery.status, 200);
    assert.deepEqual(await discovery.json(), { peers: [identity] });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

const publicCharacter = { version: 0, name: "Research", character: { role: "researcher" } };

test("old swarms stay private and publishing never copies context, titles, ownership, or execution metadata", async () => {
  const fixture = await swarmFixture();
  await fixture.sessions.updateTitle(fixture.root.id, "private-session-title");
  await fixture.service.spawn(fixture.caller, {
    requestId: "pool",
    text: "private-task",
    context: { secret: "private-worker-context" },
  });
  await fixture.service.context(fixture.caller, { title: "private-root-context", credentials: "private-credential" });
  assert.deepEqual(await fixture.service.discover(fixture.caller), { peers: [] });
  const before = await fixture.store.get(fixture.root.id);
  const identity = await fixture.service.character(fixture.caller, publicCharacter);
  const listing = await fixture.service.discover(fixture.caller);
  assert.deepEqual(listing, { peers: [identity] });
  assert.deepEqual(Object.keys(identity).sort(), ["character", "id", "name", "updatedAt", "version"]);
  const json = JSON.stringify(listing);
  for (const secret of [
    fixture.root.id,
    fixture.root.threadRef,
    fixture.root.scopeId,
    "alice",
    "private-session-title",
    "private-task",
    "private-worker-context",
    "private-root-context",
    "private-credential",
  ])
    assert.ok(!json.includes(secret), secret);
  const after = (await fixture.store.get(fixture.root.id))!;
  assert.deepEqual(after.messages, before!.messages);
  assert.deepEqual(after.template, before!.template);
  assert.deepEqual(after.members[0]!.context, before!.members[0]!.context);
  assert.deepEqual(after.members[1], before!.members[1]);
});

test("discovery works across personal scopes without granting private swarm or session access", async () => {
  const alice = await swarmFixture();
  const bob = await swarmFixture({ actorId: "bob", store: alice.store, sessions: alice.sessions, runs: alice.runs });
  const identity = await bob.service.character(bob.caller, publicCharacter);
  const before = await alice.runs.inFlightForThread(bob.root.threadRef);
  assert.deepEqual(await alice.service.discover(alice.caller), { peers: [identity] });
  assert.deepEqual(await alice.runs.inFlightForThread(bob.root.threadRef), before);
  assert.equal(await alice.sessions.getForParticipant(bob.root.id, "alice"), null);
  await assert.rejects(
    alice.service.inspect({ kind: "human", actorId: "alice", sessionId: bob.root.id }),
    /access denied/,
  );
  await assert.rejects(
    alice.service.character({ kind: "human", actorId: "alice", sessionId: bob.root.id }, publicCharacter),
    /access denied/,
  );
  assert.equal(await alice.store.get(alice.root.id), null);
});

test("concurrent initial publications and compare-and-swap edits have exactly one winner", async () => {
  const fixture = await swarmFixture();
  const second = createSwarmService(fixture.serviceOptions);
  const initial = await Promise.allSettled([
    fixture.service.character(fixture.caller, publicCharacter),
    second.character(fixture.caller, { ...publicCharacter, name: "Other publisher" }),
  ]);
  assert.equal(initial.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(
    initial.filter((result) => result.status === "rejected" && /version conflict/.test(String(result.reason))).length,
    1,
  );
  const first = (await fixture.service.discover(fixture.caller)).peers[0]!;
  const updates = await Promise.allSettled(
    Array.from({ length: 8 }, (_value, index) =>
      (index % 2 ? fixture.service : second).character(fixture.caller, {
        version: 1,
        name: "Name " + index,
        character: { index },
      }),
    ),
  );
  assert.equal(updates.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(updates.filter((result) => result.status === "rejected").length, 7);
  const restarted = createSwarmService(fixture.serviceOptions);
  const latest = (await restarted.discover(fixture.caller)).peers[0]!;
  assert.equal(latest.id, first.id);
  assert.equal(latest.version, 2);
  assert.equal((await fixture.store.get(fixture.root.id))!.members.length, 1);
});

test("publication racing first spawn keeps one initial swarm, budget, and template", async () => {
  const fixture = await swarmFixture();
  const [identity, workers] = await Promise.all([
    fixture.service.character(fixture.caller, publicCharacter),
    fixture.service.spawn(fixture.caller, { requestId: "pool", text: "Private job" }),
  ]);
  const swarm = (await fixture.store.get(fixture.root.id))!;
  assert.equal(swarm.members.length, 2);
  assert.equal(swarm.members[0]!.publicIdentity!.id, identity.id);
  assert.equal(swarm.members[1]!.id, workers[0]!.id);
  assert.equal(swarm.messages.length, 1);
  assert.equal(swarm.notificationCount, 1);
  await fixture.service.sweep();
  assert.equal((await fixture.store.get(fixture.root.id))!.members[1]!.state, "ready");
});

test("workers opt in separately; private context updates cannot edit public character", async () => {
  const fixture = await swarmFixture();
  const [worker] = await fixture.service.spawn(fixture.caller, {
    requestId: "pool",
    text: "Private job",
    context: { private: "value" },
  });
  await fixture.service.sweep();
  const caller = await fixture.workerCaller(worker!.id);
  const identity = await fixture.service.character(caller, publicCharacter);
  assert.notEqual(identity.id, worker!.id);
  assert.notEqual(identity.id, (await fixture.service.inspect(caller)).self.sessionId);
  await fixture.service.context(caller, { publicIdentity: { character: "forged" } });
  assert.deepEqual(await fixture.service.discover(fixture.caller), { peers: [identity] });
});

test("human publication requires scope management, not merely session visibility", async () => {
  const fixture = await swarmFixture();
  const caller: SwarmCaller = {
    kind: "human",
    actorId: "alice",
    sessionId: fixture.root.id,
    runId: fixture.caller.claims.runId,
  };
  fixture.state.manageable = false;
  await assert.rejects(fixture.service.character(caller, publicCharacter), /scope management required/);
  assert.equal(await fixture.store.get(fixture.root.id), null);
  fixture.state.manageable = true;
  assert.equal((await fixture.service.character(caller, publicCharacter)).version, 1);
  fixture.state.manageable = false;
  await assert.rejects(
    fixture.service.character(caller, { ...publicCharacter, version: 1 }),
    /scope management required/,
  );
  assert.equal((await fixture.service.discover(caller)).peers.length, 1);
  const failClosed = createSwarmService({ ...fixture.serviceOptions, managesScope: undefined });
  await assert.rejects(failClosed.character(caller, { ...publicCharacter, version: 1 }), /scope management required/);
});

test("discovery filters expired, deleted, revoked, roster-changed, and external identities before pagination", async () => {
  const viewer = await swarmFixture();
  const fixtures = await Promise.all(
    Array.from({ length: 8 }, (_value, index) =>
      swarmFixture({
        actorId: "peer" + index,
        store: viewer.store,
        sessions: viewer.sessions,
        runs: viewer.runs,
      }),
    ),
  );
  const identities = await Promise.all(
    fixtures.map((fixture, index) =>
      fixture.service.character(fixture.caller, { ...publicCharacter, name: "Peer " + index }),
    ),
  );
  await viewer.store.update(fixtures[0]!.root.id, (swarm) => {
    swarm.expiresAt = Date.now() - 1;
  });
  await viewer.sessions.deleteSessionIfEmpty(fixtures[1]!.root.id);
  viewer.state.blockedActors.add("peer2");
  await viewer.sessions.addParticipant(fixtures[3]!.root.id, "unexpected");
  await viewer.store.update(fixtures[4]!.root.id, (swarm) => {
    swarm.template.actor.type = "guest";
  });
  const expected = identities.slice(5).sort((left, right) => left.id.localeCompare(right.id));
  const found = [];
  let after: string | undefined;
  do {
    const page = await viewer.service.discover(viewer.caller, { limit: 1, ...(after ? { after } : {}) });
    assert.equal(page.peers.length, 1);
    found.push(...page.peers);
    if (page.nextAfter) assert.equal(page.nextAfter, page.peers[0]!.id);
    after = page.nextAfter;
  } while (after);
  assert.deepEqual(found, expected);
  assert.deepEqual(await viewer.service.discover(viewer.caller, { search: "Peer 6" }), { peers: [identities[6]] });
  assert.deepEqual(await viewer.service.discover(viewer.caller, { search: "personal:" }), { peers: [] });
});

test("active source authority is required even for discovery from an unregistered root", async () => {
  const fixture = await swarmFixture();
  fixture.state.blockedActors.add("alice");
  await assert.rejects(fixture.service.discover(fixture.caller), /scope access denied/);
  await assert.rejects(fixture.service.character(fixture.caller, publicCharacter), /scope access denied/);
  fixture.state.blockedActors.clear();
  const run = (await fixture.runs.get(fixture.caller.claims.runId!))!;
  await fixture.runs.complete(run.id, run.leaseToken!, { status: "ok", reply: "Done" });
  await assert.rejects(fixture.service.discover(fixture.caller), /active capability run required/);
  await assert.rejects(fixture.service.character(fixture.caller, publicCharacter), /active capability run required/);
});

test("publication respects replaced run leases and commit-time swarm expiry", async () => {
  const fixture = await swarmFixture();
  await fixture.service.character(fixture.caller, publicCharacter);
  const original = fixture.store.update.bind(fixture.store);
  fixture.store.update = async (id, mutate, fence) => {
    await original(id, (swarm) => {
      swarm.expiresAt = Date.now() - 1;
    });
    return original(id, mutate, fence);
  };
  await assert.rejects(
    fixture.service.character(fixture.caller, { ...publicCharacter, version: 1 }),
    /work window expired/,
  );
  assert.equal((await fixture.store.get(fixture.root.id))!.members[0]!.publicIdentity!.version, 1);
  const stale = { ...fixture.caller, claims: { ...fixture.caller.claims, runLeaseToken: "replaced" } };
  await assert.rejects(fixture.service.discover(stale), /active capability run required/);
});

test("public character and discovery reject malformed or nonportable requests without creating state", async () => {
  const fixture = await swarmFixture();
  for (const version of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])
    await assert.rejects(
      fixture.service.character(fixture.caller, { ...publicCharacter, version }),
      /invalid character version/,
    );
  for (const name of ["", " ", "a".repeat(121), "a\n", "bad\u0000name", "bad\ud800name"])
    await assert.rejects(fixture.service.character(fixture.caller, { ...publicCharacter, name }), /invalid name/);
  for (const character of [
    null,
    [],
    "text",
    { value: NaN },
    { value: undefined },
    { value: "\u0000" },
    { value: "\ud800" },
    { value: "x".repeat(8192) },
  ])
    await assert.rejects(
      fixture.service.character(fixture.caller, { ...publicCharacter, character }),
      /invalid (character|context)/,
    );
  for (const options of [
    { limit: 0 },
    { limit: 33 },
    { limit: 1.5 },
    { after: "private-session-id" },
    { search: "x".repeat(201) },
  ])
    await assert.rejects(fixture.service.discover(fixture.caller, options), /invalid discovery bounds/);
  assert.equal(await fixture.store.get(fixture.root.id), null);
  const identity = await fixture.service.character(fixture.caller, {
    ...publicCharacter,
    name: " 🔬 Research ",
    character: { role: "🧪" },
  });
  assert.equal(identity.name, "🔬 Research");
  assert.deepEqual(identity.character, { role: "🧪" });
});

test("discovery crosses storage batches without exposing hidden cursors or mutating frozen private messages", async () => {
  const fixture = await swarmFixture();
  const peers = await Promise.all(
    Array.from({ length: 35 }, () =>
      swarmFixture({ store: fixture.store, sessions: fixture.sessions, runs: fixture.runs }),
    ),
  );
  const identities = await Promise.all(
    peers.map((peer, index) => peer.service.character(peer.caller, { ...publicCharacter, name: "Batch " + index })),
  );
  const first = await fixture.service.discover(fixture.caller);
  assert.equal(first.peers.length, 32);
  assert.equal(first.nextAfter, first.peers.at(-1)!.id);
  const second = await fixture.service.discover(fixture.caller, { after: first.nextAfter });
  assert.equal(second.peers.length, 3);
  assert.equal(second.nextAfter, undefined);
  assert.deepEqual(
    [...first.peers, ...second.peers],
    identities.sort((left, right) => left.id.localeCompare(right.id)),
  );
  await fixture.service.spawn(fixture.caller, { requestId: "private-pool", text: "Private job" });
  const before = (await fixture.store.get(fixture.root.id))!;
  const identity = await fixture.service.character(fixture.caller, publicCharacter);
  await fixture.service.character(fixture.caller, { version: 1, name: "Renamed", character: { role: "editor" } });
  const updated = (await fixture.store.get(fixture.root.id))!;
  assert.deepEqual(updated.messages, before.messages);
  assert.equal(updated.notificationCount, before.notificationCount);
  assert.equal(updated.expiresAt, before.expiresAt);
  assert.equal(updated.members[0]!.publicIdentity!.id, identity.id);
  assert.deepEqual(await fixture.service.discover(fixture.caller, { search: "Renamed" }), {
    peers: [updated.members[0]!.publicIdentity],
  });
});

test("live HTTP rejects forged publication fields, invalid JSON shapes, stale edits, and malformed discovery", async () => {
  const fixture = await swarmFixture();
  const capabilitySecret = "coordination-validation-capability-secret";
  const server = createServer(
    { swarms: fixture.service, authorizesCapabilityScope: async () => true } as unknown as App,
    { signingSecret: "coordination-validation-source-secret", capabilitySecret },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/v1/swarm";
    const token = await mintCapabilityToken(fixture.caller.claims, capabilitySecret);
    const headers = { "x-agent-capability": token, "content-type": "application/json" };
    const post = (body: unknown) => fetch(base, { method: "POST", headers, body: JSON.stringify(body) });
    for (const field of [
      "actorId",
      "scopeId",
      "sessionId",
      "memberId",
      "runId",
      "template",
      "publicIdentity",
      "id",
      "ownerId",
    ])
      assert.equal((await post({ action: "character", ...publicCharacter, [field]: "forged" })).status, 400, field);
    for (const body of [
      { ...publicCharacter, character: [] },
      { ...publicCharacter, character: null },
      { ...publicCharacter, version: "0" },
      { ...publicCharacter, name: 123 },
      { version: 0, name: "Missing character" },
    ])
      assert.equal((await post({ action: "character", ...body })).status, 400);
    for (const query of [
      "limit=0",
      "limit=33",
      "limit=1.5",
      "limit=1&limit=2",
      "read=1",
      "after=private-id",
      "ownerId=alice",
      "search=" + "x".repeat(201),
    ])
      assert.equal((await fetch(base + "?discover=1&" + query, { headers })).status, 400, query);
    assert.equal(await fixture.store.get(fixture.root.id), null);
    assert.equal((await post({ action: "character", ...publicCharacter })).status, 200);
    assert.equal((await post({ action: "character", ...publicCharacter })).status, 400);
    const identity = (await fixture.service.discover(fixture.caller)).peers[0]!;
    assert.equal(
      (await post({ action: "send", requestId: "public-id-is-not-private", text: "Private", audience: [identity.id] }))
        .status,
      400,
    );
    assert.deepEqual((await fixture.store.get(fixture.root.id))!.messages, []);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
