import "../support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../support/build-app.ts";
import { testConfig } from "../support/test-config.ts";
import { mockPrompts } from "../support/mock-harness/turn.ts";

function freshApp(maxContextTokens?: number) {
  return buildApp(testConfig({ maxContextTokens }));
}

test("document uploads survive follow-up turns and stay isolated to their conversation", async () => {
  const built = freshApp();
  const blob = await built.blobTransfer.put(Buffer.from("QUARTZ-731"));
  const request = {
    surface: "test" as const,
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:docs" },
  };
  const first = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "summarize",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  assert.equal(first.status, "ok");
  const followup = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "what was the verification code?",
  });
  assert.equal(followup.status, "ok");
  const requests = mockPrompts(followup.sessionId!);
  assert.equal(requests.length, 2);
  for (const recorded of requests) assert.match(JSON.stringify(recorded), /"documents":\[\{"name":"notes.txt"/);
  const other = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    conversation: { kind: "dm", threadRef: "dm:U1:other" },
    text: "hello",
  });
  assert.doesNotMatch(JSON.stringify(mockPrompts(other.sessionId!)), /notes.txt/);
});

test("compaction stops automatic document replay while preserving the original file", async () => {
  const built = freshApp();
  const blob = await built.blobTransfer.put(Buffer.from("QUARTZ-731"));
  const request = {
    surface: "test" as const,
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:compacted-docs" },
  };
  const first = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "summarize",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  const entries = await built.sessions.getItems(first.sessionId!);
  const attachment = (
    entries.find((item) => item.kind === "UserMessage")!.body.attachments as Array<{ artifactId: string }>
  )[0]!;
  const { lease } = await built.sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease);
  await built.sessions.append(lease, {
    kind: "ContextCompaction",
    text: "Earlier user supplied a document.",
    throughSeq: entries.at(-1)!.seq,
  });
  await built.sessions.releaseLease(lease);
  const result = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "what was in the document?",
  });
  assert.equal(result.status, "ok");
  assert.doesNotMatch(JSON.stringify(mockPrompts(result.sessionId!).at(-1)), /"documents":/);
  const artifact = await built.files.get(attachment.artifactId);
  assert.equal(artifact?.enabled, true);
  const opened = await built.files.open(attachment.artifactId);
  assert.ok(opened);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "QUARTZ-731");
  const original = await built.sessions.getItem(first.sessionId!, entries[0]!.seq);
  assert.deepEqual(original, entries[0]);
});

test("compaction during a turn stops document replay immediately", async () => {
  const built = freshApp(20_000);
  const blob = await built.blobTransfer.put(Buffer.from("QUARTZ-731"));
  const request = {
    surface: "test" as const,
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:compacted-docs" },
  };
  const first = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "summarize",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  const entries = await built.sessions.getItems(first.sessionId!);
  const attachment = (
    entries.find((item) => item.kind === "UserMessage")!.body.attachments as Array<{ artifactId: string }>
  )[0]!;
  const { lease } = await built.sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease);
  for (let i = 0; i < 8; i++) {
    await built.sessions.append(lease, {
      kind: i % 2 === 0 ? "UserMessage" : "AgentMessage",
      text: "Synthetic conversation context. ".repeat(2000),
    });
  }
  await built.sessions.releaseLease(lease);
  const result = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "what was in the document?",
  });
  assert.equal(result.status, "ok");
  const compacted = await built.sessions.getItems(first.sessionId!);
  assert.ok(compacted.some((item) => item.kind === "ContextCompaction"));
  assert.doesNotMatch(JSON.stringify(mockPrompts(result.sessionId!).at(-1)), /"documents":/);
  const artifact = await built.files.get(attachment.artifactId);
  assert.equal(artifact?.enabled, true);
  const opened = await built.files.open(attachment.artifactId);
  assert.ok(opened);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "QUARTZ-731");
  const original = await built.sessions.getItem(first.sessionId!, entries[0]!.seq);
  assert.deepEqual(original, entries[0]);
});

test("large documents never push a follow-up turn past the context budget", async () => {
  const budget = 20_000;
  const built = freshApp(budget);
  const request = {
    surface: "test" as const,
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:large-docs" },
  };
  const sizes = new Map<string, number>();
  for (const name of ["one.txt", "two.txt", "three.txt"]) {
    const blob = await built.blobTransfer.put(Buffer.from(`${name} `.repeat(4_000)));
    sizes.set(name, blob.sizeBytes);
    const turn = await built.app.turn({
      origin: { kind: "direct" },
      ...request,
      text: `read ${name}`,
      attachments: [{ name, mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
    });
    assert.equal(turn.status, "ok");
  }
  const followup = await built.app.turn({
    origin: { kind: "direct" },
    ...request,
    text: "compare the three files",
  });
  assert.equal(followup.status, "ok");
  const replayed = (mockPrompts(followup.sessionId!).at(-1)?.documents ?? []).map((document) => document.name);
  const replayedTokens = replayed.reduce((sum, name) => sum + Math.ceil(sizes.get(name)! / 4), 0);
  assert.ok(replayedTokens <= budget / 2, `replayed ${replayed.join(", ")} (~${replayedTokens} tokens)`);
});
