import { readFile } from "node:fs/promises";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { NonRetryableTurnError } from "../src/core/turn-error.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "document-turn-")) }));
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

test("documents remain available after conversation compaction", async () => {
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
  assert.match(JSON.stringify(calls.at(-1)?.promptEnvelope), /"documents":\[\{"name":"notes.txt"/);
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

test("plain upload intake and document reading work while computer provisioning is unavailable", async () => {
  const built = freshApp();
  let provisioned = 0;
  built.sandbox.provision = async () => {
    provisioned++;
    throw new Error("computer unavailable");
  };
  const blob = await built.blobTransfer.put(Buffer.from("UPLOAD_WITHOUT_COMPUTER_742"));
  const result = await built.app.turn({
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:no-computer" },
    text: "summarize this upload",
    attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  assert.equal(result.status, "ok");
  assert.equal(provisioned, 0);
  const entries = await built.sessions.getEntries(result.sessionId!);
  const user = entries.find((entry) => entry.type === "user")!;
  const meta = (user.payload as { attachments: Array<{ artifactId: string }> }).attachments[0]!;
  assert.ok(await built.files.get(meta.artifactId));
  const calls = await built.sessions.listLlmRequests(result.sessionId!);
  assert.match(JSON.stringify(calls), /UPLOAD_WITHOUT_COMPUTER_742/);
});

for (const text of ["please read the upload", ""]) {
  test(`intake failure retains the ${text ? "text" : "attachment-only"} initiating user turn`, async () => {
    const built = freshApp();
    const blob = await built.blobTransfer.put(Buffer.from("some bytes"));
    built.files.put = async () => {
      throw new NonRetryableTurnError("artifact store unavailable");
    };
    await assert.rejects(
      built.app.turn({
        surface: "test",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: "dm:U1:intake-failure" },
        text,
        attachments: [{ name: "notes.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
      }),
      /artifact store unavailable/,
    );
    const session = (await built.sessions.listByParticipant("U1"))[0]!;
    const entries = await built.sessions.getEntries(session.id);
    const users = entries.filter((entry) => entry.type === "user");
    assert.equal(users.length, 1);
    assert.equal((users[0]!.payload as { text: string }).text, text);
    assert.equal((users[0]!.payload as { attachments: Array<{ name: string }> }).attachments[0]!.name, "notes.txt");
  });
}
