import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimFlyPeer,
  createEcsTaskStopped,
  recordStoppedFlyPeers,
  type FlyPeerClaim,
} from "../src/deploy/fly-peer-claims.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("overlapping tasks get distinct peers and reconnect to their existing claim", async () => {
  const claims = createMemoryMap<FlyPeerClaim>();
  const shared = { claims, peerIds: ["a", "b"], taskStopped: async () => false };
  const peers = await Promise.all(["old", "new"].map((taskArn) => claimFlyPeer({ ...shared, taskArn })));
  assert.notEqual(peers[0], peers[1]);
  assert.equal(await claimFlyPeer({ ...shared, taskArn: "old" }), peers[0]);
  await assert.rejects(claimFlyPeer({ ...shared, taskArn: "third" }), /confirmed stopped/);
});

test("only confirmed stopped tasks relinquish a peer", async () => {
  const claims = createMemoryMap<FlyPeerClaim>();
  await claims.put("a", { taskArn: "old" });
  const opts = { claims, peerIds: ["a"], taskArn: "new" };
  await assert.rejects(claimFlyPeer({ ...opts, taskStopped: async () => false }), /confirmed stopped/);
  await assert.rejects(
    claimFlyPeer({
      ...opts,
      taskStopped: async () => {
        throw new Error("AWS unavailable");
      },
    }),
    /AWS unavailable/,
  );
  assert.deepEqual(await claims.get("a"), { taskArn: "old" });
  assert.equal(await claimFlyPeer({ ...opts, taskStopped: async () => true }), "a");
  assert.deepEqual(await claims.get("a"), { taskArn: "new" });
});

test("a stale stopped-task observation cannot replace a newly assigned owner", async () => {
  const claims = createMemoryMap<FlyPeerClaim>();
  await claims.put("a", { taskArn: "old" });
  await assert.rejects(
    claimFlyPeer({
      claims,
      peerIds: ["a"],
      taskArn: "late",
      taskStopped: async () => {
        await claims.put("a", { taskArn: "winner" });
        return true;
      },
    }),
    /confirmed stopped/,
  );
  assert.deepEqual(await claims.get("a"), { taskArn: "winner" });
});

test("ECS termination requires the exact task and STOPPED status without failures", async () => {
  for (const [response, expected] of [
    [{ tasks: [{ taskArn: "owner", lastStatus: "STOPPED" }] }, true],
    [{ tasks: [{ taskArn: "owner", lastStatus: "RUNNING", desiredStatus: "STOPPED" }] }, false],
    [{ tasks: [{ taskArn: "other", lastStatus: "STOPPED" }] }, false],
    [{ tasks: [] }, false],
    [{ failures: [{ arn: "owner", reason: "MISSING" }] }, false],
  ] satisfies Array<[Partial<import("@aws-sdk/client-ecs").DescribeTasksCommandOutput>, boolean]>) {
    const stopped = createEcsTaskStopped({
      cluster: "company",
      describe: async (command) => {
        assert.deepEqual(command.input, { cluster: "company", tasks: ["owner"] });
        return {
          $metadata: {},
          ...structuredClone(response),
        } as import("@aws-sdk/client-ecs").DescribeTasksCommandOutput;
      },
    });
    assert.equal(await stopped("owner"), expected);
  }
});

test("persisted termination evidence permits reuse after ECS history disappears", async () => {
  const claims = createMemoryMap<FlyPeerClaim>();
  await claims.put("a", { taskArn: "old" });
  await recordStoppedFlyPeers({ claims, peerIds: ["a"], taskStopped: async () => true });
  assert.ok((await claims.get("a"))?.stoppedConfirmedAt);
  const peer = await claimFlyPeer({
    claims,
    peerIds: ["a"],
    taskArn: "new",
    taskStopped: async () => {
      throw new Error("historical lookup must not be needed");
    },
  });
  assert.equal(peer, "a");
  assert.deepEqual(await claims.get("a"), { taskArn: "new" });
});

test("termination evidence is never copied to a replacement task", async () => {
  const claims = createMemoryMap<FlyPeerClaim>();
  await claims.put("a", { taskArn: "old" });
  await recordStoppedFlyPeers({
    claims,
    peerIds: ["a"],
    taskStopped: async () => {
      await claims.put("a", { taskArn: "new" });
      return true;
    },
  });
  assert.deepEqual(await claims.get("a"), { taskArn: "new" });
});
