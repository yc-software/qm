import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createRunSlot,
  MAX_ATTACHMENT_BYTES,
  MAX_FILES_PER_MESSAGE,
  oversizeAttachmentNote,
  requestStop,
  uploadAttachments,
  verifySteerDelivered,
  latestTranscriptSeq,
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

test("the client limits mirror core's MAX_BLOB_BYTES and MAX_INBOUND_FILES", () => {
  const blobTransfer = readFileSync(new URL("../../../src/persistence/blob-transfer.ts", import.meta.url), "utf8");
  assert.match(blobTransfer, /export const MAX_BLOB_BYTES = 1_000_000_000;/);
  assert.equal(MAX_ATTACHMENT_BYTES, 1_000_000_000);
  const attachments = readFileSync(new URL("../../../src/core/attachments.ts", import.meta.url), "utf8");
  assert.match(attachments, /export const MAX_INBOUND_FILES = 10;/);
  assert.equal(MAX_FILES_PER_MESSAGE, 10);
});

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

test("verifySteerDelivered finds a landed steer in the transcript tail", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        entries: [{ type: "user", payload: { text: "alice: make it louder", steered: true }, createdAt: Date.now() }],
      }),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(await verifySteerDelivered("s1", "make it louder", Date.now(), [0]), true);
});

test("verifySteerDelivered says no when the text never made the transcript", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ entries: [{ type: "user", payload: { text: "other" }, createdAt: Date.now() }] }), {
      status: 200,
    })) as typeof fetch;
  assert.equal(await verifySteerDelivered("s1", "make it louder", Date.now(), [0]), false);
});

test("verifySteerDelivered ignores an ordinary (non-steered) message with the same text", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ entries: [{ type: "user", payload: { text: "continue" }, createdAt: Date.now() }] }),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(
    await verifySteerDelivered("s1", "continue", Date.now(), [0]),
    false,
    "a repeated 'continue' that was typed, not steered, must not count as the lost steer",
  );
});

test("verifySteerDelivered ignores a stale steered match from before the attempt", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        entries: [{ type: "user", payload: { text: "make it louder", steered: true }, createdAt: 1000 }],
      }),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(await verifySteerDelivered("s1", "make it louder", Date.now(), [0]), false);
});

test("requestStop targets the current submit generation, not a fixed flag", () => {
  const slot = createRunSlot();
  assert.equal(slot.stopGeneration, null);
  assert.equal(slot.generation, 0);
  requestStop(slot);
  assert.equal(slot.stopGeneration, slot.generation, "a Stop names the generation live at the moment it is pressed");
});

const composer = readFileSync(new URL("../src/composer.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");

test("the composer pre-checks size and count before reading files into memory", () => {
  const fn = composer.slice(composer.indexOf("function planAdmission"), composer.indexOf("async function addFiles"));
  assert.match(fn, /file\.size > MAX_ATTACHMENT_BYTES/, "oversize files never reach loadAnyAttachment");
  assert.match(fn, /MAX_FILES_PER_MESSAGE - composerState\.attachments\.length/, "the cap counts already-staged chips");
  assert.match(fn, /tooManyFilesNote\(overflow\)/, "skips are named, not silent");
  assert.match(
    composer,
    /const plan = planAdmission\(files, folders\.length\);/,
    "drops, picks, and folders all pass the same gate before any bytes are read",
  );
  assert.match(
    composer,
    /for \(const folder of folders\.slice\(0, plan\.folders\)\) zipped\.push\(await folderToZipFile\(folder\)\);/,
    "folders past the cap are never zipped into memory",
  );
});

test("a send whose attachments all failed does not go out as an empty turn", () => {
  const fn = bridge.slice(bridge.indexOf("async function drive("), bridge.indexOf("async function resumeDrive"));
  assert.match(fn, /if \(!opener && !text\.trim\(\) && attachments\.length === 0\)/);
  assert.match(fn, /issues\.join\(" "\) \|\| "Nothing to send\."/);
  assert.match(
    fn,
    /if \(issues\.length\) onSendIssues\?\.\(issues, retryable\);/,
    "partial skips surface as a composer note",
  );
});

test("skipped files drop off the sent message's chips so the view matches what core got", () => {
  const fn = bridge.slice(bridge.indexOf("async function latestUserTurn"), bridge.indexOf("function attachmentBytes"));
  assert.match(fn, /m\.attachments = m\.attachments\.filter\(\(a\) => !a\.id \|\| !skippedIds\.has\(a\.id\)\);/);
});

test("queued turns carry the staged attachments; attachment-only queues are real sends", () => {
  const fn = composer.slice(
    composer.indexOf("async function queueDraft"),
    composer.indexOf("async function enqueueTurn"),
  );
  assert.match(fn, /const staged = composerState\.attachments;/);
  assert.match(fn, /if \(\(!text && !staged\.length\) \|\| !threadRef\) return;/);
  assert.match(fn, /await uploadAttachments\(staged\)/);
  assert.match(fn, /enqueueTurn\(agent, threadRef, text, uploaded, queuedFilesKey\(sendable\)\)/);
  assert.match(bridge, /attachments: CoreAttachment\[\] = \[\],\n\): Promise<QueuedRun>/);
});

