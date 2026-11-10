import { readFile } from "node:fs/promises";
import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./support/build-app.ts";
import { testConfig } from "./support/test-config.ts";

function freshApp() {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "document-turn-")) }));
}

test("an earlier turn's document is not re-sent on later turns and stays saved in its conversation", async () => {
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
  assert.match(JSON.stringify(requests[0]!.promptEnvelope), /"documents":\[\{"name":"notes.txt"/);
  assert.doesNotMatch(JSON.stringify(requests[1]!.promptEnvelope), /"documents":\[\{/);
  const items = await built.sessions.getItems(first.sessionId!);
  const upload = items.find((item) => item.kind === "UserMessage")!;
  const { artifactId } = (upload.body as { attachments: Array<{ artifactId: string }> }).attachments[0]!;
  assert.match(
    String(upload.body.environment),
    new RegExp(`"notes.txt" is included inline with this message only; .* saved as file ${artifactId}`),
  );
  const opened = await built.files.open(artifactId);
  assert.ok(opened);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(chunks).toString(), "QUARTZ-731");
  const other = await built.app.turn({
    ...request,
    conversation: { kind: "dm", threadRef: "dm:U1:other" },
    text: "hello",
  });
  const otherRequests = await built.sessions.listLlmRequests(other.sessionId!);
  assert.doesNotMatch(JSON.stringify(otherRequests), /notes.txt/);
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
