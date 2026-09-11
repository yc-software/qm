import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool } from "../src/persistence/pg-pool.ts";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { signedHeaders } from "../plugins/chassis/src/core-client.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { scopeId } from "../src/types.ts";
import { createPeerBoard } from "../src/coordination/board.ts";
import { createPeerIdentity } from "../src/coordination/identity.ts";
import { createPeerSpawning } from "../src/coordination/spawning.ts";

test("coordination rejects mixed storage before opening database connections", () => {
  for (const stores of [
    { databaseUrl: "postgres://unused", sessionStore: "memory", runStore: "memory" },
    { databaseUrl: "postgres://unused", sessionStore: "postgres", runStore: "memory" },
    { databaseUrl: "postgres://unused", sessionStore: "memory", runStore: "postgres" },
  ] as const)
    assert.throws(() => buildApp(testConfig({ coordinationEnabled: true, ...stores })), /mixed stores/);
});

test("disabled coordination preserves authenticated board inspection without mutations", async (t) => {
  const config = testConfig({
    coordinationEnabled: false,
    signingSecret: "coordination-inspection-test-secret-000000",
  });
  const built = buildApp(config);
  const identity = createPeerIdentity(built.coordinationRepository);
  await identity.ensure({
    id: "inspection-sender",
    scopeId: scopeId("personal", "alice"),
    authority: {
      surface: "web",
      actor: { id: "alice", type: "internal" },
      conversation: { kind: "dm", threadRef: "private-thread", audience: [] },
    },
  });
  await createPeerSpawning(built.coordinationRepository).reserve({
    parentId: "inspection-sender",
    parentRunId: "historical-run",
    backend: "local",
    idempotencyKey: "inspection-child",
    name: "Reserved child",
    task: "private-child-task",
  });
  const peersBefore = await built.coordinationRepository.list("peer");
  const spawnsBefore = await built.coordinationRepository.list("spawn");
  const message = await createPeerBoard(built.coordinationRepository).publish({
    senderId: "inspection-sender",
    senderRunId: "historical-run",
    idempotencyKey: "inspection",
    text: "Preserved message",
    audience: ".[] | select(false)",
  });
  const deps = serverDeps(config, built);
  assert.equal(deps.peerBoard, undefined);
  assert.equal(built.peerDispatcher, undefined);
  assert.equal(built.peerSpawnWorker, undefined);
  const server = createServer(built.app, deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = await mintCapabilityToken(
    {
      actorId: "alice",
      scopeId: scopeId("personal", "alice"),
      aud: "control-plane",
      exp: Date.now() + 60_000,
    },
    TEST_CAPABILITY_SECRET,
  );
  const headers = { "x-agent-capability": token, "content-type": "application/json" };
  const before = await built.coordinationRepository.list("message");
  const readPaths = ["/v1/peer-messages", `/v1/peer-messages/${message.id}`, "/v1/peers/inspection-sender/subtree"];
  for (const path of readPaths) {
    const response = await fetch(base + path, { headers });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    assert.ok(!text.includes("private-thread"));
    assert.ok(!text.includes("private-child-task"));
    if (path.endsWith("/subtree")) {
      const tree = JSON.parse(text);
      assert.equal(tree.count, 1);
      assert.equal(tree.cap, 16);
      assert.equal(tree.nodes.length, 2);
      assert.equal(tree.manageable, false);
    }
    assert.notEqual((await fetch(base + path)).status, 200);
  }
  const preview = await fetch(base + "/v1/peer-messages/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ audience: ".[] | select(false)" }),
  });
  assert.equal(preview.status, 200, await preview.text());
  const treePath = "/v1/peers/inspection-sender/subtree?principalId=alice";
  const humanTree = await fetch(base + treePath, {
    headers: signedHeaders(config.signingSecret, "GET", treePath, ""),
  });
  assert.equal(humanTree.status, 200);
  assert.equal(((await humanTree.json()) as { manageable: boolean }).manageable, false);
  for (const [method, operation] of [
    ["POST", "lifecycle"],
    ["PUT", "subtree-limit"],
    ["PUT", "character"],
  ]) {
    const path = `/v1/peers/inspection-sender/${operation}?principalId=alice`;
    const body = JSON.stringify({ action: "resume", limit: 1, version: 1, character: {} });
    const response = await fetch(base + path, {
      method,
      headers: { ...signedHeaders(config.signingSecret, method!, path, body), "content-type": "application/json" },
      body,
    });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, "coordination_disabled");
  }
  for (const path of ["/v1/peer-messages", "/v1/peer-spawns"]) {
    const response = await fetch(base + path, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 404);
    assert.equal(((await response.json()) as { error: string }).error, "coordination_disabled");
  }
  assert.deepEqual(await built.coordinationRepository.list("message"), before);
  assert.deepEqual(await built.coordinationRepository.list("delivery"), []);
  assert.deepEqual(await built.coordinationRepository.list("peer"), peersBefore);
  assert.deepEqual(await built.coordinationRepository.list("spawn"), spawnsBefore);
  await built.identity.deactivate("alice");
  for (const path of readPaths) {
    const response = await fetch(base + path, { headers });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized", message: "principal is no longer active" });
  }
  const deniedPreview = await fetch(base + "/v1/peer-messages/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ audience: ".[] | select(false)" }),
  });
  assert.equal(deniedPreview.status, 401);
  assert.deepEqual(await deniedPreview.json(), { error: "unauthorized", message: "principal is no longer active" });
});

