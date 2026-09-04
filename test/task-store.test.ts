import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMemoryTaskStore } from "../src/tasks/memory-task-store.ts";
import { TASK_STATUSES } from "../src/tasks/task-store.ts";

describe("memory task store", () => {
  let time = 1_000;
  const store = () => createMemoryTaskStore({ now: () => ++time });

  it("creates every supported status and records an initial event", async () => {
    const tasks = store();
    for (const status of TASK_STATUSES) {
      const task = await tasks.create({ sessionId: "session", originRunId: `run-${status}`, title: status, status });
      assert.equal(task.status, status);
      assert.deepEqual(await tasks.listEvents(task.id), [
        {
          id: String(TASK_STATUSES.indexOf(status) + 1),
          taskId: task.id,
          runId: `run-${status}`,
          type: "created",
          fromStatus: null,
          toStatus: status,
          createdAt: task.createdAt,
        },
      ]);
    }
  });

  it("lists open tasks filtered by session and origin run", async () => {
    const tasks = store();
    const first = await tasks.create({ sessionId: "s1", originRunId: "r1", title: "first" });
    const second = await tasks.create({ sessionId: "s1", originRunId: "r2", title: "second", status: "in_progress" });
    await tasks.create({ sessionId: "s2", originRunId: "r1", title: "other session" });
    await tasks.create({ sessionId: "s1", originRunId: "r1", title: "done", status: "completed" });

    assert.deepEqual(
      (await tasks.listOpen({ sessionId: "s1" })).map((task) => task.id),
      [first.id, second.id],
    );
    assert.deepEqual(
      (await tasks.listOpen({ originRunId: "r1" })).map((task) => task.title),
      ["first", "other session"],
    );
    assert.deepEqual(
      (await tasks.listOpen({ sessionId: "s1", originRunId: "r1" })).map((task) => task.id),
      [first.id],
    );
    assert.deepEqual(
      (await tasks.list({ sessionId: "s1", statuses: ["completed"] })).map((task) => task.title),
      ["done"],
    );
  });

  it("uses compare-and-set transitions and appends only successful events", async () => {
    const tasks = store();
    const task = await tasks.create({ sessionId: "s1", originRunId: "origin", title: "ship it" });

    const [won, lost] = await Promise.all([
      tasks.transitionStatus(task.id, "pending", "in_progress", "worker-a"),
      tasks.transitionStatus(task.id, "pending", "failed", "worker-b"),
    ]);
    assert.equal(won?.status, "in_progress");
    assert.equal(lost, null);
    assert.equal((await tasks.get(task.id))?.status, "in_progress");

    const completed = await tasks.transitionStatus(task.id, "in_progress", "completed", "worker-a");
    assert.equal(completed?.status, "completed");
    assert.deepEqual(
      (await tasks.listEvents(task.id)).map((event) => [event.runId, event.fromStatus, event.toStatus]),
      [
        ["origin", null, "pending"],
        ["worker-a", "pending", "in_progress"],
        ["worker-a", "in_progress", "completed"],
      ],
    );
    assert.deepEqual(await tasks.listOpen({ sessionId: "s1" }), []);
  });

  it("returns copies that cannot mutate task or event state", async () => {
    const tasks = store();
    const task = await tasks.create({ sessionId: "s1", originRunId: "r1", title: "immutable reads" });
    task.status = "failed";
    const event = (await tasks.listEvents(task.id))[0]!;
    event.toStatus = "failed";
    assert.equal((await tasks.get(task.id))?.status, "pending");
    assert.equal((await tasks.listEvents(task.id))[0]?.toStatus, "pending");
  });
});
