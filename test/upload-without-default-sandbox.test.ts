import "./support/auto-fake-sprites.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import type { TurnRequest } from "../src/types.ts";

test("an upload in a scope without a default sandbox still reaches the agent", async () => {
  const built = buildApp(testConfig({ sandboxResourcesEnabled: true, eagerProvisionEnabled: false }));
  await built.directory.replace([{ principalId: "U1", displayName: "Synthetic User", type: "internal" }]);
  await built.directory.replaceChannels(
    [{ channelId: "C1", name: "synthetic-upload", isPrivate: true }],
    [{ channelId: "C1", principalId: "U1" }],
  );
  await built.sandboxResources.initialize();
  const request: Omit<TurnRequest, "text"> = {
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "channel", threadRef: "ch:C1:upload", channelRef: "C1", audience: [{ externalId: "U1" }] },
  };
  const first = await built.app.turn({ ...request, text: "I will share a document" });
  assert.equal(first.status, "ok");
  const sessionId = first.sessionId!;
  const blob = await built.blobTransfer.put(Buffer.from("Synthetic upload sample"));
  const before = (await built.sessions.listLlmRequests(sessionId)).length;
  const upload = await built.app.turn({
    ...request,
    text: "Please read this document",
    attachments: [{ name: "sample.txt", mimetype: "text/plain", sizeBytes: blob.sizeBytes, blobId: blob.blobId }],
  });
  assert.equal(upload.status, "ok", upload.status === "ok" ? undefined : upload.reason);
  assert.ok((await built.sessions.listLlmRequests(sessionId)).length > before);
  assert.equal(await built.sandboxResources.resolve("channel:C1"), null);
  const entries = await built.sessions.getEntries(sessionId);
  const text = JSON.stringify(entries.filter((e) => e.type === "user"));
  assert.match(text, /sample\.txt/);
  assert.match(text, /not yet on a computer/);
  assert.match(text, /\/v1\/files\/[^/]+\/content/);
});
