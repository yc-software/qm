import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { ECSClient } from "@aws-sdk/client-ecs";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import type { FlyPeerClaim } from "../src/deploy/fly-peer-claims.ts";

let launches = 0;
let live = false;
let stopCalls = 0;
mock.module("../src/deploy/fly-private-tunnel.ts", {
  namedExports: {
    startFlyPrivateTunnel: async () => {
      launches++;
      live = true;
      return {
        port: 31_000 + launches,
        isAlive: () => live,
        stop: async () => {
          live = false;
          stopCalls++;
        },
      };
    },
  },
});
const { createFlyTunnelManager } = await import("../src/deploy/fly-tunnel-manager.ts");

test("concurrent requests share startup and restart a confirmed dead tunnel once", async () => {
  launches = 0;
  stopCalls = 0;
  live = false;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ TaskARN: "task", Cluster: "cluster", LaunchType: "FARGATE" })),
  );
  const ecsMock = mock.method(ECSClient.prototype, "send", async () => ({
    tasks: [{ taskArn: "task", lastStatus: "RUNNING" }],
  }));
  const manager = createFlyTunnelManager({
    peers: [
      { id: "a", config: "a" },
      { id: "b", config: "b" },
    ],
    claims: createMemoryMap<FlyPeerClaim>(),
    metadataUri: "http://169.254.170.2/v4/test",
    executable: "wireproxy",
  });
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => manager.ensure())), Array(8).fill(31_001));
    assert.equal(launches, 1);
    live = false;
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => manager.ensure())), Array(8).fill(31_002));
    assert.equal(launches, 2);
    assert.equal(stopCalls, 1);
    await manager.stop();
    assert.equal(stopCalls, 2);
    await assert.rejects(manager.ensure(), /stopped/);
  } finally {
    await manager.stop();
    fetchMock.mock.restore();
    ecsMock.mock.restore();
  }
});

test("monitor records stopped predecessors before any app request or tunnel startup", async () => {
  launches = 0;
  const fetchMock = mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ TaskARN: "new", Cluster: "cluster", LaunchType: "FARGATE" })),
  );
  const ecsMock = mock.method(ECSClient.prototype, "send", async () => ({
    tasks: [{ taskArn: "old", lastStatus: "STOPPED" }],
  }));
  const claims = createMemoryMap<FlyPeerClaim>();
  await claims.put("a", { taskArn: "old" });
  let recorded!: () => void;
  const ready = new Promise<void>((resolve) => {
    recorded = resolve;
  });
  const update = claims.update!.bind(claims);
  claims.update = async (id, fn) => {
    const value = await update(id, fn);
    recorded();
    return value;
  };
  const manager = createFlyTunnelManager({
    peers: [
      { id: "a", config: "a" },
      { id: "b", config: "b" },
    ],
    claims,
    metadataUri: "http://169.254.170.2/v4/test",
    executable: "wireproxy",
  });
  try {
    manager.monitor();
    await ready;
    assert.ok((await claims.get("a"))?.stoppedConfirmedAt);
    assert.equal(launches, 0);
  } finally {
    await manager.stop();
    fetchMock.mock.restore();
    ecsMock.mock.restore();
  }
});

test("peer identity is stable across labels and duplicate keys are rejected", async () => {
  const { parseFlyWireguardPeers } = await import("../src/deploy/fly-tunnel-manager.ts");
  const key = (n: number) => `[Interface]\nPrivateKey = ${Buffer.alloc(32, n).toString("base64")}\n`;
  const peers = [
    { id: "a", config: key(1) },
    { id: "b", config: key(2) },
  ];
  const first = parseFlyWireguardPeers(JSON.stringify(peers));
  const renamed = parseFlyWireguardPeers(JSON.stringify(peers.map((p) => ({ ...p, id: p.id + "-renamed" }))));
  assert.deepEqual(first, renamed);
  assert.throws(
    () =>
      parseFlyWireguardPeers(
        JSON.stringify([
          { id: "a", config: key(1) },
          { id: "b", config: key(1) },
        ]),
      ),
    /distinct identities/,
  );
});
