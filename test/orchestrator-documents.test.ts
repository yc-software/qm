import { readFile } from "node:fs/promises";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp(maxContextTokens?: number) {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "document-turn-")), maxContextTokens }));
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
    ...request,
    text: "summarize",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  assert.equal(first.status, "ok");
  const followup = await built.app.turn({ ...request, text: "what was the verification code?" });
  assert.equal(followup.status, "ok");
  const requests = (await built.sessions.listLlmRequests(followup.sessionId!)).filter((r) => r.model === "mock");
  assert.equal(requests.length, 2);
  for (const recorded of requests)
    assert.match(JSON.stringify(recorded.promptEnvelope), /"documents":\[\{"name":"notes.txt"/);
  const other = await built.app.turn({
    ...request,
    conversation: { kind: "dm", threadRef: "dm:U1:other" },
    text: "hello",
  });
  const otherRequests = await built.sessions.listLlmRequests(other.sessionId!);
  assert.doesNotMatch(JSON.stringify(otherRequests), /notes.txt/);
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
    ...request,
    text: "summarize",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  const entries = await built.sessions.getEntries(first.sessionId!);
  const attachment = (
    entries.find((entry) => entry.type === "user")!.payload as {
      attachments: Array<{ artifactId: string }>;
    }
  ).attachments[0]!;
  const { lease } = await built.sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease);
  await built.sessions.append(lease, {
    type: "system",
    payload: { kind: "context_summary", text: "Earlier user supplied a document.", throughSeq: entries.at(-1)!.seq },
    scopeLabel: entries[0]!.scopeLabel,
  });
  await built.sessions.releaseLease(lease);
  const result = await built.app.turn({ ...request, text: "what was in the document?" });
  assert.equal(result.status, "ok");
  const calls = (await built.sessions.listLlmRequests(result.sessionId!)).filter((record) => record.model === "mock");
  assert.doesNotMatch(JSON.stringify(calls.at(-1)?.promptEnvelope), /"documents":/);
  const artifact = await built.files.get(attachment.artifactId);
  assert.equal(artifact?.enabled, true);
  const opened = await built.files.open(attachment.artifactId);
  assert.ok(opened);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "QUARTZ-731");
  const original = await built.sessions.getEntry(first.sessionId!, entries[0]!.seq);
  assert.deepEqual(original, entries[0]);
});

test("compaction during a turn stops document replay immediately", async () => {
  const built = freshApp(2000);
  const blob = await built.blobTransfer.put(Buffer.from("QUARTZ-731"));
  const request = {
    surface: "test" as const,
    actor: { externalId: "U1" },
    conversation: { kind: "dm" as const, threadRef: "dm:U1:compacted-docs" },
  };
  const first = await built.app.turn({
    ...request,
    text: "summarize",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  const entries = await built.sessions.getEntries(first.sessionId!);
  const attachment = (
    entries.find((entry) => entry.type === "user")!.payload as {
      attachments: Array<{ artifactId: string }>;
    }
  ).attachments[0]!;
  const { lease } = await built.sessions.acquireLease(first.sessionId!, "compaction");
  assert.ok(lease);
  for (let i = 0; i < 8; i++) {
    await built.sessions.append(lease, {
      type: i % 2 === 0 ? "user" : "assistant",
      payload: { text: "Synthetic conversation context. ".repeat(100) },
      scopeLabel: entries[0]!.scopeLabel,
    });
  }
  await built.sessions.releaseLease(lease);
  const result = await built.app.turn({ ...request, text: "what was in the document?" });
  assert.equal(result.status, "ok");
  const compacted = await built.sessions.getEntries(first.sessionId!);
  assert.ok(
    compacted.some(
      (entry) => entry.type === "system" && (entry.payload as { kind?: string }).kind === "context_summary",
    ),
  );
  const calls = (await built.sessions.listLlmRequests(result.sessionId!)).filter((record) => record.model === "mock");
  assert.doesNotMatch(JSON.stringify(calls.at(-1)?.promptEnvelope), /"documents":/);
  const artifact = await built.files.get(attachment.artifactId);
  assert.equal(artifact?.enabled, true);
  const opened = await built.files.open(attachment.artifactId);
  assert.ok(opened);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "QUARTZ-731");
  const original = await built.sessions.getEntry(first.sessionId!, entries[0]!.seq);
  assert.deepEqual(original, entries[0]);
});

for (const extension of ["docx", "pdf"]) {
  test(`automatic ${extension} input respects a strict content-screen verdict`, async () => {
    const built = freshApp();
    const bytes = await readFile(new URL(`./fixtures/documents/hostile.${extension}`, import.meta.url));
    const blob = await built.blobTransfer.put(bytes);
    const request = {
      surface: "test" as const,
      actor: { externalId: "U1" },
      conversation: { kind: "dm" as const, threadRef: `dm:U1:hostile-${extension}` },
    };
    const result = await built.app.turn({
      ...request,
      text: "summarize",
      attachments: [
        {
          name: `hostile.${extension}`,
          mimetype:
            extension === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sizeBytes: blob.sizeBytes,
          blobId: blob.blobId,
        },
      ],
    });
    assert.equal(result.status, "ok");
    const calls = (await built.sessions.listLlmRequests(result.sessionId!)).filter((record) => record.model === "mock");
    assert.doesNotMatch(JSON.stringify(calls.at(-1)?.promptEnvelope), /"documents":/);
    assert.match(JSON.stringify(calls.at(-1)?.promptEnvelope), /withheld by the external-data security screen/);
    const followup = await built.app.turn({ ...request, text: "try reading it again" });
    const followupCalls = (await built.sessions.listLlmRequests(followup.sessionId!)).filter(
      (record) => record.model === "mock",
    );
    assert.doesNotMatch(JSON.stringify(followupCalls.at(-1)?.promptEnvelope), /"documents":/);
  });
}
