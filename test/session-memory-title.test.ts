import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSessionMailbox, type SessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Conversation, type Principal, type ScopeId, type Session } from "../src/types.ts";
import type { SessionStore } from "../src/sessions/session-store.ts";
import type { RunStore } from "../src/runs/run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const actor: Principal = { id: "U1", type: "internal", displayName: "Alex" };
const scope: ScopeId = scopeId("personal", "U1");
const conversation: Conversation = { kind: "dm", threadRef: "slack:dm:D1", audience: [actor] };

interface Rig {
  mailbox: SessionMailbox;
  sessions: SessionStore;
  runs: RunStore;
  signals: ReturnType<typeof createMemoryRunSignalStore>;
  room: Session;
  syscallsFor(session: Session): ReturnType<ReturnType<typeof createSessionSyscalls>["forTurn"]>;
}

async function rig(opts?: { treeRunCap?: number }): Promise<Rig> {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const signals = createMemoryRunSignalStore();
  const mailbox = createSessionMailbox(createMemoryMap<SessionMessage>());
  const factory = createSessionSyscalls({
    mailbox,
    sessions,
    runs,
    signals,
    maxAttempts: 3,
    ...(opts?.treeRunCap !== undefined ? { treeRunCap: opts.treeRunCap } : {}),
  });
  const room = await sessions.getOrCreateByThread("slack:dm:D1", "dm", scope, undefined, "slack");
  await sessions.updateTitle(room.id, "dm with alex");
  await sessions.addParticipant(room.id, actor.id);
  const binding = (session: Session) => ({
    session,
    memoryContext: { audience: "safe-audience" },
    scopeId: scope,
    request: {
      surface: "slack",
      conversation,
      actor,
      deliveryTarget: "D1",
      timezone: "America/Los_Angeles",
    } as Pick<OrchestratorInput, "surface" | "conversation" | "actor" | "deliveryTarget" | "timezone" | "readOnly">,
  });
  return {
    mailbox,
    sessions,
    runs,
    signals,
    room,
    syscallsFor: (session) => factory.forTurn(binding(session)),
  };
}

test("previous-audience child title is not disclosed through session read", async () => {
  const r = await rig();
  const child = await r.sessions.getOrCreateByThread("subagent:synthetic", "dm", scope);
  await r.sessions.setParentSession(child.id, r.room.id);
  await r.sessions.addParticipant(child.id, actor.id);
  await r.sessions.updateTitle(child.id, "PRIVATE_SENTINEL");
  const { lease } = await r.sessions.acquireLease(child.id);
  assert.ok(lease);
  await r.sessions.append(lease, {
    type: "user",
    scopeLabel: scope,
    payload: {
      text: "PRIVATE_SENTINEL",
      memoryContext: {
        kind: "memory_context",
        fingerprint: "old",
        snapshot: { audience: "previous-audience" },
        throughSeq: -1,
      },
    },
  });
  await r.sessions.append(lease, { type: "assistant", scopeLabel: scope, payload: { text: "PRIVATE_SENTINEL" } });
  await r.sessions.releaseLease(lease);
  const result = await r.syscallsFor(r.room).read({ target: child.id });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
  const listed = await r.syscallsFor(r.room).read({});
  assert.doesNotMatch(JSON.stringify(listed), /PRIVATE_SENTINEL/);
});

test("reset source title does not enter fresh child task", async () => {
  const r = await rig();
  await r.sessions.updateTitle(r.room.id, "PRIVATE_SENTINEL");
  const { lease } = await r.sessions.acquireLease(r.room.id);
  assert.ok(lease);
  const old = await r.sessions.append(lease, {
    type: "assistant",
    scopeLabel: scope,
    payload: { text: "PRIVATE_SENTINEL" },
  });
  await r.sessions.append(lease, {
    type: "system",
    scopeLabel: scope,
    payload: {
      kind: "memory_context",
      fingerprint: "new",
      snapshot: { audience: "safe-audience" },
      throughSeq: old.seq,
    },
  });
  await r.sessions.releaseLease(lease);
  const opened = await r.syscallsFor((await r.sessions.get(r.room.id))!).open({ task: "safe task", name: "safe name" });
  assert.ok(opened.ok);
  const child = (await r.sessions.get(opened.sessionId))!;
  const run = (await r.runs.inFlightForThread(child.threadRef))[0]!;
  assert.doesNotMatch(run.request.text, /PRIVATE_SENTINEL/);
});
test("previous-audience child title is not disclosed through session write", async () => {
  const r = await rig();
  const opened = await r.syscallsFor(r.room).open({ task: "task", name: "PRIVATE_SENTINEL" });
  assert.ok(opened.ok);
  const child = (await r.sessions.get(opened.sessionId))!;
  await r.sessions.setParentSession(child.id, r.room.id);
  await r.sessions.addParticipant(child.id, actor.id);
  await r.sessions.updateTitle(child.id, "PRIVATE_SENTINEL");
  const { lease } = await r.sessions.acquireLease(child.id);
  assert.ok(lease);
  await r.sessions.append(lease, {
    type: "user",
    scopeLabel: scope,
    payload: {
      text: "PRIVATE_SENTINEL",
      memoryContext: {
        kind: "memory_context",
        fingerprint: "old",
        snapshot: { audience: "previous-audience" },
        throughSeq: -1,
      },
    },
  });
  await r.sessions.append(lease, { type: "assistant", scopeLabel: scope, payload: { text: "PRIVATE_SENTINEL" } });
  await r.sessions.releaseLease(lease);
  const result = await r.syscallsFor(r.room).write({ target: child.id, text: "generic message" });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL/);
});
