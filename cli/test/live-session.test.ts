import test from "node:test";
import assert from "node:assert/strict";
import { checkControlledLiveSession, type LiveSessionOwner } from "../src/live-session.ts";

function owner(): LiveSessionOwner {
  return {
    deploymentId: "core:release",
    status: {
      protocol: 2,
      deploymentId: "core:release",
      instanceId: "instance-a",
      ownerDeploymentId: "core:release",
      setAt: "2026-10-04T00:00:00.000Z",
      setBy: "core:release",
      active: true,
    },
  };
}

function success(body: string): Record<string, unknown> {
  const request = JSON.parse(body);
  assert.deepEqual(Object.keys(request).sort(), ["expectedDeploymentId", "requestId"]);
  assert.equal(request.expectedDeploymentId, "core:release");
  return { ok: true, requestId: request.requestId, deploymentId: "core:release", instanceId: "instance-a" };
}

test("live session accepts whitespace heartbeats and checks ownership afterward", async () => {
  let reads = 0;
  await checkControlledLiveSession({
    before: owner(),
    request: async (body) => ({ status: 200, body: ` \n\t\n${JSON.stringify(success(body))}\n` }),
    read: async () => {
      reads++;
      return owner();
    },
  });
  assert.equal(reads, 1);
});

test("live session refuses an inactive or non-owning deployment before requesting a canary", async () => {
  const mutations: Array<(value: LiveSessionOwner) => void> = [
    (value) => {
      value.status.ownerDeploymentId = null;
    },
    (value) => {
      value.status.ownerDeploymentId = "other";
    },
    (value) => {
      value.status.active = false;
    },
    (value) => {
      value.status.deploymentId = "other";
    },
  ];
  for (const mutate of mutations) {
    const before = owner();
    mutate(before);
    await assert.rejects(
      checkControlledLiveSession({
        before,
        request: async () => {
          assert.fail("no canary before ownership proof");
        },
        read: async () => owner(),
      }),
      /active deployment that owns background work/,
    );
  }
});

test("live session requires an explicit final success bound to request and deployment", async () => {
  for (const patch of [
    { ok: false, error: "sensitive server error" },
    { ok: undefined },
    { requestId: "another-request" },
    { deploymentId: "stale" },
    { instanceId: "" },
  ]) {
    let calls = 0;
    await assert.rejects(
      checkControlledLiveSession({
        before: owner(),
        request: async (body) => {
          calls++;
          return { status: 200, body: JSON.stringify({ ...success(body), ...patch }) };
        },
        read: async () => owner(),
      }),
      (error: Error) => {
        assert.match(error.message, /did not confirm success/);
        assert.doesNotMatch(error.message, /sensitive server error/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("live session never retries an ambiguous or truncated response", async () => {
  for (const kind of ["disconnect", "heartbeat-only", "truncated", "http-error"]) {
    let calls = 0;
    await assert.rejects(
      checkControlledLiveSession({
        before: owner(),
        request: async () => {
          calls++;
          if (kind === "disconnect") throw new Error("Bearer secret must never escape");
          return {
            status: kind === "http-error" ? 503 : 200,
            body: kind === "heartbeat-only" ? " \n\n" : '{"ok":true',
          };
        },
        read: async () => owner(),
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /Bearer secret/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("live session rejects an ownership change during a successful model check", async () => {
  const mutations: Array<(value: LiveSessionOwner) => void> = [
    (value) => {
      value.status.ownerDeploymentId = null;
    },
    (value) => {
      value.status.active = false;
    },
    (value) => {
      value.deploymentId = "core:replacement";
      value.status.deploymentId = "core:replacement";
      value.status.ownerDeploymentId = "core:replacement";
    },
  ];
  for (const mutate of mutations) {
    const after = owner();
    mutate(after);
    await assert.rejects(
      checkControlledLiveSession({
        before: owner(),
        request: async (body) => ({ status: 200, body: JSON.stringify(success(body)) }),
        read: async () => after,
      }),
      /owns background work|deployment changed/,
    );
  }
});
