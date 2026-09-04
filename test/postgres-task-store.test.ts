import assert from "node:assert/strict";
import { test } from "node:test";
import { createPostgresTaskStore } from "../src/tasks/postgres-task-store.ts";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { scopeId } from "../src/types.ts";

const URL = process.env.DATABASE_URL;
const skip = URL ? false : "set DATABASE_URL (a Postgres) to run the pg task-store tests";

test("pg task store: tasks and events are durable across instances", { skip }, async () => {
  const writer = createPostgresTaskStore(URL!);
  const reader = createPostgresTaskStore(URL!);
  const sessions = createPostgresSessionStore(URL!);
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const session = await sessions.getOrCreateByThread(`task-${key}`, "dm", scopeId("personal", `task-${key}`));
    const task = await writer.create({
      sessionId: session.id,
      originRunId: `origin-${key}`,
      title: "durable task",
    });
    assert.deepEqual(await reader.get(task.id), task);
    assert.deepEqual(
      (await reader.listOpen({ sessionId: task.sessionId })).map((row) => row.id),
      [task.id],
    );

    const transitioned = await reader.transitionStatus(task.id, "pending", "in_progress", `worker-${key}`);
    assert.equal(transitioned?.status, "in_progress");
    assert.deepEqual(
      (await writer.listEvents(task.id)).map((event) => [event.type, event.runId, event.fromStatus, event.toStatus]),
      [
        ["created", task.originRunId, null, "pending"],
        ["status_changed", `worker-${key}`, "pending", "in_progress"],
      ],
    );
  } finally {
    await writer.close?.();
    await reader.close?.();
  }
});

test("pg task store: concurrent status transitions use compare-and-set", { skip }, async () => {
  const first = createPostgresTaskStore(URL!);
  const second = createPostgresTaskStore(URL!);
  const sessions = createPostgresSessionStore(URL!);
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const session = await sessions.getOrCreateByThread(
      `task-race-${key}`,
      "dm",
      scopeId("personal", `task-race-${key}`),
    );
    const task = await first.create({ sessionId: session.id, originRunId: `origin-${key}`, title: "race" });
    const results = await Promise.all([
      first.transitionStatus(task.id, "pending", "completed", `winner-a-${key}`),
      second.transitionStatus(task.id, "pending", "failed", `winner-b-${key}`),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    const stored = await first.get(task.id);
    assert.ok(stored);
    assert.ok(stored.status === "completed" || stored.status === "failed");
    const events = await second.listEvents(task.id);
    assert.equal(events.length, 2, "the losing CAS does not append an event");
    assert.equal(events[1]?.toStatus, stored.status);
  } finally {
    await first.close?.();
    await second.close?.();
  }
});

test("pg task store: open filters compose session and origin run", { skip }, async () => {
  const tasks = createPostgresTaskStore(URL!);
  const sessions = createPostgresSessionStore(URL!);
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const originRunId = `origin-${key}`;
  try {
    const sessionId = (
      await sessions.getOrCreateByThread(`task-filter-${key}`, "dm", scopeId("personal", `task-filter-${key}`))
    ).id;
    const otherSessionId = (
      await sessions.getOrCreateByThread(
        `task-filter-other-${key}`,
        "dm",
        scopeId("personal", `task-filter-other-${key}`),
      )
    ).id;
    const wanted = await tasks.create({ sessionId, originRunId, title: "wanted", status: "in_progress" });
    await tasks.create({ sessionId, originRunId: `other-${key}`, title: "other origin" });
    await tasks.create({ sessionId: otherSessionId, originRunId, title: "other session" });
    await tasks.create({ sessionId, originRunId, title: "closed", status: "skipped" });

    assert.deepEqual(
      (await tasks.listOpen({ sessionId, originRunId })).map((task) => task.id),
      [wanted.id],
    );
    assert.deepEqual(
      (await tasks.list({ sessionId, statuses: ["skipped"] })).map((task) => task.title),
      ["closed"],
    );
  } finally {
    await tasks.close?.();
  }
});
