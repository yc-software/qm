import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppDeps } from "../src/api/app.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { scopeId } from "../src/types.ts";

test("getRun resolves the threadRef to the real UUID and builds the admin link from publicWebUrl", async () => {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const threadRef = "ch:C_UUID_FIXTURE:100.1";
  const session = await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));

  const { run } = await runs.enqueue({ sessionId: threadRef, request: {} as never });
  const claimed = await runs.claimById(run.id, "w1", 60_000);
  assert.ok(claimed, "claimed for processing");
  await runs.fail(run.id, claimed!.leaseToken!, "An unknown error occurred", { retry: false });

  const app = createApp({ sessions, runs, publicWebUrl: "https://portal.example.com" } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, session.id, "threadRef swapped for the real UUID");
  assert.notEqual(got?.result?.sessionId, threadRef);
  assert.equal(
    got?.result?.adminUrl,
    `https://portal.example.com/admin/history?session=${session.id}`,
    "admin link built from the org's portal + resolved UUID",
  );
});

test("getRun omits the admin link when no portal (publicWebUrl) is configured", async () => {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const threadRef = "ch:C2:2.2";
  await sessions.getOrCreateByThread(threadRef, "channel", scopeId("org", "default-org"));
  const { run } = await runs.enqueue({ sessionId: threadRef, request: {} as never });
  const claimed = await runs.claimById(run.id, "w1", 60_000);
  await runs.fail(run.id, claimed!.leaseToken!, "An unknown error occurred", { retry: false });

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.adminUrl, undefined, "no portal ⇒ no link");
});

test("getRun leaves an already-UUID refused sessionId untouched (no false rewrite)", async () => {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const session = await sessions.getOrCreateByThread("dm:U1", "dm", scopeId("personal", "U1"));
  const { run } = await runs.enqueue({ sessionId: "ch:C1:1.1", request: {} as never });
  const claimed = await runs.claimById(run.id, "w1", 60_000);
  await runs.complete(run.id, claimed!.leaseToken!, {
    status: "refused",
    sessionId: session.id,
    reason: "session busy",
  });

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.sessionId, session.id, "a real session id is left as-is");
});

test("getRun drops an unresolvable threadRef sessionId (turn failed before its session existed)", async () => {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const { run } = await runs.enqueue({ sessionId: "ch:C9:9.9", request: {} as never });
  const claimed = await runs.claimById(run.id, "w1", 60_000);
  await runs.fail(run.id, claimed!.leaseToken!, "An unknown error occurred", { retry: false });

  const app = createApp({ sessions, runs } as unknown as AppDeps);
  const got = await app.getRun(run.id);
  assert.equal(got?.result?.status, "failed");
  assert.equal(got?.result?.sessionId, undefined, "unresolvable id is dropped, not leaked");
});
