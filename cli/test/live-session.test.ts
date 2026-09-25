import test from "node:test";
import assert from "node:assert/strict";
import { checkControlledLiveSession, type LiveSessionCohort } from "../src/live-session.ts";

function cohort(): LiveSessionCohort {
  return {
    deploymentId: "core:release",
    taskArns: ["task-a", "task-b"],
    status: {
      protocol: 1,
      enabled: true,
      deploymentId: "core:release",
      instanceId: "instance-a",
      generation: 4,
      desiredDeploymentId: "core:release",
      lastRequestId: "handover",
      members: ["a", "b"].map((suffix) => ({
        instanceId: `instance-${suffix}`,
        taskArn: `task-${suffix}`,
        deploymentId: "core:release",
        generation: 4,
        state: "admitted",
        retired: false,
        ready: true,
      })),
    },
  };
}

function success(body: string): Record<string, unknown> {
  const request = JSON.parse(body);
  assert.equal(request.expectedDeploymentId, "core:release");
  assert.equal(request.expectedGeneration, 4);
  assert.deepEqual(request.expectedTaskArns, ["task-a", "task-b"]);
  return {
    ok: true,
    requestId: request.requestId,
    deploymentId: "core:release",
    generation: 4,
    instanceId: "instance-a",
    taskArn: "task-a",
  };
}

test("live session accepts whitespace heartbeats and checks the exact cohort afterward", async () => {
  let reads = 0;
  await checkControlledLiveSession({
    before: cohort(),
    request: async (body) => ({ status: 200, body: ` \n\t\n${JSON.stringify(success(body))}\n` }),
    read: async () => {
      reads++;
      return cohort();
    },
  });
  assert.equal(reads, 1);
});

test("live session refuses incomplete or competing ownership before requesting a canary", async () => {
  const mutations: Array<(value: LiveSessionCohort) => void> = [
    (value) => {
      value.status.enabled = false;
    },
    (value) => {
      value.status.desiredDeploymentId = "other";
    },
    (value) => {
      value.status.members[0]!.ready = false;
    },
    (value) => {
      value.status.members[0]!.generation--;
    },
    (value) => {
      value.status.members[0]!.retired = true;
    },
    (value) => {
      value.status.members[0]!.state = "relinquished";
    },
    (value) => {
      value.status.members.push({ ...value.status.members[0]!, instanceId: "other", taskArn: "unexpected" });
    },
  ];
  for (const mutate of mutations) {
    const before = cohort();
    mutate(before);
    await assert.rejects(
      checkControlledLiveSession({
        before,
        request: async () => {
          assert.fail("no canary before ownership proof");
        },
        read: async () => cohort(),
      }),
      /exact ready deployment cohort/,
    );
  }
});

test("live session requires an explicit final success bound to request and instance", async () => {
  for (const patch of [
    { ok: false, error: "sensitive server error" },
    { ok: undefined },
    { requestId: "another-request" },
    { deploymentId: "stale" },
    { generation: 3 },
    { instanceId: "old-instance" },
    { taskArn: "old-task" },
  ]) {
    let calls = 0;
    await assert.rejects(
      checkControlledLiveSession({
        before: cohort(),
        request: async (body) => {
          calls++;
          return { status: 200, body: JSON.stringify({ ...success(body), ...patch }) };
        },
        read: async () => cohort(),
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
        before: cohort(),
        request: async () => {
          calls++;
          if (kind === "disconnect") throw new Error("Bearer secret must never escape");
          return {
            status: kind === "http-error" ? 503 : 200,
            body: kind === "heartbeat-only" ? " \n\n" : '{"ok":true',
          };
        },
        read: async () => cohort(),
      }),
      (error: Error) => {
        assert.doesNotMatch(error.message, /Bearer secret/);
        return true;
      },
    );
    assert.equal(calls, 1);
  }
});

test("live session rejects ownership or task replacement during a successful model check", async () => {
  const mutations: Array<(value: LiveSessionCohort) => void> = [
    (value) => {
      value.status.generation++;
      value.status.members.forEach((member) => member.generation++);
    },
    (value) => {
      value.taskArns[1] = "replacement";
      value.status.members[1]!.taskArn = "replacement";
    },
    (value) => {
      value.status.members[0]!.instanceId = "replacement-instance";
    },
    (value) => {
      value.status.desiredDeploymentId = null;
    },
  ];
  for (const mutate of mutations) {
    const after = cohort();
    mutate(after);
    await assert.rejects(
      checkControlledLiveSession({
        before: cohort(),
        request: async (body) => ({ status: 200, body: JSON.stringify(success(body)) }),
        read: async () => after,
      }),
      /cohort/,
    );
  }
});
