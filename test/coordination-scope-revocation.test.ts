import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import { projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";

test("project roster revocation and rejoining cannot revive a coordination capability", async (t) => {
  const config = testConfig({
    coordinationEnabled: true,
    sandboxResourcesEnabled: true,
    signingSecret: "coordination-revocation-test-secret-000000000",
  });
  const built = buildApp(config);
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Coordination QA", ownerId: "owner" });
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const groupRef = projectGroupRef(project.id);
  const scopeId = projectScopeId(project.id);
  const scopeVersion = await built.projects.version(groupRef);
  assert.ok(scopeVersion);
  const session = await built.sessions.getOrCreateByThread(
    "web:member:coordination-revocation",
    "group",
    scopeId,
    undefined,
    "web",
  );
  await built.peerIdentity!.ensure({ id: session.id, scopeId });
  const { run } = await built.runs.enqueue({
    sessionId: session.threadRef,
    request: {
      actor: { id: "member", type: "internal" },
      conversation: { kind: "group", threadRef: session.threadRef, channelRef: groupRef, audience: [] },
      text: "coordinate project work",
      origin: { kind: "human" },
      surface: "web",
      scopeVersion,
    },
  });
  const claimed = await built.runs.claimById(run.id, "qa", 60_000);
  assert.ok(claimed);
  assert.equal(await built.runs.bindSession(run.id, claimed.leaseToken!, session.id), true);
  const cap = await mintCapabilityToken(
    {
      actorId: "member",
      scopeId,
      scopeVersion,
      sessionId: session.id,
      threadRef: session.threadRef,
      runId: run.id,
      runAttempt: claimed.attempts,
      runLeaseToken: claimed.leaseToken!,
      aud: "control-plane",
      exp: Date.now() + 60_000,
    },
    TEST_CAPABILITY_SECRET,
  );
  const server = createServer(built.app, serverDeps(config, built));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (method: string, path: string, body?: unknown, capability = cap) =>
    fetch(base + path, {
      method,
      headers: { "x-agent-capability": capability, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  assert.equal((await request("GET", "/v1/peers/self")).status, 200);
  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  for (const rejoined of [false, true]) {
    if (rejoined) assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
    assert.equal((await built.runs.get(run.id))?.status, "running");
    const operations: Array<[string, string, unknown?]> = [
      ["GET", "/v1/peers/self"],
      ["POST", "/v1/peer-messages", { text: "stale publication", audience: "empty", idempotencyKey: "stale" }],
      ["POST", "/v1/peer-spawns", { task: "stale spawn", name: "Child", idempotencyKey: "stale" }],
      ["PUT", `/v1/peers/${session.id}/character`, { version: 1, character: { role: "stale" } }],
      ["PUT", `/v1/peers/${session.id}/subtree-limit`, { limit: 1 }],
    ];
    for (const [method, path, body] of operations) {
      const response = await request(method, path, body);
      assert.equal(response.status, 403, `${method} ${path} rejoined=${rejoined}`);
      assert.match(await response.text(), /scope membership has been revoked/);
    }
  }
  assert.deepEqual(await built.coordinationRepository.list("spawn"), []);
  assert.deepEqual(await built.coordinationRepository.list("message"), []);
  assert.equal((await built.peerIdentity!.get(session.id))?.version, 1);
  assert.equal((await built.peerIdentity!.get(session.id))?.descendantLimit, 16);
  await built.runs.complete(run.id, claimed.leaseToken!, { status: "silent" });
  const currentVersion = await built.projects.version(groupRef);
  assert.notEqual(currentVersion, scopeVersion);
  const next = await built.runs.enqueue({
    sessionId: session.threadRef,
    request: { ...run.request, scopeVersion: currentVersion, text: "new authorized work" },
  });
  const nextClaim = await built.runs.claimById(next.run.id, "qa", 60_000);
  assert.ok(nextClaim);
  assert.equal(await built.runs.bindSession(nextClaim.id, nextClaim.leaseToken!, session.id), true);
  const currentCap = await mintCapabilityToken(
    {
      actorId: "member",
      scopeId,
      scopeVersion: currentVersion,
      sessionId: session.id,
      threadRef: session.threadRef,
      runId: next.run.id,
      runAttempt: nextClaim.attempts,
      runLeaseToken: nextClaim.leaseToken!,
      aud: "control-plane",
      exp: Date.now() + 60_000,
    },
    TEST_CAPABILITY_SECRET,
  );
  assert.equal((await request("GET", "/v1/peers/self", undefined, currentCap)).status, 200);
  assert.equal(
    (
      await request(
        "PUT",
        `/v1/peers/${session.id}/character`,
        { version: 1, character: { role: "current" } },
        currentCap,
      )
    ).status,
    200,
  );
  assert.equal(await built.sessions.deleteSessionIfEmpty(session.id), true);
  const replacement = await built.sessions.getOrCreateByThread(session.threadRef, "group", scopeId, undefined, "web");
  assert.notEqual(replacement.id, session.id);
  await built.peerIdentity!.ensure({ id: replacement.id, scopeId });
  assert.equal((await built.runs.get(next.run.id))?.status, "running");
  const staleSelf = await request("GET", "/v1/peers/self", undefined, currentCap);
  assert.equal(staleSelf.status, 403);
  assert.match(await staleSelf.text(), /capability does not identify a running session/);
  const staleMutation = await request(
    "PUT",
    `/v1/peers/${replacement.id}/character`,
    {
      version: 1,
      character: { role: "stale-incarnation" },
    },
    currentCap,
  );
  assert.equal(staleMutation.status, 403);
  assert.equal((await built.peerIdentity!.get(replacement.id))?.version, 1);
});
