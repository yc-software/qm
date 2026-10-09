import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemorySessionStore } from "../src/sessions/memory-session-store.ts";
import { createMemoryRunStore } from "../src/runs/memory-run-store.ts";
import { createMemoryRunSignalStore } from "../src/runs/run-signal-store.ts";
import { createDeliveryStore } from "../src/delivery/delivery-store.ts";
import { withWebTranscriptDeliveries } from "../src/delivery/web-transcript-delivery.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createSessionMailbox, type SessionMessage } from "../src/sessions/session-mailbox.ts";
import { createSessionSyscalls } from "../src/sessions/session-syscalls.ts";
import { scopeId, type Conversation, type Principal, type Session } from "../src/types.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";

const actor: Principal = { id: "alice@example.com", type: "internal", displayName: "Alice" };
const scope = scopeId("personal", actor.id);
const conversation: Conversation = { kind: "dm", threadRef: "web:alice@example.com:c1", audience: [actor] };

async function rig() {
  const sessions = createMemorySessionStore();
  const { runs } = createMemoryRunStore();
  const mailbox = createSessionMailbox(createMemoryMap<SessionMessage>());
  const deliveries = withWebTranscriptDeliveries(createDeliveryStore(), sessions);
  const factory = createSessionSyscalls({
    mailbox,
    deliveries,
    sessions,
    runs,
    signals: createMemoryRunSignalStore(),
    maxAttempts: 3,
  });
  const parent = await sessions.getOrCreateByThread(conversation.threadRef, "dm", scope, undefined, "web");
  await sessions.addParticipant(parent.id, actor.id);
  const forTurn = (session: Session) =>
    factory.forTurn({
      session,
      scopeId: scope,
      request: { surface: "web", conversation, actor, deliveryTarget: conversation.threadRef } as OrchestratorInput,
    });
  const opened = await forTurn(parent).open({ task: "dig in", name: "Digger" });
  assert.ok(opened.ok);
  const child = (await sessions.get(opened.sessionId))!;
  return { sessions, runs, mailbox, deliveries, parent, child: forTurn(child), childId: child.id };
}

test("a subagent's message to an idle web parent shows in the parent transcript without a turn", async () => {
  const r = await rig();
  assert.equal((await r.child.write({ target: "parent", text: "root cause found" })).ok, true);
  assert.equal((await r.deliveries.pending("web")).length, 1);
  const entries = await r.sessions.getEntries(r.parent.id);
  assert.deepEqual(
    entries.map((entry) => [entry.type, (entry.payload as { kind?: string; text?: string }).kind, (entry.payload as { text?: string }).text]),
    [["system", "subagent_update", "root cause found"]],
  );
  assert.equal((entries[0]!.payload as { sessionId?: string }).sessionId, r.childId);
  assert.equal((await r.runs.inFlightForThread(r.parent.threadRef)).length, 0);
  assert.equal((await r.mailbox.pending(r.parent.id)).length, 1);
});

test("a busy parent gets the message through its running turn only", async () => {
  const r = await rig();
  await r.runs.enqueue({
    sessionId: r.parent.threadRef,
    request: { actor, conversation, origin: { kind: "direct" }, text: "working" } as OrchestratorInput,
  });
  assert.equal((await r.child.write({ target: "parent", text: "halfway" })).ok, true);
  assert.equal((await r.deliveries.pending("web")).length, 0);
  assert.equal((await r.mailbox.pending(r.parent.id)).length, 1);
});
