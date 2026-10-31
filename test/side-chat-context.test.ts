import { countTokens } from "../src/util/tokens.ts";
import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { sideChatContext } from "../src/core/side-chat-context.ts";
import { buildApp } from "./support/build-app.ts";
import { createMockAgent } from "./support/mock-agent.ts";
import { testConfig } from "./support/test-config.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";

function discussions(text: string) {
  const json = text.split("```untrusted-data\n")[1]?.split("\n```")[0];
  return json ? JSON.parse(json) : [];
}

test("side-chat context excludes copied history, tools, footers, private messages, and promoted sessions", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const parent = await store.getOrCreateByThread("parent", "dm", "personal:alice");
  await store.addParticipant(parent.id, "alice");
  await store.addParticipant(parent.id, "bob");
  const { lease: parentLease } = await store.acquireLease(parent.id);
  assert.ok(parentLease);
  await store.append(parentLease, { type: "user", scopeLabel: parent.scopeId, payload: { text: "selected passage" } });
  await store.releaseLease(parentLease);
  const child = await store.getOrCreateByThread("child", "dm", parent.scopeId);
  await store.addParticipant(child.id, "alice");
  const { lease } = await store.acquireLease(child.id);
  assert.ok(lease);
  await store.append(lease, { type: "user", scopeLabel: parent.scopeId, payload: { text: "copied parent message" } });
  await store.updateForkProvenance(child.id, {
    forkedFrom: { sessionId: parent.id },
    forkBoundarySeq: 0,
    sideChat: { entrySeq: 0, quote: "selected passage", occurrence: 0, expanded: false },
  });
  await store.append(lease, {
    type: "user",
    scopeLabel: parent.scopeId,
    payload: {
      text: "private earlier question",
      speakerId: "alice",
      environment: "do not copy footer",
      memoryRecall: "private memory",
    },
  });
  await store.addParticipant(child.id, "bob");
  await store.append(lease, {
    type: "user",
    scopeLabel: parent.scopeId,
    payload: {
      text: "shared question",
      speakerId: "bob",
      environment: "do not copy footer",
    },
  });
  await store.append(lease, { type: "assistant", scopeLabel: parent.scopeId, payload: { text: "shared answer" } });
  await store.append(lease, {
    type: "tool_result",
    scopeLabel: parent.scopeId,
    payload: { callId: "side-context-tool", tool: "read", result: "tool secret" },
  });
  await store.releaseLease(lease);
  const text = await sideChatContext(store, parent, ["alice", "bob"], 10000);
  const [discussion] = discussions(text);
  assert.equal(discussion.passage, "selected passage");
  assert.deepEqual(
    discussion.messages.map((message: { text: string }) => message.text),
    ["shared question", "shared answer"],
  );
  assert.equal(discussion.messages[0].user, "bob");
  assert.equal(typeof discussion.messages[0].timestamp, "number");
  assert.equal(text.includes("do not copy footer"), false);
  assert.equal(text.includes("private memory"), false);
  assert.equal(await sideChatContext(store, parent, ["outsider"], 10000), "");
  await store.removeParticipant(child.id, "bob");
  assert.equal(await sideChatContext(store, parent, ["alice", "bob"], 10000), "");
  await store.expandSideChat(child.id);
  assert.equal(await sideChatContext(store, parent, ["alice"], 10000), "");
});

test("parent reads persisted side-chat exchanges on its next turn without a synthetic parent turn", async () => {
  const inputs: AgentTurnInput[] = [];
  const mock = createMockAgent();
  const { app } = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "qm-side-context-")) }), {
    agent: {
      ...mock,
      runTurn: async (input) => {
        inputs.push(input);
        return mock.runTurn(input);
      },
    },
  });
  const turn = (threadRef: string, text: string) =>
    app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef },
      text,
    });
  const first = await turn("web:U1:context-parent", "Explain queues");
  const child = await app.forkSession(first.sessionId!, "U1", {
    sideChat: { entrySeq: 0, quote: "queues", occurrence: 0 },
  });
  assert.ok(child);
  await turn(child.session.threadRef, "The retry decision is five attempts");
  assert.equal(inputs.length, 2);
  await turn("web:U1:context-parent", "Continue with the agreed retry decision");
  assert.equal(inputs.length, 3);
  const [discussion] = discussions(inputs[2]!.systemPrompt);
  assert.equal(discussion.sessionId, child.session.id);
  assert.ok(
    discussion.messages.some((message: { text: string }) => message.text === "The retry decision is five attempts"),
  );
  assert.equal(
    discussion.messages.some((message: { text: string }) => message.text === "Explain queues"),
    false,
  );
  assert.ok(discussion.messages.every((message: object) => !Object.hasOwn(message, "environment")));
  await app.expandSideChat("U1", child.session.id);
  await turn(child.session.threadRef, "Now this is a normal session");
  await turn("web:U1:context-parent", "Any remaining side discussions?");
  assert.deepEqual(discussions(inputs.at(-1)!.systemPrompt), []);
});

test("side-chat context pages messages and reports exchanges omitted by the model budget", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const parent = await store.getOrCreateByThread("budget-parent", "dm", "personal:alice");
  await store.addParticipant(parent.id, "alice");
  const { lease: parentLease } = await store.acquireLease(parent.id);
  assert.ok(parentLease);
  await store.append(parentLease, { type: "user", scopeLabel: parent.scopeId, payload: { text: "queue" } });
  await store.releaseLease(parentLease);
  for (let childIndex = 0; childIndex < 2; childIndex++) {
    const child = await store.getOrCreateByThread(`budget-child-${childIndex}`, "dm", parent.scopeId);
    await store.addParticipant(child.id, "alice");
    await store.updateForkProvenance(child.id, {
      forkedFrom: { sessionId: parent.id },
      forkBoundarySeq: 0,
      sideChat: { entrySeq: 0, quote: "queue", occurrence: 0, expanded: false },
    });
    const { lease } = await store.acquireLease(child.id);
    assert.ok(lease);
    await store.append(lease, { type: "user", scopeLabel: parent.scopeId, payload: { text: "copied" } });
    for (let index = 0; index < 130; index++) {
      await store.append(lease, {
        type: "user",
        scopeLabel: parent.scopeId,
        payload: { text: `message ${childIndex}/${index}` },
      });
    }
    await store.append(lease, {
      type: "tool_result",
      scopeLabel: parent.scopeId,
      payload: { callId: "big-tool", tool: "read", result: "tool data ".repeat(10000) },
    });
    await store.releaseLease(lease);
  }
  const full = await sideChatContext(store, parent, ["alice"], 20000);
  assert.equal(discussions(full).flatMap((d: { messages: unknown[] }) => d.messages).length, 260);
  const bounded = await sideChatContext(store, parent, ["alice"], 600);
  assert.ok(countTokens(bounded) <= 600);
  assert.match(bounded, /omitted/);
  assert.ok(discussions(bounded).flatMap((d: { messages: unknown[] }) => d.messages).length < 260);
  const latest = (await store.sideChatsOf(parent.id)).sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  )[0]!;
  const { lease } = await store.acquireLease(latest.id);
  assert.ok(lease);
  await store.append(lease, {
    type: "assistant",
    scopeLabel: parent.scopeId,
    payload: { text: "oversized answer ".repeat(10000) },
  });
  await store.releaseLease(lease);
  const oversized = await sideChatContext(store, parent, ["alice"], 600);
  assert.ok(countTokens(oversized) <= 600);
  assert.match(oversized, /omitted/);
  assert.deepEqual(discussions(oversized), []);
});
