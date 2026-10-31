import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DISCORD_DOWNLOAD_TIMEOUT_MS,
  DISCORD_MAX_FILES,
  DISCORD_UPLOAD_LIMIT_BYTES,
  ingestAttachments,
  toDiscordFiles,
} from "../src/discord/attachments.ts";
import { MAX_BLOB_BYTES } from "../src/persistence/blob-transfer.ts";

const staged: Uint8Array[] = [];
const core = {
  stageBlob: async (bytes: Uint8Array) => {
    staged.push(bytes);
    return { blobId: `b${staged.length}`, sizeBytes: bytes.length };
  },
  readBlob: async (id: string) => Buffer.from(`bytes-of-${id}`),
  readFileArtifact: async () => Buffer.from(""),
};
const okFetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;

test("Discord CDN files are staged as blobs", async () => {
  const r = await ingestAttachments(
    [{ url: "https://cdn.discordapp.com/attachments/1/2/a.txt", name: "a.txt", contentType: "text/plain", size: 3 }],
    core,
    okFetch,
  );
  assert.deepEqual(r.attachments, [{ name: "a.txt", mimetype: "text/plain", sizeBytes: 3, blobId: "b1" }]);
  assert.deepEqual(r.notes, []);
});

test("non-CDN urls are refused without fetching", async () => {
  let fetched = false;
  const spy = (async () => {
    fetched = true;
    return new Response("x");
  }) as typeof fetch;
  const r = await ingestAttachments(
    [{ url: "http://169.254.169.254/latest", name: "x", contentType: null, size: 1 }],
    core,
    spy,
  );
  assert.equal(fetched, false);
  assert.equal(r.attachments.length, 0);
  assert.match(r.notes[0]!, /not hosted on Discord/);
});

test("http CDN urls are refused without fetching", async () => {
  let fetched = false;
  const spy = (async () => {
    fetched = true;
    return new Response("x");
  }) as typeof fetch;
  const r = await ingestAttachments(
    [{ url: "http://cdn.discordapp.com/attachments/1/2/a.txt", name: "a.txt", contentType: null, size: 1 }],
    core,
    spy,
  );
  assert.equal(fetched, false);
  assert.equal(r.attachments.length, 0);
  assert.match(r.notes[0]!, /not hosted on Discord/);
});

test("CDN files larger than MAX_BLOB_BYTES are refused without fetching", async () => {
  let fetched = false;
  const spy = (async () => {
    fetched = true;
    return new Response("x");
  }) as typeof fetch;
  const r = await ingestAttachments(
    [
      {
        url: "https://cdn.discordapp.com/attachments/1/2/big.bin",
        name: "big.bin",
        contentType: null,
        size: MAX_BLOB_BYTES + 1,
      },
    ],
    core,
    spy,
  );
  assert.equal(fetched, false);
  assert.equal(r.attachments.length, 0);
  assert.match(r.notes[0]!, /larger than/);
});

test("outbound files over the bot upload limit become a text note", async () => {
  const r = await toDiscordFiles(
    [
      { name: "small.csv", mimetype: "text/csv", sizeBytes: 10, blobId: "s" },
      { name: "huge.zip", mimetype: "application/zip", sizeBytes: DISCORD_UPLOAD_LIMIT_BYTES + 1, blobId: "h" },
    ],
    core,
  );
  assert.deepEqual(
    r.files.map((f) => f.name),
    ["small.csv"],
  );
  assert.match(r.notes[0]!, /huge\.zip.*too large for Discord/);
});

test("outbound files beyond DISCORD_MAX_FILES receive a count cap note without saying too large", async () => {
  const outgoing = Array.from({ length: DISCORD_MAX_FILES + 1 }, (_, i) => ({
    name: `file${i}.txt`,
    mimetype: "text/plain",
    sizeBytes: 10,
    blobId: `b${i}`,
  }));
  const r = await toDiscordFiles(outgoing, core);
  assert.equal(r.files.length, DISCORD_MAX_FILES);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0]!.includes("too large"), false);
  assert.match(
    r.notes[0]!,
    /was not attached because Discord allows at most 10 files per message, open it in the QM web app/,
  );
});

test("rejected fetch on one attachment skips it and continues staging others", async () => {
  let callCount = 0;
  const failingFetch = (async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error("network error");
    }
    return new Response(new Uint8Array([4, 5, 6]));
  }) as typeof fetch;
  const r = await ingestAttachments(
    [
      {
        url: "https://cdn.discordapp.com/attachments/1/2/failing.txt",
        name: "failing.txt",
        contentType: "text/plain",
        size: 3,
      },
      {
        url: "https://cdn.discordapp.com/attachments/1/2/ok.txt",
        name: "ok.txt",
        contentType: "text/plain",
        size: 3,
      },
    ],
    core,
    failingFetch,
  );
  assert.equal(r.attachments.length, 1);
  assert.equal(r.attachments[0]!.name, "ok.txt");
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0]!, "Skipped failing.txt: download failed.");
});

test("unreadable outbound file becomes a text note instead of throwing", async () => {
  const failingCore = {
    readBlob: async () => {
      throw new Error("not found");
    },
    readFileArtifact: async () => {
      throw new Error("not found");
    },
  };
  const r = await toDiscordFiles(
    [{ name: "missing.txt", mimetype: "text/plain", sizeBytes: 10, blobId: "b1" }],
    failingCore,
  );
  assert.equal(r.files.length, 0);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0]!, /missing\.txt.*could not be read/);
});

test("inbound download timeout is 300s and abort lands in per-file catch", async () => {
  assert.equal(DISCORD_DOWNLOAD_TIMEOUT_MS, 300_000);
  const timingOutFetch = (async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as typeof fetch;
  const r = await ingestAttachments(
    [
      {
        url: "https://cdn.discordapp.com/attachments/1/2/timeout.txt",
        name: "timeout.txt",
        contentType: "text/plain",
        size: 3,
      },
    ],
    core,
    timingOutFetch,
  );
  assert.equal(r.attachments.length, 0);
  assert.equal(r.notes[0]!, "Skipped timeout.txt: download failed.");
});
