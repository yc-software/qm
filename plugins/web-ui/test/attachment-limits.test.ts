import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  createRunSlot,
  MAX_ATTACHMENT_BYTES,
  oversizeAttachmentNote,
  requestStop,
  uploadAttachments,
} from "../src/core-bridge.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function attachment(
  name: string,
  size = 4,
): {
  id: string;
  type: "document";
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
} {
  return { id: `id-${name}`, type: "document", fileName: name, mimeType: "text/plain", size, content: "aGV5" };
}

test("an oversize attachment is skipped before any bytes go out", async () => {
  let fetched = 0;
  globalThis.fetch = (() => {
    fetched++;
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  const big = attachment("huge.bin", MAX_ATTACHMENT_BYTES + 1);
  const { uploaded, skipped } = await uploadAttachments([big]);
  assert.equal(fetched, 0, "no upload is attempted for a file the size check already rules out");
  assert.deepEqual(uploaded, []);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.id, "id-huge.bin");
  assert.equal(skipped[0]!.note, oversizeAttachmentNote("huge.bin"));
  assert.match(skipped[0]!.note, /up to ~1 GB/, "the note names the limit in friendly terms, not an HTTP status");
});

test("one failing blob degrades that file only; the rest upload and the send survives", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 2) return new Response(JSON.stringify({ error: "too large" }), { status: 413 });
    return new Response(JSON.stringify({ blobId: `b${call}`, sizeBytes: 4 }), { status: 200 });
  }) as typeof fetch;
  const { uploaded, skipped } = await uploadAttachments([
    attachment("fine.txt"),
    attachment("rejected.txt"),
    attachment("also-fine.txt"),
  ]);
  assert.deepEqual(
    uploaded.map((u) => u.name),
    ["fine.txt", "also-fine.txt"],
    "valid files still ride the turn",
  );
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]!.name, "rejected.txt");
  assert.equal(skipped[0]!.note, oversizeAttachmentNote("rejected.txt"), "a 413 reads as the size limit, not raw HTTP");
});

test("a non-413 upload failure is noted per file with its reason", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;
  const { uploaded, skipped } = await uploadAttachments([attachment("a.txt")]);
  assert.deepEqual(uploaded, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]!.note, /"a\.txt" couldn't be uploaded/);
  assert.match(skipped[0]!.note, /network unreachable/);
});

test("requestStop targets the current submit generation, not a fixed flag", () => {
  const slot = createRunSlot();
  assert.equal(slot.stopGeneration, null);
  assert.equal(slot.generation, 0);
  requestStop(slot);
  assert.equal(slot.stopGeneration, slot.generation, "a Stop names the generation live at the moment it is pressed");
});

test("an empty attachment is reported and left out rather than silently dropped", async () => {
  const { uploaded, skipped } = await uploadAttachments([
    { id: "e1", type: "document", fileName: "empty.txt", mimeType: "text/plain", size: 0, content: "" },
  ]);
  assert.deepEqual(uploaded, []);
  assert.equal(skipped[0]?.id, "e1");
  assert.match(skipped[0]!.note, /"empty\.txt" is empty/);
});

test("a transient upload failure is not permanent, so the composer can put the file back", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network unreachable");
  }) as typeof fetch;
  const { skipped } = await uploadAttachments([
    { id: "t1", type: "document", fileName: "a.txt", mimeType: "text/plain", size: 3, content: "YWJj" },
    { id: "t2", type: "document", fileName: "empty.txt", mimeType: "text/plain", size: 0, content: "" },
  ]);
  assert.deepEqual(
    skipped.map((s) => [s.id, s.permanent]),
    [
      ["t1", false],
      ["t2", true],
    ],
  );
});