test("a queued run that carries files cannot be steered — steering would drop them", () => {
  assert.match(composer, /\?disabled=\$\{!steerable \|\| q\.hasAttachments\}/);
  assert.match(composer, /if \(!threadRef \|\| queued\.hasAttachments\) return;/);
  const appTurn = readFileSync(new URL("../../../src/api/app-turn.ts", import.meta.url), "utf8");
  assert.match(
    appTurn,
    /\.\.\.\(run\.request\.attachments\?\.length \? \{ hasAttachments: true \} : \{\}\)/,
    "core names which queued runs carry files, so every tab knows, not just the one that queued",
  );
});

test("an ambiguous steer failure verifies against the transcript before re-submitting", () => {
  const fn = composer.slice(
    composer.indexOf("async function steerQueued"),
    composer.indexOf("function recoverEndedRunSteer"),
  );
  const verify = fn.indexOf("await verifySteerDelivered(steerSessionId, queued.text, sentAt, undefined, sinceSeq)");
  const requeue = fn.indexOf("await enqueueTurn(agent, threadRef, queued.text)");
  assert.ok(verify > 0, "the transcript is consulted first");
  assert.ok(requeue > verify, "only a steer that provably never arrived goes back on the queue");
  assert.match(
    fn,
    /const steerSessionId = ctx\.chat\.state\.sessionId;/,
    "the session is captured before signaling so a mid-steer switch verifies the right transcript",
  );
});

test("Stop pressed before the run id arrives still stops core's run", () => {
  assert.match(chat, /requestStop\(runSlot\);/);
  assert.match(composer, /void ctx\.chat\.stopLiveRun\(\)\.catch/);
  const followRun = bridge.slice(bridge.indexOf("async function followRun"), bridge.indexOf("function runPath"));
  assert.match(followRun, /if \(slot && slot\.stopGeneration === gen\) \{/);
  assert.match(followRun, /await signalLiveRun\(slot, "abort", undefined, \{ threadRef: null \}\);/);
  assert.match(followRun, /slot\.unreachedAbort = true;/);
});

test("the aborted-refresh guard yields when the abort never reached core", () => {
  assert.match(chat, /if \(last\?\.stopReason === "error"\) return drawActiveChat\(agent\);/);
  assert.match(
    chat,
    /if \(last\?\.stopReason === "aborted" && !runSlot\.unreachedAbort\) return drawActiveChat\(agent\);/,
  );
});

test("verifySteerDelivered only trusts a steered entry newer than the baseline it was given", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        entries: [
          { type: "user", seq: 4, payload: { text: "yes", steered: true }, createdAt: Date.now() - 30_000 },
          { type: "user", seq: 5, payload: { text: "yes, run the tests", steered: true }, createdAt: Date.now() },
        ],
      }),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(
    await verifySteerDelivered("s1", "yes", Date.now(), [0], 4),
    false,
    "an earlier identical steer and a longer steer containing the word are not this steer",
  );
  assert.equal(await verifySteerDelivered("s1", "yes", Date.now(), [0], 3), true, "seq 4 is newer than baseline 3");
  assert.equal(await verifySteerDelivered("s1", "yes, run the tests", Date.now(), [0], 4), true);
});

test("verifySteerDelivered matches the attributed form core stores for another person's steer", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        entries: [{ type: "user", seq: 9, payload: { text: "Ada: ship it", steered: true }, createdAt: Date.now() }],
      }),
      { status: 200 },
    )) as typeof fetch;
  assert.equal(await verifySteerDelivered("s1", "ship it", Date.now(), [0], 8), true);
  assert.equal(await verifySteerDelivered("s1", "it", Date.now(), [0], 8), false, "no substring matches");
});

test("latestTranscriptSeq reads the newest seq from the tail, or nothing for an empty session", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        entries: [
          { type: "user", seq: 7 },
          { type: "assistant", seq: 12 },
        ],
      }),
      {
        status: 200,
      },
    )) as typeof fetch;
  assert.equal(await latestTranscriptSeq("s1"), 12);
  globalThis.fetch = (async () => new Response(JSON.stringify({ entries: [] }), { status: 200 })) as typeof fetch;
  assert.equal(await latestTranscriptSeq("s1"), undefined);
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
