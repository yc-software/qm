import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateItemTokens, compactTranscript } from "../src/agent/context-compaction.ts";
import { estimateDocumentTokens } from "../src/core/documents.ts";
import { storedItem } from "../src/sessions/items.ts";

let seq = 0;
function item(kind: "UserMessage" | "AgentMessage", text: string, body: Record<string, unknown> = {}) {
  seq += 1;
  return storedItem({ kind, text, body }, { sessionId: "budget", seq, createdAt: seq });
}

const pdf = (name: string, artifactId: string, sizeBytes = 1_000_000) => ({
  name,
  mimetype: "application/pdf",
  sizeBytes,
  direction: "in" as const,
  artifactId,
});

test("earlier document attachments do not inflate history token estimates", () => {
  const plain = item("UserMessage", "please review");
  const withPdf = item("UserMessage", "please review", { attachments: [pdf("contract.pdf", "f1")] });
  assert.equal(estimateItemTokens(withPdf), estimateItemTokens(plain));
  assert.ok(estimateDocumentTokens({ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50_000_000 }) <= 50_000);
});

test("compaction input names each compacted document and its saved file", () => {
  const transcript = compactTranscript([
    item("UserMessage", "review these", { attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
    item("AgentMessage", "Done."),
  ]);
  assert.match(transcript, /review these \(files: a\.pdf \[file fa\], b\.pdf \[file fb\]\)/);
});
