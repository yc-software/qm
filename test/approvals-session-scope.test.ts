import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api/app.ts";
import { createIdentityService } from "../src/identity/identity-service.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import type { PendingApprovalRecord } from "../src/types.ts";

const approval = (sessionId: string, actor: string, command: string, blocksInput = true): PendingApprovalRecord => ({
  sessionId,
  command,
  createdAt: 1,
  blocksInput,
  request: {
    surface: "web",
    actor: { externalId: actor },
    conversation: { kind: "dm", threadRef: `dm:${actor}` },
    text: command,
  },
});

test("session approvals are read by session id, never by scanning every approval", async () => {
  const sessions = createMemorySessionStore();
  const mine = await sessions.getOrCreateByThread("dm:alice:t1", "dm", "personal:alice");
  const other = await sessions.getOrCreateByThread("dm:bob:t1", "dm", "personal:bob");
  await sessions.addParticipant(mine.id, "alice");
  await sessions.addParticipant(mine.id, "bob");
  const backing = createMemoryMap<PendingApprovalRecord>();
  await backing.put("a-blocking", approval(mine.id, "alice", "git push --force"));
  await backing.put("a-input", approval(mine.id, "alice", "ask", false));
  await backing.put("b-blocking", approval(other.id, "bob", "rm -rf /"));
  await backing.put("orphan", approval("no-such-session", "alice", "noop"));
  await backing.put("unicode", approval("sesión-ü", "alice", "echo"));
  const expectedFromFullScan = (await backing.entries()).filter(([, r]) => r.sessionId === mine.id).map(([id]) => id);

  let fullReads = 0;
  const approvals: DurableMap<PendingApprovalRecord> = {
    ...backing,
    async entries() {
      fullReads++;
      return backing.entries();
    },
    async all() {
      fullReads++;
      return backing.all();
    },
  };
  const app = createApp({
    sessions,
    approvals,
    identity: createIdentityService(),
  } as unknown as Parameters<typeof createApp>[0]);

  const listed = await app.listSessionApprovals(mine.id, "alice");
  assert.deepEqual(
    listed.map((a) => a.requestId),
    expectedFromFullScan,
    "the filtered read returns exactly what the old full scan + filter did",
  );
  assert.deepEqual(
    listed.map((a) => a.blocksInput),
    [true, false],
  );
  assert.deepEqual(await app.listSessionApprovals(mine.id, "bob"), [], "viewer visibility still applies");

  const blocking = await app.pendingApprovalForThread(mine.threadRef);
  assert.equal(blocking?.status, "pending_approval");
  assert.deepEqual(
    blocking?.pendingApprovals?.map((a) => a.requestId),
    ["a-blocking"],
    "blockingOnly still drops non-blocking approvals",
  );
  assert.equal(fullReads, 0, "no caller read the whole approvals map");
});
