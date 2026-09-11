import "./support/auto-fake-sprites.ts";
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import * as modalClient from "../src/sandbox/modal-client.ts";
import { installFakeModal } from "./support/fake-modal.ts";
import { testConfig } from "./support/test-config.ts";
import { runResultDelivery } from "../src/delivery/run-result-delivery.ts";

test("wired swarm outbox drives the real orchestrator, durable runs, and authenticated session viewer", async () => {
  const fake = installFakeModal({ native: true });
  const mocked = mock.module("../src/sandbox/modal-client.ts", {
    namedExports: { ...modalClient, createSdkModalClient: () => fake.client },
  });
  const { buildApp } = await import("../src/wiring.ts");
  const built = buildApp(
    testConfig({
      sandboxResourcesEnabled: true,
      modalSandbox: { tokenId: "test-id", tokenSecret: "test-secret", nativeSnapshotsEnabled: true },
    }),
  );
  try {
    const rootTurn = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "swarm-integration-root" },
      origin: { kind: "human" },
      text: "Coordinate work",
    });
    assert.equal(rootTurn.status, "ok");
    const root = (await built.sessions.get(rootTurn.sessionId!))!;
    await built.memory.replace(root.scopeId, "# Memory\n- Root memory remains in the authorized notebook.");
    const rootRun = (await built.runs.list()).find((run) => run.request.conversation.threadRef === root.threadRef)!;
    const forum = await built.sandboxResources.create("U1", root.scopeId, "sprites", "Integration forum");
    const service = built.app.swarms!;
    const caller = { kind: "human" as const, actorId: "U1", sessionId: root.id, runId: rootRun.id };
    await service.spawn(caller, {
      requestId: "pool",
      count: 2,
      text: "Analyze independently and report through swarm messages",
      forumSandboxId: forum.id,
      contexts: [
        { role: "worker", group: "analysis" },
        { role: "reviewer", group: "analysis" },
      ],
    });
    await service.sweep();
    const spawnedRuns = (await built.runs.list()).filter((run) => run.request.swarm);
    assert.equal(spawnedRuns.length, 2);
    built.runtime.start();
    const completed = await Promise.all(spawnedRuns.map((run) => built.runs.waitFor(run.id, 15_000)));
    for (const run of completed) {
      assert.equal(run.status, "done", JSON.stringify(run.result));
      assert.equal(run.result?.status, "ok", JSON.stringify(run.result));
      const view = await built.app.getSessionForViewer(run.result!.sessionId!, "U1");
      assert.ok(view);
      assert.equal(view.session.scopeId, root.scopeId);
      assert.equal(view.session.surface, "swarm");
      const input = view.entries.find((entry) => entry.type === "user");
      assert.match(JSON.stringify(input?.payload), /Swarm human message/);
      assert.match(JSON.stringify(input?.payload), /automation/);
      assert.equal(await built.app.getSessionForViewer(view.session.id, "U2"), null);
      assert.equal(runResultDelivery(run), null);
      const requests = await built.sessions.listLlmRequests(view.session.id);
      assert.ok(JSON.stringify(requests).includes("Swarm session identity"));
      assert.ok(JSON.stringify(requests).includes("untrusted metadata"));
      assert.ok(JSON.stringify(requests).includes("Root memory remains in the authorized notebook"));
    }
    const peers = (await service.inspect(caller)).peers;
    assert.equal(peers.filter((peer) => peer.state === "ready").length, 3);
    for (const peer of peers.slice(1)) {
      assert.equal((await built.sandboxResources.get(peer.sandboxId!)).backend, "modal");
      assert.equal(peer.forumSandboxId, forum.id);
      assert.notEqual(peer.sandboxId, forum.id);
    }
  } finally {
    await built.runtime.stop();
    fake.cleanup();
    mocked.restore();
  }
});