test("spawn recovery is parked while sandbox-resource management is disabled", () => {
  for (const sandboxResourcesEnabled of [false, true]) {
    const config = testConfig({ coordinationEnabled: true, sandboxResourcesEnabled });
    const built = buildApp(config);
    assert.equal(Boolean(built.peerSpawnWorker), sandboxResourcesEnabled);
    assert.equal(Boolean(serverDeps(config, built).peerSpawnBackend), sandboxResourcesEnabled);
    assert.ok(built.peerSpawning);
    assert.ok(built.peerBoard);
    assert.ok(built.peerLifecycle);
  }
});

for (const backend of ["memory", "postgres"] as const)
  test(
    `peer routes ${backend} expose public character, enforce session attribution, and preserve transcript access`,
    { skip: backend === "postgres" && !process.env.COORDINATION_TEST_DATABASE_URL },
    async (t) => {
      let databaseUrl: string | undefined;
      if (backend === "postgres") {
        const pool = createPgPool(process.env.COORDINATION_TEST_DATABASE_URL!);
        const schema = `coord_routes_${randomUUID().replaceAll("-", "")}`;
        await pool.query(`CREATE SCHEMA ${schema}`);
        const url = new URL(process.env.COORDINATION_TEST_DATABASE_URL!);
        url.searchParams.set("options", `-c search_path=${schema}`);
        databaseUrl = url.toString();
        t.after(async () => {
          await pool.query(`DROP SCHEMA ${schema} CASCADE`);
          await pool.close();
        });
      }
      const config = testConfig({
        coordinationEnabled: true,
        sandboxResourcesEnabled: true,
        signingSecret: "coordination-ingress-test-secret-00000000000",
        ...(backend === "postgres"
          ? { databaseUrl: databaseUrl!, runStore: "postgres", sessionStore: "postgres", orgId: randomUUID() }
          : {}),
      });
      const built = buildApp(config);
      const deps = serverDeps(config, built);
      const server = createServer(built.app, deps);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      t.after(async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const personal = scopeId("personal", "alice");
      const session = await built.sessions.getOrCreateByThread("web:alice:private", "dm", personal, undefined, "web");
      await built.sessions.updateTitle(session.id, "Private acquisition discussion");
      await built.sessions.addParticipant(session.id, "alice");
      const peer = await built.peerIdentity!.ensure({ id: session.id, scopeId: personal });
      const { run } = await built.runs.enqueue({
        sessionId: session.threadRef,
        request: {
          actor: { id: "alice", type: "internal" },
          conversation: { kind: "dm", threadRef: session.threadRef, audience: [] },
          text: "work",
          origin: { kind: "human" },
          surface: "web",
        },
      });
      const claimed = await built.runs.claimById(run.id, "route-test", 60_000);
      assert.ok(claimed);
      assert.equal(await built.runs.bindSession(run.id, claimed.leaseToken!, session.id), true);
      const token = (actorId: string, extra: Record<string, unknown> = {}) =>
        mintCapabilityToken(
          {
            actorId,
            scopeId: scopeId("personal", actorId),
            aud: "control-plane",
            exp: Date.now() + 60_000,
            ...extra,
          },
          TEST_CAPABILITY_SECRET,
        );
      const own = await token("alice", {
        sessionId: session.id,
        runId: run.id,
        runAttempt: claimed.attempts,
        runLeaseToken: claimed.leaseToken!,
        threadRef: session.threadRef,
      });
      const request = async (path: string, cap: string, body?: unknown) =>
        fetch(base + path, {
          method: body ? "PUT" : "GET",
          headers: { "x-agent-capability": cap, "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      const self = await request("/v1/peers/self", own);
      assert.equal(self.status, 200, await self.clone().text());
      assert.equal(((await self.json()) as { peer: { id: string } }).peer.id, session.id);
      const updated = await request(`/v1/peers/${peer.id}/character`, own, {
        version: 1,
        character: { role: "worker" },
        name: "Builder",
      });
      assert.equal(updated.status, 200, await updated.clone().text());
      const bob = await token("bob");
      const peers = await request("/v1/peers", bob);
      assert.equal(peers.status, 200, await peers.clone().text());
      const publicText = await peers.text();
      assert.ok(publicText.includes("Builder"));
      for (const privateValue of [
        "Private acquisition",
        "web:alice:private",
        "personal:alice",
        "authority",
        "sandboxId",
      ])
        assert.ok(!publicText.includes(privateValue), privateValue);
      const refused = await request(`/v1/peers/${peer.id}/character`, bob, { version: 2, character: {} });
      assert.equal(refused.status, 403);
      assert.equal(await built.app.getSessionForViewer(session.id, "bob"), null);
      const stale = await request(`/v1/peers/${peer.id}/character`, own, { version: 1, character: {} });
      assert.equal(stale.status, 409);
      const forged = await token("alice", { sessionId: "other", runId: run.id, threadRef: session.threadRef });
      assert.equal((await request("/v1/peers/self", forged)).status, 403);
      const post = (cap: string, body: unknown, path = "/v1/peer-messages") =>
        fetch(base + path, {
          method: "POST",
          headers: { "x-agent-capability": cap, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const publication = {
        text: "Public progress update",
        audience: "empty",
        idempotencyKey: "progress",
        senderId: "forged",
        continuation: { kind: "reply_wait", waitId: "forged" },
      };
      const spawnRequest = {
        task: "Build independently",
        name: "Child",
        character: { role: "worker" },
        idempotencyKey: "child",
        parentId: "forged",
        parentRunId: "forged",
        backend: "forged",
      };
      assert.equal((await post(bob, spawnRequest, "/v1/peer-spawns")).status, 403);
      assert.equal((await post(forged, spawnRequest, "/v1/peer-spawns")).status, 403);
      const disabledServer = createServer(built.app, serverDeps({ ...config, sandboxResourcesEnabled: false }, built));
      await new Promise<void>((resolve) => disabledServer.listen(0, "127.0.0.1", resolve));
      t.after(() => new Promise<void>((resolve) => disabledServer.close(() => resolve())));
      const unavailable = await fetch(
        `http://127.0.0.1:${(disabledServer.address() as AddressInfo).port}/v1/peer-spawns`,
        {
          method: "POST",
          headers: { "x-agent-capability": own, "content-type": "application/json" },
          body: JSON.stringify(spawnRequest),
        },
      );
      assert.equal(unavailable.status, 503);
      assert.equal(((await unavailable.json()) as { error: string }).error, "spawn_backend_unavailable");
      assert.deepEqual(await built.coordinationRepository.list("spawn"), []);
      assert.equal((await built.peerSpawning!.inspect(session.id)).count, 0);
      const spawned = await post(own, spawnRequest, "/v1/peer-spawns");
      assert.equal(spawned.status, 200, await spawned.clone().text());
      const operation = (
        (await spawned.json()) as { spawn: { id: string; parentId: string; childId: string; state: string } }
      ).spawn;
      assert.equal(operation.parentId, session.id);
      assert.equal(operation.state, "reserved");
      const storedSpawn = await built.coordinationRepository.get("spawn", operation.id);
      assert.equal(storedSpawn?.parentRunId, run.id);
      assert.equal(storedSpawn?.backend, config.sandboxBackend);
      const duplicateSpawn = await post(own, spawnRequest, "/v1/peer-spawns");
      assert.deepEqual(await duplicateSpawn.json(), { spawn: operation });
      const subtree = await request(`/v1/peers/${session.id}/subtree`, bob);
      assert.equal(subtree.status, 200, await subtree.clone().text());
      const subtreeBody = (await subtree.json()) as { count: number; cap: number; peer: Record<string, unknown> };
      assert.equal(subtreeBody.count, 1);
      assert.equal(subtreeBody.cap, 16);
      assert.equal(subtreeBody.peer.authority, undefined);
      assert.equal(subtreeBody.peer.sandboxId, undefined);
      const lifecyclePath = `/v1/peers/${session.id}/lifecycle`;
      assert.equal((await post(own, { action: "stop" }, lifecyclePath)).status, 403);
      const humanAction = async (actor: string, action: string, subtree = false) => {
        const path = `${lifecyclePath}?principalId=${actor}`;
        const body = JSON.stringify({ action, subtree });
        return fetch(base + path, {
          method: "POST",
          body,
          headers: { ...signedHeaders(config.signingSecret, "POST", path, body), "content-type": "application/json" },
        });
      };
      assert.equal((await humanAction("bob", "stop")).status, 403);
      const paused = await humanAction("alice", "pause", true);
      assert.equal(paused.status, 200, await paused.clone().text());
      assert.equal((await built.coordinationRepository.get("peer", operation.childId))?.state, "paused");
      assert.equal((await humanAction("alice", "resume", true)).status, 200);
      assert.equal((await built.coordinationRepository.get("peer", operation.childId))?.state, "active");
      assert.equal((await request(`/v1/peers/${operation.childId}/subtree-limit`, own, { limit: 0 })).status, 403);
      assert.equal((await request(`/v1/peers/${session.id}/subtree-limit`, own, { limit: 0 })).status, 409);
      assert.equal((await request(`/v1/peers/${session.id}/subtree-limit`, own, { limit: 1 })).status, 200);
      assert.equal((await post(own, { ...spawnRequest, idempotencyKey: "overflow" }, "/v1/peer-spawns")).status, 409);
      const published = await post(own, publication);
      assert.equal(published.status, 200, await published.clone().text());
      const message = ((await published.json()) as { message: { id: string; senderId: string } }).message;
      assert.equal(message.senderId, session.id);
      const detail = await request(`/v1/peer-messages/${message.id}`, bob);
      assert.equal(detail.status, 200, await detail.clone().text());
      assert.ok((await detail.text()).includes(publication.text));
      assert.equal((await post(bob, publication)).status, 403);
      assert.equal((await post(forged, publication)).status, 403);
      assert.equal((await post(bob, { audience: ".[]" }, "/v1/peer-messages/preview")).status, 200);
      assert.equal((await request("/v1/peer-messages?limit=-1", bob)).status, 400);
      const beforeRace = {
        peers: await built.coordinationRepository.list("peer"),
        messages: await built.coordinationRepository.list("message"),
        spawns: await built.coordinationRepository.list("spawn"),
      };
      const raceTime = Date.now();
      t.mock.timers.enable({ apis: ["Date"], now: raceTime });
      let serviceEntries = 0;
      const expireBefore =
        <A extends unknown[], R>(action: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => {
          serviceEntries++;
          t.mock.timers.tick(60_001);
          return action(...args);
        };
      const board = built.peerBoard!;
      const spawning = built.peerSpawning!;
      const identity = built.peerIdentity!;
      const hooks = [
        t.mock.method(board, "publish", expireBefore(board.publish.bind(board))),
        t.mock.method(spawning, "reserve", expireBefore(spawning.reserve.bind(spawning))),
        t.mock.method(spawning, "lowerLimit", expireBefore(spawning.lowerLimit.bind(spawning))),
        t.mock.method(identity, "replace", expireBefore(identity.replace.bind(identity))),
      ];
      try {
        for (const mutate of [
          () => post(own, { ...publication, idempotencyKey: "lease-race" }),
          () => post(own, { ...spawnRequest, idempotencyKey: "lease-race" }, "/v1/peer-spawns"),
          () => request(`/v1/peers/${peer.id}/character`, own, { version: 2, character: { role: "changed" } }),
          () => request(`/v1/peers/${peer.id}/subtree-limit`, own, { limit: 15 }),
        ]) {
          t.mock.timers.setTime(raceTime);
          const response = await mutate();
          assert.equal(response.status, 403);
          assert.equal(((await response.json()) as { error: string }).error, "coordination_run_expired");
        }
        assert.equal(serviceEntries, 4);
      } finally {
        for (const hook of hooks) hook.mock.restore();
        t.mock.timers.reset();
      }
      assert.deepEqual(
        {
          peers: await built.coordinationRepository.list("peer"),
          messages: await built.coordinationRepository.list("message"),
          spawns: await built.coordinationRepository.list("spawn"),
        },
        beforeRace,
      );
      await built.sessions.addParticipant(session.id, "bob");
      assert.ok(await built.app.getSessionForViewer(session.id, "bob"));
      assert.equal(await built.app.managesScope("bob", personal), false);
      const humanCharacter = (principalId: string) => {
        const path = `/v1/peers/${session.id}/character?principalId=${principalId}`;
        const body = JSON.stringify({ version: 2, name: "Managed worker", character: { role: "reviewer" } });
        return fetch(base + path, {
          method: "PUT",
          body,
          headers: { ...signedHeaders(config.signingSecret, "PUT", path, body), "content-type": "application/json" },
        });
      };
      assert.equal((await humanCharacter("bob")).status, 403);
      assert.equal((await built.peerIdentity!.get(session.id))?.version, 2);
      const managed = await humanCharacter("alice");
      assert.equal(managed.status, 200, await managed.clone().text());
      assert.equal((await built.peerIdentity!.get(session.id))?.name, "Managed worker");
      await built.runs.releaseLease(run.id, claimed.leaseToken!);
      const replacement = await built.runs.claimById(run.id, "replacement-worker", 60_000);
      assert.ok(replacement);
      assert.ok(replacement.attempts > claimed.attempts);
      assert.equal((await request("/v1/peers/self", own)).status, 403);
      assert.equal((await post(own, { ...publication, idempotencyKey: "retired-attempt" })).status, 403);
      assert.equal(
        (await post(own, { ...spawnRequest, idempotencyKey: "retired-spawn" }, "/v1/peer-spawns")).status,
        403,
      );
      const replacementToken = await token("alice", {
        sessionId: session.id,
        runId: run.id,
        runAttempt: replacement.attempts,
        runLeaseToken: replacement.leaseToken!,
        threadRef: session.threadRef,
      });
      assert.equal((await request("/v1/peers/self", replacementToken)).status, 200);
      assert.equal(
        (await post(replacementToken, { ...publication, idempotencyKey: "replacement-message" })).status,
        200,
      );
      await built.runs.complete(run.id, replacement.leaseToken!, { status: "silent" });
      assert.equal((await request("/v1/peers/self", replacementToken)).status, 403);
      t.mock.timers.enable({ apis: ["Date"] });
      const expiring = await built.runs.enqueue({ sessionId: session.threadRef, request: run.request });
      const expired = await built.runs.claimById(expiring.run.id, "expiring-worker", 1_000);
      assert.ok(expired);
      assert.equal(await built.runs.bindSession(expired.id, expired.leaseToken!, session.id), true);
      const expiredToken = await token("alice", {
        sessionId: session.id,
        runId: expired.id,
        runAttempt: expired.attempts,
        runLeaseToken: expired.leaseToken!,
        threadRef: session.threadRef,
      });
      assert.equal((await request("/v1/peers/self", expiredToken)).status, 200);
      t.mock.timers.tick(1_001);
      assert.equal((await built.runs.get(expired.id))?.status, "running");
      assert.equal((await request("/v1/peers/self", expiredToken)).status, 403);
      t.mock.timers.reset();
      assert.equal((await post(own, { ...publication, idempotencyKey: "stale" })).status, 403);
      assert.equal((await request(`/v1/peers/${peer.id}/character`, own, { version: 2, character: {} })).status, 403);
      await built.runs.releaseLease(expired.id, expired.leaseToken!);
      const unbound = await built.runs.enqueue({ sessionId: session.threadRef, request: run.request });
      const unboundClaim = (await built.runs.claimById(unbound.run.id, "binding-worker", 60_000))!;
      assert.ok(unboundClaim);
      const unboundToken = await token("alice", {
        sessionId: session.id,
        runId: unbound.run.id,
        runAttempt: unboundClaim.attempts,
        threadRef: session.threadRef,
        runLeaseToken: unboundClaim.leaseToken!,
      });
      assert.equal((await request("/v1/peers/self", unboundToken)).status, 403);
      assert.equal(await built.runs.bindSession(unbound.run.id, unboundClaim.leaseToken!, session.id), true);
      assert.equal((await request("/v1/peers/self", unboundToken)).status, 200);
      await built.sessions.deleteSession(session.id);
      const recreated = await built.sessions.getOrCreateByThread(session.threadRef, "dm", personal, undefined, "web");
      assert.notEqual(recreated.id, session.id);
      await built.peerIdentity!.ensure({ id: recreated.id, scopeId: personal });
      const mismatched = await token("alice", {
        sessionId: recreated.id,
        runId: unbound.run.id,
        runAttempt: unboundClaim.attempts,
        threadRef: recreated.threadRef,
        runLeaseToken: unboundClaim.leaseToken!,
      });
      assert.equal((await request("/v1/peers/self", mismatched)).status, 403);
      const beforeMessages = await built.coordinationRepository.list("message");
      const beforeSpawns = await built.coordinationRepository.list("spawn");
      assert.equal((await post(mismatched, { ...publication, idempotencyKey: "wrong-binding" })).status, 403);
      assert.equal(
        (await post(mismatched, { ...spawnRequest, idempotencyKey: "wrong-binding" }, "/v1/peer-spawns")).status,
        403,
      );
      assert.equal(
        (await request(`/v1/peers/${recreated.id}/character`, mismatched, { version: 1, character: {} })).status,
        403,
      );
      assert.equal((await request(`/v1/peers/${recreated.id}/subtree-limit`, mismatched, { limit: 1 })).status, 403);
      assert.deepEqual(await built.coordinationRepository.list("message"), beforeMessages);
      assert.deepEqual(await built.coordinationRepository.list("spawn"), beforeSpawns);
      assert.equal((await built.peerIdentity!.get(recreated.id))?.version, 1);
    },
  );
