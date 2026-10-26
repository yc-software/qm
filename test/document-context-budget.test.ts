import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateItemTokens,
  overBudgetFraction,
  planCompaction,
  compactTranscript,
} from "../src/harness/context-compaction.ts";
import { estimateDocumentTokens } from "../src/core/document-kinds.ts";
import { storedItem, type Item } from "../src/sessions/items.ts";

let seq = 0;
function entry(kind: "UserMessage" | "AgentMessage", body: { text: string } & Record<string, unknown>): Item {
  seq += 1;
  const { text, ...rest } = body;
  return storedItem({ kind, text, body: rest }, { sessionId: "budget", seq, createdAt: seq });
}

const pdf = (name: string, artifactId: string, sizeBytes = 1_000_000) => ({
  name,
  mimetype: "application/pdf",
  sizeBytes,
  direction: "in" as const,
  artifactId,
});

test("a user entry's document attachments count at their expanded size", () => {
  const plain = entry("UserMessage", { text: "please review" });
  const withPdf = entry("UserMessage", { text: "please review", attachments: [pdf("contract.pdf", "f1")] });
  assert.ok(estimateItemTokens(withPdf) - estimateItemTokens(plain) >= 250_000);
  const outbound = entry("UserMessage", {
    text: "please review",
    attachments: [{ ...pdf("contract.pdf", "f1"), direction: "out" }],
  });
  assert.equal(estimateItemTokens(outbound), estimateItemTokens(plain));
  assert.ok(estimateDocumentTokens({ name: "notes.txt", mimetype: "text/plain", sizeBytes: 50_000_000 }) <= 50_000);
});

test("history that is small in words but carries large PDFs compacts them out of the kept window", () => {
  const budget = 1_000_000;
  const history = [
    entry("UserMessage", { text: "here are the agreements", attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
    entry("AgentMessage", { text: "Read both." }),
    entry("UserMessage", { text: "and the amendment", attachments: [pdf("c.pdf", "fc")] }),
    entry("AgentMessage", { text: "Read it." }),
    entry("UserMessage", { text: "and the exhibits", attachments: [pdf("d.pdf", "fd"), pdf("e.pdf", "fe")] }),
    entry("AgentMessage", { text: "Read them." }),
  ];
  assert.ok(overBudgetFraction(history, budget, 0.9), "five 1MB PDFs no longer look like a few hundred tokens");
  const plan = planCompaction(history, budget, 0.6);
  assert.ok(plan);
  const kept = plan.kept.reduce((sum, item) => sum + estimateItemTokens(item), 0);
  assert.ok(kept <= budget * 0.6, `kept ~${kept} tokens`);
  assert.match(compactTranscript(plan.toSummarize), /a\.pdf \[file fa\]/);
});

test("compaction input names each compacted document and its saved file", () => {
  const transcript = compactTranscript([
    entry("UserMessage", { text: "review these", attachments: [pdf("a.pdf", "fa"), pdf("b.pdf", "fb")] }),
    entry("AgentMessage", { text: "Done." }),
  ]);
  assert.match(transcript, /review these \(files: a\.pdf \[file fa\], b\.pdf \[file fb\]\)/);
});
