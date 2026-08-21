import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeliveryPoller } from "../src/slack/deliveries.ts";

const mixedFiles = [
  { name: "first.png", mimetype: "image/png", sizeBytes: 2, blobId: "B1" },
  { name: "second.jpg", mimetype: "image/jpeg", sizeBytes: 2, blobId: "B2" },
  { name: "notes.pdf", mimetype: "application/pdf", sizeBytes: 2, blobId: "B3" },
];

async function deliver(destination: Record<string, unknown> = {}) {
  const delivery = {
    id: "D1",
    text: "two screenshots and the notes",
    destination: { type: "slack", target: "C1:100.200", ...destination },
    attachments: mixedFiles,
    createdAt: 1,
  };
  const queues = new Map<string, unknown[]>([["slack", [delivery]]]);
  const acknowledgements: string[] = [];
  const uploads: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const mirrors: Array<{ ts?: string; text: string }> = [];
  const marks: Array<{ channel: string; ts: string }> = [];
  const core = {
    claimDeliveries: async (type: string) => queues.get(type)?.splice(0) ?? [],
    ackDelivery: async (id: string) => void acknowledgements.push(id),
  };
  const client = {
    files: {
      uploadV2: async (args: Record<string, unknown>) => {
        uploads.push(args);
        return { files: [{ files: mixedFiles.map((_, index) => ({ id: `F${index + 1}` })) }] };
      },
      info: async () => ({ file: { shares: { private: { C1: [{ ts: "101.300" }] } } } }),
    },
    chat: {
      postMessage: async (args: Record<string, unknown>) => {
        posts.push(args);
        return { ts: "separate-message" };
      },
    },
  };
  const poller = createDeliveryPoller({
    core: core as never,
    bridge: {
      inFlightRuns: new Set<string>(),
      fetchBlobFromCore: async (id: string) => Buffer.from(id),
      fetchFileArtifactFromCore: async () => Buffer.from("artifact"),
    } as never,
    mirror: {
      mirrorSelfPost: (_channel: string, ts: string | undefined, text: string) => void mirrors.push({ ts, text }),
    } as never,
    threads: { mark: (channel: string, ts: string) => void marks.push({ channel, ts }) } as never,
    clientForIdentity: () => client,
  });

  await poller.pollDeliveries(client);
  return { acknowledgements, uploads, posts, mirrors, marks };
}

test("Slack delivery composes text and mixed attachments into one message", async () => {
  const { acknowledgements, uploads, posts, mirrors, marks } = await deliver();

  assert.equal(uploads.length, 1);
  assert.equal(posts.length, 0, "commentary must not be posted separately");
  assert.equal(uploads[0]!.channel_id, "C1");
  assert.equal(uploads[0]!.thread_ts, "100.200");
  assert.equal(uploads[0]!.initial_comment, "two screenshots and the notes");
  assert.deepEqual(
    (uploads[0]!.file_uploads as Array<{ filename: string }>).map(({ filename }) => filename),
    ["first.png", "second.jpg", "notes.pdf"],
  );
  assert.deepEqual(acknowledgements, ["D1"]);
  assert.deepEqual(mirrors, [{ ts: "101.300", text: "two screenshots and the notes" }]);
  assert.deepEqual(marks, [{ channel: "C1", ts: "100.200" }]);
});

test("Slack delivery keeps the separate-comment fallback when upload comments cannot carry post options", async () => {
  const { uploads, posts } = await deliver({ unfurlLinks: false });

  assert.equal(posts.length, 1);
  assert.equal(posts[0]!.text, "two screenshots and the notes");
  assert.equal(posts[0]!.unfurl_links, false);
  assert.equal(uploads.length, 1, "the fallback still batches the files themselves");
  assert.equal(uploads[0]!.initial_comment, undefined);
  assert.equal((uploads[0]!.file_uploads as unknown[]).length, 3);
});
